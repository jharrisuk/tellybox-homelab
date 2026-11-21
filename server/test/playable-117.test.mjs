import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createVodLibrary,vodView} from '../vod-library.mjs';

const NOW=Date.parse('2026-11-12T00:00:00Z');

const remoteRow=id=>({id,name:'Show '+id,tmdb_id:5000+id,year:2026});
const catalogue=ids=>ids.map(id=>vodView(remoteRow(id),'Series'));
const savedEntry=(id,items,extra={})=>({
	series:vodView(remoteRow(id),'Series'),
	value:{items,notice:''},time:NOW,retry:0,access:NOW,...extra
});
const episode=(seriesId,{id=seriesId*100,name='Episode',date}={})=>({
	Id:'dispatch-episode-'+id+'-'+seriesId,Name:name,Type:'Episode',Source:'streamed',
	ParentIndexNumber:1,IndexNumber:1,...(date?{PremiereDate:date}:{})
});

async function streamedFixture(t,{ids=[],saved=[],failIds=[]}={}) {
	const directory=await mkdtemp(path.join(os.tmpdir(),'playable-117-'));
	const file=path.join(directory,'catalogue.json');
	await writeFile(file,JSON.stringify({items:catalogue(ids),time:NOW}));
	if(saved.length)await writeFile(file+'.series.json',JSON.stringify({version:1,updated:NOW,entries:saved}));
	const failing=new Set(failIds);
	const calls={details:0,providerInfo:0,episodes:0};
	const dispatcharr={status:()=>({connected:true}),api:async route=>{
		const detail=/^\/api\/vod\/series\/(\d+)\/$/.exec(route);
		if(detail){calls.details++;return remoteRow(Number(detail[1]));}
		const provider=/\/series\/(\d+)\/provider-info\//.exec(route);
		if(provider){calls.providerInfo++;if(failing.has(Number(provider[1])))throw Error('provider failed');return {};}
		const episodes=/\/series\/(\d+)\/episodes\//.exec(route);
		if(episodes){calls.episodes++;const id=Number(episodes[1]);if(failing.has(id))throw Error('provider failed');return [{id:id*100,name:'Episode',series:{id,name:'Show '+id},season_number:1,episode_number:1}];}
		return {results:[],next:null};
	}};
	const lib=createVodLibrary({dispatcharr,file,clock:()=>NOW,localItems:async()=>[],localItem:async()=>null,localEpisodes:async()=>[]});
	t.after(async()=>{await lib.flushIndex();await rm(directory,{recursive:true,force:true});});
	return {lib,calls};
}

test('normal browse hides zero-episode local series and keeps a playable local series without provider work',async t=>{
	const directory=await mkdtemp(path.join(os.tmpdir(),'playable-117-local-'));
	const file=path.join(directory,'catalogue.json');
	await writeFile(file,JSON.stringify({items:[],time:NOW}));
	const local=[
		{Id:'empty-local',Name:'Empty local',Type:'Series',ChildCount:2,ProviderIds:{Tmdb:'7001'}},
		{Id:'playable-local',Name:'Playable local',Type:'Series',ChildCount:2,ProviderIds:{Tmdb:'7002'}},
		{Id:'zero-local',Name:'Zero local',Type:'Series',ChildCount:0,ProviderIds:{Tmdb:'7003'}}
	];
	const calls={dispatch:0,local:0};
	const dispatcharr={status:()=>({connected:true}),api:async()=>{calls.dispatch++;throw Error('local views must not call Dispatcharr');}};
	const lib=createVodLibrary({dispatcharr,file,clock:()=>NOW,localItems:async()=>local,localItem:async()=>null,
		localEpisodes:async id=>{calls.local++;return id==='playable-local'?[{Id:'local-episode',Name:'Pilot',Type:'Episode',ParentIndexNumber:1,IndexNumber:1}]:[];}});
	t.after(async()=>{await lib.flushIndex();await rm(directory,{recursive:true,force:true});});

	const normal=await lib.list({type:'tvshows'});
	assert.deepEqual(normal.items.map(item=>item.Id),['playable-local']);
	assert.equal(normal.total,1);
	assert.equal(normal.availability.pending,0);
	assert.equal(calls.dispatch,0,'normal local verification must stay on Jellyfin');

	const localOnly=await lib.list({source:'local',type:'tvshows'});
	assert.deepEqual(localOnly.items.map(item=>item.Id),['playable-local']);
	assert.equal(calls.dispatch,0,'a local-only list must make zero Dispatcharr calls');

	// A known-empty local series is still discoverable, but must not offer a
	// Watch/local CTA as if it were playable.
	const rows=await lib.availability([{id:'7001',type:'tv'},{id:'7002',type:'tv'},{id:'7003',type:'tv'}]);
	assert.equal(rows[0].watchId,undefined);
	assert.equal(rows[0].statusLabel,undefined);
	assert.equal(rows[1].watchId,'playable-local');
	assert.equal(rows[2].watchId,undefined);
});

