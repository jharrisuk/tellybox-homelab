import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {deviceProfile,wantsSubtitleLookup,srtToVtt} from '../playback-profile.mjs';
import {subtitleChoice} from '../subtitle-choice.mjs';

test('direct profiles respect quality limits and only advertise supported native containers',()=>{
	assert.equal(deviceProfile(false,8000000,true).MaxStaticBitrate,8000000);
	assert.match(deviceProfile(false,8000000,true).DirectPlayProfiles[0].Container,/mkv/);
	assert.doesNotMatch(deviceProfile(false,8000000).DirectPlayProfiles[0].Container,/mkv/);
	assert.deepEqual(deviceProfile(true,8000000,true).DirectPlayProfiles,[]);
	assert.equal(wantsSubtitleLookup({subtitleIndex:-1,preferEnglishSubtitles:true}),false);
	assert.equal(wantsSubtitleLookup({preferEnglishSubtitles:true}),true);
	assert.equal(subtitleChoice({preferEnglishSubtitles:true},[{Type:'Subtitle',Language:'eng',Index:2}]),2);
	assert.match(srtToVtt('1\n00:00:01,000 --> 00:00:03,000\nHello\n'),/^WEBVTT\n\n1\n00:00:01\.000/);
});

test('text captions load separately, keep video direct, use session ownership and expire on stop',async t=>{
	const dir=await mkdtemp(path.join(os.tmpdir(),'tellybox-caption-route-'));
	t.after(()=>rm(dir,{recursive:true,force:true}));
	await writeFile(path.join(dir,'connection.json'),JSON.stringify({userId:'test',token:'private-jelly-token'}));
	const id='a'.repeat(32),requests=[];
	const item={Id:id,Type:'Episode',Name:'Caption fixture',MediaSources:[{Id:'source',Container:'mp4',RunTimeTicks:60e7,MediaStreams:[{Type:'Video',Codec:'h264',Index:0},{Type:'Subtitle',Codec:'DVBSUB',Language:'eng',Index:1},{Type:'Subtitle',Codec:'subrip',Language:'eng',Index:2}]}]};
	let captionReads=0;
	const jelly=express();jelly.use(express.json());
	jelly.get('/Users/test/Items/:id',(req,res)=>res.json(item));
	jelly.post('/Items/:id/PlaybackInfo',(req,res)=>{requests.push(req.body);res.json({PlaySessionId:'fixture',MediaSources:[{...item.MediaSources[0],SupportsDirectPlay:true}]});});
	jelly.get(`/Videos/${id}/source/Subtitles/2/Stream.vtt`,(req,res)=>{captionReads++;assert.equal(req.get('x-emby-token'),'private-jelly-token');res.type('text/vtt').send('WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nEnglish fixture\n');});
	jelly.post('/Sessions/Playing/Stopped',(req,res)=>res.sendStatus(204));jelly.delete('/Videos/ActiveEncodings',(req,res)=>res.sendStatus(204));
	const servers=[];const listen=app=>new Promise(resolve=>{const server=app.listen(0,'127.0.0.1',()=>{servers.push(server);resolve(server);});});
	t.after(()=>{for(const server of servers){server.closeAllConnections();server.close();}});
	const upstream=await listen(jelly),front=express(),local=await listen(front),base=`http://127.0.0.1:${local.address().port}`;
	Object.assign(process.env,{NODE_ENV:'test',PORT:String(local.address().port),JELLYFIN_URL:`http://127.0.0.1:${upstream.address().port}`,DATA_DIR:dir,AUTH_DIR:dir,LOCAL_HOSTS:'127.0.0.1',LOCAL_NETWORKS:'127.0.0.0/8'});
	(await import('./enabled-fixture.mjs')).enableIntegrations();
	front.use((await import('../server.mjs')).app);
	const post=(route,body)=>fetch(base+route,{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify(body)});
	const response=await post('/api/play',{id,client:'android',textSubtitles:true,preferEnglishSubtitles:true});assert.equal(response.status,200);
	const playing=await response.json();assert.equal(playing.method,'DirectPlay');assert.equal(playing.subtitleIndex,2);assert.equal(captionReads,0);assert.equal(playing.subtitles[1].embedded,true);
	assert.equal(requests[0].SubtitleStreamIndex,-1);assert.equal(requests[0].EnableDirectPlay,true);assert.equal(requests[0].AlwaysBurnInSubtitleWhenTranscoding,false);
	assert.ok(!JSON.stringify(playing).includes('private-jelly-token'));
	const caption=playing.subtitles[1].url;
	assert.match(await(await fetch(base+caption)).text(),/English fixture/);assert.equal(captionReads,1);
	assert.equal((await fetch(base+caption,{headers:{Authorization:'Bearer invalid','X-jServer-App':'android'}})).status,401);
	const unknown=caption.replace(/[^/]+$/,Buffer.from('subtitle-99.vtt').toString('base64url'));assert.equal((await fetch(base+unknown)).status,404);
	await post('/api/sessions/'+playing.session,{action:'stop'});assert.equal((await fetch(base+caption)).status,410);
});
