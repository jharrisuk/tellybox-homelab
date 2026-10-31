import http from 'node:http';
import {captionMaster,captionManifest,captionSlice} from './vod-captions.mjs';
import {randomBytes} from 'node:crypto';
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,readdir,rm,copyFile,writeFile,stat} from 'node:fs/promises';
import {wantsSubtitleLookup} from './playback-profile.mjs';
import {englishSubtitle} from './subtitle-choice.mjs';
import path from 'node:path';
import os from 'node:os';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';

const fail=message=>Object.assign(Error(message),{status:502});
const textCodecs=new Set(['subrip','srt','ass','ssa','webvtt','mov_text','text']);
const imageCodecs=new Set(['hdmv_pgs_subtitle','dvd_subtitle','dvb_subtitle']);
export async function vodUpstreamFailure(response) {
	// Dispatcharr's error pages can contain private provider URLs. Inspect only
	// a bounded prefix and return our own message; never forward or log the page.
	const reader=response.body?.getReader();let text='';
	try {
		while(reader&&text.length<8192) {
			const chunk=await reader.read();if(chunk.done)break;
			text+=Buffer.from(chunk.value).toString('utf8').slice(0,8192-text.length);
		}
	}catch{}finally{await reader?.cancel().catch(()=>{});}
	return fail(/ConnectTimeout|connect timeout|ReadTimeout|read timed out/i.test(text)
		?'Dispatcharr could not reach this title’s provider. Please try again later.'
		:'Dispatcharr could not supply video for this title. Please check it in Dispatcharr.');
}
export function vodSubtitleTracks(streams=[]){
	let ordinal=0;
	return streams.filter(s=>s.codec_type==='subtitle').map(s=>({...s,ordinal:ordinal++})).filter(s=>textCodecs.has(s.codec_name)||imageCodecs.has(s.codec_name));
}
export function selectVodSubtitle(options,tracks,external){
	if(Number.isInteger(options.subtitleIndex))return options.subtitleIndex===external?.index?external:tracks.find(s=>s.index===options.subtitleIndex)||null;
	if(options.preferEnglishSubtitles!==true)return null;
	const english=tracks.filter(s=>englishSubtitle(s.tags?.language,s.tags?.title,s.tags?.handler_name));
	return (options.textSubtitles===true?english.find(s=>textCodecs.has(s.codec_name)):null)||english[0]||external;
}
export function vodVideoFilter({offset,subtitle,url}) {
	const base=`scale=w='min(1920,iw)':h=-2,format=yuv420p,fps=25,setpts=PTS+${offset}/TB`;
	if(!subtitle)return ['-vf',base];
	if(imageCodecs.has(subtitle.codec_name))return ['-filter_complex',`[0:v:0][0:${subtitle.index}]overlay,${base}[captioned]`];
	const input=subtitle.file?(subtitle.localName||'captions.srt'):url.replaceAll(':','\\:');
	return ['-vf',base+`,subtitles=filename='${input}'${subtitle.file?'':':si='+subtitle.ordinal}:force_style='FontName=DejaVu Sans,FontSize=20,PrimaryColour=&H00FFFFFF,OutlineColour=&H90000000,BorderStyle=1,Outline=1.5,Shadow=0.5,MarginV=18'`];
}
export function vodManifest(duration) {
	if(!Number.isFinite(duration)||duration<=0||duration>86400)throw fail('This title has no usable duration.');
	const lines=['#EXTM3U','#EXT-X-VERSION:3','#EXT-X-TARGETDURATION:4','#EXT-X-MEDIA-SEQUENCE:0','#EXT-X-PLAYLIST-TYPE:VOD'];
	for(let n=0;n<Math.ceil(duration/4);n++)lines.push('#EXTINF:'+Math.min(4,duration-n*4).toFixed(3)+',','segment'+String(n).padStart(9,'0')+'.ts');
	return lines.concat('#EXT-X-ENDLIST','').join('\n');
}
export function sniffContainer(bytes) {
	if(bytes.subarray(0,4).equals(Buffer.from([0x1a,0x45,0xdf,0xa3])))return 'matroska';
	if(['ftyp','moov','mdat','free','wide'].includes(bytes.toString('ascii',4,8)))return 'mov';
	if(bytes[0]===0x47&&bytes[188]===0x47)return 'mpegts';
	if(bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='AVI ')return 'avi';
	throw fail('This provider supplied a video format that is not supported yet.');
}

