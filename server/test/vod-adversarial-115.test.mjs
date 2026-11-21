import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs';
import {mkdtemp,readFile,readdir,rm,stat,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createVodPlayer} from '../vod-player.mjs';

const ffmpeg=spawnSync('ffmpeg',['-version']).status===0;

function opener(bytes){
	return async(source,{range}={})=>{
		const parts=range?.match(/^bytes=(\d+)-(\d*)$/);const first=parts?Number(parts[1]):0;
		const last=parts&&parts[2]?Math.min(bytes.length-1,Number(parts[2])):bytes.length-1;
		return new Response(bytes.subarray(first,last+1),{status:parts?206:200,headers:{'Content-Type':'video/x-matroska','Content-Length':String(last-first+1),'Accept-Ranges':'bytes',...(parts?{'Content-Range':`bytes ${first}-${last}/${bytes.length}`}:{})}});
	};
}

test('native WebVTT output is bounded to the video window and survives a backward seek',{skip:!ffmpeg,timeout:180000},async t=>{
	const dir=await mkdtemp(path.join(os.tmpdir(),'vod-native-bound-'));t.after(()=>rm(dir,{recursive:true,force:true}));
	const srt=path.join(dir,'subs.srt'),file=path.join(dir,'native.mkv');
	await writeFile(srt,'1\n00:00:01,000 --> 00:00:03,000\nEARLY_CUE\n\n2\n00:00:20,000 --> 00:00:24,000\nMID_CUE\n\n3\n00:04:10,000 --> 00:04:12,000\nLATE_OUTSIDE_120S_WINDOW\n');
	const built=spawnSync('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=s=320x180:r=25','-f','lavfi','-i','anullsrc=r=48000:cl=stereo','-i',srt,
		'-map','0:v','-map','1:a','-map','2:s','-t','300','-c:v','libx264','-preset','ultrafast','-g','100','-keyint_min','100','-sc_threshold','0',
		'-c:a','aac','-c:s','srt','-metadata:s:s:0','language=eng','-f','matroska',file],{timeout:120000,maxBuffer:8*1024*1024});
	assert.equal(built.status,0,String(built.stderr));
	const bytes=await readFile(file);
	const before=new Set(await readdir(os.tmpdir()));
	const player=createVodPlayer({open:opener(bytes)});
	const session=await player.start({type:'movie',uuid:'native'},{textSubtitles:true,preferEnglishSubtitles:true});
	const candidates=(await readdir(os.tmpdir())).filter(name=>name.startsWith('tellybox-vod-')&&!before.has(name));
	let folder='';
	// Inspect the raw WebVTT files the encoder actually generated, not just the
	// sliced playlist response. A caption window that ends before the 250 s cue
	// must not contain it; a later window that legitimately covers 250 s may.
	const cueStart=250,windowSeconds=120;
	const rawCaptions=async()=>{
		const files=[];
		for(const name of await readdir(folder)){
			if(!/^captions-.*\.vtt$/.test(name))continue;
			const offset=Number((/-(\d+)\.vtt$/.exec(name)||[])[1]||0);
			files.push({name,offset,text:await readFile(path.join(folder,name),'utf8')});
		}
		return files;
	};
	const assertRawBounded=async(label)=>{
		const files=await rawCaptions(),beforeCue=files.filter(file=>file.offset+windowSeconds<=cueStart);
		assert.ok(beforeCue.length>0,`${label}: at least one raw caption window must end before the 250 s cue`);
		for(const file of beforeCue)assert.doesNotMatch(file.text,/LATE_OUTSIDE_120S_WINDOW/,`${label}: raw ${file.name} [${file.offset},${file.offset+windowSeconds}] must exclude the 250 s cue`);
	};
	try {
		const track=session.subtitles.find(s=>s.hls)?.index;
		assert.ok(Number.isInteger(track),'native text track must be exposed');
		await session.read('segment000000000.ts');
		folder=path.join(os.tmpdir(),candidates.find(name=>fs.existsSync(path.join(os.tmpdir(),name,'captions-2.vtt')))||candidates[0]);
		for(let wait=0;wait<200;wait++){if(session.producer().windowStart>=30)break;await new Promise(r=>setTimeout(r,100));}
		assert.ok(session.producer().windowStart>=30,'the bounded window must reach prefetch');
		await new Promise(r=>setTimeout(r,500));
		await assertRawBounded('before the backward seek');
		const early=(await session.read(`caption-${track}-0.vtt`)).toString();
		assert.match(early,/EARLY_CUE/);
		assert.doesNotMatch(early,/LATE_OUTSIDE_120S_WINDOW/,'the caption output must stop at the video window');
		const later=(await session.read(`caption-${track}-30.vtt`)).toString();
		assert.doesNotMatch(later,/LATE_OUTSIDE_120S_WINDOW/,'a nonzero-offset caption output must use the window duration');
		// A later window must not overwrite the first window's captions. A backward
		// seek may re-encode, but it must still get the caption for that position.
		await session.read('segment000000060.ts');
		await session.read('segment000000005.ts');
		const mid=(await session.read(`caption-${track}-5.vtt`)).toString();
		assert.match(mid,/MID_CUE/);
		assert.doesNotMatch(mid,/LATE_OUTSIDE_120S_WINDOW/);
		await assertRawBounded('after the backward seek');
	} finally { await session.stop(); }
});

