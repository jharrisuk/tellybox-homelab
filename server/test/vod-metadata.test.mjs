import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createVodMetadata,metadataView,artworkPath} from '../vod-metadata.mjs';
import {vodView} from '../vod-library.mjs';

const movie={Id:'dispatch-movie-20',Name:'Provider title',Type:'Movie',Source:'streamed',Provider:'Provider A',ProviderIds:{Tmdb:'55'},VodIds:[20],Artwork:'/api/web/art/movie/20',RunTimeTicks:900};
const data={id:55,title:'Metadata title',overview:'A proper description',releaseDate:'2026-09-12',voteAverage:8.34,voteCount:901,runtime:95,genres:[{name:'Documentary'}],posterPath:'/poster.jpg',backdropPath:'/backdrop.jpg',
	relatedVideos:[{type:'Trailer',site:'YouTube',key:'dQw4w9WgXcQ',name:'Official trailer',official:true}]};
test('VOD enrichment adds attributed metadata and preserves playback identity and measured duration',async()=>{
	let calls=0;const service=createVodMetadata({lookup:async(type,id)=>{calls++;assert.equal(type,'movie');assert.equal(id,55);return data;}});
	const [item]=await service.enrich([movie]);
	assert.equal(item.Id,movie.Id);assert.equal(item.Name,movie.Name);assert.equal(item.Provider,'Provider A');assert.deepEqual(item.VodIds,[20]);assert.equal(item.RunTimeTicks,900);
	assert.equal(item.Overview,data.overview);assert.equal(item.PremiereDate,'2026-09-12');assert.equal(item.Ratings[0].source,'TMDB');assert.equal(item.Ratings[0].value,8.3);assert.equal(item.Ratings[0].votes,901);
	assert.equal(item.Artwork,'/api/web/tmdb-art/movie/55/poster');assert.equal(await service.artwork('movie',55,'poster'),'/poster.jpg');
	assert.deepEqual(item.Trailer,{Provider:'YouTube',Key:'dQw4w9WgXcQ',Name:'Official trailer',Url:'https://www.youtube.com/watch?v=dQw4w9WgXcQ'});
	await service.enrich([movie,movie]);assert.equal(calls,1);
});
test('missing or invalid trailers do not add a watch action',async()=>{
	const service=createVodMetadata({lookup:async()=>({...data,relatedVideos:[{type:'Trailer',site:'YouTube',key:'bad'}]})});
	assert.equal((await service.enrich([movie]))[0].Trailer,undefined);
});
test('unavailable metadata preserves provider fields and backs off; stale good metadata remains usable',async()=>{
	let time=100,fail=false,calls=0;const service=createVodMetadata({clock:()=>time,ttl:10,lookup:async()=>{calls++;if(fail)throw Error('offline');return data;}});
	await service.enrich([movie]);time=200;fail=true;
	assert.equal((await service.enrich([movie]))[0].Overview,data.overview);
	await service.enrich([movie]);assert.equal(calls,2);
	const empty=createVodMetadata({lookup:async()=>{throw Error('offline');}});assert.deepEqual((await empty.enrich([movie]))[0],movie);
});
test('local titles and unidentified VOD titles do not trigger lookups; types are separate',async()=>{
	const calls=[];const service=createVodMetadata({lookup:async(type,id)=>{calls.push(type);return {...data,id};}});
	await service.enrich([{...movie,Source:'local'},{...movie,ProviderIds:{}},{...movie,Type:'Series'},movie]);assert.deepEqual(calls.sort(),['movie','tv']);
});
test('concurrent pages coalesce requests and bound upstream concurrency',async()=>{
	let active=0,peak=0,calls=0;const service=createVodMetadata({concurrency:2,lookup:async(type,id)=>{calls++;active++;peak=Math.max(peak,active);await new Promise(r=>setTimeout(r,10));active--;return {...data,id};}});
	const items=Array.from({length:6},(_,i)=>({...movie,ProviderIds:{Tmdb:String(i+1)}}));
	await Promise.all([service.enrich(items),service.enrich(items)]);assert.equal(peak,2);assert.equal(calls,6);
});
test('persisted metadata from an older presentation schema is refreshed once, not served until TTL',async t=>{
	const directory=mkdtempSync(path.join(tmpdir(),'tellybox-vod-metadata-'));
	t.after(()=>rmSync(directory,{recursive:true,force:true}));
	const file=path.join(directory,'vod-metadata.json');
	const legacy={Overview:'Old cached description',Genres:['Documentary'],poster:'/old.jpg'};
	writeFileSync(file,JSON.stringify([['movie/55',{time:Date.now(),retry:Date.now()+7*86400000,data:legacy}]]));
	let calls=0;
	const service=createVodMetadata({file,lookup:async()=>{calls++;return data;}});
	const [item]=await service.enrich([movie]);
	assert.equal(calls,1,'legacy cache entries must be refreshed after a presentation schema change');
	assert.deepEqual(item.Trailer,{Provider:'YouTube',Key:'dQw4w9WgXcQ',Name:'Official trailer',Url:'https://www.youtube.com/watch?v=dQw4w9WgXcQ'});
	assert.equal(item.Overview,data.overview);
});

test('invalid identity and artwork cannot redirect a VOD title to an arbitrary source',()=>{
	assert.throws(()=>metadataView({...data,id:99},'movie',55));
	for(const path of ['//evil.test/a.jpg','/../../a.jpg','https://evil.test/a.jpg','/a.svg'])assert.equal(artworkPath(path),null);
	const item=vodView({id:1,name:'Episode',series:{id:4},year:2020},'Episode');assert.equal(item.PremiereDate,undefined);
});

test('conflicting local series year/artwork use exact TMDB metadata without changing local identity or curated consistent titles',async()=>{
	let calls=0;
	const service=createVodMetadata({lookup:async(type,id)=>{calls++;assert.equal(type,'tv');assert.equal(id,55);return {...data,firstAirDate:'2017-08-29'};}});
	const local={Id:'local-show',Name:'My series',Source:'local',Type:'Series',ProviderIds:{Tmdb:'55'},ProductionYear:2014,PremiereDate:'2017-08-29T00:00:00Z',Overview:'Local description',CommunityRating:9,VodIds:[3]};
	const consistent={...local,Id:'custom-show',ProductionYear:2017,Artwork:'/custom-poster'};
	const [fixed,untouched]=await service.enrich([local,consistent]);
	assert.equal(calls,1);assert.equal(fixed.ProductionYear,2017);assert.equal(fixed.Artwork,'/api/web/tmdb-art/tv/55/poster');
	assert.equal(fixed.Id,local.Id);assert.equal(fixed.Source,'local');assert.equal(fixed.Overview,local.Overview);assert.equal(fixed.CommunityRating,9);assert.deepEqual(fixed.VodIds,[3]);
	assert.deepEqual(untouched,consistent);assert.equal(local.ProductionYear,2014);
	const offline=createVodMetadata({lookup:async()=>{throw Error('offline');}});assert.deepEqual((await offline.enrich([local]))[0],local);
});
