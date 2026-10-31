import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { installAppUpdates } from '../app-updates.mjs';
import { get } from 'node:http';
process.env.PUBLIC_ORIGIN = 'https://watch.example.test';

async function downloadsFixture(t,edition='personal') {
	const previous=process.env.TELLYBOX_APP_EDITION;
	const previousPackage=process.env.TELLYBOX_APP_PACKAGE;process.env.TELLYBOX_APP_PACKAGE='uk.co.jimbos.jserver';
	t.after(()=>{if(previousPackage===undefined)delete process.env.TELLYBOX_APP_PACKAGE;else process.env.TELLYBOX_APP_PACKAGE=previousPackage;});
	if(edition)process.env.TELLYBOX_APP_EDITION=edition;else delete process.env.TELLYBOX_APP_EDITION;
	t.after(()=>{if(previous===undefined)delete process.env.TELLYBOX_APP_EDITION;else process.env.TELLYBOX_APP_EDITION=previous;});
	const directory=await mkdtemp(path.join(tmpdir(),'tellybox-download-choice-'));
	const app=express();installAppUpdates(app,directory);
	const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
	t.after(async()=>{await new Promise(resolve=>server.close(resolve));await rm(directory,{recursive:true,force:true});});
	const request=()=>fetch(`http://127.0.0.1:${server.address().port}/app-updates/downloads.json`,{headers:{Host:'untrusted.example.test','X-Forwarded-Host':'other.example.test'}});
	const feed=Object.fromEntries(['phone','tv'].map(flavour=>[flavour,{package:'uk.co.jimbos.jserver',flavour,versionName:'0.25.0',versionCode:52,bytes:3,sha256:'a'.repeat(64),url:`https://old.example.test/app-updates/Tellybox-${flavour}-0.25.0.apk`}]));
	const save=()=>writeFile(path.join(directory,'latest.json'),JSON.stringify(feed));
	return {directory,request,feed,save};
}

test('default HomeLab admin downloads use central aliases regardless of installed manifests or origin',async t=>{
	const f=await downloadsFixture(t,''), previous=process.env.PUBLIC_ORIGIN;
	delete process.env.PUBLIC_ORIGIN;
	try {
		await mkdir(path.join(f.directory,'public'));await writeFile(path.join(f.directory,'public/latest.json'),'legacy public feed');
		await f.save();
		const response=await f.request();assert.equal(response.status,200);assert.equal(response.headers.get('cache-control'),'no-store');
		const body=await response.json();assert.equal(body.edition,'homelab');
		for(const flavour of ['phone','tv'])assert.deepEqual(body[flavour],{package:'app.tellybox.homelab',flavour,url:`https://homelab.tellyboxapp.com/downloads/Tellybox-${flavour}-latest.apk`});
	} finally {process.env.PUBLIC_ORIGIN=previous;}
});

test('existing personal downloads keep their own validated files and configured public origin',async t=>{
	const f=await downloadsFixture(t);await f.save();
	for(const flavour of ['phone','tv'])await writeFile(path.join(f.directory,`Tellybox-${flavour}-0.25.0.apk`),'apk');
	const response=await f.request();assert.equal(response.status,200);const body=await response.json();
	assert.equal(body.edition,'personal');
	for(const flavour of ['phone','tv'])assert.equal(body[flavour].url,`https://watch.example.test/app-updates/Tellybox-${flavour}-0.25.0.apk`);
});

test('broken or wrong-edition personal releases fail closed instead of substituting HomeLab apps',async t=>{
	const f=await downloadsFixture(t);
	for(const flavour of ['phone','tv'])await writeFile(path.join(f.directory,`Tellybox-${flavour}-0.25.0.apk`),'apk');
	for(const mutate of [feed=>{feed.phone.package='app.tellybox.homelab';},feed=>{delete feed.tv;},feed=>{feed.phone.url='https://old.example.test/app-updates/Tellybox-tv-0.25.0.apk';},feed=>{feed.phone.bytes=99;}]) {
		const copy=structuredClone(f.feed);mutate(copy);await writeFile(path.join(f.directory,'latest.json'),JSON.stringify(copy));
		const response=await f.request();assert.equal(response.status,503);assert.equal((await response.json()).phone,undefined);
	}
	await writeFile(path.join(f.directory,'latest.json'),'{broken');assert.equal((await f.request()).status,503);
	await f.save();await rm(path.join(f.directory,'Tellybox-tv-0.25.0.apk'));assert.equal((await f.request()).status,503);
	await rm(path.join(f.directory,'latest.json'));assert.equal((await f.request()).status,503);
	process.env.TELLYBOX_APP_EDITION='unexpected';assert.equal((await f.request()).status,503);
});

