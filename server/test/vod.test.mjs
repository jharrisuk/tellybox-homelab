import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {vodView,mergeLibrary,mergeEpisodes,createVodLibrary,ratingValue} from '../vod-library.mjs';
import {vodManifest,sniffContainer,vodUpstreamFailure} from '../vod-player.mjs';
import {createDispatcharr} from '../dispatcharr.mjs';

test('catalogue metadata excludes upstream accounts, credentials and stream URLs',()=>{
	const view=vodView({id:5,name:'Film (2025)',tmdb_id:7,imdb_id:'tt123',year:2025,m3u_account:{password:'secret'},stream_url:'https://private/secret',custom_properties:{token:'secret'}},'Movie');
	assert.equal(view.Name,'Film');assert.equal(view.Id,'dispatch-movie-5');assert.deepEqual(view.ProviderIds,{Tmdb:'7',Imdb:'tt123'});
	assert.ok(!JSON.stringify(view).includes('secret'));assert.equal(vodView({id:-1,name:'Bad'}),null);
});

test('named ratings never borrow a generic score',()=>{
	assert.equal(ratingValue({CommunityRating:9},'imdb'),null);
	assert.equal(ratingValue({Ratings:[{source:'Rotten Tomatoes',value:95,max:100}]},'rotten'),0.95);
	assert.equal(ratingValue({CommunityRating:8}),0.8);
});

test('VOD availability preserves local requests and media identity; categories, ratings and release shelves merge safely',async()=>{
	const directory=await mkdtemp(path.join(os.tmpdir(),'vod-discover-'));
	try{
		const now=Date.parse('2026-10-22T12:00:00Z');
		const local=[{Id:'local',Name:'Local nature',Type:'Movie',Genres:['Documentary'],ProviderIds:{Tmdb:'7'},PremiereDate:'2026-10-10',Ratings:[{source:'IMDb',value:8,max:10}]}];
		const d={status:()=>({connected:true}),api:async route=>({results:route.includes('/series/')?[{id:2,name:'Nature show',tmdb_id:7,year:2026}]:[{id:1,name:'Nature',tmdb_id:7,genre:'Documentary',year:2026},{id:3,name:'Other nature',tmdb_id:8,genre:'Documentary',year:2026},{id:4,name:'Future',tmdb_id:9,year:2027}],next:null})};
		const lib=createVodLibrary({file:path.join(directory,'cache.json'),dispatcharr:d,localItems:async()=>local,clock:()=>now});await lib.refresh();
		const result=await lib.availability([{id:7,type:'movie',watchId:'local',requestable:true},{id:7,type:'tv',requestable:true},{id:99,type:'movie'}]);
		assert.equal(result[0].vodId,'dispatch-movie-1');assert.equal(result[0].watchId,'local');assert.equal(result[0].requestable,true);assert.equal(result[1].vodId,'dispatch-series-2');assert.equal(result[2].vodAvailable,undefined);
		const list=await lib.list({type:'movies',genre:'Documentary',sort:'imdb'});assert.equal(list.total,2);assert.equal(list.items[0].Id,'local');assert.equal(list.items[1].Id,'dispatch-movie-3');
		const releases=await lib.releases('Movie');assert.equal(releases.length,2);assert.equal(releases[0].Id,'local');assert.ok(!releases.some(i=>i.Name==='Future'));
	}finally{await rm(directory,{recursive:true,force:true});}
});
test('local IDs win exact media matches, film/series types stay separate, ambiguous matches stay distinct',()=>{
	const local=[{Id:'local',Name:'Film',Type:'Movie',ProviderIds:{Tmdb:'7'}}];
	const remote=[vodView({id:1,name:'Film',tmdb_id:7}),vodView({id:2,name:'Film',tmdb_id:7},'Series'),vodView({id:3,name:'Film',tmdb_id:8})];
	const result=mergeLibrary(local,remote);assert.equal(result.length,3);assert.deepEqual(result[0].VodIds,[1]);assert.equal(result[0].Id,'local');assert.equal(result[0].Source,'local');
	assert.equal(mergeLibrary([...local,{...local[0],Id:'second'}],[remote[0]]).length,3);
});

