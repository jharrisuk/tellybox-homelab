import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {proxyImage,sendImageBody} from '../image-proxy.mjs';

class ResponseDouble extends EventEmitter {
	constructor(){super();this.headersSent=false;this.writableEnded=false;this.destroyed=false;this.statusCode=200;this.headers={};this.chunks=[];this.body=null;}
	set(name,value){this.headers[name]=value;return this;}
	status(code){this.statusCode=code;return this;}
	type(){return this;}
	json(value){this.headersSent=true;this.writableEnded=true;this.body=value;return this;}
	sendStatus(code){this.statusCode=code;this.headersSent=true;this.writableEnded=true;return this;}
	write(chunk){if(this.destroyed)throw Error('write after destroy');this.headersSent=true;this.chunks.push(Buffer.from(chunk));return true;}
	end(){this.writableEnded=true;return this;}
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
