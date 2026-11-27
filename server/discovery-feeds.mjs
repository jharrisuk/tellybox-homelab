import { stableQueryKey } from './discover-cache.mjs';

const fail = message => Object.assign(new Error(message), { status: 400 });
export function discoveryOrder(type, sort = 'popular') {
	if (!['popular', 'rating', 'release'].includes(sort)) throw fail('Choose a valid sort order.');
	if (sort === 'popular') return { sortBy:'popularity.desc' };
	if (!['movie', 'tv'].includes(type)) throw fail('Choose films or TV shows to sort.');
	if (sort === 'rating') return { sortBy:'vote_average.desc', voteCountGte:'50' };
	return { sortBy:type === 'movie' ? 'primary_release_date.desc' : 'first_air_date.desc',
		[type === 'movie' ? 'primaryReleaseDateLte' : 'firstAirDateLte']:new Date().toISOString().slice(0,10) };
}
export const interests = ['Documentary', 'Crime', 'Comedy', 'Drama', 'Action', 'Adventure', 'Science Fiction', 'Fantasy', 'Family', 'Animation', 'History', 'Mystery', 'Thriller', 'Horror', 'Romance', 'Music'];
const ids = { 99:'Documentary', 80:'Crime', 35:'Comedy', 18:'Drama', 28:'Action', 12:'Adventure', 878:'Science Fiction', 14:'Fantasy', 10751:'Family', 16:'Animation', 36:'History', 9648:'Mystery', 53:'Thriller', 27:'Horror', 10749:'Romance', 10402:'Music', 10759:'Action', 10765:'Science Fiction', 10768:'History' };
const tvIds = { Action:10759, Adventure:10759, 'Science Fiction':10765, Fantasy:10765, History:10768 };
export const providers = [{ id:8, name:'Netflix' }, { id:350, name:'Apple TV' }, { id:337, name:'Disney+' }, { id:9, name:'Prime Video' }, { id:531, name:'Paramount+' }];
export const providerNote = 'UK catalogue, newest film releases and series premieres first. Dates are original releases, not dates added to the service; returning seasons may not appear here.';
export const ukServiceProviders = [{ id:38, name:'BBC iPlayer' }, { id:41, name:'ITVX' }, { id:103, name:'Channel 4' }, { id:333, name:'5' }, { id:39, name:'Now' }];
const DAY = 86400000;
const releaseWindow = (days = 7) => {
	const until = new Date().toISOString().slice(0, 10);
	const since = new Date(Date.now() - days * DAY).toISOString().slice(0, 10);
	return { since, until };
};
export function genreNames(item) {
	return [...new Set([...(item.genreIds || []).flatMap(id => id === 10759 ? ['Action', 'Adventure'] : id === 10765 ? ['Science Fiction', 'Fantasy'] : [ids[id]]), ...(item.genres || []).flatMap(g => { const name = typeof g === 'string' ? g : g.name; return /action & adventure/i.test(name) ? ['Action', 'Adventure'] : /sci-fi & fantasy/i.test(name) ? ['Science Fiction', 'Fantasy'] : [name]; })].map(canonical).filter(Boolean))];
}
export function canonical(value) {
	const aliases = { documentaries:'Documentary', 'sci-fi':'Science Fiction', 'sci-fi & fantasy':'Science Fiction', 'science-fiction':'Science Fiction', 'action & adventure':'Action', 'war & politics':'History', kids:'Family' };
	return typeof value === 'string' ? aliases[value.toLowerCase()] || interests.find(g => g.toLowerCase() === value.toLowerCase()) || null : null;
}
export function preferences(body) {
	if (!body || typeof body !== 'object' || !Array.isArray(body.genres) || body.genres.length > 40 || !Array.isArray(body.exclude) || body.exclude.length > 300) throw fail('Choose a few interests or like some titles first.');
	const weights = new Map();
	for (const entry of body.genres) {
		const name = canonical(entry?.name), weight = entry?.weight;
		if (!name || !Number.isInteger(weight) || weight < -50 || weight > 50) throw fail('Invalid recommendation preferences.');
		weights.set(name, Math.max(-50, Math.min(50, (weights.get(name) || 0) + weight)));
	}
	if (body.exclude.some(id => typeof id !== 'string' || !/^(?:[a-f0-9-]{32,36}|tmdb:(?:movie|tv):[1-9][0-9]{0,9})$/i.test(id))) throw fail('Invalid watched-title list.');
	return { weights, exclude: new Set(body.exclude) };
}
export function rank(items, taste) {
	const seen = new Set(), rows = [];
	for (const item of items) {
		const key = 'tmdb:' + item.type + ':' + item.id;
		if (seen.has(key) || taste.exclude.has(key) || (item.watchId && taste.exclude.has(item.watchId))) continue;
		seen.add(key);
		const matches = (item.genres || []).map(name => ({ name, weight: taste.weights.get(canonical(name)) || 0 })).sort((a,b) => b.weight-a.weight);
		const score = matches.reduce((sum, genre) => sum+genre.weight, 0);
		if (score <= 0) continue;
		rows.push({ ...item, reason:'Because you like ' + matches[0].name.toLowerCase(), score });
	}
	// A single five-star vote should not outrank a well-established favourite.
	const confidence = item => { const rating=item.ratings?.[0]; if(!rating)return 0; const votes=rating.votes || 0; return ((rating.value / (rating.max || 10) * 10) * votes + 6 * 50) / (votes + 50); };
	return rows.sort((a,b) => b.score-a.score || confidence(b)-confidence(a));
}
export function createDiscoveryFeeds({ call, view, enrich, library = async () => [], publicCache = null, origins = null }) {
	const cache = new Map(); let running = 0; const waiters = [];
	// Without a public cache this is the historical behavior: load and enrich
	// per request. With one, sanitized catalogue metadata is shared, while
	// enrichment/availability is still recomputed for every response.
	const read = publicCache?.read || (async (_key, loader) => {
		const data = await loader();
		return { ...data, items: await enrich(data.items || []) };
	});
	// Scope the short-lived raw upstream cache by public source generation, so a
	// dynamic Seerr/config switch can never replay the previous source's rows.
	const generation = () => { try { return publicCache?.generation?.() || ''; } catch { return ''; } };
	async function cached(route) {
		const routeKey = generation() + '\u0000' + route;
		const saved = cache.get(routeKey); if (saved && saved.expires > Date.now()) return saved.promise;
		const promise = (async () => {
			if (running >= 3) await new Promise(resolve => waiters.push(resolve)); else running++;
			try { return await call(route); } finally { const next = waiters.shift(); if (next) next(); else running--; }
		})();
		if (cache.size >= 100) cache.delete(cache.keys().next().value);
		cache.set(routeKey, { expires:Date.now()+180000, promise });
		try { return await promise; } catch (error) { cache.delete(routeKey); throw error; }
	}
	async function catalogue(type, filters) {
		const data = await cached('/discover/' + (type === 'movie' ? 'movies' : 'tv') + '?' + new URLSearchParams(filters));
		return { page:data.page || 1, pages:Math.min(20, data.totalPages || 1), items:(data.results || []).filter(i => !i.adult).map(i => view(i, type)) };
	}
	async function category(name, type = 'movie', page = 1, sort = 'popular', excludeDocumentaries = false) {
		const genre = canonical(name);
		if (!genre || !['movie','tv'].includes(type) || !Number.isInteger(page) || page < 1 || page > 20) throw fail('Choose a valid category.');
		const genreId = type === 'tv' && tvIds[genre] || Number(Object.keys(ids).find(id => ids[id] === genre));
		if (genre === 'Documentary' && excludeDocumentaries) throw fail('Choose documentaries or other genres.');
		// The key is date-independent; discoveryOrder adds the runtime release
		// ceiling inside the loader so yesterday's snapshot stays reusable.
		const key = stableQueryKey('category', { genre, type, page, sort, exclude: excludeDocumentaries ? 1 : 0 });
		return read(key, async () => {
			let cursor = page;
			for (let attempt = 0; attempt < 3; attempt++) {
				const result = await catalogue(type, { page:String(cursor), genre:String(genreId), ...discoveryOrder(type, sort) });
				const items = result.items.filter(item => !excludeDocumentaries || !item.genres.includes('Documentary'));
				if (items.length || !excludeDocumentaries || cursor >= result.pages || attempt === 2) return { ...result, page:cursor, items };
				cursor++;
			}
		});
	}
	// Raw provider rail read. The public cache stores only allowlisted catalogue
	// metadata plus provider/note/page attribution; availability is recomposed.
	function providerKey(id, type, page, genre, sort) {
		return stableQueryKey('provider', { id, type, page, sort, genre:genre || '', region:'GB' });
	}
	async function providerRaw(id, type, page, {genre:name='',sort='release'} = {}) {
		const provider = providers.find(p => p.id === Number(id));
		const genre=name?canonical(name):null;
		const today = new Date().toISOString().slice(0,10);
		const groups = await Promise.all((type === 'all' ? ['movie','tv'] : [type]).map(t => {
			const genreId=genre&&(t==='tv'&&tvIds[genre]||Number(Object.keys(ids).find(id=>ids[id]===genre)));
			return catalogue(t,{page:String(page),watchRegion:'GB',watchProviders:String(provider.id),...(genreId?{genre:String(genreId)}:{}),...discoveryOrder(t,sort),[t==='movie'?'primaryReleaseDateLte':'firstAirDateLte']:today});
		}));
		const seen = new Set();
		const items = groups.flatMap(g => g.items).filter(i => i.date && i.date <= today).filter(i => { const key=i.type+':'+i.id; if(seen.has(key)) return false; seen.add(key); return true; });
		if(type==='all')items.sort((a,b)=>b.date.localeCompare(a.date));
		return { provider, note:providerNote, page, pages:Math.max(...groups.map(g => g.pages)), region:'GB', items };
	}
	async function provider(id, type = 'all', page = 1, {genre:name='',sort='release'} = {}) {
		const provider = providers.find(p => p.id === Number(id));
		if (!provider || !['all','movie','tv'].includes(type) || !Number.isInteger(page) || page<1 || page>20) throw fail('Choose a valid streaming service.');
		const genre=name?canonical(name):null;
		if(name&&!genre)throw fail('Choose a valid category.');
		if(!['release','rating','popular'].includes(sort)||type==='all'&&sort!=='release')throw fail('Choose films or TV shows and a valid sort order.');
		return read(providerKey(provider.id, type, page, genre, sort), () => providerRaw(provider.id, type, page, { genre:name, sort }));
	}
	// New releases in a rolling window. Each shelf is a separate public-cache
	// entry, so one slow service cannot block the others and the daily warmer
	// can preload the whole landing page.
	function mix(groups) {
		const rows = [];
		for (let index = 0; groups.some(group => index < group.length); index++) {
			for (const group of groups) if (index < group.length) rows.push(group[index]);
		}
		return rows;
	}
	async function mapLimit(items, limit, worker) {
		const results = new Array(items.length);
		let cursor = 0;
		const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
			while (cursor < items.length) {
				const index = cursor++;
				try { results[index] = await worker(items[index], index); }
				catch { results[index] = null; }
			}
		});
		await Promise.all(runners);
		return results.filter(Boolean);
	}
	function newWeekDefinitions() {
		const others = providers.filter(provider => provider.id !== 8).map(provider => ({
			id:'service-' + provider.id,
			title:'New on ' + provider.name,
			note:'New releases on ' + provider.name + ' in the UK. Dates are original releases, not the date added to the service.',
			days:7, sort:'popular', providers:[provider.id]
		}));
		return [
			{ id:'all', title:'New this week', note:'Popular films and series released in the last seven days.', days:7, sort:'popular', providers:[] },
			{ id:'top', title:'Top rated this week', note:'The best-rated new releases this week, with at least 10 TMDB votes.', days:7, sort:'rating', votes:10, providers:[] },
			{ id:'netflix', title:'New on Netflix', note:'New releases on Netflix in the UK. Dates are original releases, not the date added to Netflix.', days:7, sort:'popular', providers:[8] },
			{ id:'uk-titles', title:'New UK titles', note:'British films and series released this week, based on TMDB production country.', days:7, uk:true },
			{ id:'uk-services', title:'New on UK services', note:'New releases on BBC iPlayer, ITVX, Channel 4, 5 and Now.', days:7, sort:'popular', providers:ukServiceProviders.map(provider => provider.id) },
			...others
		];
	}
	function newReleaseQuery(def) {
		const providerIds = def.providers || [];
		const provider = providerIds.length === 1
			? providers.find(entry => entry.id === providerIds[0]) || ukServiceProviders.find(entry => entry.id === providerIds[0]) || null
			: null;
		const key = stableQueryKey('new-week', {
			section:def.id, providers:providerIds.join(','), days:def.days || 7,
			sort:def.sort || 'popular', votes:def.votes || 0
		});
		const load = async () => {
			const { since, until } = releaseWindow(def.days || 7);
			const groups = await Promise.all(['movie','tv'].map(type => {
				const order = def.sort === 'rating'
					? { sortBy:'vote_average.desc', voteCountGte:String(def.votes || 10) }
					: { sortBy:'popularity.desc' };
				return catalogue(type, {
					page:'1', ...order,
					...(providerIds.length ? { watchRegion:'GB', watchProviders:providerIds.join('|') } : {}),
					[type === 'movie' ? 'primaryReleaseDateGte' : 'firstAirDateGte']:since,
					[type === 'movie' ? 'primaryReleaseDateLte' : 'firstAirDateLte']:until
				});
			}));
			const seen = new Set();
			const items = mix(groups.map(group => group.items))
				.filter(item => item.date && item.date >= since && item.date <= until)
				.filter(item => { const id = item.type + ':' + item.id; if (seen.has(id)) return false; seen.add(id); return true; });
			if (def.sort === 'rating') {
				const rating = item => Number(item.ratings?.[0]?.value) || 0;
				const votes = item => Number(item.ratings?.[0]?.votes) || 0;
				items.sort((a, b) => rating(b) - rating(a) || votes(b) - votes(a));
			}
			return { provider, note:def.note, region:'GB', items };
		};
		return { key, load, provider };
	}
	async function newReleaseSection(def) {
		const query = newReleaseQuery(def);
		const snapshot = await read(query.key, query.load);
		const { since, until } = releaseWindow(def.days || 7);
		const items = (snapshot.items || [])
			.filter(item => item.date && item.date >= since && item.date <= until)
			.slice(0, 12);
		return { id:def.id, title:def.title, note:snapshot.note || def.note, ...(query.provider ? { provider:query.provider } : {}), since, until, items };
	}
	function ukTitlesQuery(def) {
		const key = stableQueryKey('new-week', { section:'uk-titles', days:def.days || 7 });
		const load = async () => {
			const { since, until } = releaseWindow(def.days || 7);
			const groups = await Promise.all(['movie','tv'].map(type => catalogue(type, {
				page:'1', sortBy:'popularity.desc',
				[type === 'movie' ? 'primaryReleaseDateGte' : 'firstAirDateGte']:since,
				[type === 'movie' ? 'primaryReleaseDateLte' : 'firstAirDateLte']:until
			})));
			const candidates = mix(groups.map(group => group.items))
				.filter(item => item.date && item.date >= since && item.date <= until)
				.slice(0, 40);
			// A slow Seerr must not hold a Discover admission slot for minutes.
			// Stop starting new detail lookups after 15 seconds; already-found
			// UK titles are still returned and the origin cache improves retries.
			const deadline = Date.now() + 15000;
			const items = await mapLimit(candidates, 4, async item => {
				if (Date.now() > deadline) return null;
				const countries = await origins(item.type, item.id);
				return Array.isArray(countries) && countries.includes('GB') ? item : null;
			});
			return { note:def.note, region:'GB', items:items.slice(0, 12) };
		};
		return { key, load };
	}
	async function ukTitlesSection(def) {
		if (typeof origins !== 'function') {
			const { since, until } = releaseWindow(def.days || 7);
			return { id:def.id, title:def.title, note:def.note, since, until, items:[] };
		}
		const query = ukTitlesQuery(def);
		const snapshot = await read(query.key, query.load);
		const { since, until } = releaseWindow(def.days || 7);
		const items = (snapshot.items || [])
			.filter(item => item.date && item.date >= since && item.date <= until)
			.slice(0, 12);
		return { id:def.id, title:def.title, note:snapshot.note || def.note, since, until, items };
	}
	// New releases in the last seven days, optionally for one streaming service.
	async function newThisWeek(providerId = null) {
		if (providerId != null) {
			const provider = providers.find(entry => entry.id === Number(providerId)) || ukServiceProviders.find(entry => entry.id === Number(providerId));
			if (!provider) throw fail('Choose a valid streaming service.');
			const def = newWeekDefinitions().find(entry => (entry.providers || []).length === 1 && entry.providers[0] === provider.id)
				|| { id:'service-' + provider.id, title:'New on ' + provider.name, note:'New releases on ' + provider.name + ' in the UK. Dates are original releases, not the date added to the service.', days:7, sort:'popular', providers:[provider.id] };
			const section = await newReleaseSection(def);
			return { provider:section.provider, since:section.since, until:section.until, note:section.note, items:section.items };
		}
		const defs = newWeekDefinitions(), sections = [];
		let partial = false;
		for (let offset = 0; offset < defs.length; offset += 3) {
			const rows = await Promise.allSettled(defs.slice(offset, offset + 3).map(def => def.uk ? ukTitlesSection(def) : newReleaseSection(def)));
			for (const row of rows) {
				if (row.status === 'fulfilled') sections.push(row.value);
				else partial = true;
			}
		}
		if (!sections.length) throw Object.assign(new Error('New releases are unavailable just now. Please try again shortly.'), { status:503 });
		const { since, until } = releaseWindow(7);
		return { region:'GB', since, until, partial, sections };
	}
	function newWeekWarmers() {
		return newWeekDefinitions().map(def => {
			if (def.uk) return typeof origins === 'function' ? ukTitlesQuery(def) : null;
			return newReleaseQuery(def);
		}).filter(Boolean).map(query => ({ key:query.key, load:query.load }));
	}
	async function forYou(body) {
		const taste = preferences(body), top = [...taste.weights].filter(([,w]) => w>0).sort((a,b)=>b[1]-a[1]).slice(0,3);
		if (!top.length) return { personalized:false, sections:[], interests };
		const tasks = top.flatMap(([genre]) => ['movie','tv'].map(type => {
			const genreId = type === 'tv' && tvIds[genre] || Number(Object.keys(ids).find(id=>ids[id]===genre));
			return catalogue(type, { page:'1', genre:String(genreId), sortBy:'popularity.desc' });
		}));
		const results = await Promise.allSettled([...tasks, library(top.map(([name])=>name))]);
		const libraryResult = results.at(-1);
		const candidates = [...(libraryResult.status === 'fulfilled' ? libraryResult.value : []), ...results.slice(0,-1).flatMap(r=>r.status==='fulfilled' ? r.value.items : [])];
		if (results.every(r=>r.status==='rejected')) throw Object.assign(new Error('Recommendations are unavailable just now. Please try again.'), { status:503 });
		const items = rank(candidates, taste);
		const sections = [
			{ id:'watch', title:'Watch now', items:items.filter(i=>i.watchId).slice(0,12) },
			{ id:'request', title:'Find your next favourite', items:items.filter(i=>!i.watchId && i.requestable && ![2,3,4,5].includes(i.status)).slice(0,12) },
			{ id:'waiting', title:'On the way', items:items.filter(i=>!i.watchId && [2,3,4].includes(i.status)).slice(0,8) }
		];
		return { personalized:true, partial:results.some(r=>r.status==='rejected'), sections:await Promise.all(sections.map(async s=>({...s,items:await enrich(s.items)}))), interests };
	}
	// Five default provider rails plus the fixed new-release shelves. The
	// scheduler must not multiply provider x type x genre x sort x page.
	function discoverWarmers() {
		return [
			...providers.map(provider => ({
				key: providerKey(provider.id, 'all', 1, null, 'release'),
				load: () => providerRaw(provider.id, 'all', 1, { genre:'', sort:'release' })
			})),
			...newWeekWarmers()
		];
	}
	return { provider, newThisWeek, forYou, category, discoverWarmers, newWeekWarmers };
}
