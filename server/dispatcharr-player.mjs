import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { sourceVideoSupported } from './capabilities.mjs';
import { createDiagnosticsBuffer, createProducerProgress } from './producer-progress.mjs';

const failure = message => Object.assign(new Error(message), {status:502});
const LIVE_PRESETS = new Set(['veryfast', 'superfast', 'ultrafast']);
export const DEFAULT_LIVE_PRESET = 'ultrafast';

/** Live/direct and relay live share this preset; VOD and catchup keep theirs. */
export function livePreset(value = process.env.TELLYBOX_LIVE_PRESET) {
	return LIVE_PRESETS.has(value) ? value : DEFAULT_LIVE_PRESET;
}

export function mediaFile(value) {
	if (!/^(?:(?:index|video|captions-\d+)\.m3u8|segment\d+\.ts|caption-\d+-\d+\.vtt)$/.test(value)) throw Object.assign(Error('Invalid stream resource.'),{status:400});
	return value;
}

export function encodingArgs({codec,pixelFormat,profile,level,width,height,bitrate,frameRate,quality,compatibility,audioIndex,capabilities,preset,threads,blockers}={}) {
	if (compatibility && Array.isArray(blockers)) blockers.push('compatibility');
	const convert = Boolean(compatibility) || !sourceVideoSupported({codec,pixelFormat,profile,level,width,height,bitrate,frameRate,quality,capabilities,allowUnknownBitrate:true,blockers});
	const args = ['-hide_banner','-loglevel','error','-nostats','-progress','pipe:2','-fflags','+genpts+discardcorrupt','-probesize','2000000','-analyzeduration','2000000','-protocol_whitelist','pipe','-i','pipe:0',
		'-map','0:v:0','-map',Number.isInteger(audioIndex) ? `0:${audioIndex}` : '0:a:0?', '-sn','-dn'];
	if (convert) {
		const selectedPreset = LIVE_PRESETS.has(preset) ? preset : livePreset();
		const selectedThreads = Number.isInteger(threads) && threads >= 1 && threads <= 8 ? threads : 2;
		args.push('-c:v','libx264','-preset',selectedPreset,'-threads',String(selectedThreads),'-crf','23','-maxrate',String(quality),'-bufsize',String(quality*2),
			'-vf',"scale=w='min(1920,iw)':h=-2,format=yuv420p",'-r','25','-g','50','-keyint_min','50','-sc_threshold','0');
	} else args.push('-c:v','copy');
	args.push('-c:a','aac','-ac','2','-b:a','160k','-max_muxing_queue_size','2048','-f','hls','-hls_time','2','-hls_list_size','30',
		'-hls_delete_threshold','8','-hls_flags','delete_segments+temp_file','-hls_segment_filename','segment%09d.ts','index.m3u8');
	return {args,convert};
}

// Most live streams identify their first video track well before 512 KiB.
// Start with 256 KiB and read a second block only when ffprobe needs it.
export function probeTargets() { return [256 * 1024, 512 * 1024]; }
export function probeNeedsMore(info) {
	const streams = info?.streams || [];
	return !streams.some(stream => stream.codec_type === 'video') || !streams.some(stream => stream.codec_type === 'audio');
}

async function probe(buffer) {
	return new Promise(resolve => {
		const child = spawn('ffprobe',['-v','error','-probesize','2000000','-analyzeduration','2000000','-protocol_whitelist','pipe','-show_streams','-show_format','-of','json','pipe:0'],{stdio:['pipe','pipe','ignore']});
		let output = '';
		const timer = setTimeout(()=>child.kill('SIGKILL'),5000);
		child.stdout.on('data',chunk=>{if(output.length<200000)output+=chunk;});
		child.stdin.on('error',()=>{}); child.stdin.end(buffer);
		child.on('error',()=>{clearTimeout(timer);resolve({});});
		child.on('close',()=>{clearTimeout(timer);try{resolve(JSON.parse(output));}catch{resolve({});}});
	});
}