test('Discover finds local titles without Seerr sync and avoids remakes, type collisions and ambiguous local IDs',async t=>{
	const directory=await mkdtemp(path.join(os.tmpdir(),'local-discover-'));t.after(()=>rm(directory,{recursive:true,force:true}));
	const local=[{Id:'local-show',Name:'The same title',Type:'Series',ProviderIds:{Tmdb:'55'}},
		{Id:'ambiguous-a',Type:'Series',ProviderIds:{Tmdb:'88'}},{Id:'ambiguous-b',Type:'Series',ProviderIds:{Tmdb:'88'}}];
	const options={file:path.join(directory,'cache.json'),dispatcharr:{status:()=>({connected:false})},localItems:async()=>local};
	const lib=createVodLibrary(options);
	const inputs=[{id:55,type:'tv',title:'The same title',watchId:null,statusLabel:'Not requested',requestable:true},
		{id:55,type:'movie'},{id:66,type:'tv',title:'The same title'},{id:88,type:'tv'}];
	const rows=await lib.availability(inputs);
	assert.equal(rows[0].watchId,'local-show');assert.equal(rows[0].statusLabel,'In your library');assert.equal(rows[0].requestable,true);
	assert.equal(inputs[0].watchId,null);for(const row of rows.slice(1))assert.equal(row.watchId,undefined);
	const offline=createVodLibrary({...options,localItems:async()=>{throw Error('Jellyfin unavailable');}});
	assert.deepEqual(await offline.availability(inputs),inputs);
});
test('episode merge fills gaps, keeps local copies and carries the canonical series identity',()=>{
	const episode=(id,season,number)=>({Id:id,Name:id,Type:'Episode',ParentIndexNumber:season,IndexNumber:number});
	const rows=mergeEpisodes([episode('local',1,1)],[episode('remote',1,1),episode('gap',1,2),episode('special',0,1)],{Id:'show',Name:'Show'});
	assert.deepEqual(rows.map(e=>e.Id),['special','local','gap']);assert.ok(rows.every(e=>e.SeriesId==='show'));assert.equal(rows[1].Source,'local');
});
test('catalogue paginates, persists safe views and retains its last complete index after a failed refresh',async()=>{
	const directory=await mkdtemp(path.join(os.tmpdir(),'vod-test-'));
	try {
		let failure=false,calls=0,now=Date.now();
		const d={status:()=>({connected:true}),api:async route=>{calls++;if(failure)throw Error('private error');if(route.includes('/series/'))return {results:[],next:null};return route.includes('page=2')?{results:[{id:2,name:'Second',password:'secret'}],next:null}:{results:[{id:1,name:'First'}],next:'next'};}};
		const lib=createVodLibrary({dispatcharr:d,file:path.join(directory,'catalogue.json'),clock:()=>now,localItems:async()=>[],localItem:async()=>null,localEpisodes:async()=>[]});
		await lib.refresh();assert.equal(calls,3);assert.equal((await lib.list({})).total,2);
		assert.ok(!(await readFile(path.join(directory,'catalogue.json'),'utf8')).includes('secret'));
		failure=true;now+=700000;await lib.refresh();const result=await lib.list({});assert.equal(result.total,2);assert.match(result.notice,/could not be refreshed/);assert.ok(!result.notice.includes('private'));assert.equal(calls,4);
	}finally{await rm(directory,{recursive:true,force:true});}
});
test('VOD seek manifests cover the exact duration and container detection rejects arbitrary text',()=>{
	const text=vodManifest(9.2);assert.match(text,/#EXT-X-PLAYLIST-TYPE:VOD/);assert.match(text,/#EXTINF:1.200,\nsegment000000002.ts/);assert.match(text,/#EXT-X-ENDLIST/);assert.throws(()=>vodManifest(Infinity));
	assert.equal(sniffContainer(Buffer.from([0x1a,0x45,0xdf,0xa3])),'matroska');assert.throws(()=>sniffContainer(Buffer.from('file:///etc/passwd')));
});

test('provider failures distinguish timeouts without exposing credentials or reading unbounded error pages',async()=>{
	const error=await vodUpstreamFailure(new Response('ConnectTimeout at /series/private-user/private-password/1.mkv',{status:500}));
	assert.equal(error.status,502);assert.match(error.message,/could not reach/);assert.doesNotMatch(error.message,/private/);
	let cancelled=false,reads=0;
	const body=new ReadableStream({pull(controller){reads++;controller.enqueue(new TextEncoder().encode('x'.repeat(8192)));},cancel(){cancelled=true;}});
	const generic=await vodUpstreamFailure(new Response(body,{status:503}));
	assert.match(generic.message,/could not supply video/);assert.ok(cancelled);assert.ok(reads<=2);
});
test('episode lookup carries its series and avoids the broken standalone Dispatcharr endpoint',async()=>{
	const directory=await mkdtemp(path.join(os.tmpdir(),'vod-episode-'));
	try{
		const episode={id:63,name:'Pilot',uuid:'11111111-1111-1111-1111-111111111111',series:{id:10880,name:'Show'},season_number:1,episode_number:1};
		const view=vodView(episode,'Episode');assert.equal(view.Id,'dispatch-episode-63-10880');
		const lib=createVodLibrary({file:path.join(directory,'cache.json'),dispatcharr:{status:()=>({connected:true}),api:async route=>{assert.equal(route,'/api/vod/series/10880/episodes/');return [episode];}},localItems:async()=>[]});
		assert.equal((await lib.raw(view.Id)).data.uuid,episode.uuid);
		await assert.rejects(()=>lib.raw('dispatch-episode-63'),/Invalid/);
		await assert.rejects(()=>lib.raw('dispatch-movie-63-10880'),/Invalid/);
	}finally{await rm(directory,{recursive:true,force:true});}
});
test('VOD range requests retain one session and never follow provider redirects outside Dispatcharr',async()=>{
	const urls=[],uuid='11111111-1111-1111-1111-111111111111',session='a'.repeat(48);
	const d=createDispatcharr({file:'absent',origin:'http://dispatch.test',fetcher:async(url,options)=>{urls.push(String(url));assert.equal(options.headers.Range,'bytes=0-99');return urls.length%2?new Response(null,{status:301,headers:{location:String(url)+'/'}}):new Response('ok');}});
	await d.stream({type:'movie',uuid,session},{range:'bytes=0-99'});await d.stream({type:'movie',uuid,session},{range:'bytes=0-99'});
	assert.ok(urls.every(url=>url.includes(session)));
	const bad=createDispatcharr({file:'absent',origin:'http://dispatch.test',fetcher:async()=>new Response(null,{status:302,headers:{location:'http://external.test/private'}})});
	await assert.rejects(()=>bad.stream({type:'movie',uuid}),/proxy VOD/);
});

test('either series entry opens the same merged seasons and local episodes win',async()=>{
	const directory=await mkdtemp(path.join(os.tmpdir(),'vod-merged-series-'));
	try{
		const local={Id:'local-series',Name:'Our show',Type:'Series',ProviderIds:{Tmdb:'44'}};
		const series={id:7,name:'Our show',tmdb_id:44};
		let failEpisodes=false,episodeCalls=0;
		const d={status:()=>({connected:true}),api:async route=>{
			if(route.includes('/movies/'))return [];
			if(route.endsWith('/provider-info/'))return {};
			if(route.endsWith('/episodes/')){episodeCalls++;if(failEpisodes)throw Error('offline');return [1,2,3].map(n=>({id:n,name:'Episode '+n,series,season_number:1,episode_number:n}));}
			if(route==='/api/vod/series/7/')return series;
			return [series];
		}};
		let now=Date.now();
		const lib=createVodLibrary({dispatcharr:d,file:path.join(directory,'cache.json'),clock:()=>now,localItems:async()=>[local],localItem:async id=>{assert.equal(id,local.Id);return local;},localEpisodes:async id=>{assert.equal(id,local.Id);return [{Id:'local-episode',Name:'Pilot',Type:'Episode',ParentIndexNumber:1,IndexNumber:1}];}});
		await lib.refresh();assert.equal((await lib.item('dispatch-series-7')).Id,local.Id);
		const [fromVod,fromLocal]=await Promise.all([lib.episodes('dispatch-series-7'),lib.episodes(local.Id)]);assert.equal(episodeCalls,1);
		assert.deepEqual(fromVod,fromLocal);assert.deepEqual(fromVod.items.map(e=>e.Id),['local-episode','dispatch-episode-2-7','dispatch-episode-3-7']);
		assert.ok(fromVod.items.every(e=>e.SeriesId===local.Id));
		now+=3600001;failEpisodes=true;const degraded=await lib.episodes('dispatch-series-7');assert.equal(degraded.items.length,3);
		await lib.refreshEpisodes(local.Id,{force:true});assert.equal((await lib.episodes(local.Id)).items.length,3);
		assert.match(lib.status().seriesIndex.error,/could not be refreshed/);await lib.flushIndex();
	}finally{await rm(directory,{recursive:true,force:true});}
});

test('conflicting series IDs stay separate unless an explicit series link is configured',()=>{
	const local={Id:'local',Type:'Series',Name:'Same title',ProductionYear:2019,ProviderIds:{Tmdb:'1'}};
	const remote=vodView({id:7,name:'Same title',year:2019,tmdb_id:2},'Series');
	assert.equal(mergeLibrary([local],[remote]).length,2);
	const joined=mergeLibrary([local],[remote],{'dispatch-series-7':'local'});
	assert.equal(joined.length,1);assert.equal(joined[0].Id,'local');assert.deepEqual(joined[0].VodIds,[7]);
});
