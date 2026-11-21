import {spawn, spawnSync} from 'node:child_process';
import {mkdtemp,readFile,readdir,rm,stat} from 'node:fs/promises';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import path from 'node:path';
import os from 'node:os';

const fail=(message,status=502)=>Object.assign(Error(message),{status});
const segmentSeconds=4;
// Catch-up quality is a bounded rung, like live and VOD. Anything else keeps
// the 8 Mbps default so an unknown client value can never break the encoder
// or the stream contract.
export const catchupQualityRungs=[2000000,4000000,8000000,20000000,80000000];
const defaultCatchupQuality=8000000;
// Encode ahead of a seek in bounded windows. Reading the minute pre-roll at
// provider speed is fast, but encoding the whole remaining programme would
// evict the client's unread segments from the bounded cache.
const encodeWindowSeconds=300;
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
export function catchupManifest(item,now=Date.now(),startOffset=0){
	const timeline=catchupTimeline(item,now),length=timeline.ended?timeline.duration:timeline.available;
	const start=Math.max(0,Math.min(Math.floor(length),Math.floor(Number(startOffset)||0)));
	const lines=['#EXTM3U','#EXT-X-VERSION:3','#EXT-X-TARGETDURATION:4','#EXT-X-MEDIA-SEQUENCE:0',
		'#EXT-X-PLAYLIST-TYPE:EVENT','#EXT-X-START:TIME-OFFSET='+start+',PRECISE=YES'];
	for(let n=0;n<Math.ceil(length/4);n++)lines.push('#EXTINF:'+Math.min(4,length-n*4).toFixed(3)+',','segment'+String(n).padStart(9,'0')+'.ts');
	if(timeline.ended)lines.push('#EXT-X-ENDLIST');
	return lines.concat('').join('\n');
}

