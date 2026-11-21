import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { installAppUpdates, adminDownloads } from '../app-updates.mjs';

const PACKAGE='uk.co.jimbos.jserver';
const flavours=['phone','tv'];
const publicOrigin='https://watch.example.test';

function fullFeed(version='0.25.0',code=52) {
	return Object.fromEntries(flavours.map(flavour=>[flavour,{package:PACKAGE,flavour,versionName:version,versionCode:code,bytes:3,sha256:'a'.repeat(64),url:`https://old.example.test/app-updates/Tellybox-${flavour}-${version}.apk`}]));
}

const envSnapshots=new WeakMap();
async function withEnv(t,values) {
	let previous=envSnapshots.get(t);
	if(!previous) {
		previous={};envSnapshots.set(t,previous);
		t.after(()=>{for(const [key,value] of Object.entries(previous)) {if(value===undefined)delete process.env[key];else process.env[key]=value;}});
	}
	for(const [key,value] of Object.entries(values)) {
		if(!(key in previous))previous[key]=process.env[key];
		if(value===undefined)delete process.env[key];else process.env[key]=value;
	}
}

async function fixture(t,{origin={public:publicOrigin,local:'http://192.168.50.8:8082'},feed=fullFeed(),files=true,packageName=PACKAGE}={}) {
	await withEnv(t,{TELLYBOX_APP_EDITION:'personal',TELLYBOX_APP_PACKAGE:packageName,PUBLIC_ORIGIN:origin.public,LOCAL_PLAYBACK_ORIGIN:origin.local});
	const directory=await mkdtemp(path.join(tmpdir(),'tellybox-updates-batch-'));
	await writeFile(path.join(directory,'latest.json'),JSON.stringify(feed));
	if(files)for(const flavour of flavours)await writeFile(path.join(directory,`Tellybox-${flavour}-${feed[flavour].versionName}.apk`),'apk');
	const app=express();installAppUpdates(app,directory);
	const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
	t.after(async()=>{await new Promise(resolve=>server.close(resolve));await rm(directory,{recursive:true,force:true});});
	const base=`http://127.0.0.1:${server.address().port}`;
	return {directory,feed,get:(route,init)=>fetch(base+route,init)};
}

function assertDownloadUrls(body,origin) {
	for(const flavour of flavours)assert.equal(body[flavour].url,`${origin}/app-updates/Tellybox-${flavour}-0.25.0.apk`);
}

test('personal update checks rewrite to the configured public HTTPS origin when the app uses LAN',async t=>{
	const f=await fixture(t);
	const latest=await f.get('/app-updates/latest.json');assert.equal(latest.status,200);
	assertDownloadUrls(await latest.json(),publicOrigin);
	const downloads=await f.get('/app-updates/downloads.json');assert.equal(downloads.status,200);
	assertDownloadUrls(await downloads.json(),publicOrigin);
});

test('personal update checks work when only the LAN origin is configured',async t=>{
	for(const route of ['/app-updates/latest.json','/app-updates/downloads.json']) {
		const f=await fixture(t,{origin:{public:undefined,local:'http://192.168.50.8:8082'}});
		const response=await f.get(route);assert.equal(response.status,200);
		assertDownloadUrls(await response.json(),'http://192.168.50.8:8082');
	}
});

test('an HTTPS origin wins and an available HTTP origin is never used for downloads',async t=>{
	for(const expectation of [
		{public:publicOrigin,local:'http://192.168.50.8:8082',expected:publicOrigin},
		{public:'http://watch.example.test',local:'https://lan.example.test:8443',expected:'https://lan.example.test:8443'},
		{public:'https://old.example.test',local:'https://lan.example.test:8443',expected:'https://old.example.test'},
		{public:'http://watch.example.test',local:'http://192.168.50.8:8082',expected:'http://watch.example.test'},
	]) {
		const f=await fixture(t,{origin:{public:expectation.public,local:expectation.local}});
		const latest=await f.get('/app-updates/latest.json');assert.equal(latest.status,200);
		assertDownloadUrls(await latest.json(),expectation.expected);
		const downloads=await f.get('/app-updates/downloads.json');assert.equal(downloads.status,200);
		assertDownloadUrls(await downloads.json(),expectation.expected);
	}
});