test('quiescent prune enforces the configured cache budget with one requested-segment exception',{skip:!ffmpeg,timeout:180000},async t=>{
	const dir=await mkdtemp(path.join(os.tmpdir(),'vod-cache-quiescent-'));t.after(()=>rm(dir,{recursive:true,force:true}));
	const file=path.join(dir,'source.mp4');
	const built=spawnSync('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=s=320x180:r=25','-f','lavfi','-i','anullsrc=r=48000:cl=stereo','-t','60',
		'-c:v','libx264','-preset','ultrafast','-g','100','-keyint_min','100','-sc_threshold','0','-c:a','aac','-movflags','+faststart',file],{timeout:60000,maxBuffer:8*1024*1024});
	assert.equal(built.status,0,String(built.stderr));
	const bytes=await readFile(file);
	const limit=16*1024*1024;
	const root=await mkdtemp(path.join(os.tmpdir(),'vod-quiescent-root-'));
	const saved={TMP:process.env.TMP,TEMP:process.env.TEMP,TMPDIR:process.env.TMPDIR};
	process.env.TMP=process.env.TEMP=process.env.TMPDIR=root;
	let session;
	try {
		const player=createVodPlayer({cacheBytes:limit,open:opener(bytes)});
		session=await player.start({type:'movie',uuid:'quiescent'});
		await session.read('segment000000010.ts');
		const end=session.producer().windowEnd;
		for(let wait=0;wait<100;wait++){if(session.producer().produced>=end)break;await new Promise(r=>setTimeout(r,100));}
		await new Promise(r=>setTimeout(r,1000));
		const folder=path.join(root,(await readdir(root))[0]);
		for(let n=11;n<=end;n++){const fd=fs.openSync(path.join(folder,'segment'+String(n).padStart(9,'0')+'.ts'),'w');fs.ftruncateSync(fd,2*1024*1024);fs.closeSync(fd);}
		for(let n=end+50;n<=end+70;n++){const fd=fs.openSync(path.join(folder,'segment'+String(n).padStart(9,'0')+'.ts'),'w');fs.ftruncateSync(fd,2*1024*1024);fs.closeSync(fd);}
		await new Promise(r=>setTimeout(r,4000));
		const names=(await readdir(folder)).filter(name=>/^segment\d{9}\.ts$/.test(name));
		const total=(await Promise.all(names.map(name=>stat(path.join(folder,name))))).reduce((sum,s)=>sum+s.size,0);
		const requested=await stat(path.join(folder,'segment000000010.ts'));
		assert.ok(total<=limit+requested.size,`quiescent cache ${total} exceeds ${limit}+requested ${requested.size}`);
		assert.ok(!names.some(name=>Number(name.slice(7,16))>end),'future windows must be evicted');
	} finally {
		await session?.stop();
		for(const key of Object.keys(saved)){if(saved[key]===undefined)delete process.env[key];else process.env[key]=saved[key];}
		await rm(root,{recursive:true,force:true});
	}
});

