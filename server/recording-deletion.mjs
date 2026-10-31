const fail=(message,status=409)=>Object.assign(Error(message),{status});
const localId=/^(?:[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i;
const same=(a,b)=>String(a||'').replaceAll('-','').toLowerCase()===String(b||'').replaceAll('-','').toLowerCase();
export function createRecordingDeletion({jelly,userId,recordings,busy=()=>false,invalidated=()=>{}}){
	let queue=Promise.resolve();
	async function libraries(){return (await jelly(`/Users/${userId()}/Views`)).Items.filter(x=>/^recordings$/i.test(x.Name||''));}
	async function localList(){
		const items=[];
		for(const library of await libraries()){
			for(let start=0;start<10000;start+=200){
				const query=new URLSearchParams({UserId:userId(),ParentId:library.Id,Recursive:'true',IncludeItemTypes:'Movie,Episode,Video',LocationTypes:'FileSystem',Fields:'Overview,DateCreated,CanDelete',StartIndex:String(start),Limit:'200'});
				const data=await jelly('/Items?'+query);
				items.push(...(data.Items||[]).filter(x=>!x.IsFolder&&!x.IsVirtualItem));
				if(start+200>=(data.TotalRecordCount||0))break;
			}
		}
		return [...new Map(items.map(item=>[item.Id,item])).values()];
	}
	async function inspect(id){
		if(/^dispatch-recording-[1-9]\d*$/.test(id)){
			const item=await recordings.item(id);
			if(!item)throw fail('Recording not found.',404);
			const finished=['completed','failed','cancelled'].includes(item.State)&&Date.parse(item.EndDate)<=Date.now();
			return {Id:id,Name:item.Name,IsRecording:true,CanDelete:finished&&!busy(id),reason:!finished?'Wait until this recording has finished saving.':busy(id)?'This recording is being watched or downloaded. Try again after playback stops.':''};
		}
		if(!localId.test(id))throw fail('Invalid recording.',400);
		const item=await jelly(`/Users/${userId()}/Items/${id}`);
		if(item.IsFolder||item.IsVirtualItem||!['Movie','Episode','Video'].includes(item.Type)||item.LocationType!=='FileSystem')return {IsRecording:false,CanDelete:false};
		const [roots,parents]=await Promise.all([libraries(),jelly(`/Items/${id}/Ancestors?UserId=${userId()}`)]);
		if(!parents.some(parent=>roots.some(root=>same(parent.Id,root.Id))))return {IsRecording:false,CanDelete:false};
		const timers=await jelly('/LiveTv/Timers');
		const recording=(timers.Items||[]).some(timer=>/inprogress|recording/i.test(timer.Status||'')&&(!timer.RecordingPath||!item.Path||timer.RecordingPath===item.Path));
		const reason=recording?'Wait until this recording has finished saving.':busy(item.Id)?'This recording is being watched or downloaded. Try again after playback stops.':item.CanDelete!==true?'Enable deletion for the Recordings library on the connected Jellyfin user.':'';
		return {Id:item.Id,Name:item.Name,IsRecording:true,CanDelete:!reason,reason};
	}
	function remove(id){
		const run=queue.then(async()=>{
			const item=await inspect(id);
			if(!item.IsRecording)throw fail('Only individual recordings can be deleted here.',403);
			if(!item.CanDelete)throw fail(item.reason);
			if(busy(id))throw fail('This recording is being watched or downloaded.');
			if(id.startsWith('dispatch-recording-'))await recordings.remove(id);
			else await jelly(`/Items/${id}`,{method:'DELETE'});
			invalidated(id);return {ok:true,Name:item.Name};
		});queue=run.catch(()=>{});return run;
	}
	return {inspect,remove,localList};
}
export function installRecordingDeletion(app,{manager,allowed,audit=()=>{}}){
	function guard(req,res,next){
		res.setHeader('Cache-Control','no-store');
		if(!allowed(req))return res.status(403).json({error:'Deleting recordings is available to administrators or at home.'});
		if(req.method==='POST'&&(!req.is('application/json')||req.get('origin')!==req.jserverOrigin||req.body?.confirm!==true))return res.status(400).json({error:'Confirm deletion from Tellybox first.'});
		next();
	}
	app.get('/api/recording-files/:id',guard,async(req,res)=>res.json(await manager.inspect(req.params.id)));
	app.post('/api/recording-files/:id/delete',guard,async(req,res)=>{
		const result=await manager.remove(req.params.id);
		audit('recording_deleted',req.jserverViewer,{title:result.Name});
		res.json({ok:true});
	});
}
