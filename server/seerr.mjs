import { createTrending, trendingGroups, trendingNote } from './trending.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { score } from './insights.mjs';
import { createDiscoveryFeeds, discoveryOrder, genreNames, providers, interests, providerNote } from './discovery-feeds.mjs';

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const validType = value => ['movie', 'tv'].includes(value);
const validId = value => Number.isSafeInteger(Number(value)) && Number(value) > 0 && Number(value) <= 2147483647;
const activeRequests = media => (media?.requests || []).filter(r => !r.is4k && [1, 2, 5].includes(r.status));
const labels = { 1: 'Not requested', 2: 'Awaiting approval', 3: 'Requested', 4: 'Partly available', 5: 'Available', 6: 'Not available' };

export function mediaView(item, type = item.mediaType) {
	const media = item.mediaInfo || {};
	const active = activeRequests(media);
	let status = media.status || 1;
	if (status < 2 && active.length) status = active.some(r => r.status === 1) ? 2 : 3;
	const failed = (media.requests || []).some(r => !r.is4k && r.status === 4);
	return {
		id: item.id, type, genres: genreNames(item), title: String(item.title || item.name || 'Untitled').slice(0, 500),
		overview: String(item.overview || '').slice(0, 6000),
		poster: /^\/[a-zA-Z0-9_-]+\.(jpg|png|webp)$/.test(item.posterPath || '') ? item.posterPath : null,
		date: String(item.releaseDate || item.firstAirDate || '').slice(0, 10),
		ratings: [score('TMDB', item.voteAverage, 10, item.voteCount, Number.isInteger(item.id) && validType(type) ? `https://www.themoviedb.org/${type}/${item.id}` : null)].filter(Boolean),
		status, statusLabel: failed && status < 4 ? 'Needs attention' : labels[status] || 'Not requested',
		watchId: /^[a-f0-9-]{32,36}$/i.test(media.jellyfinMediaId || '') ? media.jellyfinMediaId : null,
		requestable: type === 'tv' || (!active.length && ![2, 3, 4, 5].includes(status) && !failed),
		seasons: (item.seasons || []).filter(s => Number.isInteger(s.seasonNumber) && s.seasonNumber >= 0).map(s => {
			const available = (media.seasons || []).find(m => m.seasonNumber === s.seasonNumber);
			const requested = active.some(r => (r.seasons || []).some(rs => rs.seasonNumber === s.seasonNumber));
			const seasonStatus = available?.status || (requested ? 3 : 1);
			return { number: s.seasonNumber, name: s.name || `Season ${s.seasonNumber}`, episodes: s.episodeCount || 0,
				status: seasonStatus, statusLabel: labels[seasonStatus] || 'Not requested',
				requestable: s.episodeCount > 0 && !requested && ![2, 3, 5].includes(seasonStatus) };
		})
	};
}