export function createDirectPlayer({origin, fetcher = fetch, maxSessions = 6, progressTimeoutMs = 60000, watchdogMs = 10000,
	now = Date.now, spawnProcess = spawn, readPlaylist = readFile, probeFn = probe} = {}) {
	const jobs = new Set();
	async function start(channel, options = {}) {
		if (jobs.size >= maxSessions) throw Object.assign(Error('All TV playback slots are busy. Stop another stream and try again.'),{status:503});
		const job = {controller:new AbortController(),directory:null,child:null,stopped:false,exited:false,exitCode:null,lastRead:now(),progress:{},diagnostics:createDiagnosticsBuffer(),onStopped:options.onStopped};
		jobs.add(job);
		job.tracker = createProducerProgress({timeoutMs: progressTimeoutMs, now, onStall: () => { void stop(); }});
		async function stop() {
			if (job.stopped) return;
			job.stopped = true;
			job.tracker.stop();
			job.controller.abort(); clearInterval(job.watchdog); clearTimeout(job.startupTimer);
			if(job.child && job.child.exitCode === null) {
				job.child.kill('SIGTERM');
				await Promise.race([new Promise(resolve=>job.child.once('close',resolve)),new Promise(resolve=>setTimeout(resolve,1500))]);
				if(job.child.exitCode===null) job.child.kill('SIGKILL');
			}
			if(job.directory) await rm(job.directory,{recursive:true,force:true});
			jobs.delete(job);
			if (typeof job.onStopped === 'function') { try { job.onStopped(); } catch {} }
		}
		try {
			// Only a channel obtained from the trusted playlist can choose the input URL.
			if(!/^[a-f0-9-]{36}$/i.test(channel.id))throw failure('Invalid channel.');
			job.startupTimer=setTimeout(()=>job.controller.abort(),45000);
			job.startupTimer.unref?.();
			job.watchdog=setInterval(()=>{
				if(now()-job.lastRead>60000) { void stop(); return; }
				job.tracker.tick();
			}, Math.max(10, Math.min(10000, Number(watchdogMs) || 10000))).unref();
			const response=await (options.openStream?options.openStream(job.controller.signal):fetcher(new URL('/proxy/ts/stream/'+channel.id,origin),{redirect:'error',signal:job.controller.signal}));
			if(!response.ok||!response.body)throw failure('Dispatcharr could not open this channel. Please try another channel.');
			const reader=response.body.getReader(), initial=[]; let bytes=0;
			const [firstTarget, fullTarget] = probeTargets();
			async function fill(target) {
				while(bytes<target) {
					const next=await reader.read(); if(next.done)throw failure('This channel is currently unavailable.');
					initial.push(Buffer.from(next.value)); bytes+=next.value.byteLength;
				}
			}
			await fill(firstTarget);
			let buffer=Buffer.concat(initial), info=await probeFn(buffer), video=info.streams?.find(s=>s.codec_type==='video');
			if(probeNeedsMore(info)&&bytes<fullTarget) {
				await fill(fullTarget);
				buffer=Buffer.concat(initial); info=await probeFn(buffer); video=info.streams?.find(s=>s.codec_type==='video');
			}
			const audio=(info.streams||[]).filter(s=>s.codec_type==='audio');
			const selected=audio.find(s=>s.index===options.audioIndex);
			const copyBlockers=[];
			const encoding=encodingArgs({codec:video?.codec_name,pixelFormat:video?.pix_fmt,profile:video?.profile,level:video?.level,width:video?.width,height:video?.height,
				frameRate:video?.r_frame_rate||video?.avg_frame_rate,bitrate:Number(info.format?.bit_rate)||Number(video?.bit_rate)||0,quality:options.quality||20000000,compatibility:options.compatibility,
				audioIndex:selected?.index,capabilities:options.capabilities,blockers:copyBlockers});
			// Archive playback is paced and retains ten minutes; a long programme cannot fill the disk.
			if(options.finite){encoding.args.splice(encoding.args.indexOf('-i'),0,'-readrate','1');encoding.args[encoding.args.indexOf('-hls_list_size')+1]='300';}
			job.directory=await mkdtemp(path.join(os.tmpdir(),'tellybox-tv-'));
			job.child=spawnProcess('ffmpeg',encoding.args,{cwd:job.directory,stdio:['pipe','ignore','pipe']});
			job.child.on('error',()=>void stop());
			job.child.on('close',(code)=>{job.exited=true;job.exitCode=Number(code)||0;job.tracker.exit(code);if(!job.stopped)void stop();});
			job.child.stderr?.setEncoding?.('utf8');
			let stderrBuffer='';
			job.child.stderr?.on('data',chunk=>{
				stderrBuffer+=chunk;
				let newline;
				while((newline=stderrBuffer.indexOf('\n'))>=0) {
					const line=stderrBuffer.slice(0,newline).trim(); stderrBuffer=stderrBuffer.slice(newline+1);
					if(!line)continue;
					const match=/^([a-z_]+)=(.*)$/.exec(line);
					if(match&&['frame','fps','out_time_us','out_time_ms','speed','progress'].includes(match[1]))job.progress[match[1]]=match[2];
					else job.diagnostics.push(line);
				}
				if(stderrBuffer.length>8192)stderrBuffer=stderrBuffer.slice(-8192);
			});
			job.child.stdin.on('error',()=>{});
			const input=Readable.from((async function*(){yield buffer;while(!job.stopped){const next=await reader.read();if(next.done)break;yield Buffer.from(next.value);}})());
			void pipeline(input,job.child.stdin,{signal:job.controller.signal}).catch(()=>{if(!job.stopped)void stop();});
			let playlist;
			while(!job.stopped&&!job.exited) {
				try { playlist=await readPlaylist(path.join(job.directory,'index.m3u8'),'utf8'); if(playlist.includes('.ts'))break; } catch {}
				await new Promise(resolve=>setTimeout(resolve,150));
			}
			clearTimeout(job.startupTimer); job.startupTimer=null;
			if(!playlist||job.stopped)throw failure('This channel did not start. Please try again or choose another channel.');
			job.tracker.observe(playlist);
			return {stop, method:encoding.convert?'Transcode':'Remux', videoCodec:video?.codec_name||'', audioCodec:'aac', copyBlockers,
				audio:audio.map((s,i)=>({index:s.index,label:s.tags?.language||`Audio ${i+1}`,selected:s.index===(selected?.index??audio[0]?.index)})),
				diagnostics:()=>job.diagnostics.text(),
				read:async file=>{mediaFile(file);if(job.stopped||job.exited)throw Object.assign(Error('Playback expired.'),{status:410});job.lastRead=now();
					const content=await readPlaylist(path.join(job.directory,file));if(file==='index.m3u8')job.tracker.observe(content.toString());return content;}};
		} catch(error) {await stop();const wrapped=failure(error.status ? error.message : 'Dispatcharr could not prepare this channel. Please try again.');wrapped.cause=error;throw wrapped;}
	}
	return {start};
}
