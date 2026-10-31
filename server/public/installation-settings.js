// People and viewing controls remain here; service connections live in Installation settings.
fetch('/api/capabilities').then(response=>response.json()).then(async data=>{
	if(!data.managedInstallation)return;
	let setupUrl;
	try {
		const response=await fetch('/api/auth/status',{cache:'no-store',signal:AbortSignal.timeout(5000)});
		if(!response.ok)throw Error('Connection unavailable');
		const access=await response.json();
		const origin=access.local?location.origin:access.home?access.localPlayback?.origin:null;
		if(origin){
			const url=new URL(origin);
			if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw Error('Invalid installation address');
			url.protocol='http:';url.port='8990';url.pathname='/';url.search='';url.hash='';
			setupUrl=url.href;
			const link=document.getElementById('installationSettingsLink');
			if(link){link.href=setupUrl;document.getElementById('installationSettings').hidden=false;}
		}
	} catch {}
	for(const id of ['dispatcharrForm','subtitleConnectionForm','emailSettings']) {
		const form=document.getElementById(id);if(!form)continue;
		form.hidden=true;
		const note=document.createElement('p');note.className='muted';
		note.append('Manage this connection in ');
		if(setupUrl){
			const link=document.createElement('a');link.href=setupUrl;link.target='_blank';link.rel='noopener noreferrer';link.textContent='Installation settings';note.append(link,'.');
		} else note.append('Installation settings on your home network (port 8990).');
		form.before(note);
	}
	const toggle=document.getElementById('subtitleLookupEnabled');if(toggle)toggle.disabled=true;
}).catch(()=>{});
