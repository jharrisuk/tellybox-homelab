import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createVodLibrary,vodView} from '../vod-library.mjs';

const HOUR=3600000,NOW=Date.parse('2026-11-11T00:00:00Z');

function remoteRow(id){return {id,name:`Show ${id}`,tmdb_id:1000+id,year:2026,description:'Test show'};}
function savedEntry(id,time,access=time){
	return {
		series:{Id:`dispatch-series-${id}`,Name:`Show ${id}`,Type:'Series',Source:'streamed',VodIds:[id],Provider:'Dispatcharr',PremiereDate:'2026-01-01'},
		value:{items:[{Id:`dispatch-episode-${id}-${id}`,Name:`Saved ${id}`,Type:'Episode',ParentIndexNumber:1,IndexNumber:1,SeriesId:`dispatch-series-${id}`}],notice:''},
		time,retry:0,access
	};
}

async function fixture(t,{ids=[],saved=[],catalogueTime=NOW,failIds=[],delayMs=0}={}){
	const directory=await mkdtemp(path.join(os.tmpdir(),'vod-series-index-113-'));
	const rows=ids.map(remoteRow);
	const state={now:NOW,calls:{catalogue:0,details:0,info:0,episodes:0},infoIds:[],episodeIds:[],inFlight:0,maxInFlight:0,failIds:new Set(failIds)};
	const episodesFor=id=>[{id:id*10+1,name:`New ${id} E1`,series:{id,name:`Show ${id}`},season_number:1,episode_number:1}];
	const dispatcharr={status:()=>({connected:true}),api:async route=>{
		if(route.startsWith('/api/vod/movies/'))return [];
		if(route.startsWith('/api/vod/series/?')){state.calls.catalogue++;return {results:rows,next:null};}
		if(route.includes('/provider-info/')){
			const id=Number(/\/series\/(\d+)\/provider-info\//.exec(route)[1]);
			state.calls.info++;state.infoIds.push(id);
			if(state.failIds.has(id))throw Error('upstream provider failure');
			return {};
		}
		if(route.includes('/episodes/')){
			const id=Number(/\/series\/(\d+)\/episodes\//.exec(route)[1]);
			state.calls.episodes++;state.episodeIds.push(id);
			state.inFlight++;state.maxInFlight=Math.max(state.maxInFlight,state.inFlight);
			try{
				if(delayMs)await new Promise(resolve=>setTimeout(resolve,delayMs));
				if(state.failIds.has(id))throw Error('upstream episode failure');
				return episodesFor(id);
			}finally{state.inFlight--;}
		}
		const detail=/^\/api\/vod\/series\/(\d+)\/$/.exec(route);
		if(detail){state.calls.details++;return remoteRow(Number(detail[1]));}
		return [];
	}};
	const catalogueFile=path.join(directory,'catalogue.json');
	await writeFile(catalogueFile,JSON.stringify({items:ids.map(id=>vodView(remoteRow(id),'Series')),time:catalogueTime}),{mode:0o600});
	if(saved.length)await writeFile(catalogueFile+'.series.json',JSON.stringify({version:1,updated:777,entries:saved}),{mode:0o600});
	const lib=createVodLibrary({dispatcharr,file:catalogueFile,clock:()=>state.now,localItems:async()=>[],localItem:async()=>{throw Error('no local item');},localEpisodes:async()=>[]});
	t.after(async()=>{await lib.flushIndex();await rm(directory,{recursive:true,force:true});});
	return {lib,state,directory,catalogueFile};
}

function savedIds(state){return [...state.infoIds].sort((a,b)=>a-b);}

test('fresh saved series lists are skipped by the default bounded sweep',async t=>{
	const ids=[1,2,3];
	const {lib,state}=await fixture(t,{ids,saved:ids.map(id=>savedEntry(id,NOW-HOUR))});
	const result=await lib.refreshSeriesIndex();
	assert.equal(result.deferred,false);assert.equal(result.total,0);assert.equal(result.refreshed,0);
	assert.equal(state.calls.info,0);assert.equal(state.calls.episodes,0);assert.equal(state.calls.catalogue,0);
	const status=lib.status().seriesIndex;
	assert.equal(status.completed,0);assert.equal(status.cached,3);
});

test('only entries older than staleMs are selected',async t=>{
	const ids=Array.from({length:10},(_,i)=>i+1);
	const saved=ids.map(id=>savedEntry(id,id<=5?NOW-7*HOUR:NOW-HOUR));
	const {lib,state}=await fixture(t,{ids,saved});
	const result=await lib.refreshSeriesIndex({staleMs:6*HOUR});
	assert.equal(result.deferred,false);assert.equal(result.total,5);assert.equal(result.refreshed,5);
	assert.deepEqual(savedIds(state),[1,2,3,4,5]);
	assert.deepEqual(state.episodeIds,[1,2,3,4,5]);
	assert.equal(state.calls.info,5);assert.equal(state.calls.episodes,5);
	assert.equal(lib.status().seriesIndex.completed,5);
});

test('the sweep is capped to batchSize even with a large stale catalogue',async t=>{
	const ids=Array.from({length:100},(_,i)=>i+1);
	const {lib,state}=await fixture(t,{ids,saved:ids.map(id=>savedEntry(id,NOW-7*HOUR))});
	const result=await lib.refreshSeriesIndex();
	assert.equal(result.deferred,false);assert.equal(result.batchSize,24);assert.equal(result.total,24);
	assert.equal(result.refreshed,24);assert.equal(result.skipped,76);
	assert.equal(state.calls.info,24);assert.equal(state.calls.episodes,24);
	assert.equal(lib.status().seriesIndex.total,24);assert.equal(lib.status().seriesIndex.completed,24);
	// A second immediate run skips the fresh results and selects the next stale slice.
	const second=await lib.refreshSeriesIndex();
	assert.equal(second.total,24);assert.equal(state.calls.info,48);assert.ok(state.calls.info<100);
});

test('concurrency is capped at two even when a larger value is requested',async t=>{
	const ids=Array.from({length:24},(_,i)=>i+1);
	const {lib,state}=await fixture(t,{ids,saved:ids.map(id=>savedEntry(id,NOW-7*HOUR)),delayMs:3});
	const result=await lib.refreshSeriesIndex({concurrency:99});
	assert.equal(result.deferred,false);assert.equal(result.concurrency,2);assert.equal(result.total,24);
	assert.equal(state.calls.episodes,24);
	assert.ok(state.maxInFlight<=2,`expected at most 2 in flight, saw ${state.maxInFlight}`);
	assert.ok(state.maxInFlight>1,`expected overlap between workers, saw ${state.maxInFlight}`);
});

test('busy playback defers without touching the catalogue or episode cache',async t=>{
	const ids=Array.from({length:20},(_,i)=>i+1);
	const {lib,state}=await fixture(t,{ids,saved:ids.map(id=>savedEntry(id,NOW-7*HOUR))});
	const result=await lib.refreshSeriesIndex({isBusy:()=>true});
	assert.equal(result.deferred,true);assert.equal(result.reason,'busy');
	assert.equal(state.calls.info,0);assert.equal(state.calls.episodes,0);assert.equal(state.calls.details,0);assert.equal(state.calls.catalogue,0);
	const status=lib.status().seriesIndex;
	assert.equal(status.completed,0);assert.equal(status.updated,777);
});

test('one failed series keeps its saved list while the sweep continues',async t=>{
	const ids=[1,2,3,4,5,6];
	const {lib,state,directory}=await fixture(t,{ids,saved:ids.map(id=>savedEntry(id,NOW-7*HOUR)),failIds:[3]});
	const result=await lib.refreshSeriesIndex();
	assert.equal(result.deferred,false);
	// The failure must not stop later entries.
	assert.deepEqual(savedIds(state),[1,2,3,4,5,6]);
	assert.equal(state.calls.info,6);
	assert.match(lib.status().seriesIndex.error,/could not be refreshed/);
	await lib.flushIndex();
	const data=JSON.parse(await readFile(path.join(directory,'catalogue.json.series.json'),'utf8'));
	const failed=data.entries.find(entry=>entry.series.Id==='dispatch-series-3');
	const refreshed=data.entries.find(entry=>entry.series.Id==='dispatch-series-1');
	assert.deepEqual(failed.value.items.map(item=>item.Name),['Saved 3']);
	assert.deepEqual(refreshed.value.items.map(item=>item.Name),['New 1 E1']);
});

test('a stale catalogue is refreshed but a fresh catalogue is not re-downloaded',async t=>{
	const stale=await fixture(t,{ids:[1,2,3],saved:[],catalogueTime:NOW-7*HOUR});
	const staleResult=await stale.lib.refreshSeriesIndex();
	assert.equal(staleResult.deferred,false);
	assert.equal(stale.state.calls.catalogue,1);
	assert.equal(stale.lib.status().indexed,3);

	const fresh=await fixture(t,{ids:[1,2,3],saved:[],catalogueTime:NOW});
	await fresh.lib.refreshSeriesIndex();
	assert.equal(fresh.state.calls.catalogue,0);
});

test('355 cached series are not all refreshed by the hourly schedule',async t=>{
	const ids=Array.from({length:355},(_,i)=>i+1);
	const saved=ids.map(id=>savedEntry(id,NOW-2*HOUR));
	const {lib,state}=await fixture(t,{ids,saved});
	// An hourly timer firing one hour later must not force all 355 series.
	state.now+=HOUR;
	const first=await lib.refreshSeriesIndex();
	assert.equal(first.total,0);assert.equal(first.refreshed,0);
	assert.equal(state.calls.info,0);assert.equal(state.calls.episodes,0);
	// Once the saved lists really are stale, only one bounded batch is fetched.
	state.now+=4*HOUR;
	const stale=await lib.refreshSeriesIndex();
	assert.equal(stale.total,24);assert.equal(stale.refreshed,24);
	assert.equal(state.calls.info,24);assert.equal(state.calls.episodes,24);
	assert.ok(state.calls.info<355);
	// The server scheduler uses the bounded non-forced path with a busy check.
	const source=await readFile(new URL('../server.mjs',import.meta.url),'utf8');
	assert.doesNotMatch(source,/refreshSeriesIndex\(\{\s*force\s*:\s*true\s*\}\)[^\n]{0,40}3600000/);
	assert.match(source,/refreshSeriesIndex\(\{isBusy:(?:playbackBusy|backgroundBusy)\}\)/);
});
