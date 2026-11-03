import test from 'node:test';
import assert from 'node:assert/strict';
import {createBroadcastResume,broadcastEpisode} from '../broadcast-resume.mjs';
import {parseEpg} from '../dispatcharr-guide.mjs';

const channel='12345678-1234-1234-1234-123456789abc',start=Date.parse('2026-10-30T18:00:00Z');
const saved={Id:`catchup-${channel}-${start}`,Type:'Catchup',Name:'The Example Show',ChannelId:'dispatch-live-'+channel,
	StartDate:new Date(start).toISOString(),EndDate:new Date(start+3600000).toISOString(),ParentIndexNumber:2,IndexNumber:3};
const series={Id:'series',Name:saved.Name,Type:'Series',ProductionYear:2020};
const episode={Id:'episode',Type:'Episode',Name:'The missing diamond',ParentIndexNumber:2,IndexNumber:3,Source:'local'};
function setup({current=[],matches=[series],episodes=[episode],item=value=>value==='episode'?episode:null}={}) {
	const calls={catchup:0,search:0,episodes:0};
	const service=createBroadcastResume({catchup:{async list(channel,includeCurrent){calls.catchup++;assert.equal(channel,'');assert.equal(includeCurrent,true);return {channels:[{programmes:current}]};}},
		library:{async searchMatches(){calls.search++;return matches;},async episodes(){calls.episodes++;return {items:episodes};},async item(id){return item(id);}}});
	const resolve=(body,options={})=>service(body,{resolveBroadcasts:true,...options});
	return {resolve,calls,service};
}
test('the home shelf request never resolves broadcasts unless a caller explicitly opts in',async()=>{
	const resolve=createBroadcastResume({catchup:{list:async()=>{throw Error('must not read the guide');}},library:{searchMatches:async()=>{throw Error('must not search');}}});
	assert.deepEqual(await resolve({items:[saved]}),{items:[]});
	assert.deepEqual(await resolve({items:[saved,{...saved,Type:'Program'}]}),{items:[]});
});
test('plain live channels and malformed programme identities never become resume cards or open integrations',async()=>{
	const {resolve,calls}=setup();
	assert.deepEqual(await resolve({items:[{...saved,Type:'TvChannel'},{...saved,StartDate:new Date(start+1).toISOString()},{...saved,ChannelId:'dispatch-live-elsewhere'}]}),{items:[]});
	assert.deepEqual(calls,{catchup:0,search:0,episodes:0});
	await assert.rejects(resolve({items:Array(21).fill(saved)}),{status:400});
});
test('an exact local episode takes precedence over catchup and marks the source change',async()=>{
	const {resolve}=setup({current:[saved]});
	assert.deepEqual((await resolve({items:[saved]})).items,[{...episode,ResumeFromId:saved.Id,ResumeSource:'local',ResumeSourceChanged:true,BroadcastDurationMs:3600000}]);
});
test('expired catchup can resolve to VOD while deleted content falls back to current catchup',async()=>{
	const vod={...episode,Id:'vod-episode',Source:'streamed'};
	assert.equal((await setup({episodes:[vod],item:()=>vod}).resolve({items:[saved]})).items[0].ResumeSource,'streamed');
	const fallback=(await setup({current:[saved],item:()=>{throw Error('deleted');}}).resolve({items:[saved]})).items[0];
	assert.equal(fallback.Id,saved.Id);assert.equal(fallback.ResumeSourceChanged,false);assert.equal(fallback.ResumeSource,'catchup');
	assert.deepEqual((await setup({item:()=>null}).resolve({items:[saved]})).items,[]);
});
test('no title-only series guesses, generic subtitle matches, conflicting numbers or ambiguous remakes',async()=>{
	const unnumbered={...saved,ParentIndexNumber:undefined,IndexNumber:undefined};
	assert.deepEqual((await setup().resolve({items:[unnumbered]})).items,[]);
	assert.deepEqual((await setup({episodes:[{...episode,Name:'Episode 3'}]}).resolve({items:[{...unnumbered,EpisodeTitle:'Episode 3'}]})).items,[]);
	assert.deepEqual((await setup({episodes:[{...episode,IndexNumber:4}]}).resolve({items:[saved]})).items,[]);
	assert.deepEqual((await setup({matches:[series,{...series,Id:'remake',ProductionYear:2026}]}).resolve({items:[saved]})).items,[]);
	assert.deepEqual((await setup().resolve({items:[{...saved,SeriesProductionYear:1990}]})).items,[]);
});
test('distinct episode titles and explicit episode numbers support matches; provider ID conflicts do not',async()=>{
	const noNumbers={...saved,ParentIndexNumber:undefined,IndexNumber:undefined,EpisodeTitle:episode.Name};
	assert.equal((await setup().resolve({items:[noNumbers]})).items[0].Id,episode.Id);
	assert.equal((await setup().resolve({items:[{...noNumbers,EpisodeTitle:'',Overview:'S2 Ep3. The gang investigates.'}]})).items[0].Id,episode.Id);
	assert.deepEqual((await setup({episodes:[{...episode,ProviderIds:{Tmdb:'111'}}]}).resolve({items:[{...saved,ProviderIds:{Tmdb:'222'}}]})).items,[]);
});
test('films require a year or matching external identity and prefer their playable catalogue copy',async()=>{
	const film={Id:'film',Type:'Movie',Name:'The Example Film',ProductionYear:1999,Source:'local',ProviderIds:{Imdb:'tt12345'}};
	const sample={...saved,Name:film.Name,IsMovie:true,ProductionYear:1999};
	const make=()=>setup({matches:[film],item:()=>film});
	assert.equal((await make().resolve({items:[sample]})).items[0].Id,'film');
	assert.deepEqual((await make().resolve({items:[{...sample,ProductionYear:undefined}]})).items,[]);
	assert.equal((await make().resolve({items:[{...sample,ProductionYear:undefined,ProviderIds:{Imdb:'tt12345'}}]})).items[0].Id,'film');
	assert.deepEqual((await make().resolve({items:[{...sample,ProviderIds:{Imdb:'tt98765'}}]})).items,[]);
});
test('only currently available catchup is returned; expired programmes disappear and repeats deduplicate',async()=>{
	const {resolve,calls}=setup({current:[saved],matches:[]});
	const next={...saved,Id:`catchup-${channel}-${start+86400000}`,StartDate:new Date(start+86400000).toISOString(),EndDate:new Date(start+90000000).toISOString()};
	const result=await resolve({items:[saved,saved,next]});
	assert.equal(result.items.length,1);assert.equal(calls.catchup,1);assert.equal(calls.search,1);
	const programme={...saved,Type:'Programme',Id:channel+':'+start};
	assert.equal((await resolve({items:[programme]})).items[0].ResumeFromId,programme.Id);
	assert.equal((await resolve({items:[{...saved,Type:'Program'}]})).items[0].ResumeFromId,saved.Id);
});
test('XMLTV retains subtitles, correct zero-based numbering and film year without treating episode dates as series years',async()=>{
	const xml=`<tv><programme channel="one" start="20261030180000 +0000" stop="20261030190000 +0000"><title>The Example Show</title><sub-title>The missing diamond</sub-title><episode-num system="xmltv_ns">1.2.</episode-num><date>20261030</date></programme><programme channel="one" start="20261030190000 +0000" stop="20261030210000 +0000"><title>The Example Film</title><category>Movie</category><date>1999</date></programme></tv>`;
	const data=await parseEpg([Buffer.from(xml)],[{id:channel,epgId:'one',name:'Channel'}],start,1);
	const [show,film]=data.channels[0].programmes;
	assert.equal(show.ParentIndexNumber,2);assert.equal(show.IndexNumber,3);assert.equal(show.EpisodeTitle,episode.Name);
	assert.equal(show.ProductionYear,undefined);assert.equal(show.SeriesProductionYear,undefined);
	assert.equal(film.IsMovie,true);assert.equal(film.ProductionYear,1999);
	assert.deepEqual(broadcastEpisode('1.2.','dd_progid'),{});
});

