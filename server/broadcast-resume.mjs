const normal=value=>String(value||'').normalize('NFKC').toLocaleLowerCase('en-GB').replace(/^new:\s*/,'').replace(/[^\p{L}\p{N}]+/gu,' ').trim();
const integer=value=>Number.isInteger(value)&&value>=0&&value<=10000?value:null;
const uuid='[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const catchupPattern=new RegExp('^catchup-('+uuid+')-(\\d{13})$','i');
const programmePattern=new RegExp('^('+uuid+'):(\\d{13})$','i');

/** XMLTV uses zero-based season/episode numbers; on-screen labels are one-based. */
export function broadcastEpisode(value,system='onscreen') {
	const text=String(value||'').slice(0,300);
	const match=system==='xmltv_ns'?/^(\d+)(?:\/\d+)?\s*\.\s*(\d+)(?:\/\d+)?\s*(?:\.|$)/.exec(text.trim()):/\bS(?:eason|eries)?\s*(\d+)\s*[,.: -]*\s*E(?:pisode|p)?\s*(\d+)\b/i.exec(text);
	if(!match)return {};
	const season=Number(match[1])+(system==='xmltv_ns'?1:0),episode=Number(match[2])+(system==='xmltv_ns'?1:0);
	return integer(season)!==null&&integer(episode)!==null?{ParentIndexNumber:season,IndexNumber:episode}:{};
}

function savedProgramme(item) {
	if(!item||typeof item!=='object'||!['Catchup','Programme','Program'].includes(item.Type)||typeof item.Id!=='string')return null;
	const match=catchupPattern.exec(item.Id)||programmePattern.exec(item.Id);
	if(!match)return null;
	const start=Number(match[2]),end=Date.parse(item.EndDate);
	if(Date.parse(item.StartDate)!==start||!Number.isFinite(end)||end<=start||end-start>480*60000)return null;
	const channel='dispatch-live-'+match[1];
	if(item.ChannelId&&item.ChannelId!==channel)return null;
	const text=key=>typeof item[key]==='string'?item[key].trim().slice(0,200):'';
	const name=text('Name');if(!name)return null;
	return {Id:item.Id,Type:'Catchup',Name:name,ChannelId:channel,StartDate:new Date(start).toISOString(),EndDate:new Date(end).toISOString(),
		SeriesName:text('SeriesName'),EpisodeTitle:text('EpisodeTitle'),Overview:text('Overview'),IsMovie:item.IsMovie===true,
		ParentIndexNumber:integer(item.ParentIndexNumber),IndexNumber:integer(item.IndexNumber),
		ProductionYear:integer(item.ProductionYear),SeriesProductionYear:integer(item.SeriesProductionYear),
		ProviderIds:ids(item.ProviderIds),SeriesProviderIds:ids(item.SeriesProviderIds),
		CatchupId:'catchup-'+match[1]+'-'+match[2]};
}

function ids(value) {
	return Object.fromEntries(['Tmdb','Imdb','Tvdb'].flatMap(key=>{
		const id=String(value?.[key]||'');return (key==='Imdb'?/^tt\d{1,12}$/:/^\d{1,12}$/).test(id)?[[key,id]]:[];
	}));
}
function identityMatches(candidate,expected) {
	const candidateIds=ids(candidate.ProviderIds),wanted=ids(expected);
	const keys=Object.keys(wanted);
	return !keys.length||keys.some(key=>candidateIds[key]===wanted[key])&&!keys.some(key=>candidateIds[key]&&candidateIds[key]!==wanted[key]);
}
function distinctTitle(value) {
	const text=normal(value);
	return text.length>=4&&!/^(?:episode|part|chapter|pilot|series|season|special|finale)(?: \d+)?$/.test(text);
}

