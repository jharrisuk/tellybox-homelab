// Consolidation 121 - VOD producer progress regression tests.
// The release-120 prune removes segments below the read floor while the
// producer is still running. The old refreshProduced() rescanned contiguously
// from windowStart, so a pruned early segment rewound produced to the first
// surviving file minus one (PRIMARY live repro: produced 26 -> 2). That false
// reset blocked window prefetch, logged false vod_producer_stall numbers and
// combined with the fixed 45 s wait to fail a slow-but-progressing producer.
//
// PRIMARY's deeper review (Tellybox-121-primary-progress-review.txt) added
// three generation-ownership findings, all covered here:
//   1. a cached old-generation read must not raise current-encoder progress
//      (deterministic integration test below),
//   2. prune() must re-validate window ownership after every await
//      (deterministic barrier test on the exported vodPrune),
//   3. refreshProduced() must discard a scan committed after a generation
//      reset, even when the last old write shares the new start millisecond
//      (deterministic barrier test on the exported vodRefreshProduced).
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readdir,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createVodPlayer,vodProgressSegment,vodPrune,vodRefreshProduced} from '../vod-player.mjs';
import {hasFfmpeg,h264Tiny,hevc1080p,loadBytes,rangeOpener,segmentSizes} from './consolidation-121-vod-fixture.mjs';

test('progress candidate counts only current-encoder files and ignores pruned gaps',()=>{
	const startedAt=1000;
	assert.equal(vodProgressSegment([{index:3,mtimeMs:1500},{index:4,mtimeMs:1600},{index:26,mtimeMs:2000}],{windowStart:3,startedAt}),26);
	// Prune removed 3..18; the highest surviving current-encoder file wins.
	assert.equal(vodProgressSegment([{index:19,mtimeMs:1900},{index:26,mtimeMs:2000}],{windowStart:3,startedAt}),26);
	// Stale files from an earlier generation never raise or hold progress.
	assert.equal(vodProgressSegment([{index:19,mtimeMs:900},{index:40,mtimeMs:900}],{windowStart:3,startedAt}),2);
	// A last old write sharing the new start millisecond is still stale.
	assert.equal(vodProgressSegment([{index:59,mtimeMs:2000}],{windowStart:3,startedAt:2000}),2);
	// Below the window start, the floor is windowStart-1 and stale files are ignored.
	assert.equal(vodProgressSegment([{index:0,mtimeMs:500}],{windowStart:3,startedAt}),2);
});

test('an async progress scan cannot commit after a generation reset, even with a colliding start millisecond',async()=>{
	// Mirrors PRIMARY repro: the scan pauses inside stat, encode() resets to a
	// new window with a startedAt equal to the last old write's mtime, and the
	// old stat then resolves. The generation guard must discard the result.
	let entered,resume;
	const enteredPromise=new Promise(r=>entered=r);
	const oldStat=new Promise(r=>resume=r);
	const job={directory:'fixture',windowStart:30,windowEnd:59,encoderStartedAt:1000,generation:1,produced:29};
	const io={readdir:async()=>['segment000000059.ts'],stat:async()=>{entered();return oldStat;}};
	const scan=vodRefreshProduced(job,io);
	await enteredPromise;
	Object.assign(job,{windowStart:3,windowEnd:32,encoderStartedAt:2000,generation:2,produced:2});
	resume({mtimeMs:2000});
	await scan;
	assert.equal(job.produced,2,'an old scan must not commit after the generation reset');
	// Without a reset the same scan commits the prune-safe high-water mark.
	const plain={directory:'fixture',windowStart:30,windowEnd:59,encoderStartedAt:1000,generation:1,produced:29};
	await vodRefreshProduced(plain,{readdir:async()=>['segment000000059.ts'],stat:async()=>({mtimeMs:1500})});
	assert.equal(plain.produced,59,'a same-generation scan must commit the high-water mark');
});

