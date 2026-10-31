const peopleMessage = document.querySelector('#peopleMessage');
const emailSettings = document.querySelector('#emailSettings'), emailMessage = document.querySelector('#emailMessage');
authRequest('/api/auth/email/config').then(result => { emailSettings.elements.from.value = result.from; emailSettings.elements.enabled.checked = result.enabled; emailMessage.textContent = result.configured ? 'Sender configured.' : 'Not connected yet.'; }).catch(error => { emailMessage.textContent = error.message; });
emailSettings.onsubmit = async event => {
	event.preventDefault(); const button = emailSettings.querySelector('button'); button.disabled = true;
	try { await authRequest('/api/auth/email/config', { from: emailSettings.elements.from.value.trim(), key: emailSettings.elements.key.value, enabled: emailSettings.elements.enabled.checked }); emailSettings.elements.key.value = ''; emailMessage.textContent = 'Email settings saved.'; }
	catch (error) { emailMessage.textContent = error.message; } finally { button.disabled = false; }
};
void loadPeople();
setInterval(() => { if (!document.hidden&&!document.querySelector('dialog[open]')&&!document.querySelector('[data-settings=people] input:focus, [data-settings=people] select:focus')) void loadPeople(); }, 30000);

function addAccountLimits(card,id){
	const box=document.createElement('details');box.className='account-controls';const summary=document.createElement('summary');summary.textContent='Viewing & downloads';box.append(summary);card.append(box);
	box.addEventListener('toggle',async()=>{if(!box.open||box.dataset.loaded)return;box.dataset.loaded='1';
		try{const current=await authRequest('/api/account-limits/'+id),form=document.createElement('form');
			const used=document.createElement('p');form.append(used);
			const show=data=>{used.textContent=Math.floor(data.dailySeconds/60)+' minutes today · '+Math.floor(data.seconds/60)+' since manual reset';};show(current);
			function input(text,value,max){const label=document.createElement('label');label.className='auth-field';label.textContent=text;const field=document.createElement('input');field.type='number';field.min=0;field.max=max;field.step=1;field.required=true;field.value=value;label.append(field);form.append(label);return field;}
			const daily=input('Daily remote minutes · 0 = unlimited',current.dailyMinutes||0,1440);
			const info=document.createElement('p');info.className='auth-note';info.textContent='Resets at midnight UK time. Shared by the web login and all linked devices. Home viewing is excluded.';form.append(info);
			const minutes=input('Total remote minutes · manual reset · 0 = unlimited',current.minutes,525600);
			const permission=document.createElement('label');permission.className='preference-row';const downloads=document.createElement('input');downloads.type='checkbox';downloads.checked=current.downloads;permission.append('Allow downloads',downloads);form.append(permission);
			const actions=document.createElement('div');actions.className='people-actions';form.append(actions);
			const save=document.createElement('button');save.className='button primary';save.textContent='Save';
			const reset=document.createElement('button');reset.className='button secondary';reset.type='button';reset.textContent='Reset total';
			const resetDaily=document.createElement('button');resetDaily.className='button secondary';resetDaily.type='button';resetDaily.textContent='Reset today';actions.append(save,resetDaily,reset);box.append(form);
			const message=document.createElement('p');message.setAttribute('role','status');form.append(message);
			const submit=async action=>{if(!form.reportValidity())return;save.disabled=reset.disabled=resetDaily.disabled=true;try{const data=await authRequest('/api/account-limits/'+id,{minutes:Number(minutes.value),dailyMinutes:Number(daily.value),downloads:downloads.checked,reset:action==='total',resetDaily:action==='daily'});show(data);message.textContent=action?'Time used reset.':'Account limits saved.';}catch(e){message.textContent=e.message;}finally{save.disabled=reset.disabled=resetDaily.disabled=false;}};
			form.onsubmit=e=>{e.preventDefault();void submit('');};reset.onclick=()=>{if(confirm('Reset the total viewing time for this account?'))void submit('total');};resetDaily.onclick=()=>{if(confirm('Give this account its full daily allowance again today?'))void submit('daily');};
		}catch(e){box.dataset.loaded='';box.append(document.createTextNode(e.message));}
	});
}
