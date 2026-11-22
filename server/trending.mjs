import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { mkdir, writeFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { downloadUkTv, ukTvSourceUrl, matchUkTv } from './uk-tv-charts.mjs';

const HOUR = 3600000;
const DAY = 24 * HOUR;
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

// ---------------------------------------------------------------------------
// Public snapshot allowlist
//
// Chart snapshots are shared public catalogue metadata. The raw Seerr view also
// carries request workflow state (mediaInfo/requests -> status, statusLabel,
// requestable, watchId, seasons). That state is not durable public truth: it
// changes when another viewer/administrator acts, and it is not proof that a
// title can be played. Persist only the fields below and rebuild a neutral
// request status on every cache hit. Current availability is still recomputed
// per request by `enrich`.
// ---------------------------------------------------------------------------
const POSTER = /^\/[A-Za-z0-9_-]+\.(?:jpg|png|webp)$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const RATING_SOURCES = new Set(['TMDB', 'IMDb', 'Rotten Tomatoes', 'Trakt']);
const RATING_HOSTS = new Set(['www.themoviedb.org', 'www.imdb.com']);
const CHART_HOSTS = new Set(['www.netflix.com', 'www.themoviedb.org', 'www.thinkbox.tv']);
const CONTROL = /[\u0000-\u001f\u007f]/g;
const text = (value, max) => typeof value === 'string' ? value.replace(CONTROL, ' ').slice(0, max) : null;
const publicPoster = value => typeof value === 'string' && POSTER.test(value) ? value : null;

function publicUrl(value, hosts, max = 300) {
	if (typeof value !== 'string' || !value || value.length > max) return null;
	try {
		const url = new URL(value);
		if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash) return null;
		if (!hosts.has(url.hostname)) return null;
		return url.href;
	} catch { return null; }
}

function publicRatings(value) {
	if (!Array.isArray(value)) return [];
	const rows = [];
	for (const rating of value.slice(0, 8)) {
		if (!rating || !RATING_SOURCES.has(rating.source)) continue;
		const max = Number(rating.max);
		const score = Number(rating.value);
		if (!Number.isFinite(max) || max <= 0 || max > 100) continue;
		if (!Number.isFinite(score) || score <= 0 || score > max) continue;
		const votes = Number.isSafeInteger(rating.votes) && rating.votes > 0 ? rating.votes : 0;
		const url = publicUrl(rating.url, RATING_HOSTS);
		rows.push({ source: rating.source, value: Math.round(score * 10) / 10, max, votes, ...(url ? { url } : {}) });
	}
	return rows;
}

function chartItem(item) {
	if (!item || typeof item !== 'object') return null;
	const type = item.type === 'movie' || item.type === 'tv' ? item.type : null;
	const title = text(item.title, 500);
	if (!type || !title) return null;
	// Unmatched chart rows stay searchable but never look locally available.
	if (item.id === null) return { id: null, type, title, poster: null, ratings: [] };
	const id = Number(item.id);
	if (!Number.isSafeInteger(id) || id < 1 || id > 2147483647) return null;
	const row = {
		id, type, title,
		poster: publicPoster(item.poster),
		date: typeof item.date === 'string' && (item.date === '' || DATE.test(item.date)) ? item.date.slice(0, 10) : '',
		genres: Array.isArray(item.genres) ? [...new Set(item.genres.filter(value => typeof value === 'string' && value.length <= 40))].slice(0, 24) : [],
		ratings: publicRatings(item.ratings)
	};
	const rank = Number(item.rank);
	if (Number.isInteger(rank) && rank >= 1 && rank <= 1000) row.rank = rank;
	for (const [key, max] of [['rankLabel', 100], ['chartTitle', 500], ['chartSeason', 200], ['chartChannel', 100]]) {
		const value = text(item[key], max);
		if (value) row[key] = value;
	}
	return row;
}