test('prune re-validates window ownership after the readdir boundary and never deletes a newly active segment',async()=>{
	// Mirrors PRIMARY repro: prune captured requested=20/windowEnd=29, the
	// readdir pauses, the encoder advances to requested=30/windowEnd=59 and
	// produces segment 30, and readdir then returns it. The stale snapshot
	// must not delete the new window's own segment.
	let entered,releaseNames;
	const enteredPromise=new Promise(r=>entered=r);
	const names=new Promise(r=>releaseNames=r);
	const job={stopped:false,pruning:false,directory:'fixture',requested:20,windowEnd:29,generation:1,captionFiles:[]};
	const removed=[];
	const io={readdir:async()=>{entered();return names;},rm:async file=>removed.push(file),stat:async()=>({size:1})};
	const pruning=vodPrune(job,io,1000);
	await enteredPromise;
	Object.assign(job,{requested:30,windowEnd:59});
	releaseNames(['segment000000030.ts']);
	await pruning;
	assert.deepEqual(removed,[],'the newly active segment must survive');
	// A generation change while the pass is in flight must abandon it.
	let entered2,release2;
	const entered2Promise=new Promise(r=>entered2=r);
	const names2=new Promise(r=>release2=r);
	const job2={stopped:false,pruning:false,directory:'fixture',requested:20,windowEnd:29,generation:1,captionFiles:[]};
	const removed2=[];
	const io2={readdir:async()=>{entered2();return names2;},rm:async file=>removed2.push(file),stat:async()=>({size:1})};
	const pruning2=vodPrune(job2,io2,1000);
	await entered2Promise;
	job2.generation=2;
	release2(['segment000000012.ts']);
	await pruning2;
	assert.deepEqual(removed2,[],'a prune must abandon when the encoder generation advances');
	// Far-past files below the floor are still removed when ownership holds.
	const stale={stopped:false,pruning:false,directory:'fixture',requested:20,windowEnd:29,generation:1,captionFiles:[]};
	const staleRemoved=[];
	await vodPrune(stale,{readdir:async()=>['segment000000002.ts','segment000000020.ts'],rm:async f=>staleRemoved.push(f),stat:async()=>({size:1})},1000);
	assert.equal(staleRemoved.length,1,'exactly the far-past segment must be removed');
	assert.match(staleRemoved[0],/segment000000002\.ts$/,'the floor check must drop the far-past segment');
});

test('sequential playback past the prune floor keeps progress monotonic and prefetches the next window',{skip:!hasFfmpeg,timeout:300000},async t=>{
	const dir=await mkdtemp(path.join(os.tmpdir(),'vod121-progress-'));t.after(()=>rm(dir,{recursive:true,force:true}));
	const fixture=await h264Tiny({seconds:300,size:'1920x1080'});
	const bytes=await loadBytes(fixture.file);
	const errors=[],original=console.error;console.error=(...args)=>{errors.push(args.map(String).join(' '));};
	// Isolate this test's VOD temp directory. Parallel test files create their
	// own tellybox-vod-* directories; without this the folder lookup can select
	// another session and make the prune assertions flaky.
	const root=await mkdtemp(path.join(os.tmpdir(),'vod121-progress-root-'));
	const savedTemp={TMP:process.env.TMP,TEMP:process.env.TEMP,TMPDIR:process.env.TMPDIR};
	process.env.TMP=process.env.TEMP=process.env.TMPDIR=root;
	// The fixture is already built in the default temp; only the player temp is isolated.
	const before=new Set(await readdir(os.tmpdir()));
	const player=createVodPlayer({open:rangeOpener(bytes)});
	const session=await player.start({type:'episode',uuid:'progress'});
	try{
		let previous=-1;
		for(let n=0;n<=16;n++){
			const got=await session.read('segment'+String(n).padStart(9,'0')+'.ts');
			assert.ok(got.length>1000,'segment '+n+' must be produced');
			const produced=session.producer().produced;
			assert.ok(produced>=previous,`progress must be monotonic within the generation: segment ${n} saw produced ${previous} -> ${produced}`);
			previous=produced;
		}
		// Keep reading to the end of the first 120 s window; the prune floor
		// (requested-8) removes early segments while production continues.
		for(let n=17;n<=29;n++){
			const got=await session.read('segment'+String(n).padStart(9,'0')+'.ts');
			assert.ok(got.length>1000,'segment '+n+' must be produced');
			assert.ok(session.producer().produced>=previous,`progress regressed after segment ${n}: ${previous} -> ${session.producer().produced}`);
			previous=session.producer().produced;
		}
		assert.ok(previous>=29,'the whole first window must count as produced');
		assert.ok(!errors.some(line=>line.includes('vod_producer_stall')),errors.join('\n'));
		// Prune must have removed well over eight early segments by now. The
		// baseline was captured before start, so the owned directory is found.
		await new Promise(r=>setTimeout(r,3500));
		const folder=await sessionFolder(before);
		assert.ok(folder,'the live VOD temp directory must be found');
		const sizes=await segmentSizes(folder);
		assert.ok(sizes.some(s=>s.index>=29),'late segments must remain');
		assert.ok(!sizes.some(s=>s.index<12),'segments below the prune floor must be gone');
		// The completed window must prefetch the next one without a client
		// request for segment 30: this is exactly what the false reset broke.
		for(let wait=0;wait<200;wait++){
			if(session.producer().windowStart>=30)break;
			await new Promise(r=>setTimeout(r,100));
		}
		assert.ok(session.producer().windowStart>=30,'the next window must be prefetched after the first completes');
		await session.read('segment000000030.ts');
		assert.ok(!errors.some(line=>line.includes('vod_producer_stall')),errors.join('\n'));
	}finally{
		await session.stop();console.error=original;
		for(const key of Object.keys(savedTemp)){if(savedTemp[key]===undefined)delete process.env[key];else process.env[key]=savedTemp[key];}
		await rm(root,{recursive:true,force:true});
	}
});

