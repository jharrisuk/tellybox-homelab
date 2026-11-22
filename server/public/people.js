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

// Q70 live-usage wording. Pure helpers so the rendered numbers can be checked
// against the exact /api/account-limits and /api/activity payloads.
function formatDuration(seconds){
	const total=Math.max(0,Math.floor(Number(seconds)||0));
	const hours=Math.floor(total/3600),minutes=Math.round((total%3600)/60);
	if(hours&&minutes)return hours+'h '+minutes+'m';
	if(hours)return hours+'h';
	if(minutes)return minutes+'m';
	return total>0?'<1m':'0m';
}
function screensLiveText(count){const n=Math.max(0,Number(count)||0);return n+' in use now';}
function timeLiveText(dailySeconds,dailyMinutes){
	const used=formatDuration(dailySeconds);
	const limit=Number(dailyMinutes);
	return limit>0?used+' of '+formatDuration(limit*60)+' today':used+' today · no daily limit';
}
function downloadsLiveText(count){const n=Math.max(0,Number(count)||0);return n===1?'1 downloading now':n+' downloading now';}
function allowanceLimitText(limit){return Number(limit)>0?String(limit):'unlimited';}
function allowanceLine(allowances){
	return 'Phones '+allowances.phone.used+' of '+allowanceLimitText(allowances.phone.limit)+' · TVs '+allowances.tv.used+' of '+allowanceLimitText(allowances.tv.limit);
}
// Live usage for one account from the activity snapshot the server already
// exposes: remote playback in progress and active downloads, attributed by
// person id or linked device id. Home/local viewing is exempt from limits, so
// it is not counted against the screens shown here.
function accountLiveUsage(snapshot,id,linkedDeviceIds=[]){
	const key=String(id||''),personId=key.startsWith('person:')?key.slice(7):'',deviceId=key.startsWith('device:')?key.slice(7):'';
	const owns=entry=>entry&&(personId?entry.personId===personId||linkedDeviceIds.includes(entry.deviceId):entry.deviceId===deviceId);
	const active=(snapshot?.active||[]).filter(entry=>owns(entry)&&entry.purpose!=='download'&&!entry.local&&!entry.home);
	const downloads=(snapshot?.downloads||[]).filter(entry=>owns(entry));
	return {screens:active.length,downloads:downloads.length};
}
function addAccountLimits(card,id,onStatus){
	const box=document.createElement('section');box.className='account-controls account-limits-groups';card.append(box);
	const heading=document.createElement('h3');heading.textContent='Allowances';box.append(heading);
	const state={limits:null,live:{screens:0,downloads:0},timer:null};
	const liveScreens=document.createElement('p');liveScreens.className='auth-note account-live';
	const liveTime=document.createElement('p');liveTime.className='auth-note account-live';
	const liveDownloads=document.createElement('p');liveDownloads.className='auth-note account-live';
	function input(parent,text,value,max){const label=document.createElement('label');label.className='auth-field';label.textContent=text;const field=document.createElement('input');field.type='number';field.min=0;field.max=max;field.step=1;field.required=true;field.value=value;label.append(field);parent.append(label);return field;}
	const form=document.createElement('form');box.append(form);
	// Screens: concurrent remote screens plus the per-platform device allowances.
	const screensGroup=document.createElement('fieldset');screensGroup.className='account-group';screensGroup.append(Object.assign(document.createElement('legend'),{textContent:'Screens'}),liveScreens);
	const screensLabel=document.createElement('label');screensLabel.className='auth-field';screensLabel.textContent='Remote screens at once';
	const screens=document.createElement('select');for(const [label,value] of [['Unlimited','0'],['1 screen','1'],['2 screens','2'],['3 screens','3']])screens.append(new Option(label,value));screensLabel.append(screens);screensGroup.append(screensLabel);
	screensGroup.append(Object.assign(document.createElement('p'),{className:'auth-note',textContent:'Counts remote playback across linked devices. Paused playback keeps its screen. Local, home and admin playback is exempt.'}));
	let phones=null,tvs=null,allowanceNote=null;
	if(id.startsWith('person:')){
		phones=input(screensGroup,'Phones allowed · 0 = unlimited',1,8);
		tvs=input(screensGroup,'TVs allowed · 0 = unlimited',1,8);
		allowanceNote=document.createElement('p');allowanceNote.className='auth-note';screensGroup.append(allowanceNote);
		screensGroup.append(Object.assign(document.createElement('p'),{className:'auth-note',textContent:'Linked devices count against their platform allowance. Remove a device under the account, or here in Settings > People, to free a slot.'}));
	}
	form.append(screensGroup);
	// Time: daily window and manual total, with today's usage against the limit.
	const timeGroup=document.createElement('fieldset');timeGroup.className='account-group';timeGroup.append(Object.assign(document.createElement('legend'),{textContent:'Time'}),liveTime);
	const daily=input(timeGroup,'Daily remote minutes · 0 = unlimited',0,1440);
	timeGroup.append(Object.assign(document.createElement('p'),{className:'auth-note',textContent:'Resets at midnight UK time. Shared by the web login and all linked devices. Home viewing is excluded.'}));
	const minutes=input(timeGroup,'Total remote minutes · manual reset · 0 = unlimited',0,525600);
	const totalUsed=document.createElement('p');totalUsed.className='auth-note';timeGroup.append(totalUsed);
	form.append(timeGroup);
	// Downloads: permission plus what is transferring right now.
	const downloadsGroup=document.createElement('fieldset');downloadsGroup.className='account-group';downloadsGroup.append(Object.assign(document.createElement('legend'),{textContent:'Downloads'}),liveDownloads);
	const permission=document.createElement('label');permission.className='preference-row';const downloads=document.createElement('input');downloads.type='checkbox';permission.append('Allow downloads',downloads);downloadsGroup.append(permission);
	form.append(downloadsGroup);
	const actions=document.createElement('div');actions.className='people-actions';form.append(actions);
	const save=document.createElement('button');save.className='button primary';save.textContent='Save';
	const reset=document.createElement('button');reset.className='button secondary';reset.type='button';reset.textContent='Reset total';
	const resetDaily=document.createElement('button');resetDaily.className='button secondary';resetDaily.type='button';resetDaily.textContent='Reset today';actions.append(save,resetDaily,reset);
	const message=document.createElement('p');message.setAttribute('role','status');form.append(message);
	function render(data){
		state.limits=data;
		liveScreens.textContent=screensLiveText(state.live.screens);
		liveTime.textContent=timeLiveText(data.dailySeconds,data.dailyMinutes);
		liveDownloads.textContent=downloadsLiveText(state.live.downloads);
		totalUsed.textContent=formatDuration(data.seconds)+' since manual reset';
		screens.value=[1,2,3].includes(Number(data.maxSessions))?String(data.maxSessions):'0';
		daily.value=data.dailyMinutes||0;minutes.value=data.minutes;downloads.checked=data.downloads===true;
		if(phones){phones.value=data.maxPhones??1;tvs.value=data.maxTvs??1;
			allowanceNote.textContent=allowanceLine({phone:{used:state.used?.phone??0,limit:data.maxPhones??1},tv:{used:state.used?.tv??0,limit:data.maxTvs??1}});}
		if(typeof onStatus==='function')onStatus(data);
	}
	async function refresh(){
		try{
			const [limits,snapshot]=await Promise.all([authRequest('/api/account-limits/'+id),authRequest('/api/activity').catch(()=>null)]);
			const directory=await authRequest('/api/people').catch(()=>null);
			const linked=directory?Object.entries(directory.devices||{}).filter(([,person])=>'person:'+person===id).map(([device])=>device):[];
			state.live=accountLiveUsage(snapshot,id,linked);
			if(id.startsWith('person:')){
				const personId=id.slice(7);
				state.used={phone:0,tv:0};
				for(const device of directory?.apps||[])if(directory.devices?.[device.id]===personId&&['approved','pending'].includes(device.status)&&(device.platform==='phone'||device.platform==='tv'))state.used[device.platform]++;
			}
			render(limits);
		}catch(e){message.textContent=e.message;}
	}
	const submit=async action=>{if(!form.reportValidity())return;save.disabled=reset.disabled=resetDaily.disabled=true;
		try{const body={minutes:Number(minutes.value),dailyMinutes:Number(daily.value),maxSessions:Number(screens.value),downloads:downloads.checked,reset:action==='total',resetDaily:action==='daily'};
			if(phones){body.maxPhones=Number(phones.value);body.maxTvs=Number(tvs.value);}
			const data=await authRequest('/api/account-limits/'+id,body);render(data);message.textContent=action?'Time used reset.':'Account limits saved.';
		}catch(e){message.textContent=e.message;}finally{save.disabled=reset.disabled=resetDaily.disabled=false;}};
	form.onsubmit=e=>{e.preventDefault();void submit('');};
	reset.onclick=()=>{if(confirm('Reset the total viewing time for this account?'))void submit('total');};
	resetDaily.onclick=()=>{if(confirm('Give this account its full daily allowance again today?'))void submit('daily');};
	void refresh();
	// Keep the live lines current while the dialog is open; never overwrite an
	// input the administrator may be editing.
	state.timer=setInterval(()=>{if(!document.hidden)void refresh();},10000);
	card.addEventListener('close',()=>{clearInterval(state.timer);});
	return {refresh:()=>refresh()};
}
