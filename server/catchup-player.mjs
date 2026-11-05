import {spawn, spawnSync} from 'node:child_process';
import {mkdtemp,readFile,readdir,rm,stat} from 'node:fs/promises';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import path from 'node:path';
import os from 'node:os';

const fail=(message,status=502)=>Object.assign(Error(message),{status});
const segmentSeconds=4;
// FFmpeg 5.1 (the Debian worker image) does not support this newer pacing
// option. Detect it once; fall back to ordinary paced input rather than
// failing every catch-up programme on an otherwise usable worker.
const initialBurstSupported=(()=>{
	try{return spawnSync('ffmpeg',['-hide_banner','-loglevel','error','-readrate_initial_burst','1','-version'],{stdio:'ignore'}).status===0;}catch{return false;}
})();
export const catchupFfmpegCapabilities=()=>({readrateInitialBurst:initialBurstSupported});
export function catchupTimeline(item,now=Date.now()){
	const start=Date.parse(item.StartDate),end=Date.parse(item.EndDate),duration=(end-start)/1000;
	if(!Number.isFinite(duration)||duration<=0||duration>28800||start>=now)throw fail('Invalid catch-up programme.',400);
	return {start,end,duration,available:now>=end?duration:Math.min(duration,Math.max(0,Math.floor((now-start)/4000)*4)),ended:now>=end};
}
export function catchupManifest(item,now=Date.now()){
	const timeline=catchupTimeline(item,now),length=timeline.ended?timeline.duration:timeline.available;
	const lines=['#EXTM3U','#EXT-X-VERSION:3','#EXT-X-TARGETDURATION:4','#EXT-X-MEDIA-SEQUENCE:0',
		'#EXT-X-PLAYLIST-TYPE:EVENT','#EXT-X-START:TIME-OFFSET=0,PRECISE=YES'];
	for(let n=0;n<Math.ceil(length/4);n++)lines.push('#EXTINF:'+Math.min(4,length-n*4).toFixed(3)+',','segment'+String(n).padStart(9,'0')+'.ts');
	if(timeline.ended)lines.push('#EXT-X-ENDLIST');
	return lines.concat('').join('\n');
}