test('a cached old-generation read serves bytes but never raises current-encoder progress',{skip:!hasFfmpeg,timeout:300000},async t=>{
	const dir=await mkdtemp(path.join(os.tmpdir(),'vod121-cache-'));t.after(()=>rm(dir,{recursive:true,force:true}));
	const fixture=await h264Tiny({seconds:300,size:'320x180'});
	const bytes=await loadBytes(fixture.file);
	// Input-throttled so the current generation stays near its window start
	// while the cached read happens: fresh produced can never approach the
	// cached index within the test, so the assertion is timing-independent.
	const throttleBps=Math.round((bytes.length/300)*0.72);
	const player=createVodPlayer({open:rangeOpener(bytes,{throttleBps})});
	const session=await player.start({type:'episode',uuid:'cache'});
	try{
		// First generation: window 59..88, and segment 60 definitely exists.
		await session.read('segment000000059.ts');
		await session.read('segment000000060.ts');
		// Backward seek inside the old window's range: a new generation owns
		// window 40..69, and the retained old files 59..60 are inside it, so
		// prune keeps them while the new encoder produces from 40.
		await session.read('segment000000040.ts');
		assert.equal(session.producer().windowStart,40,'the backward seek must start a new generation');
		const before=session.producer().produced;
		assert.ok(before<50,'the fresh producer must still be near its window start');
		// Reading the old-generation cached segment is valid; reporting it as
		// current-encoder progress is not.
		const cached=await session.read('segment000000060.ts');
		assert.ok(cached.length>1000,'the retained cached segment must still be served');
		assert.ok(session.producer().produced<50,`a cached old-generation read must not raise produced (saw ${session.producer().produced})`);
		assert.ok(session.producer().produced>=before,'progress must remain monotonic');
	}finally{await session.stop();}
});

// Locate the live job directory without reaching into player internals. The
// baseline must be captured before the session starts, or the lookup excludes
// the running session and prune assertions silently skip.
async function sessionFolder(before){
	const dirs=(await readdir(os.tmpdir())).filter(name=>name.startsWith('tellybox-vod-')&&!before.has(name));
	for(const name of dirs){
		const folder=path.join(os.tmpdir(),name);
		try{const entries=await readdir(folder);if(entries.some(e=>/^segment\d{9}\.ts$/.test(e)))return folder;}catch{}
	}
	return null;
}

test('an encoder transition waits for the whole in-flight prune pass, so a dispatched deletion cannot touch the new generation',{skip:!hasFfmpeg,timeout:300000},async t=>{
	const dir=await mkdtemp(path.join(os.tmpdir(),'vod121-rmbarrier-'));t.after(()=>rm(dir,{recursive:true,force:true}));
	const fixture=await h264Tiny({seconds:300,size:'320x180'});
	const bytes=await loadBytes(fixture.file);
	// A real filesystem rm wrapped with a barrier on the first below-floor
	// segment deletion. Once the prune has dispatched that rm it blocks, and
	// the next encoder transition must wait for the whole pass to finish.
	const realRm=await import('node:fs/promises').then(m=>m.rm);
	let rmEntered,rmRelease,blocked=false;
	const rmEnteredPromise=new Promise(r=>rmEntered=r);
	const rmReleasePromise=new Promise(r=>rmRelease=r);
	const wrappedRm=async(file,options)=>{
		if(!blocked&&/segment\d{9}\.ts$/.test(file)&&Number(file.match(/(\d{9})\.ts$/)[1])<20){
			blocked=true;rmEntered();await rmReleasePromise;
		}
		return realRm(file,options);
	};
	const player=createVodPlayer({open:rangeOpener(bytes),deps:{rm:wrappedRm}});
	const errors=[],original=console.error;console.error=(...args)=>{errors.push(args.map(String).join(' '));};
	const session=await player.start({type:'episode',uuid:'rmbarrier'});
	try{
		for(let n=0;n<=12;n++)await session.read('segment'+String(n).padStart(9,'0')+'.ts');
		// The 3 s prune cycle now dispatches the blocked rm for an early
		// segment below the read floor (requested=12, floor=4).
		await Promise.race([rmEnteredPromise,new Promise((_,reject)=>setTimeout(()=>reject(Error('the prune never dispatched a deletion')),15000))]);
		// Request a window BEYOND the automatic prefetch (which may already
		// have started 30..59): the encode for 65 must not publish its new
		// generation while the prune deletion is in flight, and prune
		// intervals firing during the block must stay serialized behind it.
		const baseline=session.producer().windowStart;
		const nextWindow=session.read('segment000000065.ts');
		await new Promise(r=>setTimeout(r,6500));
		assert.equal(session.producer().windowStart,baseline,`the new generation must not start while a prune deletion is in flight (two prune intervals passed; baseline ${baseline})`);
		rmRelease();
		const segment65=await nextWindow;
		assert.ok(segment65.length>1000,'segment 65 must be produced after the prune pass completes');
		assert.ok(session.producer().windowStart>=65,'the encoder transition must run after the prune pass');
		assert.ok(session.producer().produced>=65,'the new-generation segment must survive the earlier deletion');
		assert.ok(!errors.some(line=>line.includes('vod_producer_stall')),errors.join('\n'));
	}finally{await session.stop();console.error=original;}
});

