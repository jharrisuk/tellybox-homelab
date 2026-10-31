import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createVodLibrary} from '../vod-library.mjs';
import {createVodMetadata} from '../vod-metadata.mjs';

async function fixture(t) {
	const dir=await mkdtemp(path.join(os.tmpdir(),'series-index-'));
	const series={id:7,name:'A show',tmdb_id:44,year:2026};
	const local={Id:'local-show',Name:'A show',Type:'Series',ProviderIds:{Tmdb:'44'}};
	const state={now:Date.parse('2026-10-22'),episodeCalls:0,infoCalls:0,localCalls:0,rows:2,localRows:1,fail:false,gate:null,extra:[]};
	const localEpisodes=async()=>Array.from({length:state.localRows},(_,i)=>({Id:'local-'+(i+1),Name:'Local '+(i+1),Type:'Episode',ParentIndexNumber:1,IndexNumber:i+1}));
	const dispatcharr={status:()=>({connected:true}),api:async route=>{
		if(route.includes('/movies/'))return [];
		if(route.includes('/provider-info/')){state.infoCalls++;if(state.gate)await state.gate;if(state.fail)throw Error('secret upstream error');return {};}
		if(route.includes('/episodes/')){state.episodeCalls++;return Array.from({length:state.rows},(_,i)=>({id:i+1,name:'Episode '+(i+1),series,season_number:1,episode_number:i+1,stream_url:'secret'}));}
		if(route==='/api/vod/series/7/')return series;
		const detail=/\/series\/(\d+)\/$/.exec(route);if(detail)return {...series,id:Number(detail[1]),tmdb_id:Number(detail[1])+100};
		return [series,...state.extra];
	}};
	const options={dispatcharr,file:path.join(dir,'catalogue.json'),clock:()=>state.now,localItems:async()=>{state.localCalls++;return [local];},localItem:async()=>local,localEpisodes};
	const lib=createVodLibrary(options);await lib.refresh();
	t.after(async()=>{await lib.flushIndex();await rm(dir,{recursive:true,force:true});});
	return {lib,state,options,dir};
}

test('saved canonical episodes and series details survive restart with no upstream requests',async t=>{
	const {lib,state,options,dir}=await fixture(t);
	const first=JSON.parse(JSON.stringify(await lib.episodes('dispatch-series-7')));await lib.flushIndex();
	const file=await readFile(path.join(dir,'catalogue.json.series.json'),'utf8');assert.ok(!file.includes('secret'));
	const restarted=createVodLibrary({...options,dispatcharr:{status:()=>({connected:true}),api:async()=>{throw Error('must not fetch');}},localItem:async()=>{throw Error('must not fetch');},localItems:async()=>{throw Error('must not fetch');}});
	assert.deepEqual(await restarted.episodes('local-show'),first);
	assert.deepEqual(await restarted.episodes('dispatch-series-7'),first);
	assert.equal((await restarted.item('dispatch-series-7')).Id,'local-show');assert.equal(state.episodeCalls,1);
});

test('new-episode shelf reads streamed episodes from the existing index without a provider request',async t=>{
	const {lib,state}=await fixture(t);await lib.episodes('local-show');const calls=state.episodeCalls;
	assert.deepEqual((await lib.releasedEpisodes()).map(e=>e.Id),['dispatch-episode-2-7']);
	assert.equal(state.episodeCalls,calls);
});

test('a restored series gets repaired presentation without changing its saved episodes or alias identity',async t=>{
	const {lib,options}=await fixture(t);
	Object.assign(await options.localItem(),{ProductionYear:2014,PremiereDate:'2017-08-29T00:00:00Z'});
	const episodes=JSON.parse(JSON.stringify(await lib.episodes('local-show')));await lib.flushIndex();
	const metadata=createVodMetadata({lookup:async()=>({id:44,firstAirDate:'2017-08-29',posterPath:'/current.jpg'})});
	const restarted=createVodLibrary({...options,metadata});
	const item=await restarted.item('dispatch-series-7');
	assert.equal(item.Id,'local-show');assert.equal(item.RequestedId,'dispatch-series-7');assert.equal(item.ProductionYear,2017);
	assert.equal(item.Artwork,'/api/web/tmdb-art/tv/44/poster');assert.deepEqual(await restarted.episodes('local-show'),episodes);
	const list=await restarted.list({type:'tvshows'});assert.equal(list.items[0].ProductionYear,2017);
});

test('expired lists return immediately while one background refresh picks up new local episodes',async t=>{
	const {lib,state}=await fixture(t);
	await lib.episodes('local-show');state.now+=3600001;state.rows=3;state.localRows=2;
	let release;state.gate=new Promise(resolve=>release=resolve);
	const immediate=await Promise.race([lib.episodes('dispatch-series-7'),new Promise((_,reject)=>setTimeout(()=>reject(Error('blocked on upstream')),150))]);
	assert.deepEqual(immediate.items.map(e=>e.Id),['local-1','dispatch-episode-2-7']);
	for(let i=0;i<10;i++)await lib.episodes('local-show');
	// Wait for the single coalesced background request to enter the provider gate.
	for(let i=0;i<20&&state.infoCalls<2;i++)await new Promise(r=>setTimeout(r,1));
	assert.equal(state.infoCalls,2);release();state.gate=null;
	await lib.refreshEpisodes('local-show',{force:true});
	const updated=await lib.episodes('dispatch-series-7');
	assert.deepEqual(updated.items.map(e=>e.Id),['local-1','local-2','dispatch-episode-3-7']);
});

test('failed refresh retains saved episodes and backs off instead of hammering the provider',async t=>{
	const {lib,state}=await fixture(t);const previous=await lib.episodes('local-show');state.now+=3600001;state.fail=true;
	await lib.refreshEpisodes('local-show',{force:true});
	const calls=state.infoCalls;for(let i=0;i<5;i++)assert.deepEqual(await lib.episodes('dispatch-series-7'),previous);
	assert.equal(state.infoCalls,calls);assert.ok(!JSON.stringify(lib.status()).includes('secret'));
	state.fail=false;state.rows=1;state.now+=300001;await lib.refreshEpisodes('local-show');
	assert.deepEqual((await lib.episodes('local-show')).items.map(e=>e.Id),['local-1']);
});

test('hourly preparation runs without browsing, coalesces sweeps and limits untouched VOD warmup',async t=>{
	const {lib,state}=await fixture(t);
	state.extra=Array.from({length:80},(_,i)=>({id:i+10,name:'New show '+i,tmdb_id:i+110,year:2026}));
	await Promise.all([lib.refreshSeriesIndex({force:true}),lib.refreshSeriesIndex({force:true})]);
	const status=lib.status().seriesIndex;
	assert.equal(status.running,false);assert.equal(status.total,21);assert.equal(status.completed,21);assert.equal(status.cached,21);
	assert.equal(state.infoCalls,21);
	assert.equal((await lib.episodes('local-show')).items.length,2);assert.equal(state.infoCalls,21);
	state.localRows=2;state.now+=3600001;await lib.refreshSeriesIndex({force:true});
	assert.equal((await lib.episodes('local-show')).items[1].Source,'local');assert.equal(state.infoCalls,42);
});

test('episode search uses the saved merged index without opening streams or fetching every series',async t=>{
	const {lib,state}=await fixture(t);await lib.episodes('local-show');
	const calls=state.episodeCalls;const found=await lib.searchEpisodes('Episode');
	assert.equal(found.length,1);assert.equal(found[0].Type,'Episode');assert.equal(state.episodeCalls,calls);
	assert.equal((await lib.searchEpisodes('Local')).length,1);
});
