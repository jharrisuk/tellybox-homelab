import { readFileSync } from 'node:fs';
import { mkdir, writeFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { downloadUkTv, ukTvSourceUrl, matchUkTv } from './uk-tv-charts.mjs';

const HOUR = 3600000;
const netflixUrl = 'https://www.netflix.com/tudum/top10/data/all-weeks-countries.tsv';
export const trendingGroups = [
	{ id:'highlights', name:'Highlights', rows:['netflix-tv','netflix-movie','week-movie','week-tv'] },
	{ id:'uk', name:'UK Top 10', rows:['netflix-tv','netflix-movie'] },
	{ id:'uk-tv', name:'UK TV', rows:['uk-tv'] },
	{ id:'films', name:'Films', rows:['week-movie'] },
	{ id:'series', name:'Series', rows:['week-tv'] },
	{ id:'documentary', name:'Documentaries', rows:['docs-tv','docs-movie'] },
	...[['netflix',8,'Netflix'],['apple',350,'Apple TV'],['disney',337,'Disney+'],['prime',9,'Prime Video'],['paramount',531,'Paramount+']].map(([id,provider,name])=>({id,name,provider,rows:[id+'-popular-tv',id+'-popular-movie']}))
];
export const trendingNote = 'Official Netflix UK weekly charts, worldwide TMDB weekly trends, and popular titles available on UK streaming services. Popularity is not a viewing count.';
const normal = value => String(value || '').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/&/g,'and').replace(/[^a-z0-9]/g,'');
export function chartCandidates(results, title, type) {
	const matches = (results || []).filter(i=>!i.adult && i.mediaType===type && Number.isInteger(i.id) && [i.title,i.name,i.originalTitle,i.originalName].some(t=>normal(t)===normal(title)));
	const unique = [...new Map(matches.map(i=>[i.id,i])).values()];
	return unique;
}
export function exactChartMatch(results, title, type) {
	const matches=chartCandidates(results,title,type);return matches.length===1?matches[0]:null;
}
export function onNetflixUk(item) {
	return (item.watchProviders||[]).some(region=>region.iso_3166_1==='GB'&&(region.flatrate||[]).some(p=>[8,1796].includes(p.id)));
}
export async function matchNetflixChart(results,title,type,call,season='') {
	const preferred=chartCandidates(results,title,type);
	if(preferred.length===1){
		const match={...preferred[0],mediaType:type};
		// Search summaries sometimes omit artwork that the title details already contain.
		if(!match.posterPath)try{return {...match,...await call('/'+type+'/'+match.id),mediaType:type};}catch{}
		return match;
	}
	const alternate=type==='tv'?'movie':'tv';
	// Never resolve an ambiguous series to a film, or turn a numbered season into a film.
	if(!preferred.length&&type==='tv'&&/\bseason\s*\d|\bseries\s*\d/i.test(season))return null;
	const selectedType=preferred.length?type:alternate;
	const candidates=preferred.length?preferred:chartCandidates(results,title,alternate);
	if(!candidates.length||candidates.length>6)return null;
	const available=[];
	for(const candidate of candidates){
		try{
			const details=await call('/'+selectedType+'/'+candidate.id);
			if(onNetflixUk(details)&&!details.adult)available.push({...candidate,...details,mediaType:selectedType});
		}catch{return null;}
	}
	return available.length===1?available[0]:null;
}
export function netflixParser() {
	let headers, week='', rows=[];
	return {
		line(line) {
			const cells=line.replace(/\r$/, '').split('\t');
			if(!headers){headers=cells; if(!['country_iso2','week','category','weekly_rank','show_title'].every(k=>headers.includes(k)))throw Error('Unrecognised chart format');return;}
			const entry=Object.fromEntries(headers.map((k,i)=>[k,cells[i]]));
			if(entry.country_iso2!=='GB'||!/^\d{4}-\d{2}-\d{2}$/.test(entry.week)||!['Films','TV'].includes(entry.category))return;
			const rank=Number(entry.weekly_rank);if(!Number.isInteger(rank)||rank<1||rank>10||!entry.show_title||entry.show_title.length>500)return;
			if(entry.week>week){week=entry.week;rows=[];}
			if(entry.week===week)rows.push({rank,title:entry.show_title,type:entry.category==='Films'?'movie':'tv',season:entry.season_title==='N/A'?'':entry.season_title||''});
		},
		result() {
			if(!week||['movie','tv'].some(type=>new Set(rows.filter(r=>r.type===type).map(r=>r.rank)).size!==10))throw Error('The UK chart is incomplete');
			return {week,items:rows.sort((a,b)=>a.rank-b.rank)};
		}
	};
}
export async function downloadNetflix(fetcher=fetch) {
	const response=await fetcher(netflixUrl,{redirect:'error',signal:AbortSignal.timeout(60000)});
	if(!response.ok||!response.body)throw Error('Netflix chart unavailable');
	const parser=netflixParser(), decoder=new TextDecoder();let pending='',bytes=0;
	for await(const chunk of response.body){bytes+=chunk.length;if(bytes>64*1024*1024)throw Error('Chart too large');pending+=decoder.decode(chunk,{stream:true});const lines=pending.split('\n');pending=lines.pop();if(pending.length>20000)throw Error('Invalid chart line');for(const line of lines)if(line)parser.line(line);}
	pending+=decoder.decode();if(pending)parser.line(pending);return parser.result();
}
export function createTrending({call,view,enrich=async items=>items,fetcher=fetch,cachePath,now=Date.now}) {
	const cache=new Map(),pending=new Map(),retry=new Map();let save=Promise.resolve();
	try {const data=JSON.parse(readFileSync(cachePath,'utf8'));for(const [key,value] of Object.entries(data))if(value&&Number.isFinite(value.time)&&value.data&&value.time>now()-7*24*HOUR)cache.set(key,value);}catch{}
	function persist(){if(!cachePath)return;const data=JSON.stringify(Object.fromEntries(cache));save=save.catch(()=>{}).then(async()=>{await mkdir(dirname(cachePath),{recursive:true});await writeFile(cachePath+'.part',data);await rename(cachePath+'.part',cachePath);}).catch(()=>{});}
	function refresh(key,job){if(pending.has(key))return pending.get(key);const work=(async()=>{try{const data=await job();cache.set(key,{time:now(),data});retry.delete(key);persist();return data;}catch(error){retry.set(key,now()+60000);throw error;}finally{pending.delete(key);}})();pending.set(key,work);return work;}
	async function cached(key,job,ttl=HOUR){const entry=cache.get(key);if(entry&&now()-entry.time<ttl)return entry.data;if(entry&&now()-entry.time<7*24*HOUR){if((retry.get(key)||0)<now())void refresh(key,job).catch(()=>{});return {...entry.data,stale:true};}if((retry.get(key)||0)>now())throw Error('Charts are temporarily unavailable. Please try again shortly.');return refresh(key,job);}
	async function chart(type){
		const source=await cached('netflix-source',()=>downloadNetflix(fetcher),6*HOUR);
		const items=[];
		// Ten searches at a time would compete with playback; resolve in small pairs.
		const rows=source.items.filter(i=>i.type===type);
		for(let n=0;n<rows.length;n+=2)items.push(...await Promise.all(rows.slice(n,n+2).map(async item=>{
			let match;try{
				const result=await call('/search?query='+encodeURIComponent(item.title)+'&page=1');
				match=await matchNetflixChart(result.results,item.title,type,call,item.season);
			}catch{}
			return {...(match?view(match,match.mediaType):{id:null,type,title:item.title,poster:null,ratings:[],statusLabel:'Find this title',requestable:false}),rank:item.rank,chartTitle:item.title,chartSeason:item.season};
		})));
		return {title:'Netflix UK Top 10 · '+(type==='tv'?'Series':'Films'),note:'Official Netflix chart · week ending '+source.week,sourceUrl:'https://www.netflix.com/tudum/top10/united-kingdom'+(type==='tv'?'/tv':''),week:source.week,stale:Boolean(source.stale),items};
	}
	async function ukTelevision(){
		const source=await cached('uk-tv-source',()=>downloadUkTv(fetcher),6*HOUR),items=[];
		for(let n=0;n<source.items.length;n+=2)items.push(...await Promise.all(source.items.slice(n,n+2).map(async item=>{
			let match;
			try{match=await matchUkTv(item,source.week,call);}catch{}
			return {...(match?view(match,match.mediaType):{id:null,type:'tv',title:item.title,poster:null,ratings:[],statusLabel:'Find this title',requestable:false}),rank:item.rank,rankLabel:'#'+item.rank+' · UK TV',chartTitle:item.title,chartChannel:item.channel};
		})));
		return {title:'Popular on UK TV',note:'BARB / Thinkbox · programmes ranked by their most-watched broadcast · week ending '+source.week,sourceUrl:ukTvSourceUrl,week:source.week,stale:Boolean(source.stale),items};
	}
	async function build(key){
		if(key==='uk-tv')return ukTelevision();
		if(key==='netflix-tv'||key==='netflix-movie')return chart(key.slice(8));
		const type=key.endsWith('-tv')?'tv':'movie';let route,title,note;
		if(key.startsWith('week-')){
			route='/discover/trending?page=1&timeWindow=week&mediaType='+type;
			title='Trending '+(type==='tv'?'series':'films');note='This week worldwide · TMDB interest, not viewing figures';
		}else{
			const provider=trendingGroups.find(g=>g.provider&&g.rows.includes(key));
			const filters={page:'1',sortBy:'popularity.desc',[type==='tv'?'firstAirDateLte':'primaryReleaseDateLte']:new Date(now()).toISOString().slice(0,10)};
			if(provider){filters.watchRegion='GB';filters.watchProviders=String(provider.provider);}
			else filters.genre='99';
			route='/discover/'+(type==='tv'?'tv':'movies')+'?'+new URLSearchParams(filters);
			title=provider?'Popular on '+provider.name+' · '+(type==='tv'?'Series':'Films'):'Popular documentary '+(type==='tv'?'series':'films');
			note=provider?'UK catalogue · TMDB popularity · availability by JustWatch':'TMDB popularity · updated hourly, not an official viewing chart';
		}
		const data=await call(route);
		const seen=new Set();const items=(data.results||[]).filter(i=>!i.adult&&(!i.mediaType||i.mediaType===type)&&Number.isInteger(i.id)).filter(i=>{if(seen.has(i.id))return false;seen.add(i.id);return true;}).slice(0,10).map(i=>view(i,type));
		return {title,note,sourceUrl:'https://www.themoviedb.org',items};
	}
	async function trending(key){
		if(!trendingGroups.some(g=>g.rows.includes(key)))throw Object.assign(Error('Choose a valid trending category.'),{status:400});
		const cacheKey=key.startsWith('netflix-')?'resolved-v2-'+key:key;
		const data=await cached(cacheKey,()=>build(key));
		// Availability is refreshed separately; cached charts never freeze local/VOD status.
		const matched=data.items.filter(i=>i.id), enriched=await enrich(matched), byId=new Map(enriched.map(i=>[i.type+':'+i.id,i]));
		return {...data,updated:new Date(cache.get(cacheKey)?.time||now()).toISOString(),items:data.items.map(i=>i.id?{...i,...byId.get(i.type+':'+i.id),rank:i.rank,chartSeason:i.chartSeason}:i)};
	}
	return {trending};
}
