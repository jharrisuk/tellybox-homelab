import sax from 'sax';
import {readFile,writeFile,rename} from 'node:fs/promises';

export const channelGroupName=value=>String(value||'Other').replace(/^UK\b\s*[|:\-]?\s*/i,'').trim()||'Other';

// XMLTV offsets describe the broadcast time, independently of the browser's zone.
export function xmltvTime(value) {
	const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\s*(?:([+-])(\d{2})(\d{2})|Z)?$/.exec(String(value || '').trim());
	if (!m) return NaN;
	const [, y, mo, d, h, mi, s, sign, oh = '0', om = '0'] = m;
	const date = new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s));
	if (date.getUTCFullYear() !== +y || date.getUTCMonth() !== +mo - 1 || date.getUTCDate() !== +d || +h > 23 || +mi > 59 || +s > 59 || +oh > 23 || +om > 59) return NaN;
	return date.valueOf() - (sign === '-' ? -1 : 1) * (+oh * 60 + +om) * 60000;
}

export function channelView(channel) {
	return { Id:'dispatch-live-' + channel.id, Name:channel.name, Type:'TvChannel', ChannelNumber:channel.number, Group:channelGroupName(channel.group),
		Nonstop:channel.nonstop, Provider:'Dispatcharr', Artwork:'/api/dispatcharr/channels/' + channel.id + '/image', ImageTags:{} };
}

export async function parseEpg(body, channels, now = Date.now(), historyDays = 0) {
	const until = now + 24 * 3600000;
	const wanted = new Set(channels.filter(c => !c.nonstop).map(c => c.epgId).filter(Boolean));
	const listings = new Map([...wanted].map(id => [id, new Map()]));
	const parser = sax.parser(true, { trim:false, normalize:false });
	let current, field, depth = 0, fieldDepth = 0, bytes = 0, invalid = 0;
	parser.ondoctype = () => { throw Error('Unsupported guide document.'); };
	parser.onopentag = tag => {
		depth++;
		if (tag.name === 'programme') {
			const start = xmltvTime(tag.attributes.start), end = xmltvTime(tag.attributes.stop);
			current = wanted.has(tag.attributes.channel) && start < until && end > now - historyDays * 86400000 && end > start
				? { channel:tag.attributes.channel, start, end, title:'', description:'' } : null;
			if (wanted.has(tag.attributes.channel) && (!Number.isFinite(start) || !Number.isFinite(end) || end <= start)) invalid++;
		} else if (current && ['title', 'desc'].includes(tag.name) && !field) {
			field = { name:tag.name, text:'', english:/^en(?:g|-|$)/i.test(tag.attributes.lang || '') }; fieldDepth = depth;
		}
	};
	const text = value => { if (field) field.text = (field.text + value).slice(0, 12000); };
	parser.ontext = text; parser.oncdata = text;
	parser.onclosetag = name => {
		if (field && depth === fieldDepth) {
			const key = field.name === 'title' ? 'title' : 'description';
			if (!current[key] || field.english) current[key] = field.text.trim();
			field = null;
		}
		if (name === 'programme' && current) {
			if (current.title) listings.get(current.channel).set(current.start + ':' + current.end + ':' + current.title, current);
			current = null;
		}
		depth--;
	};
	const decoder = new TextDecoder();
	for await (const chunk of body) {
		bytes += chunk.byteLength;
		if (bytes > 80 * 1024 * 1024) throw Error('Guide is larger than supported.');
		parser.write(decoder.decode(chunk, { stream:true }));
	}
	parser.write(decoder.decode()).close();
	let conflicts = 0;
	const result = channels.filter(c => !c.nonstop).map(channel => {
		const entries = [...(listings.get(channel.epgId)?.values() || [])].sort((a,b) => a.start - b.start || a.end - b.end);
		// Ambiguous overlapping listings are omitted, rather than choosing an invented winner.
		const programmes = entries.filter((entry, i) => {
			const overlap = entries.some((other, j) => j !== i && other.start < entry.end && other.end > entry.start);
			if (overlap) conflicts++;
			return !overlap;
		}).map(entry => ({ Id:channel.id + ':' + entry.start, Name:entry.title, Overview:entry.description, StartDate:new Date(entry.start).toISOString(), EndDate:new Date(entry.end).toISOString() }));
		return { ...channelView(channel), programmes };
	});
	const signatures=new Map();
	for(const channel of result) {
		if(channel.programmes.length<3)continue;
		const signature=JSON.stringify(channel.programmes.slice(0,3).map(p=>[p.Name,p.StartDate,p.EndDate]));
		signatures.set(signature,[...(signatures.get(signature)||[]),channel]);
	}
	const sharedSchedules=[...signatures.values()].filter(group=>group.length>1);
	for(const group of sharedSchedules)for(const channel of group)channel.GuideWarning='This channel shares an identical schedule with other channels. Its guide mapping may need checking.';
	return { channels:result, until, invalid, conflicts, sharedSchedules:sharedSchedules.map(group=>group.map(c=>c.Name)), current:result.filter(c => c.programmes.some(p => Date.parse(p.StartDate) <= now && Date.parse(p.EndDate) > now)).length };
}

export function createDispatcharrGuide(dispatcharr, fetcher = fetch, clock = Date.now, file = '') {
	let cached, pending, lastAttempt = 0;
	const restored=file?readFile(file,'utf8').then(text=>{const value=JSON.parse(text);if(Array.isArray(value.channels)&&clock()-value.fetchedAt<24*3600000)cached=value;}).catch(()=>{}):Promise.resolve();
	async function refresh(force = false) {
		await restored;
		if (pending) return pending;
		if (cached && clock() - lastAttempt < (force ? 10000 : 120000)) return cached;
		lastAttempt = clock();
		pending = (async () => {
			const channels = await dispatcharr.channels();
			try {
				const response = await fetcher(new URL('/output/epg?days=1&prev_days=7', dispatcharr.origin), { redirect:'error', signal:AbortSignal.timeout(45000) });
				if (!response.ok) throw Error('Guide unavailable');
				const data = await parseEpg(response.body, channels, clock(), 7);
				cached = { ...data, historyDays:7, fetchedAt:clock(), available:true, stale:false, provider:'Dispatcharr' };
				if(file)try{await writeFile(file+'.tmp',JSON.stringify(cached),{mode:0o600});await rename(file+'.tmp',file);}catch{}
			} catch {
				const previous = new Map((cached?.channels || []).map(c => [c.Id, c]));
				cached = { channels:channels.filter(c => !c.nonstop).map(c => ({ ...channelView(c), programmes:previous.get('dispatch-live-' + c.id)?.programmes.filter(p => Date.parse(p.EndDate) > clock()) || [] })),
					fetchedAt:cached?.fetchedAt || 0, available:false, stale:true, provider:'Dispatcharr', until:clock()+6*3600000 };
			}
			return cached;
		})();
		try { return await pending; } finally { pending = null; }
	}
	const get=async(force=false)=>{
		await restored;
		if(force||!cached)await refresh(force);
		if(clock()-cached.fetchedAt>120000)void refresh().catch(()=>{});
		return {...cached,refreshing:Boolean(pending),channels:cached.channels.map(c=>({...c,Group:channelGroupName(c.Group),programmes:c.programmes.filter(p=>Date.parse(p.EndDate)>clock())}))};
	};
	get.archive=async()=>{await restored;if(!cached||cached.historyDays!==7||clock()-cached.fetchedAt>120000)await refresh(true);return cached;};
	return get;
}