test('per-viewer restrictions remove blocked sources and may still offer an allowed catchup alternative',async()=>{
	const vod={...episode,Id:'dispatch-episode-2-1',Source:'streamed'};
	const service=setup({current:[saved],episodes:[vod],item:()=>vod});
	const allowed=item=>!item.Id.startsWith('dispatch-episode-');
	const result=await service.resolve({items:[saved]},{allowed});
	assert.equal(result.items[0].Id,saved.Id);assert.equal(result.items[0].ResumeSource,'catchup');
	assert.deepEqual(await service.resolve({items:[saved]},{allowed:()=>false}),{items:[]});
});

test('catalogue resolution runs at most two workers and preserves saved order and target deduplication',async()=>{
	let active=0,peak=0;
	const film=index=>({Id:'film-'+index,Name:'Film '+index,Type:'Movie',ProductionYear:2020});
	const service=createBroadcastResume({catchup:{list:async()=>({channels:[]})},library:{
		async searchMatches(title){
			active++;peak=Math.max(peak,active);
			await new Promise(done=>setTimeout(done,title==='Film 0'?25:2));
			active--;return [film(Number(title.slice(5)))];
		},item:async id=>film(Number(id.slice(5)))
	}});
	const resolve=(body,options={})=>service(body,{resolveBroadcasts:true,...options});
	const candidates=[0,1,2,3,0].map((index,offset)=>({...saved,IsMovie:true,Name:'Film '+index,ProductionYear:2020,
		Id:`catchup-${channel}-${start+offset*3600000}`,StartDate:new Date(start+offset*3600000).toISOString(),EndDate:new Date(start+(offset+1)*3600000).toISOString()}));
	const result=await resolve({items:candidates});
	assert.equal(peak,2);assert.equal(active,0);
	assert.deepEqual(result.items.map(item=>item.Id),['film-0','film-1','film-2','film-3']);
	assert.equal(result.items[0].ResumeFromId,candidates[0].Id);
});

