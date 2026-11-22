import { readFileSync } from 'node:fs';

const DAY = 86400000;
// Bound on how far back "Coming soon" looks. It is deliberately small so the
// release calendar can show what has just arrived as well as what is next.
export const RECENT_RELEASE_DAYS = 7;
// The forward bound matches the calendar: one week ahead.
export const UPCOMING_RELEASE_DAYS = 7;

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

function libraryKey(type, id) { return `${type === 'tv' ? 'tv' : 'movie'}:${id}`; }

// A no-library result keeps the old shape. A TV match may also be an object
// ({ id, type: 'episode' }) when the exact scheduled episode was resolved; a
// plain id still means the series for television and the film for movies.
function libraryMatch(item, value) {
	const id = value !== null && typeof value === 'object' ? value.id : value;
	if (!id) return null;
	const type = value !== null && typeof value === 'object' && value.type === 'episode'
		? 'episode' : item.type === 'tv' ? 'series' : 'movie';
	return { id: String(id), type };
}

// `matches` is a Map (or plain object) of "movie:<tmdb>" / "tv:<tmdb>" to the
// id of the same title in the local library. It is built from catalogue data
// that the server already holds; no extra lookup happens here.
export function attachLibrary(items, matches) {
	if (!matches || !items?.length) return items;
	const lookup = key => matches instanceof Map ? matches.get(key) : matches[key];
	return items.map(item => {
		const id = item?.id === null || item?.id === undefined ? null : lookup(libraryKey(item.type, item.id));
		const library = id ? libraryMatch(item, id) : null;
		if (!library) return item;
		return { ...item, library };
	});
}

function startOfUtcDay(now) { return new Date(now).setUTCHours(0, 0, 0, 0); }

function isReleased(time, now) {
	if (!Number.isFinite(time)) return false;
	// Film dates are whole UTC days. Treat anything before the current UTC day
	// as released so a film dated today still reads as "arriving today".
	return time < startOfUtcDay(now);
}

export function upcomingMovies(movies, now = Date.now(), matches = null) {
	const end = now + UPCOMING_RELEASE_DAYS * DAY;
	const start = now - RECENT_RELEASE_DAYS * DAY;
	const items = movies.filter(m => m.monitored).flatMap(m => {
		const releases = [['digitalRelease', 'Digital release'], ['physicalRelease', 'Disc release']]
			.map(([key, label]) => ({ date: m[key], time: Date.parse(m[key]), label }))
			.filter(r => r.time >= start && r.time <= end).sort((a, b) => a.time - b.time);
		let release = releases[0];
		const cinema = Date.parse(m.inCinemas);
		if (!release && cinema >= start && cinema <= end && m.status !== 'released') release = { date: m.inCinemas, time: cinema, label: 'Cinema release' };
		if (!release) {
			// An owned film only belongs here when it has a dated release inside
			// the window; otherwise every old film in the library would appear.
			if (m.hasFile) return [];
			if (!['announced', 'inCinemas'].includes(m.status)) return [];
			if ([m.digitalRelease, m.physicalRelease, m.inCinemas].some(d => Date.parse(d) > end)) return [];
		}
		const released = Boolean(release && isReleased(release.time, now));
		// An owned film joins only the recent part of the window. Its future
		// announcements are not useful to a viewer who can already watch it.
		if (m.hasFile && !released) return [];
		return [{ type: 'movie', id: m.tmdbId, title: m.title, overview: m.overview || '', poster: poster(m.images),
			date: release?.date || null, dateLabel: released ? 'Released' : release?.label || 'Home release date to be announced',
			released, ratings: movieRatings(m) }];
	}).sort((a, b) => (Date.parse(a.date) || Infinity) - (Date.parse(b.date) || Infinity));
	return attachLibrary(items, matches);
}

