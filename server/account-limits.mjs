import path from 'node:path';
import {jsonStore} from './json-store.mjs';
const fail=(message,status=403)=>Object.assign(Error(message),{status});
const ukDate=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/London',year:'numeric',month:'2-digit',day:'2-digit'});
export function createAccountLimits(directory,{clock=Date.now,resolveViewer=viewer=>viewer}={}){
	const store=jsonStore(path.join(directory,'account-limits.json'),{accounts:{}}),active=new Map();let saved=clock();
	const key=viewer=>{const v=resolveViewer(viewer);return v?.personId?'person:'+v.personId:v?.deviceId?'device:'+v.deviceId:'';};
	const home=viewer=>Boolean(viewer?.local||viewer?.home);
	const day=at=>ukDate.format(new Date(at));
	// Midnight is a wall-clock boundary in the UK, so binary-search the formatted
	// date instead of assuming a 24-hour day across DST changes.
	function nextMidnight(at){
		const today=day(at);let low=at,high=at+26*60*60*1000;
		if(day(high)===today)return high;
		while(high-low>1){const mid=Math.floor((low+high)/2);if(day(mid)===today)low=mid;else high=mid;}
		return high;
	}
	function entry(id){
		const e=store.get().accounts[id]||={minutes:0,seconds:0,downloads:false,dailyMinutes:0,dailySeconds:0,day:day(clock()),maxSessions:0};
		e.dailyMinutes??=0;e.dailySeconds??=0;e.maxSessions??=0;
		if(e.day!==day(clock())){e.day=day(clock());e.dailySeconds=0;}
		return e;
	}
	function maxSessions(id){return id?entry(id).maxSessions:0;}
	function status(id){const e=entry(id);return {...e,remainingMinutes:e.minutes?Math.max(0,e.minutes-e.seconds/60):null,dailyRemainingMinutes:e.dailyMinutes?Math.max(0,e.dailyMinutes-e.dailySeconds/60):null,reset:'manual',dailyTimezone:'Europe/London'};}
	function set(id,body){
		if(!/^(person|device):[a-f0-9]{32}$/.test(id))throw fail('Invalid account.',400);
		if(!Number.isInteger(body.minutes)||body.minutes<0||body.minutes>525600||typeof body.downloads!=='boolean')throw fail('Enter a whole number of minutes, or 0 for unlimited.',400);
		if(body.dailyMinutes!==undefined&&(!Number.isInteger(body.dailyMinutes)||body.dailyMinutes<0||body.dailyMinutes>1440))throw fail('Daily minutes must be between 0 and 1440. Use 0 for unlimited.',400);
		if(body.maxSessions!==undefined&&(!Number.isInteger(body.maxSessions)||body.maxSessions<0||body.maxSessions>3))throw fail('Remote screens must be 0, 1, 2 or 3. Use 0 for unlimited.',400);
		tick();const e=entry(id);Object.assign(e,{minutes:body.minutes,downloads:body.downloads,dailyMinutes:body.dailyMinutes??e.dailyMinutes,maxSessions:body.maxSessions??e.maxSessions});
		if(body.reset===true){e.seconds=0;e.resetAt=clock();}
		if(body.resetDaily===true){e.dailySeconds=0;e.dailyResetAt=clock();}
		store.save();return status(id);
	}
	function denial(viewer,download=false){
		if(home(viewer))return null;const id=key(viewer);if(!id)return null;
		const e=entry(id);
		if(download)return e.downloads===true?null:{message:'Downloads are disabled for this account. Ask the owner to enable them.'};
		// A manual total has no automatic reset. If both allowances are exhausted,
		// report the manual one instead of promising a midnight reset that will not help.
		if(e.minutes&&e.seconds>=e.minutes*60)return {message:'Your viewing allowance has been used. Ask the owner to reset it.',code:'VIEWING_LIMIT'};
		if(e.dailyMinutes&&e.dailySeconds>=e.dailyMinutes*60)return {message:'Your daily viewing allowance has been used. It resets at midnight UK time.',code:'VIEWING_LIMIT',retryAfter:Math.max(1,Math.ceil((nextMidnight(clock())-clock())/1000))};
		return null;
	}
	function reason(viewer,download=false){return denial(viewer,download)?.message||'';}
	function allowed(viewer,download=false){return !denial(viewer,download);}
	function guard(viewer,download=false){const denied=denial(viewer,download);if(denied)throw Object.assign(fail(denied.message),{...(denied.code?{code:denied.code}:{}),...(denied.retryAfter?{retryAfter:denied.retryAfter}:{})});}
	// The caller's own status only. It never names a person, device or other account.
	// Admins are exempt from the concurrent-screen cap, not from their minute quota.
	function viewing(viewer,{admin=false,activeSessions=0}={}){
		const id=key(viewer),limit=maxSessions(id);
		if(home(viewer)||!id)return {remainingSeconds:null,resetAt:null,maxSessions:limit,activeSessions:0,blocked:false,code:null,message:''};
		const e=entry(id);
		const manual=e.minutes?Math.max(0,e.minutes*60-e.seconds):null;
		const daily=e.dailyMinutes?Math.max(0,e.dailyMinutes*60-e.dailySeconds):null;
		const remaining=[manual,daily].filter(value=>value!==null);
		const remainingSeconds=remaining.length?Math.min(...remaining):null;
		const manualExhausted=Boolean(e.minutes&&e.seconds>=e.minutes*60);
		const dailyLimiting=daily!==null&&!manualExhausted&&(manual===null||daily<=manual);
		const blocked=remainingSeconds!==null&&remainingSeconds<=0;
		return {remainingSeconds,resetAt:dailyLimiting?new Date(nextMidnight(clock())).toISOString():null,maxSessions:limit,
			activeSessions:admin?0:(Number.isFinite(activeSessions)?Math.max(0,activeSessions):0),blocked,code:blocked?'VIEWING_LIMIT':null,
			message:blocked?reason(viewer):''};
	}
	function media(id,viewer){
		if(home(viewer)||!key(viewer)){if(active.has(id)){tick();active.delete(id);}return;}guard(viewer);
		if(!active.has(id))active.set(id,{viewer,at:clock(),heartbeat:0,playing:true});
		const s=active.get(id);s.viewer=viewer;s.media=clock();
	}
	function heartbeat(id,playing){const s=active.get(id);if(s){tick();s.heartbeat=clock();s.playing=playing;}}
	function tick(){const now=clock();let dirty=false;
		for(const [id,s] of active){const start=Math.max(s.at,now-5000),elapsed=Math.max(0,(now-start)/1000);s.at=now;
			const playing=now-s.heartbeat<30000?s.playing:now-s.media<15000;
			const account=key(s.viewer);
			if(playing&&account&&!home(s.viewer)){
				const e=entry(account);e.seconds+=elapsed;
				// A tick can straddle UK midnight (including DST). Charge only today's portion.
				let today=start;
				if(day(start)!==e.day){let low=start,high=now;while(high-low>1){const mid=Math.floor((low+high)/2);if(day(mid)===e.day)high=mid;else low=mid;}today=high;}
				e.dailySeconds+=Math.max(0,(now-today)/1000);dirty=true;
			}
			if(now-Math.max(s.media,s.heartbeat)>120000)active.delete(id);
		}
		if(dirty&&now-saved>=5000){store.save();saved=now;}
	}
	function end(id){tick();active.delete(id);store.save();}
	return {status,set,allowed,guard,reason,key,media,heartbeat,tick,end,maxSessions,viewing};
}
