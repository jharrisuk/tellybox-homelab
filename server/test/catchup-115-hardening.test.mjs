import test from 'node:test';
import assert from 'node:assert/strict';
import cp from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {writeFileSync} from 'node:fs';
import path from 'node:path';
import {createCatchupPlayer,catchupQualityRungs} from '../catchup-player.mjs';
import {createWorkerPlayers} from '../../relay/worker/players.mjs';

const base=Date.parse('2026-11-10T20:00:00Z');
const channel={id:'01234567-0123-0123-0123-012345678901'};
const item={StartDate:new Date(base).toISOString(),EndDate:new Date(base+600000).toISOString()};
const now=base+700000; // The programme has fully aired.
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
// Attach a settle handler the moment a read is issued: the patched player
// rejects a pending read promptly when stop wins, before a later harness
// await. Observing it immediately keeps the test focused on promptness.
const settle=p=>p.then(value=>({settled:true,value}),error=>({settled:true,status:error.status,error:error.message}));
const within=(p,ms)=>Promise.race([p,sleep(ms).then(()=>({settled:false}))]);

// Capture real encoder invocations without running ffmpeg: the player's
// ESM import of child_process.spawn is a live binding, refreshed here the
// same way the staged validation harness does.
function mockFfmpeg(){
	const captures=[];const original=cp.spawn;
	cp.spawn=(name,args,options)=>{
		if(name!=='ffmpeg')return original(name,args,options);
		captures.push({args,cwd:options.cwd});
		const child=new EventEmitter();child.stdin=new PassThrough();child.exitCode=null;
		child.kill=()=>{child.exitCode=0;child.emit('close',0);return true;};
		const n=Number(args[args.indexOf('-start_number')+1]);
		writeFileSync(path.join(options.cwd,'segment'+String(n).padStart(9,'0')+'.ts'),Buffer.from('fixture-segment'));
		return child;
	};
	syncBuiltinESMExports();
	return {captures,restore:()=>{cp.spawn=original;syncBuiltinESMExports();}};
}

test('stop during a pending provider session settles the pending read with 410 within 100 ms',{timeout:30000},async()=>{
	let resolveSession,stops=0;
	const service=createCatchupPlayer({startTimeoutMs:45000,clock:()=>now,onFailure:()=>{},
		openArchive:()=>new Promise(resolve=>{resolveSession=resolve;})});
	const session=await service.start(channel,item);
	const pending=settle(session.read('segment000000000.ts'));
	await sleep(20);
	const begun=Date.now();
	await session.stop();
	const outcome=await within(pending,100);
	const elapsed=Date.now()-begun;
	assert.equal(outcome.settled,true,'The pending read must settle within 100 ms of stop, not the 45 s deadline ('+elapsed+' ms)');
	assert.equal(outcome.status,410,'Stop must settle the read as expired');
	assert.equal(outcome.error,'Playback expired.');
	// The provider finishing after stop must still be released exactly once.
	resolveSession({open:async()=>new Response('x'),stop:async()=>{stops++;}});
	for(let wait=0;wait<50&&stops===0;wait++)await sleep(10);
	assert.equal(stops,1,'The late provider session must be stopped exactly once');
});

test('a provider session that completes after stop and the deadline is released exactly once',{timeout:30000},async()=>{
	let resolveSession,stops=0;
	const service=createCatchupPlayer({startTimeoutMs:1000,clock:()=>now,onFailure:()=>{},
		openArchive:()=>new Promise(resolve=>{resolveSession=resolve;})});
	const session=await service.start(channel,item);
	const pending=settle(session.read('segment000000000.ts'));
	await sleep(20);
	await session.stop();
	const immediate=await within(pending,100);
	assert.equal(immediate.settled,true,'Stop must settle the read promptly');
	assert.equal(immediate.status,410);
	// The provider answers after the original deadline window has passed.
	await sleep(1100);
	resolveSession({open:async()=>new Response('x'),stop:async()=>{stops++;}});
	for(let wait=0;wait<50&&stops===0;wait++)await sleep(10);
	assert.equal(stops,1,'The late provider session must be stopped exactly once, not leaked');
});

