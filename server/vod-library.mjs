import {readFile,writeFile,rename} from 'node:fs/promises';

const clean = value => typeof value==='string'?value.trim():'';
const positive = value => Number.isSafeInteger(Number(value))&&Number(value)>0?Number(value):null;
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
	return {Id:`dispatch-${kind}-${id}${type==='Episode'?'-'+positive(item.series.id):''}`,Name:name,Type:type,Source:'streamed',Provider:'Dispatcharr',ProductionYear:year,
		Overview:clean(item.description).slice(0,12000),Genres:clean(item.genre).split(/[,/]/).map(x=>x.trim()).filter(Boolean),
		RunTimeTicks:Math.max(0,Number(item.duration_secs)||0)*1e7,CommunityRating:Math.min(10,Math.max(0,Number(item.rating)||0))||undefined,
		PremiereDate:item.air_date||item.custom_properties?.releaseDate||item.custom_properties?.release_date|| (type!=='Episode'&&year?`${year}-01-01`:undefined),DateCreated:item.created_at,
		ProviderIds:{...(positive(item.tmdb_id)?{Tmdb:String(positive(item.tmdb_id))}:{}),...(/^tt\d+$/.test(item.imdb_id||'')?{Imdb:item.imdb_id}:{})},
		Artwork:`/api/web/art/${kind}/${id}`,ImageTags:{},VodIds:[id],
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
export function mergeEpisodes(local,remote,series) {
	const byNumber=new Map(),extras=[];
	for(const item of [...remote,...local.map(e=>({...e,Source:'local'}))]) {
		if(!Number.isInteger(item.ParentIndexNumber)||item.ParentIndexNumber<0||!Number.isInteger(item.IndexNumber)||item.IndexNumber<1){extras.push(item);continue;}
		const key=item.ParentIndexNumber+':'+item.IndexNumber;
		byNumber.set(key,{...item,SeriesId:series.Id,SeriesName:series.Name});
	}
	return [...byNumber.values(),...extras].sort((a,b)=>a.ParentIndexNumber-b.ParentIndexNumber||a.IndexNumber-b.IndexNumber||a.Name.localeCompare(b.Name));
}

export function createVodLibrary({dispatcharr,localItems,localItem,localEpisodes,file,linksFile,seriesLinks={},metadata,clock=Date.now,indexFile=file+'.series.json'}) {
	let catalogue=[],lastRefresh=0,lastAttempt=0,pending,error='',localCache,localPromise;
	const details=new Map(),episodesCache=new Map(),episodesPending=new Map();
	const aliases=new Map(),hour=3600000,maxSeries=1000;
	let indexPending,indexUpdated=0,indexProgress=0,indexTotal=0,indexError='',saveTimer,savePending=Promise.resolve();
	function remember(entry) {
		const id=entry.series.Id;
		episodesCache.set(id,entry);
		aliases.set(id,id);
		for(const vodId of entry.series.VodIds||[])aliases.set('dispatch-series-'+vodId,id);
	}
	function entryFor(id) {return episodesCache.get(aliases.get(id)||id);}
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
			try {
				const next=[];
				for(const [kind,type] of [['movies','Movie'],['series','Series']]) {
					let page=1;
					while(page<=300) {
						const data=await dispatcharr.api(`/api/vod/${kind}/?page_size=100&page=${page}&ordering=id`);
						const rows=Array.isArray(data)?data:data.results||[];
						next.push(...rows.map(i=>vodView(i,type)).filter(Boolean));
						if(Array.isArray(data)||!data.next||!rows.length)break;
						if(page===300)throw Error('Catalogue exceeded the indexing limit.');
						page++;
					}
				}
				catalogue=[...new Map(next.map(i=>[i.Id,i])).values()];lastRefresh=clock();error='';
				await writeFile(file+'.tmp',JSON.stringify({items:catalogue,time:lastRefresh}),{mode:0o600});await rename(file+'.tmp',file);
			}catch{error='The streamed catalogue could not be refreshed. Previously indexed titles may have changed.';}
		})();
		try{await pending;}finally{pending=null;}
	}
	async function locals() {
		if(localCache&&clock()-localCache.time<120000)return localCache.items;
		if(localPromise)return localPromise;
		localPromise=localItems().then(items=>{localCache={items,time:clock()};return items;});
		try{return await localPromise;}finally{localPromise=null;}
	}
	async function all() {
		await restored;
		if(dispatcharr.status().connected&&clock()-lastRefresh>60*60000&&clock()-lastAttempt>60000&&!pending)void refresh();
		const remote=dispatcharr.status().connected?catalogue:[];
		const items=mergeLibrary(await locals(),metadata?await metadata.cached(remote):remote,seriesLinks);
		return metadata?metadata.cached(items):items;
	}
	async function list(query) {
		let items=await all();
		const term=clean(query.search).toLowerCase(),type={movies:'Movie',tvshows:'Series'}[query.type];
		if(type)items=items.filter(i=>i.Type===type);
		const genres=[...new Set(items.flatMap(i=>i.Genres||[]))].sort((a,b)=>a.localeCompare(b));
		if(query.genre)items=items.filter(i=>(i.Genres||[]).some(g=>g.toLowerCase()===clean(query.genre).toLowerCase()));
		if(term)items=items.filter(i=>(i.Name+' '+(i.Genres||[]).join(' ')).toLowerCase().includes(term));
		if(query.source==='local')items=items.filter(i=>i.Source==='local');
		if(query.source==='streamed')items=items.filter(i=>i.Source!=='local');
		items.sort((a,b)=>query.sort==='az'?a.Name.localeCompare(b.Name):query.sort==='release'?(Date.parse(b.PremiereDate)||0)-(Date.parse(a.PremiereDate)||0)||a.Name.localeCompare(b.Name):
			(a.Source==='local'?0:1)-(b.Source==='local'?0:1)||(Date.parse(b.Source==='local'?b.DateCreated:b.PremiereDate)||0)-(Date.parse(a.Source==='local'?a.DateCreated:a.PremiereDate)||0)||a.Name.localeCompare(b.Name));
		if(['rating','imdb','rotten','tmdb'].includes(query.sort))items.sort((a,b)=>(ratingValue(b,query.sort)??-1)-(ratingValue(a,query.sort)??-1)||a.Name.localeCompare(b.Name));
		const start=Math.max(0,Number(query.start)||0);
		const page=items.slice(start,start+60);
		return {items:metadata?await metadata.enrich(page):page,total:items.length,genres,indexing:Boolean(pending&&!catalogue.length),notice:error||(!catalogue.length&&pending?'Adding your streamed catalogue. Your local collection is ready below.':''),indexed:catalogue.length};
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
		const index=new Map();
		if(dispatcharr.status().connected)for(const item of catalogue)for(const key of matchKeys(item))if(!index.has(key))index.set(key,item);
		// Seerr's library sync can lag behind Jellyfin. Match the actual local catalogue
		// by type and provider ID, never by title or year (remakes can share both).
		const localIndex=new Map();
		for(const item of await locals().catch(()=>[]))for(const key of matchKeys(item)){
			if(!localIndex.has(key))localIndex.set(key,item);
			else if(localIndex.get(key)?.Id!==item.Id)localIndex.set(key,null);
		}
		return items.map(item=>{
			const key=(item.type==='tv'?'Series':'Movie')+':tmdb:'+item.id;
			const match=index.get(key),local=localIndex.get(key);
			let result=match?{...item,vodId:match.Id,vodProvider:'Dispatcharr',vodAvailable:true}:item;
			if(local)result={...result,watchId:local.Id,statusLabel:'In your library'};
			return result;
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
		let value;
		if(type==='Episode') {
			// The series endpoint works on Dispatcharr versions whose episode serializer returns HTTP 500.
			const data=await dispatcharr.api(`/api/vod/series/${m[3]}/episodes/`),rows=Array.isArray(data)?data:data.results||[];
			value=rows.find(e=>Number(e.id)===Number(m[2])&&Number(e.series?.id)===Number(m[3]));
			if(!value)throw Object.assign(Error('This episode is no longer available.'),{status:404});
		} else value=await dispatcharr.api(`/api/vod/${kind}/${m[2]}/`);
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
		try{series=await itemFresh(key);}catch(e){if(known)known.retry=clock()+300000;throw e;}
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
				remote.push(...rows.map(e=>{const v=vodView(e,'Episode');return v?{...v,Artwork:'/api/web/art/series/'+vodId,Name:v.Name.replace(/^.*?\s[-–]\sS\d+E\d+\s[-–]\s/i,'')}:null;}).filter(Boolean));
			}catch{unavailable=true;}
		}
		// A temporary upstream failure must not replace a complete saved season list with a partial one.
		if(unavailable){indexError='Some series could not be refreshed. Saved episode lists remain available.';}
		if(unavailable&&previous){previous.retry=clock()+300000;return previous.value;}
		const value={items:mergeEpisodes(local,remote,series),notice:unavailable?'Some episodes could not be loaded. The available episodes are shown while we retry.':''};
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
	async function refreshSeriesIndex({force=false}={}) {
		if(indexPending)return indexPending;
		indexPending=(async()=>{
			await restored;indexError='';indexProgress=0;
			if(force||clock()-lastRefresh>=hour)await refresh();
			localCache=null;
			const library=await all(),series=library.filter(i=>i.Type==='Series');
			const current=new Map(series.map(i=>[i.Id,i]));
			const candidates=new Set(series.filter(i=>i.Source==='local').map(i=>i.Id));
			// Prepare recently browsed VOD and a small new-release selection, not the entire provider catalogue.
			for(const entry of episodesCache.values())if(clock()-(entry.access||0)<30*86400000){
				const match=current.get(entry.series.Id)||series.find(i=>i.VodIds?.some(v=>entry.series.VodIds?.includes(v)));
				if(match)candidates.add(match.Id);
			}
			for(const item of series.filter(i=>i.Source==='streamed').sort((a,b)=>(Date.parse(b.PremiereDate)||0)-(Date.parse(a.PremiereDate)||0)).slice(0,20))candidates.add(item.Id);
			const jobs=[...candidates].slice(0,maxSeries);indexTotal=jobs.length;
			let cursor=0;
			async function worker(){
				while(cursor<jobs.length){const id=jobs[cursor++];try{await refreshEpisodes(id,{force});}catch{indexError='Some series could not be refreshed. Saved episode lists remain available.';}indexProgress++;}
			}
			await Promise.all([worker(),worker()]);indexUpdated=clock();await saveIndex();
		})().catch(()=>{indexError='The episode index could not be refreshed. Saved episode lists remain available.';});
		try{await indexPending;}finally{indexPending=null;}
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
	return {list,item,raw,episodes,refresh,availability,releases,releasedEpisodes,searchMatches,searchEpisodes,refreshSeriesIndex,refreshEpisodes,removedLocal,flushIndex:saveIndex,
		status:()=>({indexing:Boolean(pending),indexed:catalogue.length,lastRefresh,error,
			seriesIndex:{running:Boolean(indexPending),cached:episodesCache.size,updated:indexUpdated,completed:indexProgress,total:indexTotal,error:indexError}})};
}