function chartPayload(data) {
	if (!data || typeof data !== 'object' || !Array.isArray(data.items)) return null;
	const items = data.items.map(chartItem).filter(Boolean);
	// An empty chart is returned honestly to the caller but never written over
	// last-good data (see refresh()).
	if (!items.length) return null;
	const payload = { items };
	for (const [key, max] of [['title', 500], ['note', 500], ['week', 40]]) {
		const value = text(data[key], max);
		if (value) payload[key] = value;
	}
	const sourceUrl = publicUrl(data.sourceUrl, CHART_HOSTS);
	if (sourceUrl) payload.sourceUrl = sourceUrl;
	if (data.stale === true) payload.stale = true;
	return payload;
}

function netflixSourcePayload(data) {
	if (!data || typeof data !== 'object' || !Array.isArray(data.items)) return null;
	const week = typeof data.week === 'string' && DATE.test(data.week) ? data.week : null;
	if (!week) return null;
	const items = data.items.slice(0, 100).map(row => {
		const rank = Number(row?.rank), title = text(row?.title, 500), type = row?.type === 'movie' || row?.type === 'tv' ? row.type : null;
		if (!Number.isInteger(rank) || rank < 1 || rank > 100 || !title || !type) return null;
		return { rank, title, type, season: text(row.season, 200) || '' };
	}).filter(Boolean);
	if (!items.length) return null;
	return { week, items, ...(data.stale === true ? { stale: true } : {}) };
}

function ukTvSourcePayload(data) {
	if (!data || typeof data !== 'object' || !Array.isArray(data.items)) return null;
	const week = typeof data.week === 'string' && DATE.test(data.week) ? data.week : null;
	if (!week) return null;
	const items = data.items.slice(0, 100).map(row => {
		const rank = Number(row?.rank), title = text(row?.title, 300), channel = text(row?.channel, 100), audience = Number(row?.audience);
		if (!Number.isInteger(rank) || rank < 1 || rank > 100 || !title || !channel) return null;
		if (!Number.isFinite(audience) || audience <= 0 || audience > 1e9) return null;
		return { rank, title, channel, audience: Math.round(audience) };
	}).filter(Boolean);
	if (!items.length) return null;
	return { week, items, ...(data.stale === true ? { stale: true } : {}) };
}

const publicSourceCache = new Set(['netflix-source', 'uk-tv-source']);
const chartCacheKeys = new Set(trendingGroups.flatMap(group => group.rows));
const allowedCacheKeys = new Set([...chartCacheKeys, ...publicSourceCache, 'resolved-v2-netflix-tv', 'resolved-v2-netflix-movie']);

function storedPayload(key, data) {
	if (key === 'netflix-source') return netflixSourcePayload(data);
	if (key === 'uk-tv-source') return ukTvSourcePayload(data);
	return chartPayload(data);
}

const deferredError = () => Object.assign(Error('Charts are waiting for playback to finish.'), { status: 503, code: 'charts_deferred', deferred: true });
const busyError = () => Object.assign(Error('Charts are busy. Please try again shortly.'), { status: 503, code: 'charts_busy' });
const timeoutError = () => Object.assign(Error('Charts took too long. Please try again shortly.'), { status: 503, code: 'charts_timeout' });
const generationError = () => Object.assign(Error('Charts settings changed. Please try again shortly.'), { status: 503, code: 'charts_source_changed' });
const invalidError = () => Object.assign(Error('Charts returned an invalid response.'), { status: 502, code: 'charts_invalid' });
const unavailableError = () => Object.assign(Error('Charts are temporarily unavailable. Please try again shortly.'), { status: 503, code: 'charts_unavailable' });

const finite = (value, fallback) => Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : fallback;
const clamp = (value, min, max, fallback) => {
	const number = Number(value);
	return Number.isFinite(number) ? Math.max(min, Math.min(max, Math.round(number))) : fallback;
};

// Conservative playback/download check. A throwing check is treated as busy.
async function busyNow(check) {
	if (typeof check !== 'function') return false;
	try { return Boolean(await check()); } catch { return true; }
}

