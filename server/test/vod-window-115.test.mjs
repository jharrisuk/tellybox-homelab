import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createVodPlayer,vodPreset,vodOverrunSegment} from '../vod-player.mjs';

test('VOD preset selector is bounded and defaults to the existing encoder',()=>{
	assert.equal(vodPreset(''),'veryfast');
	assert.equal(vodPreset('veryfast'),'veryfast');
	assert.equal(vodPreset('superfast'),'superfast');
	assert.equal(vodPreset('ultrafast'),'ultrafast');
	assert.equal(vodPreset('placebo'),'veryfast');
	const previous=process.env.TELLYBOX_VOD_PRESET;
	process.env.TELLYBOX_VOD_PRESET='ultrafast';
	try{assert.equal(vodPreset(),'ultrafast');}finally{if(previous===undefined)delete process.env.TELLYBOX_VOD_PRESET;else process.env.TELLYBOX_VOD_PRESET=previous;}
});

const ffmpeg=spawnSync('ffmpeg',['-version']).status===0;
test('overrun detection ignores stale files and accepts only current-encoder writes',()=>{
	const window={windowStart:10,windowEnd:39,startedAt:1500};
	assert.equal(vodOverrunSegment([{index:44,mtimeMs:999}],window),0,'a stale file before the current encoder must not count');
	assert.equal(vodOverrunSegment([{index:44,mtimeMs:1000},{index:45,mtimeMs:1500}],window),45,'a current-encoder write past the bound must count');
	assert.equal(vodOverrunSegment([{index:41,mtimeMs:2000}],window),0,'two segments of tolerance are allowed');
	assert.equal(vodOverrunSegment([{index:9,mtimeMs:2000}],window),0,'files below the current window are irrelevant');
});