export function createSeerr({ config, fetcher = fetch, audit = () => {}, enrich = async items => items, library, trendingCachePath }) {
	const locks = new Map();
	const metadata = new Map();
	async function call(route, body) {
		const c = config();
		if (!c?.key || !c.url) throw fail('Discovery is not connected to Seerr yet.', 503);
		let response;
		try {
			response = await fetcher(new URL('/api/v1' + route, c.url), {
				method: body ? 'POST' : 'GET', headers: { 'X-Api-Key': c.key, 'Content-Type': 'application/json' },
				body: body ? JSON.stringify(body) : undefined, redirect: 'error', signal: AbortSignal.timeout(25000)
			});
		} catch { throw fail('Seerr is not responding. Please try again shortly.', 503); }
		if (!response.ok) throw fail(response.status === 409 ? 'This title has already been requested. Refresh its details.' : 'Seerr could not complete this action. Please refresh and try again.', response.status === 409 ? 409 : 502);
		try { return await response.json(); } catch { throw fail('Seerr returned an invalid response.', 502); }
	}
	function identify(type, id) {
		if (!validType(type) || !validId(id)) throw fail('Choose a valid film or TV show.');
		return `${type}/${Number(id)}`;
	}
	async function details(type, id) {
		const item = mediaView(await call('/' + identify(type, id)), type);
		if (!config()?.specials) for (const season of item.seasons) {
			if (season.number === 0 && season.requestable) { season.requestable = false; season.statusLabel = 'Specials disabled in Seerr'; }
		}
		return (await enrich([item]))[0];
	}
	async function browse(query = '', page = 1, type = 'all', sort = 'popular', excludeDocumentaries = false) {
		if (typeof query !== 'string' || query.length > 200 || !Number.isInteger(page) || page < 1 || page > 100 || !['all', 'movie', 'tv'].includes(type)) throw fail('Invalid search.');
		const searching = Boolean(query.trim());
		const order = discoveryOrder(type, sort);
		if (searching && sort !== 'popular') throw fail('Search results are ordered by relevance. Clear the search to browse by rating or date.');
		const catalogue = { all: 'trending', movie: 'movies', tv: 'tv' }[type];
		// Seerr search is mixed. Skip empty filtered pages, with bounded upstream work.
		for (let attempt = 0; attempt < 3; attempt++) {
			const data = await call(searching ? `/search?query=${encodeURIComponent(query.trim())}&page=${page}` : `/discover/${catalogue}?page=${page}${sort === 'popular' ? '' : '&' + new URLSearchParams(order)}`);
			const pages = Math.min(data.totalPages || 1, 100);
			const items = (data.results || []).filter(i => validType(i.mediaType) && (type === 'all' || i.mediaType === type)).map(i => mediaView(i)).filter(i => !excludeDocumentaries || !i.genres.includes('Documentary'));
			if (items.length || (!searching && !excludeDocumentaries) || page >= pages || attempt === 2) return { page, pages, items: await enrich(items) };
			page++;
		}
	}
	async function requests(page = 1) {
		if (!Number.isInteger(page) || page < 1 || page > 100) throw fail('Invalid page.');
		const data = await call(`/request?take=20&skip=${(page - 1) * 20}&sort=added&filter=all`);
		const rows = (data.results || []).filter(r => !r.is4k && validType(r.type) && validId(r.media?.tmdbId));
		const items = [];
		// Small batches and a bounded metadata cache avoid a burst of upstream detail calls.
		for (let offset = 0; offset < rows.length; offset += 4) {
			items.push(...await Promise.all(rows.slice(offset, offset + 4).map(async r => {
				const key = identify(r.type, r.media.tmdbId);
				let cached = metadata.get(key);
				if (!cached || Date.now() - cached.time > 3600000) {
					try {
						const item = mediaView(await call('/' + key), r.type);
						cached = { item, time: Date.now() };
						if (metadata.size >= 200) metadata.delete(metadata.keys().next().value);
						metadata.set(key, cached);
					} catch { cached = { item: { title: `${r.type === 'tv' ? 'TV show' : 'Film'} #${r.media.tmdbId}` } }; }
				}
				const item = mediaView({ id: r.media.tmdbId, title: cached.item.title, posterPath: cached.item.poster, mediaInfo: r.media }, r.type);
				const requestLabel = { 1: 'Awaiting approval', 2: 'Requested', 3: 'Declined', 4: 'Needs attention', 5: 'Available' }[r.status];
				return { ...item, requestId: r.id, statusLabel: r.media.status === 5 ? 'Available' : requestLabel || item.statusLabel,
					created: r.createdAt, requestedSeasons: (r.seasons || []).map(s => s.seasonNumber).filter(Number.isInteger) };
			})));
		}
		return { page, pages: Math.min(data.pageInfo?.pages || 1, 100), items: await enrich(items) };
	}
	async function request(body, viewer) {
		if (!body || Object.keys(body).some(k => !['type', 'id', 'seasons'].includes(k))) throw fail('Invalid request fields.');
		const key = identify(body.type, body.id);
		// Serialize a title so simultaneous guests cannot create duplicate requests.
		while (locks.has(key)) await locks.get(key).catch(() => {});
		const pending = (async () => {
			const item = await details(body.type, body.id);
			let seasons;
			if (body.type === 'tv') {
				if (!Array.isArray(body.seasons) || !body.seasons.length || body.seasons.length > 100 || body.seasons.some(n => !Number.isInteger(n) || !item.seasons.some(s => s.number === n))) throw fail('Select valid seasons to request.');
				seasons = [...new Set(body.seasons)].filter(n => item.seasons.some(s => s.number === n && s.requestable));
				if (!seasons.length) return { item, created: false, message: 'Those seasons are already tracked or cannot be requested with the current Seerr settings.' };
			} else if (!item.requestable) return { item, created: false, message: `This film is already tracked: ${item.statusLabel.toLowerCase()}.` };
			const service = config()[body.type === 'movie' ? 'radarr' : 'sonarr'];
			if (!service || !Number.isInteger(service.serverId) || !Number.isInteger(service.profileId) || !service.rootFolder) throw fail('The request service needs configuration.', 503);
			const result = await call('/request', { mediaType: body.type, mediaId: Number(body.id), is4k: false, ...service, ...(seasons ? { seasons } : {}) });
			const statusLabel = { 1: 'Awaiting approval', 2: 'Requested', 3: 'Declined', 4: 'Needs attention', 5: 'Available' }[result.status] || 'Requested';
			audit('media_request', viewer, { title: item.title, mediaType: body.type, mediaId: Number(body.id), seasons: seasons || [], state: statusLabel.toLowerCase() });
			// Status comes from Seerr; do not claim a download has started when it is only queued.
			return { created: true, item: { ...item, statusLabel },
				message: result.status === 1 ? 'Added to the list, awaiting approval.' : [3, 4].includes(result.status) ? 'Saved, but this title needs attention from the host.' : 'Added to the list. We’ll look for a suitable release and make it available here when it’s ready.' };
		})();
		locks.set(key, pending);
		try { return await pending; } finally { if (locks.get(key) === pending) locks.delete(key); }
	}
	const feeds = createDiscoveryFeeds({ call, view:mediaView, enrich, library });
	return { browse, details, requests, request, channelSearch:async query=>(await call('/search?query='+encodeURIComponent(query)+'&page=1')).results||[], catalogueMetadata:(type,id)=>call('/'+identify(type,id)), ...feeds, ...createTrending({call,view:mediaView,enrich,cachePath:trendingCachePath}) };
}

