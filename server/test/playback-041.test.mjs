import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,rmSync} from 'node:fs';import os from 'node:os';import path from 'node:path';
import {createUploadLimit} from '../upload-limit.mjs';import {createAccountLimits} from '../account-limits.mjs';import {createCatchup} from '../catchup.mjs';import {captionSlice} from '../vod-captions.mjs';
function folder(t){const p=mkdtempSync(path.join(os.tmpdir(),'tellybox-policy-'));t.after(()=>rmSync(p,{recursive:true,force:true}));return p;}
test('scheduled upload limits handle overnight, UK summer time, persistence and overlap',t=>{
	let now=Date.parse('2026-07-01T17:00:00Z');const dir=folder(t),limit=createUploadLimit(dir,{clock:()=>now});
	limit.set(50,[{start:'18:00',end:'23:00',mbps:20},{start:'23:00',end:'06:00',mbps:10}]);assert.equal(limit.status().mbps,20);
	now=Date.parse('2026-07-01T22:00:00Z');assert.equal(limit.status().mbps,10);now=Date.parse('2026-07-02T05:00:00Z');assert.equal(limit.status().mbps,50);
	assert.throws(()=>limit.set(50,[{start:'23:00',end:'06:00',mbps:10},{start:'05:00',end:'07:00',mbps:20}]));
	assert.equal(createUploadLimit(dir,{clock:()=>Date.parse('2026-12-01T18:00Z')}).status().mbps,20);
});
test('remote limits are manual, shared by linked devices, enforce downloads and exempt home',t=>{
	let now=100000;const dir=folder(t),limit=createAccountLimits(dir,{clock:()=>now}),id='a'.repeat(32),viewer={personId:id},key='person:'+id;
	assert.equal(limit.allowed(viewer,true),false);limit.set(key,{minutes:1,downloads:true});limit.media('one',viewer);
	for(let i=0;i<12;i++){now+=5000;limit.media('one',viewer);limit.tick();}
	assert.equal(limit.allowed(viewer),false);assert.throws(()=>limit.guard(viewer));assert.equal(limit.allowed({...viewer,local:true}),true);
	assert.equal(createAccountLimits(dir).allowed(viewer),false);now+=86400000;limit.tick();assert.equal(limit.allowed(viewer),false);
	limit.set(key,{minutes:1,downloads:false,reset:true});assert.equal(limit.allowed(viewer),true);assert.equal(limit.status(key).seconds,0);assert.equal(limit.allowed(viewer,true),false);
	limit.media('two',viewer);limit.heartbeat('two',false);now+=5000;limit.tick();assert.equal(limit.status(key).seconds,0);
	limit.end('one');limit.end('two');limit.media('phone',{...viewer,deviceId:'b'.repeat(32)});limit.media('tv',{...viewer,deviceId:'c'.repeat(32)});
	now+=5000;limit.tick();assert.equal(limit.status(key).seconds,10);limit.heartbeat('tv',false);now+=5000;limit.tick();assert.equal(limit.status(key).seconds,15);
	limit.set(key,{minutes:10,downloads:true});assert.equal(limit.status(key).seconds,15);limit.end('phone');limit.end('tv');
	assert.equal(createAccountLimits(dir).status(key).seconds,15);
});
test('catch-up only offers complete broadcasts inside the advertised archive',async()=>{
	const now=Date.parse('2026-10-26T12:00Z'),uuid='01234567-0123-0123-0123-012345678901',channel={Id:'dispatch-live-'+uuid,Name:'Channel',programmes:[{Name:'Yesterday',StartDate:'2026-10-25T12:00:00Z',EndDate:'2026-10-25T13:00:00Z'},{Name:'Live',StartDate:'2026-10-26T11:30:00Z',EndDate:'2026-10-26T12:30:00Z'},{Name:'Expired',StartDate:'2026-10-18T12:00:00Z',EndDate:'2026-10-18T13:00:00Z'}]};
	const service=createCatchup({recordingApi:async()=>[{uuid,is_catchup:true,catchup_days:7}]},{archive:async()=>({channels:[channel]})},()=>now);
	const data=await service.list();assert.equal(data.channels[0].programmes.length,1);const item=data.channels[0].programmes[0];assert.equal((await service.resolve(item.Id)).Name,'Yesterday');await assert.rejects(service.resolve('catchup-'+uuid+'-'+now));await assert.rejects(service.resolve('https://evil.invalid'));
});
test('caption windows preserve global timing and exclude unrelated cues',()=>{
	const text='WEBVTT\n\n00:00:04.000 --> 00:00:11.000\nHello\n\n00:00:36.000 --> 00:00:43.000\nLater\n\n';
	assert.match(captionSlice(text,1),/Hello/);assert.doesNotMatch(captionSlice(text,1),/Later/);assert.match(captionSlice(text,9),/Later/);assert.match(captionSlice(text,9),/MPEGTS:126000/);
});