/** Keep one archive connection per playback run; reopen only for a seek or recovery. */
export function createCatchupPlayer({openArchive,maxSessions=3,clock=Date.now,paceInput=true,cacheSegments=90,cacheBytes=128*1024*1024}){
	const jobs=new Set();
	async function start(channel,item){
		if(!/^[a-f0-9-]{36}$/i.test(channel.id))throw fail('Invalid channel.',400);
		const timeline=catchupTimeline(item,clock());
		if(jobs.size>=maxSessions)throw fail('Stop another catch-up programme before opening this one.',503);
		const job={stopped:false,child:null,archive:null,controller:null,lastRead:clock(),queue:Promise.resolve(),first:-1,last:-1,requested:-1};jobs.add(job);
		async function kill(){
			job.controller?.abort();const child=job.child;job.child=null;
			if(child&&child.exitCode===null){child.kill('SIGTERM');await Promise.race([new Promise(r=>child.once('close',r)),new Promise(r=>setTimeout(r,1000))]);if(child.exitCode===null)child.kill('SIGKILL');}
			const archive=job.archive;job.archive=null;if(archive)await archive.stop();
		}
		async function stop(){if(job.stopped)return;job.stopped=true;clearInterval(job.watchdog);clearInterval(job.cleanup);await kill();if(job.directory)await rm(job.directory,{recursive:true,force:true});jobs.delete(job);}
		try{
			job.directory=await mkdtemp(path.join(os.tmpdir(),'tellybox-catchup-'));
			job.watchdog=setInterval(()=>{if(clock()-job.lastRead>120000)void stop();},15000).unref();
			async function prune(){
				if(job.stopped)return;
				const names=(await readdir(job.directory)).filter(name=>/^segment\d{9}\.ts$/.test(name)).sort().reverse();
				let bytes=0;
				for(const [index,name] of names.entries()){
					const file=path.join(job.directory,name);bytes+=(await stat(file)).size;
					if(index>=cacheSegments||bytes>cacheBytes)await rm(file,{force:true});
				}
			}
			// Serialize eviction with reads/seeks so cleanup cannot delete a newly opened run.
			job.cleanup=setInterval(()=>{
				if(job.stopped||job.pruning)return;job.pruning=true;
				job.queue=job.queue.then(prune).catch(()=>{}).finally(()=>{job.pruning=false;});
			},2000).unref();
			async function encode(n){
				await kill();
				for(const name of await readdir(job.directory))await rm(path.join(job.directory,name),{force:true});
				if(job.stopped)throw fail('Playback expired.',410);
				const offset=n*4,base=Math.floor(offset/60)*60,skip=offset-base;
				const available=catchupTimeline(item,clock()).available,length=Math.min(timeline.duration-offset,available-offset);
				if(length<=0)throw fail('This part of the programme has not aired yet.',409);
				const upstream=await openArchive(channel.id,new Date(timeline.start+base*1000).toISOString(),Math.ceil((skip+length)/60));
				let release;const archive={open:upstream.open,stop:()=>release??=(async()=>upstream.stop())()};
				if(job.stopped){await archive.stop();throw fail('Playback expired.',410);}job.archive=archive;
				const controller=new AbortController();job.controller=controller;
				const timeout=setTimeout(()=>controller.abort(),45000);
				try{
					const response=await archive.open(controller.signal);if(!response.ok||!response.body){await response.body?.cancel();throw fail('The catch-up provider could not open this programme.');}
					clearTimeout(timeout);
					// FFmpeg normalizes the input's shared start time and corrects TS discontinuities.
					// Do not reset each stream independently, or disable correction with copyts.
					// Pacing bounds read-ahead while the initial burst makes starts and seeks quick.
					const args=['-hide_banner','-loglevel','error','-fflags','+genpts+discardcorrupt','-probesize','2000000','-analyzeduration','2000000',
						...(paceInput?['-readrate','1',...(initialBurstSupported?['-readrate_initial_burst',String(skip+20)]:[])]:[]),'-protocol_whitelist','pipe','-i','pipe:0',
						'-map','0:v:0','-map','0:a:0?','-sn','-dn','-c:v','libx264','-preset','veryfast','-threads','2','-crf','23','-maxrate','8000000','-bufsize','16000000',
						'-vf',`trim=start=${skip}:duration=${length},scale=w='min(1920,iw)':h=-2,format=yuv420p,fps=25:start_time=${skip},setpts=PTS+${base}/TB`,
						'-af',`atrim=start=${skip}:duration=${length},asetpts=PTS+${base}/TB`,
						'-fps_mode','passthrough','-g','100','-keyint_min','100','-sc_threshold','0','-c:a','aac','-ac','2','-b:a','160k','-t',String(offset+length),
						'-f','hls','-hls_time','4','-hls_list_size','0','-start_number',String(n),'-hls_flags','temp_file','-hls_segment_filename','segment%09d.ts','window.m3u8'];
					const child=spawn('ffmpeg',args,{cwd:job.directory,stdio:['pipe','ignore','ignore']});job.child=child;job.first=n;job.last=n+Math.ceil(length/4)-1;job.requested=n;
					child.stdin.on('error',()=>{});child.on('error',()=>controller.abort());
					child.once('close',()=>{controller.abort();void archive.stop().catch(()=>{});});
					void pipeline(Readable.fromWeb(response.body),child.stdin,{signal:controller.signal}).catch(()=>{if(child.exitCode===null)child.stdin.destroy();});
				}catch(error){clearTimeout(timeout);await kill();throw error;}
			}
			async function chunk(n){
				const available=catchupTimeline(item,clock());
				if(!Number.isSafeInteger(n)||n<0||n>=Math.ceil((available.ended?available.duration:available.available)/4))throw fail('This part of the programme is unavailable.',404);
				const file=path.join(job.directory,'segment'+String(n).padStart(9,'0')+'.ts');
				try{const bytes=await readFile(file);job.requested=n;return bytes;}catch{}
				if(!job.child||n<job.first||n>job.last||job.child.exitCode!==null||n>job.requested+3||n<job.requested-2)await encode(n);
				const deadline=Date.now()+45000;
				while(!job.stopped&&Date.now()<deadline){
					try{const bytes=await readFile(file);job.requested=n;return bytes;}catch{}
					if(job.child?.exitCode!==null)break;
					await new Promise(r=>setTimeout(r,100));
				}
				await kill();throw fail('The catch-up provider did not supply this position. Try again.');
			}
			return {stop,touch:()=>{job.lastRead=clock();},duration:timeline.duration,method:'Transcode',audio:[],
				read:async file=>{
					if(job.stopped)throw fail('Playback expired.',410);job.lastRead=clock();
					if(file==='index.m3u8')return Buffer.from(catchupManifest(item,clock()));
					const match=/^segment(\d{9})\.ts$/.exec(file);if(!match)throw fail('Invalid stream resource.',400);
					const result=job.queue.then(()=>{if(job.stopped)throw fail('Playback expired.',410);return chunk(Number(match[1]));});job.queue=result.catch(()=>{});return result;
				}};
		}catch(error){await stop();throw error;}
	}
	return {start};
}
