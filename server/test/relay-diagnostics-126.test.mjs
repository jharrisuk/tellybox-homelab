import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {once} from 'node:events';
import {createMediaToken, controlHeaders} from '../relay-media/protocol.mjs';
import {createRelayWorker} from '../../relay/worker/worker.mjs';

const pair=()=>{const key=generateKeyPairSync('ed25519');return {privateKey:key.privateKey,publicKey:key.publicKey};};

async function fixture(t,{diagnostics='',readError=null}={}) {
	let now=1_000_000;
	const main=pair(),worker=pair();
	const started=[],heartbeatBodies=[];
	const players={start:async session=>{
		started.push(session);
		return {
			read:async file=>{
				if(readError&&file.endsWith('.ts'))throw readError;
				return file.endsWith('.m3u8')?Buffer.from('#EXTM3U\n#EXTINF:2,\nsegment0.ts\n'):Buffer.from('segment-bytes');
			},
			stop:async()=>{},
			touch:async()=>{},
			diagnostics:()=>diagnostics
		};
	}};
	const upstream={health:async()=>true,recordingFile:async()=>new Response('')};
	const w=createRelayWorker({workerId:'worker-1',version:'0.26.14',mainControlPublicKey:main.publicKey,mainMediaPublicKey:main.publicKey,
		workerPrivateKey:worker.privateKey,players,upstream,clock:()=>now,maxSessions:2,heartbeatEnabled:false,dataDirectory:'',
		mainHeartbeatUrl:'https://main.example/internal/worker/heartbeat',mainHeartbeatKeyId:'worker-1',
		fetcher:async(url,options)=>{heartbeatBodies.push(JSON.parse(options.body));return new Response(JSON.stringify({instructions:[]}),{status:200});}});
	const media=w.mediaServer(),control=w.controlServer();
	media.listen(0,'127.0.0.1');control.listen(0,'127.0.0.1');
	await Promise.all([once(media,'listening'),once(control,'listening')]);
	w.start();
	t.after(async()=>{await w.close();media.closeAllConnections?.();control.closeAllConnections?.();media.close();control.close();});
	const mediaUrl='http://127.0.0.1:'+media.address().port,controlUrl='http://127.0.0.1:'+control.address().port;
	const leaseId='lease-0001',sessionId='session-1',generation=1,itemId='dispatch-movie-1';
	const token=createMediaToken(main.privateKey,{aud:'worker-1',leaseId,sessionId,itemId,mode:'vod',generation,
		resources:['hls','segment','subtitle','file'],exp:Math.floor(now/1000)+21600,jti:'jti-1'});
	const body={workerId:'worker-1',leaseId,sessionId,itemId,mode:'vod',generation,grantSeconds:45,duration:120,
		modeParameters:{type:'movie',uuid:'11111111-1111-1111-1111-111111111111',provider:'Dispatcharr'},
		quality:8000000,allowedResourceClasses:['hls','segment','subtitle','file'],capability:token,hardEndsAt:now+21600000};
	const prepare=()=>fetch(controlUrl+'/internal/worker/prepare',{method:'POST',headers:{'content-type':'application/json',
		...controlHeaders(main.privateKey,{method:'POST',path:'/internal/worker/prepare',body,now})},body:JSON.stringify(body)});
	return {w,mediaUrl,heartbeatBodies,started,prepare};
}

test('worker session view and heartbeat carry only bounded sanitized player diagnostics',async t=>{
	const diagnostics={
		method:'Transcode',copyMode:false,windowStart:0,windowEnd:29,produced:-1,requested:0,exitCode:1,
		stderr:'https://provider.example/live/account-7?token=secret',
		failure:{category:'input_open',code:'VOD_ENCODER_INPUT_OPEN',summary:'The provider input could not be opened.',
			userSummary:'This stream could not be started by the relay.',exitCode:1}
	};
	const f=await fixture(t,{diagnostics});
	const prepared=await (await f.prepare()).json();
	const playlist=await (await fetch(f.mediaUrl+prepared.sessionUrl)).text();
	assert.match(playlist,/segment0\.ts/);
	assert.equal(f.started.length,1);
	const view=f.w.status().sessions[0];
	assert.equal(typeof view.diagnostics,'string');
	assert.ok(view.diagnostics.length<=2048);
	assert.equal(view.lastErrorCode,'VOD_ENCODER_INPUT_OPEN');
	const parsed=JSON.parse(view.diagnostics);
	assert.equal(parsed.method,'Transcode');
	assert.equal(parsed.copyMode,false);
	assert.equal(parsed.windowStart,0);
	assert.equal(parsed.produced,-1);
	assert.equal(parsed.exitCode,1);
	assert.equal(parsed.failure.category,'input_open');
	assert.equal(parsed.failure.code,'VOD_ENCODER_INPUT_OPEN');
	assert.equal(parsed.failure.userSummary,undefined,'the raw player object is projected, not forwarded');
	assert.equal(parsed.stderr,undefined);
	assert.doesNotMatch(view.diagnostics,/provider\.example|token=secret/);

	assert.equal(await f.w.heartbeat().then(result=>result.ok),true);
	assert.equal(f.heartbeatBodies.length,1);
	const leases=f.heartbeatBodies[0].leases;
	assert.equal(leases.length,1);
	assert.equal(leases[0].lastErrorCode,'VOD_ENCODER_INPUT_OPEN');
	assert.equal(leases[0].diagnostics,view.diagnostics);
	for(const key of ['leaseId','generation','seq','bytesOutTotal','resourcesServed','activeResponses','lastResourceAt','resourceState']) {
		assert.ok(Object.hasOwn(leases[0],key),`existing heartbeat lease field ${key} must stay intact`);
	}
});

test('worker media terminal failure is JSON with bounded error and code',async t=>{
	const error=Object.assign(Error('This stream could not be started by the relay. https://provider.example/live?token=secret Try another quality or source.'),
		{status:502,code:'VOD_ENCODER_EXIT'});
	const f=await fixture(t,{diagnostics:'',readError:error});
	const prepared=await (await f.prepare()).json();
	const response=await fetch(f.mediaUrl+prepared.sessionUrl.replace(/index\.m3u8$/,'segment000000000.ts'));
	assert.equal(response.status,502);
	assert.match(response.headers.get('content-type')||'',/application\/json/);
	const body=await response.json();
	assert.equal(body.code,'VOD_ENCODER_EXIT');
	assert.match(body.error,/could not be started/);
	assert.doesNotMatch(body.error,/provider\.example|token=secret|https?:/);
	assert.ok(body.error.length<=320);
});

test('worker compatibility 409 stays a 409 with its header and code',async t=>{
	const error=Object.assign(Error('This title needs compatibility playback.'),{status:409,code:'VOD_COMPATIBILITY_REQUIRED'});
	const f=await fixture(t,{readError:error});
	const prepared=await (await f.prepare()).json();
	const response=await fetch(f.mediaUrl+prepared.sessionUrl.replace(/index\.m3u8$/,'segment000000000.ts'));
	assert.equal(response.status,409);
	assert.equal(response.headers.get('x-tellybox-compatibility'),'required');
	const body=await response.json();
	assert.equal(body.code,'VOD_COMPATIBILITY_REQUIRED');
	assert.equal(body.error,'This title needs compatibility playback.');
});
