import test from 'node:test';
import assert from 'node:assert/strict';
import { createDiscoveryFeeds, discoveryOrder, preferences, rank, genreNames } from '../discovery-feeds.mjs';
import { mediaView } from '../seerr.mjs';
const prefs=(name='Documentary',exclude=[])=>({genres:[{name,weight:3}],exclude});
const row=(id,status=1)=>({id,title:'Title '+id,genreIds:[99],releaseDate:'2025-01-01',mediaInfo:{status}});
const feeds=(call,library)=>createDiscoveryFeeds({call,library,view:mediaView,enrich:async items=>items});

test('genre browsing excludes documentary crossovers while documentary films and series stay available',async()=>{
	const routes=[];const service=feeds(async route=>{const url=new URL(route,'http://test');routes.push(url);const page=Number(url.searchParams.get('page'));return {page,totalPages:3,results:page===1?[row(1)]:[{...row(2),genreIds:[18]},{...row(3),genreIds:[99,80]}]};});
	const drama=await service.category('Drama','movie',1,'popular',true);assert.equal(drama.page,2);assert.deepEqual(drama.items.map(i=>i.id),[2]);
	for(const type of ['movie','tv']){const result=await service.category('Documentary',type);assert.deepEqual(result.items.map(i=>i.id),[1]);assert.equal(routes.at(-1).searchParams.get('genre'),'99');}
	await assert.rejects(service.category('Documentary','movie',1,'popular',true));
});
test('library provider filters combine genre, media type and ordering before pagination',async()=>{
	const routes=[];const service=feeds(async route=>{routes.push(new URL(route,'https://test'));return {page:2,totalPages:5,results:[{...row(1),releaseDate:'2020-01-01'},{...row(2),releaseDate:'2025-01-01'}]};});
	const result=await service.provider(8,'movie',2,{genre:'Documentary',sort:'rating'});
	assert.deepEqual(result.items.map(i=>i.id),[1,2]);
	const params=routes[0].searchParams;assert.equal(params.get('watchProviders'),'8');assert.equal(params.get('genre'),'99');assert.equal(params.get('page'),'2');assert.equal(params.get('sortBy'),'vote_average.desc');assert.equal(params.get('voteCountGte'),'50');assert.equal(params.get('watchRegion'),'GB');assert.ok(params.get('primaryReleaseDateLte'));
	await service.provider(337,'tv',1,{genre:'Action',sort:'popular'});assert.equal(routes[1].searchParams.get('genre'),'10759');assert.equal(routes[1].searchParams.get('sortBy'),'popularity.desc');assert.ok(routes[1].searchParams.get('firstAirDateLte'));
	await assert.rejects(service.provider(8,'movie',1,{genre:'invalid'}));await assert.rejects(service.provider(8,'tv',1,{sort:'imdb'}));
});
test('Discover orders upstream before pagination, preserving category and rating confidence', async () => {
	const routes=[];
	const service=feeds(async route=>{routes.push(new URL(route,'https://test'));return {page:2,totalPages:50,results:[]};});
	await service.category('Documentary','tv',2,'rating');
	const params=routes[0].searchParams;
	assert.equal(params.get('page'),'2');assert.equal(params.get('genre'),'99');
	assert.equal(params.get('sortBy'),'vote_average.desc');assert.equal(params.get('voteCountGte'),'50');
	await service.category('Documentary','movie',1,'release');
	assert.equal(routes[1].searchParams.get('sortBy'),'primary_release_date.desc');
	assert.equal(routes[1].searchParams.get('primaryReleaseDateLte'),new Date().toISOString().slice(0,10));
	assert.equal(discoveryOrder('tv','release').sortBy,'first_air_date.desc');
	assert.ok(discoveryOrder('tv','release').firstAirDateLte);
	await assert.rejects(service.category('Documentary','tv',1,'invalid'));
});
test('cold start performs no discovery calls and rejects malformed or oversized preferences',async()=>{
	const service=feeds(()=>{throw Error('Unexpected upstream call');});
	assert.equal((await service.forYou({genres:[],exclude:[]})).personalized,false);
	for(const body of [null,{genres:[],exclude:Array(301).fill('a'.repeat(32))},{genres:[{name:'Documentary',weight:Infinity}],exclude:[]},prefs('Documentary',['https://bad.test'])]) assert.throws(()=>preferences(body));
});
test('combined TV genres preserve both interests',()=>{
	assert.deepEqual(genreNames({genreIds:[10759,10765]}),['Action','Adventure','Science Fiction','Fantasy']);
	assert.deepEqual(genreNames({genres:[{name:'Sci-Fi & Fantasy'}]}),['Science Fiction','Fantasy']);
});
test('ranking excludes watched/disliked titles, deduplicates, and uses negative genre votes',()=>{
	const taste=preferences({genres:[{name:'Documentary',weight:3},{name:'Crime',weight:-4}],exclude:['a'.repeat(32),'tmdb:movie:2']});
	const result=rank([{id:1,type:'movie',genres:['Documentary'],watchId:'a'.repeat(32)},{id:2,type:'movie',genres:['Documentary']},{id:3,type:'movie',genres:['Documentary','Crime']},{id:4,type:'movie',genres:['Documentary']},{id:4,type:'movie',genres:['Documentary']}],taste);
	assert.deepEqual(result.map(i=>i.id),[4]); assert.equal(result[0].reason,'Because you like documentary');
});
test('provider calls filter UK subscriptions with correct film/series release dates and bounded pagination',async()=>{
	const routes=[]; const service=feeds(async route=>{routes.push(new URL(route,'https://test'));return{page:1,totalPages:100,results:[row(1),{...row(2),releaseDate:'2999-01-01'},{...row(3),adult:true}]};});
	const result=await service.provider(350); assert.equal(result.provider.name,'Apple TV');assert.equal(result.pages,20);assert.equal(result.items.length,2);
	for(const url of routes){assert.equal(url.searchParams.get('watchRegion'),'GB');assert.equal(url.searchParams.get('watchProviders'),'350');}
	assert.equal(routes[0].searchParams.get('sortBy'),'primary_release_date.desc');assert.ok(routes[0].searchParams.has('primaryReleaseDateLte'));assert.ok(routes[1].searchParams.has('firstAirDateLte'));
	await assert.rejects(service.provider(10));await assert.rejects(service.provider(8,'all',21));
});
test('personal suggestions separate playable, requestable and on-the-way titles; library matches win',async()=>{
	const service=feeds(async()=>({results:[row(1),row(2,3),row(3,5),row(4)]}),async()=>[mediaView({...row(4,5),mediaInfo:{status:5,jellyfinMediaId:'b'.repeat(32)}},'movie')]);
	const result=await service.forYou(prefs());assert.equal(result.personalized,true);
	assert.equal(result.sections[0].items[0].watchId,'b'.repeat(32));assert.ok(result.sections[1].items.every(i=>i.status===1));assert.ok(result.sections[2].items.every(i=>i.status===3));
	assert.ok(result.sections.every(s=>s.items.every(i=>i.reason)));assert.ok(!result.sections.flatMap(s=>s.items).some(i=>i.id===3));
});
test('upstream discovery is cached and concurrent work bounded while personal exclusions remain separate',async()=>{
	let calls=0,running=0,peak=0;const service=feeds(async()=>{calls++;peak=Math.max(peak,++running);await new Promise(r=>setTimeout(r,5));running--;return{results:[row(1)]};});
	const [a,b]=await Promise.all([service.forYou(prefs()),service.forYou(prefs('Documentary',['tmdb:movie:1','tmdb:tv:1']))]);
	assert.equal(calls,2);assert.ok(peak<=3);assert.equal(a.sections[1].items.length,2);assert.equal(b.sections[1].items.length,0);
});
test('a failed service does not silently become an unfiltered catalogue; recommendations degrade explicitly',async()=>{
	const service=feeds(async()=>{throw Error('Unavailable');},async()=>[mediaView({...row(1),mediaInfo:{status:5,jellyfinMediaId:'c'.repeat(32)}},'movie')]);
	await assert.rejects(service.provider(8));const result=await service.forYou(prefs());assert.equal(result.partial,true);assert.equal(result.sections[0].items.length,1);
});

