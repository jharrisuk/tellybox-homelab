import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { installAdminPush, notification, pushClient } from '../admin-push.mjs';

test('Firebase client selection keeps app editions separate without breaking legacy personal clients',()=>{
	const config={projectId:'fixture-project',applicationId:'personal-app',publicApplicationId:'public-app',apiKey:'fixture-key',senderId:'123456'};
	assert.equal(pushClient(config).applicationId,'personal-app');
	assert.equal(pushClient(config,'uk.co.jimbos.jserver').applicationId,'personal-app');
	assert.equal(pushClient(config,'app.tellybox.homelab').applicationId,'public-app');
	assert.deepEqual(pushClient(config,'unknown.package'),{enabled:false});
	assert.deepEqual(pushClient({...config,publicApplicationId:''},'app.tellybox.homelab'),{enabled:false});
	assert.deepEqual(pushClient({...config,applicationId:''}),{enabled:false});
	assert.equal(pushClient({...config,applicationId:''},'app.tellybox.homelab').applicationId,'public-app');
	assert.equal(pushClient({...config,private_key:'never-send'},'app.tellybox.homelab').private_key,undefined);
});

test('admin notification messages identify requests, sign-ins and local or remote playback', () => {
	const message = event => notification(event).message;
	assert.equal(message({ type: 'person_requested', personName: 'j@example.com', local: true }), 'j@example.com has requested access');
	assert.equal(message({ type: 'app_requested', deviceName: 'Living room TV' }), 'Living room TV has requested access');
	assert.equal(message({ type: 'watch_started', title: 'ITV', local: true }), 'Local stream of ITV');
	assert.equal(message({ type: 'watch_started', title: 'ITV', home: true, deviceName: 'Living room TV' }), 'Local stream of ITV · Living room TV');
	assert.equal(message({ type: 'watch_started', title: 'Slow Horses · Episode 2', personName: 'j@example.com', deviceName: 'Phone' }), 'j@example.com started watching Slow Horses · Episode 2 · Remote');
	assert.equal(message({ type: 'media_request', title: 'Blue Planet', personName: 'j@example.com' }), 'j@example.com requested Blue Planet');
	assert.equal(message({ type: 'login_success', personName: 'j@example.com' }), 'j@example.com signed in');
});

test('notification details tolerate missing metadata and keep supplied text to one readable line', () => {
	assert.equal(notification({ type: 'app_requested' }).message, 'A new device has requested access');
	assert.equal(notification({ type: 'watch_started', local: true }).message, 'Local stream of an untitled programme');
	assert.equal(notification({ type: 'media_request', local: true, title: '  Blue\nPlanet  ' }).message, 'Someone at home requested Blue Planet');
	const result=notification({ id: 'fixture', time: 123, type: 'watch_started', title: 'ITV', personName: '  ', deviceName: 'Bedroom TV' });
	assert.equal(result.message, 'Bedroom TV started watching ITV · Remote');
	assert.equal(result.id, 'fixture'); assert.equal(result.time, 123);
});

test('push is optional, wakes authorised admins without viewing details and stops after role removal', async t => {
	const directory=mkdtempSync(path.join(tmpdir(),'tellybox-push-test-'));
	t.after(()=>rmSync(directory,{recursive:true,force:true}));
	const {privateKey}=generateKeyPairSync('rsa',{modulusLength:2048});
	writeFileSync(path.join(directory,'firebase-client.json'),JSON.stringify({projectId:'fixture-project',applicationId:'fixture-app',apiKey:'fixture-public-key',senderId:'123456'}));
	writeFileSync(path.join(directory,'firebase-service-account.json'),JSON.stringify({project_id:'fixture-project',client_email:'fixture@fixture-project.iam.gserviceaccount.com',private_key:privateKey.export({type:'pkcs8',format:'pem'})}));
	const app=express();app.use(express.json());let listener,role='admin';const sent=[];
	let delivered;const delivery=new Promise(resolve=>{delivered=resolve;});
	installAdminPush(app,{directory,admin:(req,res,next)=>role==='admin'?next():res.sendStatus(403),writeCheck:(req,res,next)=>next(),record:()=>({id:'fixture-device',role}),devices:()=>[{id:'fixture-device',role}],audit:{subscribe:fn=>{listener=fn;}},fetcher:async(url,options)=>{
		if(url.includes('oauth2.googleapis.com'))return Response.json({access_token:'fixture-token',expires_in:3600});
		sent.push(JSON.parse(options.body));delivered();return Response.json({name:'fixture-message'});
	}});
	const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
	t.after(()=>server.close());const base='http://127.0.0.1:'+server.address().port;
	assert.equal((await (await fetch(base+'/api/apps/push/config')).json()).enabled,true);
	assert.equal((await (await fetch(base+'/api/apps/push/config?package=app.tellybox.homelab')).json()).enabled,false);
	const publicRegistration=await fetch(base+'/api/apps/push/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({package:'app.tellybox.homelab',token:'fixture-public-token-not-real',types:['watch_started']})});assert.equal(publicRegistration.status,409);
	const register=await fetch(base+'/api/apps/push/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token:'fixture-device-token-not-real',types:['watch_started']})});assert.equal(register.status,200);
	listener({id:'event-1',type:'watch_started',title:'Private viewing title',personName:'Private name'});
	await delivery;assert.deepEqual(sent[0].message.data,{eventId:'event-1'});
	role='viewer';listener({id:'event-2',type:'watch_started'});
	await new Promise(resolve=>setImmediate(resolve));assert.equal(sent.length,1);
	assert.equal((await fetch(base+'/api/apps/push/config')).status,403);
});
