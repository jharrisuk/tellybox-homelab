import {readFile,writeFile,rename} from 'node:fs/promises';
import {score} from './insights.mjs';

const day=86400000;
const text=value=>typeof value==='string'?value.trim():'';
export const artworkPath=value=>/^\/[a-zA-Z0-9_-]+\.(jpg|png|webp)$/.test(value||'')?value:null;
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
		poster:artworkPath(data.posterPath),backdrop:artworkPath(data.backdropPath),MetadataSource:'TMDB'
	};
}

// A bounded, shared queue prevents a catalogue page from opening dozens of upstream requests.
// Cache entries contain metadata only: never provider URLs, credentials or playback identifiers.
export function createVodMetadata({lookup,file,clock=Date.now,ttl=7*day,concurrency=3}) {
	const cache=new Map(),pending=new Map(),queue=[];
	let active=0,timer,writing=Promise.resolve();
	const ready=file?readFile(file,'utf8').then(raw=>{
		for(const [key,value] of JSON.parse(raw))if(/^(movie|tv)\/\d+$/.test(key)&&value?.data)cache.set(key,value);
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
		if(data.poster)result.Artwork=`/api/web/tmdb-art/${key(item)}/poster`;
		if(data.backdrop)result.BackdropArtwork=`/api/web/tmdb-art/${key(item)}/backdrop`;
		return result;
	}
	function pump() {
		while(active<concurrency&&queue.length) {
			const {id,resolve}=queue.shift();active++;
			const [type,number]=id.split('/');
			Promise.resolve().then(()=>lookup(type,Number(number))).then(raw=>{
				cache.set(id,{time:clock(),retry:clock()+ttl,data:metadataView(raw,type,number)});save();
			}).catch(()=>{cache.set(id,{...cache.get(id),retry:clock()+5*60000});}).finally(()=>{
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
	async function artwork(type,id,kind) {
		await ready;return artworkPath(cache.get(`${type}/${Number(id)}`)?.data?.[kind]);
	}
	return {enrich,cached,artwork,status:()=>({cached:[...cache.values()].filter(e=>e.data).length,pending:pending.size})};
}
