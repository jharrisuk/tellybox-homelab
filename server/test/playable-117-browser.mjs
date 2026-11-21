/* Local headless-Chrome regression for the 117 availability fix.
 *
 * The real server/public UI is served with a controlled API fixture. It models
 * what the server now returns on normal watch surfaces: only verified playable
 * series, plus { availability: { pending, queued, checked } } and hasMore. The
 * fixture also models Discover/Search, which keep unavailable metadata.
 *
 * No provider stream, download, real provider request or production access is
 * used. Nothing is written outside the OS temp profile.
 *
 * Checks:
 *  - normal Series list never shows the empty local or streamed series, and
 *    shows both playable cards after the bounded pending poll finishes;
 *  - the checking notice appears while availability.pending is reported and
 *    disappears once the verified response arrives;
 *  - hasMore keeps Load more visible even when the page is complete by count;
 *  - a newer generation (search change) cancels a pending poll and is not
 *    overwritten by stale results;
 *  - polling is bounded (initial request + 5 polls, then a clear message);
 *  - Discover and Search still list the unavailable title, and using it never
 *    starts playback;
 *  - the Home feed shows a checking notice, keeps its first-paint row/hero and
 *    retries in the background, then clears the notice;
 *  - no console errors and no browser log errors.
 *
 * If Chrome or Chromium is unavailable the check prints SKIP and exits 0; it
 * never claims a browser pass without running one.
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const publicDirectory = fileURLToPath(new URL('../public/', import.meta.url));
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
	console.log('SKIP: Chrome or Chromium was not found, so the 117 availability browser regression did not run.');
	console.log('Run it from the repo root after installing Chrome (or set CHROME_PATH to the executable):');
	console.log('  node server/test/playable-117-browser.mjs');
	console.log('Windows example:');
	console.log('  $env:CHROME_PATH="C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"; node server/test/playable-117-browser.mjs');
	process.exit(0);
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const posterSvg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="300" height="450" viewBox="0 0 300 450"><rect width="300" height="450" fill="#1c2418"/><circle cx="150" cy="190" r="70" fill="none" stroke="#c4ed80" stroke-width="8"/><text x="150" y="340" fill="#c4ed80" font-family="Georgia, serif" font-size="28" text-anchor="middle">117</text></svg>');

const playableLocal = {
	Id: '91000000-0000-4000-8000-000000000001',
	Name: 'Local Playable',
	Type: 'Series',
	Source: 'local',
	ChildCount: 2,
	Genres: ['Drama'],
	ProductionYear: 2024,
	Overview: 'A fixture local series with playable episodes.',
	Artwork: '/fixture-poster.svg',
	UserData: {},
};
const emptyLocal = {
	Id: '91000000-0000-4000-8000-000000000002',
	Name: 'Local Empty',
	Type: 'Series',
	Source: 'local',
	ChildCount: 0,
	Genres: ['Drama'],
	ProductionYear: 2023,
	Overview: 'A fixture local series with no episodes.',
	Artwork: '/fixture-poster.svg',
	UserData: {},
};
const playableStreamed = {
	Id: '91000000-0000-4000-8000-000000000003',
	Name: 'Streamed Playable',
	Type: 'Series',
	Source: 'streamed',
	Provider: 'Fixture catalogue',
	Genres: ['Drama'],
	ProductionYear: 2024,
	Overview: 'A fixture streamed series with playable episodes.',
	Artwork: '/fixture-poster.svg',
	UserData: {},
};
const emptyStreamed = {
	Id: '91000000-0000-4000-8000-000000000004',
	Name: 'Streamed Empty',
	Type: 'Series',
	Source: 'streamed',
	Provider: 'Fixture catalogue',
	Genres: ['Drama'],
	ProductionYear: 2022,
	Overview: 'A fixture streamed series with no available episodes.',
	Artwork: '/fixture-poster.svg',
	UserData: {},
};
const playableMovie = {
	Id: '92000000-0000-4000-8000-000000000001',
	Name: 'Film Playable',
	Type: 'Movie',
	Source: 'local',
	Genres: ['Drama'],
	ProductionYear: 2024,
	RunTimeTicks: 7200 * 1e7,
	Overview: 'A fixture film used by the bounded-poll scenario.',
	Artwork: '/fixture-poster.svg',
	UserData: {},
};
const episodes = [
	{ Id: '93000000-0000-4000-8000-000000000001', Name: 'First episode', Type: 'Episode', Source: 'local', SeriesId: playableLocal.Id, SeriesName: playableLocal.Name, ParentIndexNumber: 1, IndexNumber: 1, RunTimeTicks: 2400 * 1e7, Artwork: '/fixture-poster.svg', UserData: {} },
	{ Id: '93000000-0000-4000-8000-000000000002', Name: 'Second episode', Type: 'Episode', Source: 'streamed', SeriesId: playableStreamed.Id, SeriesName: playableStreamed.Name, ParentIndexNumber: 1, IndexNumber: 2, RunTimeTicks: 2400 * 1e7, Artwork: '/fixture-poster.svg', UserData: {} },
];
const catalogue = new Map([playableLocal, emptyLocal, playableStreamed, emptyStreamed, playableMovie].map(item => [item.Id, item]));
const emptySeriesTitles = [emptyLocal.Name, emptyStreamed.Name];

const fixture = {
	mode: 'normal',
	itemsCalls: new Map(),
	homeCalls: 0,
	detailRequests: [],
	episodeRequests: [],
	searchRequests: [],
	discoverRequests: [],
	playTargetRequests: [],
	playRequests: [],
	consoleErrors: [],
	logErrors: [],
};
function resetFixture(mode = 'normal') {
	fixture.mode = mode;
	fixture.itemsCalls = new Map();
	fixture.homeCalls = 0;
}
function itemsCallCount(type, search = '') {
	return fixture.itemsCalls.get(type + '|' + search) || 0;
}
function availability(pending, queued, checked) {
	return { pending, queued, checked };
}
function verifiedList(items) {
	const ids = new Set(items.map(item => item.Id));
	if (ids.has(emptyLocal.Id) || ids.has(emptyStreamed.Id)) throw new Error('Fixture bug: an empty series reached a verified watch list.');
	return items;
}

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
function sendJson(response, value, status = 200) {
	response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
	response.end(JSON.stringify(value));
}
function sendPng(response) {
	response.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': png.length, 'Cache-Control': 'no-store' });
	response.end(png);
}
async function readJsonBody(request) {
	let body = '';
	for await (const chunk of request) body += chunk;
	try { return JSON.parse(body || '{}'); } catch { return {}; }
}
function seriesByName(names, term) {
	const value = String(term || '').toLowerCase();
	return names.filter(item => item.Name.toLowerCase().includes(value));
}

async function handleApi(url, request, response) {
	const path = url.pathname;
	const method = request.method || 'GET';
	if (path === '/fixture/reset') { resetFixture(url.searchParams.get('mode') || 'normal'); sendJson(response, { ok: true }); return; }
	if (path === '/api/version') { sendJson(response, { version: '0.27.0' }); return; }
	if (path === '/api/capabilities') { sendJson(response, { canShare: false, playbackDefaults: { englishSubtitles: false, autoNext: false, skipIntros: false } }); return; }
	if (path === '/api/auth/status') {
		sendJson(response, { local: true, home: false, person: { id: 'person-1', name: 'Local Viewer' }, authenticated: true, email: null, localPlayback: null });
		return;
	}
	if (path === '/api/auth/tunnel') { sendJson(response, {}); return; }
	if (path === '/api/auth/logout') { sendJson(response, { ok: true }); return; }
	if (path === '/api/status') { sendJson(response, { connected: true, features: { discover: true, comingSoon: false, live: false, recordings: false } }); return; }
	if (path === '/api/libraries') {
		sendJson(response, [
			{ Id: 'local-movies', Name: 'Films', CollectionType: 'movies' },
			{ Id: 'local-tv', Name: 'Series', CollectionType: 'tvshows' },
		]);
		return;
	}
	if (path === '/api/favourites' || path === '/api/favourites/home') { sendJson(response, { own: { id: 'me', name: 'My favourites', items: [] } }); return; }
	if (path === '/api/viewing-status') { sendJson(response, { blocked: false, remainingSeconds: null }); return; }
	if (path === '/api/coming-soon') { sendJson(response, { movies: [], tv: [] }); return; }
	if (path === '/api/web/releases' || path === '/api/web/releases/tv') { sendJson(response, { items: [] }); return; }
	if (path === '/api/web/items') {
		const type = url.searchParams.get('type') || 'all';
		const search = url.searchParams.get('search') || '';
		const key = type + '|' + search;
		const call = (fixture.itemsCalls.get(key) || 0) + 1;
		fixture.itemsCalls.set(key, call);
		if (type === 'movies' && fixture.mode === 'endless') {
			sendJson(response, { items: verifiedList([playableMovie]), total: 1, genres: ['Drama'], availability: availability(1, 1, 0) });
			return;
		}
		if (search) {
			const matches = seriesByName([playableLocal, playableStreamed], search);
			sendJson(response, { items: verifiedList(matches), total: matches.length, genres: ['Drama'], availability: availability(0, 0, 0), hasMore: false });
			return;
		}
		if (type === 'tvshows' && (fixture.mode === 'normal' || fixture.mode === 'cancel')) {
			if (call === 1) {
				sendJson(response, { items: verifiedList([playableLocal]), total: 1, genres: ['Drama'], availability: availability(2, 2, 0), hasMore: false });
				return;
			}
			sendJson(response, { items: verifiedList([playableLocal, playableStreamed]), total: 2, genres: ['Drama'], availability: availability(0, 0, 2), hasMore: true });
			return;
		}
		sendJson(response, { items: verifiedList([playableLocal, playableStreamed]), total: 2, genres: ['Drama'], availability: availability(0, 0, 0), hasMore: false });
		return;
	}
	if (path === '/api/web/home') {
		fixture.homeCalls += 1;
		const hero = { ...playableLocal, _reason: 'Picked for you' };
		if (fixture.mode === 'home' && fixture.homeCalls === 1) {
			sendJson(response, {
				personalized: true, coldStart: false, generatedAt: '2026-11-12T09:00:00.000Z',
				rows: [{ id: 'new', title: 'Recently added', note: 'New in the collection and streamed catalogue', items: [playableLocal] }],
				featured: [hero],
				availability: availability(1, 1, 1),
			});
			return;
		}
		sendJson(response, {
			personalized: true, coldStart: false, generatedAt: '2026-11-12T09:00:00.000Z',
			rows: [{ id: 'new', title: 'Recently added', note: 'New in the collection and streamed catalogue', items: [playableLocal, playableStreamed] }],
			featured: [hero],
			availability: availability(0, 0, 2),
		});
		return;
	}
	// Search keeps unavailable metadata. Only normal watch lists are filtered.
	if (path === '/api/search') {
		const scope = url.searchParams.get('scope') || 'available';
		const term = url.searchParams.get('q') || '';
		fixture.searchRequests.push({ scope, term });
		if (scope === 'available') {
			// The real server list filters zero-episode local series; a known
			// unavailable streamed title remains discoverable in the search fixture.
			const items = seriesByName([emptyStreamed], term);
			sendJson(response, { items, total: items.length, page: 1, pages: 1, genres: ['Drama'] });
			return;
		}
		sendJson(response, { items: [], total: 0, page: 1, pages: 1 });
		return;
	}
	if (path === '/api/discover') {
		fixture.discoverRequests.push(url.search);
		sendJson(response, {
			items: [{
				id: 404,
				type: 'tv',
				title: emptyStreamed.Name,
				date: '2022-05-01',
				overview: 'A discovery fixture for a title with no playable episodes.',
				ratings: [],
				statusLabel: 'Available',
				vodId: emptyStreamed.Id,
				vodAvailable: true,
			}],
			page: 1,
			pages: 1,
		});
		return;
	}
	if (path === '/api/discover/tv/404') {
		sendJson(response, {
			id: 404,
			type: 'tv',
			title: emptyStreamed.Name,
			date: '2022-05-01',
			overview: 'A discovery fixture for a title with no playable episodes.',
			ratings: [],
			statusLabel: 'Available',
			vodId: emptyStreamed.Id,
			vodAvailable: true,
			requestable: false,
			seasons: [],
		});
		return;
	}

	const similarMatch = /^\/api\/web\/items\/([^/]+)\/similar$/.exec(path);
	if (similarMatch) { sendJson(response, { items: [] }); return; }
	const episodesMatch = /^\/api\/web\/items\/([^/]+)\/episodes$/.exec(path);
	if (episodesMatch) {
		const id = decodeURIComponent(episodesMatch[1]);
		fixture.episodeRequests.push(id);
		if (id === playableLocal.Id) { sendJson(response, { items: episodes.filter(episode => episode.Source === 'local'), notice: '' }); return; }
		if (id === playableStreamed.Id) { sendJson(response, { items: episodes.filter(episode => episode.Source === 'streamed'), notice: '' }); return; }
		sendJson(response, { items: [], notice: '' });
		return;
	}
	const playTargetMatch = /^\/api\/web\/play-target\/([^/]+)$/.exec(path);
	if (playTargetMatch) {
		const id = decodeURIComponent(playTargetMatch[1]);
		fixture.playTargetRequests.push(id);
		sendJson(response, { error: 'Everything available in this series has been watched.', code: 'SERIES_COMPLETE' }, 409);
		return;
	}
	const itemMatch = /^\/api\/web\/items\/([^/]+)$/.exec(path);
	if (itemMatch) {
		const id = decodeURIComponent(itemMatch[1]);
		fixture.detailRequests.push(id);
		const item = catalogue.get(id);
		if (item) sendJson(response, item);
		else sendJson(response, { error: 'Fixture item not found.' }, 404);
		return;
	}
	if ((path === '/api/play' && method === 'POST') || (path === '/api/play-target' && method === 'POST')) {
		const body = await readJsonBody(request);
		fixture.playRequests.push({ path, body });
		sendJson(response, { error: 'The browser regression must never start playback.' }, 500);
		return;
	}
	if (path.startsWith('/api/')) { sendJson(response, {}); return; }
	sendJson(response, { error: 'Fixture API route not configured: ' + path }, 404);
}

const htmlRoutes = new Map([
	['/', 'index.html'],
	['/search', 'search.html'],
	['/discover', 'discover.html'],
]);
const server = createServer(async (request, response) => {
	const url = new URL(request.url || '/', 'http://127.0.0.1');
	if (url.pathname === '/fixture-poster.svg') {
		response.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Content-Length': posterSvg.length, 'Cache-Control': 'no-store' });
		response.end(posterSvg);
		return;
	}
	if (url.pathname === '/vendor/hls.min.js') {
		response.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
		response.end('window.Hls = window.Hls || {};');
		return;
	}
	if (url.pathname.startsWith('/api/')) {
		try { await handleApi(url, request, response); }
		catch (error) { if (!response.headersSent) sendJson(response, { error: error.message }, 500); }
		return;
	}
	if (url.pathname.startsWith('/images/') || url.pathname.startsWith('/api/web/art/')) { sendPng(response); return; }
	const mapped = htmlRoutes.get(url.pathname);
	const file = mapped ? join(publicDirectory, mapped) : join(publicDirectory, url.pathname.replace(/^\//, ''));
	if (!file.startsWith(publicDirectory) || !existsSync(file)) {
		response.writeHead(404, { 'Content-Type': 'text/plain' });
		response.end('not found');
		return;
	}
	response.writeHead(200, {
		'Content-Type': contentTypes[extname(file)] || 'application/octet-stream',
		'Cache-Control': 'no-store',
		// Match production so the 116 return-state contract is exercised.
		'Referrer-Policy': 'no-referrer',
	});
	response.end(readFileSync(file));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = 'http://127.0.0.1:' + server.address().port;

const profile = mkdtempSync(join(tmpdir(), 'tellybox-playable-117-'));
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

const results = {
	fixtureOnly: true,
	livePlayback: false,
	providerRequests: false,
	checks: {},
	scenarios: {},
};
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
	on('Runtime.exceptionThrown', params => {
		const value = params?.exceptionDetails?.exception?.description || params?.exceptionDetails?.text;
		if (value) fixture.consoleErrors.push(String(value).split('\n')[0]);
	});
	on('Runtime.consoleAPICalled', params => {
		if (params?.type !== 'error') return;
		const text = (params.args || []).map(argument => argument.value ?? argument.description ?? '').join(' ');
		if (text) fixture.consoleErrors.push(text.split('\n')[0]);
	});
	on('Log.entryAdded', params => {
		if (params?.entry?.level === 'error') fixture.logErrors.push(String(params.entry.text || '').split('\n')[0] + ' | ' + String(params.entry.url || ''));
	});
	await send('Page.enable');
	await send('Runtime.enable');
	await send('Log.enable');
	await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });

	const evaluate = async expression => {
		const response = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
		if (response.exceptionDetails) {
			const description = response.exceptionDetails.exception?.description || response.exceptionDetails.text || 'evaluation failed';
			throw new Error(description.split('\n')[0]);
		}
		return response.result.value;
	};
	const waitFor = async (expression, timeout = 12000, label = expression) => {
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
	const waitNode = async (predicate, timeout = 12000, label = 'fixture request') => {
		const deadline = Date.now() + timeout;
		while (Date.now() < deadline) {
			if (predicate()) return true;
			await sleep(40);
		}
		throw new Error('Timed out waiting for ' + label);
	};
	const navigate = async url => {
		await send('Page.navigate', { url });
		await waitFor("document.readyState === 'complete'", 15000, 'page load ' + url);
	};
	const seriesState = () => evaluate(`(() => {
		const status = document.querySelector('#status');
		return {
			names: [...document.querySelectorAll('#grid .card h3')].map(node => node.textContent),
			status: status?.textContent || '',
			statusHidden: Boolean(status?.hidden),
			loadMoreHidden: Boolean(document.querySelector('#loadMore')?.hidden),
			count: document.querySelector('#count')?.textContent || ''
		};
	})()`);
	const homeState = () => evaluate(`(() => {
		const status = document.querySelector('#homeFeedStatus');
		return {
			names: [...document.querySelectorAll('#homeRows .home-tile h3')].map(node => node.textContent),
			status: status?.textContent || '',
			statusHidden: Boolean(status?.hidden),
			heroVisible: Boolean(document.querySelector('#homeHero')) && !document.querySelector('#homeHero').hidden,
			heroTitle: document.querySelector('#homeHeroTitle')?.textContent || '',
			feedVisible: Boolean(document.querySelector('#homeFeed')) && !document.querySelector('#homeFeed').hidden
		};
	})()`);

	let checksPassed = true;
	const check = (name, condition, detail) => {
		results.checks[name] = { pass: Boolean(condition), detail };
		if (!condition) checksPassed = false;
	};

	// 1. Home feed: the first paint keeps its rows and hero, shows the checking
	//    notice while pending, and clears it after the background retry.
	resetFixture('home');
	await navigate(origin + '/');
	await waitFor("document.querySelectorAll('#homeRows .home-tile').length === 1", 15000, 'Home first paint row');
	const homeFirst = await homeState();
	check('home first paint has a row', homeFirst.names.length === 1 && homeFirst.names[0] === playableLocal.Name, homeFirst.names);
	check('home first paint keeps featured hero', homeFirst.heroVisible === true && homeFirst.heroTitle === playableLocal.Name, homeFirst.heroTitle);
	check('home checking notice while pending', homeFirst.statusHidden === false && homeFirst.status.trim() === 'Checking availability for more titles...', homeFirst.status);
	check('home first paint never shows empty series', !homeFirst.names.some(name => emptySeriesTitles.includes(name)), homeFirst.names);
	await waitFor("(() => { const status = document.querySelector('#homeFeedStatus'); return document.querySelectorAll('#homeRows .home-tile').length === 2 && status && status.hidden; })()", 15000, 'Home verified retry');
	const homeVerified = await homeState();
	check('home retry adds the verified series', JSON.stringify(homeVerified.names) === JSON.stringify([playableLocal.Name, playableStreamed.Name]), homeVerified.names);
	check('home checking notice clears after verified response', homeVerified.statusHidden === true, homeVerified.status);
	check('home keeps the featured hero after retry', homeVerified.heroVisible === true && homeVerified.heroTitle === playableLocal.Name, homeVerified.heroTitle);
	check('home retry never shows empty series', !homeVerified.names.some(name => emptySeriesTitles.includes(name)), homeVerified.names);
	check('home availability retry is bounded', fixture.homeCalls >= 2 && fixture.homeCalls <= 3, fixture.homeCalls);
	results.scenarios.home = { homeRequests: fixture.homeCalls, firstPaint: homeFirst, afterRetry: homeVerified };

	// 2. Normal Series list: short first page with pending, then verified cards.
	resetFixture('normal');
	await navigate(origin + '/?view=tvshows');
	await waitFor("(() => { const status = document.querySelector('#status'); return document.querySelectorAll('#grid .card').length === 1 && status && !status.hidden && status.textContent.trim() === 'Checking availability for more titles...'; })()", 15000, 'Series checking state');
	const seriesFirst = await seriesState();
	check('series first page shows only the verified card', JSON.stringify(seriesFirst.names) === JSON.stringify([playableLocal.Name]), seriesFirst.names);
	check('series first page never shows the empty local series', !seriesFirst.names.includes(emptyLocal.Name), seriesFirst.names);
	check('series first page never shows the empty streamed series', !seriesFirst.names.includes(emptyStreamed.Name), seriesFirst.names);
	check('series checking status shown while pending', seriesFirst.status.trim() === 'Checking availability for more titles...', seriesFirst.status);
	check('series checking status is visible', seriesFirst.statusHidden === false, seriesFirst.statusHidden);
	await waitFor("(() => { const status = document.querySelector('#status'); return document.querySelectorAll('#grid .card').length === 2 && status && status.hidden; })()", 15000, 'Series verified state');
	const seriesVerified = await seriesState();
	check('series verified list shows both playable cards', JSON.stringify(seriesVerified.names) === JSON.stringify([playableLocal.Name, playableStreamed.Name]), seriesVerified.names);
	check('series verified list has no empty local series', !seriesVerified.names.includes(emptyLocal.Name), seriesVerified.names);
	check('series verified list has no empty streamed series', !seriesVerified.names.includes(emptyStreamed.Name), seriesVerified.names);
	check('series checking status disappears', seriesVerified.statusHidden === true, seriesVerified.status);
	check('series hasMore keeps Load more visible', seriesVerified.loadMoreHidden === false, seriesVerified.loadMoreHidden);
	check('series pending poll is exactly one re-request', itemsCallCount('tvshows') === 2, itemsCallCount('tvshows'));
	check('series count follows verified total', seriesVerified.count === '2', seriesVerified.count);
	results.scenarios.series = { requests: itemsCallCount('tvshows'), firstPage: seriesFirst, verified: seriesVerified };

	// 3. A changed search cancels the pending poll; stale results must not
	//    overwrite the newer generation or add duplicate cards.
	resetFixture('cancel');
	await navigate(origin + '/?view=tvshows');
	await waitFor("(() => { const status = document.querySelector('#status'); return document.querySelectorAll('#grid .card').length === 1 && status && !status.hidden && status.textContent.includes('Checking availability'); })()", 15000, 'cancel scenario pending state');
	await evaluate("(() => { const input = document.querySelector('#search'); input.value = 'Streamed'; input.dispatchEvent(new Event('input')); return true; })()");
	await waitFor("(() => document.querySelectorAll('#grid .card').length === 1 && document.querySelector('#grid .card h3')?.textContent === 'Streamed Playable')()", 12000, 'search result');
	await sleep(2600);
	const afterSearch = await seriesState();
	check('new search replaces the pending page', JSON.stringify(afterSearch.names) === JSON.stringify([playableStreamed.Name]), afterSearch.names);
	check('cancelled poll adds no stale local card', !afterSearch.names.includes(playableLocal.Name), afterSearch.names);
	check('cancelled poll never re-requests the old page', itemsCallCount('tvshows') === 1, itemsCallCount('tvshows'));
	check('search generation request was made once', itemsCallCount('tvshows', 'Streamed') === 1, itemsCallCount('tvshows', 'Streamed'));
	results.scenarios.cancelledPoll = { unsearchedRequests: itemsCallCount('tvshows'), searchRequests: itemsCallCount('tvshows', 'Streamed'), finalGrid: afterSearch };

	// 4. Polling is bounded when the server keeps reporting pending.
	resetFixture('endless');
	await navigate(origin + '/?view=movies');
	await waitFor("(() => { const status = document.querySelector('#status'); return document.querySelector('#grid .card h3')?.textContent === 'Film Playable' && status && !status.hidden && status.textContent.includes('Checking availability'); })()", 15000, 'endless pending state');
	await sleep(10500);
	const endless = await seriesState();
	check('endless pending stops after initial request plus five polls', itemsCallCount('movies') === 6, itemsCallCount('movies'));
	check('endless pending keeps the verified card', JSON.stringify(endless.names) === JSON.stringify([playableMovie.Name]), endless.names);
	check('endless pending ends with a precise longer-than-expected notice', endless.status.includes('Checking availability for more titles...') && endless.status.includes('taking longer than expected'), endless.status);
	await sleep(2200);
	check('endless pending does not resume polling later', itemsCallCount('movies') === 6, itemsCallCount('movies'));
	results.scenarios.boundedPoll = { requests: itemsCallCount('movies'), final: endless };

	// 5. Discover still lists unavailable metadata and never starts playback.
	resetFixture('normal');
	await navigate(origin + '/discover?type=tv');
	await waitFor("(() => [...document.querySelectorAll('#discoverGrid .discover-card strong')].some(node => node.textContent === 'Streamed Empty'))()", 15000, 'Discover unavailable title');
	const discoverCard = await evaluate(`(() => {
		const card = [...document.querySelectorAll('#discoverGrid .discover-card')].find(node => node.querySelector('strong')?.textContent === '${emptyStreamed.Name}');
		return card ? { text: card.textContent, tag: card.tagName } : null;
	})()`);
	check('discover lists the unavailable streamed series', Boolean(discoverCard), discoverCard);
	check('discover card is metadata, not a play control', discoverCard?.tag === 'BUTTON' && !/^Play /i.test(discoverCard.text), discoverCard?.tag);
	await evaluate(`(() => {
		const card = [...document.querySelectorAll('#discoverGrid .discover-card')].find(node => node.querySelector('strong')?.textContent === '${emptyStreamed.Name}');
		card?.click();
		return true;
	})()`);
	await waitFor("document.querySelector('#requestDetails')?.open === true && document.querySelector('#requestBody h2')?.textContent === 'Streamed Empty'", 12000, 'Discover detail');
	await sleep(250);
	const discoverDetail = await evaluate(`(() => {
		const body = document.querySelector('#requestBody');
		const links = [...body.querySelectorAll('a.button')].map(node => ({ text: node.textContent, href: node.getAttribute('href') }));
		return { title: body.querySelector('h2')?.textContent || '', links, buttons: [...body.querySelectorAll('button')].map(node => node.textContent) };
	})()`);
	check('discover detail opens without playback', discoverDetail.title === emptyStreamed.Name, discoverDetail.title);
	check('discover detail offers a details link, not a play button', discoverDetail.links.some(link => link.href?.includes('item=' + emptyStreamed.Id)), discoverDetail.links);
	check('discover detail did not start playback', fixture.playRequests.length === 0, fixture.playRequests);
	check('discover detail did not resolve a play target', fixture.playTargetRequests.length === 0, fixture.playTargetRequests);
	results.scenarios.discover = { card: discoverCard, detail: discoverDetail };
	// Following the details link must open the empty series state, not play it.
	await evaluate(`(() => {
		const link = [...document.querySelectorAll('#requestBody a.button')].find(node => (node.getAttribute('href') || '').includes('item=' + encodeURIComponent('${emptyStreamed.Id}')));
		link?.click();
		return true;
	})()`);
	await waitFor("document.querySelector('#details')?.open === true && document.querySelector('#detailsTitle')?.textContent === 'Streamed Empty'", 15000, 'Discover details link');
	await waitFor("document.querySelector('#detailsBody .episode-list')?.textContent.includes('No episodes are available for this series yet.')", 12000, 'Discover empty series state');
	check('discover details link opens episodes, not playback', fixture.playRequests.length === 0 && fixture.playTargetRequests.length === 0, { plays: fixture.playRequests, targets: fixture.playTargetRequests });

	// 6. Search keeps the unavailable title; following it opens details, not playback.
	resetFixture('normal');
	await navigate(origin + '/search?q=Empty');
	await waitFor("(() => { const names = [...document.querySelectorAll('#availableSection .discover-card strong')].map(node => node.textContent); return names.includes('Streamed Empty') && !names.includes('Local Empty'); })()", 15000, 'Search unavailable title');
	const searchCards = await evaluate(`(() => [...document.querySelectorAll('#availableSection .discover-card')].map(card => ({
		name: card.querySelector('strong')?.textContent || '',
		action: card.querySelector('.search-action')?.textContent || '',
		href: card.getAttribute('href') || '',
		tag: card.tagName
	})))()`);
	const searchEmpty = searchCards.find(card => card.name === emptyStreamed.Name);
	check('search does not list a known-empty local series', !searchCards.some(card => card.name === emptyLocal.Name), searchCards.map(card => card.name));
	check('search lists the unavailable streamed series', Boolean(searchEmpty), searchCards.map(card => card.name));
	check('search unavailable title has no play action label', Boolean(searchEmpty) && !/^Play /i.test(searchEmpty.action) && !/^Play /i.test(searchEmpty.href), searchEmpty?.action);
	check('search unavailable title links to details', searchEmpty?.tag === 'A' && searchEmpty.href === '/?item=' + emptyStreamed.Id + '&from=search', searchEmpty?.href);
	await evaluate(`(() => {
		const card = [...document.querySelectorAll('#availableSection .discover-card')].find(node => node.querySelector('strong')?.textContent === '${emptyStreamed.Name}');
		card?.click();
		return true;
	})()`);
	await waitFor("document.querySelector('#details')?.open === true && document.querySelector('#detailsTitle')?.textContent === 'Streamed Empty'", 15000, 'Search hand-off details');
	await waitFor("document.querySelector('#detailsBody .episode-list')?.textContent.includes('No episodes are available for this series yet.')", 12000, 'empty series details state');
	const handoff = await evaluate(`(() => ({
		title: document.querySelector('#detailsTitle')?.textContent || '',
		episodeList: document.querySelector('#detailsBody .episode-list')?.textContent || '',
		playButtons: [...document.querySelectorAll('#detailsBody button.primary')].map(node => node.textContent)
	}))()`);
	check('search hand-off opens the unavailable title details', handoff.title === emptyStreamed.Name, handoff.title);
	check('search hand-off shows the informative empty state', handoff.episodeList.includes('No episodes are available for this series yet. It may appear later; try again.'), handoff.episodeList);
	check('search hand-off offers no play button for the empty series', !handoff.playButtons.some(text => /Play/i.test(text)), handoff.playButtons);
	check('search hand-off did not start playback', fixture.playRequests.length === 0, fixture.playRequests);
	check('search hand-off did not resolve a play target', fixture.playTargetRequests.length === 0, fixture.playTargetRequests);
	results.scenarios.search = { cards: searchCards, handoff };

	await sleep(400);
	check('no console errors', fixture.consoleErrors.length === 0, fixture.consoleErrors);
	check('no browser log errors', fixture.logErrors.length === 0, fixture.logErrors);

	results.ok = checksPassed;
	results.fixture = {
		playableLocal: { id: playableLocal.Id, name: playableLocal.Name },
		emptyLocal: { id: emptyLocal.Id, name: emptyLocal.Name },
		playableStreamed: { id: playableStreamed.Id, name: playableStreamed.Name },
		emptyStreamed: { id: emptyStreamed.Id, name: emptyStreamed.Name },
	};
	results.requests = {
		lastScenarioItems: Object.fromEntries(fixture.itemsCalls),
		lastScenarioHome: fixture.homeCalls,
		search: fixture.searchRequests,
		discover: fixture.discoverRequests,
		details: fixture.detailRequests,
		episodes: fixture.episodeRequests,
		playTargets: fixture.playTargetRequests,
		plays: fixture.playRequests,
	};
	results.consoleErrors = fixture.consoleErrors;
	results.logErrors = fixture.logErrors;
	console.log(JSON.stringify(results, null, 2));
	process.exitCode = checksPassed ? 0 : 1;
	socket.close();
} catch (error) {
	results.ok = false;
	results.error = error.message;
	results.checks = results.checks || {};
	results.consoleErrors = fixture.consoleErrors;
	results.logErrors = fixture.logErrors;
	console.log(JSON.stringify(results, null, 2));
	process.exitCode = 1;
} finally {
	child.kill();
	await sleep(700);
	try { rmSync(profile, { recursive: true, force: true }); } catch {}
	server.closeAllConnections();
	server.close();
}