/** Resolves broadcasts only. Ordinary film/episode resume remains on the client. */
export function createBroadcastResume({library,catchup,now=Date.now}) {
	// Cache catalogue identity only: availability and viewer permissions are checked below.
	const matchesCache=new Map();
	const matchKey=programme=>JSON.stringify([programme.SeriesName||programme.Name,programme.IsMovie===true,
		programme.EpisodeTitle,programme.Overview,programme.ParentIndexNumber,programme.IndexNumber,
		programme.ProductionYear,programme.SeriesProductionYear,programme.ProviderIds,programme.SeriesProviderIds]);
	const rememberMatch=(key,target)=>{
		for(const [entry,value] of matchesCache)if(value.until<=now())matchesCache.delete(entry);
		matchesCache.delete(key);
		while(matchesCache.size>=100)matchesCache.delete(matchesCache.keys().next().value);
		matchesCache.set(key,{target,until:now()+30000});
	};
	return async (body,{allowed=()=>true,resolveBroadcasts=false}={})=>{
		if(!Array.isArray(body?.items)||body.items.length>20)throw Object.assign(Error('Choose up to 20 programmes.'),{status:400});
		// Home Continue watching is on-demand only. Broadcast-to-catalogue matching
		// is retained solely behind an explicit internal opt-in for direct callers.
		if(!resolveBroadcasts)return {items:[]};
		const candidates=body.items.map(savedProgramme).filter(Boolean);
		if(!candidates.length)return {items:[]};
		// A capability check and current archive window, not a saved "available" flag.
		let available=new Map();
		try {available=new Map((await catchup.list('',true)).channels.flatMap(c=>c.programmes).map(item=>[item.Id,item]));}catch{}
		const queries=new Map(),episodeQueries=new Map();
		const search=(title,type)=>{
			const key=type+':'+title;
			if(!queries.has(key))queries.set(key,Promise.resolve().then(()=>library.searchMatches(title,type)).catch(()=>[]));
			return queries.get(key);
		};
		const episodes=id=>{
			if(!episodeQueries.has(id))episodeQueries.set(id,Promise.resolve().then(()=>library.episodes(id)).then(result=>result.items||[]).catch(()=>[]));
			return episodeQueries.get(id);
		};
		async function matchCatalogue(programme) {
			const title=programme.SeriesName||programme.Name,kind=programme.IsMovie?'Movie':'Series';
			let matches=(await search(title,kind==='Movie'?'movies':'tvshows')).filter(item=>item.Type===kind&&normal(item.Name)===normal(title));
			const expectedIds=kind==='Movie'?programme.ProviderIds:programme.SeriesProviderIds;
			matches=matches.filter(item=>identityMatches(item,expectedIds));
			const year=kind==='Movie'?programme.ProductionYear:programme.SeriesProductionYear;
			if(year)matches=matches.filter(item=>item.ProductionYear===year);
			// A name shared by remakes, or duplicate unlinked catalogues, is ambiguous.
			if(matches.length!==1)return null;
			let target=matches[0];
			if(kind==='Movie') {
				// Film name alone is not enough to distinguish an unknown remake.
				if(!year&&!Object.keys(expectedIds).length)return null;
			} else {
				const numbers={...broadcastEpisode(programme.Overview),...broadcastEpisode(programme.EpisodeTitle)};
				if(programme.ParentIndexNumber!==null&&programme.ParentIndexNumber!==undefined)numbers.ParentIndexNumber=programme.ParentIndexNumber;
				if(programme.IndexNumber!==null&&programme.IndexNumber!==undefined)numbers.IndexNumber=programme.IndexNumber;
				const numbered=integer(numbers.ParentIndexNumber)!==null&&integer(numbers.IndexNumber)!==null;
				if(!numbered&&!distinctTitle(programme.EpisodeTitle))return null;
				const found=(await episodes(target.Id)).filter(item=>item.Type==='Episode'&&identityMatches(item,programme.ProviderIds)&&
					(numbered?item.ParentIndexNumber===numbers.ParentIndexNumber&&item.IndexNumber===numbers.IndexNumber:normal(item.Name)===normal(programme.EpisodeTitle)));
				if(found.length!==1)return null;
				target=found[0];
			}
			return target;
		}
		const pendingMatches=new Map();
		async function localOrVod(programme) {
			const key=matchKey(programme),cached=matchesCache.get(key);
			let target;
			if(cached&&cached.until>now())target=cached.target;
			else {
				if(!pendingMatches.has(key))pendingMatches.set(key,matchCatalogue(programme).then(result=>{
					rememberMatch(key,result);return result;
				}));
				target=await pendingMatches.get(key);
			}
			if(!target)return null;
			// Even cached matches must pass current policy and item availability checks.
			if(!allowed(target))return null;
			try {const current=await library.item(target.Id);return current&&['Movie','Episode'].includes(current.Type)&&allowed(current)?current:null;}catch{return null;}
		}
		const resolved=new Array(candidates.length);
		let next=0;
		async function worker() {
			while(next<candidates.length) {
				const index=next++,saved=candidates[index],current=available.get(saved.CatchupId);
				// Keep stored metadata for expired programmes; freshly supplied guide fields win.
				const programme={...saved,...current};
				const replacement=await localOrVod(programme),target=replacement||current;
				if(!target||!allowed(target))continue;
				resolved[index]={...target,ResumeFromId:saved.Id,ResumeSource:replacement?(target.Source==='streamed'?'streamed':'local'):'catchup',
					ResumeSourceChanged:Boolean(replacement),BroadcastDurationMs:Date.parse(saved.EndDate)-Date.parse(saved.StartDate)};
			}
		}
		await Promise.all(Array.from({length:Math.min(2,candidates.length)},()=>worker()));
		// Completion order must not change the viewer's most-recently-watched ordering.
		const seen=new Set(),result=resolved.filter(target=>{
			if(!target||seen.has(target.Id))return false;
			seen.add(target.Id);return true;
		});
		return {items:result};
	};
}
