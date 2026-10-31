export const ukTvSourceUrl = 'https://www.thinkbox.tv/training-and-tools/barb-data/top-programmes-report';
const plain = value => String(value || '').replace(/<[^>]*>/g, '').replace(/&(#x[\da-f]+|#\d+|amp|quot|apos|lt|gt|nbsp);/gi, (_, entity) => {
	if (!entity.startsWith('#')) return {amp:'&',quot:'"',apos:"'",lt:'<',gt:'>',nbsp:' '}[entity.toLowerCase()];
	const code = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
	return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
}).trim();
const normal = value => value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
const titleKey = value => normal(String(value || '').replace(/&/g, ' and '));
function networkKey(value) {
	const key=titleKey(value);
	return {bbc1:'bbcone',bbc2:'bbctwo',ch4:'channel4','5':'channel5',itv:'itv1',uanddave:'dave'}[key] || key;
}

export async function matchUkTv(item, week, call) {
	const result=await call('/search?query='+encodeURIComponent(item.title)+'&page=1');
	const matches=(result.results||[]).filter(candidate=>!candidate.adult && ['movie','tv'].includes(candidate.mediaType) && Number.isSafeInteger(candidate.id) && candidate.id>0 && [candidate.title,candidate.name,candidate.originalTitle,candidate.originalName].some(title=>title && titleKey(title)===titleKey(item.title)));
	const candidates=[...new Map(matches.map(candidate=>[candidate.mediaType+':'+candidate.id,candidate])).values()];
	if(candidates.length===1)return candidates[0];
	if(candidates.length>6)return null;
	const current=[],britishOnChannel=[];
	const start=Date.parse(week+'T00:00:00Z')-6*86400000, end=start+7*86400000;
	for(const candidate of candidates) {
		const detail=await call('/'+candidate.mediaType+'/'+candidate.id);
		if(candidate.mediaType!=='tv')continue;
		const began=Date.parse(detail.firstAirDate),last=Date.parse(detail.lastAirDate);
		const onChannel=(detail.networks||[]).some(network=>networkKey(network.name)===networkKey(item.channel));
		const resolved={...candidate,...detail,mediaType:candidate.mediaType};
		if(began<=end && last>=start && onChannel)current.push(resolved);
		if(began<=end && onChannel && (detail.originCountry||[]).includes('GB'))britishOnChannel.push(resolved);
	}
	// A current run on the reported channel distinguishes remakes and international editions.
	// If metadata cannot establish one match, keep the title searchable rather than guessing.
	return current.length===1?current[0]:current.length===0&&britishOnChannel.length===1?britishOnChannel[0]:null;
}

export function ukTvReport(html) {
	const raw = html.match(/<script\b[^>]*\bid="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/)?.[1];
	if (!raw) throw Error('UK TV report format changed');
	const articles = JSON.parse(raw)?.props?.pageProps?.data?.pageArticleCollection?.items;
	const article = articles?.find(item => item.slug === 'top-programmes-report');
	const weekNumber = Number(article?.reportTableSummary?.match(/\bweek\s+(\d{1,2})\b/i)?.[1]);
	const updated = Date.parse(article?.updatedDate);
	if (!weekNumber || weekNumber > 53 || !Number.isFinite(updated)) throw Error('UK TV report date unavailable');
	const year = new Date(updated).getUTCFullYear();
	let week;
	for (const y of [year, year - 1]) {
		const jan4 = new Date(Date.UTC(y, 0, 4));
		const end = new Date(jan4.getTime() + (7 * (weekNumber - 1) + 6 - (jan4.getUTCDay() + 6) % 7) * 86400000);
		if (end.getTime() <= updated + 86400000 && updated - end.getTime() < 90 * 86400000) { week = end.toISOString().slice(0, 10); break; }
	}
	if (!week) throw Error('UK TV report date is inconsistent');
	const url = new URL(article?.reportDataFile?.url);
	if (url.origin !== 'https://assets.ctfassets.net' || !url.pathname.startsWith('/ptzdhtf6t0jg/') || !url.pathname.endsWith('/TopProgs.json') || url.search || url.hash || url.username || url.password) throw Error('Unexpected UK TV data source');
	return {week, url:url.href};
}

export function ukTvRows(data, week) {
	if (!Array.isArray(data?.content) || data.content.length > 10000) throw Error('Invalid UK TV chart');
	const channels = data.filters?.find(filter => filter.label === 'Commercial TV By Channel')?.content;
	if (!Array.isArray(channels) || channels.some(channel => typeof channel !== 'string')) throw Error('UK TV channel filters unavailable');
	const allowed = new Set(['All TV', ...channels]), seen = new Map();
	const end = Date.parse(week + 'T00:00:00Z'), start = end - 6 * 86400000;
	let nationalRows = 0;
	for (const row of data.content) {
		if (!allowed.has(row.Filter)) continue;
		const date = String(row.Programme || '').match(/<br\s*\/?\s*>\s*(\d{4}-\d{2}-\d{2})/i)?.[1];
		const aired = Date.parse(date + 'T00:00:00Z');
		// Broadcast days can extend past midnight into the following calendar day.
		if (!Number.isFinite(aired) || aired < start || aired > end + 86400000) throw Error('UK TV data does not match the report week');
		const title = plain(String(row.Programme || '').split(/<br\s*\/?\s*>/i)[0]);
		const audience = Number(plain(row["Total Audience ('000)"]).replace(/,/g, ''));
		const channel = plain(row.Channel), key = normal(title);
		if (!key || title.length > 300 || !channel || channel.length > 100 || !Number.isFinite(audience) || audience <= 0) continue;
		if (row.Filter === 'All TV') nationalRows++;
		const item = {title, channel, audience};
		if (!seen.has(key) || audience > seen.get(key).audience) seen.set(key, item);
	}
	if (nationalRows < 10 || seen.size < 10) throw Error('UK TV chart is incomplete');
	return {week, items:[...seen.values()].sort((a,b) => b.audience - a.audience || a.title.localeCompare(b.title)).slice(0,40).map((item,index) => ({...item,rank:index+1}))};
}

async function bounded(fetcher, url, maximum) {
	const response = await fetcher(url, {redirect:'error',signal:AbortSignal.timeout(15000)});
	if (!response.ok || !response.body) throw Error('UK TV chart unavailable');
	const chunks = []; let size = 0;
	for await (const chunk of response.body) {
		size += chunk.length;
		if (size > maximum) throw Error('UK TV chart too large');
		chunks.push(Buffer.from(chunk));
	}
	return Buffer.concat(chunks).toString('utf8');
}

export async function downloadUkTv(fetcher = fetch) {
	const report = ukTvReport(await bounded(fetcher, ukTvSourceUrl, 2 * 1024 * 1024));
	return ukTvRows(JSON.parse(await bounded(fetcher, report.url, 4 * 1024 * 1024)), report.week);
}