test('a slow but progressing producer serves mid-window reads, never false-stalls, and survives the no-read watchdog',{skip:!hasFfmpeg,timeout:360000},async t=>{
	const dir=await mkdtemp(path.join(os.tmpdir(),'vod121-slow-'));t.after(()=>rm(dir,{recursive:true,force:true}));
	// Bounded representative source, input-throttled to 0.6x. A 120 s fixture
	// keeps the test under the Linux 6-minute bound while still forcing the far
	// read past the old 45 s deadline. The separate 1080p sequential test covers
	// the HEVC window boundary and pruning.
	const fixture=await h264Tiny({seconds:120,size:'320x180'});
	const bytes=await loadBytes(fixture.file);
	const sourceBps=bytes.length/120;
	const throttleBps=Math.round(sourceBps*0.6);
	const errors=[],original=console.error;console.error=(...args)=>{errors.push(args.map(String).join(' '));};
	const before=new Set(await readdir(os.tmpdir()));
	const player=createVodPlayer({open:rangeOpener(bytes,{throttleBps})});
	const session=await player.start({type:'episode',uuid:'slow'});
	let folder='',sessionDir='';
	try{
		const first=await Promise.race([
			session.read('segment000000000.ts'),
			new Promise((_,reject)=>setTimeout(()=>reject(Error('fail-fast: no first segment produced within 120 s')),120000)),
		]);
		assert.ok(first.length>1000,'first segment must be produced');
		folder=await sessionFolder(before)||'';
		assert.ok(folder,'the live VOD temp directory must be found');
		sessionDir=path.basename(folder);
		const started=Date.now();
		let samples=[],previous=-1;
		const sampler=setInterval(()=>{
			const p=session.producer().produced;
			if(p<previous)samples.push({kind:'regression',from:previous,to:p});
			previous=p;
		},2000).unref();
		const far=await Promise.race([
			session.read('segment000000020.ts'),
			new Promise((_,reject)=>setTimeout(()=>reject(Error('fail-fast: the far mid-window read did not complete within 300 s')),300000)),
		]);
		clearInterval(sampler);
		const waited=Date.now()-started;
		assert.ok(far.length>1000,'mid-window segment must eventually be produced');
		assert.ok(waited>45000,`the read must outlive the old fixed 45 s deadline (waited ${waited}ms)`);
		assert.ok(waited<240000,`the read must stay under the hard cap (waited ${waited}ms)`);
		assert.deepEqual(samples,[],`progress regressed during the wait: ${JSON.stringify(samples)}`);
		assert.ok(session.producer().produced>=20,'produced must reach the requested segment');
		assert.ok(!errors.some(line=>line.includes('vod_producer_stall')),errors.join('\n'));
		// The prune floor crossed during the wait (20-8=12).
		await new Promise(r=>setTimeout(r,3500));
		folder=await sessionFolder(before);
		assert.ok(folder,'the live VOD temp directory must be found');
		const sizes=await segmentSizes(folder);
		assert.ok(!sizes.some(s=>s.index<12),'segments below the prune floor (20-8) must be pruned during production');
	}finally{
		await session.stop();
		console.error=original;
		// stop() must remove the session's own temp directory promptly.
		for(let wait=0;wait<50;wait++){
			if(!(await readdir(os.tmpdir())).includes(sessionDir))break;
			await new Promise(r=>setTimeout(r,200));
		}
		const afterDirs=(await readdir(os.tmpdir())).filter(name=>name===sessionDir);
		assert.deepEqual(afterDirs,[],'stop() must remove the VOD temp directory');
	}
});
