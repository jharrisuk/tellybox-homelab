import {readFile,writeFile,rename,rm} from 'node:fs/promises';

const clean = value => typeof value==='string'?value.trim():'';
const positive = value => Number.isSafeInteger(Number(value))&&Number(value)>0?Number(value):null;
// A removed upstream title is a normal 404, not an upstream outage. Only the
// exact upstream 404 is translated; every other failure keeps its real status.
const gone = api => route => api(route).catch(error => {
	if (error?.upstreamStatus === 404) throw Object.assign(Error('This title is no longer available.'), { status: 404 });
	throw error;
});
const providerName = record => clean(record?.m3u_account?.name).slice(0,100);
export function selectProvider(records) {
	if(!Array.isArray(records))return null;
	// Dispatcharr orders VOD relations by account priority descending, then
	// relation id ascending (see its VOD proxy). Match that exactly so the
	// displayed provider is the one its stream route would choose.
	return records.filter(record=>record?.m3u_account&&record.m3u_account.is_active!==false&&providerName(record))
		.sort((a,b)=>(Number(b.m3u_account.priority)||0)-(Number(a.m3u_account.priority)||0)
			||(Number(a.id)||0)-(Number(b.id)||0)
			||providerName(a).localeCompare(providerName(b)))[0]||null;
}
export function providerLabel(records) {
	const chosen=selectProvider(records);
	return chosen?providerName(chosen):'';
}

export function ratingValue(item,source='rating') {
	const name={imdb:'imdb',rotten:'rotten tomatoes',tmdb:'tmdb'}[source];
	const rating=(item.Ratings||[]).find(r=>String(r.source).toLowerCase()===name);
	if(rating&&Number.isFinite(Number(rating.value)))return Number(rating.value)/Number(rating.max||10);
	return name?null:Number(item.CommunityRating)>0?Number(item.CommunityRating)/10:null;
}
export function vodView(item,type='Movie') {
	const year=positive(item.year)||Number(clean(item.name).match(/(?:\(| - )(19\d{2}|20\d{2})\)?$/)?.[1])||undefined;
	const id=positive(item.id);
	if(!id||!clean(item.name)||!['Movie','Series','Episode'].includes(type))return null;
	const kind={Movie:'movie',Series:'series',Episode:'episode'}[type];
	const name=clean(item.name).replace(/(?:\s*\(| - )(?:19\d{2}|20\d{2})\)?$/,'').trim();
	if(type==='Episode'&&!positive(item.series?.id))return null;
	const logoId=positive(item.logo?.id)||(type==='Episode'?positive(item.series?.logo?.id):null);
	const provider=providerLabel(item.providers)||'Dispatcharr';
	return {Id:`dispatch-${kind}-${id}${type==='Episode'?'-'+positive(item.series.id):''}`,Name:name,Type:type,Source:'streamed',Provider:provider,ProductionYear:year,
		Overview:clean(item.description).slice(0,12000),Genres:clean(item.genre).split(/[,/]/).map(x=>x.trim()).filter(Boolean),
		RunTimeTicks:Math.max(0,Number(item.duration_secs)||0)*1e7,CommunityRating:Math.min(10,Math.max(0,Number(item.rating)||0))||undefined,
		PremiereDate:item.air_date||item.custom_properties?.releaseDate||item.custom_properties?.release_date|| (type!=='Episode'&&year?`${year}-01-01`:undefined),DateCreated:item.created_at,
		ProviderIds:{...(positive(item.tmdb_id)?{Tmdb:String(positive(item.tmdb_id))}:{}),...(/^tt\d+$/.test(item.imdb_id||'')?{Imdb:item.imdb_id}:{})},
		Artwork:`/api/web/art/${kind}/${id}${logoId?'?v='+logoId:''}`,ImageTags:{},VodIds:[id],
		...(type==='Episode'?{ParentIndexNumber:Number(item.season_number),IndexNumber:Number(item.episode_number)}:{})};
}

