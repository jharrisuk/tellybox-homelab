import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {createRemoteControls} from '../remote-controls.mjs';
import {createAccountLimits} from '../account-limits.mjs';
const person='a'.repeat(32),device='b'.repeat(32),key='person:'+person;
function folder(t){const dir=mkdtempSync(path.join(os.tmpdir(),'remote-controls-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));return dir;}

test('remote switches persist, distinguish sources, exempt trusted home and include guests/admins',t=>{
	const dir=folder(t),p=createRemoteControls(dir);
	assert.deepEqual(p.status(),{enabled:true,vod:true,nonstop:true});
	assert.throws(()=>p.set({enabled:'false',vod:true,nonstop:true}),e=>e.status===400);
	p.set({enabled:true,vod:false,nonstop:false});
	for(const id of ['dispatch-movie-42','dispatch-episode-13-5'])assert.throws(()=>p.guard({},{itemId:id}),/only at home/);
	assert.throws(()=>p.guard({},{itemId:'dispatch-live-channel',nonstop:true}),/24\/7/);
	for(const id of ['abc','dispatch-recording-4','catchup-123','dispatch-live-channel'])assert.equal(p.allowed({},{itemId:id}),true);
	p.set({enabled:false,vod:false,nonstop:false});
	for(const viewer of [{},{personId:person},{deviceId:device},{shareId:'x'},{role:'admin'}])assert.equal(p.allowed(viewer),false);
	for(const viewer of [{local:true},{home:true}])assert.equal(p.allowed(viewer,{nonstop:true,itemId:'dispatch-movie-1'}),true);
	assert.equal(createRemoteControls(dir).status().enabled,false);
	p.set({enabled:true,vod:true,nonstop:true});assert.equal(p.allowed({},{nonstop:true}),true);
});

test('daily allowance combines web and linked apps; manual reset, daily reset and restarts are independent',t=>{
	let now=Date.parse('2026-10-27T12:00Z');const dir=folder(t);const limits=createAccountLimits(dir,{clock:()=>now});
	limits.set(key,{minutes:10,dailyMinutes:1,downloads:false});
	for(const [id,v] of [['web',{personId:person}],['phone',{personId:person,deviceId:device}],['tv',{personId:person,deviceId:'c'.repeat(32)}]])limits.media(id,v);
	for(let i=0;i<4;i++){now+=5000;limits.tick();for(const id of ['web','phone','tv'])limits.heartbeat(id,true);}
	assert.equal(limits.status(key).dailySeconds,60);assert.equal(limits.status(key).seconds,60);
	assert.throws(()=>limits.guard({personId:person}),/midnight UK/);assert.equal(limits.allowed({personId:person,home:true}),true);
	assert.equal(createAccountLimits(dir,{clock:()=>now}).allowed({personId:person}),false);
	limits.set(key,{minutes:10,downloads:false,reset:true});assert.equal(limits.status(key).seconds,0);assert.equal(limits.status(key).dailySeconds,60);
	limits.set(key,{minutes:10,downloads:false,resetDaily:true});assert.equal(limits.status(key).dailySeconds,0);assert.equal(limits.status(key).dailyMinutes,1);
	for(const id of ['web','phone','tv'])limits.heartbeat(id,false);now+=5000;limits.tick();assert.equal(limits.status(key).dailySeconds,0);
	assert.throws(()=>limits.set(key,{minutes:0,downloads:false,dailyMinutes:1441}),e=>e.status===400);
	assert.throws(()=>limits.set(key,{minutes:0,downloads:false,dailyMinutes:1.5}),e=>e.status===400);
});

test('daily reset follows UK midnight in summer and winter including a playing stream crossing midnight',t=>{
	for(const midnight of ['2026-07-01T23:00:00Z','2026-10-27T00:00:00Z']){
		let now=Date.parse(midnight)-2500;const limits=createAccountLimits(folder(t),{clock:()=>now});
		limits.set(key,{minutes:10,dailyMinutes:1,downloads:true});limits.media('stream',{personId:person});now+=5000;limits.tick();
		assert.equal(limits.status(key).seconds,5);assert.equal(limits.status(key).dailySeconds,2.5);
		limits.heartbeat('stream',false);now+=86400000;limits.tick();assert.equal(limits.status(key).dailySeconds,0);assert.equal(limits.status(key).seconds,5);
	}
});

test('daily reset survives DST changes and an existing manual-only record is preserved',t=>{
	const dir=folder(t);writeFileSync(path.join(dir,'account-limits.json'),JSON.stringify({accounts:{[key]:{minutes:60,seconds:55,downloads:true}}}));
	let now=Date.parse('2026-10-25T00:59:55Z');const limits=createAccountLimits(dir,{clock:()=>now});
	assert.equal(limits.status(key).seconds,55);assert.equal(limits.status(key).dailyMinutes,0);
	limits.media('s',{personId:person});now+=10000;limits.tick();assert.equal(limits.status(key).dailySeconds,5);
	now=Date.parse('2026-10-25T23:59:59Z');assert.equal(limits.status(key).dailySeconds,5);now+=1000;assert.equal(limits.status(key).dailySeconds,0);
});

test('active device account resolution follows an admin link change and home media stops charging',t=>{
	let now=100000,linked=false;const limits=createAccountLimits(folder(t),{clock:()=>now,resolveViewer:v=>v.deviceId&&linked?{...v,personId:person}:v});
	limits.media('tv',{deviceId:device});now+=5000;limits.tick();assert.equal(limits.status('device:'+device).seconds,5);
	linked=true;now+=5000;limits.tick();assert.equal(limits.status(key).seconds,5);
	limits.media('tv',{deviceId:device,local:true});now+=5000;limits.tick();assert.equal(limits.status(key).seconds,5);
});

test('live HTTP controls protect writes, stop existing remote streams, block VOD/24-7 before opening and leave home working',{timeout:20000},async t=>{
	const dir=folder(t),servers=[],id='1'.repeat(32),uuid='11111111-1111-1111-1111-111111111111';
	const listen=async handler=>{const s=http.createServer(handler);await new Promise(resolve=>s.listen(0,'127.0.0.1',resolve));servers.push(s);return s;};
	t.after(()=>{for(const s of servers){s.closeAllConnections();s.close();}});
	let port;
	const upstream=await listen((req,res)=>{
		if(req.url==='/output/m3u')return res.end('#EXTM3U\n#EXTINF:-1 group-title="24/7",Always on\nhttp://127.0.0.1:'+port+'/proxy/ts/stream/'+uuid+'\n');
		if(req.url.startsWith('/Users/'))return res.end(JSON.stringify({Id:id,Name:'Fixture',Type:'Movie',RunTimeTicks:600000000,MediaSources:[{Id:'source'}]}));
		if(req.url.includes('/PlaybackInfo'))return res.end(JSON.stringify({PlaySessionId:'fixture',MediaSources:[{Id:'source',TranscodingUrl:`/Videos/${id}/master.m3u8`,MediaStreams:[]}]}));
		if(req.url.endsWith('master.m3u8'))return res.setHeader('Content-Type','application/vnd.apple.mpegurl'),res.end('#EXTM3U\n#EXTINF:6,\ncontinuous.ts\n');
		if(req.url.endsWith('continuous.ts')){res.setHeader('Content-Type','video/mp2t');res.write('first');const timer=setInterval(()=>res.write('more'),30);res.on('close',()=>clearInterval(timer));return;}
		res.writeHead(204);res.end();
	});port=upstream.address().port;
	const local=await listen(),remote=await listen();
	Object.assign(process.env,{NODE_ENV:'test',PORT:String(local.address().port),AUTH_DIR:dir,DATA_DIR:dir,JELLYFIN_URL:`http://127.0.0.1:${port}`,DISPATCHARR_URL:`http://127.0.0.1:${port}`,LOCAL_HOSTS:'127.0.0.1',LOCAL_NETWORKS:'127.0.0.0/8',PUBLIC_ORIGIN:'https://remote.test'});
	writeFileSync(path.join(dir,'connection.json'),JSON.stringify({userId:'test',token:'fixture-only'}));
	(await import('./enabled-fixture.mjs')).enableIntegrations();
	const {app}=await import('../server.mjs');local.on('request',app);remote.on('request',app);
	const base=side=>`http://127.0.0.1:${(side==='local'?local:remote).address().port}`;
	const request=(side,route,body,token,extra={})=>fetch(base(side)+route,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json',Origin:base(side),...(token?{Authorization:'Bearer '+token}:{}),...extra},body:body===undefined?undefined:JSON.stringify(body)});
	const device=await(await request('local','/api/apps/enroll',{name:'Phone'})).json();assert.ok(device.token);
	assert.equal((await request('remote','/api/remote-controls')).status,403);
	for(const side of ['local','remote'])for(const body of [undefined,{enabled:false,vod:false,nonstop:false}])assert.equal((await request(side,'/api/remote-controls',body,device.token)).status,403);
	assert.equal((await request('local','/api/remote-controls',{enabled:false,vod:false,nonstop:false},null,{Origin:'https://evil.test'})).status,403);
	const play=await(await request('remote','/api/play',{id},device.token)).json();assert.ok(play.session);
	const manifest=await(await request('remote',play.url,undefined,device.token)).text();const segment=manifest.split('\n').find(x=>x.startsWith('/stream/'));
	const stream=await request('remote',segment,undefined,device.token),reader=stream.body.getReader();assert.equal((await reader.read()).done,false);
	await request('local','/api/remote-controls',{enabled:false,vod:true,nonstop:true});
	await Promise.race([(async()=>{try{while(!(await reader.read()).done){}}catch{}})(),new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error('Active stream not stopped')),4000);timer.unref();})]);
	assert.equal((await request('remote','/api/play',{id},device.token)).status,403);
	assert.equal((await request('remote','/api/downloads/status',undefined,device.token)).status,403);
	assert.equal((await request('local','/api/remote-controls')).status,200);
	const home=await(await request('local','/api/play',{id})).json();assert.ok(home.session);
	const ticket=await(await request('local','/api/sessions/'+home.session+'/cast',{})).json();assert.ok(ticket.url);
	assert.equal((await request('remote',new URL(ticket.url).pathname)).status,403);
	assert.equal((await request('local',new URL(ticket.url).pathname)).status,200);
	await request('local','/api/sessions/'+home.session,{action:'stop'});
	await request('local','/api/remote-controls',{enabled:true,vod:false,nonstop:false});
	for(const blocked of ['dispatch-movie-12','dispatch-episode-12-3','dispatch-live-'+uuid]){
		const response=await request('remote','/api/play',{id:blocked},device.token);assert.equal(response.status,403,await response.text());
	}
	const resumed=await(await request('remote','/api/play',{id},device.token)).json();assert.ok(resumed.session);await request('remote','/api/sessions/'+resumed.session,{action:'stop'},device.token);
});
