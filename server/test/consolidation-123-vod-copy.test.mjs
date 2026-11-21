import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync} from 'node:fs';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {
	createVodPlayer,vodCopyEligible,vodCopyProfileSupported,vodCopySegmentSeconds,vodCopyTailCleanup,vodCopyTailPlan,vodManifest
} from '../vod-player.mjs';
import {captionManifest} from '../vod-captions.mjs';
import {capabilities,hasFfmpeg,hevcAllIntra,hevcLateGop,hevcMixedGop,hevcSmall,h264Aac,h264Ac3,h264Tail,h264Truncated,fileOpener,rangeOpener} from './consolidation-123-vod-fixture.mjs';

const ffmpeg=hasFfmpeg;
const fixture1080=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..','outputs/Tellybox-consolidation-121/vod/fixture/hevc-1080p25-180s-srt.mkv');

function packets(file,select='v:0') {
	const result=spawnSync('ffprobe',['-v','error','-select_streams',select,'-show_entries','packet=pts_time','-of','csv=p=0',file],{encoding:'utf8',timeout:60000,maxBuffer:256*1024*1024});
	assert.equal(result.status,0,result.stderr);
	return String(result.stdout||'').trim().split(/\r?\n/).filter(Boolean).map(line=>Number(line.replace(/,$/,''))).filter(Number.isFinite);
}

function streamInfo(file,select='v:0') {
	const result=spawnSync('ffprobe',['-v','error','-select_streams',select,'-show_entries','stream=codec_name,profile,channels','-of','json',file],{encoding:'utf8',timeout:60000});
	assert.equal(result.status,0,result.stderr);
	return JSON.parse(result.stdout||'{}').streams?.[0]||{};
}

function formatDuration(file) {
	const result=spawnSync('ffprobe',['-v','error','-show_entries','format=duration','-of','csv=p=0',file],{encoding:'utf8',timeout:60000});
	assert.equal(result.status,0,result.stderr);
	return Number(String(result.stdout||'').trim());
}