/** Keep one archive connection per playback run; reopen only for a seek or recovery. */
export function createCatchupPlayer({openArchive,maxSessions=3,clock=Date.now,paceInput=true,cacheSegments=90,cacheBytes=128*1024*1024,startTimeoutMs=45000,onFailure=null}){
	const jobs=new Set();
	// One overall deadline for a start or seek: from the first missing-segment
	// wait through the provider session POST, the archive open and the first
	// completed segment. The client's media read timeout is 65 seconds, so the
	// default 45 seconds leaves a stalled provider no way to stack its latency
	// past the client. Invalid values fall back to the default.
	const startDeadline=Number.isFinite(startTimeoutMs)?Math.min(60000,Math.max(1000,startTimeoutMs)):45000;
	// Bounded, sanitized failure records: stage name and elapsed milliseconds
	// only. Never channel names, IDs, URLs, tokens, query strings or provider
	// payloads. The default sink writes one line per failed stage, capped at
	// three per playback run.
	const failLog=typeof onFailure==='function'?onFailure:record=>{try{console.error('catch-up '+record.stage+' failed after '+record.elapsedMs+'ms');}catch{}};
	async function start(channel,item,position=0,options={}){
		if(!/^[a-f0-9-]{36}$/i.test(channel.id))throw fail('Invalid channel.',400);
		// The encoder caps the video bitrate at the chosen quality rung; the
		// effective value travels back to the caller so a replacement or resume
		// can keep the same ceiling.
		const quality=catchupQualityRungs.includes(options?.quality)?options.quality:defaultCatchupQuality;
		const timeline=catchupTimeline(item,clock());
		// The playlist keeps the absolute programme timeline so the client's seek
		// bar, resume position and captions stay on one clock. The requested
		// position only changes where the first segment is encoded: segment n is
		// always exactly at programme time n*4. A replacement at 10:00 therefore
		// reuses the same playlist but starts its archive section at 10:00.
		// Clients and the API carry milliseconds; the archive timeline is seconds.
		const requestedSeconds=Math.max(0,Number(position)||0)/1000;
		const startOffset=Math.max(0,Math.min(Math.max(0,Math.floor(timeline.duration)-segmentSeconds),
			Math.floor(requestedSeconds/segmentSeconds)*segmentSeconds));
		if(jobs.size>=maxSessions)throw fail('Stop another catch-up programme before opening this one.',503);
		const job={stopped:false,child:null,archive:null,controller:null,cancel:new AbortController(),lastRead:clock(),queue:Promise.resolve(),first:-1,last:-1,requested:-1,startOffset,failures:0};jobs.add(job);
		async function kill(){
			job.controller?.abort();const child=job.child;job.child=null;
			if(child&&child.exitCode===null){child.kill('SIGTERM');await Promise.race([new Promise(r=>child.once('close',r)),new Promise(r=>setTimeout(r,1000))]);if(child.exitCode===null)child.kill('SIGKILL');}
			const archive=job.archive;job.archive=null;if(archive)await archive.stop();
		}
		async function stop(){if(job.stopped)return;job.stopped=true;
			// Settle every pending start/seek race first, so a read waiting on a
			// provider that ignores cancellation is released promptly instead of
			// holding the client until the deadline.
			job.cancel.abort();
			clearInterval(job.watchdog);clearInterval(job.cleanup);await kill();if(job.directory)await rm(job.directory,{recursive:true,force:true});jobs.delete(job);}
		function reportFailure(stage,elapsedMs){
			if(job.failures>=3)return;
			job.failures++;
			const record={stage:String(stage),elapsedMs:Math.max(0,Math.round(Number(elapsedMs)||0))};
			try{failLog(record);}catch{}
		}
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
			async function encode(n,deadline){
				await kill();
				for(const name of await readdir(job.directory))await rm(path.join(job.directory,name),{force:true});
				if(job.stopped)throw fail('Playback expired.',410);
				const offset=n*segmentSeconds,base=Math.floor(offset/60)*60,skip=offset-base;
				const available=catchupTimeline(item,clock()).available,length=Math.min(timeline.duration-offset,available-offset);
				if(length<=0)throw fail('This part of the programme has not aired yet.',409);
				// Dispatcharr catch-up returns the minute containing the requested
				// timestamp, so open the containing minute and trim the pre-roll.
				// The pre-roll is read at full provider speed (no read-rate) and
				// bounded to a short window so a seek cannot stall at 1x for up to
				// 59 seconds before its first new segment exists.
				const window=Math.min(length,encodeWindowSeconds);
				const started=Date.now();
				// One provider archive per encode window. It is released exactly
				// once, whether the session POST, the archive open or stop loses.
				let releaseTarget=null,releasePromise=null;
				const releaseArchive=created=>{
					if(created)releaseTarget=created;
					if(!releaseTarget||typeof releaseTarget.stop!=='function')return Promise.resolve();
					if(!releasePromise)releasePromise=Promise.resolve().then(()=>releaseTarget.stop()).catch(()=>{});
					return releasePromise;
				};
				// The provider session POST takes no abort signal, so race it
				// against the same overall deadline as the rest of the start and
				// against playback stop. A stalled provider must fail here, before
				// the client's media read timeout, instead of stacking its latency
				// onto the later waits.
				let opening,upstream;
				try{
					opening=openArchive(channel.id,new Date(timeline.start+base*1000).toISOString(),Math.max(1,Math.ceil((skip+window)/60)));
					upstream=await Promise.race([opening,
						new Promise((resolve,reject)=>{
							const timer=setTimeout(()=>reject(Object.assign(fail('The catch-up provider did not prepare this programme in time. Try again.'),{stage:'session'})),Math.max(0,deadline-Date.now()));
							if(timer.unref)timer.unref();
						}),
						new Promise((resolve,reject)=>{job.cancel.signal.addEventListener('abort',()=>reject(fail('Playback expired.',410)),{once:true});})]);
				}catch(error){
					// The race is lost; the session POST may still complete later.
					// Register its release here, even when stop won first, so the
					// provider archive is never leaked.
					void opening?.then(created=>{void releaseArchive(created);},()=>{});
					if(job.stopped){await kill();throw fail('Playback expired.',410);}
					// Report the sanitized stage for a deadline miss and for a
					// provider rejection alike (HTTP error, invalid session,
					// network failure). The original error keeps its exact
					// user-facing message and status.
					reportFailure('session',Date.now()-started);
					await kill();throw error;
				}
				const archive={open:upstream.open,stop:()=>releaseArchive(upstream)};
				if(job.stopped){await archive.stop();throw fail('Playback expired.',410);}job.archive=archive;
				const controller=new AbortController();job.controller=controller;
				let opened=false;
				const openRemaining=Math.max(0,deadline-Date.now());
				const timeout=setTimeout(()=>controller.abort(),openRemaining);
				try{
					// Race the archive open against the deadline and stop. The
					// abort signal is only a hint: a provider that ignores it must
					// not be able to leave the read unsettled after the deadline.
					const response=await Promise.race([archive.open(controller.signal),
						new Promise((resolve,reject)=>{
							const timer=setTimeout(()=>reject(Object.assign(fail('The catch-up provider could not open this programme in time. Try again.'),{stage:'open'})),openRemaining);
							if(timer.unref)timer.unref();
						}),
						new Promise((resolve,reject)=>{job.cancel.signal.addEventListener('abort',()=>reject(fail('Playback expired.',410)),{once:true});})]);
					if(!response.ok||!response.body){await response.body?.cancel();throw fail('The catch-up provider could not open this programme.');}
					clearTimeout(timeout);opened=true;
					// FFmpeg normalizes the input's shared start time and corrects TS
					// discontinuities. Do not reset each stream independently.
					// -copyts/-start_at_zero move all streams by the same amount so
					// the trim can address the minute pre-roll even when the
					// provider's PTS is an absolute clock. Only the first programme
					// start is paced; a seek reads its pre-roll at provider speed
					// and then stops at the bounded window.
					const paced=paceInput&&n===0;
					const args=['-hide_banner','-loglevel','error','-fflags','+genpts+discardcorrupt','-probesize','2000000','-analyzeduration','2000000',
						...(paced?['-readrate','1',...(initialBurstSupported?['-readrate_initial_burst','20']:[])]:[]),
						'-copyts','-start_at_zero','-protocol_whitelist','pipe','-i','pipe:0',
						'-map','0:v:0','-map','0:a:0?','-sn','-dn','-c:v','libx264','-preset','veryfast','-threads','2','-crf','23','-maxrate',String(quality),'-bufsize',String(quality*2),
						'-vf',`trim=start=${skip}:duration=${window},scale=w='min(1920,iw)':h=-2,format=yuv420p,fps=25:start_time=${skip},setpts=PTS+${base}/TB`,
						'-af',`atrim=start=${skip}:duration=${window},asetpts=PTS+${base}/TB`,
						'-fps_mode','passthrough','-g','100','-keyint_min','100','-sc_threshold','0','-c:a','aac','-ac','2','-b:a','160k','-t',String(offset+window),
						'-f','hls','-hls_time','4','-hls_list_size','0','-start_number',String(n),'-hls_flags','temp_file','-hls_segment_filename','segment%09d.ts','window.m3u8'];
					const child=spawn('ffmpeg',args,{cwd:job.directory,stdio:['pipe','ignore','ignore']});job.child=child;job.first=n;job.last=n+Math.ceil(window/4)-1;job.requested=n;
					child.stdin.on('error',()=>{});child.on('error',()=>controller.abort());
					child.once('close',()=>{controller.abort();void archive.stop().catch(()=>{});});
					void pipeline(Readable.fromWeb(response.body),child.stdin,{signal:controller.signal}).catch(()=>{if(child.exitCode===null)child.stdin.destroy();});
				}catch(error){clearTimeout(timeout);
					if(job.stopped){await kill();throw fail('Playback expired.',410);}
					// A deadline miss, or an open that only failed because the
					// deadline aborted it, is reported with the bounded open
					// message; a provider rejection keeps its exact message and
					// status.
					if(error?.stage==='open'||(error?.name==='AbortError'&&controller.signal.aborted)){
						reportFailure('open',Date.now()-started);
						await kill();
						throw Object.assign(fail('The catch-up provider could not open this programme in time. Try again.'),{stage:'open'});
					}
					if(!opened)reportFailure('open',Date.now()-started);
					await kill();throw error;}
			}
			async function chunk(n){
				const available=catchupTimeline(item,clock());
				if(!Number.isSafeInteger(n)||n<0||n>=Math.ceil((available.ended?available.duration:available.available)/4))throw fail('This part of the programme is unavailable.',404);
				const file=path.join(job.directory,'segment'+String(n).padStart(9,'0')+'.ts');
				try{const bytes=await readFile(file);job.requested=n;return bytes;}catch{}
				// One deadline covers the whole start-or-seek operation, including
				// the provider session POST and archive open inside encode(), so a
				// stalled provider fails here, before the client's media read
				// timeout, instead of after the client has given up.
				const started=Date.now(),deadline=started+startDeadline;
				if(!job.child||n<job.first||n>job.last||job.child.exitCode!==null||n>job.requested+3||n<job.requested-2)await encode(n,deadline);
				while(!job.stopped&&Date.now()<deadline){
					try{const bytes=await readFile(file);job.requested=n;return bytes;}catch{}
					if(job.child?.exitCode!==null)break;
					await new Promise(r=>setTimeout(r,100));
				}
				if(job.stopped){await kill();throw fail('Playback expired.',410);}
				if(!job.stopped)reportFailure('segment',Date.now()-started);
				await kill();throw fail('The catch-up provider did not supply this position in time. Try again.');
			}
			return {stop,touch:()=>{job.lastRead=clock();},duration:timeline.duration,position:startOffset,quality,method:'Transcode',audio:[],
				read:async file=>{
					if(job.stopped)throw fail('Playback expired.',410);job.lastRead=clock();
					if(file==='index.m3u8')return Buffer.from(catchupManifest(item,clock(),job.startOffset));
					const match=/^segment(\d{9})\.ts$/.exec(file);if(!match)throw fail('Invalid stream resource.',400);
					const result=job.queue.then(()=>{if(job.stopped)throw fail('Playback expired.',410);return chunk(Number(match[1]));});job.queue=result.catch(()=>{});return result;
				}};
		}catch(error){await stop();throw error;}
	}
	return {start};
}