function matchKeys(item) {
	const keys=[],type=item.Type,ids=item.ProviderIds||{};
	if(positive(ids.Tmdb))keys.push(type+':tmdb:'+positive(ids.Tmdb));
	if(/^tt\d+$/.test(ids.Imdb||''))keys.push(type+':imdb:'+ids.Imdb);
	return keys;
}
export function mergeLibrary(local,remote,seriesLinks={}) {
	const result=[],index=new Map(),localSeries=new Map();
	for(const original of [...local.map(i=>({...i,Source:'local'})),...remote]) {
		const item={...original,VodIds:[...(original.VodIds||[])]},keys=matchKeys(item);
		const candidates=[...new Set(keys.map(k=>index.get(k)).filter(Boolean))];
		// Explicit links resolve a confirmed metadata mismatch without guessing from titles.
		const linked=item.Type==='Series'&&item.Source==='streamed'?localSeries.get(seriesLinks[item.Id]):null;
		const existing=linked||(candidates.length===1?candidates[0]:null);
		if(existing && !(existing.Source==='local'&&item.Source==='local')) {
			existing.VodIds=[...new Set([...existing.VodIds,...item.VodIds])];
			continue;
		}
		result.push(item);
		if(item.Type==='Series'&&item.Source==='local')localSeries.set(item.Id,item);
		for(const key of keys)index.set(key,index.has(key)?null:item);
	}
	return result;
}
// Merge-time availability. This is deliberately stricter than a truthiness
// check but must not invent availability: an absent or unparseable premiere
// date is unknown, not future. A date-only value is compared by calendar day,
// so a date-only today is releasable while a date-only tomorrow is not.
function episodeReleasable(item,now) {
	if(item?.IsVirtualItem===true||item?.IsMissing===true||item?.IsUnaired===true)return false;
	const date=clean(item?.PremiereDate);
	if(!date)return true;
	const day=/^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
	if(day){
		const today=new Date(now);
		return Number(day[1]+day[2]+day[3])<=today.getFullYear()*10000+(today.getMonth()+1)*100+today.getDate();
	}
	const at=Date.parse(date);
	return !Number.isFinite(at)||at<=now;
}
function mergedVodIds(...items) {
	const ids=[];
	for(const item of items)for(const id of Array.isArray(item?.VodIds)?item.VodIds:[])
		if(id!==undefined&&id!==null&&!ids.includes(id))ids.push(id);
	return ids;
}
// Pick the row that owns playback identity. A local duplicate only wins when it
// is actually releasable; otherwise the streamed row stays the fallback. Two
// playable rows keep local priority, and equal-source duplicates keep the first
// (provider-priority) row deterministically.
function mergeEpisodeRows(current,incoming,now) {
	const currentLocal=current.Source==='local',incomingLocal=incoming.Source==='local';
	const currentReleasable=episodeReleasable(current,now),incomingReleasable=episodeReleasable(incoming,now);
	const incomingWins=incomingLocal
		?(currentLocal?incomingReleasable&&!currentReleasable:incomingReleasable)
		:(currentLocal?!currentReleasable&&incomingReleasable:incomingReleasable&&!currentReleasable);
	const winner=incomingWins?incoming:current,loser=incomingWins?current:incoming;
	// The winner owns Id/Source/availability. Metadata that does not determine
	// playback identity may still come from the other copy.
	const merged={...winner},vodIds=mergedVodIds(winner,loser);
	if(vodIds.length||'VodIds' in winner)merged.VodIds=vodIds;
	if(!clean(merged.Name)&&clean(loser.Name))merged.Name=loser.Name;
	if(!clean(merged.Artwork)&&clean(loser.Artwork))merged.Artwork=loser.Artwork;
	if(!(Number(merged.RunTimeTicks)>0)&&Number(loser.RunTimeTicks)>0)merged.RunTimeTicks=loser.RunTimeTicks;
	if(winner.ProviderIds&&loser.ProviderIds&&typeof winner.ProviderIds==='object'&&typeof loser.ProviderIds==='object')
		merged.ProviderIds={...loser.ProviderIds,...winner.ProviderIds};
	return merged;
}
export function mergeEpisodes(local,remote,series,now=Date.now()) {
	const byNumber=new Map(),extras=[];
	for(const item of [...remote,...local.map(e=>({...e,Source:'local'}))]) {
		if(!Number.isInteger(item.ParentIndexNumber)||item.ParentIndexNumber<0||!Number.isInteger(item.IndexNumber)||item.IndexNumber<1){extras.push(item);continue;}
		const key=item.ParentIndexNumber+':'+item.IndexNumber,current=byNumber.get(key);
		const merged=current?mergeEpisodeRows(current,item,now):item;
		byNumber.set(key,{...merged,SeriesId:series.Id,SeriesName:series.Name});
	}
	const order=value=>Number.isInteger(value)?value:Number.MAX_SAFE_INTEGER;
	return [...byNumber.values(),...extras].sort((a,b)=>order(a.ParentIndexNumber)-order(b.ParentIndexNumber)||order(a.IndexNumber)-order(b.IndexNumber)
		||clean(a.Name).localeCompare(clean(b.Name))||String(a.Id??'').localeCompare(String(b.Id??'')));
}

