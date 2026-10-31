(() => {
	const form=document.querySelector('#dispatcharrForm'), status=document.querySelector('#dispatcharrStatus');
	if(!form)return;
	const catalogue=document.querySelector('#dispatcharrCatalogueStatus'),refresh=document.querySelector('#refreshDispatcharrCatalogue');
	const seriesIndex=document.querySelector('#seriesIndexStatus');
	function connectionMessage(data){
		if(data.needsReconnect)return 'Dispatcharr sign-in has expired. Reconnect below using a personal API key for a lasting connection.';
		if(!data.connected)return 'Connect Dispatcharr to include its on-demand catalogue.';
		if(data.authMode==='api-key')return 'Dispatcharr API key configured.';
		return 'Dispatcharr connected using a temporary sign-in'+(data.expiresAt?' · expires '+new Date(data.expiresAt).toLocaleString():'')+'. Use a personal API key to avoid signing in again.';
	}
	async function catalogueStatus(){
		try{const response=await fetch('/api/dispatcharr/catalogue');if(!response.ok)throw Error();const data=await response.json();
			catalogue.textContent=data.indexing?'Updating the streamed catalogue…':data.error||`${Number(data.indexed).toLocaleString()} titles indexed. Refreshes automatically every hour.`;
			const index=data.seriesIndex||{};
			if(seriesIndex)seriesIndex.textContent=index.running?`Preparing episode lists: ${Number(index.completed||0)} of ${Number(index.total||0)} series. Saved lists stay available.`:
				index.error||`${Number(index.cached||0)} series ready to open. Local and mixed series, recently opened VOD and a selection of new shows refresh hourly.${index.updated?' Last checked '+new Date(index.updated).toLocaleString()+'.':''}`;
			refresh.disabled=data.indexing||index.running;
			if(data.indexing||index.running)setTimeout(catalogueStatus,5000);
		}catch{catalogue.textContent='Catalogue status is unavailable.';}
	}
	void catalogueStatus();
	refresh.onclick=async()=>{refresh.disabled=true;try{const response=await fetch('/api/dispatcharr/catalogue/refresh',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});if(!response.ok)throw Error();catalogue.textContent='Updating the streamed catalogue…';setTimeout(catalogueStatus,1000);}catch{catalogue.textContent='Could not refresh the catalogue. Try again.';refresh.disabled=false;}};
	fetch('/api/dispatcharr/guide-health').then(r=>r.json()).then(data=>{
		const node=document.querySelector('#dispatcharrGuideHealth');
		node.textContent=data.available?`${data.current} of ${data.total} channels have a current listing. Checked ${new Date(data.updated).toLocaleTimeString()}.`:'The guide could not be refreshed.';
		if(data.missing?.length)node.append(document.createElement('br'),document.createTextNode('No listings in the next 24 hours: '+data.missing.map(c=>c.name).join(', ')+'. Check their EPG mapping in Dispatcharr.'));
		for(const group of data.sharedSchedules || [])node.append(document.createElement('br'),document.createTextNode('Identical schedules—check these mappings: '+group.join(', ')+'.'));
		if(data.conflicts)node.append(document.createElement('br'),document.createTextNode(data.conflicts+' overlapping listings were omitted because their times conflict.'));
	}).catch(()=>{document.querySelector('#dispatcharrGuideHealth').textContent='Guide health is currently unavailable.';});
	fetch('/api/dispatcharr/connection').then(r=>r.ok?r.json():Promise.reject()).then(data=>{status.textContent=connectionMessage(data);}).catch(()=>{status.textContent='Open settings using the local Tellybox address to manage this connection.';});
	form.onsubmit=async event=>{
		event.preventDefault();const button=form.querySelector('button');button.disabled=true;status.textContent='Checking the connection…';
		try{
			const data=Object.fromEntries(new FormData(form));
			const response=await fetch('/api/dispatcharr/connection',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});
			const result=await response.json();if(!response.ok)throw Error(result.error||'Could not connect.');
			form.reset();status.textContent=connectionMessage(result);void catalogueStatus();
		}catch(error){status.textContent=error.message;}finally{button.disabled=false;}
	};
})();
