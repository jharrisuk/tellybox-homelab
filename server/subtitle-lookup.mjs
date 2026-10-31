import {readFile,writeFile,mkdir,rename,readdir,stat,unlink} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';

export const downloadedSubtitleIndex=1000000;
export const englishLanguage=value=>/^(en|eng|english)([-_].*)?$/i.test(value||'');
const failure=(message,status=502)=>Object.assign(Error(message),{status});
const numeric=value=>/^\d+$/.test(String(value||''))&&Number.isSafeInteger(Number(value))&&Number(value)>0?String(Number(value)):'';
const imdb=value=>numeric(String(value||'').replace(/^tt/,''));

export function subtitleIdentity(item,series) {
	if(!['Movie','Episode'].includes(item?.Type))return null;
	const episode=item.Type==='Episode',ids=(episode?series:item)?.ProviderIds||{};
	const identity={type:episode?'episode':'movie',imdb:imdb(ids.Imdb),tmdb:numeric(ids.Tmdb)};
	if(!identity.imdb&&!identity.tmdb)return null;
	if(episode){
		if(!Number.isInteger(item.ParentIndexNumber)||item.ParentIndexNumber<0||!Number.isInteger(item.IndexNumber)||item.IndexNumber<1)return null;
		Object.assign(identity,{season:item.ParentIndexNumber,episode:item.IndexNumber});
	}
	return identity;
}

export function chooseSubtitle(rows,identity,release='') {
	const normal=value=>String(value||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
	return (rows||[]).map(row=>row.attributes).filter(a=>{
		const f=a?.feature_details||{};
		if(a?.language!=='en'||a.foreign_parts_only||a.ai_translated||a.machine_translated||a.files?.length!==1||!Number.isSafeInteger(a.files[0]?.file_id))return false;
		if(String(f.feature_type).toLowerCase()!==identity.type)return false;
		const episode=identity.type==='episode';
		if(episode&&(Number(f.season_number)!==identity.season||Number(f.episode_number)!==identity.episode))return false;
		const actualImdb=imdb(f[episode?'parent_imdb_id':'imdb_id']),actualTmdb=numeric(f[episode?'parent_tmdb_id':'tmdb_id']);
		if(identity.imdb&&actualImdb&&identity.imdb!==actualImdb||identity.tmdb&&actualTmdb&&identity.tmdb!==actualTmdb)return false;
		return Boolean(identity.imdb&&actualImdb===identity.imdb||identity.tmdb&&actualTmdb===identity.tmdb);
	}).sort((a,b)=>{
		const score=a=>(release&&normal(a.release)===normal(release)?1e9:0)+(a.from_trusted?1e7:0)+Math.min(1e6,Number(a.download_count)||0);
		return score(b)-score(a);
	})[0]||null;
}

// Only plain, bounded SRT cues enter libass. Ignore markup, positioning and executable attachments.
export function cleanSrt(text) {
	if(Buffer.byteLength(text)>2*1024*1024)throw failure('The subtitle file was too large.');
	const cues=[];let end=0;
	for(const block of text.replace(/^\uFEFF/,'').replace(/\r/g,'').split(/\n\s*\n/)){
		const lines=block.trim().split('\n'),index=lines.findIndex(line=>/^\d{2}:\d{2}:\d{2}[,.]\d{3}\s+-->\s+\d{2}:\d{2}:\d{2}[,.]\d{3}/.test(line));
		if(index<0)continue;
		const match=lines[index].match(/^(\d{2}):(\d{2}):(\d{2})[,.](\d{3})\s+-->\s+(\d{2}):(\d{2}):(\d{2})[,.](\d{3})/);
		const parts=match.slice(1).map(Number);if(parts[1]>59||parts[2]>59||parts[5]>59||parts[6]>59)continue;
		const start=parts[0]*3600+parts[1]*60+parts[2]+parts[3]/1000,stop=parts[4]*3600+parts[5]*60+parts[6]+parts[7]/1000;
		if(stop<=start||stop>86400)continue;
		const content=lines.slice(index+1).join('\n').replace(/<[^>]*>/g,'').replace(/\{[^}]*\}/g,'').replace(/[\u0000-\u0008\u000b-\u001f]/g,'').trim().slice(0,2000);
		if(!content)continue;
		cues.push(`${cues.length+1}\n${match[0].replace(/\./g,',')}\n${content}`);end=Math.max(end,stop);
		if(cues.length>20000)throw failure('The subtitle file contained too many captions.');
	}
	if(!cues.length)throw failure('No usable English captions were found in the download.');
	return {text:cues.join('\n\n')+'\n',end};
}

