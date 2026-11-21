import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createCatchupPlayer} from '../catchup-player.mjs';

// Resolve the real ffmpeg/ffprobe from PATH like the surrounding media tests;
// the encoder tests skip when the binaries are absent.
const ffmpeg=spawnSync('ffmpeg',['-version']).status===0;
const ffprobe=spawnSync('ffprobe',['-version']).status===0;

const base=Date.parse('2026-11-10T20:00:00Z');
const channel={id:'01234567-0123-0123-0123-012345678901'};
const item={StartDate:new Date(base).toISOString(),EndDate:new Date(base+600000).toISOString()};
const now=base+700000; // The programme has fully aired.
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

function fixture(seconds){
	const result=spawnSync('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=s=160x90:r=25','-f','lavfi','-i','anullsrc=r=48000:cl=stereo',
		'-c:v','libx264','-preset','ultrafast','-threads','2','-g','100','-c:a','aac','-t',String(seconds),'-f','mpegts','pipe:1'],
		{maxBuffer:64*1024*1024,timeout:60000});
	assert.equal(result.status,0,String(result.stderr));
	return result.stdout;
}

// The MPEG-TS muxer adds a small fixed start offset; compare segments against
// the same encode run's segment 0 rather than against zero.
function startOf(bytes){
	const info=spawnSync('ffprobe',['-v','error','-show_entries','format=start_time','-of','json','pipe:0'],{input:bytes,timeout:10000});
	assert.equal(info.status,0,String(info.stderr));
	return Number(JSON.parse(info.stdout).format.start_time);
}

test('a hanging provider session POST fails before the client media read timeout',{timeout:30000},async()=>{
	const failures=[];
	const service=createCatchupPlayer({startTimeoutMs:1500,clock:()=>now,onFailure:record=>failures.push(record),
		// The closure carries a URL and token that must never reach the log.
		openArchive:id=>new Promise(()=>{void 'https://secret.example/session?token=SECRETTOKEN';void id;})});
	const session=await service.start(channel,item);
	try{
		const started=Date.now();
		await assert.rejects(session.read('segment000000000.ts'),error=>{
			assert.equal(error.status,502);
			assert.match(error.message,/did not prepare this programme in time/);
			return true;
		});
		const elapsed=Date.now()-started;
		assert.ok(elapsed<65000,'The failure must arrive before the client 65s read timeout: '+elapsed+'ms');
		assert.ok(elapsed<15000,'The failure must track the bounded deadline, not the provider: '+elapsed+'ms');
		assert.ok(elapsed>=1300,'The failure must come from the deadline, not an immediate error: '+elapsed+'ms');
	}finally{await session.stop();}
	assert.equal(failures.length,1);
	assert.deepEqual(Object.keys(failures[0]).sort(),['elapsedMs','stage'],'Failure records carry only stage and elapsed milliseconds');
	assert.equal(failures[0].stage,'session');
	assert.equal(Number.isInteger(failures[0].elapsedMs),true);
	const text=JSON.stringify(failures);
	for(const secret of ['01234567','secret.example','SECRETTOKEN','http','token='])assert.ok(!text.includes(secret),'Failure records must not contain '+secret);
});

test('a provider session rejection is reported with stage and elapsed only, and its error is preserved',{timeout:30000},async()=>{
	const failures=[];
	// The rejection message itself contains a URL and token that must never
	// reach a failure record.
	const providerError=Object.assign(Error('Dispatcharr is unavailable to https://secret.example/session?token=SECRETTOKEN. Please try again.'),{status:502});
	const service=createCatchupPlayer({startTimeoutMs:5000,clock:()=>now,onFailure:record=>failures.push(record),
		openArchive:()=>Promise.reject(providerError)});
	const session=await service.start(channel,item);
	try{
		const started=Date.now();
		await assert.rejects(session.read('segment000000000.ts'),error=>{
			assert.equal(error,providerError,'The exact provider error must reach the client unchanged');
			assert.equal(error.status,502);
			return true;
		});
		assert.ok(Date.now()-started<5000,'A rejection must fail fast, not at the deadline');
	}finally{await session.stop();}
	assert.equal(failures.length,1);
	assert.deepEqual(Object.keys(failures[0]).sort(),['elapsedMs','stage'],'Failure records carry only stage and elapsed milliseconds');
	assert.equal(failures[0].stage,'session');
	assert.equal(Number.isInteger(failures[0].elapsedMs),true);
	const text=JSON.stringify(failures);
	for(const secret of ['01234567','secret.example','SECRETTOKEN','http','token=','Dispatcharr'])assert.ok(!text.includes(secret),'Failure records must not contain '+secret);
});

