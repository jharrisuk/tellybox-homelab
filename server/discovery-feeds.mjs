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
export function createDiscoveryFeeds({ call, view, enrich, library = async () => [] }) {
	const cache = new Map(); let running = 0; const waiters = [];
	async function cached(route) {
		const saved = cache.get(route); if (saved && saved.expires > Date.now()) return saved.promise;
		const promise = (async () => {
			if (running >= 3) await new Promise(resolve => waiters.push(resolve)); else running++;
			try { return await call(route); } finally { const next = waiters.shift(); if (next) next(); else running--; }
		})();
		if (cache.size >= 100) cache.delete(cache.keys().next().value);
		cache.set(route, { expires:Date.now()+180000, promise });
		try { return await promise; } catch (error) { cache.delete(route); throw error; }
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
		for (let attempt = 0; attempt < 3; attempt++) {
			const result = await catalogue(type, { page:String(page), genre:String(genreId), ...discoveryOrder(type, sort) });
			const items = result.items.filter(item => !excludeDocumentaries || !item.genres.includes('Documentary'));
			if (items.length || !excludeDocumentaries || page >= result.pages || attempt === 2) return { ...result, page, items:await enrich(items) };
			page++;
		}
	}
	async function provider(id, type = 'all', page = 1, {genre:name='',sort='release'} = {}) {
		const provider = providers.find(p => p.id === Number(id));
		if (!provider || !['all','movie','tv'].includes(type) || !Number.isInteger(page) || page<1 || page>20) throw fail('Choose a valid streaming service.');
		const genre=name?canonical(name):null;
		if(name&&!genre)throw fail('Choose a valid category.');
		if(!['release','rating','popular'].includes(sort)||type==='all'&&sort!=='release')throw fail('Choose films or TV shows and a valid sort order.');
		const today = new Date().toISOString().slice(0,10);
		const groups = await Promise.all((type === 'all' ? ['movie','tv'] : [type]).map(t => {
			const genreId=genre&&(t==='tv'&&tvIds[genre]||Number(Object.keys(ids).find(id=>ids[id]===genre)));
			return catalogue(t,{page:String(page),watchRegion:'GB',watchProviders:String(provider.id),...(genreId?{genre:String(genreId)}:{}),...discoveryOrder(t,sort),[t==='movie'?'primaryReleaseDateLte':'firstAirDateLte']:today});
		}));
		const seen = new Set();
		const items = groups.flatMap(g => g.items).filter(i => i.date && i.date <= today).filter(i => { const key=i.type+':'+i.id; if(seen.has(key)) return false; seen.add(key); return true; });
		if(type==='all')items.sort((a,b)=>b.date.localeCompare(a.date));
		return { provider, note:providerNote, page, pages:Math.max(...groups.map(g => g.pages)), items:await enrich(items) };
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
	return { provider, forYou, category };
}
