import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const digest=value=>createHash('sha256').update(value).digest('hex');

test('remote screens, admin quota truthfulness, failed preparation and quota stream stop',{timeout:30000},async t=>{
	const directory=mkdtempSync(path.join(os.tmpdir(),'remote-sessions-')),servers=[];
	const id='1'.repeat(32),quotaItem='2'.repeat(32),quotaId='d'.repeat(32),adminId='e'.repeat(32);
	const quotaToken='f'.repeat(64),adminToken='e'.repeat(64),now=Date.now();
	t.after(()=>{rmSync(directory,{recursive:true,force:true});for(const server of servers){server.closeAllConnections();server.close();}});
	const listen=async handler=>{const server=http.createServer(handler);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));servers.push(server);return server;};
	const upstream=await listen((req,res)=>{
		if(req.url.startsWith('/Users/'))return res.end(JSON.stringify({Id:req.url.includes(quotaItem)?quotaItem:id,Name:'Fixture',Type:'Movie',RunTimeTicks:600000000,MediaSources:[{Id:'source'}]}));
		if(req.url.includes('/PlaybackInfo')){const item=req.url.match(/\/Items\/([a-f0-9-]+)\/PlaybackInfo/)?.[1]||id;return res.end(JSON.stringify({PlaySessionId:'fixture',MediaSources:[{Id:'source',Container:'mp4',TranscodingUrl:`/Videos/${item}/master.m3u8`,MediaStreams:[]}]}));}
		if(req.url.endsWith('master.m3u8'))return res.setHeader('Content-Type','application/vnd.apple.mpegurl'),res.end('#EXTM3U\n#EXTINF:6,\nfirst.ts\n');
		if(req.url.endsWith('first.ts')){res.setHeader('Content-Type','video/mp2t');res.write('first');const timer=setInterval(()=>res.write('more'),30);res.on('close',()=>clearInterval(timer));return;}
		res.writeHead(204);res.end();
	});
	const local=await listen(),remote=await listen();
	Object.assign(process.env,{NODE_ENV:'test',PORT:String(local.address().port),AUTH_DIR:directory,DATA_DIR:directory,
		JELLYFIN_URL:`http://127.0.0.1:${upstream.address().port}`,DISPATCHARR_URL:`http://127.0.0.1:${upstream.address().port}`,
		LOCAL_HOSTS:'127.0.0.1',LOCAL_NETWORKS:'127.0.0.0/8',PUBLIC_ORIGIN:'https://remote.test'});
	writeFileSync(path.join(directory,'connection.json'),JSON.stringify({userId:'test',token:'fixture-only'}));
	(await import('./enabled-fixture.mjs')).enableIntegrations();
	const appRecord=(deviceId,name,role)=>({id:deviceId,name,status:'approved',role,created:now,approved:now,expires:now+3600000});
	writeFileSync(path.join(directory,'apps.json'),JSON.stringify({
		[digest(quotaToken)]:appRecord(quotaId,'Quota phone','viewer'),
		[digest(adminToken)]:appRecord(adminId,'Admin phone','admin')
	}));
	writeFileSync(path.join(directory,'account-limits.json'),JSON.stringify({accounts:{
		['device:'+quotaId]:{minutes:1,seconds:59,downloads:true,dailyMinutes:0,dailySeconds:0,maxSessions:0},
		['device:'+adminId]:{minutes:1,seconds:60,downloads:true,dailyMinutes:0,dailySeconds:0,maxSessions:1}
	}}));
	const {app}=await import('../server.mjs');
	local.on('request',app);remote.on('request',app);
	const base=side=>`http://127.0.0.1:${(side==='local'?local:remote).address().port}`;
	const request=(side,route,body,token)=>fetch(base(side)+route,{method:body===undefined?'GET':'POST',
		headers:{'Content-Type':'application/json',Origin:base(side),...(token?{Authorization:'Bearer '+token}:{})},
		body:body===undefined?undefined:JSON.stringify(body)});

	// A full minute quota still applies to admins; only screen concurrency is exempt.
	const adminDenied=await request('remote','/api/play',{id},adminToken);
	assert.equal(adminDenied.status,403);
	assert.equal((await adminDenied.json()).code,'VIEWING_LIMIT');
	const adminStatus=await(await request('remote','/api/viewing-status',undefined,adminToken)).json();
	assert.equal(adminStatus.blocked,true);
	assert.equal(adminStatus.remainingSeconds,0);
	assert.equal(adminStatus.code,'VIEWING_LIMIT');
	const resetAdmin=await request('local','/api/account-limits/device:'+adminId,{minutes:0,downloads:true,maxSessions:1,reset:true});
	assert.equal(resetAdmin.status,200,await resetAdmin.text());
	const adminPlays=await Promise.all([request('remote','/api/play',{id},adminToken),request('remote','/api/play',{id},adminToken)]);
	assert.deepEqual(adminPlays.map(play=>play.status).sort(),[200,200],'admin screen concurrency is exempt');
	const adminSessions=await Promise.all(adminPlays.map(play=>play.json()));
	for(const session of adminSessions)await request('remote','/api/sessions/'+session.session,{action:'stop'},adminToken);
	const adminReleased=await(await request('remote','/api/viewing-status',undefined,adminToken)).json();
	assert.equal(adminReleased.activeSessions,0);
	assert.equal(adminReleased.remainingSeconds,null);
	assert.equal(adminReleased.blocked,false);

	const device=await(await request('local','/api/apps/enroll',{name:'Phone'})).json();
	assert.ok(device.token);
	assert.equal((await request('local','/api/account-limits/device:'+device.id,{minutes:0,downloads:true,maxSessions:4})).status,400);
	const unlimited=await request('local','/api/account-limits/device:'+device.id,{minutes:0,downloads:true,maxSessions:0});
	assert.equal(unlimited.status,200,await unlimited.text());

	// Unlimited still tracks remote screens. Raising the cap later preserves
	// those screens and only rejects genuinely new playback.
	const openPlays=await Promise.all([request('remote','/api/play',{id},device.token),request('remote','/api/play',{id},device.token)]);
	assert.deepEqual(openPlays.map(play=>play.status).sort(),[200,200]);
	const openSessions=await Promise.all(openPlays.map(play=>play.json()));
	const unlimitedStatus=await(await request('remote','/api/viewing-status',undefined,device.token)).json();
	assert.equal(unlimitedStatus.maxSessions,0);
	assert.equal(unlimitedStatus.activeSessions,2,'unlimited remote screens are counted');
	const finite=await request('local','/api/account-limits/device:'+device.id,{minutes:0,downloads:true,maxSessions:1});
	assert.equal(finite.status,200,await finite.text());
	for(const session of openSessions){
		const heartbeat=await request('remote','/api/sessions/'+session.session,{action:'progress'},device.token);
		assert.equal(heartbeat.status,204,'an existing unlimited screen must survive a finite cap');
	}
	const preserved=await(await request('remote','/api/viewing-status',undefined,device.token)).json();
	assert.equal(preserved.maxSessions,1);
	assert.equal(preserved.activeSessions,2);
	const tooMany=await request('remote','/api/play',{id},device.token);
	assert.equal(tooMany.status,429);
	assert.equal((await tooMany.json()).code,'SESSION_LIMIT');
	for(const session of openSessions)await request('remote','/api/sessions/'+session.session,{action:'stop'},device.token);
	assert.equal((await(await request('remote','/api/viewing-status',undefined,device.token)).json()).activeSessions,0);

	const [first,second]=await Promise.all([request('remote','/api/play',{id},device.token),request('remote','/api/play',{id},device.token)]);
	assert.deepEqual([first.status,second.status].sort(),[200,429]);
	const accepted=first.status===200?first:second,rejected=first.status===429?first:second;
	const denial=await rejected.json();
	assert.equal(denial.code,'SESSION_LIMIT');
	assert.match(denial.error,/screen/);
	const play=await accepted.json();
	assert.ok(play.session);

	const status=await(await request('remote','/api/viewing-status',undefined,device.token)).json();
	assert.deepEqual(Object.keys(status).sort(),['activeSessions','blocked','code','maxSessions','message','remainingSeconds','resetAt']);
	assert.equal(status.maxSessions,1);
	assert.equal(status.activeSessions,1);
	assert.equal(status.remainingSeconds,null);
	assert.equal(status.resetAt,null);
	assert.equal(status.blocked,false);
	assert.equal(status.code,null);
	assert.equal(JSON.stringify(status).includes(device.id),false);

	await request('remote','/api/sessions/'+play.session,{action:'stop'},device.token);
	const released=await(await request('remote','/api/viewing-status',undefined,device.token)).json();
	assert.equal(released.activeSessions,0);
	const failed=await request('remote','/api/play',{id:'invalid'},device.token);
	assert.equal(failed.status,400);
	assert.equal((await(await request('remote','/api/viewing-status',undefined,device.token)).json()).activeSessions,0,'a failed startup must release its screen');
	const retry=await request('remote','/api/play',{id},device.token);
	assert.equal(retry.status,200);
	const resumed=await retry.json();
	await request('remote','/api/sessions/'+resumed.session,{action:'stop'},device.token);

	// A stop must never be rejected by the screen cap. This local playback has
	// no reservation; stopping it while a remote screen fills the account used
	// to return 429 before the session or upstream player was released.
	const localSession=await(await request('local','/api/play',{id},device.token)).json();
	const blockingPlay=await request('remote','/api/play',{id},device.token);
	assert.equal(blockingPlay.status,200);
	const blockingSession=await blockingPlay.json();
	assert.equal((await(await request('remote','/api/viewing-status',undefined,device.token)).json()).activeSessions,1);
	const stopWhenFull=await request('remote','/api/sessions/'+localSession.session,{action:'stop'},device.token);
	assert.equal(stopWhenFull.status,204,'stop must bypass the screen cap');
	assert.equal((await(await request('remote','/api/viewing-status',undefined,device.token)).json()).activeSessions,1);
	await request('remote','/api/sessions/'+blockingSession.session,{action:'stop'},device.token);

	assert.equal((await request('remote','/api/viewing-status')).status,401);

	// A real stream crossing the manual quota is stopped by the server sweep.
	const quotaPlay=await request('remote','/api/play',{id:quotaItem},quotaToken);
	if(quotaPlay.status!==200)assert.fail(await quotaPlay.text());
	const quotaSession=await quotaPlay.json();
	const manifest=await(await request('remote',quotaSession.url,undefined,quotaToken)).text();
	const segment=manifest.split('\n').find(line=>line.startsWith('/stream/'));
	assert.ok(segment);
	const stream=await request('remote',segment,undefined,quotaToken);
	const reader=stream.body.getReader();
	await reader.read();
	const closed=(async()=>{try{while(!(await reader.read()).done){}}catch{}})();
	let blocked=null;
	const deadline=Date.now()+6000;
	while(Date.now()<deadline){
		blocked=await(await request('remote','/api/viewing-status',undefined,quotaToken)).json();
		if(blocked.blocked)break;
		await wait(100);
	}
	assert.equal(blocked.blocked,true,'the quota sweep must block this account');
	const denied=await request('remote','/api/play',{id:quotaItem},quotaToken);
	assert.equal(denied.status,403);
	const deniedBody=await denied.json();
	assert.equal(deniedBody.code,'VIEWING_LIMIT');
	assert.equal(deniedBody.retryAfter,undefined,'manual exhaustion must not promise a midnight reset');
	const ended=await Promise.race([closed.then(()=>true),wait(4000).then(()=>false)]);
	assert.equal(ended,true,'the quota sweep must close the active stream');
	assert.equal(blocked.resetAt,null);
	assert.equal(blocked.activeSessions,0);
});