test('VOD produces a bounded run ahead instead of waiting on a wall-clock 1x read',{skip:!ffmpeg,timeout:180000},async t=>{
	const dir=await mkdtemp(path.join(os.tmpdir(),'vod-window-'));t.after(()=>rm(dir,{recursive:true,force:true}));
	const file=path.join(dir,'source.ts');
	const built=spawnSync('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=s=320x180:r=25','-f','lavfi','-i','anullsrc=r=48000:cl=stereo','-t','300',
		'-c:v','libx264','-preset','ultrafast','-g','100','-keyint_min','100','-sc_threshold','0','-c:a','aac','-b:a','64k','-f','mpegts',file],{timeout:120000,maxBuffer:8*1024*1024});
	assert.equal(built.status,0,String(built.stderr));
	const bytes=await readFile(file);
	const player=createVodPlayer({open:async(source,{range}={})=>{
		const parts=range?.match(/^bytes=(\d+)-(\d*)$/);const first=parts?Number(parts[1]):0;
		const last=parts&&parts[2]?Math.min(bytes.length-1,Number(parts[2])):bytes.length-1;
		return new Response(bytes.subarray(first,last+1),{status:parts?206:200,headers:{'Content-Type':'video/mp2t','Content-Length':String(last-first+1),'Accept-Ranges':'bytes',...(parts?{'Content-Range':`bytes ${first}-${last}/${bytes.length}`}:{})}});
	}});
	const session=await player.start({type:'movie',uuid:'test'});
	try {
		const first=await session.read('segment000000000.ts');assert.ok(first.length>100);
		const started=Date.now();
		const ahead=await session.read('segment000000020.ts');
		const elapsed=Date.now()-started;
		assert.ok(ahead.length>100);
		assert.ok(elapsed<30000,`segment 20 should already be produced, took ${elapsed}ms`);
		assert.ok(session.producer().produced>=20,'completed files are the producer truth');

		// Segment 60 is beyond the first 120 s run. It starts the next bounded
		// window at the requested segment and must not depend on a wall clock.
		const nextStarted=Date.now();
		const next=await session.read('segment000000060.ts');
		assert.ok(next.length>100);
		assert.ok(Date.now()-nextStarted<30000,'forward window should start at the request');
		assert.ok(session.producer().produced>=60);

		// A backward seek is served from the retained bounded cache.
		const back=await session.read('segment000000005.ts');assert.ok(back.length>100);
		const manifest=(await session.read('index.m3u8')).toString();
		const count=(manifest.match(/#EXTINF:/g)||[]).length;
		assert.ok(count===75||count===76,`unexpected segment count ${count}`);
		assert.match(manifest,/#EXT-X-ENDLIST/);
	}finally{await session.stop();}
});

test('a backward seek past the prune floor is not mistaken for an encoder overrun',{skip:!ffmpeg,timeout:180000},async t=>{
	const dir=await mkdtemp(path.join(os.tmpdir(),'vod-overrun-'));t.after(()=>rm(dir,{recursive:true,force:true}));
	const file=path.join(dir,'source.ts');
	const built=spawnSync('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=s=320x180:r=25','-f','lavfi','-i','anullsrc=r=48000:cl=stereo','-t','300',
		'-c:v','libx264','-preset','ultrafast','-g','100','-keyint_min','100','-sc_threshold','0','-c:a','aac','-b:a','64k','-f','mpegts',file],{timeout:120000,maxBuffer:8*1024*1024});
	assert.equal(built.status,0,String(built.stderr));
	const bytes=await readFile(file);
	const player=createVodPlayer({open:async(source,{range}={})=>{
		const parts=range?.match(/^bytes=(\d+)-(\d*)$/);const first=parts?Number(parts[1]):0;
		const last=parts&&parts[2]?Math.min(bytes.length-1,Number(parts[2])):bytes.length-1;
		return new Response(bytes.subarray(first,last+1),{status:parts?206:200,headers:{'Content-Type':'video/mp2t','Content-Length':String(last-first+1),'Accept-Ranges':'bytes',...(parts?{'Content-Range':`bytes ${first}-${last}/${bytes.length}`}:{})}});
	}});
	const errors=[],original=console.error;console.error=(...args)=>{errors.push(args.map(String).join(' '));};
	const session=await player.start({type:'movie',uuid:'test'});
	try {
		await session.read('segment000000000.ts');
		await session.read('segment000000020.ts');
		// Wait for the prefetch window [30,59] to exist, then for the 3 s prune to
		// delete segments below floor 12. Segment 10 is now a re-encode at [10,39]
		// with stale files 40..59 still on disk.
		for(let wait=0;wait<100;wait++){const p=session.producer();if(p.windowStart>=30&&p.produced>=45)break;await new Promise(r=>setTimeout(r,100));}
		await new Promise(r=>setTimeout(r,3500));
		const segment=await session.read('segment000000010.ts');
		assert.ok(segment.length>100);
		assert.equal(session.producer().windowStart,10,'the pruned segment must be re-encoded at 10');
		assert.ok(!errors.some(line=>line.includes('vod_encoder_overrun')),errors.join('\n'));
	}finally{await session.stop();console.error=original;}
});

test('a seek that kills an in-flight prefetch is not a false overrun',{skip:!ffmpeg,timeout:360000},async t=>{
	const dir=await mkdtemp(path.join(os.tmpdir(),'vod-inflight-'));t.after(()=>rm(dir,{recursive:true,force:true}));
	const file=path.join(dir,'source.ts');
	const built=spawnSync('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=s=1920x1080:r=25','-f','lavfi','-i','anullsrc=r=48000:cl=stereo','-t','240',
		'-c:v','libx264','-preset','ultrafast','-g','100','-keyint_min','100','-sc_threshold','0','-c:a','aac','-b:a','64k','-f','mpegts',file],{timeout:120000,maxBuffer:8*1024*1024});
	assert.equal(built.status,0,String(built.stderr));
	const bytes=await readFile(file);
	let prunedSegment10='';
	const player=createVodPlayer({deps:{rm:async(file,options)=>{
		await rm(file,options);
		if(path.basename(String(file))==='segment000000010.ts')prunedSegment10=String(file);
	}},open:async(source,{range}={})=>{
		const parts=range?.match(/^bytes=(\d+)-(\d*)$/);const first=parts?Number(parts[1]):0;
		const last=parts&&parts[2]?Math.min(bytes.length-1,Number(parts[2])):bytes.length-1;
		return new Response(bytes.subarray(first,last+1),{status:parts?206:200,headers:{'Content-Type':'video/mp2t','Content-Length':String(last-first+1),'Accept-Ranges':'bytes',...(parts?{'Content-Range':`bytes ${first}-${last}/${bytes.length}`}:{})}});
	}});
	const errors=[],original=console.error;console.error=(...args)=>{errors.push(args.map(String).join(' '));};
	const session=await player.start({type:'movie',uuid:'test'});
	try {
		await session.read('segment000000000.ts');
		// The 1080p first window can take over a minute on the 3-CPU Linux image;
		// wait for the actual prefetch start rather than a desktop-speed guess.
		for(let wait=0;wait<1800;wait++){if(session.producer().windowStart>=30)break;await new Promise(r=>setTimeout(r,100));}
		await session.read('segment000000020.ts');
		// Establish a real cache miss in this player's own directory. A fixed
		// 3300 ms sleep races the asynchronous prune; a cached read would validly
		// leave the prefetch running and would not test the seek/re-encode path.
		const pruneDeadline=Date.now()+10000;
		let segment10Missing=false;
		while(!segment10Missing&&Date.now()<pruneDeadline){
			if(prunedSegment10){
				try{await readFile(prunedSegment10);}catch(error){if(error.code==='ENOENT')segment10Missing=true;else throw error;}
			}
			if(!segment10Missing)await new Promise(r=>setTimeout(r,50));
		}
		assert.ok(segment10Missing,'this session must actually prune segment 10 before testing a cache-miss seek');
		assert.ok(session.producer().windowStart>=30,'prefetch window should have started');
		assert.ok(session.producer().produced<59,'prefetch should still be in flight');
		const segment=await session.read('segment000000010.ts');
		assert.ok(segment.length>100);
		assert.equal(session.producer().windowStart,10,'the pruned segment must be re-encoded at 10');
		assert.ok(!errors.some(line=>line.includes('vod_encoder_overrun')),errors.join('\n'));
	}finally{await session.stop();console.error=original;}
});