const neutralHit = item => item.id == null
	? { ...item, statusLabel:'Find this title', requestable:false, watchId:null, seasons:[] }
	: { ...item, status:6, statusLabel:'Not in your library', requestable:false, watchId:null, seasons:[] };

export function createTrending({call,view,enrich=async items=>items,fetcher=fetch,cachePath,now=Date.now,sourceKey=null,maxBytes=4*1024*1024,maxReadBytes=4*1024*1024,maxEntries=64,maxActive=2,maxQueue=8,queueWaitMs=20000,callTimeoutMs=45000}) {
	if (typeof call !== 'function') throw new TypeError('A chart upstream call function is required.');
	const cache=new Map(),pending=new Map(),retry=new Map();let save=Promise.resolve();
	const maxBytesBound=Math.max(1024,clamp(maxBytes,1024,64*1024*1024,4*1024*1024));
	const maxReadBound=Math.max(1024,clamp(maxReadBytes,1024,64*1024*1024,4*1024*1024));
	const maxEntriesBound=clamp(maxEntries,2,256,64);
	const maxActiveBound=clamp(maxActive,1,8,2);
	const maxQueueBound=clamp(maxQueue,0,64,8);
	const queueWaitBound=clamp(queueWaitMs,10,120000,20000);
	const callTimeoutBound=clamp(callTimeoutMs,10,180000,45000);
	const fingerprint=()=>{
		let raw='';try{raw=typeof sourceKey==='function'?sourceKey():sourceKey||'';}catch{raw='';}
		return raw?createHash('sha256').update('trending-133\u0000'+String(raw)).digest('hex').slice(0,32):'';
	};
	// A supplied accessor means this installation has a source identity, even
	// when it is currently unconfigured/empty. A legacy file can never be proven
	// to belong to it, so it is rejected; only a caller that opted out of source
	// identity entirely may reuse the pre-fingerprint upgrade file.
	const hasSourceIdentity = sourceKey !== null && sourceKey !== undefined;
	let currentSource=fingerprint();

	// -----------------------------------------------------------------------
	// Global upstream admission
	//
	// A visitor row, the scheduled preload and the owner refresh all share this
	// one gate, so distinct chart keys can never multiply simultaneous upstream
	// calls. A caller may stop waiting (deadline) but the physical slot is held
	// until the underlying promise actually settles: a non-cooperative loader is
	// quarantined against the same global maximum instead of being replaced on
	// every timeout. Admission is per leaf call, never held across a nested call,
	// so chart resolution cannot deadlock on itself.
	// -----------------------------------------------------------------------
	let activeCalls = 0, quarantinedCalls = 0;
	const highQueue = [], lowQueue = [];

	function acquire(priority) {
		const high = priority !== 'low';
		if (activeCalls < maxActiveBound && (high || (highQueue.length === 0 && lowQueue.length === 0))) {
			activeCalls++;
			return { promise: Promise.resolve(), cancel: () => {} };
		}
		const queue = high ? highQueue : lowQueue;
		if (highQueue.length + lowQueue.length >= maxQueueBound) return { promise: Promise.reject(busyError()), cancel: () => {} };
		let waiter = null;
		const promise = new Promise((resolve, reject) => {
			waiter = { resolve, reject, timer: null };
			waiter.timer = setTimeout(() => {
				const index = queue.indexOf(waiter);
				if (index >= 0) queue.splice(index, 1);
				reject(busyError());
			}, queueWaitBound);
			waiter.timer.unref?.();
			queue.push(waiter);
		});
		return {
			promise,
			cancel: () => {
				const index = queue.indexOf(waiter);
				if (index < 0) return;
				queue.splice(index, 1);
				clearTimeout(waiter.timer);
				waiter.reject(busyError());
			}
		};
	}

	function releaseSlot() {
		// Interactive work goes first; a background slot never jumps a queued
		// visitor. The slot transfers directly, so the maximum is never exceeded.
		const waiter = highQueue.shift() || lowQueue.shift();
		if (waiter) { clearTimeout(waiter.timer); waiter.resolve(); }
		else activeCalls--;
	}

	async function upstream(route, priority = 'high') {
		const admission = acquire(priority);
		await admission.promise;
		let settled = false, quarantined = false;
		const release = () => {
			if (settled) return;
			settled = true;
			if (quarantined) quarantinedCalls = Math.max(0, quarantinedCalls - 1);
			releaseSlot();
		};
		const physical = Promise.resolve().then(() => call(route));
		const tracked = physical.then(value => { release(); return value; }, error => { release(); throw error; });
		tracked.catch(() => {});
		let timer = null;
		try {
			return await new Promise((resolve, reject) => {
				timer = setTimeout(() => {
					// The caller's deadline does not free the physical slot; it stays
					// occupied (and visible) until the upstream promise settles.
					if (!quarantined) { quarantined = true; quarantinedCalls++; }
					reject(timeoutError());
				}, callTimeoutBound);
				timer.unref?.();
				tracked.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
			});
		} finally {
			if (timer) clearTimeout(timer);
		}
	}

	function syncSource(){
		const next=fingerprint();
		if(next!==currentSource){
			// Old in-flight work keeps its own generation key and can never publish
			// into the new source; it also cannot coalesce with the new generation.
			currentSource=next;cache.clear();retry.clear();
		}
		return currentSource;
	}

	// Startup re-reads a bounded public snapshot synchronously so the first
	// visitor sees last-known chart data without an upstream fetch. Size is
	// checked before JSON.parse; keys, entry count and every field are
	// allowlisted so an oversized or tampered file cannot enter memory raw.
	if(cachePath){
		try{
			const size=statSync(cachePath).size;
			if(!Number.isFinite(size)||size<=0||size>maxReadBound)throw Error('snapshot-size');
			const raw=JSON.parse(readFileSync(cachePath,'utf8'));
			const version2=Boolean(raw&&raw.version===2);
			if(version2&&raw.source!==currentSource)throw Error('source-changed');
			const entries=version2?raw.entries:raw;
			if(!entries||typeof entries!=='object'||Array.isArray(entries))throw Error('snapshot-shape');
			// The legacy flat map predates the source fingerprint. It is only
			// safe when this installation has no source identity at all; a
			// configured source can never prove a legacy file belongs to it, so
			// fail closed rather than serving another source's charts.
			if(!version2&&hasSourceIdentity)throw Error('legacy-source');
			let loaded=0;
			for(const [key,value] of Object.entries(entries)){
				if(loaded>=maxEntriesBound)break;
				if(typeof key!=='string'||!allowedCacheKeys.has(key))continue;
				if(!value||!Number.isFinite(value.time)||value.time>now()+300000||value.time<=now()-7*DAY)continue;
				const data=storedPayload(key,value.data);
				if(!data)continue;
				cache.set(key,{time:value.time,data});loaded++;
			}
		}catch{/* missing, unreadable, oversized or corrupt: start empty and recover on the next write */}
	}

	function serialize(){
		const entries={};
		let count=0;
		for(const [key,entry] of cache){
			if(count>=maxEntriesBound)break;
			if(!allowedCacheKeys.has(key))continue;
			entries[key]={time:entry.time,data:entry.data};count++;
		}
		return JSON.stringify({version:2,source:currentSource,entries});
	}

	function persist(){
		if(!cachePath)return;
		const data=serialize();
		if(Buffer.byteLength(data)>maxBytesBound)return;
		save=save.catch(()=>{}).then(async()=>{await mkdir(dirname(cachePath),{recursive:true,mode:0o700});await writeFile(cachePath+'.part',data,{mode:0o600});await rename(cachePath+'.part',cachePath);}).catch(()=>{});
	}

	function evictOne(){
		let victim=null,oldest=Infinity;
		for(const [key,entry] of cache)if(!victim||entry.time<oldest){victim=key;oldest=entry.time;}
		if(victim)cache.delete(victim);
	}

	function refresh(key,job,source=currentSource){
		const pendingKey=source+'\u0000'+key;
		if(pending.has(pendingKey))return pending.get(pendingKey);
		const work=(async()=>{
			try{
				const data=await job();
				if(syncSource()!==source)throw generationError();
				const stored=storedPayload(key,data);
				if(stored){
					if(!cache.has(key)&&cache.size>=maxEntriesBound)evictOne();
					cache.set(key,{time:now(),data:stored});retry.delete(key);persist();
				}else if(Array.isArray(data?.items)&&data.items.length===0){
					// Honest empty result: return it to this caller, but never replace
					// a nonempty last-good snapshot with nothing.
					retry.delete(key);
				}else{
					throw invalidError();
				}
				return data;
			}catch(error){
				// A playback deferral is not a failed upstream attempt; it must not
				// start a retry backoff for a generation that no longer applies.
				if(!error?.deferred&&syncSource()===source)retry.set(key,now()+60000);
				throw error;
			}finally{
				pending.delete(pendingKey);
			}
		})();
		pending.set(pendingKey,work);return work;
	}

	async function cached(key,job,ttl=HOUR){
		const entry=cache.get(key);
		if(entry&&now()-entry.time<ttl)return {data:entry.data,state:'fresh'};
		if(entry&&now()-entry.time<7*DAY){
			// Stale-while-revalidate: serve last-good immediately and refresh in
			// the background only when the retry backoff has elapsed.
			if((retry.get(key)||0)<now())void refresh(key,job).catch(()=>{});
			return {data:{...entry.data,stale:true},state:'stale'};
		}
		if((retry.get(key)||0)>now())throw unavailableError();
		return {data:await refresh(key,job),state:'miss'};
	}

	async function chart(type,context={}){
		const source=(await cached('netflix-source',()=>downloadNetflix(fetcher))).data;
		const upstreamCall=context.call||(route=>upstream(route,context.priority));
		const items=[];
		// Ten searches at a time would compete with playback; resolve in small
		// pairs and stop before the next pair if playback/download activity began.
		const rows=source.items.filter(i=>i.type===type);
		for(let n=0;n<rows.length;n+=2){
			if(await busyNow(context.isBusy))throw deferredError();
			items.push(...await Promise.all(rows.slice(n,n+2).map(async item=>{
				let match;try{
					const result=await upstreamCall('/search?query='+encodeURIComponent(item.title)+'&page=1');
					match=await matchNetflixChart(result.results,item.title,type,upstreamCall,item.season);
				}catch{}
				return {...(match?view(match,match.mediaType):{id:null,type,title:item.title,poster:null,ratings:[],statusLabel:'Find this title',requestable:false}),rank:item.rank,chartTitle:item.title,chartSeason:item.season};
			})));
		}
		return {title:'Netflix UK Top 10 · '+(type==='tv'?'Series':'Films'),note:'Official Netflix chart · week ending '+source.week,sourceUrl:'https://www.netflix.com/tudum/top10/united-kingdom'+(type==='tv'?'/tv':''),week:source.week,stale:Boolean(source.stale),items};
	}

	async function ukTelevision(context={}){
		const source=(await cached('uk-tv-source',()=>downloadUkTv(fetcher))).data;
		const upstreamCall=context.call||(route=>upstream(route,context.priority));
		const items=[];
		for(let n=0;n<source.items.length;n+=2){
			if(await busyNow(context.isBusy))throw deferredError();
			items.push(...await Promise.all(source.items.slice(n,n+2).map(async item=>{
				let match;
				try{match=await matchUkTv(item,source.week,upstreamCall);}catch{}
				return {...(match?view(match,match.mediaType):{id:null,type:'tv',title:item.title,poster:null,ratings:[],statusLabel:'Find this title',requestable:false}),rank:item.rank,rankLabel:'#'+item.rank+' · UK TV',chartTitle:item.title,chartChannel:item.channel};
			})));
		}
		return {title:'Popular on UK TV',note:'BARB / Thinkbox · programmes ranked by their most-watched broadcast · week ending '+source.week,sourceUrl:ukTvSourceUrl,week:source.week,stale:Boolean(source.stale),items};
	}

	async function build(key,context={}){
		const priority=context.priority==='low'?'low':'high';
		const scoped={...context,call:route=>upstream(route,priority)};
		if(key==='uk-tv')return ukTelevision(scoped);
		if(key==='netflix-tv'||key==='netflix-movie')return chart(key.slice(8),scoped);
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
		const data=await scoped.call(route);
		const seen=new Set();const items=(data.results||[]).filter(i=>!i.adult&&(!i.mediaType||i.mediaType===type)&&Number.isInteger(i.id)).filter(i=>{if(seen.has(i.id))return false;seen.add(i.id);return true;}).slice(0,10).map(i=>view(i,type));
		return {title,note,sourceUrl:'https://www.themoviedb.org',items};
	}

	async function trending(key){
		if(!trendingGroups.some(g=>g.rows.includes(key)))throw Object.assign(Error('Choose a valid trending category.'),{status:400});
		syncSource();
		const cacheKey=key.startsWith('netflix-')?'resolved-v2-'+key:key;
		const {data,state}=await cached(cacheKey,()=>build(key));
		// Availability is refreshed separately; cached charts never freeze local/VOD
		// status. A cache hit carries no trustworthy Seerr request workflow state,
		// so return a neutral status and let this request's enrich overlay run.
		const rows=(data.items||[]).map(item=>state==='miss'?item:neutralHit(item));
		const matched=rows.filter(i=>i.id),enriched=await enrich(matched),byId=new Map(enriched.map(i=>[i.type+':'+i.id,i]));
		return {...data,updated:new Date(cache.get(cacheKey)?.time||now()).toISOString(),items:rows.map(i=>i.id?{...i,...byId.get(i.type+':'+i.id),rank:i.rank,chartSeason:i.chartSeason}:i)};
	}

	// Warm the shared public chart snapshots without a visitor and without
	// per-request enrichment. Sequential, TTL-aware and bounded; a failed chart
	// keeps its last good snapshot and respects the retry backoff. Playback or
	// download activity is checked between rows and between chart call pairs.
	async function preload(keys=[],{max=8,isBusy=()=>false}={}) {
		syncSource();
		const limit=Math.max(1,Math.min(16,Number.isSafeInteger(Number(max))?Number(max):8));
		const valid=[...new Set(Array.isArray(keys)?keys:[])]
			.filter(key=>typeof key==='string'&&trendingGroups.some(group=>group.rows.includes(key)))
			.slice(0,limit);
		const result={keys:valid.length,ran:0,skipped:0,failed:0,deferred:false};
		for(const key of valid){
			if(await busyNow(isBusy)){result.deferred=true;break;}
			const cacheKey=key.startsWith('netflix-')?'resolved-v2-'+key:key;
			const entry=cache.get(cacheKey);
			if(entry&&now()-entry.time<HOUR){result.skipped++;continue;}
			if((retry.get(cacheKey)||0)>now()){result.skipped++;continue;}
			try{await refresh(cacheKey,()=>build(key,{priority:'low',isBusy}));result.ran++;}
			catch(error){if(error?.deferred){result.deferred=true;break;}result.failed++;}
		}
		await save;
		return result;
	}

	function status(){
		let newest=null,pendingCurrent=0;
		for(const entry of cache.values())if(!newest||entry.time>newest)newest=entry.time;
		for(const key of pending.keys())if(key.startsWith(currentSource+'\u0000'))pendingCurrent++;
		return {entries:cache.size,pending:pendingCurrent,retry:retry.size,newestAt:newest,
			source:currentSource?'set':'none',schema:2,
			admission:{active:activeCalls,queued:highQueue.length+lowQueue.length,quarantined:quarantinedCalls}};
	}

	return {trending,preload,status};
}