test('recommendations account for rating confidence instead of promoting a single perfect vote',()=>{
	const result=rank([{id:1,type:'movie',genres:['Documentary'],ratings:[{value:10,max:10,votes:1}]},{id:2,type:'movie',genres:['Documentary'],ratings:[{value:8,max:10,votes:500}]}],preferences(prefs()));
	assert.deepEqual(result.map(i=>i.id),[2,1]);
});

test('category browsing validates genre and uses the correct film and television genre IDs', async () => {
	const routes = [];
	const service = createDiscoveryFeeds({ call:async route => { routes.push(route); return { page:1,totalPages:40,results:[{id:1}] }; }, view:(item,type)=>({...item,type}), enrich:async items=>items });
	const result = await service.category('Documentary','tv',1);
	assert.equal(result.items[0].type,'tv'); assert.equal(result.pages,20); assert.match(routes[0], /genre=99/);
	await service.category('Action','tv',2); assert.match(routes[1], /genre=10759/);
	await service.category('Action','movie',2); assert.match(routes[2], /genre=28/);
	await assert.rejects(service.category('invalid','tv',1)); await assert.rejects(service.category('Drama','all',1)); await assert.rejects(service.category('Drama','tv',21));
});

const day=n=>new Date(Date.now()-n*86400000).toISOString().slice(0,10);
const freshRow=(id,type='movie',date=day(1))=>({id,title:'New '+id,mediaType:type,genreIds:[18],...(type==='movie'?{releaseDate:date}:{firstAirDate:date})});

