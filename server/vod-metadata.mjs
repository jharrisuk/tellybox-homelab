import {readFile,writeFile,rename} from 'node:fs/promises';
import {score} from './insights.mjs';
import {trailerView} from './trailers.mjs';

const day=86400000;
// Increment when a cached presentation field is added or corrected. Older
// persisted entries must be refreshed once instead of waiting a full TTL.
const CACHE_SCHEMA=2;
const text=value=>typeof value==='string'?value.trim():'';
export const artworkPath=value=>/^\/[a-zA-Z0-9_-]+\.(jpg|jpeg|png|webp)$/i.test(value||'')?value:null;
const date=value=>/^\d{4}-\d{2}-\d{2}$/.test(value||'')&&Number.isFinite(Date.parse(value))?value:undefined;
export function metadataView(data,type,id) {
	if(Number(data.id)!==Number(id))throw Error('Metadata identity mismatch.');
	const release=date(type==='movie'?data.releaseDate:data.firstAirDate);
	const rating=score('TMDB',data.voteAverage,10,data.voteCount,`https://www.themoviedb.org/${type}/${id}`);
	return {
		Overview:text(data.overview).slice(0,12000),Genres:(data.genres||[]).map(g=>text(g.name)).filter(Boolean),
		PremiereDate:release,ProductionYear:release?Number(release.slice(0,4)):undefined,
		RunTimeTicks:Number(data.runtime)>0?Number(data.runtime)*60*1e7:undefined,
		CommunityRating:rating?.value,Ratings:rating?[rating]:[],
		Trailer:trailerView(data)||undefined,
		poster:artworkPath(data.posterPath),backdrop:artworkPath(data.backdropPath),MetadataSource:'TMDB'
	};
}

// A bounded, shared queue prevents a catalogue page from opening dozens of upstream requests.
// Cache entries contain metadata only: never provider URLs, credentials or playback identifiers.
export function createVodMetadata({lookup,file,clock=Date.now,ttl=7*day,concurrency=3}) {
	const cache=new Map(),pending=new Map(),queue=[];
	// Discovery already carries a trusted public TMDB filename. Remember only
	// those validated paths in a small FIFO so the origin route can resolve
	// without an upstream detail request or unbounded cache growth.
	const artworkPaths=new Map(),maxArtworkPaths=5000;
	let active=0,timer,writing=Promise.resolve();
	const ready=file?readFile(file,'utf8').then(raw=>{
		for(const [key,value] of JSON.parse(raw))if(/^(movie|tv)\/\d+$/.test(key)&&value?.data&&value.schema===CACHE_SCHEMA)cache.set(key,value);
	}).catch(()=>{}):Promise.resolve();
	function save() {
		if(!file||timer)return;
		timer=setTimeout(()=>{timer=null;writing=writing.then(async()=>{
			await writeFile(file+'.tmp',JSON.stringify([...cache]),{mode:0o600});await rename(file+'.tmp',file);
		}).catch(()=>{});},1000);timer.unref?.();
	}
	function key(item) {
		const id=Number(item.ProviderIds?.Tmdb),type={Movie:'movie',Series:'tv'}[item.Type];
		const premiere=date(text(item.PremiereDate).slice(0,10));
		const repairLocal=item.Source==='local'&&item.Type==='Series'&&Number(item.ProductionYear)>0&&premiere&&Number(item.ProductionYear)!==Number(premiere.slice(0,4));
		return (item.Source==='streamed'||repairLocal)&&type&&Number.isSafeInteger(id)&&id>0?`${type}/${id}`:null;
	}
	function apply(item) {
		const entry=cache.get(key(item)),data=entry?.data;
		if(!data)return item;
		const result={...item};
		// Repair conflicting local series presentation from its exact TMDB identity.
		// Keep local descriptions, ratings, episode numbering and curated consistent metadata.
		const fields=item.Source==='local'?['PremiereDate','ProductionYear','MetadataSource']:['Overview','Genres','PremiereDate','ProductionYear','CommunityRating','Ratings','MetadataSource'];
		for(const field of fields)if(data[field]!==undefined&&data[field]!==''&&(!Array.isArray(data[field])||data[field].length))result[field]=data[field];
		if(!result.RunTimeTicks&&data.RunTimeTicks)result.RunTimeTicks=data.RunTimeTicks;
		if(!result.Trailer&&data.Trailer)result.Trailer=data.Trailer;
		if(data.poster)result.Artwork=`/api/web/tmdb-art/${key(item)}/poster`;
		if(data.backdrop)result.BackdropArtwork=`/api/web/tmdb-art/${key(item)}/backdrop`;
		return result;
	}
	function pump() {
		while(active<concurrency&&queue.length) {
			const {id,resolve}=queue.shift();active++;
			const [type,number]=id.split('/');
			Promise.resolve().then(()=>lookup(type,Number(number))).then(raw=>{
				cache.set(id,{schema:CACHE_SCHEMA,time:clock(),retry:clock()+ttl,data:metadataView(raw,type,number)});save();
			}).catch(()=>{cache.set(id,{schema:CACHE_SCHEMA,...cache.get(id),retry:clock()+5*60000});}).finally(()=>{
				active--;pending.delete(id);resolve();pump();
			});
		}
	}
	function request(item) {
		const id=key(item);if(!id||cache.get(id)?.retry>clock())return Promise.resolve();
		if(pending.has(id))return pending.get(id);
		if(queue.length>=240)return Promise.resolve();
		let resolve;const promise=new Promise(r=>resolve=r);pending.set(id,promise);queue.push({id,resolve});pump();return promise;
	}
	async function enrich(items,{waitMs=1200}={}) {
		await ready;
		const done=Promise.all(items.map(request));
		let timeout;
		await Promise.race([done,new Promise(resolve=>{timeout=setTimeout(resolve,waitMs);})]);clearTimeout(timeout);
		return items.map(apply);
	}
	async function cached(items) {await ready;return items.map(apply);}
	// Synchronous availability for the bounded Home artwork warmer: an in-flight
	// lookup, a settled reusable entry, a settled error and an untouched title are
	// distinct, without queueing or changing any cache state.
	function state(item) {
		const id=key(item);if(!id)return 'none';
		const entry=cache.get(id);if(entry&&Number(entry.retry)>clock())return entry.data?'cached':'failed';
		if(pending.has(id))return 'pending';
		return 'missing';
	}
	async function artwork(type,id,kind) {
		await ready;
		const key=`${type}/${Number(id)}`;
		return artworkPath(cache.get(key)?.data?.[kind]||artworkPaths.get(key)?.[kind]);
	}
	// Discovery feeds already carry the exact public TMDB filename. Remember that
	// path so the existing origin artwork route can resolve without an extra
	// provider detail request. Paths live in a small FIFO, never in the metadata
	// cache, so they cannot suppress or inflate full metadata enrichment.
	function remember(type,id,kind,value) {
		const path=artworkPath(value),number=Number(id);
		if(!['movie','tv'].includes(type)||!['poster','backdrop'].includes(kind)||!Number.isSafeInteger(number)||number<=0||!path)return false;
		const key=`${type}/${number}`,existing=artworkPaths.get(key)||{};
		artworkPaths.delete(key);
		artworkPaths.set(key,{...existing,[kind]:path});
		if(artworkPaths.size>maxArtworkPaths)artworkPaths.delete(artworkPaths.keys().next().value);
		return true;
	}
	return {enrich,cached,artwork,remember,state,status:()=>({cached:[...cache.values()].filter(e=>e.data).length,pending:pending.size})};
}
