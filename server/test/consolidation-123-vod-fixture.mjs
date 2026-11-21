// Shared synthetic fixtures for the consolidation-123 VOD copy tests.
// No provider streams and no network beyond loopback. Fixtures are built once
// with real ffmpeg under the system temp directory and reused.
import {spawnSync} from 'node:child_process';
import {mkdir,open as openFile,readFile,rename,rm,stat,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const ffmpegBin=process.env.TELLYBOX_FFMPEG||'ffmpeg';
export const hasFfmpeg=spawnSync(ffmpegBin,['-version']).status===0;

export function fixtureRoot() {
	return process.env.TELLYBOX_VOD123_FIXTURE_ROOT||path.join(os.tmpdir(),'tellybox-vod123-fixtures');
}

export const CUE_SRT=`1
00:00:01,000 --> 00:00:03,000
EARLY_CUE

2
00:00:10,000 --> 00:00:12,000
MID_CUE

3
00:00:20,000 --> 00:00:22,000
LATE_CUE
`;

function run(args,timeout=300000) {
	const result=spawnSync(ffmpegBin,args,{timeout,maxBuffer:16*1024*1024});
	if(result.status!==0)throw new Error('ffmpeg failed: '+String(result.stderr||'').slice(-2000));
	return result;
}

async function durationOf(file) {
	const probe=spawnSync('ffprobe',['-v','error','-show_entries','format=duration','-of','csv=p=0',file],{timeout:30000,maxBuffer:1024*1024});
	const value=Number(String(probe.stdout||'').trim());
	return probe.status===0&&Number.isFinite(value)?value:0;
}

async function valid(file,seconds) {
	try {
		if((await stat(file)).size<1000)return false;
		return Math.abs((await durationOf(file))-seconds)<1.5;
	}catch{return false;}
}

async function buildIfMissing(key,seconds,args) {
	await mkdir(fixtureRoot(),{recursive:true});
	const file=path.join(fixtureRoot(),key+'.mkv');
	if(await valid(file,seconds))return {file,dir:path.dirname(file)};
	const part=file+'.tmp-'+process.pid;
	await rm(part,{force:true});
	run([...args,part]);
	try{await rename(part,file);}catch{await rm(part,{force:true});}
	if(!(await valid(file,seconds)))throw new Error('generated fixture failed validation: '+key);
	return {file,dir:path.dirname(file)};
}

/** HEVC 320x180 25 fps, 2 s GOP, AAC stereo, embedded SubRip. */
export async function hevcSmall({seconds=24}={}) {
	const key='hevc-small-'+seconds;
	const srt=path.join(fixtureRoot(),key+'.srt');
	await mkdir(fixtureRoot(),{recursive:true});
	if(!(await stat(srt).catch(()=>null)))await writeFile(srt,CUE_SRT);
	return buildIfMissing(key,seconds,['-y','-v','error',
		'-f','lavfi','-i',`testsrc2=size=320x180:rate=25:duration=${seconds}`,
		'-f','lavfi','-i',`sine=frequency=440:sample_rate=48000:duration=${seconds}`,
		'-i',srt,
		'-map','0:v:0','-map','1:a:0','-map','2:s:0',
		'-c:v','libx265','-preset','fast','-crf','28','-pix_fmt','yuv420p',
		'-x265-params','keyint=50:min-keyint=50:scenecut=0:open-gop=0:log-level=error',
		'-c:a','aac','-b:a','64k','-ac','2',
		'-c:s','srt','-metadata:s:s:0','language=eng','-f','matroska']);
}

/** HEVC 320x180 25 fps with an all-intra GOP (copy grid cannot be proven). */
export async function hevcAllIntra({seconds=8}={}) {
	const key='hevc-allintra-'+seconds;
	return buildIfMissing(key,seconds,['-y','-v','error',
		'-f','lavfi','-i',`testsrc2=size=320x180:rate=25:duration=${seconds}`,
		'-f','lavfi','-i',`sine=frequency=440:sample_rate=48000:duration=${seconds}`,
		'-map','0:v:0','-map','1:a:0',
		'-c:v','libx265','-preset','fast','-crf','28','-pix_fmt','yuv420p',
		'-x265-params','keyint=1:min-keyint=1:scenecut=0:open-gop=0:log-level=error',
		'-c:a','aac','-b:a','64k','-ac','2','-f','matroska']);
}

/** H.264 320x180 25 fps, 4 s GOP, AAC stereo (video copy with AAC copy). */
export async function h264Aac({seconds=16}={}) {
	const key='h264-aac-'+seconds;
	return buildIfMissing(key,seconds,['-y','-v','error',
		'-f','lavfi','-i',`testsrc2=size=320x180:rate=25:duration=${seconds}`,
		'-f','lavfi','-i',`sine=frequency=440:sample_rate=48000:duration=${seconds}`,
		'-map','0:v:0','-map','1:a:0',
		'-c:v','libx264','-preset','ultrafast','-g','100','-keyint_min','100','-sc_threshold','0','-pix_fmt','yuv420p',
		'-c:a','aac','-b:a','64k','-ac','2','-f','matroska']);
}

/** H.264 320x180 25 fps, 4 s GOP, AC3 5.1 audio (audio-only conversion). */
export async function h264Ac3({seconds=16}={}) {
	const key='h264-ac3-'+seconds;
	return buildIfMissing(key,seconds,['-y','-v','error',
		'-f','lavfi','-i',`testsrc2=size=320x180:rate=25:duration=${seconds}`,
		'-f','lavfi','-i',`aevalsrc=0.05|0.05|0.05|0.05|0.05|0.05:s=48000:d=${seconds}`,
		'-map','0:v:0','-map','1:a:0',
		'-c:v','libx264','-preset','ultrafast','-g','100','-keyint_min','100','-sc_threshold','0','-pix_fmt','yuv420p',
		'-c:a','ac3','-ac','6','-b:a','192k','-f','matroska']);
}

/** H.264 160x90 25 fps with a fixed 2 s GOP and independent video/audio ends.
 *  The default pair reproduces the relay fractional tail: 12 s of video and a
 *  12.064 s sine, whose AAC encode ends at 12.085 s (no keyframe at 12).
 *  Passing an audio end shorter than or equal to the video end exercises an
 *  exact duration; a video end past 12 s keeps a real keyframe at 12. */
export async function h264Tail({videoSeconds=12,audioSeconds=12.064,audioCodec='aac',audioChannels=2}={}) {
	const key=`h264-tail-${videoSeconds}-${audioSeconds}-${audioCodec}-${audioChannels}`;
	return buildIfMissing(key,Math.min(videoSeconds,audioSeconds),['-y','-v','error',
		'-f','lavfi','-i',`testsrc2=size=160x90:rate=25:duration=${videoSeconds}`,
		'-f','lavfi','-i',`sine=frequency=440:sample_rate=48000:duration=${audioSeconds}`,
		'-map','0:v:0','-map','1:a:0',
		'-c:v','libx264','-preset','ultrafast','-g','50','-keyint_min','50','-sc_threshold','0','-pix_fmt','yuv420p',
		'-c:a',audioCodec,'-b:a',audioCodec==='ac3'?'192k':'64k','-ac',String(audioChannels),'-f','matroska']);
}

/** A real H.264/AAC source cut short. The container header still declares the
 *  original duration, so the last real packets are provably missing. */
export async function h264Truncated({seconds=16,keep=0.6}={}) {
	const key=`h264-truncated-${seconds}-${Math.round(keep*100)}`;
	const out=path.join(fixtureRoot(),key+'.mkv');
	await mkdir(fixtureRoot(),{recursive:true});
	const current=await stat(out).catch(()=>null);
	if(current&&current.size>1000)return {file:out,dir:fixtureRoot()};
	const full=await buildIfMissing(`h264-truncated-source-${seconds}`,seconds,['-y','-v','error',
		'-f','lavfi','-i',`testsrc2=size=160x90:rate=25:duration=${seconds}`,
		'-f','lavfi','-i',`sine=frequency=440:sample_rate=48000:duration=${seconds}`,
		'-map','0:v:0','-map','1:a:0',
		'-c:v','libx264','-preset','ultrafast','-g','50','-keyint_min','50','-sc_threshold','0','-pix_fmt','yuv420p',
		'-c:a','aac','-b:a','64k','-ac','2','-f','matroska']);
	const bytes=await readFile(full.file);
	const cut=Math.max(2048,Math.floor(bytes.length*keep));
	await writeFile(out+'.tmp-'+process.pid,bytes.subarray(0,cut));
	try{await rename(out+'.tmp-'+process.pid,out);}catch{await rm(out+'.tmp-'+process.pid,{force:true});}
	const check=await stat(out).catch(()=>null);
	if(!check||check.size!==cut)throw new Error('generated truncated fixture failed validation');
	return {file:out,dir:fixtureRoot()};
}

/** Range opener backed by the file itself; avoids loading multi-hundred MB
 *  archived fixtures into memory. */
export function fileOpener(file) {
	return async(source,{range}={})=>{
		const handle=await openFile(file,'r');
		try {
			const {size}=await handle.stat();
			const parts=range?.match(/^bytes=(\d+)-(\d*)$/),first=parts?Number(parts[1]):0;
			const last=parts&&parts[2]?Math.min(size-1,Number(parts[2])):size-1;
			const length=Math.max(0,last-first+1),buffer=Buffer.alloc(length);
			if(length)await handle.read(buffer,0,length,first);
			return new Response(buffer,{status:parts?206:200,headers:{'Content-Type':'video/x-matroska','Content-Length':String(length),'Accept-Ranges':'bytes',...(parts?{'Content-Range':`bytes ${first}-${last}/${size}`}:{})}});
		} finally { await handle.close(); }
	};
}

/** HEVC 320x180 25 fps with a regular 2 s GOP for 12 s, then a 10 s GOP.
 *  Copy must be rejected by whole-title GOP sampling even though the first
 *  12 s look regular. */
export async function hevcMixedGop() {
	const key='hevc-mixed-gop-40';
	const out=path.join(fixtureRoot(),key+'.mkv');
	if(await valid(out,40))return {file:out,dir:fixtureRoot()};
	await mkdir(fixtureRoot(),{recursive:true});
	const part1=path.join(fixtureRoot(),key+'-part1.mkv'),part2=path.join(fixtureRoot(),key+'-part2.mkv');
	const list=path.join(fixtureRoot(),key+'.txt');
	const build=(file,seconds,keyint)=>run(['-y','-v','error',
		'-f','lavfi','-i',`testsrc2=size=320x180:rate=25:duration=${seconds}`,
		'-f','lavfi','-i',`sine=frequency=440:sample_rate=48000:duration=${seconds}`,
		'-map','0:v:0','-map','1:a:0','-c:v','libx265','-preset','fast','-crf','28','-pix_fmt','yuv420p',
		'-x265-params',`keyint=${keyint}:min-keyint=${keyint}:scenecut=0:open-gop=0:log-level=error`,
		'-c:a','aac','-b:a','64k','-ac','2','-f','matroska',file]);
	build(part1,12,50);
	build(part2,28,250);
	await writeFile(list,`file '${part1.replaceAll('\\','/')}'\nfile '${part2.replaceAll('\\','/')}'\n`);
	const part=out+'.tmp-'+process.pid;
	await rm(part,{force:true});
	run(['-y','-v','error','-f','concat','-safe','0','-i',list,'-c','copy','-f','matroska',part]);
	await rm(part1,{force:true});await rm(part2,{force:true});await rm(list,{force:true});
	try{await rename(part,out);}catch{await rm(part,{force:true});}
	if(!(await valid(out,40)))throw new Error('generated mixed-GOP fixture failed validation');
	return {file:out,dir:fixtureRoot()};
}

/** HEVC 320x180 25 fps: 2 s GOP for 120 s, a 10 s GOP for 10 s, then 2 s
 *  again for 30 s. Whole-title sampling can miss the middle 10 s GOP; the
 *  per-segment duration guard must catch it at the window boundary. */
export async function hevcLateGop() {
	const key='hevc-late-gop-160';
	const out=path.join(fixtureRoot(),key+'.mkv');
	if(await valid(out,160))return {file:out,dir:fixtureRoot()};
	await mkdir(fixtureRoot(),{recursive:true});
	const parts=[
		{file:path.join(fixtureRoot(),key+'-p1.mkv'),seconds:120,keyint:50},
		{file:path.join(fixtureRoot(),key+'-p2.mkv'),seconds:10,keyint:250},
		{file:path.join(fixtureRoot(),key+'-p3.mkv'),seconds:30,keyint:50}
	];
	const list=path.join(fixtureRoot(),key+'.txt');
	for(const part of parts)run(['-y','-v','error',
		'-f','lavfi','-i',`testsrc2=size=320x180:rate=25:duration=${part.seconds}`,
		'-f','lavfi','-i',`sine=frequency=440:sample_rate=48000:duration=${part.seconds}`,
		'-map','0:v:0','-map','1:a:0','-c:v','libx265','-preset','fast','-crf','28','-pix_fmt','yuv420p',
		'-x265-params',`keyint=${part.keyint}:min-keyint=${part.keyint}:scenecut=0:open-gop=0:log-level=error`,
		'-c:a','aac','-b:a','64k','-ac','2','-f','matroska',part.file]);
	await writeFile(list,parts.map(part=>`file '${part.file.replaceAll('\\','/')}'`).join('\n')+'\n');
	const part=out+'.tmp-'+process.pid;
	await rm(part,{force:true});
	run(['-y','-v','error','-f','concat','-safe','0','-i',list,'-c','copy','-f','matroska',part]);
	for(const entry of parts)await rm(entry.file,{force:true});
	await rm(list,{force:true});
	try{await rename(part,out);}catch{await rm(part,{force:true});}
	if(!(await valid(out,160)))throw new Error('generated late-GOP fixture failed validation');
	return {file:out,dir:fixtureRoot()};
}

export function rangeOpener(bytes,{onRequest}={}) {
	return async(source,{range}={})=>{
		const parts=range?.match(/^bytes=(\d+)-(\d*)$/),first=parts?Number(parts[1]):0;
		const last=parts&&parts[2]?Math.min(bytes.length-1,Number(parts[2])):bytes.length-1;
		const data=bytes.subarray(first,last+1);
		onRequest?.({range:range||null,first,last,size:data.length});
		return new Response(data,{status:parts?206:200,headers:{'Content-Type':'video/x-matroska','Content-Length':String(last-first+1),'Accept-Ranges':'bytes',...(parts?{'Content-Range':`bytes ${first}-${last}/${bytes.length}`}:{})}});
	};
}

export function capabilities(overrides={}) {
	return {videoCodecs:['hevc','h264'],audioCodecs:['aac'],
		maxWidth:1920,maxHeight:1080,maxBitrate:20000000,maxFps:30,
		hevcMaxWidth:1920,hevcMaxHeight:1080,hevcMaxBitrate:20000000,hevcMaxFps:30,
		hevcMaxLevel:186,hevcProfiles:['main','main10'],hevcPixelFormats:['yuv420p','yuv420p10le'],hevcEvidence:true,
		hevcMain10:false,hls:true,mpegTs:true,...overrides};
}
