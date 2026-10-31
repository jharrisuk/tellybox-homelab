import test from 'node:test';
import assert from 'node:assert/strict';
import { createTrending, netflixParser, downloadNetflix, exactChartMatch, onNetflixUk, matchNetflixChart } from '../trending.mjs';
const header='country_name\tcountry_iso2\tweek\tcategory\tweekly_rank\tshow_title\tseason_title';
const chart=(week='2026-10-18',country='GB')=>['TV','Films'].flatMap(type=>Array.from({length:10},(_,i)=>`United Kingdom\t${country}\t${week}\t${type}\t${i+1}\tTitle ${i+1}\t${type==='TV'?'Season 2':'N/A'}`));
test('Netflix parser keeps the latest complete UK chart and original ranks',()=>{
	const parser=netflixParser();[header,...chart('2026-10-18'),...chart('2026-10-25','US'),...chart('2026-10-11')].forEach(line=>parser.line(line));
	const result=parser.result();assert.equal(result.week,'2026-10-18');assert.equal(result.items.length,20);assert.equal(result.items[0].rank,1);assert.equal(result.items[0].season,'Season 2');
	const incomplete=netflixParser();[header,...chart().slice(1)].forEach(line=>incomplete.line(line));assert.throws(()=>incomplete.result());
});
test('Netflix streaming reader tolerates split UTF8 and rejects failed sources',async()=>{
	const data=new TextEncoder().encode([header,...chart()].join('\r\n'));
	const response=new Response(new ReadableStream({start(controller){for(let n=0;n<data.length;n+=17)controller.enqueue(data.slice(n,n+17));controller.close();}}));
	assert.equal((await downloadNetflix(async()=>response)).items.length,20);
	await assert.rejects(downloadNetflix(async()=>new Response('unavailable',{status:503})));
});
test('title matching rejects ambiguous, adult and wrong media matches',()=>{
	const row={id:1,title:'A Story',mediaType:'movie'};assert.equal(exactChartMatch([row],'A Story','movie').id,1);
	assert.equal(exactChartMatch([row,{...row,id:2}],'A Story','movie'),null);
	assert.equal(exactChartMatch([row],'A Story','tv'),null);assert.equal(exactChartMatch([{...row,adult:true}],'A Story','movie'),null);
});
test('weekly, genre and provider feeds use distinct upstream filters and refresh availability',async()=>{
	const routes=[];let status=1;const service=createTrending({call:async route=>{routes.push(route);return {results:[{id:1,mediaType:'movie'},{id:1,mediaType:'movie'},{id:2,adult:true}]};},view:i=>({...i,type:'movie'}),enrich:async items=>items.map(i=>({...i,status}))});
	const week=await service.trending('week-movie');assert.equal(week.items.length,1);assert.ok(routes[0].includes('timeWindow=week'));status=5;assert.equal((await service.trending('week-movie')).items[0].status,5);assert.equal(routes.length,1);
	await service.trending('docs-movie');assert.ok(routes[1].includes('genre=99'));
	await service.trending('apple-popular-movie');const params=new URL(routes[2],'https://test').searchParams;assert.equal(params.get('watchRegion'),'GB');assert.equal(params.get('watchProviders'),'350');assert.equal(params.has('watchMonetizationTypes'),false);assert.equal(params.get('sortBy'),'popularity.desc');
	await assert.rejects(service.trending('../secret'));
});
test('concurrent charts coalesce and failed refresh keeps clearly marked cached data',async()=>{
	let count=0,time=Date.now(),broken=false;const service=createTrending({now:()=>time,call:async()=>{count++;await new Promise(r=>setTimeout(r,5));if(broken)throw Error('offline');return {results:[]};},view:i=>i});
	await Promise.all([service.trending('week-tv'),service.trending('week-tv')]);assert.equal(count,1);broken=true;time+=3600001;assert.equal((await service.trending('week-tv')).stale,true);await new Promise(r=>setTimeout(r,10));assert.equal(count,2);await service.trending('week-tv');assert.equal(count,2);
});

test('Netflix disambiguation uses UK subscription availability rather than network names',()=>{
	assert.equal(onNetflixUk({watchProviders:[{iso_3166_1:'GB',flatrate:[{id:8}]}]}),true);
	assert.equal(onNetflixUk({watchProviders:[{iso_3166_1:'US',flatrate:[{id:8}]}],networks:[{id:213}]}),false);
	assert.equal(onNetflixUk({watchProviders:[{iso_3166_1:'GB',buy:[{id:8}]}]}),false);
});
const netflixGb={watchProviders:[{iso_3166_1:'GB',flatrate:[{id:8}]}]};
test('Netflix cross-category matches use exact titles and confirmed UK availability, preserving the actual media type',async()=>{
	const movie={id:1790935,title:'Instadocs: AI Gone Wild',mediaType:'movie'};
	const hit=await matchNetflixChart([movie],movie.title,'tv',async route=>{assert.equal(route,'/movie/1790935');return {...netflixGb,posterPath:'/poster.jpg'};});
	assert.equal(hit.mediaType,'movie');assert.equal(hit.posterPath,'/poster.jpg');
	assert.equal(await matchNetflixChart([movie],movie.title,'tv',async()=>({watchProviders:[]})),null);
	assert.equal(await matchNetflixChart([movie],movie.title,'tv',async()=>netflixGb,'Season 2'),null);
	assert.equal(await matchNetflixChart([{...movie,title:'Another title'}],movie.title,'tv',async()=>netflixGb),null);
});
test('Netflix matching never guesses between remakes or switches category to escape ambiguity',async()=>{
	const series={id:1,name:'Same name',mediaType:'tv'},film={id:3,title:'Same name',mediaType:'movie'};
	assert.equal(await matchNetflixChart([series,{...series,id:2},film],'Same name','tv',async()=>netflixGb),null);
	assert.equal(await matchNetflixChart([film,{...film,id:4}],'Same name','tv',async()=>netflixGb),null);
	assert.equal(await matchNetflixChart([film],'Same name','tv',async()=>{throw Error('offline');}),null);
	assert.equal(await matchNetflixChart([{...film,adult:true}],'Same name','tv',async()=>netflixGb),null);
});
test('missing chart artwork is hydrated from details and title punctuation variants stay exact',async()=>{
	const item={id:7,name:'You & Me',mediaType:'tv'};
	const result=await matchNetflixChart([item],'You and Me','tv',async()=>({posterPath:'/found.jpg'}));
	assert.equal(result.posterPath,'/found.jpg');assert.equal(result.mediaType,'tv');
	assert.equal((await matchNetflixChart([item],item.name,'tv',async()=>{throw Error('offline');})).id,7);
});
test('Netflix chart integration enriches corrected film IDs while retaining chart rank',async()=>{
	const lines=chart().map(line=>line.replace('Title 1\tSeason 2','Instadocs: AI Gone Wild\tN/A'));
	const service=createTrending({fetcher:async()=>new Response([header,...lines].join('\n')),call:async route=>route.startsWith('/search?')?{results:route.includes('Instadocs')?[{id:1790935,title:'Instadocs: AI Gone Wild',mediaType:'movie'}]:[]}:netflixGb,view:(i,type)=>({id:i.id,type,title:i.title}),enrich:async items=>items.map(i=>({...i,vodAvailable:i.type==='movie'}))});
	const row=await service.trending('netflix-tv'),item=row.items[0];assert.equal(item.rank,1);assert.equal(item.type,'movie');assert.equal(item.vodAvailable,true);
});