test('an archive.open that ignores abort still settles the read and is stopped exactly once',{timeout:30000},async()=>{
	let stops=0,aborts=0;
	const service=createCatchupPlayer({startTimeoutMs:1000,clock:()=>now,onFailure:()=>{},
		openArchive:async()=>({open:signal=>{signal.addEventListener('abort',()=>aborts++);return new Promise(()=>{});},stop:async()=>{stops++;}})});
	const session=await service.start(channel,item);
	const pending=settle(session.read('segment000000000.ts'));
	const afterDeadline=await within(pending,1500);
	assert.equal(afterDeadline.settled,true,'The read must settle at the deadline even though the provider ignores abort');
	assert.equal(afterDeadline.status,502,'A noncooperative open fails with the bounded open error');
	assert.match(afterDeadline.error,/could not open this programme in time/);
	await session.stop();
	const afterStop=await within(pending,100);
	assert.equal(afterStop.settled,true,'The read must stay settled after stop');
	assert.equal(stops,1,'The noncooperative archive must be stopped exactly once');
	assert.equal(aborts,1,'The abort signal is still raised once for a cooperative provider');
});

test('catch-up quality bounds the encoder maxrate and bufsize to the requested rung',{timeout:30000},async()=>{
	const mock=mockFfmpeg();
	try{
		for(const [requested,maxrate,bufsize] of [[2000000,'2000000','4000000'],[80000000,'80000000','160000000']]){
			let stops=0;
			const service=createCatchupPlayer({paceInput:false,clock:()=>now,onFailure:()=>{},
				openArchive:async()=>({open:async()=>new Response(new Uint8Array([1,2,3])),stop:async()=>{stops++;}})});
			const session=await service.start(channel,item,0,{quality:requested});
			assert.equal(session.quality,requested,'The effective quality must travel back to the caller');
			assert.equal((await within(settle(session.read('segment000000000.ts')),2000)).settled,true,'The mock encode must produce the first segment');
			const args=mock.captures.at(-1).args;
			assert.equal(args[args.indexOf('-maxrate')+1],maxrate,'-maxrate must use the '+requested+' rung');
			assert.equal(args[args.indexOf('-bufsize')+1],bufsize,'-bufsize must stay 2x maxrate');
			await session.stop();
		}
	}finally{mock.restore();}
});

test('catch-up keeps the 8 Mbps default for missing or unknown quality values',{timeout:30000},async()=>{
	assert.deepEqual(catchupQualityRungs,[2000000,4000000,8000000,20000000,80000000],'The rung list must keep the 2 Mbps option and the 8 Mbps default');
	const mock=mockFfmpeg();
	try{
		for(const [requested,expected] of [[undefined,8000000],[5000000,8000000],['2000000',8000000]]){
			const service=createCatchupPlayer({paceInput:false,clock:()=>now,onFailure:()=>{},
				openArchive:async()=>({open:async()=>new Response(new Uint8Array([1,2,3])),stop:async()=>{}})});
			const session=await service.start(channel,item,0,requested===undefined?undefined:{quality:requested});
			assert.equal(session.quality,expected,'Unknown or missing quality must keep the 8 Mbps default');
			assert.equal((await within(settle(session.read('segment000000000.ts')),2000)).settled,true);
			const args=mock.captures.at(-1).args;
			assert.equal(args[args.indexOf('-maxrate')+1],'8000000','The default encoder ceiling must stay 8 Mbps');
			assert.equal(args[args.indexOf('-bufsize')+1],'16000000');
			await session.stop();
		}
	}finally{mock.restore();}
});

test('the relay worker forwards quality into catchup.start and the encoder uses it',{timeout:30000},async()=>{
	const mock=mockFfmpeg();
	try{
		const opens=[];
		const upstream={origin:'http://127.0.0.1:9',
			catchupSession:async(channelId,start,minutes)=>{opens.push({channelId,start,minutes});return{open:async()=>new Response(new Uint8Array([1,2,3])),stop:async()=>{}};}};
		const players=createWorkerPlayers({upstream,maxSessions:3,paceInput:false});
		const run=await players.start({mode:'catchup',params:{channelId:channel.id,item},options:{quality:2000000,position:0}});
		assert.equal(run.quality,2000000,'The worker must surface the effective quality');
		assert.equal((await within(settle(run.read('segment000000000.ts')),2000)).settled,true);
		const args=mock.captures.at(-1).args;
		assert.equal(args[args.indexOf('-maxrate')+1],'2000000','The worker must forward the 2 Mbps rung to the encoder');
		assert.equal(args[args.indexOf('-bufsize')+1],'4000000');
		assert.equal(opens.length,1,'The worker must open the provider once for the first segment');
		assert.equal(opens[0].channelId,channel.id);
		await run.stop();
	}finally{mock.restore();}
});
