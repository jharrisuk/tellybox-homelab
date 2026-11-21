// Shared fixtures and openers for consolidation-121 VOD integration tests.
// Synthetic media only: no provider streams, no network access beyond loopback.
// Fixtures are built once with real ffmpeg and cached under the system temp
// directory so repeated test runs reuse them.
import {spawnSync} from 'node:child_process';
import {mkdir,mkdtemp,readFile,rm,stat,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Readable} from 'node:stream';

// Explicit ffmpeg selection: the environment override supports hosts where
// ffmpeg is not on PATH; the default still uses PATH so CI images keep working.
const ffmpegBin=process.env.TELLYBOX_FFMPEG||'ffmpeg';
const ffmpeg=spawnSync(ffmpegBin,['-version']).status===0;

export const hasFfmpeg=ffmpeg;

export function fixtureRoot() {
	return process.env.TELLYBOX_VOD_FIXTURE_ROOT||path.join(os.tmpdir(),'tellybox-vod121-fixtures');
}

export async function runFfmpeg(args,{timeout=600000}={}) {
	const result=spawnSync(ffmpegBin,args,{timeout,maxBuffer:16*1024*1024});
	if(result.status!==0)throw new Error('ffmpeg failed: '+(result.stderr?String(result.stderr).slice(-4000):''));
	return result;
}

export const CUE_SRT=`1
00:00:01,000 --> 00:00:03,000
EARLY_CUE

2
00:00:60,000 --> 00:00:64,000
MID_CUE

3
00:02:10,000 --> 00:02:12,000
LATE_CUE
`;

// Representative HEVC 1080p25 source with AAC audio and an embedded SubRip
// track. MPEG-TS cannot carry text SubRip, so the container is Matroska (the
// same shape the release-120 subtitle benchmark used). Cached under the system
// temp directory. The cache is concurrency-safe: builds go to a unique temp
// name and are renamed into place, so a killed run can never leave a truncated
// file, and the cached file is validated with ffprobe before reuse.
export async function hevc1080p({seconds=180}={}) {
	if(!ffmpeg)throw new Error('ffmpeg is required for the HEVC fixture');
	await mkdir(fixtureRoot(),{recursive:true});
	const root=fixtureRoot();
	const key='hevc-1080p25-'+seconds+'s';
	const dir=path.join(root,key);
	const out=path.join(dir,'source-hevc-1080p25-srt.mkv');
	if(await validFixture(out,{seconds}))return {file:out,dir};
	await rm(dir,{recursive:true,force:true});
	await mkdir(dir,{recursive:true});
	const srt=path.join(dir,'cues.srt');
	await writeFile(srt,CUE_SRT);
	const ts=path.join(dir,'source-hevc-1080p25.ts');
	const part=out+'.tmp-'+process.pid;
	await rm(part,{force:true});
	await runFfmpeg(['-y','-v','error','-f','lavfi','-i',`testsrc2=size=1920x1080:rate=25:duration=${seconds}`,
		'-f','lavfi','-i',`sine=frequency=440:sample_rate=48000:duration=${seconds}`,
		'-c:v','libx265','-preset','fast','-crf','18','-pix_fmt','yuv420p',
		'-x265-params','keyint=50:min-keyint=50:scenecut=0:open-gop=0:log-level=error',
		'-c:a','aac','-b:a','160k','-ac','2','-f','mpegts',ts],{timeout:600000});
	await runFfmpeg(['-y','-v','error','-i',ts,'-i',srt,'-map','0:v:0','-map','0:a:0','-map','1:s:0',
		'-c:v','copy','-c:a','copy','-c:s','srt','-metadata:s:s:0','language=eng','-f','matroska',part],{timeout:300000});
	await rm(ts,{force:true});
	try{await (await import('node:fs/promises')).rename(part,out);}catch{await (await import('node:fs/promises')).copyFile(part,out);await rm(part,{force:true});}
	if(!(await validFixture(out,{seconds})))throw new Error('generated HEVC fixture failed validation');
	return {file:out,dir};
}

