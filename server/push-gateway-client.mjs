import path from 'node:path';
import {readFileSync} from 'node:fs';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {jsonStore} from './json-store.mjs';

export const PUSH_GATEWAY='https://homelab.tellyboxapp.com/push/v1';
export const PUBLIC_APP_PACKAGE='app.tellybox.homelab';
const opaque=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{20,256}$/.test(value);
const unavailable=()=>Object.assign(Error('Tellybox notifications are unavailable. Background alerts remain available.'),{status:503});
export const pushDeviceId=id=>createHash('sha256').update(id).digest('hex');

async function boundedJson(response) {
	if(Number(response.headers.get('content-length')||0)>16384){await response.body?.cancel().catch(()=>{});throw unavailable();}
	const reader=response.body?.getReader();if(!reader)throw unavailable();
	let length=0;const chunks=[];
	try {
		while(true){const {done,value}=await reader.read();if(done)break;length+=value.length;if(length>16384)throw unavailable();chunks.push(Buffer.from(value));}
		return JSON.parse(Buffer.concat(chunks).toString('utf8'));
	} catch(error){await reader.cancel().catch(()=>{});throw error;}
}

export function createPushGatewayClient({directory,fetcher=fetch,clock=Date.now}) {
	let enabled=false;
	try {enabled=JSON.parse(readFileSync(path.join(directory,'push-gateway.json'),'utf8')).enabled===true;}catch{}
	const store=jsonStore(path.join(directory,'push-gateway-installation.json'),{}), state=store.get();
	let configUntil=0,configValue=false,configPending=null,enrolPending=null;
	function credentials() {return typeof state.id==='string'&&/^[a-f0-9-]{36}$/.test(state.id)&&typeof state.key==='string'&&/^[a-f0-9]{64}$/.test(state.key);}
	async function request(route,body,authenticated=false) {
		if(!enabled||Number(state.retryAt||0)>clock())throw unavailable();
		if(authenticated&&(!credentials()||!state.enrolled))throw unavailable();
		try {
			const response=await fetcher(PUSH_GATEWAY+route,{method:body?'POST':'GET',redirect:'error',signal:AbortSignal.timeout(route==='/wake'?15000:7000),
				headers:{...(body?{'Content-Type':'application/json'}:{}),...(authenticated?{Authorization:'Bearer '+state.id+'.'+state.key}:{})},...(body?{body:JSON.stringify(body)}:{})});
			// Token rotation can already have removed the old binding. Treat that as revoked,
			// otherwise a stale retry would prevent every new wake from being delivered.
			if(authenticated&&route==='/devices/revoke'&&response.status===404){await response.body?.cancel().catch(()=>{});return {ok:true};}
			if(!response.ok){
				// Expired unproven installations can enrol again using the same identity.
				// A revoked installation receives 403 and must never bypass that decision.
				if(authenticated&&response.status===401){state.enrolled=false;store.save();}
				await response.body?.cancel().catch(()=>{});throw unavailable();
			}
			return await boundedJson(response);
		} catch {
			state.retryAt=clock()+30000;store.save();throw unavailable();
		}
	}
	async function flushRevocations() {
		for(const handle of (Array.isArray(state.revocations)?state.revocations:[]).slice(0,8)) {
			try {await request('/devices/revoke',{handle},true);state.revocations=state.revocations.filter(item=>item!==handle);store.save();}catch{return;}
		}
	}
	async function status() {
		if(!enabled)return false;
		if(configUntil>clock())return configValue;
		if(configPending)return configPending;
		configPending=(async()=>{
			try {const value=await request('/config');configValue=value.enabled===true&&value.package===PUBLIC_APP_PACKAGE;configUntil=clock()+(configValue?60000:30000);}
			catch{configValue=false;configUntil=clock()+30000;}
			return configValue;
		})().finally(()=>{configPending=null;});return configPending;
	}
	async function enrol() {
		if(!enabled)throw unavailable();
		if(state.enrolled){if(!credentials())throw unavailable();return;}
		if(enrolPending)return enrolPending;
		enrolPending=(async()=>{
			if(!credentials()){state.id=randomUUID();state.key=randomBytes(32).toString('hex');store.save();}
			const result=await request('/installations',{id:state.id,key:state.key});
			if(result.id!==state.id)throw unavailable();state.enrolled=true;store.save();
		})().finally(()=>{enrolPending=null;});return enrolPending;
	}
	return {
		enabled,status,
		async ticket(deviceId) {
			if(!await status())throw unavailable();await enrol();await flushRevocations();
			const result=await request('/tickets',{deviceId:pushDeviceId(deviceId)},true);
			if(!opaque(result.ticket)||!Number.isSafeInteger(result.expiresAt)||result.expiresAt<=clock()||result.expiresAt>clock()+15*60000)throw unavailable();
			return {ticket:result.ticket,expiresAt:result.expiresAt};
		},
		async verify(handle,deviceId) {
			if(!opaque(handle))return false;
			const result=await request('/devices/verify',{handle,deviceId:pushDeviceId(deviceId)},true);return result.active===true;
		},
		async wake(handle,eventId) {
			if(!opaque(handle)||typeof eventId!=='string'||!/^[a-f0-9-]{36}$/i.test(eventId))return false;
			await flushRevocations();await request('/wake',{handle,eventId},true);return true;
		},
		async revoke(handle) {
			if(!opaque(handle))return;
			state.revocations=[...new Set([...(Array.isArray(state.revocations)?state.revocations:[]),handle])].slice(-128);store.save();
			if(enabled&&state.enrolled)await flushRevocations();
		}
	};
}
