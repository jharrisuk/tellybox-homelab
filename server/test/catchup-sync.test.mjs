import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createCatchupPlayer} from '../catchup-player.mjs';

const ffmpeg=spawnSync('ffmpeg',['-version']).status===0&&spawnSync('ffprobe',['-version']).status===0;
const base=Date.parse('2026-10-30T12:00:00Z'),channel={id:'01234567-0123-0123-0123-012345678901'};
function run(command,args,options={}) {
	const result=spawnSync(command,args,{maxBuffer:64*1024*1024,timeout:30000,...options});
	assert.equal(result.status,0,`${command}: ${result.error||result.stderr}`);
	return result.stdout;
}
function probe(file,selection,entries) {
	return JSON.parse(run('ffprobe',['-v','error','-read_intervals','%+4','-select_streams',selection,'-show_frames','-show_entries',entries,'-of','json',file]));
}
// Measure the visible flash and audible tone, rather than merely the muxer's stream start.
function markers(file) {
	const video=probe(file,'v:0','frame=best_effort_timestamp_time').frames;
	const pixels=run('ffmpeg',['-v','error','-i',file,'-t','4','-map','0:v:0','-an','-vf','scale=1:1,format=gray','-fps_mode','passthrough','-f','rawvideo','pipe:1']);
	const flash=pixels.findIndex(value=>value>200);
	assert.ok(flash>=0&&flash<video.length,'Decoded video must contain the white flash');
	const audio=probe(file,'a:0','frame=best_effort_timestamp_time').frames;
	const pcm=run('ffmpeg',['-v','error','-i',file,'-t','4','-map','0:a:0','-vn','-ac','1','-ar','48000','-f','f32le','pipe:1']);
	let sound=-1;
	for(let index=0;index<pcm.length/4;index++)if(Math.abs(pcm.readFloatLE(index*4))>.25){sound=index;break;}
	assert.ok(sound>=0&&audio.length>0,'Decoded audio must contain the audible tone');
	return {video:Number(video[flash].best_effort_timestamp_time),audio:Number(audio[0].best_effort_timestamp_time)+sound/48000};
}

test('continuous catchup preserves audible A/V alignment and content across the old two-minute boundary',{skip:!ffmpeg,timeout:120000},async()=>{
	const directory=await mkdtemp(path.join(os.tmpdir(),'tellybox-catchup-sync-test-'));
	let session;
	try {
		const videoPulse=[2,118,122,126].map(time=>`between(t,${time},${time+.12})`).join('+');
		const audioPulse=[1.36,117.36,121.36,125.36].map(time=>`between(t,${time},${time+.08})`).join('+');
		const sample=run('ffmpeg',['-v','error','-f','lavfi','-i',`color=c=black:s=160x90:r=25,drawbox=x=0:y=0:w=iw:h=ih:color=white:t=fill:enable='${videoPulse}'`,
			'-itsoffset','0.64','-f','lavfi','-i',`aevalsrc='if(${audioPulse},0.8*sin(2*PI*1000*t),0)':s=48000`,
			'-c:v','libx264','-preset','ultrafast','-threads','2','-g','100','-c:a','aac','-t','132','-f','mpegts','pipe:1']);
		const source=path.join(directory,'fixture.ts');await writeFile(source,sample);
		const streams=JSON.parse(run('ffprobe',['-v','error','-show_streams','-of','json',source])).streams;
		const offset=Number(streams.find(stream=>stream.codec_type==='audio').start_time)-Number(streams.find(stream=>stream.codec_type==='video').start_time);
		assert.ok(offset>.5&&offset<.8,'Fixture must genuinely have delayed audio stream PTS');
		const original=markers(source);
		assert.ok(Math.abs(original.audio-original.video)<.12,`Fixture tone/flash are aligned: ${JSON.stringify(original)}`);
		const opens=[],stops=[];
		const service=createCatchupPlayer({paceInput:false,clock:()=>base+200000,openArchive:async(id,start,minutes)=>{
			const index=opens.length;opens.push({id,start,minutes});
			return {open:async()=>new Response(sample),stop:async()=>{stops.push(index);}};
		}});
		session=await service.start(channel,{StartDate:new Date(base).toISOString(),EndDate:new Date(base+132000).toISOString()});
		const captured=new Map();
		for(let index=0;index<=31;index++) {
			const bytes=await session.read('segment'+String(index).padStart(9,'0')+'.ts');
			if([0,29,30,31].includes(index)) {
				const file=path.join(directory,`output-${index}.ts`);await writeFile(file,bytes);captured.set(index,file);
			}
		}
		let first;
		for(const [index,file] of captured) {
			const measured=markers(file);
			assert.ok(Math.abs(measured.audio-measured.video)<.12,`Segment ${index}: audible tone/visible flash drifted: ${JSON.stringify(measured)}`);
			if(first===undefined)first=measured.video;
			assert.ok(Math.abs(measured.video-first-index*4)<.12,`Segment ${index}: content jumped or repeated at a window boundary`);
		}
		assert.equal(opens.length,1,'Sequential viewing must not reopen the provider at120seconds');
		assert.equal(opens[0].start,new Date(base).toISOString());
		assert.ok(opens[0].minutes>=3,'Archive request covers the whole remaining programme');
		await session.stop();session=null;
		assert.deepEqual(stops,[0],'Provider session is released exactly once');
	} finally {
		await session?.stop();await rm(directory,{recursive:true,force:true});
	}
});

test('paced catchup keeps its provider after45seconds, bounds cached segments and reopens an evicted seek',{skip:!ffmpeg,timeout:90000},async()=>{
	const sample=run('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=s=160x90:r=25','-f','lavfi','-i','anullsrc=r=48000:cl=stereo',
		'-c:v','libx264','-preset','ultrafast','-threads','2','-g','100','-c:a','aac','-t','76','-f','mpegts','pipe:1']);
	let opens=0,stops=0;const signals=[];
	const service=createCatchupPlayer({cacheSegments:4,clock:()=>base+80000,openArchive:async()=>{
		opens++;return {open:async signal=>{signals.push(signal);return new Response(sample);},stop:async()=>{stops++;}};
	}});
	const session=await service.start(channel,{StartDate:new Date(base).toISOString(),EndDate:new Date(base+76000).toISOString()});
	try {
		const started=Date.now();
		for(let n=0;n<=17;n++)await session.read('segment'+String(n).padStart(9,'0')+'.ts');
		assert.ok(Date.now()-started>=45000,'Production pacing must exercise the old45-second lifetime timeout');
		assert.equal(opens,1,'Normal playback keeps the original archive open beyond45seconds');
		assert.equal(signals[0].aborted,false,'A successful stream must not hit a lifetime abort timer');
		await session.read('segment000000000.ts');
		assert.equal(opens,2,'An evicted backward seek opens a fresh run rather than hanging');
		assert.ok(stops>=1,'Seeking releases the previous provider');
	} finally {await session.stop();}
	assert.equal(stops,opens,'All provider sessions are released exactly once');
});