test('an uncached local series gets no Watch CTA until playable episodes are verified',async t=>{
	const directory=await mkdtemp(path.join(os.tmpdir(),'playable-117-uncached-'));
	const file=path.join(directory,'catalogue.json');
	await writeFile(file,JSON.stringify({items:[],time:NOW}));
	const local=[{Id:'late-local',Name:'Late local',Type:'Series',ChildCount:2,ProviderIds:{Tmdb:'7101'}}];
	let now=NOW;
	let loadEpisodes=async()=>{throw Error('Jellyfin unavailable');};
	const lib=createVodLibrary({dispatcharr:{status:()=>({connected:false})},file,clock:()=>now,
		localItems:async()=>local,localItem:async()=>local,localEpisodes:id=>loadEpisodes(id)});
	t.after(async()=>{await lib.flushIndex();await rm(directory,{recursive:true,force:true});});

	const before=await lib.availability([{id:'7101',type:'tv',title:'Late local'}]);
	assert.equal(before[0].watchId,undefined,'an unverified local series must not claim a local Watch CTA');
	assert.equal(before[0].statusLabel,undefined);

	loadEpisodes=async()=>[{Id:'local-episode',Name:'Pilot',Type:'Episode',ParentIndexNumber:1,IndexNumber:1}];
	now+=61000;
	const after=await lib.availability([{id:'7101',type:'tv',title:'Late local'}]);
	assert.equal(after[0].watchId,'late-local');
	assert.equal(after[0].statusLabel,'In your library');
});

test('streamed cached-empty, cached-available, unknown and failed series get distinct states',async t=>{
	const ids=[1,2,3,4,5];
	const saved=[
		savedEntry(1,[]),
		savedEntry(2,[episode(2,{id:21})]),
		savedEntry(5,[episode(5,{id:51,name:'Future',date:'2999-01-01'})])
	];
	const {lib,calls}=await streamedFixture(t,{ids,saved,failIds:[4]});

	const list=await lib.list({type:'tvshows'});
	assert.deepEqual(list.items.map(item=>item.Id),['dispatch-series-2','dispatch-series-3']);
	assert.equal(list.total,2);
	assert.equal(list.availability.pending,1,'the failed series is still pending');
	assert.equal(list.availability.checked,2,'only the two unknown series were checked');
	assert.equal(list.availability.queued,0,'a backed-off failure is not requeued');
	assert.ok(calls.episodes<ids.length,'one page must not verify the whole catalogue');

	const states=await lib.verifySeries(['dispatch-series-1','dispatch-series-2','dispatch-series-5']);
	assert.equal(states.states.get('dispatch-series-1'),'empty','a complete saved list with no playable episodes is empty');
	assert.equal(states.states.get('dispatch-series-2'),'available');
	assert.equal(states.states.get('dispatch-series-5'),'empty','only future premieres are not playable');
	const failed=await lib.verifySeries(['dispatch-series-4']);
	assert.equal(failed.states.get('dispatch-series-4'),'unknown','provider failure must never become empty');

	// Discover and Search still expose the unavailable titles.
	const rows=await lib.availability([{id:'5001',type:'tv',title:'Show 1'},{id:'5005',type:'tv',title:'Show 5'}]);
	assert.equal(rows[0].vodId,'dispatch-series-1');
	assert.equal(rows[0].vodAvailable,true);
	assert.equal(rows[1].vodId,'dispatch-series-5');
	const matches=await lib.searchMatches('Show 1','tvshows');
	assert.ok(matches.some(item=>item.Id==='dispatch-series-1'),'search keeps a known-empty title');
	const episodes=await lib.searchEpisodes('Future');
	assert.deepEqual(episodes.map(item=>item.Id),['dispatch-episode-51-5'],'episode search keeps an unplayable future episode');
});

