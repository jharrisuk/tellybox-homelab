import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {parsePlaylist,isNonstop,createDispatcharr} from '../dispatcharr.mjs';
import {parseEpg,xmltvTime,createDispatcharrGuide} from '../dispatcharr-guide.mjs';
import {mediaFile,encodingArgs} from '../dispatcharr-player.mjs';

const origin='http://dispatch.test:9191', a='11111111-1111-1111-1111-111111111111',b='22222222-2222-2222-2222-222222222222';
const channels=[{id:a,name:'BBC',number:'1',epgId:'bbc',nonstop:false},{id:b,name:'24/7 Show',number:'1000',epgId:'loop',nonstop:true}];
const now=Date.parse('2026-10-22T18:00:00Z');
const xml=text=>new Response(text).body;
test('channel browsing serves stale metadata immediately, coalesces refreshes and survives a restart', {timeout:2000}, async t=>{
	const dir=mkdtempSync(path.join(os.tmpdir(),'channel-cache-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
	const file=path.join(dir,'config.json');let time=now,calls=0,release;
	const gate=new Promise(resolve=>{release=resolve;});
	const playlist=name=>`#EXTM3U\n#EXTINF:-1 tvg-logo="https://external.test/secret?token=hidden" group-title="24/7 TV",${name}\n${origin}/proxy/ts/stream/${a}`;
	const client=createDispatcharr({file,origin,clock:()=>time,fetcher:async()=>{calls++;if(calls>1)await gate;return new Response(playlist(calls===1?'First':'Updated'));}});
	await client.channels();time+=61000;
	assert.equal((await client.channels())[0].name,'First');assert.equal((await client.channels())[0].name,'First');assert.equal(calls,2);
	release();assert.equal((await client.channels(true))[0].name,'Updated');assert.equal(calls,2);
	assert.doesNotMatch(readFileSync(file+'.channels-cache.json','utf8'),/secret|token|hidden|proxy\/ts/);
	const restored=createDispatcharr({file,origin,clock:()=>time,fetcher:async()=>{throw Error('offline');}});
	assert.equal((await restored.channels())[0].name,'Updated');
	time+=86400001;await assert.rejects(restored.channels(),/offline/);
});
test('a failed background playlist refresh retains the last list and bounds retries', async t=>{
	const dir=mkdtempSync(path.join(os.tmpdir(),'channel-retry-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));let time=now,calls=0;
	const client=createDispatcharr({file:path.join(dir,'config.json'),origin,clock:()=>time,fetcher:async()=>{if(++calls>1)throw Error('offline');return new Response(`#EXTM3U\n#EXTINF:-1 group-title="24/7",Channel\n${origin}/proxy/ts/stream/${a}`);}});
	await client.channels();time+=61000;assert.equal((await client.channels()).length,1);await new Promise(resolve=>setImmediate(resolve));
	assert.equal((await client.channels()).length,1);assert.equal(calls,2);time+=15001;await client.channels();assert.equal(calls,3);
});
test('playlist preserves quoted commas, numbers and groups, excludes other origins and repeated streams',()=>{
	const lines=['#EXTM3U',`#EXTINF:-1 tvg-name="One, Two" tvg-chno="1000" group-title="24/7, TV Series",One, Two`,origin+'/proxy/ts/stream/'+a,
		'#EXTINF:-1 tvg-chno="2" group-title="News",News',origin+'/proxy/ts/stream/'+b,
		'#EXTINF:-1,Duplicate',origin+'/proxy/ts/stream/'+a,'#EXTINF:-1,External','https://evil.test/proxy/ts/stream/'+b];
	const result=parsePlaylist(lines.join('\n'),origin);
	assert.equal(result.length,2);assert.equal(result[0].number,'2');assert.equal(result[1].name,'One, Two');assert.equal(result[1].nonstop,true);
	assert.equal(isNonstop('24/7 Movies'),true);assert.equal(isNonstop('Channel 2470'),false);
});
test('XMLTV offsets survive UK summer time, winter time and invalid calendar values',()=>{
	assert.equal(xmltvTime('20261022190000 +0100'),now);
	assert.equal(xmltvTime('20261022180000 +0000'),now);
	assert.equal(xmltvTime('20261022130000 -0500'),now);
	assert.ok(Number.isNaN(xmltvTime('20260230180000 +0000')));
	assert.ok(Number.isNaN(xmltvTime('20261022250000 +0000')));
});
test('guide uses exact channel IDs, decodes text, excludes 24/7, duplicates, expired and invalid listings',async()=>{
	const p=(id,title,start='20261022190000 +0100',stop='20261022200000 +0100')=>`<programme channel="${id}" start="${start}" stop="${stop}"><title>${title}</title><desc>News &amp; weather</desc></programme>`;
	const result=await parseEpg(xml('<tv>'+p('bbc','A &amp; B')+p('bbc','A &amp; B')+p('loop','Loop')+p('other','Other')+p('bbc','Expired','20261022160000 +0100','20261022170000 +0100')+p('bbc','Invalid','oops')+'</tv>'),channels,now);
	assert.equal(result.channels.length,1);assert.equal(result.channels[0].programmes.length,1);assert.equal(result.channels[0].programmes[0].Name,'A & B');assert.equal(result.current,1);assert.equal(result.invalid,1);
});
test('overlapping schedules are flagged instead of displayed as a confident match; DTDs rejected',async()=>{
	const result=await parseEpg(xml('<tv><programme channel="bbc" start="20261022180000 +0000" stop="20261022190000 +0000"><title>A</title></programme><programme channel="bbc" start="20261022183000 +0000" stop="20261022200000 +0000"><title>B</title></programme></tv>'),channels,now);
	assert.equal(result.conflicts,2);assert.equal(result.channels[0].programmes.length,0);
	await assert.rejects(()=>parseEpg(xml('<!DOCTYPE tv SYSTEM "file:///etc/passwd"><tv/>'),channels,now));
});
test('guide coalesces requests and keeps only unexpired listings after a refresh failure',async()=>{
	let count=0,clock=now,fail=false;
	const guide=createDispatcharrGuide({origin,channels:async()=>channels},async()=>{count++;if(fail)throw Error('offline');return new Response('<tv><programme channel="bbc" start="20261022180000 +0000" stop="20261022190000 +0000"><title>A</title></programme></tv>');},()=>clock);
	await Promise.all([guide(),guide()]);assert.equal(count,1);
	clock+=130000;fail=true;await guide();const stale=await guide(true);assert.equal(stale.stale,true);assert.equal(stale.channels[0].programmes.length,1);
	clock+=3600000;assert.equal((await guide()).channels[0].programmes.length,0);
});
test('identical schedules on distinct channels are flagged without silently guessing a corrected mapping',async()=>{
	const items=[channels[0],{id:b,name:'Different channel',number:'2',epgId:'other',nonstop:false}];
	let text='<tv>';
	for(const channel of ['bbc','other'])for(let i=0;i<3;i++)text+=`<programme channel="${channel}" start="20261022${18+i}0000 +0000" stop="20261022${19+i}0000 +0000"><title>Programme ${i}</title></programme>`;
	const data=await parseEpg(xml(text+'</tv>'),items,now);
	assert.deepEqual(data.sharedSchedules,[['BBC','Different channel']]);
	assert.ok(data.channels.every(c=>c.GuideWarning&&c.programmes.length===3));
});
test('connection credentials persist only after validation, and returned status never includes secrets',async t=>{
	const dir=mkdtempSync(path.join(os.tmpdir(),'dispatch-test-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
	let denied=false;
	const client=createDispatcharr({file:path.join(dir,'config.json'),origin,fetcher:async(url,options)=>{
		if(url.pathname.endsWith('/token/'))return Response.json({access:'temporary-secret',refresh:'refresh-secret'});
		if(denied)return new Response('provider-secret',{status:401});
		assert.ok(options.headers.Authorization);return Response.json({results:[]});
	}});
	await client.connect({username:'user',password:'not-stored'});
	assert.deepEqual(JSON.parse(readFileSync(path.join(dir,'config.json'),'utf8')),{refresh:'refresh-secret'});
	assert.equal(JSON.stringify(client.status()).includes('secret'),false);
	denied=true;await assert.rejects(()=>client.connect({key:'rejected'}),/not accepted/);
	assert.equal(JSON.parse(readFileSync(path.join(dir,'config.json'),'utf8')).refresh,'refresh-secret');
});
test('HLS resources cannot traverse directories; supported video remuxes and unsupported or oversized video converts',()=>{
	for(const file of ['../secret','/etc/passwd','segment0.ts?url=http://evil','index.m3u8/..'])assert.throws(()=>mediaFile(file));
	assert.equal(mediaFile('segment000000001.ts'),'segment000000001.ts');
	assert.equal(encodingArgs({codec:'h264',bitrate:4000000,quality:8000000}).convert,false);
	assert.equal(encodingArgs({codec:'hevc',quality:8000000}).convert,true);
	assert.equal(encodingArgs({codec:'h264',bitrate:12000000,quality:4000000}).convert,true);
});

test('expired sign-in is reported without repeated upstream refresh attempts; API key reconnect restores catalogue',async t=>{
	const dir=mkdtempSync(path.join(os.tmpdir(),'dispatch-expired-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
	const file=path.join(dir,'config.json'),refresh='synthetic.'+Buffer.from(JSON.stringify({exp:now/1000-1})).toString('base64url')+'.secret';
	writeFileSync(file,JSON.stringify({refresh}));let calls=0;
	const client=createDispatcharr({file,origin,clock:()=>now,fetcher:async(url,options)=>{calls++;assert.equal(options.headers['X-API-Key'],'test-key');return Response.json({results:[{id:1}]});}});
	assert.equal(client.status().needsReconnect,true);assert.equal(client.status().connected,true);assert.equal(JSON.stringify(client.status()).includes('secret'),false);
	for(let i=0;i<2;i++)await assert.rejects(client.api('/api/vod/movies/'),/sign-in has expired/);
	assert.equal(calls,0);
	const status=await client.connect({key:'test-key'});assert.equal(status.authMode,'api-key');assert.equal(status.needsReconnect,false);assert.equal(status.expiresAt,null);
	assert.equal((await client.api('/api/vod/movies/')).results[0].id,1);assert.equal(calls,2);
});

test('revoked refresh gives an actionable safe error, while valid concurrent refreshes coalesce and persist rotation',async t=>{
	const dir=mkdtempSync(path.join(os.tmpdir(),'dispatch-renew-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
	const file=path.join(dir,'config.json');writeFileSync(file,JSON.stringify({refresh:'old-refresh'}));let denied=true,refreshes=0;
	const client=createDispatcharr({file,origin,fetcher:async(url,options)=>{
		if(url.pathname.endsWith('/refresh/')){refreshes++;return denied?new Response('private upstream body',{status:401}):Response.json({access:'new-access',refresh:'new-refresh'});}
		assert.equal(options.headers.Authorization,'Bearer new-access');return Response.json({results:[]});
	}});
	await assert.rejects(client.api('/api/vod/movies/'),error=>error.status===503&&/personal API key/.test(error.message)&&!error.message.includes('private'));
	assert.equal(refreshes,1);denied=false;
	await Promise.all([client.api('/api/vod/movies/'),client.api('/api/vod/series/')]);assert.equal(refreshes,2);
	assert.equal(JSON.parse(readFileSync(file,'utf8')).refresh,'new-refresh');
});
