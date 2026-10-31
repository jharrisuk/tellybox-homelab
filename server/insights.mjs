import { readFileSync } from 'node:fs';

export function score(source, value, max = 10, votes = 0, url = null) {
	if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > max) return null;
	return { source, value: Math.round(value * 10) / 10, max, votes: Number.isSafeInteger(votes) && votes > 0 ? votes : 0, url };
}

export function movieRatings(movie) {
	const ratings = movie.ratings || {};
	return [
		score('IMDb', ratings.imdb?.value, 10, ratings.imdb?.votes, /^tt\d+$/.test(movie.imdbId || '') ? `https://www.imdb.com/title/${movie.imdbId}/` : null),
		score('TMDB', ratings.tmdb?.value, 10, ratings.tmdb?.votes, Number.isInteger(movie.tmdbId) ? `https://www.themoviedb.org/movie/${movie.tmdbId}` : null),
		score('Rotten Tomatoes', ratings.rottenTomatoes?.value, 100, ratings.rottenTomatoes?.votes),
		score('Trakt', ratings.trakt?.value, 10, ratings.trakt?.votes)
	].filter(Boolean);
}

function poster(images = []) {
	const source = images.find(i => i.coverType === 'poster')?.remoteUrl;
	try {
		const url = new URL(source);
		if (url.protocol !== 'https:' || !['image.tmdb.org', 'artworks.thetvdb.com'].includes(url.hostname) || url.username || url.password || url.port) return null;
		url.search = ''; url.hash = '';
		return url.href;
	} catch { return null; }
}

export function upcomingMovies(movies, now = Date.now()) {
	const end = now + 90 * 86400000;
	const start = new Date(now).setUTCHours(0, 0, 0, 0);
	return movies.filter(m => m.monitored && !m.hasFile).flatMap(m => {
		const releases = [['digitalRelease', 'Digital release'], ['physicalRelease', 'Disc release']]
			.map(([key, label]) => ({ date: m[key], time: Date.parse(m[key]), label }))
			.filter(r => r.time >= start && r.time <= end).sort((a, b) => a.time - b.time);
		let release = releases[0];
		const cinema = Date.parse(m.inCinemas);
		if (!release && cinema >= start && cinema <= end && m.status !== 'released') release = { date: m.inCinemas, label: 'Cinema release' };
		if (!release && !['announced', 'inCinemas'].includes(m.status)) return [];
		if (!release && [m.digitalRelease, m.physicalRelease, m.inCinemas].some(d => Date.parse(d) > end)) return [];
		return [{ type: 'movie', id: m.tmdbId, title: m.title, overview: m.overview || '', poster: poster(m.images),
			date: release?.date || null, dateLabel: release?.label || 'Home release date to be announced', ratings: movieRatings(m) }];
	}).sort((a, b) => (Date.parse(a.date) || Infinity) - (Date.parse(b.date) || Infinity));
}

export function upcomingSeries(episodes, now = Date.now()) {
	const series = new Map();
	const sorted = episodes.filter(e => e.monitored && e.series?.monitored && !e.hasFile && e.seasonNumber > 0
		&& Date.parse(e.airDateUtc) >= now && Date.parse(e.airDateUtc) <= now + 90 * 86400000)
		.sort((a, b) => Date.parse(a.airDateUtc) - Date.parse(b.airDateUtc));
	for (const episode of sorted) {
		let item = series.get(episode.seriesId);
		if (!item) {
			const s = episode.series;
			item = { type: 'tv', id: s.tmdbId || null, title: s.title, overview: s.overview || '', poster: poster(s.images),
				date: episode.airDateUtc, dateLabel: episode.episodeNumber === 1 ? `Season ${episode.seasonNumber} begins` : 'Next episode airs',
				episode: `S${String(episode.seasonNumber).padStart(2, '0')} · E${String(episode.episodeNumber).padStart(2, '0')}`,
				episodeTitle: episode.title, episodes: [], ratings: [] };
			series.set(episode.seriesId, item);
		}
		if (item.episodes.length < 5) item.episodes.push({ title: episode.title, season: episode.seasonNumber, number: episode.episodeNumber, date: episode.airDateUtc });
	}
	return [...series.values()];
}

export function createInsights({ config, fetcher = fetch, clock = Date.now }) {
	const cache = new Map();
	async function cached(key, loader) {
		let entry = cache.get(key);
		if (entry && clock() < entry.expires) return entry.promise;
		entry = { expires: clock() + 300000, promise: null };
		entry.promise = loader().catch(() => { entry.expires = clock() + 30000; return null; });
		cache.set(key, entry);
		return entry.promise;
	}
	async function get(kind, route) {
		const service = config()?.[kind];
		if (!service?.url || !service.key) throw new Error('Not connected');
		const response = await fetcher(new URL('/api/v3/' + route, service.url), { headers: { 'X-Api-Key': service.key }, signal: AbortSignal.timeout(8000), redirect: 'error' });
		if (!response.ok) throw new Error('Service unavailable');
		const data = await response.json();
		if (!Array.isArray(data)) throw new Error('Invalid service response');
		return data;
	}
	const movies = () => cached('movies', () => get('radarr', 'movie'));
	async function ratings() {
		return new Map((await movies() || []).map(m => [String(m.tmdbId), movieRatings(m)]));
	}
	async function enrich(items) {
		if (!items.some(i => i.type === 'movie')) return items;
		const scores = await ratings();
		return items.map(i => ({ ...i, ratings: i.type === 'movie' && scores.get(String(i.id))?.length ? scores.get(String(i.id)) : i.ratings || [] }));
	}
	async function upcoming() {
		const now = clock();
		const [films, episodes] = await Promise.all([
			movies(),
			cached('calendar', () => get('sonarr', `calendar?start=${new Date(now).toISOString().slice(0, 10)}&end=${new Date(now + 90 * 86400000).toISOString().slice(0, 10)}&includeSeries=true&unmonitored=false`))
		]);
		return { tv: upcomingSeries(episodes || [], now), movies: upcomingMovies(films || [], now),
			unavailable: [...(films ? [] : ['films']), ...(episodes ? [] : ['tv'])], checkedAt: new Date(now).toISOString() };
	}
	async function recentEpisodeDates() {
		const now=clock();
		const rows=await cached('recent-calendar',()=>get('sonarr',`calendar?start=${new Date(now-90*86400000).toISOString().slice(0,10)}&end=${new Date(now+86400000).toISOString().slice(0,10)}&includeSeries=true&unmonitored=true`));
		return (rows||[]).map(e=>({series:e.series?.title,seriesId:e.seriesId,season:e.seasonNumber,episode:e.episodeNumber,date:e.airDateUtc}));
	}
	return { ratings, enrich, upcoming, recentEpisodeDates };
}

export function insightsFromFile(configPath) {
	return createInsights({ config: () => { try { return JSON.parse(readFileSync(configPath, 'utf8')); } catch { return null; } } });
}
