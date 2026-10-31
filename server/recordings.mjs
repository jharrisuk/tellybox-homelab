const fail=(message,status=400)=>Object.assign(Error(message),{status});
const clean=value=>typeof value==='string'?value.trim():'';
const numeric=value=>Number.isSafeInteger(Number(value))&&Number(value)>0?Number(value):null;
const iso=value=>Number.isFinite(Date.parse(value))?new Date(value).toISOString():null;
export function recordingView(raw,channel,now=Date.now()) {
	const id=numeric(raw.id);if(!id)return null;
	const p=raw.custom_properties||{},program=p.program||{},start=Date.parse(raw.start_time),end=Date.parse(raw.end_time);
	const status=clean(p.status).toLowerCase();
	const state=['completed','finished','stopped'].includes(status)?'completed':['failed','error','interrupted'].includes(status)?'failed':
		['cancelled','canceled'].includes(status)?'cancelled':status==='recording'?'recording':start>now?'scheduled':end>now?'starting':'processing';
	return {Id:'dispatch-recording-'+id,RecordingId:id,Name:clean(program.title)||clean(p.title)||channel?.name||'TV recording',Type:'Recording',
		Overview:clean(program.description).slice(0,12000),Source:'recording',Provider:'Dispatcharr',State:state,Playable:state==='completed'&&Boolean(p.file_path),
		StartDate:Number.isFinite(start)?new Date(start).toISOString():null,EndDate:Number.isFinite(end)?new Date(end).toISOString():null,
		ProgrammeStart:iso(program.start_time)||iso(raw.start_time),ProgrammeEnd:iso(program.end_time)||iso(raw.end_time),
		RunTimeTicks:Math.max(0,(end-start)||0)*10000,ChannelId:numeric(raw.channel),ChannelName:channel?.name||'TV channel',
		ChannelUuid:channel?.uuid,Artwork:channel?.uuid?'/api/dispatcharr/channels/'+channel.uuid+'/image':undefined,
		CanCancel:state==='scheduled'&&start>now+60000&&!p.file_path};
}

export function createRecordings({dispatcharr,guide,clock=Date.now}) {
	let channelCache,pendingChannels,cache,pending,queue=Promise.resolve();
	const serial=fn=>{const result=queue.then(fn);queue=result.catch(()=>{});return result;};
	async function channels() {
		if(channelCache&&clock()-channelCache.time<60000)return channelCache.items;
		if(pendingChannels)return pendingChannels;
		pendingChannels=(async()=>{
			const rows=[];
			for(let page=1;page<=100;page++){
				const data=await dispatcharr.recordingApi('GET',`/api/channels/channels/?page_size=2000&page=${page}`);
				rows.push(...(Array.isArray(data)?data:data.results||[]));
				if(Array.isArray(data)||!data.next)break;
				if(page===100)throw fail('The channel list could not be fully loaded.',502);
			}
			channelCache={items:rows.map(c=>({id:c.id,uuid:c.uuid,name:c.name})),time:clock()};return channelCache.items;
		})();try{return await pendingChannels;}finally{pendingChannels=null;}
	}
	async function list(force=false) {
		if(!force&&cache&&clock()-cache.time<10000)return cache.items;
		if(pending)return pending;
		pending=(async()=>{
			const [data,all]=await Promise.all([dispatcharr.recordingApi('GET','/api/channels/recordings/'),channels()]);
			let rows=Array.isArray(data)?data:data.results||[];
			for(let page=2;!Array.isArray(data)&&data.next;page++){
				if(page>100)throw fail('The recording list could not be fully loaded.',502);
				const more=await dispatcharr.recordingApi('GET',`/api/channels/recordings/?page=${page}`);rows.push(...more.results||[]);if(!more.next)break;
			}
			const items=rows.map(r=>recordingView(r,all.find(c=>c.id===Number(r.channel)),clock())).filter(Boolean);
			cache={items,time:clock()};return items;
		})();try{return await pending;}finally{pending=null;}
	}
	async function item(id) {
		const match=/^dispatch-recording-(\d+)$/.exec(id);if(!match||!numeric(match[1]))throw fail('Invalid recording.');
		const raw=await dispatcharr.recordingApi('GET',`/api/channels/recordings/${match[1]}/`),all=await channels();
		return recordingView(raw,all.find(c=>c.id===Number(raw.channel)),clock());
	}
	function schedule(channelId,programmeId) {return serial(async()=>{
		if(typeof channelId!=='string'||typeof programmeId!=='string')throw fail('Choose a programme in the TV guide.');
		const data=await guide(true);if(!data.available||data.stale)throw fail('Refresh the TV guide before scheduling a recording.',409);
		const channel=data.channels.find(c=>c.Id===channelId),programme=channel?.programmes.find(p=>p.Id===programmeId);
		if(!programme||Date.parse(programme.EndDate)<=clock()||Date.parse(programme.EndDate)-Date.parse(programme.StartDate)>24*3600000)throw fail('This programme has ended or its listing has changed. Refresh the guide.',409);
		const source=(await channels()).find(c=>'dispatch-live-'+c.uuid===channelId);if(!source)throw fail('This channel is no longer available.',409);
		const existing=(await list(true)).find(r=>r.ChannelId===source.id&&!['failed','cancelled'].includes(r.State)&&Date.parse(r.ProgrammeStart)===Date.parse(programme.StartDate)&&Date.parse(r.ProgrammeEnd)===Date.parse(programme.EndDate));
		if(existing)return {item:existing,existing:true};
		const created=await dispatcharr.recordingApi('POST','/api/channels/recordings/',{channel:source.id,start_time:programme.StartDate,end_time:programme.EndDate,
			custom_properties:{program:{title:programme.Name,description:programme.Overview||'',start_time:programme.StartDate,end_time:programme.EndDate},tellybox:true}});
		cache=null;return {item:recordingView(created,source,clock()),existing:false};
	});}
	function cancel(id){return serial(async()=>{
		const recording=await item(id);if(!recording?.CanCancel)throw fail('Only recordings that have not started can be cancelled here.',409);
		await dispatcharr.recordingApi('DELETE',`/api/channels/recordings/${recording.RecordingId}/`);cache=null;return {ok:true};
	});}
	function remove(id){return serial(async()=>{
		const recording=await item(id);
		if(!recording||!['completed','failed','cancelled'].includes(recording.State)||Date.parse(recording.EndDate)>clock())throw fail('Wait until this recording has finished saving.',409);
		await dispatcharr.recordingApi('DELETE',`/api/channels/recordings/${recording.RecordingId}/`);cache=null;return {ok:true};
	});}
	return {list,item,schedule,cancel,remove};
}
