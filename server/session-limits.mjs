// Remote screen reservations. Counted per linked account, never per app token.
// acquire() is synchronous, so the count and insert cannot be interleaved by async
// preparation. Downloads and exempt viewers never reserve a screen.
export const SESSION_LIMIT='SESSION_LIMIT';
const fail=message=>Object.assign(Error(message),{status:429,code:SESSION_LIMIT});
export function createSessionLimits({accountLimits,clock=Date.now,exists=()=>true,idleMs=90000,preparedMs=45000,pendingMs=60000}={}){
	const bySession=new Map(),byAccount=new Map();
	const exempt=(viewer,admin)=>Boolean(admin||viewer?.local||viewer?.home);
	const limitFor=key=>accountLimits.maxSessions(key);
	function active(key){return byAccount.get(key)?.size||0;}
	function detach(id){
		const entry=bySession.get(id);if(!entry)return null;
		bySession.delete(id);
		const members=byAccount.get(entry.key);
		if(members){members.delete(id);if(!members.size)byAccount.delete(entry.key);}
		return entry;
	}
	function release(id){return Boolean(detach(id));}
	function message(limit){
		return limit===1
			?'This account is already watching on another screen. Stop playback there before starting here.'
			:`This account is already watching on ${limit} screens. Stop playback on one of them before starting here.`;
	}
	function acquire(id,viewer,{admin=false,download=false,pending=false}={}){
		const key=download?'':accountLimits.key(viewer);
		// Exempt viewers still take no reservation. An unlimited account is not
		// exempt: its remote screens are tracked so a later finite cap can preserve
		// them and reject new sessions.
		if(exempt(viewer,admin)||!key){detach(id);return null;}
		const prior=bySession.get(id);
		// The same session may refresh its own slot even if an administrator has
		// since lowered the cap. A different account is a new transition and must
		// find free capacity.
		if(prior&&prior.key===key){prior.viewer=viewer;return prior;}
		if(prior)detach(id);
		const now=clock(),limit=limitFor(key);
		if(limit>0&&active(key)>=limit)throw fail(message(limit));
		const entry={id,key,viewer,at:now,media:0,heartbeat:0,started:false,pending:Boolean(pending),admin:Boolean(admin)};
		bySession.set(id,entry);
		if(!byAccount.has(key))byAccount.set(key,new Set());
		byAccount.get(key).add(id);
		return entry;
	}
	// Preparation holds a pending reservation until the session exists. Without
	// this explicit commit the next sweep could mistake a slow preparation for a
	// failed one and admit a second stream.
	function commit(id){
		const entry=bySession.get(id);if(!entry)return false;
		entry.pending=false;entry.at=clock();
		return true;
	}
	// Re-resolve linked accounts on every heartbeat and media request. A move to a
	// different account must acquire that account's capacity; it is never bypassed.
	function touch(id,viewer,{admin=false,download=false,media=false,heartbeat=false,started=false}={}){
		const entry=acquire(id,viewer,{admin,download});
		if(!entry)return null;
		const now=clock();
		entry.pending=false;
		entry.viewer=viewer;
		if(media){entry.media=now;entry.started=true;}
		if(heartbeat)entry.heartbeat=now;
		if(started)entry.started=true;
		return entry;
	}
	function count(viewer,{admin=false}={}){
		if(exempt(viewer,admin))return 0;
		const key=accountLimits.key(viewer);
		return key?active(key):0;
	}
	const media=(id,viewer,options={})=>touch(id,viewer,{...options,media:true});
	const heartbeat=(id,viewer,options={})=>touch(id,viewer,{...options,heartbeat:true});
	function tick(){
		const now=clock();
		for(const [id,entry] of bySession){
			// Pending preparation is not in the sessions map yet. Only its bounded
			// TTL may release it.
			if(entry.pending){if(now-entry.at>=pendingMs)release(id);continue;}
			if(!exists(id)){release(id);continue;}
			// A prepared or warm-up session that never played must not hold a screen.
			if(!entry.started&&now-entry.at>=preparedMs){release(id);continue;}
			if(now-Math.max(entry.at,entry.media,entry.heartbeat)>=idleMs)release(id);
		}
	}
	return {acquire,commit,release,touch,count,tick,active,media,heartbeat,snapshot:()=>[...bySession.values()].map(entry=>({...entry}))};
}