export function createVodPlayer({open,close=async()=>{},maxSessions=3}) {
	const jobs=new Map();let serverPromise;
	async function internalServer() {
		if(serverPromise)return serverPromise;
		serverPromise=new Promise(resolve=>{
			const server=http.createServer(async(req,res)=>{
				const job=jobs.get(req.url?.slice(1));
				if(!job||job.stopped||!['GET','HEAD'].includes(req.method))return res.writeHead(404).end();
				if(req.headers.range&&!/^bytes=\d*-\d*$/.test(req.headers.range))return res.writeHead(416).end();
				const controller=new AbortController();job.controllers.add(controller);res.on('close',()=>controller.abort());
				try {
					const upstream=await open(job.source,{range:req.headers.range,signal:controller.signal,client:'Tellybox-'+job.token.slice(0,12)});
					if(process.env.VOD_DEBUG==='1')console.error(JSON.stringify({range:req.headers.range,status:upstream.status,contentRange:upstream.headers.get('content-range'),length:upstream.headers.get('content-length')}));
					if(![200,206,416].includes(upstream.status)){await upstream.body?.cancel();return res.writeHead(502).end();}
					res.statusCode=upstream.status;
					for(const key of ['content-type','content-length','content-range','accept-ranges'])if(upstream.headers.has(key))res.setHeader(key,upstream.headers.get(key));
					if(req.method==='HEAD'){await upstream.body?.cancel();return res.end();}
					await pipeline(Readable.fromWeb(upstream.body),res,{signal:controller.signal});
				}catch{if(!res.headersSent)res.writeHead(502);res.end();}
				finally{job.controllers.delete(controller);}
			}).listen(0,'127.0.0.1',()=>{server.unref();resolve(server.address().port);});
		});
		return serverPromise;
	}
	async function start(source,options={}) {
		if(jobs.size>=maxSessions)throw Object.assign(Error('All streamed-film playback slots are busy. Please stop another streamed title and try again.'),{status:503});
		const token=randomBytes(24).toString('hex');source={...source,session:token};
		const job={token,source,controllers:new Set(),subtitleChildren:new Set(),stopped:false,child:null,lastRead:Date.now(),start:-1,queue:Promise.resolve()};
		jobs.set(token,job);
		async function killEncoder(){const child=job.child;job.child=null;job.start=-1;if(!child||child.exitCode!==null)return;child.kill('SIGTERM');await Promise.race([new Promise(r=>child.once('close',r)),new Promise(r=>setTimeout(r,1000))]);if(child.exitCode===null)child.kill('SIGKILL');}
		async function stop(){if(job.stopped)return;job.stopped=true;clearInterval(job.watchdog);for(const c of job.controllers)c.abort();for(const child of job.subtitleChildren)child.kill('SIGKILL');await killEncoder();await close(token,source);jobs.delete(token);if(job.directory)await rm(job.directory,{recursive:true,force:true});}
		try {
			const port=await internalServer();job.url=`http://127.0.0.1:${port}/${token}`;
			job.watchdog=setInterval(()=>{if(Date.now()-job.lastRead>120000)void stop();},15000).unref();
			const sampleController=new AbortController();job.controllers.add(sampleController);const timeout=setTimeout(()=>sampleController.abort(),20000);
			let container;
			try{const response=await open(source,{range:'bytes=0-4095',signal:sampleController.signal,client:'Tellybox-'+token.slice(0,12)});if(!response.ok)throw await vodUpstreamFailure(response);const reader=response.body.getReader();const first=await reader.read();await reader.cancel();container=sniffContainer(Buffer.from(first.value||[]));}
			finally{clearTimeout(timeout);job.controllers.delete(sampleController);}
			const info=await new Promise((resolve,reject)=>{
				const child=spawn('ffprobe',['-v','error','-protocol_whitelist','http,tcp','-f',container,'-show_streams','-show_format','-of','json',job.url],{stdio:['ignore','pipe','ignore']});
				let output='';const timer=setTimeout(()=>child.kill('SIGKILL'),30000);
				child.stdout.on('data',chunk=>{if(output.length<200000)output+=chunk;});child.on('error',reject);
				child.on('close',()=>{clearTimeout(timer);try{resolve(JSON.parse(output));}catch{reject(fail('This streamed title could not be inspected. Please try again.'));}});
			});
			const duration=Number(info.format?.duration),manifest=vodManifest(duration),audio=(info.streams||[]).filter(s=>s.codec_type==='audio');
			const chosen=audio.find(s=>s.index===options.audioIndex)||audio.find(s=>/^en(g)?$/i.test(s.tags?.language||''))||audio[0];
			const subtitleTracks=vodSubtitleTracks(info.streams);
			const missingEnglish=!subtitleTracks.some(s=>englishSubtitle(s.tags?.language,s.tags?.title,s.tags?.handler_name));
			const deferred=options.textSubtitles===true&&missingEnglish&&options.lookupSubtitles?{index:1000000,label:'English · OpenSubtitles',lookup:()=>options.lookupSubtitles(duration)}:null;
			const external=options.externalSubtitle||deferred||(missingEnglish&&options.lookupSubtitles&&wantsSubtitleLookup(options)?await options.lookupSubtitles(duration):null);
			const selectedSubtitle=selectVodSubtitle(options,subtitleTracks,external);
			const nativeCaptions=options.textSubtitles===true?subtitleTracks.filter(s=>textCodecs.has(s.codec_name)):[];
			const subtitle=selectedSubtitle?.lookup||nativeCaptions.includes(selectedSubtitle)?null:selectedSubtitle;
			const quality=[2000000,4000000,8000000,20000000,80000000].includes(options.quality)?options.quality:8000000;
			job.directory=await mkdtemp(path.join(os.tmpdir(),'tellybox-vod-'));
			if(subtitle?.file)await copyFile(subtitle.file,path.join(job.directory,'captions.srt'));
			// libass scans its entire input before rendering. Never give it a remote
			// full-length film: extract a short caption window, then render that file.
			const windowedSubtitle=subtitle&&!subtitle.file&&textCodecs.has(subtitle.codec_name);
			const captionSeconds=32,captionWindows=new Map();
			function captionWindow(offset) {
				if(captionWindows.has(offset))return captionWindows.get(offset);
				const pending=(async()=>{
					if(job.stopped)throw fail('Playback expired.');
					const start=Math.max(0,offset-20),length=Math.min(duration,offset+captionSeconds+10)-start;
					const localName=`embedded-${offset}.ass`,clip=path.join(job.directory,`caption-window-${offset}.mkv`);
					async function extract(args,capture=false) {
						return new Promise((resolve,reject)=>{
							const child=spawn('ffmpeg',['-v','error',...args],{stdio:['ignore',capture?'pipe':'ignore','ignore']});
							job.subtitleChildren.add(child);const chunks=[];let bytes=0,limited=false;
							const timeout=setTimeout(()=>{limited=true;child.kill('SIGKILL');},20000);
							child.stdout?.on('data',chunk=>{bytes+=chunk.length;if(bytes>2*1024*1024){limited=true;child.kill('SIGKILL');}else chunks.push(chunk);});
							child.on('error',reject);
							child.on('close',code=>{clearTimeout(timeout);job.subtitleChildren.delete(child);if(code!==0||limited||job.stopped)reject(fail('English subtitles could not be prepared. Try subtitles Off to keep watching.'));else resolve(Buffer.concat(chunks));});
						});
					}
					let data;
					try {
						// Include video packets while cutting: subtitle-only demuxing can
						// scan a whole film when captions are sparse or start much later.
						await extract(['-copyts','-ss',String(start),'-protocol_whitelist','http,tcp','-f',container,'-i',job.url,
							'-map','0:v:0','-map',`0:${subtitle.index}`,'-an','-c','copy','-to',String(start+length),'-avoid_negative_ts','disabled','-fs','268435456','-f','matroska',clip]);
						if(job.stopped)throw fail('Playback expired.');
						if((await stat(clip)).size>=268435456)throw fail('This subtitle track is too large to prepare. Try subtitles Off to keep watching.');
						data=await extract(['-copyts','-i',clip,'-map','0:s:0','-c:s','ass','-f','ass','pipe:1'],true);
					}finally{await rm(clip,{force:true});}
					if(job.stopped)throw fail('Playback expired.');
					await writeFile(path.join(job.directory,localName),data);
					return {...subtitle,file:true,localName};
				})();
				captionWindows.set(offset,pending);
				pending.catch(()=>captionWindows.delete(offset));
				return pending;
			}
			async function encode(n) {
				await killEncoder();
				for(const file of await readdir(job.directory))if(/^segment\d+\.ts(?:\.tmp)?$|^generated\.m3u8(?:\.tmp)?$/.test(file))await rm(path.join(job.directory,file),{force:true});
				if(job.stopped)throw fail('Playback expired.');
				const offset=n*4;
				const renderSubtitle=windowedSubtitle?await captionWindow(offset):subtitle;
				if(job.stopped)throw fail('Playback expired.');
				const args=['-hide_banner','-loglevel','error','-readrate','1','-ss',String(offset),'-protocol_whitelist','http,tcp','-f',container,'-i',job.url,
					'-map',imageCodecs.has(subtitle?.codec_name)?'[captioned]':'0:v:0','-map',chosen?`0:${chosen.index}`:'0:a:0?','-sn','-dn','-c:v','libx264','-preset','veryfast','-threads','2','-crf','23','-maxrate',String(quality),'-bufsize',String(quality*2),
					...vodVideoFilter({offset,subtitle:renderSubtitle,url:job.url}),...(windowedSubtitle?['-t',String(offset+captionSeconds)]:[]),'-fps_mode','passthrough','-g','100','-keyint_min','100','-sc_threshold','0',
					'-c:a','aac','-ac','2','-b:a','160k','-af',`asetpts=PTS+${offset}/TB`,'-max_muxing_queue_size','2048','-f','hls','-hls_time','4','-hls_list_size','12','-hls_delete_threshold','2',
					'-start_number',String(n),'-hls_flags','delete_segments+temp_file','-hls_segment_filename','segment%09d.ts','generated.m3u8'];
				for(const track of nativeCaptions)args.push('-map',`0:${track.index}`,'-c:s','webvtt','-output_ts_offset',String(offset),'-flush_packets','1','-f','webvtt','-y',`captions-${track.index}.vtt`);
				job.start=n;job.child=spawn('ffmpeg',args,{cwd:job.directory,stdio:['ignore','ignore',process.env.VOD_DEBUG==='1'?'pipe':'ignore']});
				job.child.stderr?.on('data',chunk=>console.error(chunk.toString().replaceAll(job.url,'[internal-input]')));
				job.child.on('error',()=>void stop());job.encoderStart=Date.now();
			}
			async function chunk(n) {
				if(n<0||n>=Math.ceil(duration/4))throw Object.assign(Error('Invalid segment.'),{status:404});
				const file=path.join(job.directory,'segment'+String(n).padStart(9,'0')+'.ts');
				try{const bytes=await readFile(file);if(bytes.length)return bytes;}catch{}
				const head=job.start+Math.floor((Date.now()-(job.encoderStart||Date.now()))/4000);
				if(!job.child||job.child.exitCode!==null||n<job.start||n>head+8||n<head-14||(windowedSubtitle&&n>=job.start+captionSeconds/4))await encode(n);
				const deadline=Date.now()+45000;
				while(!job.stopped&&Date.now()<deadline) {
					try{const bytes=await readFile(file);if(bytes.length)return bytes;}catch{}
					if(job.child?.exitCode!==null)break;
					await new Promise(r=>setTimeout(r,120));
				}
				throw fail('The provider stream stalled. Try playing again.');
			}
			return {stop,touch:()=>{job.lastRead=Date.now();},duration,method:'Transcode',videoCodec:'h264',audioCodec:'aac',
				captionSources:deferred?new Map([[deferred.index,{lookup:deferred.lookup}]]):null,subtitleIndex:selectedSubtitle?.index??-1,subtitles:[...subtitleTracks.map(s=>({index:s.index,label:s.tags?.title||s.tags?.language||'Subtitles',...(nativeCaptions.includes(s)?{hls:true,embedded:true,nativeTitle:`tellybox-subtitle-${s.index}`,language:s.tags?.language||'und',ordinal:nativeCaptions.indexOf(s)}:{})})),...(external?[{index:external.index,label:external.label}]:[])],
				audio:audio.map((s,i)=>({index:s.index,label:s.tags?.language||`Audio ${i+1}`,selected:s.index===chosen?.index})),
				read:async file=>{job.lastRead=Date.now();if(job.stopped)throw Object.assign(Error('Playback expired. Please press play again.'),{status:410});if(file==='index.m3u8')return Buffer.from(nativeCaptions.length?captionMaster(nativeCaptions,quality,selectedSubtitle?.index):manifest);
					if(file==='video.m3u8')return Buffer.from(manifest);
					const subtitleList=/^captions-(\d+)\.m3u8$/.exec(file),captionPart=/^caption-(\d+)-(\d+)\.vtt$/.exec(file);
					if(subtitleList||captionPart){
						const track=Number((subtitleList||captionPart)[1]);
						if(!nativeCaptions.some(s=>s.index===track))throw Object.assign(Error('Invalid captions.'),{status:404});
						if(subtitleList)return Buffer.from(captionManifest(duration,track));
						const n=Number(captionPart[2]);if(n>=Math.ceil(duration/4))throw Object.assign(Error('Invalid captions.'),{status:404});
						// Caption fetches never start, stop or seek the encoder. Wait for the
						// matching video segment; failures leave video playback independent.
						const deadline=Date.now()+15000;
						while(!job.stopped&&Date.now()<deadline){
							try{await stat(path.join(job.directory,'segment'+String(n).padStart(9,'0')+'.ts'));break;}catch{}
							await new Promise(r=>setTimeout(r,150));
						}
						let text='';try{text=await readFile(path.join(job.directory,`captions-${track}.vtt`),'utf8');}catch{}
						return Buffer.from(captionSlice(text,n));
					}
					const match=/^segment(\d+)\.ts$/.exec(file);if(!match)throw Object.assign(Error('Invalid stream resource.'),{status:400});
						const result=job.queue.then(()=>chunk(Number(match[1]))).then(bytes=>{
							// Prepare only the next window, after video has started. Its captions
							// are ready before playback crosses the encoder's window boundary.
							const next=(job.start*4)+captionSeconds;
							if(windowedSubtitle&&next<duration&&!job.stopped)void captionWindow(next).catch(()=>{});
							return bytes;
						});job.queue=result.catch(()=>{});return result;}};
		}catch(error){await stop();throw fail(error.status?error.message:'This streamed title could not be prepared. Please try again.');}
	}
	return {start};
}
