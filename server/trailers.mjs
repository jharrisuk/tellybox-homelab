const youtubeId=/^[A-Za-z0-9_-]{11}$/;
const hosts=new Set(['youtube.com','www.youtube.com','m.youtube.com','www.youtube-nocookie.com']);
const text=value=>typeof value==='string'?value.trim():'';

/** Extract only an exact YouTube video identity. Arbitrary URLs are never passed through. */
export function youtubeKey(value) {
	const address=text(value);
	if(!address)return null;
	try {
		const url=new URL(address);
		if(url.protocol!=='https:'||url.username||url.password||url.port)return null;
		const host=url.hostname.toLowerCase();
		if(host==='youtu.be') {
			const id=url.pathname.replace(/^\/|\/$/g,'');
			return youtubeId.test(id)&&!id.includes('/')?id:null;
		}
		if(!hosts.has(host))return null;
		if(url.pathname==='/watch') {
			const id=url.searchParams.get('v')||'';
			return youtubeId.test(id)?id:null;
		}
		const match=/^\/(?:embed|shorts|live)\/([A-Za-z0-9_-]{11})\/?$/.exec(url.pathname);
		return match?match[1]:null;
	}
	catch{return null;}
}

function candidates(value,kind) {
	if(!Array.isArray(value))return [];
	return value.map(entry=>{
		if(!entry||typeof entry!=='object')return null;
		const type=text(entry.type),site=text(entry.site);
		if(type&&type.toLowerCase()!=='trailer')return null;
		if(site&&site.toLowerCase()!=='youtube')return null;
		const declared=text(entry.key);
		const key=youtubeId.test(declared)?declared:youtubeKey(entry.url||entry.Url);
		if(!key)return null;
		return {key,kind,name:text(entry.name||entry.Name).slice(0,200),official:entry.official===true};
	}).filter(Boolean);
}

/** Pick one real trailer from Jellyfin RemoteTrailers or TMDB/Seerr related videos. */
export function trailerView(input={}) {
	const {remoteTrailers,videos,relatedVideos}=input||{};
	const found=[...candidates(relatedVideos),...candidates(Array.isArray(videos)?videos:videos?.results),...candidates(remoteTrailers)];
	if(!found.length)return null;
	found.sort((a,b)=>Number(b.official)-Number(a.official));
	const chosen=found[0],result={Provider:'YouTube',Key:chosen.key,Url:`https://www.youtube.com/watch?v=${chosen.key}`};
	if(chosen.name)result.Name=chosen.name;
	return result;
}
