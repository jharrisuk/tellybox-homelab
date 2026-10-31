import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createVodPlayer} from '../vod-player.mjs';
import {downloadedSubtitleIndex} from '../subtitle-lookup.mjs';

const available=spawnSync('ffmpeg',['-version']).status===0;
test('actual VOD encoding renders external and embedded English captions after seeking and honours Off',{skip:!available,timeout:120000},async t=>{
	const dir=await mkdtemp(path.join(os.tmpdir(),'vod-captions-'));t.after(()=>rm(dir,{recursive:true,force:true}));
	const subtitle=path.join(dir,'captions.srt');await writeFile(subtitle,'1\n00:00:04,000 --> 00:00:11,000\nENGLISH AFTER SEEK\n\n2\n00:00:36,000 --> 00:00:43,000\nENGLISH NEXT WINDOW\n\n3\n00:02:04,000 --> 00:02:11,000\nENGLISH LATER SEEK\n');
	const file=path.join(dir,'video.mkv');
	const built=spawnSync('ffmpeg',['-v','error','-f','lavfi','-i','color=black:s=640x360:r=25','-f','lavfi','-i','anullsrc=r=48000:cl=stereo','-i',subtitle,'-map','0:v','-map','1:a','-map','2:s','-metadata:s:s:0','language=eng','-c:v','libx264','-preset','ultrafast','-c:a','aac','-c:s','srt','-g','25','-t','152',file],{timeout:20000});assert.equal(built.status,0,String(built.stderr));
	const bytes=await readFile(file);
	const player=createVodPlayer({open:async(source,{range})=>{
		const parts=range?.match(/^bytes=(\d+)-(\d*)$/);const first=parts?Number(parts[1]):0,last=parts&&parts[2]?Math.min(bytes.length-1,Number(parts[2])):bytes.length-1;
		return new Response(bytes.subarray(first,last+1),{status:parts?206:200,headers:{'Content-Type':'video/x-matroska','Content-Length':String(last-first+1),'Accept-Ranges':'bytes',...(parts?{'Content-Range':`bytes ${first}-${last}/${bytes.length}`}:{})}});
	}});
	for(const mode of ['external','embedded','off','native']){
		let lookups=0;
		const options={textSubtitles:mode==='native',preferEnglishSubtitles:true,lookupSubtitles:async()=>{lookups++;throw Error('English is already embedded');},...(mode==='external'?{externalSubtitle:{file:subtitle,index:downloadedSubtitleIndex,label:'English'},subtitleIndex:downloadedSubtitleIndex}:mode==='off'?{subtitleIndex:-1}:{})};
		const session=await player.start({type:'movie',uuid:'test'},options);
		try{
			assert.equal(lookups,0);assert.equal(session.subtitleIndex,mode==='external'?downloadedSubtitleIndex:mode==='off'?-1:2);
			for(const number of ['embedded','native'].includes(mode)?[1,9,31]:[1]){
				const segment=await session.read('segment'+String(number).padStart(9,'0')+'.ts');assert.ok(segment.length>100);
				if(mode==='native'){const captions=(await session.read(`caption-2-${number}.vtt`)).toString();assert.match(captions,/ENGLISH/);assert.match((await session.read('index.m3u8')).toString(),/TYPE=SUBTITLES/);}
				const frame=spawnSync('ffmpeg',['-v','error','-i','pipe:0','-frames:v','1','-f','rawvideo','-pix_fmt','gray','pipe:1'],{input:segment,timeout:15000,maxBuffer:1024*1024});assert.equal(frame.status,0,String(frame.stderr));
				const bright=[...frame.stdout].filter(value=>value>150).length;
				assert.ok(['off','native'].includes(mode)?bright<10:bright>100,mode+' caption pixels '+bright);
			}
		}finally{await session.stop();}
	}
});