test('a local empty copy is hidden while a separately identified streamed duplicate can stay playable',async t=>{
	const directory=await mkdtemp(path.join(os.tmpdir(),'playable-117-duplicate-'));
	const file=path.join(directory,'catalogue.json');
	const local={Id:'local-empty-dup',Name:'Duplicate show',Type:'Series',ChildCount:2,VodIds:[9]};
	const streamed=vodView({id:9,name:'Duplicate show',tmdb_id:9009,year:2026},'Series');
	await writeFile(file,JSON.stringify({items:[streamed],time:NOW}));
	// The saved list is a local series whose only episodes are streamed ones:
	// that proves the streamed duplicate, not the empty local copy.
	await writeFile(file+'.series.json',JSON.stringify({version:1,updated:NOW,entries:[{
		series:{...local,Source:'local'},value:{items:[episode(9,{id:91})],notice:''},time:NOW,retry:0,access:NOW
	}]}));
	let dispatch=0,localCalls=0;
	const dispatcharr={status:()=>({connected:true}),api:async route=>{
		dispatch++;
		const detail=/^\/api\/vod\/series\/(\d+)\/$/.exec(route);
		if(detail)return remoteRow(Number(detail[1]));
		if(route.includes('/provider-info/'))return {};
		if(route.includes('/episodes/'))return [{id:91,name:'Episode',series:{id:9,name:'Duplicate show'},season_number:1,episode_number:1}];
		return {results:[],next:null};
	}};
	const lib=createVodLibrary({dispatcharr,file,clock:()=>NOW,localItems:async()=>[local],localItem:async()=>local,
		localEpisodes:async()=>{localCalls++;return [];}});
	t.after(async()=>{await lib.flushIndex();await rm(directory,{recursive:true,force:true});});

	const localOnly=await lib.list({source:'local',type:'tvshows'});
	assert.deepEqual(localOnly.items,[]);
	assert.equal(dispatch,0,'the empty local copy must not trigger provider work');
	assert.equal(localCalls,0,'a complete saved local list is reused without Jellyfin');

	const normal=await lib.list({type:'tvshows'});
	assert.deepEqual(normal.items.map(item=>item.Id),['dispatch-series-9']);
	assert.ok(!normal.items.some(item=>item.Id===local.Id),'the local copy stays hidden');
});

test('empty first candidates are replaced by playable titles and totals stay consistent',async t=>{
	const ids=Array.from({length:101},(_,index)=>index+1);
	const empty=new Set(ids.slice(0,40));
	const saved=ids.map(id=>savedEntry(id,empty.has(id)?[]:[episode(id,{id:id*100})]));
	const {lib,calls}=await streamedFixture(t,{ids,saved});

	const first=await lib.list({type:'tvshows'});
	assert.equal(first.items.length,60,'the page fills with playable replacements');
	assert.equal(first.total,61,'total is the verified playable count');
	assert.equal(first.hasMore,true);
	assert.equal(first.availability.checked,0,'saved states need no upstream checks');
	assert.ok(first.items.every(item=>!empty.has(Number(item.VodIds[0]))));

	const second=await lib.list({type:'tvshows',start:60});
	assert.equal(second.items.length,1);
	assert.equal(second.total,61);
	assert.equal(second.hasMore,false);
	const union=[...first.items,...second.items].map(item=>item.Id);
	assert.equal(new Set(union).size,61,'pages contain no duplicates');
	assert.ok(union.every(id=>!empty.has(Number(id.split('-').at(-1)))));
	assert.equal(calls.episodes,0);
});

test('appending pages verifies the prefix and does not skip a newly playable title',async t=>{
	const ids=Array.from({length:30},(_,index)=>index+1);
	const {lib}=await streamedFixture(t,{ids});

	const first=await lib.list({type:'tvshows'});
	assert.equal(first.items.length,24);
	assert.equal(first.total,24);

	// The second page verifies the prefix up to the requested page, so titles
	// that were unknown on the first page are resolved before slicing.
	const second=await lib.list({type:'tvshows',start:24});
	assert.equal(second.items.length,6);
	assert.equal(second.total,30);
	assert.equal(second.hasMore,false);

	const union=[...first.items,...second.items].map(item=>item.Id);
	assert.equal(new Set(union).size,30,'appended pages contain no duplicates');
	assert.equal(union.length,30,'no newly playable title is skipped');
});

test('series verification is bounded per request and cached for the next request',async t=>{
	const ids=Array.from({length:40},(_,index)=>index+1);
	const {lib,calls}=await streamedFixture(t,{ids});

	const first=await lib.list({type:'tvshows'});
	assert.equal(first.availability.checked,24,'one page verifies at most the bounded budget');
	assert.equal(first.availability.pending,16);
	assert.equal(first.availability.queued,16,'the rest of the window enters the bounded background queue');
	assert.equal(first.items.length,24);
	assert.equal(first.total,24);
	assert.equal(first.hasMore,true,'unverified series beyond the page may form another page');
	assert.equal(calls.episodes,24);
	assert.ok(calls.episodes<ids.length,'one request must not verify the whole catalogue');

	await lib.flushAvailability();
	assert.equal(calls.episodes,40,'the background queue finishes the bounded window');

	const second=await lib.list({type:'tvshows'});
	assert.equal(second.availability.checked,0,'the saved index is reused');
	assert.equal(second.availability.pending,0);
	assert.equal(second.items.length,40);
	assert.equal(second.total,40);
	assert.equal(calls.episodes,40,'a second request does not re-fetch cached series');
});
