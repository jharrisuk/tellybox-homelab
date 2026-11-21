/* Tellybox consolidation 121 - web Home/navigation browser regression.
 *
 * Serves the real server/public app (index.html, app.js, style.css, discover
 * and search documents) with a local mocked /api layer that can delay Home,
 * releases and images, then drives the real UI in headless Chrome at desktop
 * (1440x900) and mobile (390x844) sizes. No real stream, provider or
 * production access is used. Evidence is written to
 * outputs/Tellybox-consolidation-121/web/evidence/<label>/ unless EVIDENCE_DIR
 * points at another folder.
 *
 * Scenarios:
 *  - home reveal must not move the content the viewer is reading (no jump);
 *  - Continue watching is the first, prominent rail after the hero;
 *  - a "New episodes of your shows" rail is built from liked shows only and
 *    shows exactly one next episode per show, with Continue winning a show;
 *  - the same title never appears in more than one rail (no stale repeats);
 *  - the featured hero stays on the title the viewer chose across refreshes;
 *  - focus, scroll and history are restored after player Back/Close on the
 *    Home -> series details -> player flow and the Discover handoff;
 *  - the Home request carries only this browser profile's own favourites
 *    (account isolation of the client context) and never secrets.
 *
 * The assertions describe the fixed behaviour; on the previous code the jump,
 * rail-order, new-episodes, duplicate-card and focus checks fail, so a "before"
 * run also serves as the reproduction evidence.
 *
 * If Chrome is unavailable the check prints SKIP and exits 0; it never claims
 * a pass without running the browser.
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const label = (process.env.EVIDENCE_LABEL || 'run').replace(/[^A-Za-z0-9._-]/g, '_');
const scenarioFilter = (process.env.SCENARIO_FILTER || '').trim();
const publicDirectory = process.env.PUBLIC_DIR
	? process.env.PUBLIC_DIR.replace(/[\\/]$/, '')
	: fileURLToPath(new URL('../public/', import.meta.url));
const outDir = process.env.EVIDENCE_DIR
	? process.env.EVIDENCE_DIR.replace(/[\\/]$/, '')
	: fileURLToPath(new URL('../../outputs/Tellybox-consolidation-121/web/evidence/' + label + '/', import.meta.url));
mkdirSync(outDir, { recursive: true });

const chromePath = [
	process.env.CHROME_PATH,
	'C:/Program Files/Google/Chrome/Application/chrome.exe',
	'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
	'/usr/bin/google-chrome',
	'/usr/bin/google-chrome-stable',
	'/usr/bin/chromium',
	'/usr/bin/chromium-browser',
	'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean).find(candidate => existsSync(candidate));
if (!chromePath) {
	console.log('SKIP: Chrome or Chromium was not found. Set CHROME_PATH to run the consolidation 121 web browser check.');
	process.exit(0);
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const originPlaceholder = 'http://127.0.0.1';

// ---------------------------------------------------------------------------
// Fixture catalogue
// ---------------------------------------------------------------------------

const continueMovie = {
	Id: 'c1000000-0000-4000-8000-000000000001',
	Name: 'Continue Fixture Film',
	Type: 'Movie',
	Source: 'local',
	ProductionYear: 2024,
	RunTimeTicks: 7200 * 1e7,
	Genres: ['Drama'],
	Overview: 'A fixture film with saved progress.',
	Artwork: '',
	UserData: {},
};
const movie1 = fixtureMovie('c1000000-0000-4000-8000-000000000002', 'Alpha Drama Film', ['Drama']);
const movie2 = fixtureMovie('c1000000-0000-4000-8000-000000000003', 'Beta Comedy Film', ['Comedy']);
const movie3 = fixtureMovie('c1000000-0000-4000-8000-000000000004', 'Gamma Action Film', ['Action']);
const movie4 = fixtureMovie('c1000000-0000-4000-8000-000000000005', 'Delta Family Film', ['Family']);
const movie5 = fixtureMovie('c1000000-0000-4000-8000-000000000006', 'Epsilon History Film', ['History']);
const movie6 = fixtureMovie('c1000000-0000-4000-8000-000000000007', 'Favourite Fixture Film', ['Drama']);

function fixtureMovie(id, name, genres) {
	return {
		Id: id,
		Name: name,
		Type: 'Movie',
		Source: 'local',
		ProductionYear: 2024,
		RunTimeTicks: 7200 * 1e7,
		Genres: genres,
		Overview: 'A fixture film for the consolidation 121 web check.',
		Artwork: '',
		UserData: {},
	};
}

const seriesA = {
	Id: 'd1000000-0000-4000-8000-000000000001',
	Name: 'Liked Show One',
	Type: 'Series',
	Source: 'local',
	ProductionYear: 2023,
	Genres: ['Drama'],
	Overview: 'A fixture series the viewer likes.',
	Artwork: '',
	UserData: {},
};
const seriesB = {
	Id: 'd1000000-0000-4000-8000-000000000002',
	Name: 'Liked Show Two',
	Type: 'Series',
	Source: 'local',
	ProductionYear: 2022,
	Genres: ['Comedy'],
	Overview: 'A fixture series the viewer watches.',
	Artwork: '',
	UserData: {},
};
const seriesC = {
	Id: 'd1000000-0000-4000-8000-000000000003',
	Name: 'Unliked Show Three',
	Type: 'Series',
	Source: 'local',
	ProductionYear: 2021,
	Genres: ['Mystery'],
	Overview: 'A fixture series the viewer never touched.',
	Artwork: '',
	UserData: {},
};
// A local series linked to a streamed provider id through VodIds. The releases
// endpoint may answer with either the local or dispatch-series alias, but both
// rows are one canonical show.
const seriesD = {
	Id: 'd1000000-0000-4000-8000-000000000004',
	Name: 'Aliased Show',
	Type: 'Series',
	Source: 'local',
	ProductionYear: 2024,
	Genres: ['Drama'],
	Overview: 'A fixture series with a provider alias.',
	Artwork: '',
	VodIds: ['777'],
	UserData: {},
};
// Two different shows with the same title. Identity must stay the SeriesId.
const seriesTwinOne = {
	Id: 'd1000000-0000-4000-8000-000000000005',
	Name: 'Same Name Show',
	Type: 'Series',
	Source: 'local',
	ProductionYear: 2024,
	Genres: ['Drama'],
	Overview: 'The first fixture show with a shared title.',
	Artwork: '',
	UserData: {},
};
const seriesTwinTwo = {
	Id: 'd1000000-0000-4000-8000-000000000006',
	Name: 'Same Name Show',
	Type: 'Series',
	Source: 'local',
	ProductionYear: 2024,
	Genres: ['Drama'],
	Overview: 'The second fixture show with a shared title.',
	Artwork: '',
	UserData: {},
};

const episodeA1 = fixtureEpisode('e1000000-0000-4000-8000-000000000001', seriesA, 1, 1, 'The First Course');
const episodeA2 = fixtureEpisode('e1000000-0000-4000-8000-000000000002', seriesA, 1, 2, 'The Second Course');
const episodeB1 = fixtureEpisode('e1000000-0000-4000-8000-000000000003', seriesB, 2, 1, 'A New Beginning');
const episodeC1 = fixtureEpisode('e1000000-0000-4000-8000-000000000004', seriesC, 1, 1, 'Unseen Episode');
// Release-only edges: a special, unaired/future/missing/virtual rows and
// local/streamed duplicates. The client must never turn these into a
// duplicate card or a wrong "next" episode.
const episodeA0 = fixtureEpisode('e1000000-0000-4000-8000-000000000005', seriesA, 0, 1, 'A Special Course');
const episodeA3 = { ...fixtureEpisode('e1000000-0000-4000-8000-000000000006', seriesA, 1, 3, 'The Third Course'), PremiereDate: '2030-01-01T20:00:00.000Z' };
const episodeA4 = { ...fixtureEpisode('e1000000-0000-4000-8000-000000000007', seriesA, 1, 4, 'The Fourth Course'), IsUnaired: true };
const episodeA5 = { ...fixtureEpisode('e1000000-0000-4000-8000-000000000008', seriesA, 1, 5, 'The Missing Course'), IsMissing: true };
const episodeA6 = { ...fixtureEpisode('e1000000-0000-4000-8000-000000000009', seriesA, 1, 6, 'The Virtual Course'), IsVirtualItem: true };
const episodeA1Streamed = { ...fixtureEpisode('e1000000-0000-4000-8000-000000000010', seriesA, 1, 1, 'The First Course'), Source: 'streamed' };
const episodeA2Streamed = { ...fixtureEpisode('e1000000-0000-4000-8000-000000000011', seriesA, 1, 2, 'The Second Course'), Source: 'streamed' };
const episodeD1Local = fixtureEpisode('e1000000-0000-4000-8000-000000000012', seriesD, 1, 1, 'Alias Episode');
const episodeD1Streamed = { ...fixtureEpisode('e1000000-0000-4000-8000-000000000013', seriesD, 1, 1, 'Alias Episode'), SeriesId: 'dispatch-series-777', Source: 'streamed' };
const episodeTwinOne1 = fixtureEpisode('e1000000-0000-4000-8000-000000000014', seriesTwinOne, 1, 1, 'The Shared Title');
const episodeTwinTwo1 = fixtureEpisode('e1000000-0000-4000-8000-000000000015', seriesTwinTwo, 1, 1, 'The Shared Title');

function fixtureEpisode(id, series, season, number, name) {
	return {
		Id: id,
		Name: name,
		Type: 'Episode',
		Source: 'local',
		SeriesId: series.Id,
		SeriesName: series.Name,
		ParentIndexNumber: season,
		IndexNumber: number,
		RunTimeTicks: 2400 * 1e7,
		PremiereDate: '2026-11-01T20:00:00.000Z',
		Overview: 'A fixture episode for the consolidation 121 web check.',
		Artwork: '',
		UserData: {},
	};
}

const collection = [continueMovie, movie1, movie2, movie3, movie4, movie5, movie6, seriesA, seriesB, seriesC, seriesD, seriesTwinOne, seriesTwinTwo];
const itemById = new Map(collection.map(item => [item.Id, item]));
const episodesBySeries = new Map([
	[seriesA.Id, [episodeA1, episodeA2]],
	[seriesB.Id, [episodeB1]],
	[seriesC.Id, [episodeC1]],
]);
const tvReleaseEpisodes = [episodeA1, episodeA2, episodeB1, episodeC1].map(episode => ({ ...episode }));
const releaseEpisodes = [
	episodeA0, episodeA1, episodeA2, episodeA3, episodeA4, episodeA5, episodeA6,
	episodeA1Streamed, episodeA2Streamed, episodeB1, episodeC1,
	episodeD1Local, episodeD1Streamed, episodeTwinOne1, episodeTwinTwo1,
].map(episode => ({ ...episode }));

// ---------------------------------------------------------------------------
// Mock state and control
// ---------------------------------------------------------------------------

const mockState = {
	delays: { homeMs: 0, itemsMs: 0, releasesMs: 0, tvMs: 0, imagesMs: 0, playMs: 0 },
	scramble: false,
	duplicate: false,
	reverseAfter: -1,
	profile: 'basic',
	homeBodies: [],
	homeRequests: 0,
	playRequests: [],
	sessionStops: [],
	notFound: [],
	consoleErrors: [],
	logErrors: [],
};

function continueItemsFor(body) {
	const progress = body?.progress && typeof body.progress === 'object' ? body.progress : {};
	const watched = new Set(Array.isArray(body?.watched) ? body.watched : []);
	const seconds = id => Number(progress[id]) || 0;
	const items = [];
	if (seconds(continueMovie.Id) > 30) items.push(continueMovie);
	for (const episodes of episodesBySeries.values()) {
		for (const episode of episodes) {
			const position = seconds(episode.Id);
			const runtime = Number(episode.RunTimeTicks) / 1e7;
			if (position > 30 && !watched.has(episode.Id) && !(runtime > 0 && position >= runtime - 30)) items.push(episode);
		}
	}
	return items;
}

function orderedHomeRows(body) {
	const resume = continueItemsFor(body);
	const rows = [
		{ id: 'continue', title: 'Continue watching', note: '', items: resume },
		{ id: 'for-you', title: 'Picked for you', note: 'A varied start from the collection', items: [movie1, seriesC, movie2] },
		{ id: 'new', title: 'Recently added', note: 'New in the collection and streamed catalogue', items: [movie3, seriesA] },
		{ id: 'top', title: 'Top rated in your collection', note: '', items: [movie4, movie5] },
	];
	// Mirror the server's account scoping: the Continue watching rail exists only
	// when the caller's own context has resumable progress. A fresh viewer must
	// not see another profile's resume titles.
	if (!resume.length) rows.shift();
	if (mockState.duplicate) {
		const added = rows.find(row => row.id === 'new');
		if (added) added.items = [movie1, movie3, seriesA];
	}
	if (mockState.scramble) return [rows.find(row => row.id === 'for-you'), rows.find(row => row.id === 'new'), rows.find(row => row.id === 'continue'), rows.find(row => row.id === 'top')].filter(Boolean);
	return rows;
}

function featuredItems() {
	const base = [
		{ ...continueMovie, _reason: 'Continue watching' },
		{ ...movie1, _reason: 'Picked for you' },
		{ ...seriesA, _reason: 'Because you like drama' },
	];
	if (mockState.homeRequests > mockState.reverseAfter) return [...base].reverse();
	return base;
}

function homeFeedBody(body) {
	return {
		personalized: true,
		coldStart: false,
		generatedAt: '2026-11-16T09:00:00.000Z',
		rows: orderedHomeRows(body),
		featured: featuredItems(),
		availability: { pending: 0, checked: 0, queued: 0 },
	};
}

// ---------------------------------------------------------------------------
// Local server: real static app + mocked API
// ---------------------------------------------------------------------------

const contentTypes = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.mjs': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.ico': 'image/x-icon',
	'.txt': 'text/plain; charset=utf-8',
};

function readBody(request) {
	return new Promise(resolve => {
		let data = '';
		request.on('data', chunk => { data += chunk; });
		request.on('end', () => {
			if (!data) { resolve(null); return; }
			try { resolve(JSON.parse(data)); } catch { resolve(null); }
		});
	});
}

function sendJson(response, value, status = 200) {
	const body = JSON.stringify(value);
	response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
	response.end(body);
}

function sendEmpty(response, status = 204) {
	response.writeHead(status, { 'Cache-Control': 'no-store' });
	response.end();
}

function posterSvg(id, width, height) {
	return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="100%" height="100%" fill="#1c2418"/><circle cx="${Math.round(width / 2)}" cy="${Math.round(height / 2 - height / 12)}" r="${Math.round(Math.min(width, height) / 4)}" fill="none" stroke="#c4ed80" stroke-width="6"/><text x="${Math.round(width / 2)}" y="${Math.round(height / 2 + height / 3)}" fill="#c4ed80" font-family="Georgia, serif" font-size="${Math.round(Math.min(width, height) / 7)}" text-anchor="middle">${id.slice(0, 8)}</text></svg>`);
}

async function handleApi(url, request, response) {
	const path = url.pathname;
	const method = request.method || 'GET';
	const body = method === 'POST' || method === 'PUT' ? await readBody(request) : null;

	if (path === '/__control/set' && method === 'POST') {
		for (const [key, value] of Object.entries(body || {})) {
			if (key in mockState.delays && Number.isFinite(Number(value))) mockState.delays[key] = Math.max(0, Math.min(10000, Number(value)));
			else if (key === 'scramble') mockState.scramble = Boolean(value);
			else if (key === 'duplicate') mockState.duplicate = Boolean(value);
			else if (key === 'reverseAfter') mockState.reverseAfter = Number.isInteger(value) ? value : -1;
			else if (key === 'profile' && typeof value === 'string' && Object.hasOwn(seedProfiles, value)) mockState.profile = value;
		}
		sendJson(response, { ok: true, delays: mockState.delays });
		return;
	}
	if (path === '/__control/state') {
		sendJson(response, {
			homeRequests: mockState.homeRequests,
			homeBodies: mockState.homeBodies,
			playRequests: mockState.playRequests,
			sessionStops: mockState.sessionStops,
		});
		return;
	}

	if (path === '/api/version') { sendJson(response, { version: '0.26.30' }); return; }
	if (path === '/api/capabilities') { sendJson(response, { canShare: false, playbackDefaults: { englishSubtitles: false, autoNext: false, skipIntros: false } }); return; }
	if (path === '/api/auth/status') {
		// Login-free local viewing: no server account surface, while this
		// browser profile's own favourites and progress remain trusted.
		sendJson(response, { local: true, home: false, person: null, authenticated: false, email: null, localPlayback: null });
		return;
	}
	if (path === '/api/auth/logout') { sendJson(response, { ok: true }); return; }
	if (path === '/api/status') {
		// Coming soon is enabled in this fixture: the real server shows the large
		// teaser, and the landing-order check must prove it stays secondary.
		sendJson(response, { connected: true, features: { discover: true, comingSoon: true, live: false, recordings: false } });
		return;
	}
	if (path === '/api/libraries') {
		sendJson(response, [
			{ Id: 'local-movies', Name: 'Films', CollectionType: 'movies' },
			{ Id: 'local-tv', Name: 'Series', CollectionType: 'tvshows' },
		]);
		return;
	}
	if (path === '/api/viewing-status') { sendJson(response, { blocked: false, remainingSeconds: null }); return; }
	if (path === '/api/favourites' || path === '/api/favourites/home') {
		const profile = seedProfiles[mockState.profile] || seedProfiles.basic;
		const items = profile.favourites.map(item => ({ ...item }));
		sendJson(response, { own: { id: 'me', name: 'My favourites', items } });
		return;
	}

	if (path === '/api/web/items') {
		await sleep(mockState.delays.itemsMs);
		const type = url.searchParams.get('type') || 'all';
		const search = (url.searchParams.get('search') || '').trim().toLowerCase();
		const start = Math.max(0, Number(url.searchParams.get('start')) || 0);
		let items = collection;
		if (type === 'movies') items = items.filter(item => item.Type === 'Movie');
		else if (type === 'tvshows') items = items.filter(item => item.Type === 'Series');
		if (search) items = items.filter(item => item.Name.toLowerCase().includes(search));
		sendJson(response, { items: items.slice(start, start + 30), total: items.length, genres: ['Comedy', 'Drama'], hasMore: false });
		return;
	}

	if (path === '/api/web/home') {
		mockState.homeRequests += 1;
		if (body) mockState.homeBodies.push(body);
		await sleep(mockState.delays.homeMs);
		sendJson(response, homeFeedBody(body));
		return;
	}
	if (path === '/api/web/releases') {
		await sleep(mockState.delays.releasesMs);
		sendJson(response, { items: [movie1] });
		return;
	}
	if (path === '/api/web/releases/tv') {
		await sleep(mockState.delays.tvMs);
		sendJson(response, { items: tvReleaseEpisodes });
		return;
	}
	if (path === '/api/web/releases/episodes') {
		await sleep(mockState.delays.releasesMs);
		const requested = new Set((url.searchParams.get('series') || '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean));
		const items = releaseEpisodes.filter(episode => {
			const source = String(episode.SeriesId || '').toLowerCase();
			if (requested.has(source)) return true;
			// The real endpoint resolves a local series to its provider alias.
			return source === 'dispatch-series-777' && requested.has(seriesD.Id.toLowerCase());
		});
		sendJson(response, { items: items.map(episode => ({ ...episode })) });
		return;
	}
	if (path === '/api/web/similar') { sendJson(response, { items: [], availability: { pending: 0, checked: 0, queued: 0 } }); return; }

	const playTargetMatch = /^\/api\/web\/play-target\/([^/]+)$/.exec(path);
	if (playTargetMatch) {
		const id = decodeURIComponent(playTargetMatch[1]);
		const item = itemById.get(id);
		if (item?.Type === 'Series') {
			const episodes = episodesBySeries.get(id) || [];
			if (!episodes.length) { sendJson(response, { error: 'Everything available in this series has been watched.', code: 'SERIES_COMPLETE' }, 409); return; }
			sendJson(response, { id: episodes[0].Id, type: 'Episode', name: episodes[0].Name, seriesId: id, seriesName: item.Name, position: 0, reason: 'next' });
			return;
		}
		sendJson(response, item || { error: 'Fixture item not found.' }, item ? 200 : 404);
		return;
	}

	const episodesMatch = /^\/api\/web\/items\/([^/]+)\/episodes$/.exec(path);
	if (episodesMatch) {
		const id = decodeURIComponent(episodesMatch[1]);
		sendJson(response, { items: episodesBySeries.get(id) || [], notice: '' });
		return;
	}
	if (/^\/api\/web\/items\/[^/]+\/segments$/.test(path)) { sendJson(response, { segments: [] }); return; }
	if (/^\/api\/web\/items\/[^/]+\/schedule$/.test(path)) { sendJson(response, {}); return; }
	const nextMatch = /^\/api\/web\/items\/([^/]+)\/next$/.exec(path);
	if (nextMatch) { sendJson(response, { status: 'complete' }); return; }
	const itemMatch = /^\/api\/web\/items\/([^/]+)$/.exec(path);
	if (itemMatch) {
		const id = decodeURIComponent(itemMatch[1]);
		const stored = itemById.get(id);
		if (stored) { sendJson(response, stored); return; }
		for (const episodes of episodesBySeries.values()) {
			const episode = episodes.find(entry => entry.Id === id);
			if (episode) { sendJson(response, episode); return; }
		}
		sendJson(response, { error: 'Fixture item not found.' }, 404);
		return;
	}

	if (path === '/api/play') {
		mockState.playRequests.push(body || {});
		await sleep(mockState.delays.playMs);
		sendJson(response, {
			session: 'sess-' + mockState.playRequests.length,
			url: '/media/mock.mp4',
			kind: 'direct',
			method: 'DirectPlay',
			live: false,
			audio: [{ index: 1, label: 'English' }],
			subtitles: [],
			subtitleIndex: -1,
			mediaRoute: 'direct',
		});
		return;
	}
	const sessionMatch = /^\/api\/sessions\/([^/]+)$/.exec(path);
	if (sessionMatch) {
		const action = body?.action || 'progress';
		if (action === 'stop') mockState.sessionStops.push({ session: sessionMatch[1], position: body?.position });
		sendEmpty(response, 204);
		return;
	}
	if (path.startsWith('/api/recording-files/')) { sendJson(response, { IsRecording: false }); return; }

	if (path === '/api/discover') {
		const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
		sendJson(response, {
			items: [
				{
					id: 1,
					type: 'movie',
					title: 'Discover Fixture Film',
					date: '2024-05-01',
					overview: 'A discover result for the consolidation 121 return check.',
					watchId: movie1.Id,
					vodId: movie1.Id,
					vodAvailable: true,
					statusLabel: 'In your library',
					requestable: false,
					ratings: [],
					seasons: [],
					poster: null,
				},
				{
					// The TorrentDay audit confirmed cards can genuinely have both a
					// local copy and a streamed counterpart. This card models the
					// streamed-only side: it must keep the Stream now CTA.
					id: 2,
					type: 'movie',
					title: 'Discover Streamed Only Film',
					date: '2025-02-01',
					overview: 'A streamed-only discover result for the label check.',
					watchId: null,
					vodId: null,
					vodAvailable: true,
					statusLabel: 'Not requested',
					requestable: true,
					ratings: [],
					seasons: [],
					poster: null,
				},
			],
			page,
			pages: 1,
			total: 2,
		});
		return;
	}
	const discoverMatch = /^\/api\/discover\/(movie|tv)\/(\d+)$/.exec(path);
	if (discoverMatch) {
		sendJson(response, {
			id: Number(discoverMatch[2]),
			type: discoverMatch[1],
			title: 'Discover Fixture Film',
			date: '2024-05-01',
			overview: 'A discover result for the consolidation 121 return check.',
			watchId: movie1.Id,
			vodId: movie1.Id,
			vodAvailable: true,
			statusLabel: 'In your library',
			requestable: false,
			ratings: [],
			seasons: [],
			poster: null,
		});
		return;
	}
	if (path === '/api/discover/options') { sendJson(response, { providers: [], note: '', interests: [] }); return; }
	if (path === '/api/discover/request') { sendJson(response, { message: 'Added to the list.', created: true, item: {} }); return; }
	if (path === '/api/discover/trending') { sendJson(response, { groups: [] }); return; }
	if (path === '/api/auth/tunnel') { sendJson(response, {}); return; }

	if (path === '/api/search') {
		const query = (url.searchParams.get('q') || '').trim().toLowerCase();
		const scope = url.searchParams.get('scope') || 'available';
		const start = url.searchParams.has('start')
			? Math.max(0, Number(url.searchParams.get('start')) || 0)
			: 0;
		const items = query
			? collection.filter(item => item.Name.toLowerCase().includes(query) || (item.SeriesName || '').toLowerCase().includes(query)).map(item => ({ ...item }))
			: [];
		sendJson(response, {
			items: scope === 'available' ? items.slice(start, start + 60) : [],
			total: scope === 'available' ? items.length : 0,
			page: 1,
			pages: Math.max(1, Math.ceil((scope === 'available' ? items.length : 0) / 60)),
		});
		return;
	}
	if (path.startsWith('/api/')) { mockState.notFound.push(path); sendJson(response, { error: 'Mock API route not configured: ' + path }, 404); return; }
	mockState.notFound.push(path);
	sendJson(response, { error: 'Mock API route not configured: ' + path }, 404);
}

const htmlRoutes = new Map([
	['/', 'index.html'],
	['/search', 'search.html'],
	['/discover', 'discover.html'],
	['/coming-soon', 'coming-soon.html'],
	['/login', 'login.html'],
	['/settings', 'settings.html'],
]);

const seedProfiles = {
	basic: { favourites: [], watched: [], progress: { [continueMovie.Id]: 1800 } },
	liked: {
		favourites: [seriesA, movie6],
		watched: [],
		progress: { [continueMovie.Id]: 1800 },
		seriesLast: { [seriesB.Id]: episodeB1.Id },
	},
	watched: {
		favourites: [seriesA, movie6],
		watched: [episodeA1.Id],
		progress: { [continueMovie.Id]: 1800 },
		seriesLast: { [seriesB.Id]: episodeB1.Id },
	},
	complete: {
		favourites: [seriesA, movie6],
		watched: [episodeA1.Id, episodeA2.Id],
		progress: { [continueMovie.Id]: 1800 },
		seriesLast: { [seriesB.Id]: episodeB1.Id },
	},
	continue: {
		favourites: [seriesA, movie6],
		watched: [],
		progress: { [continueMovie.Id]: 1800, [episodeA1.Id]: 600 },
		seriesLast: { [seriesB.Id]: episodeB1.Id },
	},
	aliased: {
		favourites: [seriesD, seriesTwinOne, seriesTwinTwo],
		watched: [],
		progress: { [continueMovie.Id]: 1800 },
	},
};

const seedScript = profileName => {
	const profile = seedProfiles[profileName] || seedProfiles.basic;
	const favourites = {};
	for (const item of profile.favourites) {
		favourites[item.Id] = { Id: item.Id, Name: item.Name, Type: item.Type, ...(Array.isArray(item.VodIds) ? { VodIds: item.VodIds } : {}) };
	}
	return `
	try { localStorage.clear(); sessionStorage.clear(); } catch {}
	try {
		localStorage.setItem('tellybox-favourites', ${JSON.stringify(JSON.stringify(favourites))});
		for (const id of ${JSON.stringify(profile.watched)}) localStorage.setItem('tellybox-watched-' + id, 'true');
		for (const [id, seconds] of Object.entries(${JSON.stringify(profile.progress)})) localStorage.setItem('jimbo-progress-' + id, String(seconds));
		for (const [id, episode] of Object.entries(${JSON.stringify(profile.seriesLast || {})})) localStorage.setItem('tellybox-series-' + id, episode);
	} catch {}
	location.replace('/');
`;
};

const server = createServer(async (request, response) => {
	const url = new URL(request.url || '/', originPlaceholder);
	if (url.pathname === '/__seed') {
		const profile = url.searchParams.get('profile') || 'basic';
		if (Object.hasOwn(seedProfiles, profile)) mockState.profile = profile;
		response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
		response.end('<!doctype html><title>seed</title><script>' + seedScript(profile) + '</script>');
		return;
	}
	if (url.pathname.startsWith('/__control')) {
		try { await handleApi(url, request, response); }
		catch (error) { if (!response.headersSent) sendJson(response, { error: error.message }, 500); }
		return;
	}
	if (url.pathname.startsWith('/api/')) {
		try { await handleApi(url, request, response); }
		catch (error) { if (!response.headersSent) sendJson(response, { error: error.message }, 500); }
		return;
	}
	if (url.pathname.startsWith('/images/')) {
		const id = decodeURIComponent(url.pathname.split('/')[2] || 'item');
		const backdrop = url.pathname.endsWith('Backdrop');
		const width = Number(url.searchParams.get('width')) || (backdrop ? 1200 : 400);
		await sleep(mockState.delays.imagesMs);
		const svg = posterSvg(id, width, backdrop ? Math.round(width * 9 / 16) : Math.round(width * 3 / 2));
		response.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Content-Length': svg.length, 'Cache-Control': 'no-store' });
		response.end(svg);
		return;
	}
	if (url.pathname.startsWith('/media/')) {
		response.writeHead(404, { 'Content-Type': 'text/plain' });
		response.end('not found');
		return;
	}
	if (url.pathname === '/vendor/hls.min.js') {
		response.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
		response.end('window.Hls = window.Hls || {};');
		return;
	}
	const mapped = htmlRoutes.get(url.pathname);
	const file = mapped ? join(publicDirectory, mapped) : join(publicDirectory, url.pathname.replace(/^\//, ''));
	if (!file.startsWith(publicDirectory) || !existsSync(file)) {
		response.writeHead(404, { 'Content-Type': 'text/plain' });
		response.end('not found');
		return;
	}
	response.writeHead(200, { 'Content-Type': contentTypes[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
	response.end(readFileSync(file));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = 'http://127.0.0.1:' + server.address().port;

async function control(bodyValue) {
	const response = await fetch(origin + '/__control/set', {
		method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(bodyValue || {}),
	});
	return response.json();
}
async function controlState() {
	return (await fetch(origin + '/__control/state')).json();
}

// ---------------------------------------------------------------------------
// Chrome / CDP plumbing
// ---------------------------------------------------------------------------

const profile = mkdtempSync(join(tmpdir(), 'tellybox-consolidation-121-web-'));
const child = spawn(chromePath, [
	'--headless=new',
	'--disable-gpu',
	'--hide-scrollbars',
	'--no-first-run',
	'--no-default-browser-check',
	'--disable-extensions',
	'--autoplay-policy=no-user-gesture-required',
	'--remote-debugging-port=0',
	'--user-data-dir=' + profile,
	'about:blank',
], { stdio: 'ignore' });

async function targetFor(port) {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		try {
			const list = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
			const page = list.find(entry => entry.type === 'page');
			if (page) return page;
		} catch {}
		await sleep(100);
	}
	throw new Error('Chrome target unavailable');
}

async function connect(targetValue) {
	const socket = new WebSocket(targetValue.webSocketDebuggerUrl);
	await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
	let id = 0;
	const pending = new Map();
	const eventListeners = new Map();
	socket.onmessage = event => {
		const message = JSON.parse(event.data);
		if (message.id && pending.has(message.id)) {
			const { resolve, reject } = pending.get(message.id);
			pending.delete(message.id);
			if (message.error) reject(new Error(JSON.stringify(message.error)));
			else resolve(message.result);
		} else if (message.method) {
			for (const listener of eventListeners.get(message.method) || []) listener(message.params);
		}
	};
	const send = (method, params = {}) => new Promise((resolve, reject) => {
		const messageId = ++id;
		pending.set(messageId, { resolve, reject });
		socket.send(JSON.stringify({ id: messageId, method, params }));
	});
	const on = (method, listener) => {
		const listeners = eventListeners.get(method) || [];
		listeners.push(listener);
		eventListeners.set(method, listeners);
	};
	return { socket, send, on };
}

function makeContext(send, on) {
	on('Runtime.exceptionThrown', params => {
		const value = params?.exceptionDetails?.exception?.description || params?.exceptionDetails?.text;
		if (value) mockState.consoleErrors.push(String(value).split('\n')[0]);
	});
	on('Runtime.consoleAPICalled', params => {
		if (process.env.DEBUG_PAGE_LOGS === '1') {
			const text = (params.args || []).map(argument => argument.value ?? argument.description ?? '').join(' ');
			if (text) console.log('PAGELOG', text);
		}
		if (params?.type !== 'error') return;
		const text = (params.args || []).map(argument => argument.value ?? argument.description ?? '').join(' ');
		if (text) mockState.consoleErrors.push(text.split('\n')[0]);
	});
	on('Log.entryAdded', params => {
		if (params?.entry?.level === 'error') mockState.logErrors.push(String(params.entry.text || '').split('\n')[0]);
	});

	const evaluate = async (expression, userGesture = false) => {
		const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture });
		if (result.exceptionDetails) {
			const description = result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'evaluation failed';
			throw new Error(description.split('\n')[0]);
		}
		return result.result.value;
	};

	const waitFor = async (expression, timeout = 10000, label = expression) => {
		const deadline = Date.now() + timeout;
		let last = null;
		while (Date.now() < deadline) {
			try {
				last = await evaluate(expression);
				if (last) return last;
			} catch (error) { last = error.message; }
			await sleep(60);
		}
		throw new Error('Timed out waiting for ' + label + ' (last: ' + JSON.stringify(last) + ')');
	};

	const navigate = async url => {
		await send('Page.navigate', { url });
		await waitFor("document.readyState === 'complete'", 12000, 'page load');
	};

	const history = async () => {
		const value = await send('Page.getNavigationHistory');
		return {
			index: value.currentIndex,
			length: value.entries.length,
			url: value.entries[value.currentIndex]?.url || '',
		};
	};

	const mouseClick = async selector => {
		const point = await evaluate(`(() => {
			const node = document.querySelector(${JSON.stringify(selector)});
			if (!node) return null;
			node.scrollIntoView({ block: 'center', inline: 'center' });
			const rect = node.getBoundingClientRect();
			return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
		})()`);
		if (!point) throw new Error('Could not find ' + selector + ' for a mouse click');
		await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
		await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
	};

	const click = async selector => {
		const clicked = await evaluate(`(() => { const node = document.querySelector(${JSON.stringify(selector)}); if (!node) return false; node.click(); return true; })()`);
		if (!clicked) throw new Error('Could not click ' + selector);
		return clicked;
	};

	const clickText = async (selector, text) => {
		const clicked = await evaluate(`(() => {
			const nodes = [...document.querySelectorAll(${JSON.stringify(selector)})];
			const node = nodes.find(entry => (entry.textContent || '').includes(${JSON.stringify(text)}));
			if (!node) return false;
			node.click();
			return true;
		})()`);
		if (!clicked) throw new Error('Could not click ' + selector + ' containing ' + text);
		return clicked;
	};

	const screenshot = async name => {
		const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
		const file = join(outDir, name);
		writeFileSync(file, Buffer.from(shot.data, 'base64'));
		return file;
	};

	const addInitScript = async source => {
		await send('Page.addScriptToEvaluateOnNewDocument', { source });
	};

	return { evaluate, waitFor, navigate, history, mouseClick, click, clickText, screenshot, addInitScript, sleep };
}

// ---------------------------------------------------------------------------
// Assertion helpers and results
// ---------------------------------------------------------------------------

const results = {
	label,
	fixtureOnly: true,
	livePlayback: false,
	scenarios: {},
	consoleErrors: mockState.consoleErrors,
	logErrors: mockState.logErrors,
};

function scenarioResult(name) {
	results.scenarios[name] = { assertions: [], checks: {} };
	return results.scenarios[name];
}
function check(scenario, name, pass, detail = '') {
	scenario.assertions.push({ name, pass: Boolean(pass), detail });
	scenario.checks[name] = { pass: Boolean(pass), detail };
}
async function stateFor(name) {
	const state = await controlState();
	results.scenarios[name].fixture = {
		homeRequests: state.homeRequests,
		homeBodies: state.homeBodies,
		playRequests: state.playRequests,
		sessionStops: state.sessionStops,
	};
	return state;
}

// ---------------------------------------------------------------------------
// Scenario 1: async Home reveal must not move what the viewer is reading
// ---------------------------------------------------------------------------

async function runRevealScenario(context, viewport) {
	const name = 'home-reveal-no-jump-' + viewport;
	const scenario = scenarioResult(name);
	await control({ scramble: false, duplicate: false, reverseAfter: -1, homeMs: 2200, itemsMs: 0, releasesMs: 800, tvMs: 1000, imagesMs: 450 });
	await context.navigate(origin + '/__seed?profile=basic');
	await context.waitFor('location.pathname === "/"', 8000, 'seed redirect');
	await context.waitFor("document.querySelectorAll('#homeRows .home-tile .card, #homeRows .continue-card').length >= 6", 12000, 'home tiles');
	// Browser scroll anchoring is disabled for this measurement so the app's own
	// stability is proven rather than Chrome's compensation (which fails whenever
	// the anchor node is replaced or the viewer is at the page bottom).
	await context.evaluate(`(() => {
		const style = document.createElement('style');
		style.textContent = '* { overflow-anchor: none !important; }';
		document.head.append(style);
		return true;
	})()`);
	await context.evaluate(`(() => {
		const host = document.scrollingElement || document.documentElement;
		host.scrollTop = host.scrollHeight;
		return true;
	})()`);
	await context.sleep(150);
	await context.evaluate(`(() => {
		const evidence = window.__tellyboxEvidence = { shifts: [], samples: [], beforeTop: null, finalTop: null, anchorLabel: '', anchorIndex: -1, anchorIntersected: false, anchorLost: false, realFeedSeen: false, lastMoveAt: 0, running: true, errors: [] };
		try {
			const observer = new PerformanceObserver(list => {
				for (const entry of list.getEntries()) if (!entry.hadRecentInput) window.__tellyboxEvidence.shifts.push(Number(entry.value.toFixed(4)));
			});
			observer.observe({ type: 'layout-shift', buffered: false });
		} catch (error) { window.__tellyboxEvidence.errors.push(String(error)); }
		// The reading anchor is the first Home card FULLY inside the viewport.
		// The same DOM element (plus its identity) is retained and re-read at
		// the settled endpoint - Home cards survive the feed reveal, so identity
		// plus final rect is a real endpoint measurement.
		const cards = [...document.querySelectorAll('#homeRows .home-tile .card, #homeRows .continue-card')];
		const anchor = cards.find(card => {
			const box = card.getBoundingClientRect();
			return box.top >= 0 && box.bottom <= innerHeight && box.width > 0 && box.height > 0;
		}) || null;
		evidence.anchor = anchor;
		if (anchor) {
			evidence.anchorLabel = anchor.getAttribute('aria-label') || '';
			evidence.anchorIndex = cards.indexOf(anchor);
		}
		const anchorTop = () => {
			const node = evidence.anchor;
			if (!node || !node.isConnected) return null;
			return node.getBoundingClientRect().top;
		};
		evidence.anchorIntersected = anchorTop() !== null;
		evidence.beforeTop = anchorTop();
		evidence.lastMoveAt = performance.now();
		let lastSampleTop = null;
		const sample = () => {
			if (!evidence.running) return;
			const top = anchorTop();
			if (top === null) return;
			evidence.samples.push({ t: Math.round(performance.now()), top: Number(top.toFixed(2)) });
			// Quiet means no CHANGE between consecutive frames; the endpoint
			// offset against the pre-reveal baseline is asserted separately.
			if (lastSampleTop !== null && Math.abs(top - lastSampleTop) > 0.25) evidence.lastMoveAt = performance.now();
			lastSampleTop = top;
		};
		// The reveal completes only once the REAL feed (non-skeleton rows) is
		// on screen - the skeleton must not count.
		const realFeed = () => Boolean(document.querySelector('#homeRows .home-row:not(.home-row--skeleton)'));
		const finish = () => { if (!evidence.realFeedSeen && realFeed()) { evidence.realFeedSeen = true; sample(); } };
		finish();
		// Continuous sampling: mutation observers, an anchor ResizeObserver and
		// a requestAnimationFrame loop until a quiet window is confirmed.
		const rowsObserver = new MutationObserver(() => { sample(); finish(); });
		rowsObserver.observe(document.querySelector('#homeRows'), { childList: true, subtree: true });
		if (anchor && typeof ResizeObserver === 'function') {
			try { const resizeObserver = new ResizeObserver(() => sample()); resizeObserver.observe(anchor); evidence.resizeObserver = resizeObserver; } catch {}
		}
		const raf = () => { sample(); if (evidence.running) requestAnimationFrame(raf); };
		requestAnimationFrame(raf);
		sample();
		return true;
	})()`);
	const shotPre = await context.screenshot(name + '-pre-reveal.png');
	await context.waitFor("(() => document.querySelectorAll('#homeRows .home-row:not(.home-row--skeleton)').length >= 3)()", 12000, 'real home feed');
	// Wait for the home rows and every artwork image before the endpoint
	// measurement.
	await context.waitFor("(() => { const images = [...document.querySelectorAll('#homeRows .home-tile .poster img, #homeRows .continue-art-image')].filter(image => image.getAttribute('src') && !image.dataset.skeleton); return images.length > 0 && images.every(image => image.complete); })()", 12000, 'home artwork');
	// A quiet window: no anchor movement beyond 0.25 px for 300 ms while the
	// rAF sampler keeps running, so late layout cannot hide between samples.
	try {
		await context.waitFor("(() => { const e = window.__tellyboxEvidence || {}; return e.realFeedSeen === true && performance.now() - e.lastMoveAt > 300 && (e.samples || []).length >= 10; })()", 15000, 'quiet window after settle');
	} catch (error) {
		const dump = await context.evaluate("(() => { const e = window.__tellyboxEvidence || {}; return { realFeedSeen: e.realFeedSeen, sinceMove: Math.round(performance.now() - e.lastMoveAt), samples: e.samples ? e.samples.length : 0, lastSamples: (e.samples || []).slice(-6), anchorConnected: Boolean(e.anchor && e.anchor.isConnected), skeletonRows: Boolean(document.querySelector('#homeRows .home-row--skeleton')) }; })()");
		throw new Error(error.message + ' | dump: ' + JSON.stringify(dump));
	}
	const measured = await context.evaluate(`(() => {
		const evidence = window.__tellyboxEvidence || {};
		evidence.running = false;
		const anchor = evidence.anchor;
		if (anchor && anchor.isConnected) {
			evidence.finalTop = Number(anchor.getBoundingClientRect().top.toFixed(2));
			// One last post-stop sample: the endpoint must equal the last frame.
			evidence.samples.push({ t: Math.round(performance.now()), top: evidence.finalTop, final: true });
		} else {
			evidence.anchorLost = true;
			evidence.finalTop = null;
		}
		const host = document.scrollingElement || document.documentElement;
		const beforeTop = Number(evidence.beforeTop);
		const finalTop = evidence.finalTop === null ? null : Number(evidence.finalTop);
		const samples = (evidence.samples || []).map(entry => Number(entry.top));
		const transientSamples = (evidence.samples || []).filter(entry => !entry.final).map(entry => Number(entry.top));
		const drift = Number.isFinite(beforeTop) && Number.isFinite(finalTop) ? Math.abs(finalTop - beforeTop) : null;
		const maxTransient = transientSamples.length ? Math.max(...transientSamples.map(value => Math.abs(value - beforeTop))) : null;
		const rows = [...document.querySelectorAll('#homeRows .home-row')].map(section => ({
			title: section.querySelector('.shelf-heading h2')?.textContent || '',
			className: section.className || '',
		}));
		return {
			beforeTop,
			finalTop,
			drift,
			anchorLabel: evidence.anchorLabel || '',
			anchorIndex: evidence.anchorIndex,
			anchorIntersected: evidence.anchorIntersected,
			anchorLost: evidence.anchorLost,
			sampleCount: transientSamples.length,
			samples: evidence.samples || [],
			maxTransient,
			scrollY: host.scrollTop,
			cls: (evidence.shifts || []).reduce((sum, value) => sum + value, 0),
			shiftEntries: evidence.shifts || [],
			errors: evidence.errors || [],
			rows,
			overflow: document.scrollingElement.scrollWidth - innerWidth,
		};
	})()`);
	const shotAfter = await context.screenshot(name + '-after-reveal.png');

	check(scenario, 'the reading anchor is fully inside the viewport before the reveal', measured.anchorIntersected === true, JSON.stringify({ anchor: measured.anchorLabel, beforeTop: measured.beforeTop }));
	check(scenario, 'the reading anchor survives to the settled endpoint', measured.anchorLost === false && measured.finalTop !== null, JSON.stringify({ anchor: measured.anchorLabel }));
	check(scenario, 'home reveal keeps the visible reading anchor in place at the settled endpoint', measured.drift !== null && measured.drift <= 2, JSON.stringify({ beforeTop: measured.beforeTop, finalTop: measured.finalTop, drift: measured.drift, anchor: measured.anchorLabel }));
	check(scenario, 'no transient movement of the reading anchor at any sampled frame', measured.maxTransient !== null && measured.maxTransient <= 2 && measured.sampleCount >= 10, JSON.stringify({ beforeTop: measured.beforeTop, samples: measured.samples, maxTransient: measured.maxTransient, sampleCount: measured.sampleCount }));
	check(scenario, 'cumulative layout shift during reveal stays bounded (supplemental)', measured.cls <= 0.25, JSON.stringify({ cls: measured.cls, entries: measured.shiftEntries }));
	check(scenario, 'no page-level horizontal overflow', measured.overflow <= 1, String(measured.overflow));
	check(scenario, 'real (non-skeleton) home rows rendered', measured.rows.length >= 3 && measured.rows.every(row => !/home-row--skeleton/.test(row.className)), JSON.stringify(measured.rows.map(row => row.title)));
	check(scenario, 'no observer errors', measured.errors.length === 0, JSON.stringify(measured.errors));
	scenario.artifacts = [shotPre, shotAfter];
	scenario.measurements = measured;
	await stateFor(name);
}

// ---------------------------------------------------------------------------
// Scenario 2: Continue watching is the first, prominent rail after the hero
// ---------------------------------------------------------------------------

async function runContinueScenario(context, viewport) {
	const name = 'continue-watching-prominent-' + viewport;
	const scenario = scenarioResult(name);
	await control({ scramble: true, duplicate: false, reverseAfter: -1, homeMs: 0, itemsMs: 0, releasesMs: 0, tvMs: 0, imagesMs: 0 });
	await context.navigate(origin + '/__seed?profile=basic');
	await context.waitFor('location.pathname === "/"', 8000, 'seed redirect');
	await context.evaluate(`(() => { const host = document.scrollingElement || document.documentElement; host.scrollTop = 0; return true; })()`);
	await context.waitFor("(() => { const rows = document.querySelectorAll('#homeRows .home-row'); return rows.length >= 3 && rows[0].querySelector('.shelf-heading h2'); })()", 12000, 'home rows');
	await context.waitFor("(() => { const images = [...document.querySelectorAll('#homeRows .home-tile .poster img')].filter(image => image.getAttribute('src')); return images.length > 0 && images.every(image => image.complete); })()", 12000, 'home artwork');
	await context.sleep(200);
	const state = await context.evaluate(`(() => {
		const rows = [...document.querySelectorAll('#homeRows .home-row')];
		const first = rows[0];
		const continueRow = rows.find(row => row.querySelector('.shelf-heading h2')?.textContent === 'Continue watching');
		const forYouRow = rows.find(row => row.querySelector('.shelf-heading h2')?.textContent === 'Picked for you');
		const badge = continueRow?.querySelector('.continue-resume');
		const card = continueRow?.querySelector('button.continue-card');
		const width = row => { const tile = row?.querySelector('.continue-card, .home-tile'); return tile ? Math.round(tile.getBoundingClientRect().width) : 0; };
		return {
			scrollY: (document.scrollingElement || document.documentElement).scrollTop,
			innerHeight,
			firstTitle: first?.querySelector('.shelf-heading h2')?.textContent || '',
			firstClass: first?.className || '',
			continueIndex: rows.indexOf(continueRow),
			forYouIndex: rows.indexOf(forYouRow),
			continueWidth: width(continueRow),
			forYouWidth: width(forYouRow),
			badgeText: badge?.textContent || '',
			cardLabel: card?.getAttribute('aria-label') || '',
			headingTop: continueRow ? continueRow.querySelector('.shelf-heading').getBoundingClientRect().top : null,
			firstCardRect: continueRow ? (() => { const node = continueRow.querySelector('.continue-card'); if (!node) return null; const box = node.getBoundingClientRect(); return { top: box.top, bottom: box.bottom, width: box.width, height: box.height }; })() : null,
			overflow: document.scrollingElement.scrollWidth - innerWidth,
		};
	})()`);
	const shot = await context.screenshot(name + '.png');
	check(scenario, 'the page is at the top when the feed settles', state.scrollY === 0, String(state.scrollY));
	check(scenario, 'Continue watching is the first rail on Home', state.firstTitle === 'Continue watching', JSON.stringify({ firstTitle: state.firstTitle, firstClass: state.firstClass }));
	check(scenario, 'continue rail carries a prominent style hook', /\bhome-row--continue\b/.test(state.firstClass), state.firstClass);
	check(scenario, 'Continue watching sits above Picked for you', state.continueIndex >= 0 && state.continueIndex < state.forYouIndex, JSON.stringify({ continueIndex: state.continueIndex, forYouIndex: state.forYouIndex }));
	check(scenario, 'continue cards show the saved resume position', state.badgeText === 'Resume - 30 min', state.badgeText);
	check(scenario, 'continue card announces Resume', /^Resume\b/.test(state.cardLabel), state.cardLabel);
	check(scenario, 'continue rail is wider than a standard rail', state.continueWidth > state.forYouWidth, JSON.stringify({ continueWidth: state.continueWidth, forYouWidth: state.forYouWidth }));
	check(scenario, 'continue heading is visible inside the viewport', state.headingTop !== null && state.headingTop >= 0 && state.headingTop < state.innerHeight, JSON.stringify({ headingTop: state.headingTop, innerHeight: state.innerHeight }));
	check(scenario, 'continue card shows a useful visible area', state.firstCardRect !== null && state.firstCardRect.width > 0 && state.firstCardRect.height > 0 && state.firstCardRect.bottom > 0 && state.firstCardRect.top < state.innerHeight && (Math.min(state.firstCardRect.bottom, state.innerHeight) - Math.max(state.firstCardRect.top, 0)) >= 60, JSON.stringify({ card: state.firstCardRect, innerHeight: state.innerHeight }));
	check(scenario, 'no page-level horizontal overflow', state.overflow <= 1, String(state.overflow));
	scenario.artifacts = [shot];
	scenario.measurements = state;
	await stateFor(name);
}

// ---------------------------------------------------------------------------
// Scenario 3: a New episodes rail shows exactly one next episode per liked show
// ---------------------------------------------------------------------------

async function waitForEpisodesRail(context) {
	await context.waitFor("(() => { const row = [...document.querySelectorAll('#homeRows .home-row')].find(section => section.querySelector('.shelf-heading h2')?.textContent === 'New episodes of your shows'); return Boolean(row && row.querySelectorAll('.home-tile').length); })()", 12000, 'new episodes rail');
	// Bring the whole rail (poster, series name and episode caption) into the
	// evidence screenshot without changing the DOM or the assertions.
	await context.evaluate(`(() => {
		const row = [...document.querySelectorAll('#homeRows .home-row')].find(section => section.querySelector('.shelf-heading h2')?.textContent === 'New episodes of your shows');
		if (row) row.scrollIntoView({ block: 'center' });
		return true;
	})()`);
	await context.sleep(200);
}

async function readHomeEpisodeRails(context) {
	return context.evaluate(`(() => {
		const rows = [...document.querySelectorAll('#homeRows .home-row')];
		const continueRow = rows.find(row => row.querySelector('.shelf-heading h2')?.textContent === 'Continue watching');
		const rail = rows.find(row => row.querySelector('.shelf-heading h2')?.textContent === 'New episodes of your shows');
		const tiles = rail ? [...rail.querySelectorAll('.home-tile')] : [];
		const continueCards = continueRow ? [...continueRow.querySelectorAll('.continue-card')] : [];
		return {
			railClass: rail?.className || '',
			railIndex: rail ? rows.indexOf(rail) : -1,
			continueIndex: continueRow ? rows.indexOf(continueRow) : -1,
			rowTitles: rows.map(row => row.querySelector('.shelf-heading h2')?.textContent || ''),
			titles: tiles.map(tile => tile.querySelector('h3')?.textContent || ''),
			captions: tiles.map(tile => tile.querySelector('.card p')?.textContent || ''),
			labels: tiles.map(tile => tile.querySelector('button.card')?.getAttribute('aria-label') || ''),
			continueTitles: continueCards.map(card => card.querySelector('.continue-title')?.textContent || ''),
			continueLabels: continueCards.map(card => card.getAttribute('aria-label') || ''),
			overflow: document.scrollingElement.scrollWidth - innerWidth,
		};
	})()`);
}

const episodeEntriesFor = (state, title) => state.titles
	.map((value, index) => ({ title: value, caption: state.captions[index], label: state.labels[index] }))
	.filter(entry => entry.title === title);

async function runNewEpisodesScenario(context, viewport) {
	const name = 'new-episodes-rail-' + viewport;
	const scenario = scenarioResult(name);
	await control({ scramble: false, duplicate: false, reverseAfter: -1, homeMs: 0, itemsMs: 0, releasesMs: 0, tvMs: 0, imagesMs: 0 });
	await context.navigate(origin + '/__seed?profile=liked');
	await context.waitFor('location.pathname === "/"', 8000, 'seed redirect');
	let railSeen = true;
	try {
		await waitForEpisodesRail(context);
	} catch {
		railSeen = false;
		await context.waitFor("document.querySelectorAll('#homeRows .home-row').length >= 3", 12000, 'home rows (no new episodes rail)');
	}
	const state = await readHomeEpisodeRails(context);
	const shot = await context.screenshot(name + '.png');
	const a = episodeEntriesFor(state, seriesA.Name);
	const b = episodeEntriesFor(state, seriesB.Name);
	check(scenario, 'New episodes rail exists with a stable style hook', railSeen === true && state.railIndex >= 0 && /\bhome-row--new-episodes\b/.test(state.railClass), JSON.stringify({ railIndex: state.railIndex, railClass: state.railClass }));
	check(scenario, 'New episodes rail sits directly after Continue watching', state.railIndex === state.continueIndex + 1, JSON.stringify({ railIndex: state.railIndex, continueIndex: state.continueIndex }));
	check(scenario, 'exactly one card per liked show, not one card per episode', railSeen === true && state.titles.length === 2 && a.length === 1 && b.length === 1, JSON.stringify({ titles: state.titles, a: a.length, b: b.length }));
	check(scenario, 'a show with no history starts at its first regular episode', a.length === 1 && a[0].caption.includes('S1 E1') && a[0].caption.includes(episodeA1.Name) && !a[0].caption.includes(episodeA0.Name), JSON.stringify(a));
	check(scenario, 'specials and unavailable later rows are not offered as the first episode', a.length === 1 && !a[0].caption.includes(episodeA3.Name) && !a[0].caption.includes(episodeA4.Name) && !a[0].caption.includes(episodeA5.Name) && !a[0].caption.includes(episodeA6.Name), JSON.stringify(a));
	check(scenario, 'a second liked show gets its own first regular episode', b.length === 1 && b[0].caption.includes('S2 E1') && b[0].caption.includes(episodeB1.Name), JSON.stringify(b));
	check(scenario, 'episode cards offer direct play', state.labels.length > 0 && state.labels.every(label => /^Play /.test(label)), JSON.stringify(state.labels));
	check(scenario, 'no page-level horizontal overflow', state.overflow <= 1, String(state.overflow));
	scenario.artifacts = [shot];
	scenario.measurements = state;
	await stateFor(name);
}

async function runNewEpisodesHistoryScenario(context, viewport) {
	const name = 'new-episodes-next-after-watch-' + viewport;
	const scenario = scenarioResult(name);
	await control({ scramble: false, duplicate: false, reverseAfter: -1, homeMs: 0, itemsMs: 0, releasesMs: 0, tvMs: 0, imagesMs: 0 });
	await context.navigate(origin + '/__seed?profile=watched');
	await context.waitFor('location.pathname === "/"', 8000, 'seed redirect');
	await waitForEpisodesRail(context);
	const state = await readHomeEpisodeRails(context);
	const shot = await context.screenshot(name + '.png');
	const a = episodeEntriesFor(state, seriesA.Name);
	const b = episodeEntriesFor(state, seriesB.Name);
	check(scenario, 'watched show still has exactly one next card', state.titles.length === 2 && a.length === 1 && b.length === 1, JSON.stringify({ titles: state.titles, a: a.length, b: b.length }));
	check(scenario, 'the next card follows the furthest watched episode', a.length === 1 && a[0].caption.includes('S1 E2') && a[0].caption.includes(episodeA2.Name), JSON.stringify(a));
	check(scenario, 'the watched episode is not offered again', a.length === 1 && !a[0].caption.includes(episodeA1.Name), JSON.stringify(a));
	check(scenario, 'a show without history still starts at its first regular episode', b.length === 1 && b[0].caption.includes('S2 E1') && b[0].caption.includes(episodeB1.Name), JSON.stringify(b));
	check(scenario, 'next episode cards offer direct play', state.labels.length > 0 && state.labels.every(label => /^Play /.test(label)), JSON.stringify(state.labels));
	scenario.artifacts = [shot];
	scenario.measurements = state;
	await stateFor(name);
}

async function runNewEpisodesCompleteScenario(context, viewport) {
	const name = 'new-episodes-complete-no-restart-' + viewport;
	const scenario = scenarioResult(name);
	await control({ scramble: false, duplicate: false, reverseAfter: -1, homeMs: 0, itemsMs: 0, releasesMs: 0, tvMs: 0, imagesMs: 0 });
	await context.navigate(origin + '/__seed?profile=complete');
	await context.waitFor('location.pathname === "/"', 8000, 'seed redirect');
	await waitForEpisodesRail(context);
	const state = await readHomeEpisodeRails(context);
	const shot = await context.screenshot(name + '.png');
	const a = episodeEntriesFor(state, seriesA.Name);
	const b = episodeEntriesFor(state, seriesB.Name);
	check(scenario, 'a fully watched show gets no card instead of restarting', a.length === 0 && !state.titles.includes(seriesA.Name), JSON.stringify({ titles: state.titles, a }));
	check(scenario, 'the other liked show keeps its own single card', state.titles.length === 1 && b.length === 1 && b[0].caption.includes('S2 E1'), JSON.stringify({ titles: state.titles, b }));
	check(scenario, 'no episode-1 restart and no unavailable later row', state.captions.every(caption => !caption.includes(episodeA1.Name) && !caption.includes(episodeA2.Name) && !caption.includes(episodeA3.Name) && !caption.includes(episodeA4.Name)), JSON.stringify(state.captions));
	scenario.artifacts = [shot];
	scenario.measurements = state;
	await stateFor(name);
}

async function runNewEpisodesContinueScenario(context, viewport) {
	const name = 'new-episodes-continue-wins-' + viewport;
	const scenario = scenarioResult(name);
	await control({ scramble: false, duplicate: false, reverseAfter: -1, homeMs: 0, itemsMs: 0, releasesMs: 0, tvMs: 0, imagesMs: 0 });
	await context.navigate(origin + '/__seed?profile=continue');
	await context.waitFor('location.pathname === "/"', 8000, 'seed redirect');
	await waitForEpisodesRail(context);
	await context.waitFor("(() => { const row = [...document.querySelectorAll('#homeRows .home-row')].find(section => section.querySelector('.shelf-heading h2')?.textContent === 'Continue watching'); return Boolean(row && row.querySelectorAll('.continue-card').length); })()", 12000, 'continue watching row');
	const state = await readHomeEpisodeRails(context);
	const shot = await context.screenshot(name + '.png');
	const a = episodeEntriesFor(state, seriesA.Name);
	const b = episodeEntriesFor(state, seriesB.Name);
	const aContinue = state.continueTitles.filter(title => title === seriesA.Name).length;
	check(scenario, 'the partial show is in Continue watching', aContinue === 1 && state.continueIndex >= 0, JSON.stringify({ continueTitles: state.continueTitles }));
	check(scenario, 'Continue watching wins: the same show is not repeated in New episodes', a.length === 0 && !state.titles.includes(seriesA.Name), JSON.stringify({ titles: state.titles, a }));
	check(scenario, 'the show appears exactly once across Continue and New episodes', aContinue + a.length === 1, JSON.stringify({ aContinue, newEpisodes: a.length }));
	check(scenario, 'the other liked show still gets its one next card', state.titles.length === 1 && b.length === 1 && b[0].caption.includes('S2 E1'), JSON.stringify({ titles: state.titles, b }));
	check(scenario, 'the Continue card resumes the real partial episode', state.continueLabels.some(label => /^Resume\b/.test(label) && label.includes(seriesA.Name) && label.includes(episodeA1.Name) && label.includes('S1 E1')), JSON.stringify(state.continueLabels));
	scenario.artifacts = [shot];
	scenario.measurements = state;
	await stateFor(name);
}

async function runNewEpisodesAliasScenario(context, viewport) {
	const name = 'new-episodes-aliases-' + viewport;
	const scenario = scenarioResult(name);
	await control({ scramble: false, duplicate: false, reverseAfter: -1, homeMs: 0, itemsMs: 0, releasesMs: 0, tvMs: 0, imagesMs: 0 });
	await context.navigate(origin + '/__seed?profile=aliased');
	await context.waitFor('location.pathname === "/"', 8000, 'seed redirect');
	await waitForEpisodesRail(context);
	const state = await readHomeEpisodeRails(context);
	const shot = await context.screenshot(name + '.png');
	const aliased = episodeEntriesFor(state, seriesD.Name);
	const twins = episodeEntriesFor(state, seriesTwinOne.Name);
	check(scenario, 'local and streamed aliases of one show make one card', aliased.length === 1 && aliased[0].caption.includes('S1 E1'), JSON.stringify({ titles: state.titles, aliased }));
	check(scenario, 'two different shows with the same title are not merged', twins.length === 2, JSON.stringify({ titles: state.titles, twins: twins.length }));
	check(scenario, 'the alias rail has no duplicate show cards', state.titles.length === 3 && aliased.length === 1 && twins.length === 2, JSON.stringify(state.titles));
	scenario.artifacts = [shot];
	scenario.measurements = state;
	await stateFor(name);
}

// ---------------------------------------------------------------------------
// Scenario 4: no title repeats across rails
// ---------------------------------------------------------------------------

async function runDuplicateScenario(context, viewport) {
	const name = 'no-duplicate-stale-cards-' + viewport;
	const scenario = scenarioResult(name);
	await control({ scramble: false, duplicate: true, reverseAfter: -1, homeMs: 0, itemsMs: 0, releasesMs: 0, tvMs: 0, imagesMs: 0 });
	await context.navigate(origin + '/__seed?profile=basic');
	await context.waitFor('location.pathname === "/"', 8000, 'seed redirect');
	await context.waitFor("document.querySelectorAll('#homeRows .home-row').length >= 3", 12000, 'home rows');
	await context.sleep(200);
	const state = await context.evaluate(`(() => {
		const names = [...document.querySelectorAll('#homeRows .home-tile h3')].map(node => node.textContent || '');
		return {
			counts: names.filter(name => name === ${JSON.stringify(movie1.Name)}).length,
			all: names,
		};
	})()`);
	check(scenario, 'a title never appears in more than one rail', state.counts === 1, JSON.stringify(state));
	scenario.measurements = state;
	await stateFor(name);
}

// ---------------------------------------------------------------------------
// Scenario 6: focus, scroll and history after series details -> player -> Close
// and -> browser Back (real popstate traversal). Runs on desktop and mobile.
// ---------------------------------------------------------------------------

async function runSeriesPlayerReturnScenario(context, viewport, mode) {
	const name = 'series-player-return-' + mode + '-' + viewport;
	const scenario = scenarioResult(name);
	await control({ scramble: false, duplicate: false, reverseAfter: -1, homeMs: 0, itemsMs: 0, releasesMs: 0, tvMs: 0, imagesMs: 0, playMs: 0 });
	await context.navigate(origin + '/__seed?profile=basic');
	await context.waitFor('location.pathname === "/"', 8000, 'seed redirect');
	await context.waitFor("document.querySelectorAll('#homeRows .home-tile .card').length >= 5", 12000, 'home tiles');
	await context.evaluate(`(() => { const host = document.scrollingElement || document.documentElement; host.scrollTop = 900; return true; })()`);
	await context.sleep(200);
	const cardSelector = `#homeRows .home-tile button.card[aria-label="${seriesA.Name}, Series"]`;
	await context.mouseClick(cardSelector);
	await context.waitFor("document.querySelector('#details').open && document.querySelectorAll('#detailsBody .episode').length >= 2", 12000, 'series details with episodes');
	const historyBefore = await context.history();
	const beforeScroll = await context.evaluate("(document.scrollingElement || document.documentElement).scrollTop");
	const episodeSelector = `#detailsBody .episode[aria-label*="${episodeA1.Name}"]`;
	// Exact origin focus: the pressed episode is marked, and the details dialog
	// reading position at click time is recorded by a capture listener (the
	// click's scrollIntoView happens before the handler runs).
	await context.evaluate(`(() => {
		const episode = [...document.querySelectorAll('#detailsBody .episode')].find(node => (node.getAttribute('aria-label') || '').includes(${JSON.stringify(episodeA1.Name)}));
		if (episode) episode.dataset.focusProbe = '1';
		window.__dlgScrollAtClick = null;
		document.addEventListener('click', () => {
			const dialog = document.querySelector('#details');
			if (dialog && dialog.open) window.__dlgScrollAtClick = dialog.scrollTop;
		}, true);
		return true;
	})()`);
	await context.mouseClick(episodeSelector);
	await context.waitFor("document.querySelector('#player').open && typeof state !== 'undefined' && Boolean(state.session)", 12000, 'player with session');
	const beforeDialogScroll = await context.evaluate("window.__dlgScrollAtClick");
	const historyOpen = await context.history();
	check(scenario, 'opening the player pushes exactly one history entry', historyOpen.index === historyBefore.index + 1 && historyOpen.length === historyBefore.length + 1, JSON.stringify({ before: historyBefore, open: historyOpen }));

	if (mode === 'close') {
		await context.click('#closePlayer');
	} else {
		await context.evaluate("history.back(); true");
	}
	await context.waitFor("!document.querySelector('#player').open && document.querySelector('#details').open", 10000, 'player closed and details restored');
	await context.sleep(200);
	const after = await context.evaluate(`(() => {
		const active = document.activeElement;
		const host = document.scrollingElement || document.documentElement;
		return {
			pathname: location.pathname,
			scrollY: host.scrollTop,
			focusClass: active?.className || '',
			focusLabel: active?.getAttribute('aria-label') || '',
			focusTag: active?.tagName || '',
			focusProbe: active?.dataset?.focusProbe || '',
			detailsOpen: document.querySelector('#details')?.open || false,
			detailsScroll: document.querySelector('#details')?.scrollTop || 0,
		};
	})()`);
	const historyAfter = await context.history();
	const shot = await context.screenshot(name + '.png');
	check(scenario, mode + ' returns to the recorded history entry', historyAfter.index === historyBefore.index && historyAfter.length === historyOpen.length, JSON.stringify({ before: historyBefore, open: historyOpen, after: historyAfter }));
	check(scenario, 'series details dialog is restored', after.detailsOpen === true, String(after.detailsOpen));
	check(scenario, 'page scroll position restored', Math.abs(after.scrollY - beforeScroll) <= 2, JSON.stringify({ beforeScroll, afterScroll: after.scrollY }));
	check(scenario, 'details dialog scroll position restored', Math.abs(after.detailsScroll - beforeDialogScroll) <= 2, JSON.stringify({ beforeDialogScroll, afterDialogScroll: after.detailsScroll }));
	check(scenario, 'focus returns to the exact episode that was pressed', after.focusProbe === '1' && after.focusClass.includes('episode') && after.focusLabel.includes(episodeA1.Name), JSON.stringify(after));
	scenario.artifacts = [shot];
	scenario.measurements = { historyBefore, historyOpen, historyAfter, beforeScroll, beforeDialogScroll, after };
	await stateFor(name);
}

// ---------------------------------------------------------------------------
// Scenario 7: Home -> Discover -> details -> player -> Back returns properly
// ---------------------------------------------------------------------------

async function runDiscoverJourneyScenario(context, viewport) {
	const name = 'discover-journey-return-' + viewport;
	const scenario = scenarioResult(name);
	await control({ scramble: false, duplicate: false, reverseAfter: -1, homeMs: 0, itemsMs: 0, releasesMs: 0, tvMs: 0, imagesMs: 0, playMs: 0 });
	await context.navigate(origin + '/__seed?profile=basic');
	await context.waitFor('location.pathname === "/"', 8000, 'seed redirect');
	await context.waitFor("document.querySelectorAll('#homeRows .home-row').length >= 3", 12000, 'home rows');
	await context.navigate(origin + '/discover?type=movie');
	try {
		await context.waitFor("location.pathname === '/discover' && document.querySelectorAll('#discoverGrid .discover-card').length >= 1", 15000, 'discover grid');
	} catch (error) {
		const dump = await context.evaluate(`(() => ({
			pathname: location.pathname,
			href: location.href,
			status: document.querySelector('#discoverStatus')?.textContent || '',
			cards: document.querySelectorAll('#discoverGrid .discover-card').length,
			bodySnippet: document.body.textContent.slice(0, 400),
		}))()`);
		throw new Error(error.message + ' | dump: ' + JSON.stringify(dump));
	}
	await context.evaluate(`(() => { const host = document.scrollingElement || document.documentElement; host.scrollTop = 500; return true; })()`);
	await context.sleep(200);
	const discoverIndex = (await context.history()).index;
	await context.mouseClick('#discoverGrid .discover-card');
	await context.waitFor("document.querySelector('#requestDetails')?.open", 10000, 'discover detail dialog');
	await context.waitFor("Boolean(document.querySelector('#requestBody a.button.primary'))", 10000, 'discover watch link');
	// Exact origin focus: mark the watch link before the handoff; the return
	// must put focus back on it (back/forward cache keeps the same node).
	await context.evaluate("(() => { const link = document.querySelector('#requestBody a.button.primary'); if (link) link.dataset.focusProbe = '1'; return true; })()");
	// The handoff stores the scroll position that exists when the viewer leaves;
	// the dialog-centred click can move it, so capture it now.
	const discoverScrollBefore = await context.evaluate("(document.scrollingElement || document.documentElement).scrollTop");
	await context.mouseClick('#requestBody a.button.primary');
	await context.waitFor("location.pathname === '/' && new URLSearchParams(location.search).get('item') && document.querySelector('#details').open", 15000, 'home details from discover');
	await context.mouseClick('#detailsBody button.button.primary');
	await context.waitFor("document.querySelector('#player').open && typeof state !== 'undefined' && Boolean(state.session)", 15000, 'player from discover');
	const historyOpen = await context.history();
	check(scenario, 'player open pushes exactly one entry', historyOpen.index === discoverIndex + 2, JSON.stringify({ discoverIndex, open: historyOpen }));

	// A real browser Back traversal, not the in-app close button.
	await context.evaluate("history.back(); true");
	await context.waitFor("location.pathname === '/discover' && document.readyState === 'complete'", 15000, 'return to discover');
	await context.sleep(300);
	const after = await context.evaluate(`(() => {
		const active = document.activeElement;
		const host = document.scrollingElement || document.documentElement;
		return {
			pathname: location.pathname,
			scrollY: host.scrollTop,
			gridCards: document.querySelectorAll('#discoverGrid .discover-card').length,
			focusProbe: active?.dataset?.focusProbe || '',
			focusTag: active?.tagName || '',
			focusText: active?.textContent?.trim() || '',
			focusHref: active?.getAttribute?.('href') || '',
			dialogOpen: Boolean(document.querySelector('#requestDetails')?.open),
		};
	})()`);
	const historyAfter = await context.history();
	const shot = await context.screenshot(name + '.png');
	check(scenario, 'Back lands on the Discover document', after.pathname === '/discover', after.pathname);
	check(scenario, 'Discover grid still populated', after.gridCards >= 1, String(after.gridCards));
	check(scenario, 'Discover scroll position restored', Math.abs(after.scrollY - discoverScrollBefore) <= 3, JSON.stringify({ before: discoverScrollBefore, after: after.scrollY }));
	check(scenario, 'history index returns to Discover', historyAfter.index === discoverIndex, JSON.stringify({ discoverIndex, open: historyOpen, after: historyAfter }));
	check(scenario, 'focus returns to the exact Watch in Tellybox action', after.focusProbe === '1' || (after.focusTag === 'A' && after.focusText === 'Watch in Tellybox' && after.focusHref.includes('?item=')), JSON.stringify(after));
	scenario.artifacts = [shot];
	scenario.measurements = { historyOpen, historyAfter, discoverIndex, discoverScrollBefore, after };
	await stateFor(name);
}

// ---------------------------------------------------------------------------
// Scenario 8: Home -> Search -> details -> player -> Back returns properly
// ---------------------------------------------------------------------------

async function runSearchJourneyScenario(context, viewport) {
	const name = 'search-journey-return-' + viewport;
	const scenario = scenarioResult(name);
	await control({ scramble: false, duplicate: false, reverseAfter: -1, homeMs: 0, itemsMs: 0, releasesMs: 0, tvMs: 0, imagesMs: 0, playMs: 0 });
	await context.navigate(origin + '/search?q=Alpha&type=all');
	await context.waitFor("document.querySelectorAll('#availableSection .discover-card').length >= 1 && document.querySelector('#query')?.value === 'Alpha'", 15000, 'search results');
	await context.evaluate(`(() => { const host = document.scrollingElement || document.documentElement; host.scrollTop = Math.min(400, host.scrollHeight); return true; })()`);
	await context.sleep(200);
	const searchScrollBefore = await context.evaluate("(document.scrollingElement || document.documentElement).scrollTop");
	const searchIndex = (await context.history()).index;
	// Exact origin focus: the result card is marked before the handoff. On a
	// back/forward-cache return the same node survives; on a fresh reload the
	// recreated card is focused by the handoff restore instead.
	await context.evaluate("(() => { const card = document.querySelector('#availableSection .discover-card'); if (card) card.dataset.focusProbe = '1'; return true; })()");
	await context.mouseClick('#availableSection .discover-card');
	await context.waitFor("location.pathname === '/' && new URLSearchParams(location.search).get('item') && document.querySelector('#details').open", 15000, 'home details from search');
	await context.mouseClick('#detailsBody button.button.primary');
	await context.waitFor("document.querySelector('#player').open && typeof state !== 'undefined' && Boolean(state.session)", 15000, 'player from search');
	const historyOpen = await context.history();
	check(scenario, 'player open pushes exactly one entry', historyOpen.index === searchIndex + 2, JSON.stringify({ searchIndex, open: historyOpen }));

	// A real browser Back traversal: search -> home handoff -> player -> search.
	await context.evaluate("history.back(); true");
	await context.waitFor("location.pathname === '/search' && document.readyState === 'complete'", 15000, 'return to search');
	await context.sleep(300);
	const after = await context.evaluate(`(() => {
		const active = document.activeElement;
		const host = document.scrollingElement || document.documentElement;
		return {
			pathname: location.pathname,
			query: new URLSearchParams(location.search).get('q') || '',
			queryValue: document.querySelector('#query')?.value || '',
			scrollY: host.scrollTop,
			cards: document.querySelectorAll('#availableSection .discover-card').length,
			focusProbe: active?.dataset?.focusProbe || '',
			focusTag: active?.tagName || '',
			focusInResults: Boolean(active && active.closest && active.closest('#availableSection .discover-card')),
		};
	})()`);
	const historyAfter = await context.history();
	const shot = await context.screenshot(name + '.png');
	check(scenario, 'Back lands on the Search document', after.pathname === '/search', after.pathname);
	check(scenario, 'search query and input are preserved', after.query === 'Alpha' && after.queryValue === 'Alpha', JSON.stringify(after));
	check(scenario, 'search results still populated', after.cards >= 1, String(after.cards));
	check(scenario, 'search scroll position restored', Math.abs(after.scrollY - searchScrollBefore) <= 3, JSON.stringify({ before: searchScrollBefore, after: after.scrollY }));
	check(scenario, 'history index returns to Search', historyAfter.index === searchIndex, JSON.stringify({ searchIndex, open: historyOpen, after: historyAfter }));
	check(scenario, 'focus returns to the exact result card that was pressed', after.focusInResults === true && (after.focusProbe === '1' || after.focusTag === 'A'), JSON.stringify(after));
	scenario.artifacts = [shot];
	scenario.measurements = { historyOpen, historyAfter, searchIndex, after };
	await stateFor(name);
}

// ---------------------------------------------------------------------------
// Scenario 9: closing the player while playback preparation is still delayed
// ---------------------------------------------------------------------------

async function runCloseDuringPreparationScenario(context, viewport) {
	const name = 'close-during-preparation-' + viewport;
	const scenario = scenarioResult(name);
	await control({ scramble: false, duplicate: false, reverseAfter: -1, homeMs: 0, itemsMs: 0, releasesMs: 0, tvMs: 0, imagesMs: 0, playMs: 900 });
	await context.navigate(origin + '/__seed?profile=basic');
	await context.waitFor('location.pathname === "/"', 8000, 'seed redirect');
	await context.waitFor("document.querySelectorAll('#homeRows .home-row').length >= 3", 12000, 'home rows');
	const stopsBefore = (await controlState()).sessionStops.length;
	const historyBefore = await context.history();
	await context.mouseClick(`#homeRows .home-tile button.card[aria-label="Play ${movie1.Name}"]`);
	await context.waitFor("document.querySelector('#player').open", 10000, 'player open while preparing');
	// The /api/play response is still 900ms away: close immediately.
	await context.click('#closePlayer');
	await context.waitFor("!document.querySelector('#player').open", 10000, 'player closed during preparation');
	await context.waitFor("Boolean(typeof state !== 'undefined') && !state.session", 10000, 'playback session cleared');
	const deadline = Date.now() + 6000;
	let fixture = await controlState();
	while (Date.now() < deadline && fixture.sessionStops.length <= stopsBefore) {
		await context.sleep(100);
		fixture = await controlState();
	}
	const historyAfter = await context.history();
	const after = await context.evaluate(`(() => {
		const video = document.querySelector('#video');
		return {
			playerOpen: Boolean(document.querySelector('#player')?.open),
			videoSrc: video?.getAttribute('src') || '',
			currentSrc: video?.currentSrc || '',
		};
	})()`);
	check(scenario, 'closing during preparation returns to the same history entry', historyAfter.index === historyBefore.index && historyAfter.length === historyBefore.length + 1, JSON.stringify({ before: historyBefore, after: historyAfter }));
	check(scenario, 'the late play response is stopped, not attached', fixture.sessionStops.length > stopsBefore, JSON.stringify({ stops: fixture.sessionStops.length - stopsBefore }));
	check(scenario, 'no media was attached after the late response', after.videoSrc === '' && after.currentSrc === '', JSON.stringify(after));
	scenario.measurements = { historyBefore, historyAfter, after, stops: fixture.sessionStops.length - stopsBefore };
	await stateFor(name);
}

// ---------------------------------------------------------------------------
// Scenario 10: repeated open/close cycles add no duplicate history entries
// ---------------------------------------------------------------------------

async function runRepeatedOpenCloseScenario(context, viewport) {
	const name = 'repeated-open-close-' + viewport;
	const scenario = scenarioResult(name);
	await control({ scramble: false, duplicate: false, reverseAfter: -1, homeMs: 0, itemsMs: 0, releasesMs: 0, tvMs: 0, imagesMs: 0, playMs: 0 });
	await context.navigate(origin + '/__seed?profile=basic');
	await context.waitFor('location.pathname === "/"', 8000, 'seed redirect');
	await context.waitFor("document.querySelectorAll('#homeRows .home-row').length >= 3", 12000, 'home rows');
	const historyBefore = await context.history();
	const cycles = [];
	for (let cycle = 1; cycle <= 2; cycle += 1) {
		await context.mouseClick(`#homeRows .home-tile button.card[aria-label="Play ${movie1.Name}"]`);
		await context.waitFor("document.querySelector('#player').open && typeof state !== 'undefined' && Boolean(state.session)", 12000, 'player open cycle ' + cycle);
		cycles.push({ stage: 'open' + cycle, ...(await context.history()) });
		await context.click('#closePlayer');
		await context.waitFor("!document.querySelector('#player').open", 10000, 'player closed cycle ' + cycle);
		await context.waitFor("Boolean(typeof state !== 'undefined') && !state.session", 10000, 'session cleared cycle ' + cycle);
		cycles.push({ stage: 'close' + cycle, ...(await context.history()) });
	}
	await context.sleep(200);
	const historyAfter = await context.history();
	const playerClosed = await context.evaluate("Boolean(document.querySelector('#player')) && !document.querySelector('#player').open");
	check(scenario, 'two open/close cycles return to the original entry', historyAfter.index === historyBefore.index, JSON.stringify({ before: historyBefore, after: historyAfter }));
	check(scenario, 'cycles never stack duplicate player entries (one forward entry total)', historyAfter.length === historyBefore.length + 1, JSON.stringify({ before: historyBefore, cycles, after: historyAfter }));
	check(scenario, 'the player is closed after both cycles', playerClosed === true, String(playerClosed));
	scenario.measurements = { historyBefore, cycles, historyAfter };
	await stateFor(name);
}

// ---------------------------------------------------------------------------
// Scenario 8: the Home context carries only this profile's own favourites
// ---------------------------------------------------------------------------

async function runAccountContextScenario(context, viewport) {
	const name = 'client-state-isolation-' + viewport;
	const scenario = scenarioResult(name);
	await control({ scramble: false, duplicate: false, reverseAfter: -1, homeMs: 0, itemsMs: 0, releasesMs: 0, tvMs: 0, imagesMs: 0 });
	await context.navigate(origin + '/__seed?profile=liked');
	await context.waitFor('location.pathname === "/"', 8000, 'seed redirect');
	await context.waitFor("document.querySelectorAll('#homeRows .home-row').length >= 4", 12000, 'home rows');
	await context.sleep(300);
	const seeded = await controlState();
	const seededBody = seeded.homeBodies[seeded.homeBodies.length - 1] || {};
	check(scenario, 'client context: seeded profile sends only its own favourite ids', JSON.stringify((seededBody.favourites || []).sort()) === JSON.stringify([movie6.Id, seriesA.Id].sort()), JSON.stringify(seededBody.favourites));
	check(scenario, 'client context: seeded profile sends only its own progress', Number((seededBody.progress || {})[continueMovie.Id]) === 1800, JSON.stringify(seededBody.progress));
	check(scenario, 'client context carries no URLs, tokens or media paths', !/https?:\/\/|\/api\/|\/media\/|bearer|token|secret|password/i.test(JSON.stringify(seededBody)), 'body keys=' + Object.keys(seededBody).join(', '));

	await context.evaluate(`(() => { try { localStorage.clear(); sessionStorage.clear(); } catch {} return true; })()`);
	await control({ profile: 'basic' });
	await context.navigate(origin + '/');
	await context.waitFor("document.querySelectorAll('#homeRows .home-row').length >= 2", 12000, 'home rows after clear');
	await context.sleep(300);
	const cleared = await controlState();
	const clearedBody = cleared.homeBodies[cleared.homeBodies.length - 1] || {};
	check(scenario, 'client context: a cleared browser profile sends no favourites', (clearedBody.favourites || []).length === 0, JSON.stringify(clearedBody.favourites));
	check(scenario, 'client context: a cleared browser profile sends no progress', Object.keys(clearedBody.progress || {}).length === 0, JSON.stringify(clearedBody.progress));
	check(scenario, 'the second Home request happened for the new context', cleared.homeRequests >= seeded.homeRequests + 1, JSON.stringify({ seeded: seeded.homeRequests, cleared: cleared.homeRequests }));
	scenario.measurements = { seededBody: { favourites: seededBody.favourites || [], progressKeys: Object.keys(seededBody.progress || {}), watched: seededBody.watched || [], tastePresent: Boolean(seededBody.taste) }, clearedBody: { favourites: clearedBody.favourites || [], progressKeys: Object.keys(clearedBody.progress || {}) } };
	await stateFor(name);
}

// ---------------------------------------------------------------------------
// Scenario 9: landing order, skeleton, first-viewport Continue watching
// ---------------------------------------------------------------------------

async function runLandingOrderScenario(context, viewport) {
	const name = 'landing-order-first-viewport-' + viewport;
	const scenario = scenarioResult(name);
	await control({ scramble: false, duplicate: false, reverseAfter: -1, homeMs: 900, itemsMs: 0, releasesMs: 0, tvMs: 0, imagesMs: 0 });
	// Fresh-page navigation lifecycle boundary: a brand new document via the
	// seed page, then an explicit top-of-page position before the delayed Home
	// response resolves.
	await context.navigate(origin + '/__seed?profile=liked');
	await context.waitFor('location.pathname === "/"', 8000, 'seed redirect');
	const preScroll = await context.evaluate(`(() => { const host = document.scrollingElement || document.documentElement; host.scrollTop = 0; return host.scrollTop; })()`);
	check(scenario, 'the page starts at the top before the feed resolves', preScroll === 0, String(preScroll));
	// The skeleton must be up before the async Home feed resolves.
	let skeletonSeen = true;
	try {
		await context.waitFor("Boolean(document.querySelector('#homeRows .home-row--skeleton'))", 8000, 'home skeleton');
	} catch {
		skeletonSeen = false;
		await context.waitFor("document.querySelectorAll('#homeRows .home-row').length >= 4", 12000, 'home rows (no skeleton)');
	}
	const skeleton = await context.evaluate(`(() => {
		const feed = document.querySelector('#homeFeed');
		const discovery = document.querySelector('#homeDiscovery');
		const menuRect = (() => { const node = document.querySelector('#menuToggle'); if (!node) return null; const box = node.getBoundingClientRect(); const style = getComputedStyle(node); return { x: box.x, width: box.width, height: box.height, visible: box.width > 0 && box.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' }; })();
		return {
			skeletonRow: Boolean(document.querySelector('#homeRows .home-row--skeleton')),
			feedVisible: Boolean(feed) && !feed.hidden,
			discoveryHidden: Boolean(discovery) && discovery.hidden,
			scrollY: (document.scrollingElement || document.documentElement).scrollTop,
			homeNavRect: (() => { const rect = document.querySelector('a.nav-item[href="/"]')?.getBoundingClientRect(); return rect ? { x: rect.x, width: rect.width } : null; })(),
			menuRect,
		};
	})()`);
	check(scenario, 'a stable Home skeleton is visible before the feed resolves', skeletonSeen === true && skeleton.skeletonRow === true && skeleton.feedVisible === true, JSON.stringify(skeleton));
	check(scenario, 'browse discovery waits until the feed has rendered', skeleton.discoveryHidden === true, JSON.stringify(skeleton));

	await context.waitFor("(() => { const rows = document.querySelectorAll('#homeRows .home-row'); return rows.length >= 4 && rows[0].querySelector('.shelf-heading h2')?.textContent === 'Continue watching'; })()", 12000, 'continue first after feed');
	await context.waitFor("(() => { const images = [...document.querySelectorAll('#homeRows .home-tile .poster img, #homeRows .continue-art-image')].filter(image => image.getAttribute('src') && image.getAttribute('src').indexOf('data:') !== 0); return images.length > 0 && images.every(image => image.complete); })()", 12000, 'home artwork');
	await context.sleep(200);
	const state = await context.evaluate(`(() => {
		const host = document.scrollingElement || document.documentElement;
		const rect = selector => { const node = document.querySelector(selector); if (!node) return null; const box = node.getBoundingClientRect(); return { top: box.top, bottom: box.bottom, width: box.width, height: box.height }; };
		const rows = [...document.querySelectorAll('#homeRows .home-row')];
		const continueRow = rows.find(row => row.querySelector('.shelf-heading h2')?.textContent === 'Continue watching');
		const heading = continueRow?.querySelector('.shelf-heading');
		const firstCard = continueRow?.querySelector('.continue-card');
		const feed = document.querySelector('#homeFeed');
		const discovery = document.querySelector('#homeDiscovery');
		const collection = document.querySelector('#collectionView');
		const headerBottom = rect('.topbar')?.bottom ?? 0;
		const headingRect = heading ? heading.getBoundingClientRect() : null;
		const cardRect = firstCard ? firstCard.getBoundingClientRect() : null;
		return {
			scrollY: host.scrollTop,
			firstRowTitle: rows[0]?.querySelector('.shelf-heading h2')?.textContent || '',
			innerHeight,
			headerBottom,
			feedRect: rect('#homeFeed'),
			discoveryRect: rect('#homeDiscovery'),
			feedVisible: Boolean(feed) && !feed.hidden,
			discoveryVisible: Boolean(discovery) && !discovery.hidden,
			collectionHidden: Boolean(collection) && collection.hidden,
			headingRect: headingRect ? { top: headingRect.top, bottom: headingRect.bottom, height: headingRect.height } : null,
			cardRect: cardRect ? { top: cardRect.top, bottom: cardRect.bottom, width: cardRect.width, height: cardRect.height } : null,
			skeletonGone: !document.querySelector('#homeRows .home-row--skeleton'),
			overflow: document.scrollingElement.scrollWidth - innerWidth,
			homeNavRect: (() => { const rect = document.querySelector('a.nav-item[href="/"]')?.getBoundingClientRect(); return rect ? { x: rect.x, width: rect.width } : null; })(),
			menuRect: (() => { const node = document.querySelector('#menuToggle'); if (!node) return null; const box = node.getBoundingClientRect(); const style = getComputedStyle(node); return { x: box.x, width: box.width, height: box.height, visible: box.width > 0 && box.height > 0 && style.display !== 'none' && style.visibility !== 'hidden' }; })(),
		};
	})()`);
	// Screenshot the exact state that is asserted: top of page with Continue
	// watching in the first viewport.
	const shot = await context.screenshot(name + '.png');
	const ordered = state.feedVisible === true && state.discoveryVisible === true && state.collectionHidden === true
		&& state.feedRect !== null && state.discoveryRect !== null && state.feedRect.top <= state.discoveryRect.top;
	check(scenario, 'landing order: Home feed, then discovery, with the collection hidden', ordered === true, JSON.stringify({ feed: state.feedRect, discovery: state.discoveryRect, feedVisible: state.feedVisible, discoveryVisible: state.discoveryVisible, collectionHidden: state.collectionHidden }));
	check(scenario, 'the settled page is still at the top (scrollY 0)', state.scrollY === 0, String(state.scrollY));
	check(scenario, 'Continue watching is the first rail after the landing heading', state.firstRowTitle === 'Continue watching', state.firstRowTitle);
	check(scenario, 'the Home feed is visible with positive geometry', state.feedRect !== null && state.feedRect.top >= 0 && state.feedRect.height > 0 && state.feedRect.bottom > state.headerBottom, JSON.stringify({ feed: state.feedRect, headerBottom: state.headerBottom }));
	check(scenario, 'Continue watching heading sits in the first viewport below the header', state.headingRect !== null && state.headingRect.top >= state.headerBottom && state.headingRect.top < state.innerHeight && state.headingRect.bottom > state.headerBottom && state.headingRect.height > 0, JSON.stringify({ heading: state.headingRect, headerBottom: state.headerBottom, innerHeight: state.innerHeight }));
	check(scenario, 'Continue watching shows a useful visible card area', state.cardRect !== null && state.cardRect.width > 0 && state.cardRect.height > 0 && state.cardRect.bottom > state.headerBottom && state.cardRect.top < state.innerHeight && (Math.min(state.cardRect.bottom, state.innerHeight) - Math.max(state.cardRect.top, state.headerBottom)) >= 60, JSON.stringify({ card: state.cardRect, headerBottom: state.headerBottom, innerHeight: state.innerHeight }));
	check(scenario, 'skeleton is replaced by the real feed', state.skeletonGone === true, String(state.skeletonGone));
	check(scenario, 'no page-level horizontal overflow', state.overflow <= 1, String(state.overflow));
	if (viewport === 'mobile') {
		const menu = state.menuRect;
		check(scenario, 'mobile menu control is visible with a usable target size', menu !== null && menu.visible === true && menu.width > 0 && menu.height >= 44, JSON.stringify(menu));
		check(scenario, 'mobile menu control keeps a stable position while the page settles', skeleton.menuRect !== null && menu !== null && Math.abs(skeleton.menuRect.x - menu.x) <= 0.5 && Math.abs(skeleton.menuRect.width - menu.width) <= 0.5 && Math.abs(skeleton.menuRect.height - menu.height) <= 0.5, JSON.stringify({ before: skeleton.menuRect, after: menu }));
	} else {
		check(scenario, 'Home nav item geometry matches the pre-feed measurement', skeleton.homeNavRect !== null && state.homeNavRect !== null && Math.abs(skeleton.homeNavRect.x - state.homeNavRect.x) <= 0.5 && Math.abs(skeleton.homeNavRect.width - state.homeNavRect.width) <= 0.5, JSON.stringify({ before: skeleton.homeNavRect, after: state.homeNavRect }));
	}
	scenario.artifacts = [shot];
	scenario.measurements = { skeleton, state };
	await stateFor(name);
}

// ---------------------------------------------------------------------------
// Scenario 10: a fresh viewer (no progress) gets no Continue watching rail
// ---------------------------------------------------------------------------

async function runFreshViewerScenario(context, viewport) {
	const name = 'fresh-viewer-no-continue-' + viewport;
	const scenario = scenarioResult(name);
	await control({ scramble: false, duplicate: false, reverseAfter: -1, homeMs: 600, itemsMs: 0, releasesMs: 0, tvMs: 0, imagesMs: 0 });
	await context.navigate(origin + '/__seed?profile=basic');
	await context.waitFor('location.pathname === "/"', 8000, 'seed redirect');
	await context.evaluate(`(() => { try { localStorage.clear(); } catch {} return true; })()`);
	await context.navigate(origin + '/');
	await context.waitFor("document.querySelectorAll('#homeRows .home-row').length >= 2", 12000, 'home rows for a fresh viewer');
	await context.sleep(200);
	const state = await context.evaluate(`(() => {
		const rows = [...document.querySelectorAll('#homeRows .home-row')];
		return {
			titles: rows.map(row => row.querySelector('.shelf-heading h2')?.textContent || ''),
			hasContinue: rows.some(row => row.querySelector('.shelf-heading h2')?.textContent === 'Continue watching'),
			status: document.querySelector('#homeFeedStatus')?.textContent || '',
		};
	})()`);
	check(scenario, 'fresh viewer sees no Continue watching rail', state.hasContinue === false, JSON.stringify(state));
	check(scenario, 'fresh viewer still gets browse rails', state.titles.length >= 2, JSON.stringify(state.titles));
	scenario.measurements = state;
	await stateFor(name);
}

// ---------------------------------------------------------------------------
// Scenario 11: Discover card with a local copy must not double-label Stream now
// ---------------------------------------------------------------------------

async function runDiscoverBadgeScenario(context, viewport) {
	const name = 'discover-local-card-labels-' + viewport;
	const scenario = scenarioResult(name);
	await control({ scramble: false, duplicate: false, reverseAfter: -1, homeMs: 0, itemsMs: 0, releasesMs: 0, tvMs: 0, imagesMs: 0 });
	await context.navigate(origin + '/discover?type=movie');
	await context.waitFor("document.querySelectorAll('#discoverGrid .discover-card').length >= 2", 15000, 'discover grid');
	await context.sleep(200);
	const state = await context.evaluate(`(() => {
		const cards = [...document.querySelectorAll('#discoverGrid .discover-card')];
		const local = cards.find(card => (card.textContent || '').includes('Discover Fixture Film'));
		const streamed = cards.find(card => (card.textContent || '').includes('Discover Streamed Only Film'));
		const badges = card => [...(card?.querySelectorAll('.request-badge') || [])].map(node => node.textContent || '');
		return {
			localBadges: badges(local),
			streamedBadges: badges(streamed),
			localHasStreamNow: badges(local).some(text => text.includes('Stream now')),
			localHasInLibrary: badges(local).some(text => text.includes('In your library')),
			streamedHasStreamNow: badges(streamed).some(text => text.includes('Stream now')),
			localAction: local?.querySelector('.search-action')?.textContent || '',
			streamedAction: streamed?.querySelector('.search-action')?.textContent || '',
		};
	})()`);
	const shot = await context.screenshot(name + '.png');
	check(scenario, 'a card with a local copy shows In your library', state.localHasInLibrary === true, JSON.stringify(state));
	check(scenario, 'a card with a local copy does not also claim Stream now', state.localHasStreamNow === false, JSON.stringify(state));
	check(scenario, 'a streamed-only card keeps the Stream now CTA', state.streamedHasStreamNow === true, JSON.stringify(state.streamedBadges));
	await context.mouseClick('#discoverGrid .discover-card');
	await context.waitFor("document.querySelector('#requestDetails')?.open", 10000, 'discover detail dialog');
	await context.sleep(200);
	const detail = await context.evaluate(`(() => {
		const body = document.querySelector('#requestBody');
		return {
			badges: body ? [...body.querySelectorAll('.request-badge')].map(node => node.textContent || '') : [],
			primary: body ? [...body.querySelectorAll('.button.primary')].map(node => node.textContent || '') : [],
			hasStreamNowButton: Boolean(body && [...body.querySelectorAll('a.button, button')].some(node => (node.textContent || '').includes('Stream now'))),
		};
	})()`);
	check(scenario, 'details for a local copy show In your library only', detail.badges.includes('In your library') && !detail.badges.includes('Stream now'), JSON.stringify(detail));
	check(scenario, 'details offer the local watch action, not a stream CTA', detail.primary.includes('Watch in Tellybox') && detail.hasStreamNowButton === false, JSON.stringify(detail));
	scenario.artifacts = [shot];
	scenario.measurements = { state, detail };
	await stateFor(name);
}

// ---------------------------------------------------------------------------
// Scenario 12: Films view settles without the Coming soon teaser flash
// ---------------------------------------------------------------------------

async function runFilmsSwitchScenario(context, viewport) {
	const name = 'films-async-switch-' + viewport;
	const scenario = scenarioResult(name);
	await control({ scramble: false, duplicate: false, reverseAfter: -1, homeMs: 0, itemsMs: 400, releasesMs: 0, tvMs: 0, imagesMs: 0 });
	// A document-start probe records whether the Coming soon teaser is ever
	// visible on the Films view, including the pre-JS first paint.
	await context.addInitScript(`(() => {
		window.__tellyboxTeaserProbe = { everVisible: false, checks: 0, started: false };
		const record = () => {
			window.__tellyboxTeaserProbe.checks += 1;
			const teaser = document.querySelector('#comingTeaser');
			if (teaser && !teaser.hidden && teaser.getClientRects().length > 0) window.__tellyboxTeaserProbe.everVisible = true;
		};
		const start = () => {
			if (window.__tellyboxTeaserProbe.started || !document.documentElement) return;
			window.__tellyboxTeaserProbe.started = true;
			const observer = new MutationObserver(record);
			observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden'] });
			record();
		};
		try { start(); } catch {}
		document.addEventListener('DOMContentLoaded', () => { try { start(); } catch {} });
	})()`);
	await context.navigate(origin + '/?view=movies');
	await context.waitFor("document.readyState === 'complete'", 12000, 'films page load');
	const probe = await context.evaluate("window.__tellyboxTeaserProbe || { everVisible: null, checks: 0 }");
	check(scenario, 'Coming soon teaser never flashes on the Films view', probe.everVisible === false && probe.checks > 0, JSON.stringify(probe));
	const initial = await context.evaluate(`(() => {
		const heading = document.querySelector('#collectionTitle');
		const rect = heading?.getBoundingClientRect();
		return {
			feedHidden: document.querySelector('#homeFeed')?.hidden === true,
			collectionVisible: document.querySelector('#collectionView')?.hidden === false,
			headingText: heading?.textContent || '',
			headingRect: rect ? { top: rect.top, height: rect.height } : null,
			scrollY: (document.scrollingElement || document.documentElement).scrollTop,
		};
	})()`);
	check(scenario, 'the Home feed is hidden and the collection is shown on the Films view', initial.feedHidden === true && initial.collectionVisible === true, JSON.stringify(initial));

	await context.waitFor("document.querySelectorAll('#grid .card').length >= 3 && document.querySelector('#collectionTitle')?.textContent.includes('Films')", 15000, 'films cards');
	await context.sleep(150);
	const settled = await context.evaluate(`(() => {
		const heading = document.querySelector('#collectionTitle');
		const rect = heading?.getBoundingClientRect();
		return {
			headingText: heading?.textContent || '',
			headingRect: rect ? { top: rect.top, height: rect.height } : null,
			scrollY: (document.scrollingElement || document.documentElement).scrollTop,
			cardCount: document.querySelectorAll('#grid .card').length,
		};
	})()`);
	const headingStable = initial.headingRect !== null && settled.headingRect !== null
		&& Math.abs(initial.headingRect.top - settled.headingRect.top) <= 1
		&& Math.abs(initial.headingRect.height - settled.headingRect.height) <= 1;
	check(scenario, 'collection heading geometry is stable across the async switch', headingStable === true, JSON.stringify({ initial: initial.headingRect, settled: settled.headingRect }));
	check(scenario, 'Films heading replaces the generic connecting state', settled.headingText.includes('Films'), settled.headingText);
	check(scenario, 'no scroll movement during the Films switch', initial.scrollY === 0 && settled.scrollY === 0, JSON.stringify({ initial: initial.scrollY, settled: settled.scrollY }));
	scenario.measurements = { probe, initial, settled };
	await stateFor(name);
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const viewports = [
	{ name: 'desktop', width: 1440, height: 900, mobile: false },
	{ name: 'desktop-1250', width: 1250, height: 700, mobile: false },
	{ name: 'mobile', width: 390, height: 844, mobile: true },
];

let checksPassed = true;
const want = name => !scenarioFilter || name.includes(scenarioFilter);
try {
	let port = 0;
	for (let attempt = 0; attempt < 100; attempt += 1) {
		const file = join(profile, 'DevToolsActivePort');
		if (existsSync(file)) {
			port = Number(readFileSync(file, 'utf8').split(/\r?\n/)[0]);
			if (port) break;
		}
		await sleep(100);
	}
	const { send, on, socket } = await connect(await targetFor(port));
	await send('Page.enable');
	await send('Runtime.enable');
	await send('Log.enable');

	for (const viewport of viewports) {
		await send('Emulation.setDeviceMetricsOverride', { width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: viewport.mobile });
		const context = makeContext(send, on);

		if (want('home-reveal-no-jump-' + viewport.name)) await runRevealScenario(context, viewport.name);
		if (want('continue-watching-prominent-' + viewport.name)) await runContinueScenario(context, viewport.name);
		if (want('landing-order-first-viewport-' + viewport.name)) await runLandingOrderScenario(context, viewport.name);
		if (want('series-player-return-close-' + viewport.name)) await runSeriesPlayerReturnScenario(context, viewport.name, 'close');
		if (want('series-player-return-back-' + viewport.name)) await runSeriesPlayerReturnScenario(context, viewport.name, 'back');
		if (viewport.name !== 'desktop-1250') {
			if (want('discover-journey-return-' + viewport.name)) await runDiscoverJourneyScenario(context, viewport.name);
			if (want('search-journey-return-' + viewport.name)) await runSearchJourneyScenario(context, viewport.name);
			if (want('close-during-preparation-' + viewport.name)) await runCloseDuringPreparationScenario(context, viewport.name);
			if (want('repeated-open-close-' + viewport.name)) await runRepeatedOpenCloseScenario(context, viewport.name);
		}
		if (viewport.name === 'desktop') {
			if (want('new-episodes-rail-desktop')) await runNewEpisodesScenario(context, viewport.name);
			if (want('new-episodes-next-after-watch-desktop')) await runNewEpisodesHistoryScenario(context, viewport.name);
			if (want('new-episodes-complete-no-restart-desktop')) await runNewEpisodesCompleteScenario(context, viewport.name);
			if (want('new-episodes-continue-wins-desktop')) await runNewEpisodesContinueScenario(context, viewport.name);
			if (want('new-episodes-aliases-desktop')) await runNewEpisodesAliasScenario(context, viewport.name);
			if (want('no-duplicate-stale-cards-desktop')) await runDuplicateScenario(context, viewport.name);
			if (want('discover-local-card-labels-desktop')) await runDiscoverBadgeScenario(context, viewport.name);
			if (want('films-async-switch-desktop')) await runFilmsSwitchScenario(context, viewport.name);
			if (want('fresh-viewer-no-continue-desktop')) await runFreshViewerScenario(context, viewport.name);
			if (want('client-state-isolation-desktop')) await runAccountContextScenario(context, viewport.name);
		}
	}
	await sleep(400);
	results.consoleErrors = mockState.consoleErrors;
	results.logErrors = mockState.logErrors;
	for (const scenario of Object.values(results.scenarios)) {
		scenario.ok = scenario.assertions.length > 0 && scenario.assertions.every(assertion => assertion.pass);
		if (!scenario.ok) checksPassed = false;
	}
	results.ok = checksPassed;
	results.assertionCount = Object.values(results.scenarios).reduce((sum, scenario) => sum + scenario.assertions.length, 0);
	results.consoleErrorCount = mockState.consoleErrors.length;
	writeFileSync(join(outDir, 'CONSOLIDATION-121-WEB-RESULTS.json'), JSON.stringify(results, null, 2) + '\n');
	console.log(JSON.stringify(results, null, 2));
	process.exitCode = checksPassed ? 0 : 1;
	socket.close();
} catch (error) {
	results.error = error.message + ' | consoleErrors: ' + JSON.stringify(mockState.consoleErrors.slice(0, 6)) + ' | logErrors: ' + JSON.stringify(mockState.logErrors.slice(0, 6)) + ' | notFound: ' + JSON.stringify(mockState.notFound.slice(0, 10));
	results.ok = false;
	writeFileSync(join(outDir, 'CONSOLIDATION-121-WEB-RESULTS.json'), JSON.stringify(results, null, 2) + '\n');
	console.error(results.error);
	process.exitCode = 1;
} finally {
	child.kill();
	await sleep(700);
	try { rmSync(profile, { recursive: true, force: true }); } catch {}
	server.closeAllConnections();
	server.close();
}