test('custom app downloads require the configured application ID and never substitute personal apps',async t=>{
	const f=await downloadsFixture(t);await f.save();
	for(const flavour of ['phone','tv'])await writeFile(path.join(f.directory,`Tellybox-${flavour}-0.25.0.apk`),'apk');
	delete process.env.TELLYBOX_APP_PACKAGE;assert.equal((await f.request()).status,503);
	process.env.TELLYBOX_APP_PACKAGE='app.tellybox.homelab';assert.equal((await f.request()).status,503);
	process.env.TELLYBOX_APP_PACKAGE='org.example.familytv';assert.equal((await f.request()).status,503);
	for(const flavour of ['phone','tv'])f.feed[flavour].package='org.example.familytv';await f.save();
	const response=await f.request();assert.equal(response.status,200);
	assert.equal((await response.json()).packageName,'org.example.familytv');
});

test('public and personal update feeds cannot exchange app identities',async t=>{
	const dir=await mkdtemp(path.join(tmpdir(),'tellybox-editions-'));await mkdir(path.join(dir,'public'));
	const file='Tellybox-phone-0.25.0.apk';
	const feed=identity=>({phone:{package:identity,url:'https://watch.example.test/app-updates/'+file}});
	await writeFile(path.join(dir,'latest.json'),JSON.stringify(feed('uk.co.jimbos.jserver')));
	await writeFile(path.join(dir,'public/latest.json'),JSON.stringify(feed('app.tellybox.homelab')));
	await writeFile(path.join(dir,'public',file),'public-apk');
	const app=express();installAppUpdates(app,dir);const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
	t.after(async()=>{await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});});
	const origin='http://127.0.0.1:'+server.address().port;
	const personal=await(await fetch(origin+'/app-updates/latest.json')).json();
	const pub=await(await fetch(origin+'/app-updates/public/latest.json')).json();
	assert.equal(personal.phone.package,'uk.co.jimbos.jserver');assert.equal(pub.phone.package,'app.tellybox.homelab');
	assert.equal(pub.phone.url,'https://watch.example.test/app-updates/public/'+file);
	assert.equal(await(await fetch(origin+'/app-updates/public/'+file)).text(),'public-apk');
	await writeFile(path.join(dir,'public/latest.json'),JSON.stringify(feed('uk.co.jimbos.jserver')));
	assert.equal((await fetch(origin+'/app-updates/public/latest.json')).status,503);
	assert.equal((await fetch(origin+'/app-updates/public/connection.json')).status,404);
});

test('update feed exposes only published files, never credentials or writes', async () => {
	const dir=await mkdtemp(path.join(tmpdir(),'tellybox-updates-'));
	await writeFile(path.join(dir,'latest.json'),'{}');
	await writeFile(path.join(dir,'Tellybox-tv-0.18.apk'),'apk');
	await writeFile(path.join(dir,'connection.json'),'private');
	const app=express();installAppUpdates(app,dir);app.use((req,res)=>res.sendStatus(401));
	const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
	const origin=`http://127.0.0.1:${server.address().port}`;
	try {
		const feed=await fetch(origin+'/app-updates/latest.json');assert.equal(feed.status,200);assert.equal(feed.headers.get('cache-control'),'no-store');assert.deepEqual(await feed.json(),{});
		const apk=await fetch(origin+'/app-updates/Tellybox-tv-0.18.apk');assert.equal(apk.status,200);assert.equal(await apk.text(),'apk');
		for(const route of ['/app-updates/connection.json','/app-updates/.env','/app-updates/nested/latest.json','/app-updates/'])assert.equal((await fetch(origin+route)).status,404);
		assert.equal((await fetch(origin+'/app-updates/latest.json',{method:'POST'})).status,405);
		assert.equal((await fetch(origin+'/api/apps')).status,401);
	} finally {await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});}
});

test('update URLs use only the configured installation origin, never an injected Host', async t => {
	const dir=await mkdtemp(path.join(tmpdir(),'tellybox-update-hosts-'));
	await writeFile(path.join(dir,'latest.json'),JSON.stringify({ phone:{url:'https://watch.example.test/app-updates/Tellybox-phone-0.20.0.apk',versionCode:20,sha256:'a'.repeat(64)} }));
	const app=express();installAppUpdates(app,dir);
	const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
	t.after(async()=>{await new Promise(resolve=>server.close(resolve));await rm(dir,{recursive:true,force:true});});
	for(const host of ['old.example.test','watch.example.test','evil.test']) {
		const feed=await new Promise((resolve,reject)=>get(`http://127.0.0.1:${server.address().port}/app-updates/latest.json`,{headers:{Host:host}},response=>{let text='';response.setEncoding('utf8');response.on('data',part=>text+=part);response.on('end',()=>{try{resolve(JSON.parse(text));}catch(error){reject(error);}});}).on('error',reject));
		const expected='watch.example.test';
		assert.equal(feed.phone.url,`https://${expected}/app-updates/Tellybox-phone-0.20.0.apk`);assert.equal(feed.phone.sha256,'a'.repeat(64));
	}
});
