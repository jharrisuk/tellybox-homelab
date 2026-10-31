import test from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtemp,mkdir,writeFile,readFile,rm} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import {subtitleIdentity,downloadedSubtitleIndex} from '../subtitle-lookup.mjs';

test('local playback exposes cached English captions, burns them on request and preserves Off and private streaming',{skip:spawnSync('ffmpeg',['-version']).status!==0,timeout:60000},async t=>{
	const dir=await mkdtemp(path.join(os.tmpdir(),'local-captions-'));t.after(()=>rm(dir,{recursive:true,force:true}));
	const file=path.join(dir,'sample.mkv');
	assert.equal(spawnSync('ffmpeg',['-v','error','-f','lavfi','-i','color=black:s=640x360:r=25','-f','lavfi','-i','anullsrc=r=48000:cl=stereo','-c:v','libx264','-preset','ultrafast','-c:a','aac','-t','8',file],{timeout:20000}).status,0);
	const bytes=await readFile(file),id='a'.repeat(32),item={Id:id,Type:'Movie',Name:'Sample',ProviderIds:{Imdb:'tt123'},RunTimeTicks:8e7,Path:'/video/sample.mkv',MediaSources:[{Id:'source',RunTimeTicks:8e7,MediaStreams:[{Type:'Video',Index:0},{Type:'Audio',Index:1,Language:'eng'}]}]};
	const cache=path.join(dir,'subtitle-cache');await mkdir(cache);const key=createHash('sha256').update(JSON.stringify({identity:subtitleIdentity(item),release:'sample',fingerprint:id+':source',duration:8})).digest('hex');
	await writeFile(path.join(cache,key+'.srt'),'1\n00:00:00,000 --> 00:00:07,000\nLOCAL ENGLISH CAPTION\n');await writeFile(path.join(dir,'opensubtitles.json'),JSON.stringify({key:'synthetic-key',enabled:true}));await writeFile(path.join(dir,'connection.json'),JSON.stringify({userId:'test',token:'synthetic-jelly-token'}));
	const jelly=express();jelly.use(express.json());jelly.get('/Users/test/Items/:id',(req,res)=>res.json(item));
	jelly.get('/Videos/:id/stream',(req,res)=>{
		assert.equal(req.headers['x-emby-token'],'synthetic-jelly-token');assert.equal(req.query.MediaSourceId,'source');
		const parts=req.headers.range?.match(/^bytes=(\d+)-(\d*)$/),first=parts?Number(parts[1]):0,last=parts&&parts[2]?Math.min(bytes.length-1,Number(parts[2])):bytes.length-1;
		if(parts)res.status(206).set('Content-Range',`bytes ${first}-${last}/${bytes.length}`);res.set('Accept-Ranges','bytes').type('video/x-matroska').send(bytes.subarray(first,last+1));
	});
	const selected=[];jelly.post('/Items/:id/PlaybackInfo',(req,res)=>{selected.push(req.body.SubtitleStreamIndex);res.json({PlaySessionId:'test',MediaSources:[{...item.MediaSources[0],TranscodingUrl:`/Videos/${id}/master.m3u8`}]});});
	jelly.post('/Sessions/Playing/Stopped',(req,res)=>res.sendStatus(204));jelly.delete('/Videos/ActiveEncodings',(req,res)=>res.sendStatus(204));
	const listen=app=>new Promise(resolve=>{const server=app.listen(0,'127.0.0.1',()=>resolve(server));});
	const upstream=await listen(jelly),front=express(),local=await listen(front);t.after(()=>{for(const server of [upstream,local]){server.closeAllConnections();server.close();}});
	Object.assign(process.env,{NODE_ENV:'test',PORT:String(local.address().port),JELLYFIN_URL:`http://127.0.0.1:${upstream.address().port}`,DATA_DIR:dir,AUTH_DIR:dir,LOCAL_HOSTS:'127.0.0.1',LOCAL_NETWORKS:'127.0.0.0/8'});
	(await import('./enabled-fixture.mjs')).enableIntegrations();
	front.use((await import('../server.mjs')).app);const base=`http://127.0.0.1:${local.address().port}`;
	const post=(route,body)=>fetch(base+route,{method:'POST',headers:{'Content-Type':'application/json',Origin:base},body:JSON.stringify(body)});
	const off=await(await post('/api/play',{id,subtitleIndex:-1,preferEnglishSubtitles:true})).json();assert.equal(off.subtitleIndex,-1);assert.equal(off.subtitles[0].index,downloadedSubtitleIndex);assert.deepEqual(selected,[-1]);await post('/api/sessions/'+off.session,{action:'stop'});
	const response=await post('/api/play',{id,preferEnglishSubtitles:true});assert.equal(response.status,200);const playing=await response.json();assert.equal(playing.subtitleIndex,downloadedSubtitleIndex);assert.equal(playing.method,'Transcode');assert.ok(!JSON.stringify(playing).includes('synthetic'));
	try{
		const manifest=await(await fetch(base+playing.url)).text(),segment=manifest.split('\n').find(line=>line.startsWith('/stream/'));
		assert.ok(segment);const data=Buffer.from(await(await fetch(base+segment)).arrayBuffer());
		const frame=spawnSync('ffmpeg',['-v','error','-i','pipe:0','-frames:v','1','-f','rawvideo','-pix_fmt','gray','pipe:1'],{input:data,timeout:15000,maxBuffer:1024*1024});assert.equal(frame.status,0,String(frame.stderr));assert.ok([...frame.stdout].filter(v=>v>150).length>100);
	}finally{await post('/api/sessions/'+playing.session,{action:'stop'});}
});
