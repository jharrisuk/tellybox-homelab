(()=>{
	const form=document.querySelector('#subtitleConnectionForm'),status=document.querySelector('#subtitleConnectionStatus'),enabled=document.querySelector('#subtitleLookupEnabled');
	if(!form)return;
	let configured=false;
	function show(data){
		configured=data.configured;enabled.checked=configured?data.enabled:true;
		status.textContent=!configured?'Connect OpenSubtitles to find missing English tracks.':!data.enabled?'Automatic lookup is paused.':`English subtitle lookup is enabled · ${data.account?'account allowance':'API key allowance'}.${data.remaining!==null?' '+data.remaining+' downloads remaining at last check.':''}${data.notice?' '+data.notice:''}`;
	}
	fetch('/api/subtitles/connection').then(r=>r.ok?r.json():Promise.reject()).then(show).catch(()=>{status.textContent='Open local Settings to manage OpenSubtitles.';enabled.disabled=true;});
	async function save(body){const response=await fetch('/api/subtitles/connection',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const data=await response.json();if(!response.ok)throw Error(data.error||'Could not connect OpenSubtitles.');show(data);}
	enabled.onchange=async()=>{if(!configured)return;enabled.disabled=true;try{await save({enabled:enabled.checked});}catch(error){enabled.checked=!enabled.checked;status.textContent=error.message;}finally{enabled.disabled=false;}};
	form.onsubmit=async event=>{event.preventDefault();const button=form.querySelector('button');button.disabled=true;status.textContent='Checking OpenSubtitles…';try{await save({...Object.fromEntries(new FormData(form)),enabled:enabled.checked});form.reset();}catch(error){status.textContent=error.message;}finally{button.disabled=false;}};
})();