test('short match cache reuses positive and negative identities but refreshes catchup, policy and item availability',async()=>{
	let clock=0,searches=0,guideCalls=0,itemCalls=0,listed=true,exists=true,current=[saved];
	const service=createBroadcastResume({now:()=>clock,catchup:{async list(){guideCalls++;return {channels:[{programmes:current}]};}},library:{
		async searchMatches(){searches++;return listed?[series]:[];},episodes:async()=>({items:[episode]}),
		async item(){itemCalls++;return exists?episode:null;}
	}});
	const resolve=(body,options={})=>service(body,{resolveBroadcasts:true,...options});
	assert.equal((await resolve({items:[saved]})).items[0].Id,episode.Id);
	assert.equal((await resolve({items:[saved]},{allowed:item=>item.Type==='Catchup'})).items[0].Id,saved.Id);
	assert.equal(searches,1);assert.equal(itemCalls,1);
	exists=false;current=[];
	assert.deepEqual((await resolve({items:[saved]})).items,[]);
	assert.equal(itemCalls,2);assert.equal(guideCalls,3);
	clock=30000;listed=false;
	assert.deepEqual((await resolve({items:[saved]})).items,[]);assert.equal(searches,2);
	listed=true;exists=true;
	assert.deepEqual((await resolve({items:[saved]})).items,[]);assert.equal(searches,2);
	clock=60000;
	assert.equal((await resolve({items:[saved]})).items[0].Id,episode.Id);assert.equal(searches,3);
	assert.equal(guideCalls,6);
});

test('catalogue cache retains at most one hundred identities',async()=>{
	let searches=0;
	const service=createBroadcastResume({now:()=>0,catchup:{list:async()=>({channels:[]})},library:{searchMatches:async()=>{searches++;return [];}}});
	const resolve=(body,options={})=>service(body,{resolveBroadcasts:true,...options});
	const candidate=index=>({...saved,Name:'Unmatched programme '+index});
	for(let offset=0;offset<100;offset+=20)await resolve({items:Array.from({length:20},(_,index)=>candidate(offset+index))});
	assert.equal(searches,100);
	await resolve({items:[candidate(99)]});assert.equal(searches,100);
	await resolve({items:[candidate(100)]});assert.equal(searches,101);
	await resolve({items:[candidate(0)]});assert.equal(searches,102);
});