export function upcomingSeries(episodes, now = Date.now(), matches = null) {
	const end = now + UPCOMING_RELEASE_DAYS * DAY;
	const start = now - RECENT_RELEASE_DAYS * DAY;
	const grouped = new Map();
	const sorted = episodes.filter(e => e.monitored && e.series?.monitored && e.seasonNumber > 0
		// Aired episodes are allowed even when they are already in the library so
		// the recent window can link back to the owned copy. Future episodes stay
		// limited to the ones still missing.
		&& (!e.hasFile || Date.parse(e.airDateUtc) < now)
		&& Date.parse(e.airDateUtc) >= start && Date.parse(e.airDateUtc) <= end)
		.sort((a, b) => Date.parse(a.airDateUtc) - Date.parse(b.airDateUtc));
	for (const episode of sorted) {
		const list = grouped.get(episode.seriesId);
		if (list) list.push(episode);
		else grouped.set(episode.seriesId, [episode]);
	}
	const items = [...grouped.values()].map(upcoming => {
		const series = upcoming[0].series;
		// Prefer the next episode when the show is still running; otherwise show
		// the most recent episode that has already aired.
		const next = upcoming.find(e => Date.parse(e.airDateUtc) >= now);
		const chosen = next || upcoming[upcoming.length - 1];
		const future = upcoming.filter(e => Date.parse(e.airDateUtc) >= now);
		const aired = upcoming.filter(e => Date.parse(e.airDateUtc) < now);
		// Keep the next five episodes and the two most recently aired ones. The
		// calendar expands this list, so a running show then appears in both
		// "Recently released" and "Next 7 days" without a second series item.
		const listed = (future.length ? [...future.slice(0, 5), ...aired.slice(-2)] : aired.slice(-5))
			.sort((a, b) => Date.parse(a.airDateUtc) - Date.parse(b.airDateUtc));
		return { type: 'tv', id: series.tmdbId || null, title: series.title, overview: series.overview || '', poster: poster(series.images),
			date: chosen.airDateUtc,
			// The card stands for this one episode, so keep its identity beyond the
			// bounded history below. The library link uses it to open that episode
			// instead of the series (and therefore episode one).
			seasonNumber: chosen.seasonNumber, episodeNumber: chosen.episodeNumber,
			dateLabel: next ? (chosen.episodeNumber === 1 ? `Season ${chosen.seasonNumber} begins` : 'Next episode airs') : 'Aired',
			released: !next && isReleased(Date.parse(chosen.airDateUtc), now),
			episode: `S${String(chosen.seasonNumber).padStart(2, '0')} · E${String(chosen.episodeNumber).padStart(2, '0')}`,
			episodeTitle: chosen.title, ratings: [],
			episodes: listed.map(e => ({ title: e.title, season: e.seasonNumber, number: e.episodeNumber, date: e.airDateUtc })) };
	});
	return attachLibrary(items, matches);
}

export function createInsights({ config, fetcher = fetch, clock = Date.now, library = null }) {
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
	// Detailed views pay for a Radarr lookup when a film is not in the local
	// library, so IMDb and (when supplied) Rotten Tomatoes can appear. Browse
	// pages never trigger a burst of lookups; one entry is a detail request.
	const lookupCache = new Map();
	async function lookupRatings(items) {
		const now = clock(), found = new Map();
		await Promise.all(items.map(async item => {
			const key = String(item.id), cached = lookupCache.get(key);
			if (cached && now - cached.at < 6 * 3600000) { found.set(key, cached.ratings); return; }
			try {
				const data = await get('radarr', 'movie/lookup?term=' + encodeURIComponent('tmdb:' + key));
				const match = Array.isArray(data) ? data[0] : null;
				const scores = match ? movieRatings(match) : [];
				lookupCache.set(key, { at: now, ratings: scores });
				if (scores.length) found.set(key, scores);
			} catch { /* keep the catalogue rating */ }
		}));
		return found;
	}
	async function enrich(items) {
		if (!items.some(i => i.type === 'movie')) return items;
		const scores = await ratings();
		const missing = items.length === 1 ? items.filter(i => i.type === 'movie' && i.id && !scores.get(String(i.id))?.length) : [];
		const looked = missing.length ? await lookupRatings(missing) : new Map();
		return items.map(i => {
			if (i.type !== 'movie') return { ...i, ratings: i.ratings || [] };
			const base = scores.get(String(i.id))?.length ? scores.get(String(i.id)) : i.ratings || [];
			const extra = looked.get(String(i.id)) || [];
			const merged = [...base];
			for (const rating of extra) if (!merged.some(existing => existing.source === rating.source)) merged.push(rating);
			return { ...i, ratings: merged };
		});
	}
	async function libraryMatches(items) {
		if (!library || !items.length) return null;
		try { return await library(items); } catch { return null; }
	}
	async function upcoming() {
		const now = clock();
		const [films, episodes] = await Promise.all([
			movies(),
			cached('calendar', () => get('sonarr', `calendar?start=${new Date(now - RECENT_RELEASE_DAYS * DAY).toISOString().slice(0, 10)}&end=${new Date(now + UPCOMING_RELEASE_DAYS * DAY).toISOString().slice(0, 10)}&includeSeries=true&unmonitored=false`))
		]);
		const tv = upcomingSeries(episodes || [], now);
		const movieItems = upcomingMovies(films || [], now);
		const matches = await libraryMatches([...tv, ...movieItems]);
		return { tv: attachLibrary(tv, matches), movies: attachLibrary(movieItems, matches),
			unavailable: [...(films ? [] : ['films']), ...(episodes ? [] : ['tv'])], checkedAt: new Date(now).toISOString() };
	}
	async function recentEpisodeDates() {
		const now=clock();
		const rows=await cached('recent-calendar',()=>get('sonarr',`calendar?start=${new Date(now-90*86400000).toISOString().slice(0,10)}&end=${new Date(now+86400000).toISOString().slice(0,10)}&includeSeries=true&unmonitored=true`));
		return (rows||[]).map(e=>({series:e.series?.title,seriesId:e.seriesId,season:e.seasonNumber,episode:e.episodeNumber,date:e.airDateUtc}));
	}
	return { ratings, enrich, upcoming, recentEpisodeDates };
}

export function insightsFromFile(configPath, options = {}) {
	return createInsights({ ...options, config: () => { try { return JSON.parse(readFileSync(configPath, 'utf8')); } catch { return null; } } });
}
