const failure=(message,status=400)=>Object.assign(Error(message),{status});
export function createCatchup(dispatcharr,guide,clock=Date.now){
	let cached,expires=0,pending;
	async function capabilities(){
		if(cached&&clock()<expires)return cached;
		if(pending)return pending;
		pending=(async()=>{const value=await dispatcharr.recordingApi('GET','/api/channels/channels/?page_size=5000');
			const rows=Array.isArray(value)?value:value.results||[];
			cached=new Map(rows.filter(c=>c.is_catchup&&c.catchup_days>0).map(c=>['dispatch-live-'+c.uuid,Math.min(7,c.catchup_days)]));expires=clock()+300000;return cached;})();
		try{return await pending;}finally{pending=null;}
	}
	async function list(channelId='',includeCurrent=false){
		const [caps,data]=await Promise.all([capabilities(),guide.archive()]);
		const now=clock();
		return {channels:data.channels.filter(c=>!c.Nonstop&&caps.has(c.Id)&&(!channelId||c.Id===channelId)).map(c=>({...c,programmes:c.programmes.filter(p=>{
			const start=Date.parse(p.StartDate),end=Date.parse(p.EndDate);
			return Number.isFinite(start)&&Number.isFinite(end)&&end>start&&end-start<=480*60000&&start>=now-caps.get(c.Id)*86400000
				&&(end<=now||(includeCurrent&&!data.stale&&start<=now-60000));
		}).map(p=>({...p,Id:'catchup-'+c.Id.slice(14)+'-'+Date.parse(p.StartDate),Type:'Catchup',ChannelId:c.Id,ChannelName:c.Name,Artwork:c.Artwork,Restart:Date.parse(p.EndDate)>now}))})).filter(c=>c.programmes.length)};
	}
	async function restart(channelId,programmeId){
		if(!/^dispatch-live-[a-f0-9-]{36}$/i.test(channelId)||typeof programmeId!=='string'||!programmeId||programmeId.length>180)throw failure('Invalid programme.');
		const data=await list(channelId,true);
		const item=data.channels.flatMap(c=>c.programmes).find(p=>p.Restart&&programmeId===channelId.slice(14)+':'+Date.parse(p.StartDate));
		return {item:item||null};
	}
	async function resolve(id){
		if(!/^catchup-[a-f0-9-]{36}-\d{13}$/i.test(id))throw failure('Invalid catch-up programme.');
		const item=(await list('',true)).channels.flatMap(c=>c.programmes).find(p=>p.Id===id);
		if(!item)throw failure('This programme is no longer available in catch-up.',404);
		return item;
	}
	return {list,restart,resolve};
}
