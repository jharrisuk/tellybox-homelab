import path from 'node:path';
import {jsonStore} from './json-store.mjs';
const fail=(message,status=403)=>Object.assign(Error(message),{status});
const ukDate=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/London',year:'numeric',month:'2-digit',day:'2-digit'});
export function createAccountLimits(directory,{clock=Date.now,resolveViewer=viewer=>viewer}={}){
	const store=jsonStore(path.join(directory,'account-limits.json'),{accounts:{}}),active=new Map();let saved=clock();
	const key=viewer=>{const v=resolveViewer(viewer);return v?.personId?'person:'+v.personId:v?.deviceId?'device:'+v.deviceId:'';};
	const home=viewer=>Boolean(viewer?.local||viewer?.home);
	const day=at=>ukDate.format(new Date(at));
	function entry(id){
		const e=store.get().accounts[id]||={minutes:0,seconds:0,downloads:false,dailyMinutes:0,dailySeconds:0,day:day(clock())};
		e.dailyMinutes??=0;e.dailySeconds??=0;
		if(e.day!==day(clock())){e.day=day(clock());e.dailySeconds=0;}
		return e;
	}
	function status(id){const e=entry(id);return {...e,remainingMinutes:e.minutes?Math.max(0,e.minutes-e.seconds/60):null,dailyRemainingMinutes:e.dailyMinutes?Math.max(0,e.dailyMinutes-e.dailySeconds/60):null,reset:'manual',dailyTimezone:'Europe/London'};}
	function set(id,body){
		if(!/^(person|device):[a-f0-9]{32}$/.test(id))throw fail('Invalid account.',400);
		if(!Number.isInteger(body.minutes)||body.minutes<0||body.minutes>525600||typeof body.downloads!=='boolean')throw fail('Enter a whole number of minutes, or 0 for unlimited.',400);
		if(body.dailyMinutes!==undefined&&(!Number.isInteger(body.dailyMinutes)||body.dailyMinutes<0||body.dailyMinutes>1440))throw fail('Daily minutes must be between 0 and 1440. Use 0 for unlimited.',400);
		tick();const e=entry(id);Object.assign(e,{minutes:body.minutes,downloads:body.downloads,dailyMinutes:body.dailyMinutes??e.dailyMinutes});
		if(body.reset===true){e.seconds=0;e.resetAt=clock();}
		if(body.resetDaily===true){e.dailySeconds=0;e.dailyResetAt=clock();}
		store.save();return status(id);
	}
	function reason(viewer,download=false){
		if(home(viewer))return '';const id=key(viewer);if(!id)return '';
		const e=entry(id);
		if(download)return e.downloads===true?'':'Downloads are disabled for this account. Ask the owner to enable them.';
		if(e.dailyMinutes&&e.dailySeconds>=e.dailyMinutes*60)return 'Your daily viewing allowance has been used. It resets at midnight UK time.';
		return e.minutes&&e.seconds>=e.minutes*60?'Your viewing allowance has been used. Ask the owner to reset it.':'';
	}
	function allowed(viewer,download=false){return !reason(viewer,download);}
	function guard(viewer,download=false){const message=reason(viewer,download);if(message)throw fail(message);}
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
	return {status,set,allowed,guard,key,media,heartbeat,tick,end};
}
