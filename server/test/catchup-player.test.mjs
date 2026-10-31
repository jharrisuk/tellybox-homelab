import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createCatchupPlayer,catchupManifest,catchupTimeline} from '../catchup-player.mjs';

const base=Date.parse('2026-10-30T12:00:00Z'),item={StartDate:new Date(base).toISOString(),EndDate:new Date(base+600000).toISOString()};
const channel={id:'01234567-0123-0123-0123-012345678901'};
test('catch-up has a stable, growing programme timeline and never advertises future media',()=>{
	const earlier=catchupManifest(item,base+100000),later=catchupManifest(item,base+140000),ended=catchupManifest(item,base+700000);
	assert.match(earlier,/#EXT-X-MEDIA-SEQUENCE:0/);assert.match(earlier,/segment000000000.ts/);assert.match(later,/segment000000000.ts/);
	assert.equal((earlier.match(/#EXTINF/g)||[]).length,25);assert.equal((later.match(/#EXTINF/g)||[]).length,35);
	assert.doesNotMatch(earlier,/#EXT-X-ENDLIST/);assert.match(ended,/#EXT-X-ENDLIST/);assert.equal(catchupTimeline(item,base+100000).duration,600);
	const partial={...item,EndDate:new Date(base+601000).toISOString()};assert.equal(catchupTimeline(partial,base+601001).available,601);assert.match(catchupManifest(partial,base+601001),/#EXTINF:1.000,/);
	assert.throws(()=>catchupTimeline({...item,StartDate:'bad'},base));assert.throws(()=>catchupTimeline({...item,EndDate:new Date(base+9*3600000).toISOString()},base+100000));
});
test('metadata does not open a provider; invalid paths and future seeks cannot open one',async()=>{
	let opens=0;const service=createCatchupPlayer({clock:()=>base+100000,openArchive:async()=>{opens++;throw Error('unexpected');},maxSessions:1});
	const session=await service.start(channel,item);
	try{await session.read('index.m3u8');assert.equal(opens,0);await assert.rejects(session.read('../private'));await assert.rejects(session.read('segment000000030.ts'));assert.equal(opens,0);await assert.rejects(service.start(channel,item),/Stop another/);}
	finally{await session.stop();}await assert.rejects(session.read('index.m3u8'),/expired/);
});
const ffmpeg=spawnSync('ffmpeg',['-version']).status===0;
test('real archive encoding seeks forwards and backwards without reading from the programme beginning',{skip:!ffmpeg,timeout:120000},async()=>{
	const sample=spawnSync('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=s=160x90:r=25','-f','lavfi','-i','anullsrc=r=48000:cl=stereo','-c:v','libx264','-preset','ultrafast','-c:a','aac','-g','100','-t','180','-f','mpegts','pipe:1'],{maxBuffer:32*1024*1024,timeout:20000});assert.equal(sample.status,0,String(sample.stderr));
	const opens=[],closed=[];
	const service=createCatchupPlayer({clock:()=>base+700000,openArchive:async(id,start,minutes)=>{
		assert.equal(closed.length,opens.length,'Previous provider session must close before another opens');
		const index=opens.length;opens.push({id,start,minutes});return {open:async()=>new Response(sample.stdout),stop:async()=>{await new Promise(resolve=>setTimeout(resolve,25));closed.push(index);}};
	}});
	const session=await service.start(channel,item);
	try{
		const times=[];
		for(const n of [0,29,30,75,5]){
			const bytes=await session.read('segment'+String(n).padStart(9,'0')+'.ts');assert.ok(bytes.length>100);
			const info=spawnSync('ffprobe',['-v','error','-show_format','-of','json','pipe:0'],{input:bytes,timeout:10000});assert.equal(info.status,0,String(info.stderr));times.push(Number(JSON.parse(info.stdout).format.start_time));
		}
		assert.deepEqual(opens.map(o=>(Date.parse(o.start)-base)/1000),[0,120,300,0]);assert.ok(opens.every(o=>o.minutes<=3));
		for(const [index,offset] of [0,116,120,300,20].entries())assert.ok(Math.abs(times[index]-times[0]-offset)<.1,JSON.stringify(times));
	}finally{await session.stop();}
	assert.equal(new Set(closed).size,opens.length);assert.equal(closed.length,opens.length);
});
