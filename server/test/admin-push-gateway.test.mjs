import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {installAdminPush} from '../admin-push.mjs';
import {PUSH_GATEWAY,PUBLIC_APP_PACKAGE,pushDeviceId} from '../push-gateway-client.mjs';

test('gateway tickets and handles belong to current app admins; notifications disclose only event IDs',async t=>{
	const directory=mkdtempSync(path.join(tmpdir(),'tellybox-admin-gateway-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
	writeFileSync(path.join(directory,'push-gateway.json'),JSON.stringify({enabled:true}));
	let listener,role='admin',isApp=true,delivered;const delivery=new Promise(resolve=>{delivered=resolve;});
	const calls=[],handle='h'.repeat(48),eventId='11111111-2222-4333-8444-555555555555';
	const app=express();app.use(express.json());
	installAdminPush(app,{directory,admin:(req,res,next)=>role==='admin'?next():res.sendStatus(403),writeCheck:(req,res,next)=>next(),record:()=>isApp?{id:'local-device',role}:null,devices:()=>[{id:'local-device',role}],audit:{subscribe:fn=>{listener=fn;}},fetcher:async(url,options)=>{
		assert.ok(url.startsWith(PUSH_GATEWAY+'/'));const body=options.body?JSON.parse(options.body):null;calls.push({url,body});
		if(url.endsWith('/config'))return Response.json({enabled:true,package:PUBLIC_APP_PACKAGE});
		if(url.endsWith('/installations'))return Response.json({id:body.id});
		if(url.endsWith('/tickets'))return Response.json({ticket:'t'.repeat(48),expiresAt:Date.now()+60000});
		if(url.endsWith('/devices/verify'))return Response.json({active:body.handle===handle&&body.deviceId===pushDeviceId('local-device')});
		if(url.endsWith('/wake'))delivered();return Response.json({ok:true});
	}});
	app.use((error,req,res,next)=>res.status(error.status||500).json({error:error.message}));
	const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
	const base='http://127.0.0.1:'+server.address().port;
	const post=(route,body)=>fetch(base+route,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
	assert.deepEqual(await(await fetch(base+'/api/apps/push/config')).json(),{enabled:false});assert.equal(calls.length,0);
	const cfg=await(await fetch(base+'/api/apps/push/config?package='+PUBLIC_APP_PACKAGE)).json();assert.deepEqual(cfg,{enabled:true,mode:'gateway',gateway:PUSH_GATEWAY,package:PUBLIC_APP_PACKAGE});
	assert.equal(calls.filter(call=>call.url.endsWith('/installations')).length,0);
	isApp=false;assert.equal((await post('/api/apps/push/ticket',{})).status,403);isApp=true;
	assert.equal((await post('/api/apps/push/ticket',{package:PUBLIC_APP_PACKAGE})).status,200);
	const registration={package:PUBLIC_APP_PACKAGE,handle,types:['watch_started']};
	assert.equal((await post('/api/apps/push/register',{...registration,handle:'other'.repeat(10)})).status,400);
	assert.equal((await post('/api/apps/push/register',{...registration,token:'do-not-accept-fcm-tokens'})).status,400);
	assert.equal((await post('/api/apps/push/register',registration)).status,200);
	const saved=JSON.parse(readFileSync(path.join(directory,'push-devices.json'),'utf8'))['local-device'];assert.equal(saved.token,undefined);assert.equal(saved.handle,handle);
	listener({id:eventId,type:'watch_started',title:'Private title',personName:'private@example.test'});await delivery;
	assert.deepEqual(calls.find(call=>call.url.endsWith('/wake')).body,{handle,eventId});
	role='viewer';listener({id:'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',type:'watch_started'});await new Promise(resolve=>setImmediate(resolve));
	assert.equal(calls.filter(call=>call.url.endsWith('/wake')).length,1);assert.equal((await post('/api/apps/push/ticket',{})).status,403);
	role='admin';assert.equal((await post('/api/apps/push/register',{enabled:false})).status,200);
	assert.deepEqual(calls.find(call=>call.url.endsWith('/devices/revoke')).body,{handle});
	assert.deepEqual(JSON.parse(readFileSync(path.join(directory,'push-devices.json'),'utf8')),{});
});

test('a transient gateway outage returns 503 without disabling or removing an existing app binding',async t=>{
	const directory=mkdtempSync(path.join(tmpdir(),'tellybox-admin-gateway-outage-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
	writeFileSync(path.join(directory,'push-gateway.json'),JSON.stringify({enabled:true}));
	const binding={'local-device':{mode:'gateway',package:PUBLIC_APP_PACKAGE,handle:'a'.repeat(32),types:['watch_started']}};
	writeFileSync(path.join(directory,'push-devices.json'),JSON.stringify(binding));
	let calls=0;const app=express();
	installAdminPush(app,{directory,admin:(req,res,next)=>next(),writeCheck:(req,res,next)=>next(),record:()=>({id:'local-device',role:'admin'}),devices:()=>[],fetcher:async()=>{calls++;return new Response('',{status:503});}});
	const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
	const url='http://127.0.0.1:'+server.address().port+'/api/apps/push/config?package='+PUBLIC_APP_PACKAGE;
	for(let i=0;i<2;i++){const response=await fetch(url);assert.equal(response.status,503);assert.equal((await response.json()).enabled,undefined);}
	assert.equal(calls,1);assert.deepEqual(JSON.parse(readFileSync(path.join(directory,'push-devices.json'),'utf8')),binding);
});