export function createSubtitleLookup({directory,fetcher=fetch,clock=Date.now}) {
	const configFile=path.join(directory,'opensubtitles.json'),cacheDir=path.join(directory,'subtitle-cache');
	let token='',tokenUntil=0,apiHost='api.opensubtitles.com',loginPending,blockedUntil=0,lastNotice='',quota=null;
	const pending=new Map(),misses=new Map();
	const load=async()=>{try{return JSON.parse(await readFile(configFile,'utf8'));}catch{return {};}};
	async function bounded(response,max=2*1024*1024){let size=0;const chunks=[];for await(const chunk of response.body){size+=chunk.length;if(size>max)throw failure('Subtitle response was too large.');chunks.push(chunk);}return Buffer.concat(chunks).toString('utf8');}
	async function call(route,config,{body,auth=true,signal}={}) {
		const original=new URL(`https://${apiHost}/api/v1${route}`);
		let address=original,response;
		const options={method:body?'POST':'GET',redirect:'manual',signal:signal||AbortSignal.timeout(10000),headers:{'Api-Key':config.key,'User-Agent':'Tellybox v0.20.7',Accept:'application/json',...(body?{'Content-Type':'application/json'}:{}),...(auth&&token?{Authorization:'Bearer '+token}:{})},...(body?{body:JSON.stringify(body)}:{})};
		for(let redirects=0;;redirects++){
			response=await fetcher(address.href,options);
			if(![301,302,303,307,308].includes(response.status))break;
			const location=response.headers.get('location');await response.body?.cancel();
			const target=location?new URL(location,address):null;
			// OpenSubtitles canonicalises search queries. Never forward credentials to another host or endpoint.
			if(body||original.pathname!=='/api/v1/subtitles'||redirects>=3||!target||target.origin!==original.origin||target.pathname!==original.pathname||target.username||target.password||target.hash)
				throw failure('OpenSubtitles returned an unsupported search redirect.');
			address=target;
		}
		if(!response.ok){await response.body?.cancel();
			if([401,403].includes(response.status)){blockedUntil=clock()+3600000;token='';throw failure('OpenSubtitles access was rejected. Check its connection in local Settings.');}
			if([406,429].includes(response.status)){blockedUntil=clock()+3600000;throw failure('OpenSubtitles download allowance or rate limit reached. Playback can continue without downloaded subtitles.');}
			throw failure('OpenSubtitles is unavailable. Playback can continue without downloaded subtitles.');
		}
		try{return JSON.parse(await bounded(response));}catch(error){if(error.status)throw error;throw failure('OpenSubtitles returned an unreadable response.');}
	}
	async function login(config,signal) {
		if(!config.username||!config.password)return;
		if(token&&clock()<tokenUntil)return;
		if(!loginPending)loginPending=(async()=>{
			const result=await call('/login',config,{body:{username:config.username,password:config.password},auth:false,signal});
			if(typeof result.token!=='string'||!['api.opensubtitles.com','vip-api.opensubtitles.com'].includes(result.base_url||'api.opensubtitles.com'))throw failure('OpenSubtitles did not return a usable sign-in.');
			token=result.token;apiHost=result.base_url||'api.opensubtitles.com';tokenUntil=clock()+23*3600000;
			try{const exp=JSON.parse(Buffer.from(token.split('.')[1],'base64url').toString()).exp*1000;if(Number.isFinite(exp))tokenUntil=Math.min(tokenUntil,exp-60000);}catch{}
		})();
		try{await loginPending;}finally{loginPending=null;}
	}
	async function status(){const c=await load();return {configured:Boolean(c.key),enabled:Boolean(c.key)&&c.enabled!==false,account:Boolean(c.username),notice:lastNotice,remaining:quota};}
	async function connect(body) {
		const old=await load();
		if(body?.key===undefined&&typeof body?.enabled==='boolean'&&old.key){await writeFile(configFile,JSON.stringify({...old,enabled:body.enabled}),{mode:0o600});return status();}
		if(!body||typeof body.key!=='string'||!body.key.trim()||body.key.length>4096||/[\r\n]/.test(body.key))throw failure('Enter your OpenSubtitles API key.',400);
		if((body.username||body.password)&&(!(typeof body.username==='string'&&body.username.trim())||typeof body.password!=='string'||!body.password||body.password.length>1000||body.username.length>200))throw failure('Enter both the OpenSubtitles username and password, or leave both blank.',400);
		const candidate={key:body.key.trim(),enabled:body.enabled!==false,...(body.username?{username:body.username.trim(),password:body.password}:{})};
		const previous={token,tokenUntil,apiHost,blockedUntil};
		token='';tokenUntil=0;apiHost='api.opensubtitles.com';blockedUntil=0;
		try{await login(candidate);await call(candidate.username?'/infos/user':'/infos/languages',candidate);}
		catch(error){({token,tokenUntil,apiHost,blockedUntil}=previous);throw error;}
		await mkdir(directory,{recursive:true});await writeFile(configFile+'.tmp',JSON.stringify(candidate),{mode:0o600});await rename(configFile+'.tmp',configFile);misses.clear();lastNotice='';quota=null;return status();
	}
	async function downloadFile(link,signal){
		for(let i=0;i<4;i++){
			const url=new URL(link);
			if(url.protocol!=='https:'||url.username||url.password||url.port||!/(^|\.)opensubtitles\.(com|org)$/.test(url.hostname))throw failure('OpenSubtitles returned an unsupported download address.');
			// Never forward API credentials to file storage or redirected URLs.
			const response=await fetcher(url,{redirect:'manual',signal});
			if([301,302,303,307,308].includes(response.status)){link=new URL(response.headers.get('location')||'',url).href;await response.body?.cancel();continue;}
			if(!response.ok){await response.body?.cancel();throw failure('The subtitle file could not be downloaded.');}
			return bounded(response);
		}
		throw failure('The subtitle download redirected too many times.');
	}
	async function lookup({item,series,release='',fingerprint='',duration=0,cachedOnly=false}) {
		const config=await load(),identity=subtitleIdentity(item,series);
		if(!config.key||config.enabled===false||!identity)return null;
		const key=createHash('sha256').update(JSON.stringify({identity,release,fingerprint,duration:Math.round(duration)})).digest('hex'),file=path.join(cacheDir,key+'.srt');
		try{const value=cleanSrt(await readFile(file,'utf8'));if(duration&&value.end>duration+120)return null;return {file,index:downloadedSubtitleIndex,label:'English · OpenSubtitles'};}catch{}
		if(cachedOnly||clock()<blockedUntil||clock()<(misses.get(key)||0))return null;
		if(pending.has(key))return pending.get(key);
		if(pending.size>=3)return null;
		const job=(async()=>{
			const signal=AbortSignal.timeout(12000);
			try{
				await login(config,signal);
				const query={languages:'en',type:identity.type,foreign_parts_only:'exclude',ai_translated:'exclude',order_by:'download_count',order_direction:'desc'};
				if(identity.type==='episode'){query.season_number=identity.season;query.episode_number=identity.episode;query[identity.imdb?'parent_imdb_id':'parent_tmdb_id']=identity.imdb||identity.tmdb;}
				else query[identity.imdb?'imdb_id':'tmdb_id']=identity.imdb||identity.tmdb;
				const params=new URLSearchParams(query);params.sort();
				const result=await call('/subtitles?'+params,config,{signal});
				const match=chooseSubtitle(result.data,identity,release);
				if(!match){misses.set(key,clock()+6*3600000);return null;}
				const download=await call('/download',config,{body:{file_id:match.files[0].file_id,sub_format:'srt'},signal});
				if(Number.isFinite(download.remaining))quota=download.remaining;
				const captions=cleanSrt(await downloadFile(download.link,signal));
				if(duration&&captions.end>duration+120)throw failure('The available subtitles do not match this video duration.');
				await mkdir(cacheDir,{recursive:true});await writeFile(file+'.tmp',captions.text,{mode:0o600});await rename(file+'.tmp',file);lastNotice='';
				const files=(await readdir(cacheDir)).filter(name=>/^[a-f0-9]{64}\.srt$/.test(name));
				if(files.length>300){const dated=await Promise.all(files.map(async name=>({name,time:(await stat(path.join(cacheDir,name))).mtimeMs})));for(const old of dated.sort((a,b)=>a.time-b.time).slice(0,files.length-300))await unlink(path.join(cacheDir,old.name)).catch(()=>{});}
				return {file,index:downloadedSubtitleIndex,label:'English · OpenSubtitles'};
			}catch(error){lastNotice=error.status?error.message:'Subtitle lookup timed out or is unavailable. Playback can continue.';misses.set(key,clock()+300000);return null;}
			finally{if(misses.size>1000)misses.delete(misses.keys().next().value);}
		})();
		pending.set(key,job);try{return await job;}finally{pending.delete(key);}
	}
	return {lookup,status,connect};
}
