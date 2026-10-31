import test from 'node:test';
import assert from 'node:assert/strict';
import {ukTvReport,ukTvRows,downloadUkTv,ukTvSourceUrl,matchUkTv} from '../uk-tv-charts.mjs';
import {createTrending} from '../trending.mjs';

const asset='https://assets.ctfassets.net/ptzdhtf6t0jg/test/hash/TopProgs.json';
function report(overrides={}){
	const item={slug:'top-programmes-report',reportTableSummary:'week 42, October 12 - 18',updatedDate:'2026-10-26T00:00:00.000Z',reportDataFile:{url:asset},...overrides};
	return '<script id="__NEXT_DATA__" type="application/json">'+JSON.stringify({props:{pageProps:{data:{pageArticleCollection:{items:[item]}}}}})+'</script>';
}
function row(title,audience=1000,filter='All TV',channel='BBC 1'){
	return {Programme:`<b>${title}</b><br/>2026-10-16 20:00:00-21:00:00`,Channel:channel,Filter:filter,"Total Audience ('000)":`<b>${audience}</b>`};
}
function chart(){return {filters:[{label:'Commercial TV By Channel',content:['ITV','CH4','5']}],content:Array.from({length:12},(_,i)=>row('Show '+(i+1),2000-i*10))};}
const source=async url=>new Response(url===ukTvSourceUrl?report():JSON.stringify(chart()));

test('UK TV report discovers the public asset and derives the reporting Sunday including New Year',()=>{
	assert.deepEqual(ukTvReport(report()),{week:'2026-10-18',url:asset});
	assert.equal(ukTvReport(report({reportTableSummary:'week 53, December 28 - January 3',updatedDate:'2027-01-11T00:00:00Z'})).week,'2027-01-03');
	for(const url of ['http://assets.ctfassets.net/ptzdhtf6t0jg/test/TopProgs.json','https://other.test/TopProgs.json','https://user@assets.ctfassets.net/ptzdhtf6t0jg/test/TopProgs.json','https://assets.ctfassets.net/private/TopProgs.json'])assert.throws(()=>ukTvReport(report({reportDataFile:{url}})));
	assert.throws(()=>ukTvReport('<script>not a report</script>'));
	assert.throws(()=>ukTvReport(report({reportTableSummary:'week 99'})));
});

test('UK TV combines broadcasters once per show using its best broadcast, excluding audience subgroup charts',()=>{
	const data=chart();data.content.push(row('Show 1',5000,'ITV','ITV'),row('Channel &amp; friends',4000,'CH4','CH4'),row('Not a national ranking',999999,'Adults','ITV'));
	const result=ukTvRows(data,'2026-10-18');
	assert.equal(result.items.length,13);assert.equal(result.items[0].title,'Show 1');assert.equal(result.items[0].audience,5000);assert.equal(result.items[0].channel,'ITV');
	assert.equal(result.items[1].title,'Channel & friends');assert.equal(result.items[1].rank,2);assert.equal(result.items.some(i=>i.title==='Not a national ranking'),false);
	assert.deepEqual(result.items.map(i=>i.rank),Array.from({length:13},(_,i)=>i+1));
});

test('UK TV rejects incomplete or mismatched-week data rather than showing a falsely fresh chart',()=>{
	assert.throws(()=>ukTvRows({content:[],filters:chart().filters},'2026-10-18'));
	const wrong=chart();wrong.content[0].Programme=wrong.content[0].Programme.replace('2026-10-16','2026-10-09');assert.throws(()=>ukTvRows(wrong,'2026-10-18'));
	const invalid=chart();invalid.content.forEach(r=>r["Total Audience ('000)"]='n/a');assert.throws(()=>ukTvRows(invalid,'2026-10-18'));
	const monday=chart();monday.content[0].Programme=monday.content[0].Programme.replace('2026-10-16','2026-10-19');assert.equal(ukTvRows(monday,'2026-10-18').items.length,12);
});