test('VOD admission still refuses a session over the configured bound',{skip:!ffmpeg,timeout:120000},async t=>{
	const dir=await mkdtemp(path.join(os.tmpdir(),'vod-admission-'));t.after(()=>rm(dir,{recursive:true,force:true}));
	const file=path.join(dir,'source.ts');
	const built=spawnSync('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=s=160x90:r=25','-f','lavfi','-i','anullsrc=r=48000:cl=stereo','-t','8',
		'-c:v','libx264','-preset','ultrafast','-g','100','-c:a','aac','-f','mpegts',file],{timeout:30000,maxBuffer:4*1024*1024});
	assert.equal(built.status,0,String(built.stderr));
	const bytes=await readFile(file);
	const player=createVodPlayer({maxSessions:1,open:async(source,{range}={})=>{
		const parts=range?.match(/^bytes=(\d+)-(\d*)$/);const first=parts?Number(parts[1]):0;
		const last=parts&&parts[2]?Math.min(bytes.length-1,Number(parts[2])):bytes.length-1;
		return new Response(bytes.subarray(first,last+1),{status:parts?206:200,headers:{'Content-Type':'video/mp2t','Content-Length':String(last-first+1),...(parts?{'Content-Range':`bytes ${first}-${last}/${bytes.length}`}:{})}});
	}});
	const first=await player.start({type:'movie',uuid:'one'});
	try{await assert.rejects(()=>player.start({type:'movie',uuid:'two'}),/busy/);}finally{await first.stop();}
});
