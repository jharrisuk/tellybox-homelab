import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {proxyImage,sendImageBody} from '../image-proxy.mjs';

class ResponseDouble extends EventEmitter {
	constructor(){super();this.headersSent=false;this.writableEnded=false;this.destroyed=false;this.statusCode=200;this.headers={};this.chunks=[];this.body=null;}
	set(name,value){this.headers[name]=value;return this;}
	setHeader(name,value){this.headers[name]=value;return this;}
	removeHeader(name){delete this.headers[name];return this;}
	status(code){this.statusCode=code;return this;}
	type(){return this;}
	json(value){this.headersSent=true;this.writableEnded=true;this.body=value;return this;}
	sendStatus(code){this.statusCode=code;this.headersSent=true;this.writableEnded=true;return this;}
	write(chunk){if(this.destroyed)throw Error('write after destroy');this.headersSent=true;this.chunks.push(Buffer.from(chunk));return true;}
	end(value){if(value!==undefined)this.body=JSON.parse(value);this.writableEnded=true;return this;}
	destroy(){this.destroyed=true;return this;}
}

function trackUnhandled(t){
	const seen=[];
	const listener=error=>seen.push(error);
	process.on('unhandledRejection',listener);
	t.after(()=>process.off('unhandledRejection',listener));
	return seen;
}

test('image proxy streams bytes and headers',async t=>{
	const res=new ResponseDouble();
	await proxyImage(res,{url:'http://media.test/one.jpg',timeoutMs:1000,logger:{error:()=>assert.fail('should not fail')},
		fetchImpl:async()=>new Response(Buffer.from('image-bytes'),{headers:{'content-type':'image/jpeg','content-length':'11'}})});
	assert.equal(res.statusCode,200);
	assert.match(res.headers['Cache-Control'],/no-store/);
	assert.equal(Buffer.concat(res.chunks).toString(),'image-bytes');
	assert.equal(res.writableEnded,true);
});

test('an image body timeout is reported once and never becomes an unhandled readable error',async t=>{
	const seen=trackUnhandled(t),errors=[],res=new ResponseDouble();
	const body=new ReadableStream({start(controller){setTimeout(()=>controller.error(Object.assign(Error('the operation timed out'),{name:'TimeoutError'})),10);}});
	await proxyImage(res,{url:'http://media.test/slow.jpg',maxBytes:1000,timeoutMs:1000,logger:{error:(...args)=>errors.push(args.join(' '))},
		fetchImpl:async()=>new Response(body,{headers:{'content-type':'image/jpeg'}})});
	assert.equal(res.statusCode,504);
	assert.match(res.body.error,/timed out/);
	assert.equal(errors.length,1);
	assert.match(errors[0],/failed/);
	await new Promise(resolve=>setTimeout(resolve,20));
	assert.deepEqual(seen,[]);
});

test('an abort after headers are sent destroys the response and still logs the timeout',async t=>{
	const seen=trackUnhandled(t),errors=[],res=new ResponseDouble();
	const body=new ReadableStream({start(controller){controller.enqueue(new Uint8Array([1,2,3]));}});
	await proxyImage(res,{url:'http://media.test/hang.jpg',maxBytes:1000,timeoutMs:20,logger:{error:(...args)=>errors.push(args.join(' '))},
		fetchImpl:async()=>new Response(body,{headers:{'content-type':'image/jpeg'}})});
	assert.equal(res.destroyed,true);
	assert.equal(errors.length,1);
	assert.match(errors[0],/timed out/);
	await new Promise(resolve=>setTimeout(resolve,20));
	assert.deepEqual(seen,[]);
});

test('oversized images are rejected before streaming',async t=>{
	const res=new ResponseDouble(),errors=[];
	await proxyImage(res,{url:'http://media.test/big.jpg',maxBytes:10,logger:{error:(...args)=>errors.push(args.join(' '))},
		fetchImpl:async()=>new Response(Buffer.from('small'),{headers:{'content-type':'image/jpeg','content-length':'999'}})});
	assert.equal(res.statusCode,413);
	assert.match(res.body.error,/too large/);
	assert.deepEqual(errors,[]);
});

test('a client disconnect is cancelled quietly',async t=>{
	const seen=trackUnhandled(t),errors=[],res=new ResponseDouble(),controller=new AbortController();
	const pending=sendImageBody(new Response(Buffer.from('payload')).body,res,{signal:controller.signal,logger:{error:(...args)=>errors.push(args)}});
	controller.abort(Object.assign(Error('client closed'),{name:'AbortError'}));
	await pending;
	assert.equal(errors.length,0,'a client disconnect is not a server failure');
	await new Promise(resolve=>setTimeout(resolve,10));
	assert.deepEqual(seen,[]);
});

test('an upstream image failure is never cacheable and carries no ETag',async t=>{
	const errors=[];
	const notFound=new ResponseDouble();
	await proxyImage(notFound,{url:'http://media.test/missing.jpg',logger:{error:(...args)=>errors.push(args.join(' '))},
		fetchImpl:async()=>new Response('missing',{status:404,headers:{'content-type':'text/plain'}})});
	assert.equal(notFound.statusCode,404);
	assert.match(notFound.headers['Cache-Control'],/no-store/);
	assert.equal(notFound.headers.ETag,undefined);

	const failed=new ResponseDouble();
	await proxyImage(failed,{url:'http://media.test/broken.jpg',logger:{error:(...args)=>errors.push(args.join(' '))},
		fetchImpl:async()=>{throw Error('upstream down');}});
	assert.equal(failed.statusCode,502);
	assert.match(failed.headers['Cache-Control'],/no-store/);
	assert.equal(failed.headers.ETag,undefined);
});

test('body failures before the first chunk discard successful image cache headers',async()=>{
	for(const [name,status] of [['Error',502],['TimeoutError',504],['oversized',413]]){
		const res=new ResponseDouble();
		const body=new ReadableStream({start(controller){
			if(name==='oversized')controller.enqueue(new Uint8Array(11));
			else controller.error(Object.assign(Error('body failed'),{name}));
		}});
		await proxyImage(res,{url:'http://media.test/body.jpg',maxBytes:10,cache:'private, no-cache',logger:{error(){}},
			onSuccess:target=>target.setHeader('ETag','"successful-image"'),
			fetchImpl:async()=>new Response(body,{headers:{'content-type':'image/jpeg'}})});
		assert.equal(res.statusCode,status,name);
		assert.equal(res.headers['Cache-Control'],'no-store',name);
		assert.equal(res.headers.ETag,undefined,name);
		assert.equal(res.chunks.length,0,name);
		assert.equal(res.writableEnded,true,name);
	}
});

test('a failed image after its first chunk is destroyed without changing sent headers',async()=>{
	const res=new ResponseDouble();
	const setHeader=res.setHeader.bind(res);
	res.setHeader=(name,value)=>{assert.equal(res.headersSent,false,'cannot change sent headers');return setHeader(name,value);};
	let pulls=0;
	const body=new ReadableStream({pull(controller){
		if(pulls++===0)controller.enqueue(new Uint8Array([1]));
		else controller.error(Error('body failed'));
	}});
	await proxyImage(res,{url:'http://media.test/body.jpg',cache:'private, no-cache',logger:{error(){}},
		onSuccess:target=>target.setHeader('ETag','"successful-image"'),
		fetchImpl:async()=>new Response(body,{headers:{'content-type':'image/jpeg'}})});
	assert.equal(res.chunks.length,1);
	assert.equal(res.destroyed,true);
	assert.equal(res.writableEnded,false);
});