test('new-release shelves cover the window, providers and top-rated ordering',async()=>{
	const routes=[];
	const service=feeds(async route=>{const url=new URL(route,'https://test');routes.push(url);return{page:1,totalPages:1,results:[freshRow(1,'movie'),freshRow(2,'tv')]};});
	const result=await service.newThisWeek();
	assert.equal(result.region,'GB');
	assert.deepEqual(result.sections.map(section=>section.id),['all','top','netflix','uk-titles','uk-services','service-350','service-337','service-9','service-531']);
	assert.equal(result.sections.find(section=>section.id==='netflix').provider.name,'Netflix');
	assert.equal(routes.filter(url=>url.searchParams.get('watchProviders')==='8').length,2);
	assert.ok(routes.some(url=>url.searchParams.get('watchProviders')==='38|41|103|333|39'));
	assert.ok(routes.every(url=>url.searchParams.get('primaryReleaseDateGte')||url.searchParams.get('firstAirDateGte')));
	assert.ok(routes.some(url=>url.searchParams.get('sortBy')==='vote_average.desc'&&url.searchParams.get('voteCountGte')==='10'));
	const netflix=await service.newThisWeek(8);assert.equal(netflix.provider.id,8);assert.equal(netflix.items.length,4);
	const bbc=await service.newThisWeek(38);assert.equal(bbc.provider.name,'BBC iPlayer');assert.equal(bbc.items.length,4);
	await assert.rejects(service.newThisWeek(999));
});

test('new UK titles keep only titles whose production or origin country is GB',async()=>{
	const service=createDiscoveryFeeds({
		call:async route=>({page:1,totalPages:1,results:(new URL(route,'https://test').pathname.endsWith('/movies')?[freshRow(1),freshRow(2)]:[freshRow(3,'tv'),freshRow(4,'tv')])}),
		view:mediaView,enrich:async items=>items,
		origins:async (type,id)=>id===1||id===4?['GB','US']:['US']
	});
	const result=await service.newThisWeek();
	const uk=result.sections.find(section=>section.id==='uk-titles');
	assert.deepEqual(uk.items.map(item=>item.id),[1,4]);
});

test('new-release shelves are reused from the public cache instead of refetching',async()=>{
	let calls=0;const saved=new Map();
	const service=createDiscoveryFeeds({
		call:async()=>{calls++;return{page:1,totalPages:1,results:[freshRow(1),freshRow(2,'tv')]};},
		view:mediaView,enrich:async items=>items,origins:async()=>['GB'],
		publicCache:{read:async(key,loader)=>{if(!saved.has(key))saved.set(key,await loader());return saved.get(key);},generation:()=>'fixture'}
	});
	await service.newThisWeek();const cold=calls;assert.ok(cold>0);
	await service.newThisWeek();assert.equal(calls,cold);
	assert.equal(service.newWeekWarmers().length,9);
	assert.equal(new Set(service.newWeekWarmers().map(warmer=>warmer.key)).size,9);
});
test('top-rated shelf re-sorts the merged film and TV rows by rating',async()=>{
	const service=createDiscoveryFeeds({
		call:async route=>{
			const tv=new URL(route,'https://test').pathname.endsWith('/tv');
			return{page:1,totalPages:1,results:tv?[
				{id:1,title:'TV one',firstAirDate:day(1),voteAverage:8,voteCount:50},
				{id:2,title:'TV two',firstAirDate:day(1),voteAverage:9.5,voteCount:30}
			]:[
				{id:3,title:'Film one',releaseDate:day(1),voteAverage:9,voteCount:20},
				{id:4,title:'Film two',releaseDate:day(1),voteAverage:7,voteCount:100}
			]};
		},
		view:mediaView,enrich:async items=>items
	});
	const result=await service.newThisWeek();
	const top=result.sections.find(section=>section.id==='top');
	assert.deepEqual(top.items.map(item=>item.id),[2,3,1,4]);
});test('a failed shelf marks the aggregate partial but keeps the other shelves',async()=>{
	const service=feeds(async route=>{
		if(route.includes('watchProviders=8'))throw Error('Netflix unavailable');
		return{page:1,totalPages:1,results:[freshRow(1),freshRow(2,'tv')]};
	});
	const result=await service.newThisWeek();
	assert.equal(result.partial,true);
	assert.ok(result.sections.some(section=>section.id==='all'&&section.items.length>0));
	assert.ok(!result.sections.some(section=>section.id==='netflix'));
});