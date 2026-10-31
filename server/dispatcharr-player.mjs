import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const failure = message => Object.assign(new Error(message), {status:502});
export function mediaFile(value) {
	if (!/^(?:(?:index|video|captions-\d+)\.m3u8|segment\d+\.ts|caption-\d+-\d+\.vtt)$/.test(value)) throw Object.assign(Error('Invalid stream resource.'), {status:400});
	return value;
}

export function encodingArgs({codec, pixelFormat, bitrate, quality, compatibility, audioIndex}) {
	const convert = compatibility || codec !== 'h264' || (pixelFormat && !['yuv420p','yuvj420p'].includes(pixelFormat)) || bitrate > quality;
	const args = ['-hide_banner','-loglevel','error','-fflags','+genpts+discardcorrupt','-probesize','2000000','-analyzeduration','2000000','-protocol_whitelist','pipe','-i','pipe:0',
		'-map','0:v:0','-map',Number.isInteger(audioIndex) ? `0:${audioIndex}` : '0:a:0?', '-sn','-dn'];
	if (convert) args.push('-c:v','libx264','-preset','veryfast','-threads','2','-crf','23','-maxrate',String(quality),'-bufsize',String(quality*2),
		'-vf',"scale=w='min(1920,iw)':h=-2,format=yuv420p",'-r','25','-g','50','-keyint_min','50','-sc_threshold','0');
	else args.push('-c:v','copy');
	args.push('-c:a','aac','-ac','2','-b:a','160k','-max_muxing_queue_size','2048','-f','hls','-hls_time','2','-hls_list_size','30',
		'-hls_delete_threshold','8','-hls_flags','delete_segments+temp_file','-hls_segment_filename','segment%09d.ts','index.m3u8');
	return {args,convert};
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

export function createDirectPlayer({origin, fetcher = fetch, maxSessions = 6}) {
	const jobs = new Set();
	async function start(channel, options = {}) {
		if (jobs.size >= maxSessions) throw Object.assign(Error('All TV playback slots are busy. Stop another stream and try again.'),{status:503});
		const job = {controller:new AbortController(),directory:null,child:null,stopped:false,lastRead:Date.now()};
		jobs.add(job);
		async function stop() {
			if (job.stopped) return;
			job.stopped = true; job.controller.abort(); clearInterval(job.watchdog);
			if(job.child && job.child.exitCode === null) {
				job.child.kill('SIGTERM');
				await Promise.race([new Promise(resolve=>job.child.once('close',resolve)),new Promise(resolve=>setTimeout(resolve,1500))]);
				if(job.child.exitCode===null) job.child.kill('SIGKILL');
			}
			if(job.directory) await rm(job.directory,{recursive:true,force:true});
			jobs.delete(job);
		}
		try {
			// Only a channel obtained from the trusted playlist can choose the input URL.
			if(!/^[a-f0-9-]{36}$/i.test(channel.id))throw failure('Invalid channel.');
			const startupTimer=setTimeout(()=>job.controller.abort(),45000);
			job.watchdog=setInterval(()=>{if(Date.now()-job.lastRead>60000)void stop();},10000).unref();
			const response=await (options.openStream?options.openStream(job.controller.signal):fetcher(new URL('/proxy/ts/stream/'+channel.id,origin),{redirect:'error',signal:job.controller.signal}));
			if(!response.ok||!response.body)throw failure('Dispatcharr could not open this channel. Please try another channel.');
			const reader=response.body.getReader(), initial=[]; let bytes=0;
			while(bytes<512*1024) {
				const next=await reader.read(); if(next.done)throw failure('This channel is currently unavailable.');
				initial.push(Buffer.from(next.value)); bytes+=next.value.byteLength;
			}
			const buffer=Buffer.concat(initial), info=await probe(buffer), video=info.streams?.find(s=>s.codec_type==='video');
			const audio=(info.streams||[]).filter(s=>s.codec_type==='audio');
			const selected=audio.find(s=>s.index===options.audioIndex);
			const encoding=encodingArgs({codec:video?.codec_name,pixelFormat:video?.pix_fmt,bitrate:Number(info.format?.bit_rate)||Number(video?.bit_rate)||0,
				quality:options.quality||20000000, compatibility:options.compatibility, audioIndex:selected?.index});
			// Archive playback is paced and retains ten minutes; a long programme cannot fill the disk.
			if(options.finite){encoding.args.splice(encoding.args.indexOf('-i'),0,'-readrate','1');encoding.args[encoding.args.indexOf('-hls_list_size')+1]='300';}
			job.directory=await mkdtemp(path.join(os.tmpdir(),'tellybox-tv-'));
			job.child=spawn('ffmpeg',encoding.args,{cwd:job.directory,stdio:['pipe','ignore','ignore']});
			job.child.on('error',()=>void stop());
			job.child.on('close',()=>{job.exited=true;});
			job.child.stdin.on('error',()=>{});
			const input=Readable.from((async function*(){yield buffer;while(!job.stopped){const next=await reader.read();if(next.done)break;yield Buffer.from(next.value);}})());
			void pipeline(input,job.child.stdin,{signal:job.controller.signal}).catch(()=>{if(!job.stopped)void stop();});
			let playlist;
			while(!job.stopped&&!job.exited) {
				try { playlist=await readFile(path.join(job.directory,'index.m3u8'),'utf8'); if(playlist.includes('.ts'))break; } catch {}
				await new Promise(resolve=>setTimeout(resolve,150));
			}
			clearTimeout(startupTimer);
			if(!playlist||job.stopped)throw failure('This channel did not start. Please try again or choose another channel.');
			return {stop, method:encoding.convert?'Transcode':'Remux', videoCodec:video?.codec_name||'', audioCodec:'aac',
				audio:audio.map((s,i)=>({index:s.index,label:s.tags?.language||`Audio ${i+1}`,selected:s.index===(selected?.index??audio[0]?.index)})),
				read:async file=>{mediaFile(file);job.lastRead=Date.now();if(job.stopped)throw Object.assign(Error('Playback expired.'),{status:410});return readFile(path.join(job.directory,file));}};
		} catch(error) {await stop();throw failure(error.status ? error.message : 'Dispatcharr could not prepare this channel. Please try again.');}
	}
	return {start};
}
