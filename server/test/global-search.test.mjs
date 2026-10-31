import test from 'node:test';
import assert from 'node:assert/strict';
import {createGlobalSearch} from '../global-search.mjs';

test('playable results do not wait for or require discovery; search never creates a request',async()=>{
	const search=createGlobalSearch({library:{list:async q=>({items:[{Id:'local'}],total:1,query:q})},discover:{browse:()=>{throw Error('unavailable');},request:()=>{throw Error('Search must not request');}}});
	const result=await search({q:' Arrival ',scope:'available'});
	assert.equal(result.items[0].Id,'local');assert.equal(result.query.search,'Arrival');
	assert.equal((await search({q:'   '})).items.length,0);
});

test('wider search removes indexed duplicates by media identity, keeps remakes/types separate and preserves pending requests',async()=>{
	const catalogue=[{Id:'local',Type:'Movie',ProviderIds:{Tmdb:'1'}},{Id:'dispatch-series-2',Type:'Series',ProviderIds:{Tmdb:'2'}}];
	const rows=[{id:1,type:'movie'},{id:2,type:'tv',vodId:'dispatch-series-2'},
		{id:1,type:'tv',requestable:true,statusLabel:'Not requested'},
		{id:3,type:'movie',requestable:true,statusLabel:'Not requested'},
		{id:4,type:'movie',requestable:false,statusLabel:'Requested'},
		{id:5,type:'tv',vodAvailable:true,vodId:'other-series',statusLabel:'Not requested'}];
	const search=createGlobalSearch({library:{searchMatches:async()=>catalogue},discover:{browse:async(q,page,type)=>{assert.equal(q,'Film');assert.equal(page,2);assert.equal(type,'all');return {items:rows,page:2,pages:4};}}});
	const result=await search({q:'Film',scope:'more',page:'2'});
	assert.deepEqual(result.items.map(i=>`${i.type}:${i.id}`),['tv:1','movie:3','movie:4','tv:5']);
	assert.equal(result.items[0].statusLabel,'Add to local library');assert.equal(result.items[2].statusLabel,'Requested');
	assert.equal(result.items[3].vodAvailable,true);assert.equal(result.pages,4);
});

test('invalid searches fail before upstream calls and empty filtered pages retain pagination',async()=>{
	const search=createGlobalSearch({library:{searchMatches:async()=>[{Id:'local',Type:'Movie',ProviderIds:{Tmdb:'1'}}]},discover:{browse:async()=>({items:[{id:1,type:'movie'}],page:1,pages:2})}});
	for(const q of [{},{q:['x']},{q:'x'.repeat(201)},{q:'x',page:0},{q:'x',start:-1},{q:'x',scope:'request'},{q:'x',type:'person'}])await assert.rejects(search(q),e=>e.status===400);
	const result=await search({q:'x',scope:'more'});assert.deepEqual(result.items,[]);assert.equal(result.pages,2);
});

test('VOD-only search matches remain requestable while existing local copies are deduplicated',async()=>{
	const catalogue=[{Id:'dispatch-movie-1',Source:'streamed',Type:'Movie',ProviderIds:{Tmdb:'1'}},
		{Id:'local',Source:'local',Type:'Movie',ProviderIds:{Tmdb:'2'}}];
	const rows=[{id:1,type:'movie',vodAvailable:true,vodId:'dispatch-movie-1',requestable:true,statusLabel:'Not requested'},
		{id:2,type:'movie',watchId:'local',requestable:false}];
	const search=createGlobalSearch({library:{searchMatches:async()=>catalogue},discover:{browse:async()=>({items:rows,page:1,pages:1})}});
	const result=await search({q:'Film',scope:'more'});
	assert.deepEqual(result.items,rows.slice(0,1));
	assert.equal(result.items[0].requestable,true);
	assert.equal(result.items[0].vodAvailable,true);
});

test('global channels and episode sections include live and nonstop, deduplicate and paginate independently',async()=>{
	const channels=Array.from({length:65},(_,n)=>({Id:'c'+n,Name:'BBC '+n,Type:'TvChannel',Nonstop:n%2===0}));
	const search=createGlobalSearch({library:{searchEpisodes:async()=>[{Id:'ep',Name:'Pilot',SeriesName:'BBC Story',Type:'Episode'},{Id:'ep',Name:'Pilot',SeriesName:'BBC Story',Type:'Episode'}]},channels:async()=>channels,discover:{browse:()=>{throw Error('not needed');}}});
	const first=await search({q:'BBC',scope:'channels'}),second=await search({q:'BBC',scope:'channels',start:60});
	assert.equal(first.total,65);assert.equal(first.items.length,60);assert.equal(second.items.length,5);
	assert.equal(new Set([...first.items,...second.items].map(i=>i.Id)).size,65);assert.ok(first.items.some(i=>i.Nonstop)&&first.items.some(i=>!i.Nonstop));
	assert.equal((await search({q:'BBC',scope:'episodes'})).items.length,1);
	assert.equal((await search({q:'BBC',scope:'channels',type:'movie'})).items.length,0);
});