test('latest.json and downloads.json reject the same bad manifest fields',async t=>{
	const f=await fixture(t);
	const save=async mutate=>{const copy=structuredClone(f.feed);mutate(copy);await writeFile(path.join(f.directory,'latest.json'),JSON.stringify(copy));};
	const mutations=[
		feed=>{feed.phone.package='app.tellybox.homelab';},
		feed=>{feed.phone.flavour='tv';},
		feed=>{feed.phone.versionCode=0;},
		feed=>{feed.phone.versionCode='52';},
		feed=>{feed.phone.versionName='v0.25.0';},
		feed=>{feed.phone.bytes=0;},
		feed=>{feed.phone.bytes='3';},
		feed=>{feed.phone.sha256='A'.repeat(64);},
		feed=>{feed.phone.url='ftp://watch.example.test/app-updates/Tellybox-phone-0.25.0.apk';},
		feed=>{feed.phone.url='https://user:password@watch.example.test/app-updates/Tellybox-phone-0.25.0.apk';},
		feed=>{feed.phone.url='https://watch.example.test/app-updates/Tellybox-phone-0.25.0.apk?token=secret';},
		feed=>{feed.phone.url='https://watch.example.test/app-updates/Tellybox-tv-0.25.0.apk';},
		feed=>{feed.phone.url='https://watch.example.test/app-updates/public/Tellybox-phone-0.25.0.apk';},
		feed=>{feed.phone.url='https://watch.example.test/elsewhere/Tellybox-phone-0.25.0.apk';},
	];
	for(const mutate of mutations) {
		await save(mutate);
		assert.equal((await f.get('/app-updates/latest.json')).status,503);
		assert.equal((await f.get('/app-updates/downloads.json')).status,503);
	}
	await save(mutations[0]);
	const unavailable=await f.get('/app-updates/downloads.json');assert.equal(unavailable.status,503);
	assert.match((await unavailable.json()).error,/temporarily unavailable/);
	await writeFile(path.join(f.directory,'latest.json'),'{}');
	assert.equal((await f.get('/app-updates/latest.json')).status,200);
	assert.equal((await f.get('/app-updates/downloads.json')).status,503);
	await writeFile(path.join(f.directory,'latest.json'),JSON.stringify({phone:{url:`${publicOrigin}/app-updates/Tellybox-phone-0.25.0.apk`}}));
	assert.equal((await f.get('/app-updates/latest.json')).status,200);
	assert.equal((await f.get('/app-updates/downloads.json')).status,503);
});

test('downloads.json requires present binaries while latest.json stays a metadata feed',async t=>{
	const f=await fixture(t);
	await rm(path.join(f.directory,'Tellybox-phone-0.25.0.apk'));
	assert.equal((await f.get('/app-updates/latest.json')).status,200);
	assert.equal((await f.get('/app-updates/downloads.json')).status,503);
	await writeFile(path.join(f.directory,'Tellybox-phone-0.25.0.apk'),'four');
	assert.equal((await f.get('/app-updates/downloads.json')).status,503);
});

test('downloads.json re-reads latest.json once when an APK is mid-publication',async t=>{
	await withEnv(t,{TELLYBOX_APP_EDITION:'personal',TELLYBOX_APP_PACKAGE:PACKAGE,PUBLIC_ORIGIN:publicOrigin,LOCAL_PLAYBACK_ORIGIN:undefined});
	const feed=fullFeed(),manifest=JSON.stringify(feed);
	for(const firstSize of [null,2]) {
		let reads=0,apkStats=0;
		const io={
			stat(file) {
				if(path.basename(file)==='latest.json')return {size:Buffer.byteLength(manifest),isFile:()=>true};
				apkStats++;
				if(apkStats===1) {
					if(firstSize===null) {const error=Error('missing');error.code='ENOENT';throw error;}
					return {size:firstSize,isFile:()=>true};
				}
				return {size:3,isFile:()=>true};
			},
			readFile() {reads++;return manifest;},
		};
		const result=adminDownloads('unused',io);
		assert.equal(reads,2);assert.equal(apkStats,3);
		assertDownloadUrls(result,publicOrigin);
	}
});

test('downloads.json re-reads latest.json only once when the APK stays unavailable',async t=>{
	await withEnv(t,{TELLYBOX_APP_EDITION:'personal',TELLYBOX_APP_PACKAGE:PACKAGE,PUBLIC_ORIGIN:publicOrigin,LOCAL_PLAYBACK_ORIGIN:undefined});
	const manifest=JSON.stringify(fullFeed());let reads=0;
	const io={
		stat(file){if(path.basename(file)==='latest.json')return {size:Buffer.byteLength(manifest),isFile:()=>true};const error=Error('missing');error.code='ENOENT';throw error;},
		readFile(){reads++;return manifest;},
	};
	assert.throws(()=>adminDownloads('unused',io),{message:'Personal APK is unavailable'});
	assert.equal(reads,2);
});