function extinf(manifest) {
	return [...manifest.matchAll(/#EXTINF:([\d.]+)/g)].map(match=>Number(match[1]));
}

function assertPlaylistConsistent(manifest) {
	const levels=extinf(manifest);
	const target=Number(/#EXT-X-TARGETDURATION:(\d+)/.exec(manifest)?.[1]);
	assert.ok(levels.length>0);
	assert.ok(target>=Math.max(...levels),`TARGETDURATION ${target} must cover every EXTINF (max ${Math.max(...levels)})`);
	return levels;
}

function framemd5(file,{ss=0,count=3}={}) {
	const args=['-v','error'];
	if(ss)args.push('-ss',String(ss));
	args.push('-i',file,'-map','0:v:0','-frames:v',String(count),'-f','framemd5','-');
	const result=spawnSync('ffmpeg',args,{encoding:'utf8',timeout:60000,maxBuffer:64*1024*1024});
	assert.equal(result.status,0,result.stderr);
	return String(result.stdout||'').split(/\r?\n/).filter(line=>/^\d/.test(line)).map(line=>line.split(',').pop().trim());
}

function decode(file) {
	const result=spawnSync('ffmpeg',['-v','error','-i',file,'-map','0:v:0','-frames:v','3','-f','null','-'],{encoding:'utf8',timeout:60000});
	assert.equal(result.status,0,result.stderr);
	return true;
}

async function segmentFile(t,name,bytes) {
	const dir=await mkdtemp(path.join(os.tmpdir(),'vod123-seg-'));
	t.after(()=>rm(dir,{recursive:true,force:true}));
	const file=path.join(dir,name);
	await writeFile(file,bytes);
	return file;
}

test('copy profile/level validation fails closed for 10-bit and unknown profiles',()=>{
	const caps=capabilities();
	assert.equal(vodCopyProfileSupported({codec_name:'h264',profile:'High',level:41},caps),true);
	assert.equal(vodCopyProfileSupported({codec_name:'h264',profile:'Main',level:40},caps),true);
	assert.equal(vodCopyProfileSupported({codec_name:'h264',profile:'High 10',level:41},caps),false);
	assert.equal(vodCopyProfileSupported({codec_name:'h264',profile:'High 4:4:4 Predictive',level:41},caps),false);
	assert.equal(vodCopyProfileSupported({codec_name:'h264',profile:'High',level:0},caps),false);
	assert.equal(vodCopyProfileSupported({codec_name:'hevc',profile:'Main',level:120},caps),true);
	assert.equal(vodCopyProfileSupported({codec_name:'hevc',profile:'Main 10',level:120},{...caps,hevcMain10:false}),false);
	assert.equal(vodCopyProfileSupported({codec_name:'hevc',profile:'Main 10',level:120},{...caps,hevcMain10:true}),true);
	assert.equal(vodCopyProfileSupported({codec_name:'hevc',profile:'Rext',level:120},caps),false);
	assert.equal(vodCopyProfileSupported({codec_name:'mpeg4',profile:'Main',level:1},caps),false);
});

test('copy eligibility requires capabilities, profile, container, audio and quality',()=>{
	const caps=capabilities();
	const video={codec_name:'hevc',profile:'Main',level:120,pix_fmt:'yuv420p',width:1920,height:1080,r_frame_rate:'25/1',bit_rate:9000000};
	const format={format_name:'matroska',bit_rate:9485389};
	const audio={codec_name:'aac',channels:2};
	const base={capabilities:caps,quality:20000000,audio,container:'matroska'};
	assert.equal(vodCopyEligible(video,format,base),true);
	assert.equal(vodCopyEligible(video,format,{...base,capabilities:null}),false,'absent capabilities fail closed');
	assert.equal(vodCopyEligible(video,format,{...base,capabilities:{...caps,hls:false}}),false,'no HLS fails closed');
	assert.equal(vodCopyEligible(video,format,{...base,capabilities:{...caps,mpegTs:false}}),false,'no MPEG-TS fails closed');
	assert.equal(vodCopyEligible(video,format,{...base,quality:4000000}),false,'quality ceiling is respected');
	assert.equal(vodCopyEligible(video,format,{...base,audio:{codec_name:'mlp',channels:2}}),false,'unknown audio fails closed');
	assert.equal(vodCopyEligible(video,format,{...base,audio:{codec_name:'aac',channels:10}}),false,'too many channels fail closed');
	assert.equal(vodCopyEligible(video,format,{...base,container:'avi'}),false,'unproven container fails closed');
	assert.equal(vodCopyEligible({...video,pix_fmt:'yuv422p10le'},format,base),false,'4:2:2 10-bit fails closed');
	assert.equal(vodCopyEligible({...video,profile:'Main 10',pix_fmt:'yuv420p10le'},format,{...base,capabilities:{...caps,hevcMain10:false}}),false,'Main 10 without capability fails closed');
	assert.equal(vodCopyEligible({...video,width:3840,height:2160},format,base),false,'client dimension ceiling is respected');
	assert.equal(vodCopyEligible({...video,width:0},format,base),false,'absent width fails closed');
	assert.equal(vodCopyEligible({...video,height:0},format,base),false,'absent height fails closed');
	assert.equal(vodCopyEligible({...video,r_frame_rate:'0/1',avg_frame_rate:'0/1'},format,base),false,'absent frame rate fails closed');
	assert.equal(vodCopyEligible({...video,bit_rate:0},{format_name:'matroska'},{...base,quality:20000000}),false,'absent bitrate fails closed');
});

test('copy segment grid derives only from a regular proven GOP',()=>{
	assert.equal(vodCopySegmentSeconds([0.021,2.021,4.021,6.021,8.021,10.021]),2);
	assert.equal(vodCopySegmentSeconds([0,4,8,12,16]),4);
	assert.equal(vodCopySegmentSeconds([0,2,4,7,9,11]),0,'irregular GOP fails closed');
	assert.equal(vodCopySegmentSeconds([0,0.04,0.08,0.12]),0,'all-intra GOP is outside the segment bounds');
	assert.equal(vodCopySegmentSeconds([0,0.5,1,1.5]),0,'sub-second keyframe gaps fail closed');
	assert.equal(vodCopySegmentSeconds([0,12,24,36]),0,'long GOP is outside the segment bounds');
	assert.equal(vodCopySegmentSeconds([0,2]),0,'too few keyframes fail closed');
	assert.equal(vodCopySegmentSeconds([]),0);
});

test('copy manifests use the proven grid and real tail duration',()=>{
	const manifest=vodManifest(11,2);
	assert.match(manifest,/#EXT-X-TARGETDURATION:2/);
	assert.equal(extinf(manifest).length,6);
	assert.match(manifest,/#EXTINF:1\.000,/);
	assert.match(manifest,/#EXT-X-ENDLIST/);
	const captions=captionManifest(9,2,2);
	assert.match(captions,/#EXT-X-TARGETDURATION:2/);
	assert.equal(extinf(captions).length,5);
	// The copy plan passes real per-segment durations, including a genuine short
	// tail. Nothing is re-derived from a declared duration.
	const planned=vodManifest(0,2,[2,2,2,2,0.08]);
	assert.equal(extinf(planned).length,5);
	assert.match(planned,/#EXTINF:2\.000,/);
	assert.match(planned,/#EXTINF:0\.080,/);
	assertPlaylistConsistent(planned);
	const plannedCaptions=captionManifest(0,2,2,[2,2,2,2,0.08]);
	assert.equal(extinf(plannedCaptions).length,5);
	assert.match(plannedCaptions,/#EXTINF:0\.080,/);
	assertPlaylistConsistent(plannedCaptions);
});

test('HEVC copy keeps video identity, AAC audio, exact durations, seek and bounds',{skip:!ffmpeg,timeout:300000},async t=>{
	const {file}=await hevcSmall({seconds:130});
	const bytes=await readFile(file);
	const player=createVodPlayer({open:rangeOpener(bytes)});
	const session=await player.start({type:'movie',uuid:'copy-hevc'},{capabilities:capabilities(),quality:20000000});
	try {
		assert.equal(session.method,'Copy');
		assert.equal(session.videoCodec,'hevc');
		assert.equal(session.producer().copy,true);
		assert.equal(session.producer().segmentSeconds,2);
		const total=session.producer().total;
		assert.equal(total,65,'130 s at a 2 s keyframe grid must end at the last real keyframe (128 s) plus its tail');
		assert.ok(total>=64);

		const first=await session.read('segment000000000.ts');
		assert.ok(first.length>1000);
		const firstFile=await segmentFile(t,'first.ts',first);
		assert.equal(streamInfo(firstFile).codec_name,'hevc');
		assert.equal(streamInfo(firstFile,'a:0').codec_name,'aac');
		const firstPts=packets(firstFile);
		assert.ok(Math.min(...firstPts)<0.6,`copy must not inherit the 1.4 s MPEG-TS mux delay, first PTS ${Math.min(...firstPts)}`);
		const sourceHashes=framemd5(file,{count:3});
		const copyHashes=framemd5(firstFile,{count:3});
		assert.deepEqual(copyHashes,sourceHashes,'copied video must decode identically to the source');
		decode(firstFile);

		// The first 120 s is one bounded copy window; segment 59 ends it.
		const end=await session.read('segment000000059.ts');
		assert.ok(end.length>1000);
		// Segment 60 starts the next window; its timestamps must continue the
		// title's absolute timeline rather than rebase to zero.
		const next=await session.read('segment000000060.ts');
		const nextFile=await segmentFile(t,'next.ts',next);
		const nextPts=packets(nextFile);
		assert.ok(nextPts.length>0);
		assert.ok(nextPts[0]>100,`window boundary PTS should stay absolute, got ${nextPts[0]}`);
		const after=await session.read('segment000000061.ts');
		const afterFile=await segmentFile(t,'after.ts',after);
		const afterPts=packets(afterFile);
		assert.ok(afterPts.length>0);
		assert.ok(afterPts[0]>nextPts[nextPts.length-1],'adjacent segments must not overlap');
		assert.ok(afterPts[0]-nextPts[nextPts.length-1]<0.3,'adjacent segments must be continuous');
		decode(nextFile);
		decode(afterFile);

		// Let prune advance past the old window so the backward seek is a real
		// re-encode rather than a cache hit.
		await new Promise(resolve=>setTimeout(resolve,3500));
		// A seek back past the prune floor re-encodes the requested window.
		const back=await session.read('segment000000005.ts');
		assert.ok(back.length>1000);
		assert.ok([4,5].includes(session.producer().windowStart),'the window starts at the proven keyframe at or before the seek');
		const backFile=await segmentFile(t,'back.ts',back);
		assert.equal(streamInfo(backFile).codec_name,'hevc');
		const backPts=packets(backFile);
		assert.ok(Math.min(...backPts)>=9.5&&Math.min(...backPts)<10.5,`segment 5 should carry its absolute 10 s timeline, got ${Math.min(...backPts)}`);
		decode(backFile);

		const manifest=(await session.read('index.m3u8')).toString();
		const levels=assertPlaylistConsistent(manifest);
		assert.equal(levels.length,total);
		assert.match(manifest,/#EXT-X-ENDLIST/);

		await assert.rejects(()=>session.read('segment'+String(total).padStart(9,'0')+'.ts'),error=>error.status===404);
	} finally {
		await session.stop();
	}
	await assert.rejects(()=>session.read('segment000000000.ts'),error=>error.status===410);
});

test('a later irregular GOP is not copied even when the first 12 s look regular',{skip:!ffmpeg,timeout:240000},async t=>{
	const {file}=await hevcMixedGop();
	const bytes=await readFile(file);
	const player=createVodPlayer({open:rangeOpener(bytes)});
	const session=await player.start({type:'movie',uuid:'mixed-gop'},{capabilities:capabilities(),quality:20000000});
	try {
		assert.equal(session.method,'Transcode','whole-title GOP sampling must reject a later 10 s GOP');
		assert.equal(session.producer().copy,false);
		assert.equal(session.producer().segmentSeconds,4);
		const segment=await session.read('segment000000000.ts');
		const segmentPath=await segmentFile(t,'mixed.ts',segment);
		assert.equal(streamInfo(segmentPath).codec_name,'h264');
	} finally {
		await session.stop();
	}
});

test('copy tail cleanup cannot delete a newer generation segment',async()=>{
	const removed=[];
	const job={generation:2,stopped:false,directory:path.join(os.tmpdir(),'copy-cleanup-scope')};
	const racing={readdir:async()=>['segment000000060.ts'],stat:async()=>{job.generation=3;return {mtimeMs:2001};},rm:async name=>{removed.push(name);}};
	assert.deepEqual(await vodCopyTailCleanup(job,racing,{generation:2,windowEnd:59,startedAt:2000,shift:0}),[]);
	assert.deepEqual(removed,[],'a stale callback must not delete the new generation file');

	const current={readdir:async()=>['segment000000060.ts'],stat:async()=>({mtimeMs:2001}),rm:async name=>{removed.push(path.basename(name));}};
	job.generation=4;
	assert.deepEqual(await vodCopyTailCleanup(job,current,{generation:4,windowEnd:59,startedAt:2000,shift:0}),['segment000000060.ts']);
	assert.deepEqual(removed,['segment000000060.ts'],'the same generation tail is removed');
});

test('a later-window 10 s GOP asks for a bounded compatibility replacement',{skip:!ffmpeg,timeout:240000},async t=>{
	const {file}=await hevcLateGop();
	const bytes=await readFile(file);
	const player=createVodPlayer({open:rangeOpener(bytes)});
	const session=await player.start({type:'movie',uuid:'late-gop'},{capabilities:capabilities(),quality:20000000});
	try {
		assert.equal(session.method,'Copy');
		const first=await session.read('segment000000000.ts');
		assert.ok(first.length>1000);
		const boundary=await session.read('segment000000059.ts');
		assert.ok(boundary.length>1000);
		await assert.rejects(()=>session.read('segment000000060.ts'),error=>error.status===409&&error.code==='VOD_COMPATIBILITY_REQUIRED');
		await assert.rejects(()=>session.read('segment000000060.ts'),error=>error.status===409&&error.code==='VOD_COMPATIBILITY_REQUIRED','a repeated request must not serve the stale copy file');
		const concurrent=await Promise.allSettled([session.read('segment000000060.ts'),session.read('segment000000060.ts')]);
		assert.ok(concurrent.every(result=>result.status==='rejected'&&result.reason.status===409&&result.reason.code==='VOD_COMPATIBILITY_REQUIRED'),'concurrent requests must all receive the compatibility contract');
		assert.equal(session.method,'Transcode','the failed copy session reports the required compatibility mode');
	} finally {
		await session.stop();
	}
	// The client's one-shot compatibility replacement is a new transcode session
	// at the current position, not a codec switch inside the old playlist.
	const replacement=createVodPlayer({open:rangeOpener(bytes)});
	const transcode=await replacement.start({type:'movie',uuid:'late-gop'},{capabilities:capabilities(),quality:20000000,compatibility:true});
	try {
		assert.equal(transcode.method,'Transcode');
		assert.equal(transcode.producer().segmentSeconds,4);
		const atPosition=await transcode.read('segment000000030.ts'); // 120 s in the 4 s grid
		assert.ok(atPosition.length>1000);
		const atPath=await segmentFile(t,'late-compat.ts',atPosition);
		assert.equal(streamInfo(atPath).codec_name,'h264');
	} finally {
		await transcode.stop();
	}
});

test('H.264 copy with AAC audio is a Copy with unchanged audio',{skip:!ffmpeg,timeout:120000},async t=>{
	const {file}=await h264Aac({seconds:16});
	const bytes=await readFile(file);
	const player=createVodPlayer({open:rangeOpener(bytes)});
	const session=await player.start({type:'movie',uuid:'copy-h264-aac'},{capabilities:capabilities(),quality:20000000});
	try {
		assert.equal(session.method,'Copy');
		assert.equal(session.videoCodec,'h264');
		assert.equal(session.audioCodec,'aac');
		assert.equal(session.producer().segmentSeconds,4);
		const segment=await session.read('segment000000000.ts');
		const segmentPath=await segmentFile(t,'h264-copy.ts',segment);
		assert.equal(streamInfo(segmentPath,'v:0').codec_name,'h264');
		assert.equal(streamInfo(segmentPath,'a:0').codec_name,'aac');
		decode(segmentPath);
	} finally {
		await session.stop();
	}
});

test('H.264 copy with AC3 audio is a Remux and converts audio to AAC stereo',{skip:!ffmpeg,timeout:180000},async t=>{
	const {file}=await h264Ac3({seconds:16});
	const bytes=await readFile(file);
	const player=createVodPlayer({open:rangeOpener(bytes)});
	const session=await player.start({type:'movie',uuid:'copy-h264'},{capabilities:capabilities(),quality:20000000});
	try {
		assert.equal(session.method,'Remux');
		assert.equal(session.videoCodec,'h264');
		assert.equal(session.producer().segmentSeconds,4);
		const segment=await session.read('segment000000000.ts');
		const segmentPath=await segmentFile(t,'remux.ts',segment);
		const video=streamInfo(segmentPath,'v:0');
		const audio=streamInfo(segmentPath,'a:0');
		assert.equal(video.codec_name,'h264');
		assert.equal(audio.codec_name,'aac');
		assert.equal(Number(audio.channels),2);
		decode(segmentPath);
	} finally {
		await session.stop();
	}
});

test('text captions remain a sidecar while a burned-in subtitle forces transcode',{skip:!ffmpeg,timeout:240000},async t=>{
	const {file}=await hevcSmall({seconds:24});
	const bytes=await readFile(file);
	const sidecar=createVodPlayer({open:rangeOpener(bytes)});
	const copySession=await sidecar.start({type:'movie',uuid:'copy-captions'},{capabilities:capabilities(),quality:20000000,textSubtitles:true,subtitleIndex:2});
	try {
		assert.equal(copySession.method,'Copy');
		const master=(await copySession.read('index.m3u8')).toString();
		assert.match(master,/#EXT-X-MEDIA:TYPE=SUBTITLES/);
		const captions=(await copySession.read('captions-2.m3u8')).toString();
		assertPlaylistConsistent(captions);
		assert.equal(extinf(captions).length,copySession.producer().total);
		// Captions follow the video; fetch the first segment so the encoder has
		// produced the matching caption window (the real client order).
		await copySession.read('segment000000000.ts');
		const cue=(await copySession.read('caption-2-0.vtt')).toString();
		assert.match(cue,/EARLY_CUE/);
		// A later copy window must slice the same cue file on the real 2 s grid.
		await copySession.read('segment000000005.ts');
		const mid=(await copySession.read('caption-2-5.vtt')).toString();
		assert.match(mid,/MID_CUE/);
	} finally {
		await copySession.stop();
	}

	const burn=createVodPlayer({open:rangeOpener(bytes)});
	const burnSession=await burn.start({type:'movie',uuid:'burn-captions'},{capabilities:capabilities(),quality:20000000,textSubtitles:false,subtitleIndex:2});
	try {
		assert.equal(burnSession.method,'Transcode');
		assert.equal(burnSession.producer().segmentSeconds,4);
		const segment=await burnSession.read('segment000000000.ts');
		assert.ok(segment.length>1000);
	} finally {
		await burnSession.stop();
	}
});

test('absent, incompatible and compatibility-retry requests fail closed to transcode',{skip:!ffmpeg,timeout:300000},async t=>{
	const {file}=await hevcSmall({seconds:24});
	const bytes=await readFile(file);

	const absent=createVodPlayer({open:rangeOpener(bytes)});
	const absentSession=await absent.start({type:'movie',uuid:'absent'},{quality:20000000});
	try{assert.equal(absentSession.method,'Transcode');}finally{await absentSession.stop();}

	const incompatible=createVodPlayer({open:rangeOpener(bytes)});
	const incompatibleSession=await incompatible.start({type:'movie',uuid:'h264-only'},{capabilities:capabilities({videoCodecs:['h264']}),quality:20000000});
	try{assert.equal(incompatibleSession.method,'Transcode');}finally{await incompatibleSession.stop();}

	const retry=createVodPlayer({open:rangeOpener(bytes)});
	const retrySession=await retry.start({type:'movie',uuid:'retry'},{capabilities:capabilities(),quality:20000000,compatibility:true});
	try{assert.equal(retrySession.method,'Transcode');}finally{await retrySession.stop();}

	const intra=await hevcAllIntra({seconds:8});
	const intraPlayer=createVodPlayer({open:rangeOpener(await readFile(intra.file))});
	const intraSession=await intraPlayer.start({type:'movie',uuid:'intra'},{capabilities:capabilities(),quality:20000000});
	try{assert.equal(intraSession.method,'Transcode');}finally{await intraSession.stop();}

	if(!existsSync(fixture1080)){
		t.skip('the 121 1080p quality-ceiling fixture is not present');
		return;
	}
	const big=await readFile(fixture1080);
	const ceiling=createVodPlayer({open:rangeOpener(big)});
	const ceilingSession=await ceiling.start({type:'movie',uuid:'ceiling'},{capabilities:capabilities(),quality:4000000});
	try{assert.equal(ceilingSession.method,'Transcode','a source above the requested ceiling must transcode');}finally{await ceilingSession.stop();}
});

test('copy session stop aborts the producer and expires reads',{skip:!ffmpeg,timeout:120000},async t=>{
	const {file}=await hevcSmall({seconds:24});
	const bytes=await readFile(file);
	const player=createVodPlayer({open:rangeOpener(bytes)});
	const session=await player.start({type:'movie',uuid:'cancel'},{capabilities:capabilities(),quality:20000000});
	await session.read('segment000000000.ts');
	await session.stop();
	await assert.rejects(()=>session.read('segment000000001.ts'),error=>error.status===410);
});

test('tail plan uses the real keyframe split, preserves short tails and refuses unproven ones',()=>{
	// Archived relay shape: the last real keyframe is at 358.053 s; the seek
	// lands one GOP early, so the probe emits two real segments and the final
	// 2.09 s tail. ceil(360.064/2) would advertise a phantom segment 180.
	const archived=vodCopyTailPlan({step:2,sourceVideoEnd:359.973,sourceAudioEnd:360.042,
		segments:[{duration:2.024,firstPts:356.053},{duration:2.090667,videoEnd:359.973,audioEnd:360.042}]});
	assert.ok(archived);
	assert.equal(archived.total,180);
	assert.equal(archived.lastIndex,179);
	assert.equal(archived.first,178);
	assert.equal(archived.tailSeconds,2.090667);
	assert.equal(archived.durations.length,180);
	assert.equal(archived.durations[177],2);
	assert.equal(archived.durations[178],2.024);
	assert.equal(archived.durations[179],2.090667);
	assert.ok(Math.abs(archived.end-360.090667)<1e-6);

	// A genuine 0.08 s tail after a real keyframe at 12 s is kept, not floored.
	const short=vodCopyTailPlan({step:2,sourceVideoEnd:12.04,sourceAudioEnd:12.08,
		segments:[{duration:0.08,firstPts:12,videoEnd:12.04,audioEnd:12.08}]});
	assert.ok(short);
	assert.equal(short.total,7);
	assert.equal(short.tailSeconds,0.08);
	assert.equal(short.durations[6],0.08);

	// An unproven tail is rejected instead of invented: the emitted final
	// segment does not carry the source's real last video packet.
	assert.equal(vodCopyTailPlan({step:2,sourceVideoEnd:359.99,sourceAudioEnd:360.04,
		segments:[{duration:1.5,firstPts:358,videoEnd:358.02,audioEnd:358.02}]}),null);
	// A non-final split that is not the proven grid is rejected.
	assert.equal(vodCopyTailPlan({step:2,sourceVideoEnd:359.99,sourceAudioEnd:360.04,
		segments:[{duration:2.5,firstPts:356},{duration:2.0,videoEnd:359.99,audioEnd:360.04}]}),null);
	// A tail whose first PTS is not on the manifest grid is rejected.
	assert.equal(vodCopyTailPlan({step:2,sourceVideoEnd:12.04,sourceAudioEnd:12.08,
		segments:[{duration:0.08,firstPts:11.4,videoEnd:12.04,audioEnd:12.08}]}),null);
	// Selected audio missing from the emitted tail is rejected.
	assert.equal(vodCopyTailPlan({step:2,sourceVideoEnd:12.04,sourceAudioEnd:12.08,
		segments:[{duration:2.08,firstPts:10,videoEnd:12.04,audioEnd:10.2}]}),null);
});

test('fractional AAC tail has no phantom segment and keeps the audio-only tail',{skip:!ffmpeg,timeout:300000},async t=>{
	const {file}=await h264Tail({videoSeconds:12,audioSeconds:12.064,audioCodec:'aac'});
	const declared=formatDuration(file);
	assert.ok(declared>12.0&&declared<12.2,`expected the AAC frame-padded fractional tail, got ${declared}`);
	const player=createVodPlayer({open:rangeOpener(await readFile(file))});
	const session=await player.start({type:'movie',uuid:'tail-aac'},{capabilities:capabilities(),quality:20000000});
	try {
		assert.equal(session.method,'Copy');
		assert.equal(session.producer().segmentSeconds,2);
		assert.equal(session.producer().total,6,'no keyframe at 12 s means the real grid ends at segment 5');
		const levels=assertPlaylistConsistent((await session.read('index.m3u8')).toString());
		assert.equal(levels.length,6);
		assert.ok(levels[5]>2&&levels[5]<2.2,`the final EXTINF must be the real emitted tail, not the 0.08 s phantom: ${levels[5]}`);
		const lastFile=await segmentFile(t,'tail-aac-last.ts',await session.read('segment000000005.ts'));
		assert.ok(Math.abs(formatDuration(lastFile)-levels[5])<=0.15,'EXTINF must match the emitted final segment');
		const video=packets(lastFile),audio=packets(lastFile,'a:0');
		assert.ok(Math.min(...video)>=9.5&&Math.min(...video)<10.5,'the final segment starts at its real keyframe');
		assert.ok(Math.max(...video)>11.8,'the last real video frame is retained');
		assert.ok(Math.max(...audio)>declared-0.2,'the audio-only tail past the video end is retained');
		decode(lastFile);
		await assert.rejects(()=>session.read('segment000000006.ts'),error=>error.status===404,'advertising a phantom segment must not happen');
	} finally { await session.stop(); }
});

test('fractional AC3 tail is a Remux with the same real final segment boundary',{skip:!ffmpeg,timeout:300000},async t=>{
	const {file}=await h264Tail({videoSeconds:12,audioSeconds:12.064,audioCodec:'ac3'});
	const declared=formatDuration(file);
	assert.ok(declared>12.0&&declared<12.2,`expected the AC3 fractional tail, got ${declared}`);
	const player=createVodPlayer({open:rangeOpener(await readFile(file))});
	const session=await player.start({type:'movie',uuid:'tail-ac3'},{capabilities:capabilities(),quality:20000000});
	try {
		assert.equal(session.method,'Remux');
		assert.equal(session.producer().total,6);
		const levels=assertPlaylistConsistent((await session.read('index.m3u8')).toString());
		assert.equal(levels.length,6);
		assert.ok(levels[5]>2&&levels[5]<2.2);
		const lastFile=await segmentFile(t,'tail-ac3-last.ts',await session.read('segment000000005.ts'));
		assert.ok(Math.abs(formatDuration(lastFile)-levels[5])<=0.15);
		assert.equal(streamInfo(lastFile,'a:0').codec_name,'aac');
		assert.equal(Number(streamInfo(lastFile,'a:0').channels),2);
		assert.ok(Math.max(...packets(lastFile,'a:0'))>declared-0.2,'the converted audio-only tail is retained');
		decode(lastFile);
		await assert.rejects(()=>session.read('segment000000006.ts'),error=>error.status===404);
	} finally { await session.stop(); }
});

test('exact-duration 12 s copy keeps the final keyframe and the whole grid',{skip:!ffmpeg,timeout:300000},async t=>{
	const {file}=await h264Tail({videoSeconds:12,audioSeconds:12,audioCodec:'aac'});
	const player=createVodPlayer({open:rangeOpener(await readFile(file))});
	const session=await player.start({type:'movie',uuid:'tail-exact'},{capabilities:capabilities(),quality:20000000});
	try {
		assert.equal(session.method,'Copy');
		assert.equal(session.producer().total,6);
		const levels=assertPlaylistConsistent((await session.read('index.m3u8')).toString());
		assert.equal(levels.length,6);
		const lastFile=await segmentFile(t,'tail-exact-last.ts',await session.read('segment000000005.ts'));
		assert.ok(Math.abs(formatDuration(lastFile)-levels[5])<=0.15);
		assert.ok(Math.max(...packets(lastFile))>11.8);
		decode(lastFile);
	} finally { await session.stop(); }
});

test('a genuine 0.08 s tail after a real keyframe at 12 s stays playable',{skip:!ffmpeg,timeout:300000},async t=>{
	const {file}=await h264Tail({videoSeconds:12.08,audioSeconds:12.08,audioCodec:'aac'});
	const player=createVodPlayer({open:rangeOpener(await readFile(file))});
	const session=await player.start({type:'movie',uuid:'tail-short'},{capabilities:capabilities(),quality:20000000});
	try {
		assert.equal(session.method,'Copy');
		assert.equal(session.producer().total,7,'the keyframe at 12 s is a real final segment');
		const levels=assertPlaylistConsistent((await session.read('index.m3u8')).toString());
		assert.equal(levels.length,7);
		assert.ok(levels[6]>0&&levels[6]<0.3,`a genuine sub-second tail must not be rounded away: ${levels[6]}`);
		const lastFile=await segmentFile(t,'tail-short-last.ts',await session.read('segment000000006.ts'));
		assert.ok(Math.abs(formatDuration(lastFile)-levels[6])<=0.15);
		assert.ok(Math.max(...packets(lastFile))>12,'the real frame at 12 s is retained');
		decode(lastFile);
	} finally { await session.stop(); }
});

test('a genuine 13 s tail is a full one-second segment and survives a last-then-back seek',{skip:!ffmpeg,timeout:300000},async t=>{
	const {file}=await h264Tail({videoSeconds:13,audioSeconds:13,audioCodec:'aac'});
	const player=createVodPlayer({open:rangeOpener(await readFile(file))});
	const session=await player.start({type:'movie',uuid:'tail-13'},{capabilities:capabilities(),quality:20000000});
	try {
		assert.equal(session.method,'Copy');
		assert.equal(session.producer().total,7);
		const levels=assertPlaylistConsistent((await session.read('index.m3u8')).toString());
		assert.ok(levels[6]>0.8&&levels[6]<1.2,`the genuine 1 s tail must not be truncated: ${levels[6]}`);
		// Seek directly to the last segment first, then back into an earlier
		// window: both must stay on the absolute timeline.
		const lastFile=await segmentFile(t,'tail-13-last.ts',await session.read('segment000000006.ts'));
		assert.ok(Math.abs(formatDuration(lastFile)-levels[6])<=0.15);
		assert.ok(Math.min(...packets(lastFile))>=11.5&&Math.min(...packets(lastFile))<12.5);
		decode(lastFile);
		const backFile=await segmentFile(t,'tail-13-back.ts',await session.read('segment000000003.ts'));
		const back=packets(backFile);
		assert.ok(Math.min(...back)>=5.5&&Math.min(...back)<6.5,`seeked window must keep its absolute timeline, got ${Math.min(...back)}`);
		assert.ok(Math.max(...back)<8.5);
		decode(backFile);
		await assert.rejects(()=>session.read('segment000000007.ts'),error=>error.status===404);
	} finally { await session.stop(); }
});

test('a truncated real source fails closed instead of finishing early as success',{skip:!ffmpeg,timeout:300000},async t=>{
	const {file}=await h264Truncated({seconds:16,keep:0.6});
	const player=createVodPlayer({open:rangeOpener(await readFile(file))});
	await assert.rejects(()=>player.start({type:'movie',uuid:'truncated'},{capabilities:capabilities(),quality:20000000}),
		error=>error.status===502,'missing final media must be surfaced, not advertised as a short successful title');
});

// The archived relay fixtures are 597 MB each. This full advertised-segment
// pass is opt-in because it writes the whole title through the real player.
const archivedCopy=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..','outputs/Tellybox-relay-final-123/fixtures/extended-360s-hevc-2srt.mkv');
const archivedRemux=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..','outputs/Tellybox-relay-final-123/fixtures/extended-360s-hevc-ac3-2srt.mkv');
const archivedEnabled=process.env.TELLYBOX_VOD123_ARCHIVED==='1';
const archiveSkip=!ffmpeg||!archivedEnabled||!existsSync(archivedCopy);

async function playEveryAdvertised(session,label) {
	const total=session.producer().total;
	for(let n=0;n<total;n++){
		const bytes=await session.read('segment'+String(n).padStart(9,'0')+'.ts');
		assert.ok(bytes.length>200,`${label} segment ${n} must be real media`);
	}
	const phantom='segment'+String(total).padStart(9,'0')+'.ts';
	await assert.rejects(()=>session.read(phantom),error=>error.status===404,`${label} must not advertise ${phantom}`);
	return total;
}

test('archived 360.064 s HEVC Copy finishes every advertised segment and ENDLIST is accepted',{skip:archiveSkip,timeout:1800000},async t=>{
	const player=createVodPlayer({open:fileOpener(archivedCopy)});
	const session=await player.start({type:'movie',uuid:'archive-copy'},{capabilities:capabilities(),quality:80000000,textSubtitles:true,subtitleIndex:2});
	try {
		assert.equal(session.method,'Copy');
		assert.equal(session.producer().segmentSeconds,2);
		assert.equal(session.producer().total,180,'the last real keyframe is 358.053 s, so there is no segment 180');
		const manifest=(await session.read('video.m3u8')).toString();
		const levels=assertPlaylistConsistent(manifest);
		assert.equal(levels.length,180);
		assert.match(manifest,/#EXT-X-ENDLIST/);
		const captions=assertPlaylistConsistent((await session.read('captions-2.m3u8')).toString());
		assert.equal(captions.length,180);
		const total=await playEveryAdvertised(session,'archived copy');
		assert.equal(total,180);
		const lastFile=await segmentFile(t,'archive-copy-last.ts',await session.read('segment000000179.ts'));
		assert.ok(Math.abs(formatDuration(lastFile)-levels[179])<=0.2,`final EXTINF ${levels[179]} must match the emitted tail`);
		assert.ok(Math.max(...packets(lastFile))>359,'the final real video frame is retained');
		assert.ok(Math.max(...packets(lastFile,'a:0'))>359.9,'the final audio tail is retained');
		decode(lastFile);
	} finally { await session.stop(); }
});

test('archived 360.064 s HEVC Remux finishes every advertised segment and ENDLIST is accepted',{skip:archiveSkip||!existsSync(archivedRemux),timeout:1800000},async t=>{
	const player=createVodPlayer({open:fileOpener(archivedRemux)});
	const session=await player.start({type:'movie',uuid:'archive-remux'},{capabilities:capabilities(),quality:80000000,textSubtitles:true,subtitleIndex:2});
	try {
		assert.equal(session.method,'Remux');
		assert.equal(session.producer().segmentSeconds,2);
		assert.equal(session.producer().total,180);
		const levels=assertPlaylistConsistent((await session.read('video.m3u8')).toString());
		assert.equal(levels.length,180);
		const total=await playEveryAdvertised(session,'archived remux');
		assert.equal(total,180);
		const lastFile=await segmentFile(t,'archive-remux-last.ts',await session.read('segment000000179.ts'));
		assert.ok(Math.abs(formatDuration(lastFile)-levels[179])<=0.2);
		assert.equal(streamInfo(lastFile,'a:0').codec_name,'aac');
		assert.ok(Math.max(...packets(lastFile,'a:0'))>359.9);
		decode(lastFile);
	} finally { await session.stop(); }
});