export function createVodLibrary({dispatcharr,localItems,localItem,localEpisodes,file,linksFile,seriesLinks={},metadata,clock=Date.now,indexFile=file+'.series.json'}) {
	let catalogue=[],lastRefresh=0,lastAttempt=0,pending,error='',persistenceError='',localCache,localPromise;
	let catalogueGeneration=0,providerIndexCache=null,providerIndexGeneration=-1;
	const details=new Map(),episodesCache=new Map(),episodesPending=new Map();
	const aliases=new Map(),hour=3600000,maxSeries=1000;
	// Browse availability is derived from the saved episode index. Local series
	// get a short-lived confirmation because Jellyfin can change without the
	// provider catalogue changing. All work here is bounded and coalesced.
	const localStates=new Map(),verifyPending=new Map(),verifyBackoff=new Map(),localStateMs=5*60000,streamedStateMs=hour;
	const background={queue:[],seen:new Set(),active:0,limit:2,cap:48};
	let backgroundTimer;
	// Dispatcharr caps page_size at 100 in production. This is a safety bound,
	// not an expected catalogue size: 1,000 pages covers 100,000 titles.
	const maxCataloguePages=1000;
	let indexPending,indexUpdated=0,indexProgress=0,indexTotal=0,indexError='',saveTimer,savePending=Promise.resolve();
	function remember(entry) {
		const id=entry.series.Id;
		episodesCache.set(id,entry);
		aliases.set(id,id);
		for(const vodId of entry.series.VodIds||[])aliases.set('dispatch-series-'+vodId,id);
	}
	function entryFor(id) {return episodesCache.get(aliases.get(id)||id);}
	function episodePlayable(episode,now=clock()) {
		if(episode?.IsVirtualItem===true||episode?.IsMissing===true)return false;
		const date=Date.parse(episode?.PremiereDate||'');
		return !Number.isFinite(date)||date<=now;
	}
	function stateOfEntry(entry,now=clock()) {
		// A saved list is only proof when it is complete, recent and the provider
		// did not report a failure. A failure is always unknown, never empty. A
		// stale positive must be re-verified rather than showing an episode list
		// that may since have become empty.
		if(!entry||!entry.value||!Array.isArray(entry.value.items))return 'unknown';
		if(entry.value.notice||Number(entry.failedAt||0)>0)return 'unknown';
		if(!(Number(entry.time)>0)||now-Number(entry.time)>streamedStateMs)return 'unknown';
		return entry.value.items.some(item=>episodePlayable(item,now))?'available':'empty';
	}
	function localEntryState(entry) {
		// Local availability is decided by Jellyfin episodes only. A streamed
		// duplicate in the same merged cache entry must not make an empty local
		// copy watchable. Only a complete, recent local list is proof.
		if(!entry||!entry.value||!Array.isArray(entry.value.items))return 'unknown';
		if(entry.value.notice||Number(entry.failedAt||0)>0)return 'unknown';
		if(entry.series?.Source!=='local')return 'unknown';
		if(!(Number(entry.time)>0)||clock()-Number(entry.time)>localStateMs)return 'unknown';
		const localItems=entry.value.items.filter(item=>item.Source==='local');
		return localItems.some(item=>episodePlayable(item))?'available':'empty';
	}
	function cachedSeriesState(id) {
		const entry=entryFor(id);
		if(String(id).startsWith('dispatch-'))return stateOfEntry(entry);
		const local=localStates.get(id);
		if(local&&clock()-local.time<localStateMs)return local.state;
		// Local episodes change without the provider catalogue changing. Trust a
		// saved complete local list; otherwise verify Jellyfin again before
		// hiding the item from browse.
		return localEntryState(entry);
	}
	// Cheap, network-free read of the saved availability for a bounded id set.
	// Home uses it between passes so a series proven by a parallel lookup (for
	// example Continue's exact episode) is not hidden by an earlier unknown.
	function cachedStates(ids) {
		const states=new Map();
		for(const id of [...new Set((Array.isArray(ids)?ids:[]).filter(id=>typeof id==='string'&&id))])states.set(id,cachedSeriesState(id));
		return states;
	}
	function saveIndex() {
		clearTimeout(saveTimer);saveTimer=null;
		savePending=savePending.then(async()=>{
			const entries=[...episodesCache.values()].sort((a,b)=>(b.access||0)-(a.access||0)).slice(0,maxSeries);
			await writeFile(indexFile+'.tmp',JSON.stringify({version:1,updated:indexUpdated,entries}),{mode:0o600});await rename(indexFile+'.tmp',indexFile);
		}).catch(()=>{indexError='Episode lists are available, but could not be saved for the next restart.';});
		return savePending;
	}
	function scheduleSave() {if(!saveTimer){saveTimer=setTimeout(saveIndex,500);saveTimer.unref?.();}}
	const restored=Promise.all([
		readFile(file,'utf8').then(text=>{const data=JSON.parse(text);if(Array.isArray(data.items)){catalogue=data.items;lastRefresh=data.time||0;}}).catch(()=>{}),
		linksFile?readFile(linksFile,'utf8').then(text=>{const links=JSON.parse(text);if(links&&typeof links==='object'&&!Array.isArray(links))seriesLinks=links;}).catch(()=>{}):null,
		readFile(indexFile,'utf8').then(text=>{
			const data=JSON.parse(text);if(data.version!==1||!Array.isArray(data.entries))return;
			for(const entry of data.entries.slice(0,maxSeries))if(entry.series?.Type==='Series'&&typeof entry.series.Id==='string'&&Array.isArray(entry.value?.items)&&Number.isFinite(entry.time))remember(entry);
			indexUpdated=Number(data.updated)||0;
		}).catch(()=>{})
	]);
	async function refresh() {
		await restored;
		if(pending)return pending;
		if(!dispatcharr.status().connected)return;
		lastAttempt=clock();
		pending=(async()=>{
			const next=[];
			try {
				for(const [kind,type] of [['movies','Movie'],['series','Series']]) {
					let page=1;
					while(page<=maxCataloguePages) {
						const data=await dispatcharr.api(`/api/vod/${kind}/?page_size=100&page=${page}&ordering=id`);
						const rows=Array.isArray(data)?data:data.results||[];
						next.push(...rows.map(i=>vodView(i,type)).filter(Boolean));
						if(Array.isArray(data)||!data.next||!rows.length)break;
						if(page===maxCataloguePages)throw Error('Catalogue exceeded the indexing limit.');
						page++;
					}
				}
			}catch{
				// Fetch/map failure: keep the last complete catalogue and tell the
				// viewer that indexed titles may be stale.
				error='The streamed catalogue could not be refreshed. Previously indexed titles may have changed.';
				return;
			}
			// The in-memory catalogue is complete even if persistence fails below.
			catalogue=[...new Map(next.map(i=>[i.Id,i])).values()];lastRefresh=clock();error='';
			catalogueGeneration++;
			try {
				await writeFile(file+'.tmp',JSON.stringify({items:catalogue,time:lastRefresh}),{mode:0o600});
				await rename(file+'.tmp',file);
				persistenceError='';
			}catch{
				persistenceError='The streamed catalogue refreshed, but could not be saved for the next restart.';
				await rm(file+'.tmp',{force:true}).catch(()=>{});
			}
		})();
		try{await pending;}finally{pending=null;}
	}
	async function locals() {
		if(localCache&&clock()-localCache.time<120000)return localCache.items;
		if(localPromise)return localPromise;
		localPromise=localItems().then(items=>{localCache={items,time:clock()};return items;});
		try{return await localPromise;}finally{localPromise=null;}
	}
	async function all({refresh:allowRefresh=true}={}) {
		await restored;
		if(allowRefresh&&dispatcharr.status().connected&&clock()-lastRefresh>60*60000&&clock()-lastAttempt>60000&&!pending)void refresh();
		const remote=dispatcharr.status().connected?catalogue:[];
		const items=mergeLibrary(await locals(),metadata?await metadata.cached(remote):remote,seriesLinks);
		return metadata?metadata.cached(items):items;
	}
	function sortItems(items,query) {
		items.sort((a,b)=>query.sort==='az'?a.Name.localeCompare(b.Name):query.sort==='release'?(Date.parse(b.PremiereDate)||0)-(Date.parse(a.PremiereDate)||0)||a.Name.localeCompare(b.Name):
			(a.Source==='local'?0:1)-(b.Source==='local'?0:1)||(Date.parse(b.Source==='local'?b.DateCreated:b.PremiereDate)||0)-(Date.parse(a.Source==='local'?a.DateCreated:a.PremiereDate)||0)||a.Name.localeCompare(b.Name));
		if(['rating','imdb','rotten','tmdb'].includes(query.sort))items.sort((a,b)=>(ratingValue(b,query.sort)??-1)-(ratingValue(a,query.sort)??-1)||a.Name.localeCompare(b.Name));
		return items;
	}
	async function list(query={}) {
		const localOnly=query.source==='local';
		// A local-only view must not start or display streamed catalogue work.
		let items=await all({refresh:!localOnly});
		const term=clean(query.search).toLowerCase(),type={movies:'Movie',tvshows:'Series'}[query.type];
		if(type)items=items.filter(i=>i.Type===type);
		const genres=[...new Set(items.flatMap(i=>i.Genres||[]))].sort((a,b)=>a.localeCompare(b));
		if(query.genre)items=items.filter(i=>(i.Genres||[]).some(g=>g.toLowerCase()===clean(query.genre).toLowerCase()));
		if(term)items=items.filter(i=>(i.Name+' '+(i.Genres||[]).join(' ')).toLowerCase().includes(term));
		if(query.source==='local')items=items.filter(i=>i.Source==='local');
		if(query.source==='streamed')items=items.filter(i=>i.Source!=='local');
		// A local record is only a watch-now item when it is actually playable:
		// missing files and zero-episode series do not belong in normal browse lists.
		items=items.filter(i=>i.Source!=='local'||(i.IsMissing!==true&&(i.Type!=='Series'||Number(i.ChildCount)!==0)));
		items=sortItems(items,query);
		const candidates=items;
		const start=Math.max(0,Number(query.start)||0),pageSize=60;
		const availability={pending:0,queued:0,checked:0};
		let unknownLater=false;
		// Normal Series browse is verified availability: empty and unknown series
		// are not watchable. Movies and other types pass through unchanged.
		if(type!=='Movie'){
			const states=new Map();
			for(const item of items)if(item.Type==='Series')states.set(item.Id,cachedSeriesState(item.Id));
			const verifyLimit=24;
			// Verify the prefix up to this page, then continue scanning past known
			// empty/available titles until the bounded unknown budget is full. A
			// catalogue with a long empty prefix must not leave the first page
			// permanently empty while playable titles exist further down.
			const wanted=[],seenWanted=new Set();
			let scanIndex=start+pageSize+verifyLimit;
			const collect=item=>{
				if(item.Type!=='Series'||wanted.length>=verifyLimit||seenWanted.has(item.Id))return;
				if(states.get(item.Id)!=='unknown'||!actionableUnknown(item.Id))return;
				seenWanted.add(item.Id);wanted.push(item);
			};
			for(const item of items.slice(0,scanIndex))collect(item);
			for(;scanIndex<items.length&&wanted.length<verifyLimit;scanIndex++)collect(items[scanIndex]);
			if(wanted.length){
				const localFirst=wanted.filter(item=>item.Source==='local').map(item=>item.Id);
				const ordered=[...localFirst,...wanted.filter(item=>item.Source!=='local').map(item=>item.Id)];
				const verified=await verifySeries(ordered,{limit:verifyLimit,deadlineMs:2500,concurrency:3,priority:localFirst});
				for(const [id,state] of verified.states)states.set(id,state);
				availability.checked=verified.checked;
				const remaining=wanted.filter(item=>states.get(item.Id)==='unknown').map(item=>item.Id);
				// Continue scanning for a bounded lookahead so the client can poll
				// or Load more without re-targeting the raw prefix.
				for(const item of items){
					if(remaining.length>=verifyLimit)break;
					if(item.Type==='Series'&&states.get(item.Id)==='unknown'&&actionableUnknown(item.Id)&&!remaining.includes(item.Id))remaining.push(item.Id);
				}
				availability.pending=remaining.length;
				availability.queued=enqueueBackground(remaining);
			}
			items=items.filter(item=>item.Type!=='Series'||states.get(item.Id)==='available');
			// Unverified series after the last title actually returned can still
			// become another page, even though the verified total is a lower bound.
			const lastAt=Math.min(start+pageSize,items.length)-1;
			const lastItem=lastAt>=start?items[lastAt]:null;
			const candidateAt=lastItem?candidates.indexOf(lastItem):-1;
			unknownLater=candidates.slice(candidateAt+1).some(item=>item.Type==='Series'&&states.get(item.Id)==='unknown');
		}
		const page=items.slice(start,start+pageSize);
		return {items:metadata?await metadata.enrich(page):page,total:items.length,genres,
			hasMore:start+page.length<items.length||unknownLater,
			availability,
			indexing:!localOnly&&Boolean(pending&&!catalogue.length),
			notice:localOnly?'':error||(!catalogue.length&&pending?'Adding your streamed catalogue. Your local collection is ready below.':''),
			indexed:catalogue.length};
	}
	async function searchMatches(term,type) {
		const value=clean(term).toLowerCase(),kind={movies:'Movie',tvshows:'Series'}[type];
		return (await all()).filter(item=>(!kind||item.Type===kind)&&(item.Name+' '+(item.Genres||[]).join(' ')).toLowerCase().includes(value));
	}
	async function searchEpisodes(term) {
		await restored;
		const value=clean(term).toLowerCase(),connected=dispatcharr.status().connected;
		return [...episodesCache.values()].flatMap(entry=>entry.value.items)
			.filter(item=>(connected||item.Source!=='streamed')&&`${item.Name} ${item.SeriesName||''}`.toLowerCase().includes(value));
	}
	async function releasedEpisodes() {
		await restored;
		if(!dispatcharr.status().connected)return [];
		// Read the hourly episode index, without querying every provider on a home-page visit.
		const ids=new Set(catalogue.filter(i=>i.Type==='Series').flatMap(i=>i.VodIds||[]));
		return [...episodesCache.values()].filter(entry=>entry.series.VodIds?.some(id=>ids.has(id)))
			.flatMap(entry=>entry.value.items.filter(item=>item.Source==='streamed'));
	}
	async function availability(items) {
		await restored;
		// Build the provider ID map once per catalogue generation. A 45k
		// catalogue previously rebuilt this map on every Discover rail; the map
		// is rebuilt only after a real catalogue refresh.
		let index=new Map();
		if(dispatcharr.status().connected){
			if(!providerIndexCache||providerIndexGeneration!==catalogueGeneration){
				providerIndexCache=new Map();
				for(const item of catalogue)for(const key of matchKeys(item))if(!providerIndexCache.has(key))providerIndexCache.set(key,item);
				providerIndexGeneration=catalogueGeneration;
			}
			index=providerIndexCache;
		}
		// Seerr's library sync can lag behind Jellyfin. Match the actual local catalogue
		// by type and provider ID, never by title or year (remakes can share both).
		const available=await locals().catch(()=>[]);
		// Discover must never advertise a local Watch CTA for an empty (or not yet
		// verified) local series. Verify only the local series that actually match
		// this response, through Jellyfin episodes, within the same bounded budget.
		const wanted=new Set();
		for(const item of Array.isArray(items)?items:[]){
			if(item?.type==='tv'&&positive(item.id))wanted.add('Series:tmdb:'+positive(item.id));
		}
		const localUnknown=[];
		for(const item of available){
			if(item.IsMissing===true||item.Type!=='Series')continue;
			if(matchKeys(item).some(key=>wanted.has(key))&&cachedSeriesState(item.Id)==='unknown')localUnknown.push(item.Id);
		}
		if(localUnknown.length)await verifySeries(localUnknown,{limit:24,deadlineMs:2500,concurrency:3});
		const localIndex=new Map();
		for(const item of available){
			// Discover/Search still return unavailable titles, but only a local
			// series with confirmed playable episodes may claim 'In your library'.
			if(item.IsMissing===true||(item.Type==='Series'&&cachedSeriesState(item.Id)!=='available'))continue;
			for(const key of matchKeys(item)){
				if(!localIndex.has(key))localIndex.set(key,item);
				else if(localIndex.get(key)?.Id!==item.Id)localIndex.set(key,null);
			}
		}
		return items.map(item=>{
			const key=(item.type==='tv'?'Series':'Movie')+':tmdb:'+item.id;
			const match=index.get(key),local=localIndex.get(key);
			// Never trust an inbound Seerr/Discover watchId. It can lag behind
			// Jellyfin and point at a local Series that now has no episodes, which
			// would show a false "In your library"/Watch CTA and hide the streamed
			// action. Only the verified local match below may set it.
			let result={...item};
			if(typeof result.watchId==='string'&&result.watchId)delete result.watchId;
			if(result.statusLabel==='In your library')delete result.statusLabel;
			if(match){result.vodId=match.Id;result.vodProvider=match.Provider||'Dispatcharr';result.vodAvailable=true;}
			if(local)result={...result,watchId:local.Id,statusLabel:'In your library'};
			return result;
		});
	}
	/**
	 * A bounded, genre-balanced slice of the whole available catalogue.
	 * Recent releases alone starve recommendations on a large library, so build
	 * one deterministic bucket per primary genre and round-robin between them.
	 * No provider metadata is fetched here; callers rank these titles with their
	 * own local signals.
	 */
	async function recommendationPool(type='Movie',limit=600,{allowed=()=>true}={}) {
		const cap=Math.max(1,Math.min(1200,Number.isInteger(Number(limit))?Number(limit):600));
		// Apply the caller's policy before sampling. Otherwise a restrictive viewer
		// could receive a balanced slice that is mostly hidden and end up starved.
		const items=(await all()).filter(item=>item.Type===type&&item.Name&&allowed(item)
			&&(item.Source!=='local'||(item.IsMissing!==true&&(item.Type!=='Series'||Number(item.ChildCount)!==0)))
			&&(item.Type!=='Series'||cachedSeriesState(item.Id)==='available'));
		const rank=(a,b)=>(ratingValue(b)??0)-(ratingValue(a)??0)
			||(Date.parse(b.PremiereDate)||0)-(Date.parse(a.PremiereDate)||0)
			||a.Name.localeCompare(b.Name);
		const buckets=new Map();
		for(const item of items){
			const genre=clean((item.Genres||[])[0]).toLowerCase()||'other';
			if(!buckets.has(genre))buckets.set(genre,[]);
			buckets.get(genre).push(item);
		}
		const queues=[...buckets.keys()].sort().map(key=>buckets.get(key).sort(rank));
		const result=[],seen=new Set();
		for(let round=0;result.length<cap;round++){
			let added=false;
			for(const queue of queues){
				const item=queue[round];
				if(!item)continue;
				if(seen.has(item.Id))continue;
				seen.add(item.Id);result.push(item);added=true;
				if(result.length>=cap)break;
			}
			if(!added)break;
		}
		// Keep the response small enough for a phone and never include shared
		// Jellyfin UserData or provider text. An allowlist also protects future
		// private fields from leaking through a new route.
		const safe=['Id','Name','Type','MediaType','Source','Provider','ProductionYear','PremiereDate','DateCreated','ProviderIds','OfficialRating','CommunityRating','RunTimeTicks','Genres','IndexNumber','ParentIndexNumber','SeriesName','SeriesId','ImageTags','BackdropImageTags','ParentBackdropItemId','ParentBackdropImageTags','PrimaryImageAspectRatio','Artwork','VodIds','Ratings'];
		return result.map(item=>{
			const view=Object.fromEntries(safe.filter(key=>item[key]!==undefined).map(key=>[key,item[key]]));
			// Nested provider ids and rating rows are narrowed too, so a future
			// adapter cannot smuggle a private key inside an allowed object.
			if(view.ProviderIds)view.ProviderIds=Object.fromEntries(['Tmdb','Imdb'].filter(key=>view.ProviderIds[key]!==undefined).map(key=>[key,view.ProviderIds[key]]));
			if(Array.isArray(view.Ratings))view.Ratings=view.Ratings.map(rating=>Object.fromEntries(['source','value','max','votes','url'].filter(key=>rating?.[key]!==undefined).map(key=>[key,rating[key]])));
			return view;
		});
	}
	async function releases(type,limit=16) {
		const now=clock(),since=now-366*86400000;
		const recent=(await all()).filter(i=>i.Type===type&&Date.parse(i.PremiereDate)>=since&&Date.parse(i.PremiereDate)<=now)
			.sort((a,b)=>Date.parse(b.PremiereDate)-Date.parse(a.PremiereDate)||(Date.parse(b.DateCreated)||0)-(Date.parse(a.DateCreated)||0)||a.Name.localeCompare(b.Name));
		// Reserve space for both sources; year-only provider dates must not hide the VOD catalogue.
		const streamed=recent.filter(i=>i.Source==='streamed').slice(0,Math.ceil(limit/2));
		const chosen=new Set(streamed.map(i=>i.Id));
		for(const item of recent){if(chosen.size>=limit)break;chosen.add(item.Id);}
		const result=recent.filter(i=>chosen.has(i.Id));
		return metadata?metadata.enrich(result):result;
	}
	async function raw(id) {
		const m=/^dispatch-(movie|series|episode)-(\d+)(?:-(\d+))?$/.exec(id);
		if(!m||!positive(m[2])||(m[1]==='episode'?!positive(m[3]):Boolean(m[3])))throw Object.assign(Error('Invalid streamed title.'),{status:400});
		const kind={movie:'movies',series:'series',episode:'episodes'}[m[1]],type={movie:'Movie',series:'Series',episode:'Episode'}[m[1]];
		const hit=details.get(id);if(hit&&clock()-hit.time<300000)return hit.value;
		const catalogue=gone(dispatcharr.api);
		let value;
		if(type==='Episode') {
			// The series endpoint works on Dispatcharr versions whose episode serializer returns HTTP 500.
			const data=await catalogue(`/api/vod/series/${m[3]}/episodes/`),rows=Array.isArray(data)?data:data.results||[];
			value=rows.find(e=>Number(e.id)===Number(m[2])&&Number(e.series?.id)===Number(m[3]));
			if(!value)throw Object.assign(Error('This episode is no longer available.'),{status:404});
		} else value=await catalogue(`/api/vod/${kind}/${m[2]}/`);
		const result={data:value,kind,type,id:Number(m[2])};details.set(id,{value:result,time:clock()});
		if(details.size>500)details.delete(details.keys().next().value);
		return result;
	}
	async function itemFresh(id) {
		if(!id.startsWith('dispatch-')) {
			const original=await localItem(id),match=(await all()).find(i=>i.Id===id);
			const view={...original,Source:'local',VodIds:match?.VodIds||[]};
			return metadata?(await metadata.enrich([view]))[0]:view;
		}
		const result=await raw(id),view=vodView(result.data,result.type);
		if(!view)throw Object.assign(Error('This title is no longer available.'),{status:404});
		if(result.type==='Series') {
			const canonical=(await all()).find(i=>i.Type==='Series'&&i.VodIds?.includes(result.id));
			if(canonical?.Source==='local')return {...await itemFresh(canonical.Id),RequestedId:id};
			if(canonical)view.VodIds=canonical.VodIds;
		}
		if(result.type==='Episode') {view.SeriesId='dispatch-series-'+result.data.series?.id;view.SeriesName=result.data.series?.name;view.Artwork='/api/web/art/series/'+result.data.series?.id;}
		return metadata?(await metadata.enrich([view],{waitMs:3500}))[0]:view;
	}
	function stale(entry) {return clock()-entry.time>=hour&&clock()>=(entry.retry||0);}
	function refreshInBackground(entry) {
		if(stale(entry)){entry.retry=clock()+60000;void refreshEpisodes(entry.series.Id,{force:true}).catch(()=>{});}
	}
	async function item(id) {
		await restored;
		const entry=entryFor(id);
		if(entry){entry.access=clock();refreshInBackground(entry);const view={...entry.series,...(id!==entry.series.Id?{RequestedId:id}:{})};return metadata?(await metadata.enrich([view]))[0]:view;}
		return itemFresh(id);
	}
	async function refreshEpisodes(id,{force=false}={}) {
		await restored;
		const known=entryFor(id),key=known?.series.Id||id;
		if(episodesPending.has(key))return episodesPending.get(key);
		if(known&&!force&&!stale(known))return known.value;
		// Resolve aliases before taking the lock: both local and VOD links share one refresh.
		let series;
		try{series=await itemFresh(key);}catch(e){if(known){known.retry=clock()+300000;known.failedAt=clock();}throw e;}
		if(series.Type!=='Series')throw Object.assign(Error('Choose a series.'),{status:400});
		if(episodesPending.has(series.Id))return episodesPending.get(series.Id);
		const previous=entryFor(series.Id);
		if(previous&&!force&&!stale(previous))return previous.value;
		const pending=(async()=>{
		let local=[];const remote=[];
		let unavailable=false;
		try{local=series.Source==='local'?await localEpisodes(series.Id):[];}catch{unavailable=true;}
		for(const vodId of series.VodIds||[]) {
			try{
				// Dispatcharr lazily imports the provider's episodes on this detail request.
				await dispatcharr.api(`/api/vod/series/${vodId}/provider-info/`);
				const data=await dispatcharr.api(`/api/vod/series/${vodId}/episodes/`),rows=Array.isArray(data)?data:data.results||[];
				// The provider's series row often has no logo or TMDB id, so the
				// generic /api/web/art/series/<vodId> route 404s and streamed episode
				// rows show empty squares. The parent series already resolved a
				// working poster for its own detail page; episodes inherit it.
				const parentArtwork=typeof series.Artwork==='string'&&series.Artwork?series.Artwork:'';
				remote.push(...rows.map(e=>{const v=vodView(e,'Episode');return v?{...v,Artwork:parentArtwork||('/api/web/art/series/'+vodId),Name:v.Name.replace(/^.*?\s[-–]\sS\d+E\d+\s[-–]\s/i,'')}:null;}).filter(Boolean));
			}catch{unavailable=true;}
		}
		// A temporary upstream failure must not replace a complete saved season list with a partial one.
		if(unavailable){indexError='Some series could not be refreshed. Saved episode lists remain available.';}
		if(unavailable&&previous){previous.retry=clock()+300000;previous.failedAt=clock();return previous.value;}
		const value={items:mergeEpisodes(local,remote,series,clock()),notice:unavailable?'Some episodes could not be loaded. The available episodes are shown while we retry.':''};
		remember({series,value,time:unavailable?clock()-hour:clock(),retry:unavailable?clock()+300000:0,access:previous?.access||clock()});
		if(episodesCache.size>maxSeries){
			const oldest=[...episodesCache.values()].sort((a,b)=>(a.access||0)-(b.access||0))[0];episodesCache.delete(oldest.series.Id);
			for(const [alias,target] of aliases)if(target===oldest.series.Id)aliases.delete(alias);
		}
		scheduleSave();
		return value;
		})();
		episodesPending.set(series.Id,pending);
		try{return await pending;}finally{episodesPending.delete(series.Id);}
	}
	async function episodes(id) {
		await restored;
		const entry=entryFor(id);
		if(entry){entry.access=clock();refreshInBackground(entry);return entry.value;}
		return refreshEpisodes(id);
	}
	const verifyGlobal={active:0,activeLimit:4,queue:[],queueLimit:32};
	function drainVerifyQueue(){
		while(verifyGlobal.active<verifyGlobal.activeLimit&&verifyGlobal.queue.length){
			const entry=verifyGlobal.queue.shift();
			if(entry.settled)continue;
			if(Number.isFinite(entry.expiresAt)&&Date.now()>=entry.expiresAt){
				entry.settled=true;verifyPending.delete(entry.id);entry.resolve('unknown');continue;
			}
			entry.started=true;verifyGlobal.active++;
			runVerify(entry.id).then(state=>entry.resolve(state),()=>entry.resolve('unknown')).finally(()=>{
				entry.settled=true;verifyGlobal.active--;verifyPending.delete(entry.id);
				if(verifyGlobal.queue.length)drainVerifyQueue();
			});
		}
	}
	function scheduleVerify(id,{expiresAt=Infinity}={}){
		const pending=verifyPending.get(id);
		if(pending)return pending;
		if(Number(verifyBackoff.get(id)||0)>clock())return Promise.resolve('unknown');
		if(verifyGlobal.active>=verifyGlobal.activeLimit&&verifyGlobal.queue.length>=verifyGlobal.queueLimit)return Promise.resolve('unknown');
		let resolve;
		const promise=new Promise(done=>{resolve=done;});
		const entry={id,expiresAt,settled:false,started:false,resolve};
		verifyPending.set(id,promise);
		if(Number.isFinite(expiresAt)){
			const timer=setTimeout(()=>{
				if(entry.settled||entry.started)return;
				entry.settled=true;verifyPending.delete(id);resolve('unknown');drainVerifyQueue();
			},Math.max(0,expiresAt-Date.now()));
			timer.unref?.();
		}
		if(verifyGlobal.active<verifyGlobal.activeLimit){
			entry.started=true;verifyGlobal.active++;
			runVerify(id).then(state=>resolve(state),()=>resolve('unknown')).finally(()=>{
				entry.settled=true;verifyGlobal.active--;verifyPending.delete(id);
				if(verifyGlobal.queue.length)drainVerifyQueue();
			});
		}
		else verifyGlobal.queue.push(entry);
		return promise;
	}
	async function runVerify(id){
		const local=!String(id).startsWith('dispatch-');
		try{
			if(local){
				// Never merge remote VodIds while checking a local copy: a
				// local-only view must not cause provider work, and a
				// streamed duplicate must not make an empty local copy playable.
				const items=typeof localEpisodes==='function'?await localEpisodes(id):null;
				if(!Array.isArray(items)){verifyBackoff.set(id,clock()+60000);return 'unknown';}
				const state=items.some(item=>episodePlayable(item))?'available':'empty';
				localStates.set(id,{state,time:clock()});
				verifyBackoff.delete(id);
				return state;
			}
			const entry=entryFor(id);
			// Respect an existing failure backoff. A stale positive saved list
			// is not trusted: force a refresh so a title that has become empty
			// is removed instead of remaining playable forever.
			if(entry&&Number(entry.retry||0)>clock())return 'unknown';
			if(entry)await refreshEpisodes(id,{force:true});
			else await episodes(id);
			const state=stateOfEntry(entryFor(id));
			if(state==='unknown')verifyBackoff.set(id,clock()+60000);
			else verifyBackoff.delete(id);
			return state;
		}catch{verifyBackoff.set(id,clock()+60000);return 'unknown';}
	}
	function actionableUnknown(id) {
		return !verifyPending.has(id) && !(Number(verifyBackoff.get(id) || 0) > clock());
	}
	function verifyOne(id,{expiresAt=Infinity}={}){return scheduleVerify(id,{expiresAt});}
	/**
	 * Verify a bounded set of series against the saved episode index.
	 *
	 * Unknown ids are checked with at most `limit` upstream/coalesced calls and
	 * `concurrency` workers before `deadlineMs` elapses. Ids already in flight
	 * are joined, not requested again. The returned map always covers every
	 * requested id; unresolved ids stay 'unknown'.
	 */
	async function verifySeries(ids,{limit=24,deadlineMs=2500,concurrency=3,priority=[]}={}) {
		await restored;
		const unique=[...new Set((Array.isArray(ids)?ids:[]).filter(id=>typeof id==='string'&&id))];
		const states=new Map();
		for(const id of unique)states.set(id,cachedSeriesState(id));
		const limitValue=Math.max(0,Math.min(200,Number.isSafeInteger(Number(limit))?Number(limit):24));
		const priorityIds=new Set((Array.isArray(priority)?priority:[]).filter(id=>typeof id==='string'&&states.get(id)==='unknown'&&actionableUnknown(id)));
		const ordered=[...unique.filter(id=>priorityIds.has(id)),...unique.filter(id=>!priorityIds.has(id)&&states.get(id)==='unknown'&&actionableUnknown(id))];
		const jobs=ordered.slice(0,limitValue);
		const until=clock()+Math.max(0,Number(deadlineMs)||0);
		const workers=Math.max(1,Math.min(8,Number.isSafeInteger(Number(concurrency))&&Number(concurrency)>0?Number(concurrency):3));
		let cursor=0,checked=0;
		const race=work=>{
			const remaining=until-clock();
			if(remaining<=0)return Promise.resolve('unknown');
			let timer;
			return Promise.race([work,new Promise(resolve=>{timer=setTimeout(()=>resolve('unknown'),remaining);timer.unref?.();})])
				.finally(()=>{if(timer)clearTimeout(timer);});
		};
		async function worker(){
			while(cursor<jobs.length&&clock()<until){
				const id=jobs[cursor++];
				const running=verifyPending.get(id);
				if(!running)checked++;
				const expiresAt=Date.now()+Math.max(1,until-clock());
				const state=await race(running||verifyOne(id,{expiresAt}));
				if(state!=='unknown')states.set(id,state);
			}
		}
		await Promise.all(Array.from({length:Math.min(workers,jobs.length)},()=>worker()));
		let pending=0;
		for(const id of unique)if(states.get(id)==='unknown')pending++;
		return {states,checked,pending,limit:limitValue};
	}
	function drainBackground(){
		while(background.active<background.limit&&background.queue.length){
			const id=background.queue.shift();
			background.active++;
			verifyOne(id).then(state=>state,()=>'unknown').finally(()=>{
				background.active--;background.seen.delete(id);
				if(background.queue.length)drainBackground();
			});
		}
	}
	function enqueueBackground(ids){
		let queued=0;
		for(const id of Array.isArray(ids)?ids:[]){
			if(background.queue.length>=background.cap)break;
			if(background.seen.has(id)||cachedSeriesState(id)!=='unknown')continue;
			const entry=entryFor(id);
			// Respect the existing failure backoff instead of retrying a failed
			// provider on every page.
			if(entry&&Number(entry.retry||0)>clock())continue;
			background.queue.push(id);background.seen.add(id);queued++;
		}
		if(queued&&!backgroundTimer){
			backgroundTimer=setTimeout(()=>{backgroundTimer=null;drainBackground();},250);
			backgroundTimer.unref?.();
		}
		return queued;
	}
	async function flushAvailability({timeoutMs=5000}={}){
		const until=Date.now()+Math.max(0,Number(timeoutMs)||0);
		while((background.queue.length||background.active||verifyPending.size)&&Date.now()<until){
			if(background.queue.length)drainBackground();
			await new Promise(resolve=>setTimeout(resolve,5));
		}
		return {queued:background.queue.length,active:background.active,pending:verifyPending.size};
	}
	/**
	 * Refresh a bounded, stale-only slice of the saved series index.
	 *
	 * The hourly server scheduler must call this without `force`: entries whose
	 * saved list is younger than `staleMs` are skipped, so a large catalogue is
	 * worked through over several runs instead of hammering every provider at
	 * once. A manual `force` still ignores per-series staleness, but remains
	 * bounded by `batchSize` and capped at two concurrent upstream refreshes.
	 *
	 * When `isBusy()` reports live playback, the run is deferred before any
	 * catalogue or episode cache is touched. The catalogue itself is only
	 * refetched when it is genuinely stale.
	 */
	async function refreshSeriesIndex({force=false,batchSize=24,staleMs=6*hour,concurrency=2,isBusy=()=>false}={}) {
		if(indexPending)return indexPending;
		const limit=Math.max(1,Math.min(maxSeries,Number.isSafeInteger(Number(batchSize))&&Number(batchSize)>0?Number(batchSize):24));
		const workers=Math.max(1,Math.min(2,Number.isSafeInteger(Number(concurrency))&&Number(concurrency)>0?Number(concurrency):2));
		const age=Number.isFinite(Number(staleMs))&&Number(staleMs)>0?Math.max(hour,Number(staleMs)):6*hour;
		const busy=async()=>{try{return Boolean(await isBusy());}catch{return false;}};
		indexPending=(async()=>{
			await restored;
			if(await busy())return {deferred:true,reason:'busy',refreshed:0,total:0,skipped:0};
			indexError='';indexProgress=0;
			// Only pay for the provider catalogue when it is stale (or explicitly
			// forced by an administrator). Keep the existing one-hour catalogue TTL;
			// `staleMs` governs the saved series lists, not the catalogue itself.
			if(force||!lastRefresh||clock()-lastRefresh>=hour)await refresh();
			if(await busy())return {deferred:true,reason:'busy',refreshed:0,total:0,skipped:0};
			localCache=null;
			// Do not let all() start its own hour-based background refresh during a
			// deliberately bounded sweep; catalogue freshness is handled above.
			const library=await all({refresh:false}),series=library.filter(i=>i.Type==='Series');
			const current=new Map(series.map(i=>[i.Id,i]));
			const candidates=new Set(series.filter(i=>i.Source==='local').map(i=>i.Id));
			// Prepare recently browsed VOD and a small new-release selection, not the entire provider catalogue.
			for(const entry of episodesCache.values())if(clock()-(entry.access||0)<30*86400000){
				const match=current.get(entry.series.Id)||series.find(i=>i.VodIds?.some(v=>entry.series.VodIds?.includes(v)));
				if(match)candidates.add(match.Id);
			}
			for(const item of series.filter(i=>i.Source==='streamed').sort((a,b)=>(Date.parse(b.PremiereDate)||0)-(Date.parse(a.PremiereDate)||0)).slice(0,20))candidates.add(item.Id);
			const now=clock(),selected=[];
			for(const id of candidates){
				const entry=entryFor(id);
				if(!force&&entry){
					// Respect failure backoff, then skip lists that are still fresh.
					if(Number(entry.retry||0)>now)continue;
					if(now-Number(entry.time||0)<age)continue;
				}
				selected.push(id);
			}
			// Oldest lists (and series with no saved list) go first, so repeated
			// bounded runs rotate through the catalogue instead of re-refreshing
			// the same leading slice forever.
			selected.sort((a,b)=>{const ea=entryFor(a),eb=entryFor(b);return (Number(ea?.time)||0)-(Number(eb?.time)||0)||String(a).localeCompare(String(b));});
			const jobs=selected.slice(0,limit);indexTotal=jobs.length;
			let cursor=0,refreshed=0,stopped=false;
			async function worker(){
				while(true){
					// If playback starts mid-sweep, stop taking new series but keep
					// whatever has already been safely saved.
					if(await busy()){stopped=true;return;}
					// Check and claim the next job after the await, otherwise two
					// workers can both pass the bound and claim one job too many.
					if(cursor>=jobs.length)return;
					const id=jobs[cursor++];try{await refreshEpisodes(id,{force:true});refreshed++;}catch{indexError='Some series could not be refreshed. Saved episode lists remain available.';}indexProgress++;
				}
			}
			await Promise.all(Array.from({length:workers},()=>worker()));
			indexUpdated=clock();
			if(refreshed)await saveIndex();
			return {deferred:stopped,reason:stopped?'busy':'',refreshed,total:jobs.length,skipped:Math.max(0,candidates.size-jobs.length),cached:episodesCache.size,batchSize:limit,concurrency:workers};
		})().catch(()=>{
			indexError='The episode index could not be refreshed. Saved episode lists remain available.';
			return {deferred:false,error:true,reason:'failed',refreshed:0,total:0,skipped:0};
		});
		try{return await indexPending;}finally{indexPending=null;}
	}
	function removedLocal(id){
		localCache=null;details.delete(id);
		for(const entry of episodesCache.values()){
			if(entry.value.items.some(item=>item.Id===id)){
				entry.value={...entry.value,items:entry.value.items.filter(item=>item.Id!==id)};
				entry.time=0;entry.retry=0;
			}
		}
		scheduleSave();
	}
	return {all,list,item,raw,episodes,refresh,availability,recommendationPool,releases,releasedEpisodes,searchMatches,searchEpisodes,refreshSeriesIndex,refreshEpisodes,removedLocal,flushIndex:saveIndex,verifySeries,cachedStates,flushAvailability,
		ready:()=>restored,
	status:()=>({indexing:Boolean(pending),indexed:catalogue.length,lastRefresh,error,persistenceError,
			availability:{queued:background.queue.length,active:background.active,seen:background.seen.size},
			seriesIndex:{running:Boolean(indexPending),cached:episodesCache.size,updated:indexUpdated,completed:indexProgress,total:indexTotal,error:indexError}})};
}
