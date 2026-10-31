import {readFile,writeFile,rename} from 'node:fs/promises';

const day=86400000;
const genreIds={28:'Action',12:'Adventure',16:'Animation',35:'Comedy',80:'Crime',99:'Documentaries',18:'Drama',10751:'Family',14:'Fantasy',36:'History',27:'Horror',10402:'Music',9648:'Mystery',10749:'Romance',878:'Sci-fi',53:'Thriller',10759:'Action & adventure',10762:'Kids',10764:'Reality',10765:'Sci-fi & fantasy',10767:'Talk shows',10768:'History'};
const normalize=value=>String(value||'').normalize('NFKD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/&/g,' and ').replace(/[^a-z0-9]/g,'');
export function channelIdentity(channel) {
	const group=String(channel.group||'');
	const type=/movies?|cinema/i.test(group)?'movie':/series|teens|kids/i.test(group)?'tv':null;
	let title=String(channel.name||'').replace(/^\s*(?:24\s*[\/x×-]?\s*7|247)\s*[-:|·]?\s*/i,'').replace(/\s*\[?(?:FHD|UHD|HD|SD|4K)\]?\s*$/i,'').trim();
	const year=Number(title.match(/\s*\((19\d{2}|20\d{2})\)$/)?.[1])||null;
	if(year)title=title.replace(/\s*\((?:19\d{2}|20\d{2})\)$/,'').trim();
	return type&&title?{type,title,year,key:`${type}:${normalize(title)}:${year||''}`}:null;
}
export function matchChannel(identity,results) {
	if(!identity)return null;
	const exact=new Map();
	for(const item of results||[]) {
		if(item.mediaType!==identity.type||!Number.isSafeInteger(item.id)||item.id<=0)continue;
		const names=[item.title,item.name,item.originalTitle,item.originalName];
		if(!names.some(name=>name&&normalize(name)===normalize(identity.title)))continue;
		const date=item.releaseDate||item.firstAirDate||'';
		if(identity.year&&Number(date.slice(0,4))!==identity.year)continue;
		exact.set(item.id,item);
	}
	// Remakes and similarly named titles stay in the provider group until identifiable.
	if(exact.size!==1)return null;
	const item=[...exact.values()][0];
	return {id:item.id,type:identity.type,genres:[...new Set((item.genreIds||[]).map(id=>genreIds[id]).filter(Boolean))]};
}

/** Cached, paced title lookup. Opening the channel grid never waits for upstream metadata. */
export function createNonstopMetadata({search,file,clock=Date.now,delayMs=800}) {
	const cache=new Map(),queue=new Map();let busy=false,activeKey=null,timer,saveTimer,backoff=0,closed=false,writing=Promise.resolve();
	const ready=file?readFile(file,'utf8').then(raw=>{for(const [key,value] of JSON.parse(raw))if(typeof key==='string'&&Number.isFinite(value?.time))cache.set(key,value);}).catch(()=>{}):Promise.resolve();
	function save() {
		if(!file||saveTimer)return;
		saveTimer=setTimeout(()=>{saveTimer=null;writing=writing.then(async()=>{await writeFile(file+'.tmp',JSON.stringify([...cache]),{mode:0o600});await rename(file+'.tmp',file);}).catch(()=>{});},1000);saveTimer.unref?.();
	}
	function pump() {
		if(closed||busy||timer||!queue.size)return;
		timer=setTimeout(async()=>{
			timer=null;if(closed)return;busy=true;
			const [key,identity]=queue.entries().next().value;queue.delete(key);activeKey=key;
			try {const result=matchChannel(identity,await search(identity.title));cache.set(key,{time:clock(),result});save();}
			catch {queue.set(key,identity);backoff=clock()+5*60000;}
			finally {busy=false;activeKey=null;pump();}
		},Math.max(delayMs,backoff-clock()));timer.unref?.();
	}
	async function enrich(channels) {
		await ready;
		const result=channels.map(channel=>{
			const identity=channelIdentity(channel),entry=identity&&cache.get(identity.key);
			if(identity&&identity.key!==activeKey&&(!entry||clock()-entry.time>14*day)&&queue.size<1500)queue.set(identity.key,identity);
			return {...channel,genres:entry?.result?.genres||[]};
		});pump();return result;
	}
	return {enrich,status:()=>({matched:[...cache.values()].filter(e=>e.result?.genres.length).length,pending:queue.size+(busy?1:0)}),close(){closed=true;clearTimeout(timer);clearTimeout(saveTimer);}};
}
