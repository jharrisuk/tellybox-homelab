const invalid=()=>Object.assign(Error('Enter a title of up to 200 characters.'),{status:400});
const identity=item=>`${item.Type==='Series'?'tv':'movie'}:${item.ProviderIds?.Tmdb||''}`;

export function createGlobalSearch({library,discover,channels=async()=>[]}) {
	return async query=>{
		if(typeof query.q!=='string'||query.q.length>200)throw invalid();
		const term=query.q.trim(),scope=query.scope||'available',type=query.type||'all';
		const page=Number(query.page??1),start=Number(query.start??0);
		if(!['available','more','channels','episodes'].includes(scope)||!['all','movie','tv'].includes(type)||!Number.isInteger(page)||page<1||page>100||!Number.isInteger(start)||start<0||start>100000)throw invalid();
		if(!term)return {items:[],total:0,page:1,pages:0};
		const libraryType={all:'all',movie:'movies',tv:'tvshows'}[type];
		if(scope==='channels'||scope==='episodes') {
			if(type==='movie'||(scope==='channels'&&type!=='all'))return {items:[],total:0};
			const rows=scope==='channels'?await channels():await library.searchEpisodes(term);
			const value=term.toLocaleLowerCase(),items=[...new Map(rows.filter(i=>`${i.Name} ${i.SeriesName||''} ${i.ChannelNumber||''} ${i.Group||''}`.toLocaleLowerCase().includes(value)).map(i=>[i.Id,i])).values()];
			items.sort((a,b)=>Number(b.Name.toLocaleLowerCase()===value)-Number(a.Name.toLocaleLowerCase()===value)||a.Name.localeCompare(b.Name)||a.Id.localeCompare(b.Id));
			return {items:items.slice(start,start+60),total:items.length};
		}
		if(scope==='available')return library.list({search:term,type:libraryType,start});
		// Keep the playable catalogue fast: clients load this section separately.
		// Search never requests anything; the existing request flow confirms the title/seasons.
		const [catalogue,result]=await Promise.all([
			library.searchMatches(term,libraryType),discover.browse(term,page,type)
		]);
		// VOD-only results still need a route to request a copy on the home server.
		const local=catalogue.filter(item=>item.Source!=='streamed');
		const ids=new Set(local.map(item=>item.Id));
		const identities=new Set(local.filter(item=>item.ProviderIds?.Tmdb).map(identity));
		const items=result.items.filter(item=>!ids.has(item.watchId)&&!identities.has(`${item.type}:${item.id}`)).map(item=>({
			...item,
			statusLabel:!item.watchId&&!item.vodAvailable&&item.requestable&&item.statusLabel==='Not requested'?'Add to local library':item.statusLabel
		}));
		return {...result,items};
	};
}