test('a provider session that completes after the deadline is released, not leaked',{timeout:30000},async()=>{
	let released=false;
	const service=createCatchupPlayer({startTimeoutMs:1000,clock:()=>now,onFailure:()=>{},
		openArchive:()=>new Promise(resolve=>setTimeout(()=>resolve({open:()=>{throw Error('never opened');},stop:async()=>{released=true;}}),3000))});
	const session=await service.start(channel,item);
	try{
		await assert.rejects(session.read('segment000000000.ts'),/did not prepare this programme in time/);
	}finally{await session.stop();}
	for(let wait=0;wait<50&&!released;wait++)await sleep(100);
	assert.equal(released,true,'The late provider session must be stopped after the deadline');
});

test('an archive that never supplies data fails the first segment before the client timeout',{skip:!ffmpeg,timeout:60000},async()=>{
	const failures=[];let stops=0;
	const service=createCatchupPlayer({startTimeoutMs:2500,clock:()=>now,onFailure:record=>failures.push(record),
		openArchive:()=>Promise.resolve({open:async()=>new Response(new ReadableStream({start(){}})),stop:async()=>{stops++;}})});
	const session=await service.start(channel,item);
	try{
		const started=Date.now();
		await assert.rejects(session.read('segment000000000.ts'),error=>{
			assert.equal(error.status,502);
			assert.match(error.message,/did not supply this position in time/);
			return true;
		});
		const elapsed=Date.now()-started;
		assert.ok(elapsed<65000,'The failure must arrive before the client 65s read timeout: '+elapsed+'ms');
		assert.ok(elapsed<15000,'The failure must track the bounded deadline: '+elapsed+'ms');
	}finally{await session.stop();}
	assert.ok(stops>=1,'The silent archive must be stopped');
	const segment=failures.find(record=>record.stage==='segment');
	assert.ok(segment,'A segment-stage failure must be reported');
	assert.deepEqual(Object.keys(segment).sort(),['elapsedMs','stage']);
});

test('a healthy archive still starts normally and reports no failures',{skip:!ffmpeg||!ffprobe,timeout:60000},async()=>{
	const sample=fixture(60);
	const failures=[];
	const service=createCatchupPlayer({paceInput:false,clock:()=>now,onFailure:record=>failures.push(record),
		openArchive:()=>Promise.resolve({open:async()=>new Response(sample),stop:async()=>{}})});
	const session=await service.start(channel,item);
	try{
		const first=await session.read('segment000000000.ts');
		assert.ok(first.length>100,'The first segment must encode');
		const fifth=await session.read('segment000000005.ts');
		assert.ok(fifth.length>100,'A later segment in the same window must encode');
		assert.ok(Math.abs(startOf(fifth)-startOf(first)-20)<0.5,'Segments must keep their absolute programme offsets');
	}finally{await session.stop();}
	assert.deepEqual(failures,[],'A healthy start must not report failures');
});

test('a seek still opens the containing minute and encodes the requested section',{skip:!ffmpeg||!ffprobe,timeout:60000},async()=>{
	const sample=fixture(120);
	const opens=[];
	const service=createCatchupPlayer({paceInput:false,clock:()=>now,openArchive:async(id,start,minutes)=>{
		opens.push({start,minutes});return {open:async()=>new Response(sample),stop:async()=>{}};
	}});
	const session=await service.start(channel,item);
	try{
		const zero=await session.read('segment000000000.ts');
		const bytes=await session.read('segment000000012.ts');
		assert.ok(bytes.length>100,'The sought segment must encode');
		assert.ok(Math.abs(startOf(bytes)-startOf(zero)-48)<0.5,'Segment 12 must contain programme time 48s');
	}finally{await session.stop();}
	assert.equal(opens.length,2,'The seek must reopen the provider');
	assert.equal(opens[1].start,item.StartDate,'The seek opens the minute containing 48s');
	assert.equal(opens[1].minutes,6,'The seek requests the bounded 300s window from 48s');
});

test('the default failure log writes only a stage and elapsed milliseconds',{timeout:30000},async()=>{
	const lines=[];const original=console.error;
	console.error=(...args)=>{lines.push(args.map(String).join(' '));};
	try{
		const service=createCatchupPlayer({startTimeoutMs:1000,clock:()=>now,openArchive:id=>new Promise(()=>{void id;})});
		const session=await service.start(channel,item);
		try{
			await assert.rejects(session.read('segment000000000.ts'),/did not prepare this programme in time/);
		}finally{await session.stop();}
	}finally{console.error=original;}
	assert.ok(lines.length>=1,'The default sink must log the failure');
	for(const line of lines){
		assert.match(line,/^catch-up session failed after \d+ms$/,'Logged line must be exactly stage and elapsed milliseconds: '+line);
		assert.ok(!line.includes('01234567'),'The log must not contain channel IDs');
		assert.ok(!line.includes('http'),'The log must not contain URLs');
	}
});