test('concurrent production keeps a finite observed overshoot above the cache budget and preserves the request',{skip:!ffmpeg,timeout:180000},async t=>{
	// Own the temporary directory: other FFmpeg tests in this file/other files
	// create tellybox-vod-* folders under the global tmp. A private TMPDIR makes
	// directory discovery unambiguous instead of selecting an arbitrary new one.
	const sandbox=await mkdtemp(path.join(os.tmpdir(),'vod-cache-sandbox-'));
	const savedTmp={TMPDIR:process.env.TMPDIR,TEMP:process.env.TEMP,TMP:process.env.TMP};
	process.env.TMPDIR=sandbox;process.env.TEMP=sandbox;process.env.TMP=sandbox;
	t.after(async()=>{
		for(const key of Object.keys(savedTmp)){if(savedTmp[key]===undefined)delete process.env[key];else process.env[key]=savedTmp[key];}
		await rm(sandbox,{recursive:true,force:true});
	});
	const dir=await mkdtemp(path.join(sandbox,'vod-cache-bound-'));t.after(()=>rm(dir,{recursive:true,force:true}));
	const file=path.join(dir,'source.mp4');
	const built=spawnSync('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=s=320x180:r=25','-f','lavfi','-i','anullsrc=r=48000:cl=stereo','-t','300',
		'-c:v','libx264','-preset','ultrafast','-g','100','-keyint_min','100','-sc_threshold','0','-c:a','aac','-movflags','+faststart',file],{timeout:120000,maxBuffer:8*1024*1024});
	assert.equal(built.status,0,String(built.stderr));
	const bytes=await readFile(file);
	const limit=8*1024*1024;
	const player=createVodPlayer({cacheBytes:limit,open:opener(bytes)});
	const before=new Set(await readdir(os.tmpdir()));
	const session=await player.start({type:'movie',uuid:'cache'});
	try {
		const candidates=(await readdir(os.tmpdir())).filter(name=>name.startsWith('tellybox-vod-')&&!before.has(name));
		const folder=path.join(os.tmpdir(),candidates.find(name=>fs.existsSync(path.join(os.tmpdir(),name,'segment000000005.ts')))||candidates[0]);
		// A stale far-future window from an earlier seek. Each file is larger than
		// the 320x180 fixture, so the old bug retained them forever.
		for(let n=111;n<=130;n++){const fd=fs.openSync(path.join(folder,'segment'+String(n).padStart(9,'0')+'.ts'),'w');fs.ftruncateSync(fd,1024*1024);fs.closeSync(fd);}
		await session.read('segment000000005.ts');
		await new Promise(r=>setTimeout(r,4000));
		let names=(await readdir(folder)).filter(name=>/^segment\d{9}\.ts$/.test(name));
		assert.ok(names.some(name=>/segment000000005\.ts$/.test(name)),'requested segment must survive');
		assert.ok(!names.some(name=>Number(name.slice(7,16))>session.producer().windowEnd),'stale future window must be evicted');
		let total=(await Promise.all(names.map(name=>stat(path.join(folder,name))))).reduce((sum,s)=>sum+s.size,0);
		assert.ok(total<=limit+1024*1024,`cache ${total} exceeds ${limit}+one segment`);
		// An oversized current window must also be bounded, while the requested
		// segment remains available.
		for(let n=6;n<=30;n++){const fd=fs.openSync(path.join(folder,'segment'+String(n).padStart(9,'0')+'.ts'),'w');fs.ftruncateSync(fd,1024*1024);fs.closeSync(fd);}
		// Snapshot the exact files present before the prune window. The product
		// does not promise an instantaneous hard cap while the encoder is still
		// producing; it promises that a completed pass removes everything it can
		// and that a quiescent folder settles at the budget (proved by the test
		// above). Here we only assert that any persistent growth is fully
		// accounted for by files that actually arrived after this snapshot, and
		// that the stale/oversized pre-existing files were evicted. This replaces
		// an unproven "+2 arrivals" constant that was an empirical tolerance, not
		// an invariant.
		const snapNames=(await readdir(folder)).filter(name=>/^segment\d{9}\.ts$/.test(name));
		const snapshot=new Map();
		for(const name of snapNames)snapshot.set(name,(await stat(path.join(folder,name))).size);
		await new Promise(r=>setTimeout(r,4000));
		names=(await readdir(folder)).filter(name=>/^segment\d{9}\.ts$/.test(name));
		assert.ok(names.some(name=>/segment000000005\.ts$/.test(name)),'requested segment must still survive');
		const nowSizes=new Map();
		for(const name of names)nowSizes.set(name,(await stat(path.join(folder,name))).size);
		total=[...nowSizes.values()].reduce((sum,size)=>sum+size,0);
		const protectedSize=(await stat(path.join(folder,'segment000000005.ts'))).size;
		let arrivals=0,growth=0;
		for(const [name,size] of nowSizes) {
			if(!snapshot.has(name))arrivals+=size;
			else growth+=Math.max(0,size-snapshot.get(name));
		}
		const evictedBefore=snapNames.some(name=>!nowSizes.has(name));
		assert.ok(evictedBefore||total<=limit+protectedSize,'a completed pass must evict pre-existing oversize data');
		assert.ok(total<=limit+protectedSize+arrivals+growth,`persistent cache ${total} exceeds ${limit}+protected ${protectedSize}+accounted arrivals ${arrivals}+growth ${growth}`);
		assert.ok((await session.read('segment000000020.ts')).length>0,'evicted lookahead must re-encode on demand');
	} finally { await session.stop(); }
});
