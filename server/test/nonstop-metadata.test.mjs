import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {channelIdentity,matchChannel,createNonstopMetadata} from '../nonstop-metadata.mjs';

const channel={name:'24/7 The Office',group:'24/7 TV Series',id:'channel'};
const result={mediaType:'tv',id:123,name:'The Office',firstAirDate:'2005-03-24',genreIds:[35]};
test('24/7 matching accepts exact titles and rejects ambiguous remakes, wrong media types and partial matches',()=>{
	const identity=channelIdentity(channel);
	assert.equal(identity.title,'The Office');
	assert.deepEqual(matchChannel(identity,[result]).genres,['Comedy']);
	assert.equal(matchChannel(identity,[result,{...result,id:456,firstAirDate:'2001-07-09'}]),null);
	assert.equal(matchChannel(identity,[{...result,mediaType:'movie'}]),null);
	assert.equal(matchChannel(identity,[{...result,name:'The Office Australia'}]),null);
	assert.equal(matchChannel(channelIdentity({...channel,name:'24/7 The Office (2005) HD'}),[result,{...result,id:456,firstAirDate:'2001-07-09'}]).id,123);
	assert.equal(channelIdentity({...channel,group:'24/7 Concerts'}),null);
});
test('channel browsing returns immediately, deduplicates lookups, retains provider data and survives lookup failure',async t=>{
	let release,calls=0;const pending=new Promise(resolve=>release=resolve);
	const service=createNonstopMetadata({delayMs:1,search:async()=>{calls++;return pending;}});t.after(()=>service.close());
	const first=await service.enrich([channel,channel]);assert.deepEqual(first[0].genres,[]);assert.equal(first[0].group,channel.group);
	await new Promise(resolve=>setTimeout(resolve,10));assert.equal(calls,1);
	await service.enrich([channel]);release([result]);await new Promise(resolve=>setTimeout(resolve,10));
	assert.deepEqual((await service.enrich([channel]))[0].genres,['Comedy']);assert.equal(calls,1);
	let failures=0;const offline=createNonstopMetadata({delayMs:1,search:async()=>{failures++;throw Error('offline');}});t.after(()=>offline.close());
	await offline.enrich([channel]);await new Promise(resolve=>setTimeout(resolve,10));
	await offline.enrich([channel]);await new Promise(resolve=>setTimeout(resolve,10));assert.equal(failures,1);
});
test('stored genres are served after restart while stale entries refresh without blocking',async t=>{
	const dir=await mkdtemp(path.join(tmpdir(),'nonstop-'));t.after(()=>rm(dir,{recursive:true,force:true}));const file=path.join(dir,'cache.json');
	await writeFile(file,JSON.stringify([[channelIdentity(channel).key,{time:1,result:{genres:['Comedy']}}]]));
	const service=createNonstopMetadata({file,clock:()=>20*86400000,delayMs:1000,search:async()=>[]});t.after(()=>service.close());
	assert.deepEqual((await service.enrich([channel]))[0].genres,['Comedy']);assert.equal(service.status().pending,1);
});