test('UK TV downloads are bounded and fail closed on upstream errors',async()=>{
	const calls=[];const result=await downloadUkTv(async(url,options)=>{calls.push(url);assert.equal(options.redirect,'error');return source(url);});
	assert.equal(result.items.length,12);assert.deepEqual(calls,[ukTvSourceUrl,asset]);
	await assert.rejects(downloadUkTv(async()=>new Response('unavailable',{status:503})));
	await assert.rejects(downloadUkTv(async()=>new Response('x'.repeat(2*1024*1024+1))));
	await assert.rejects(downloadUkTv(async url=>new Response(url===ukTvSourceUrl?report():'not JSON')));
});

test('UK TV caches source and matches, bounds metadata concurrency and refreshes local/VOD availability',async()=>{
	let requests=0,active=0,maximum=0,available=false;const routes=[];
	const service=createTrending({fetcher:async url=>{requests++;return source(url);},call:async route=>{
		routes.push(route);maximum=Math.max(maximum,++active);await new Promise(r=>setTimeout(r,1));active--;
		const title=new URL(route,'https://test').searchParams.get('query');
		if(!title)return {};
		if(title==='Show 2')return {results:[{id:21,name:title,mediaType:'tv'},{id:22,title,mediaType:'movie'}]};
		return {results:[{id:Number(title.split(' ')[1]),name:title,mediaType:title==='Show 3'?'movie':'tv'}]};
	},view:(item,type)=>({id:item.id,type,title:item.name,requestable:true}),enrich:async items=>items.map(item=>({...item,vodAvailable:available,watchId:item.id===1?'local-series-id':null,vodWatchId:available?'dispatch-series-123':null}))});
	const [a,b]=await Promise.all([service.trending('uk-tv'),service.trending('uk-tv')]);assert.equal(a.items.length,12);assert.deepEqual(a,b);assert.equal(requests,2);assert.equal(routes.length,14);assert.ok(maximum<=2);
	assert.equal(a.items[1].id,null);assert.equal(a.items[1].statusLabel,'Find this title');assert.equal(a.items[2].type,'movie');assert.equal(a.items[0].rankLabel,'#1 · UK TV');assert.equal(a.sourceUrl,ukTvSourceUrl);
	assert.equal(a.items[0].watchId,'local-series-id');assert.equal(a.items[3].requestable,true);
	available=true;const refreshed=await service.trending('uk-tv');assert.equal(refreshed.items[0].vodAvailable,true);assert.equal(refreshed.items[0].rank,1);assert.equal(refreshed.items[0].vodWatchId,'dispatch-series-123');assert.equal(requests,2);assert.equal(routes.length,14);
});

test('UK TV matching handles ampersands and resolves current broadcaster versions without guessing',async()=>{
	const item={title:'All Creatures Great and Small',channel:'5'},week='2026-10-18';
	const candidates=[{id:1,mediaType:'tv',name:'All Creatures Great & Small'},{id:2,mediaType:'tv',name:item.title},{id:3,mediaType:'movie',title:item.title}];
	const detail={firstAirDate:'2020-01-01',lastAirDate:'2026-10-22',networks:[{name:'Channel 5'}]};
	const call=async path=>path.startsWith('/search?')?{results:candidates}:path==='/tv/1'?detail:{firstAirDate:'1978-01-01',lastAirDate:'1990-01-01',networks:[{name:'BBC One'}]};
	assert.equal((await matchUkTv(item,week,call)).id,1);
	const repeat=async path=>path==='/tv/1'?{...detail,originCountry:['GB'],lastAirDate:'2025-01-01'}:call(path);
	assert.equal((await matchUkTv(item,week,repeat)).id,1);
	assert.equal(await matchUkTv({...item,channel:'ITV'},week,call),null);
	assert.equal(await matchUkTv(item,week,async path=>path.startsWith('/search?')?{results:candidates}:detail),null);
	await assert.rejects(matchUkTv(item,week,async path=>{if(path.startsWith('/search?'))return {results:candidates};throw Error('offline');}));
	assert.equal((await matchUkTv(item,week,async()=>({results:[candidates[0]]}))).id,1);
});
