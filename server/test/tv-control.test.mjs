import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { installTvControl } from '../tv-control.mjs';

async function fixture(t) {
	let clock = 100000, valid = true;
	const sessions = new Map([['session-tv', { owner: 'app:tv' }], ['session-other', { owner: 'app:other' }]]);
	const app = express();app.use(express.json());
	// Trusted auth context, not headers that the real endpoints accept as identity.
	app.use((req,res,next) => { const id = req.get('test-identity');if(id !== 'guest'){req.jserverApp={};req.jserverViewer={deviceId:id,deviceName:'Living room'};req.jserverOwner='app:'+id;}next(); });
	installTvControl(app, {sessions, now:()=>clock, auth:{isHome:req=>req.get('test-home')==='yes',validOwner:()=>valid}});
	const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
	async function call(path='',body,id='tv',home=true) {
		const result=await fetch(`http://127.0.0.1:${server.address().port}/api/tv-control${path}`,{method:body?'POST':'GET',headers:{'Content-Type':'application/json','test-identity':id,'test-home':home?'yes':'no'},body:body?JSON.stringify(body):undefined});
		return {status:result.status,data:await result.json()};
	}
	return {call,sessions,tick:n=>clock+=n,revoke:()=>valid=false,state:{session:'session-tv',title:'An episode',paused:false,live:false,position:52,duration:1800}};
}

test('only approved home apps can list, advertise or control TVs',async t=>{
	const f=await fixture(t);
	for(const [id,home] of [['guest',true],['phone',false]])for(const [path,body] of [['',null],['/state',f.state],['/tv/command',{action:'pause'}]])assert.equal((await f.call(path,body,id,home)).status,403);
	assert.equal((await f.call('/state',f.state,'other')).status,403);
	assert.equal((await f.call('/state',f.state)).status,200);
	const list=(await f.call('',null,'phone')).data.televisions;
	assert.equal(list[0].title,'An episode');assert.equal(list[0].name,'Living room');assert.equal(JSON.stringify(list).includes('session-tv'),false);assert.equal(JSON.stringify(list).includes('app:tv'),false);
});
test('commands retry until acknowledged, are bounded, and cannot seek a live channel',async t=>{
	const f=await fixture(t);await f.call('/state',f.state);
	assert.equal((await f.call('/tv/command',{action:'pause'},'phone')).status,200);
	const first=(await f.call('/state',f.state)).data.commands;
	assert.equal(first[0].action,'pause');assert.deepEqual((await f.call('/state',f.state)).data.commands,first);
	assert.equal((await f.call('/state',{...f.state,ack:first[0].id})).data.commands.length,0);
	f.tick(300);await f.call('/state',{...f.state,live:true});
	assert.equal((await f.call('/tv/command',{action:'seekForward'},'phone')).status,400);
	assert.equal((await f.call('/tv/command',{action:'openUrl',url:'http://example.invalid'},'phone')).status,400);
	assert.equal((await f.call('/tv/command',{action:'play'},'phone')).status,200);
	assert.equal((await f.call('/tv/command',{action:'pause'},'phone')).status,429);
	for(let i=0;i<7;i++){f.tick(300);assert.equal((await f.call('/tv/command',{action:'pause'},'phone')).status,200);}
	f.tick(300);assert.equal((await f.call('/tv/command',{action:'pause'},'phone')).status,429);
});
test('old sessions, expired presence and revoked owners cannot receive controls',async t=>{
	const f=await fixture(t);await f.call('/state',f.state);
	await f.call('/state',{session:'different',ended:true});assert.equal((await f.call()).data.televisions.length,1);
	f.sessions.set('replacement',{owner:'app:tv'});await f.call('/tv/command',{action:'stop'},'phone');
	assert.deepEqual((await f.call('/state',{...f.state,session:'replacement'})).data.commands,[]);
	await f.call('/state',{session:'session-tv',ended:true});assert.equal((await f.call()).data.televisions.length,1);
	f.tick(15001);assert.equal((await f.call('/tv/command',{action:'play'},'phone')).status,404);
	await f.call('/state',f.state);f.revoke();assert.equal((await f.call()).data.televisions.length,0);
});