async function validFixture(file,{seconds}={}) {
	try{
		const info=await stat(file);
		if(info.size<1000000)return false;
		const probe=spawnSync('ffprobe',['-v','error','-show_entries','format=duration','-of','csv=p=0',file],{timeout:30000,maxBuffer:1024*1024});
		const duration=Number(String(probe.stdout||'').trim());
		if(probe.status!==0||!Number.isFinite(duration))return false;
		return Math.abs(duration-seconds)<2;
	}catch{return false;}
}

// A fast small H.264 fixture for logic-heavy tests that do not need 1080p.
export async function h264Tiny({seconds=300,size='320x180'}={}) {
	if(!ffmpeg)throw new Error('ffmpeg is required for the H.264 fixture');
	await mkdir(fixtureRoot(),{recursive:true});
	const out=path.join(fixtureRoot(),`h264-${size.replace(':','x')}-${seconds}s.ts`);
	try{const existing=await stat(out);if(existing.size>1000)return {file:out,dir:path.dirname(out)};}catch{}
	await runFfmpeg(['-y','-v','error','-f','lavfi','-i',`testsrc2=s=${size}:r=25`,'-f','lavfi','-i','anullsrc=r=48000:cl=stereo','-t',String(seconds),
		'-c:v','libx264','-preset','ultrafast','-g','100','-keyint_min','100','-sc_threshold','0','-c:a','aac','-b:a','64k','-f','mpegts',out],{timeout:180000});
	return {file:out,dir:path.dirname(out)};
}

// Serve an in-memory file over the player's internal HTTP proxy with Range
// support. `throttleBps` paces the body so the producer becomes input-bound;
// this is a deterministic stand-in for a busy CPU-bound worker: production
// settles near throttleBps / sourceBitrateBps of realtime regardless of the
// host's encoder speed.
export function rangeOpener(bytes,{throttleBps=0,onRequest}={}) {
	return async(source,{range}={})=>{
		const parts=range?.match(/^bytes=(\d+)-(\d*)$/);const first=parts?Number(parts[1]):0;
		const last=parts&&parts[2]?Math.min(bytes.length-1,Number(parts[2])):bytes.length-1;
		const data=bytes.subarray(first,last+1);
		onRequest?.({range:range||null,first,last,size:data.length});
		let body;
		if(throttleBps>0){
			async function* paced(){
				const started=Date.now();let sent=0;
				for(let offset=0;offset<data.length;offset+=262144){
					const chunk=data.subarray(offset,Math.min(data.length,offset+262144));
					yield chunk;
					// Cumulative bytes served, from actual chunk sizes: the offset
					// must not be counted twice or the pace asymptotically halves.
					sent+=chunk.length;
					const wait=sent/throttleBps*1000-(Date.now()-started);
					if(wait>1)await new Promise(r=>setTimeout(r,wait));
				}
			}
			body=Readable.toWeb(Readable.from(paced()));
		}else{
			body=new Response(data).body;
		}
		return new Response(body,{status:parts?206:200,headers:{'Content-Type':'video/x-matroska','Content-Length':String(last-first+1),'Accept-Ranges':'bytes',...(parts?{'Content-Range':`bytes ${first}-${last}/${bytes.length}`}:{})}});
	};
}

// Read all segment sizes in a job directory (cache bytes evidence).
export async function segmentSizes(directory) {
	const {readdir}=await import('node:fs/promises');
	const sizes=[];
	for(const name of await readdir(directory)) {
		const match=/^segment(\d{9})\.ts$/.exec(name);
		if(!match)continue;
		try{sizes.push({index:Number(match[1]),size:(await stat(path.join(directory,name))).size});}catch{}
	}
	return sizes;
}

export async function withTempDir(t,name) {
	const dir=await mkdtemp(path.join(os.tmpdir(),name));
	t.after(()=>rm(dir,{recursive:true,force:true}));
	return dir;
}

export async function loadBytes(file) {
	return readFile(file);
}