export function installSeerr(app, { configPath, audit, enrich, library }) {
	const config = () => { try { return JSON.parse(readFileSync(configPath, 'utf8')); } catch { return null; } };
	const service = createSeerr({ config, audit, enrich, library, trendingCachePath:process.env.TRENDING_CACHE_PATH || '/auth/trending-cache.json' });
	app.use('/api/discover', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
	app.get('/api/discover', async (req, res) => res.json(req.query.genre ? await service.category(req.query.genre, req.query.type || 'movie', Number(req.query.page || 1), req.query.sort || 'popular', req.query.excludeDocumentaries === 'true') : await service.browse(req.query.q || '', Number(req.query.page || 1), req.query.type || 'all', req.query.sort || 'popular', req.query.excludeDocumentaries === 'true')));
	app.get('/api/discover/trending', (req,res)=>res.json({groups:trendingGroups,note:trendingNote}));
	app.get('/api/discover/trending/:key', async(req,res)=>res.json(await service.trending(req.params.key)));
	app.get('/api/discover/options', (req, res) => res.json({ providers, interests, region:'GB', note:providerNote }));
	app.get('/api/discover/provider/:id', async (req, res) => res.json(await service.provider(req.params.id, req.query.type || 'all', Number(req.query.page || 1), {genre:req.query.genre||'',sort:req.query.sort||'release'})));
	app.post('/api/discover/for-you', async (req, res) => {
		if (!req.is('application/json') || !req.get('origin') || ![req.jserverOrigin, process.env.PUBLIC_ORIGIN].includes(req.get('origin'))) return res.sendStatus(403);
		res.json(await service.forYou(req.body));
	});
	app.get('/api/discover/requests', async (req, res) => res.json(await service.requests(Number(req.query.page || 1))));
	app.get('/api/discover/:type/:id', async (req, res) => res.json(await service.details(req.params.type, req.params.id)));
	app.post('/api/discover/request', async (req, res) => {
		if (!req.is('application/json') || !req.headers.origin || ![req.jserverOrigin, process.env.PUBLIC_ORIGIN].includes(req.headers.origin)) return res.status(403).json({ error: 'Requests must be made from jServer.' });
		res.json(await service.request(req.body, req.jserverViewer));
	});
	app.get('/discover', (req, res) => res.sendFile(fileURLToPath(new URL('./public/discover.html', import.meta.url))));
	return service;
}
