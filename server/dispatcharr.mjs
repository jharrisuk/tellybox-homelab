import { readFileSync, writeFileSync, renameSync } from 'node:fs';

const fail = (message, status = 502) => Object.assign(new Error(message), { status });
const reconnectMessage = 'Dispatcharr sign-in has expired or been revoked. Reconnect Dispatcharr in local server settings using a personal API key for a lasting connection.';
function expiresAt(value) {
	try { const exp=JSON.parse(Buffer.from(value.split('.')[1],'base64url').toString()).exp; return Number.isFinite(exp)?exp*1000:null; } catch { return null; }
}
export const isNonstop = value => /(?:\b24\s*[\/×x-]?\s*7\b|\b247\b)/i.test(value || '');

export function parsePlaylist(text, origin) {
	const channels = [], ids = new Set(); let info;
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		if (line.startsWith('#EXTINF:')) {
			const attrs = Object.fromEntries([...line.matchAll(/([\w-]+)="([^"]*)"/g)].map(m => [m[1], m[2]]));
			const delimiter = line.match(/,(?=(?:[^\"]*\"[^\"]*\")*[^\"]*$)/)?.index;
			info = { name:line.slice((delimiter ?? line.length) + 1).trim() || attrs['tvg-name'], number:attrs['tvg-chno'] || '', group:attrs['group-title'] || 'Other', epgId:attrs['tvg-id'] || '', logo:attrs['tvg-logo'] || '' };
		} else if (info && line && !line.startsWith('#')) {
			try {
				const url = new URL(line);
				const id = url.pathname.match(/^\/proxy\/ts\/stream\/([a-f0-9-]{36})\/?$/i)?.[1];
				if (url.origin === origin && id && !ids.has(id)) {
					ids.add(id); channels.push({ ...info, id, nonstop:isNonstop(info.group) || isNonstop(info.name) });
				}
			} catch { /* Ignore malformed or external playlist entries. */ }
			info = null;
		}
	}
	return channels.sort((a,b) => (Number(a.number) || 0) - (Number(b.number) || 0) || a.name.localeCompare(b.name));
}

export function createDispatcharr({ file, origin = 'http://127.0.0.1:1', fetcher = fetch, clock = Date.now }) {
	let playlist, playlistPromise, token = '', tokenUntil = 0, tokenPromise;
	let playlistAttempt = -Infinity;
	const playlistFile = file + '.channels-cache.json';
	const validSnapshot = value => value?.origin === origin && Number.isFinite(value.time) && value.time <= clock() && clock()-value.time < 86400000 && Array.isArray(value.items) && value.items.length && value.items.every(c => /^[a-f0-9-]{36}$/i.test(c.id) && typeof c.name === 'string');
	try { const saved=JSON.parse(readFileSync(playlistFile,'utf8')); if(validSnapshot(saved))playlist=saved; } catch {}
	function config() { try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return {}; } }
	function save(value) { writeFileSync(file+'.tmp', JSON.stringify(value), { mode:0o600 }); renameSync(file+'.tmp',file); }
	async function request(route, options = {}) {
		const response = await fetcher(new URL(route,origin), { ...options, redirect:'error', signal:AbortSignal.timeout(30000) });
		if (!response.ok) {
			await response.body?.cancel();
			throw Object.assign(fail(response.status === 401 || response.status === 403 ? 'Dispatcharr access was not accepted. Check the connection in local settings.' : 'Dispatcharr is unavailable. Please try again.', response.status === 401 || response.status === 403 ? 503 : 502),{upstreamStatus:response.status});
		}
		return response;
	}
	async function authHeaders() {
		const c = config();
		if (c.key) return { 'X-API-Key':c.key, Authorization:'ApiKey '+c.key };
		if (!c.refresh) throw fail('Connect Dispatcharr in local server settings to include its on-demand catalogue.',503);
		if (token && clock() < tokenUntil) return { Authorization:'Bearer '+token };
		const refreshExpiry=expiresAt(c.refresh);
		if(refreshExpiry!==null&&refreshExpiry<=clock())throw fail(reconnectMessage,503);
		if(!tokenPromise)tokenPromise=(async()=>{
			let response;
			try { response=await request('/api/accounts/token/refresh/',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({refresh:c.refresh})}); }
			catch(error) { if([401,403].includes(error.upstreamStatus))throw fail(reconnectMessage,503);throw error; }
			const data=await response.json();
			if(typeof data.access!=='string')throw fail('Dispatcharr did not renew the connection.');
			token=data.access; tokenUntil=clock()+4*60*1000;
			try {const expires=JSON.parse(Buffer.from(token.split('.')[1],'base64url').toString()).exp*1000;if(Number.isFinite(expires))tokenUntil=Math.min(tokenUntil,expires-30000);}catch{}
			if(data.refresh)save({...c,refresh:data.refresh});
		})();
		try{await tokenPromise;}finally{tokenPromise=null;}
		return {Authorization:'Bearer '+token};
	}
	async function api(route) {
		const url=new URL(route,origin);
		if (url.origin!==origin || !/^\/api\/vod\/(movies|series|episodes)\/(?:\d+\/(?:episodes\/|providers\/|provider-info\/)?)?$/.test(url.pathname)) throw fail('Invalid catalogue request.',400);
		try{return await (await request(route,{headers:await authHeaders()})).json();}
		catch(error){
			if(error.upstreamStatus!==401||!config().refresh)throw error;
			token='';tokenUntil=0;
			return(await request(route,{headers:await authHeaders()})).json();
		}
	}
	async function connect(body) {
		if (!body || typeof body !== 'object') throw fail('Enter your Dispatcharr connection details.',400);
		let candidate, headers;
		if (typeof body.key === 'string' && body.key.trim()) {
			if(body.key.length>4096 || /[\r\n]/.test(body.key))throw fail('Invalid API key.',400);
			candidate={key:body.key.trim()}; headers={'X-API-Key':candidate.key,Authorization:'ApiKey '+candidate.key};
		} else {
			if(typeof body.username!=='string'||typeof body.password!=='string'||!body.username||!body.password||body.username.length>200||body.password.length>1000)throw fail('Enter an API key or Dispatcharr sign-in details.',400);
			const result=await(await request('/api/accounts/token/',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:body.username,password:body.password})})).json();
			if(!result.access||!result.refresh)throw fail('Dispatcharr did not return a usable connection.');
			candidate={refresh:result.refresh}; headers={Authorization:'Bearer '+result.access};
		}
		await (await request('/api/vod/movies/?page_size=1',{headers})).body?.cancel();
		save(candidate); token=''; tokenUntil=0;
		return status();
	}
	async function channels(force = false) {
		if(!force&&playlist&&clock()-playlist.time<60000)return playlist.items;
		if(!force&&playlist&&clock()-playlist.time<86400000){
			if(!playlistPromise&&clock()-playlistAttempt>=15000)void refreshChannels().catch(()=>{});
			return playlist.items;
		}
		return refreshChannels();
	}
	async function refreshChannels() {
		if(playlistPromise)return playlistPromise;
		playlistAttempt=clock();
		playlistPromise=(async()=>{
			const text=await(await request('/output/m3u')).text();
			if(text.length>20000000)throw fail('The channel playlist is too large.');
			const items=parsePlaylist(text,origin); if(!items.length)throw fail('Dispatcharr returned an empty channel playlist.');
			playlist={time:clock(),items};
			// Persist only channel metadata. Stream addresses and provider credentials never enter this cache.
			const safeItems=items.map(item=>{let logo='';try{const url=new URL(item.logo,origin);if(url.origin===origin&&/^\/api\/channels\/logos\/\d+\/cache\/$/.test(url.pathname))logo=url.pathname;}catch{}return {...item,logo};});
			try{writeFileSync(playlistFile+'.tmp',JSON.stringify({origin,time:playlist.time,items:safeItems}),{mode:0o600});renameSync(playlistFile+'.tmp',playlistFile);}catch{}
			return items;
		})();
		try{return await playlistPromise;}finally{playlistPromise=null;}
	}
	async function stream(source,{range,signal,client='Tellybox'}={}) {
		if(!['movie','episode'].includes(source.type)||!/^[a-f0-9-]{36}$/i.test(source.uuid))throw fail('Invalid streamed title.',400);
		const prefix=`/proxy/vod/${source.type}/${source.uuid}`;
		let url=new URL(prefix+(/^[a-f0-9]{48}$/.test(source.session||'')?'/'+source.session:''),origin);
		if(Number.isSafeInteger(source.account))url.searchParams.set('m3u_account_id',String(source.account));
		if(/^\d+$/.test(String(source.streamId||'')))url.searchParams.set('stream_id',String(source.streamId));
		for(let hop=0;hop<4;hop++) {
			const response=await fetcher(url,{headers:{'User-Agent':client,...(range?{Range:range}:{})},redirect:'manual',signal});
			if([301,302,303,307,308].includes(response.status)) {
				const target=new URL(response.headers.get('location')||'',url);await response.body?.cancel();
				if(target.origin!==origin || !(target.pathname===prefix||target.pathname.startsWith(prefix+'/')))throw fail('Set Dispatcharr to proxy VOD streams rather than redirecting to the provider.');
				url=target;continue;
			}
			return response;
		}
		throw fail('Dispatcharr redirected this stream too many times.');
	}
	async function stopStream(session) {
		if(!/^[a-f0-9]{48}$/.test(session||''))return;
		try{await(await request('/proxy/vod/stop_client/',{method:'POST',headers:{...await authHeaders(),'Content-Type':'application/json'},body:JSON.stringify({client_id:session})})).body?.cancel();}catch{}
	}
	async function recordingApi(method,route,body) {
		const url=new URL(route,origin);
		const allowed=method==='GET'?/^\/api\/channels\/(?:channels\/|recordings\/(?:\d+\/)?)$/.test(url.pathname):
			method==='POST'?url.pathname==='/api/channels/recordings/':method==='DELETE'&&/^\/api\/channels\/recordings\/\d+\/$/.test(url.pathname);
		if(url.origin!==origin||!allowed)throw fail('Invalid recording request.',400);
		let response;
		try{response=await request(url,{method,headers:{...await authHeaders(),...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});}
		catch(error){if(error.upstreamStatus===403)throw fail('The connected Dispatcharr account needs recording-management permission to do this. Update its permissions or reconnect in server settings.',403);throw error;}
		return response.status===204?null:response.json();
	}
	async function recordingFile(id,{range,signal}={}) {
		if(!Number.isSafeInteger(id)||id<=0)throw fail('Invalid recording.',400);
		return fetcher(new URL(`/api/channels/recordings/${id}/file/`,origin),{headers:{...await authHeaders(),...(range?{Range:range}:{})},redirect:'error',signal});
	}
	async function catchupSession(channel,start,duration){
		const response=await request('/api/catchup/sessions/',{method:'POST',headers:{...await authHeaders(),'Content-Type':'application/json'},body:JSON.stringify({channel_uuid:channel,start,duration})});
		const data=await response.json(),url=new URL(data.playback_url,origin);
		if(url.origin!==origin||url.pathname!=='/proxy/catchup/'+channel||!data.session_id)throw fail('Dispatcharr returned an invalid catch-up session.');
		return {open:(signal,range)=>fetcher(url,{redirect:'error',signal,headers:range?{Range:range}:{}}),stop:async()=>{try{await(await request('/api/catchup/sessions/'+encodeURIComponent(data.session_id)+'/',{method:'DELETE',headers:await authHeaders()})).body?.cancel();}catch{}}};
	}

	function status() {
		const c=config(), expiry=c.key?null:expiresAt(c.refresh||'');
		// Keep connected as the configured flag for cached catalogue compatibility.
		return {connected:Boolean(c.key||c.refresh),origin,authMode:c.key?'api-key':c.refresh?'sign-in':'none',expiresAt:expiry,needsReconnect:expiry!==null&&expiry<=clock()};
	}
	return {channels,api,connect,stream,stopStream,recordingApi,recordingFile,catchupSession,origin,status};
}
