(() => {
	const toggle=document.querySelector('#remoteToggle'),vod=document.querySelector('#remoteVod'),nonstop=document.querySelector('#remoteNonstop'),state=document.querySelector('#remoteState'),message=document.querySelector('#remoteMessage');
	let current;
	const busy=value=>{toggle.disabled=vod.disabled=nonstop.disabled=value;};
	function render(data){
		current=data;toggle.textContent=data.enabled?'Pause remote viewing':'Resume remote viewing';
		toggle.className='button '+(data.enabled?'secondary':'primary');
		state.textContent=data.enabled?'Remote viewing is on.':'Remote viewing is paused until you resume it.';
		vod.checked=data.vod;nonstop.checked=data.nonstop;
	}
	async function save(patch){
		busy(true);message.textContent='';
		try{render(await authRequest('/api/remote-controls',{...current,...patch}));message.textContent='Saved.';}
		catch(error){render(current);message.textContent=error.message;}finally{busy(false);}
	}
	toggle.onclick=()=>save({enabled:!current.enabled});
	vod.onchange=()=>save({vod:vod.checked});nonstop.onchange=()=>save({nonstop:nonstop.checked});
	authRequest('/api/remote-controls').then(data=>{render(data);busy(false);}).catch(error=>{message.textContent=error.message;});
})();
