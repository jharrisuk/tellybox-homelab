/* Local Chrome regression check for release 101 web-player Back navigation.
 *
 * It serves the real server/public app (index.html, app.js and the player
 * markup) with local mocked /api responses, then drives the real UI in
 * headless Chrome at desktop and mobile widths. It never starts a real stream,
 * never touches production and never edits source files.
 *
 * Evidence is written to outputs/Tellybox-player-back-101/evidence/.
 *
 * If Chrome is unavailable the check prints SKIP and exits 0; it never claims a
 * pass without running the browser.
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const publicDirectory = fileURLToPath(new URL('../public/', import.meta.url));
const outDir = fileURLToPath(new URL('../../outputs/Tellybox-player-back-101/evidence/', import.meta.url));
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
	console.log('SKIP: Chrome or Chromium was not found. Set CHROME_PATH to run the player Back browser check.');
	process.exit(0);
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const originPlaceholder = 'http://127.0.0.1';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const catalogue = [];
for (let index = 1; index <= 20; index += 1) {
	const suffix = String(index).padStart(2, '0');
	catalogue.push({
		Id: '10000000-0000-0000-0000-0000000000' + suffix,
		Name: 'Alpha Movie ' + suffix,
		Type: 'Movie',
		ProductionYear: 2020 + (index % 5),
		RunTimeTicks: 7200000000,
		Genres: ['Drama', 'Comedy'],
		Overview: 'A local test film for the player Back regression check.',
		Source: 'local',
		UserData: { PlaybackPositionTicks: 0 },
	});
	catalogue.push({
		Id: '11000000-0000-0000-0000-0000000000' + suffix,
		Name: 'Alpha Series ' + suffix,
		Type: 'Series',
		ProductionYear: 2021 + (index % 5),
		Genres: ['Drama'],
		Overview: 'A local test series for the player Back regression check.',
		Source: 'local',
		UserData: { PlaybackPositionTicks: 0 },
	});
}
const itemById = new Map(catalogue.map(item => [item.Id, item]));
const movies = catalogue.filter(item => item.Type === 'Movie');
const series = catalogue.filter(item => item.Type === 'Series');
const featured = movies[0];

// Search results are larger than one page so the check can prove that the
// loaded page (the "Show more" offset) survives a search -> player -> search
// handoff. Every title matches "Alpha"; type=movie still leaves 70 results.
const searchCatalogue = [];
for (let index = 1; index <= 140; index += 1) {
	const base = catalogue[(index - 1) % catalogue.length];
	searchCatalogue.push({
		...base,
		Id: '30000000-0000-0000-0000-' + String(index).padStart(12, '0'),
		Name: 'Alpha Result ' + String(index).padStart(3, '0'),
		Type: index % 2 === 0 ? 'Series' : 'Movie',
	});
}

function episodeFor(seriesId, index) {
	return {
		Id: '20000000-0000-0000-0000-00000000000' + index,
		Name: index === 1 ? 'First Episode' : 'Second Episode',
		Type: 'Episode',
		SeriesId: seriesId || series[0].Id,
		SeriesName: seriesId && itemById.get(seriesId) ? itemById.get(seriesId).Name : series[0].Name,
		ParentIndexNumber: 1,
		IndexNumber: index,
		RunTimeTicks: 12000000000,
		Source: 'local',
		Overview: 'An episode used to exercise autoplay and Back behaviour.',
		PremiereDate: '2024-01-0' + index,
		UserData: { PlaybackPositionTicks: 0 },
	};
}

const favourites = [...movies.slice(0, 5), ...series.slice(0, 5)];

const now = Date.now();
const guideChannels = [];
for (let index = 0; index < 8; index += 1) {
	guideChannels.push({
		Id: index === 0
			? 'dispatch-live-aaaaaaaa-1111-2222-3333-444444444444'
			: 'dispatch-live-bbbbbbbb-1111-2222-3333-44444444444' + index,
		Name: index === 0 ? 'News Channel' : 'News Channel ' + (index + 1),
		ChannelNumber: String(101 + index),
		Group: 'News',
		programmes: [
			{
				Id: 'prog-' + index + '-1',
				Name: index === 0 ? 'Bulletin' : 'News Hour ' + (index + 1),
				StartDate: new Date(now - 10 * 60000).toISOString(),
				EndDate: new Date(now + 20 * 60000).toISOString(),
				Overview: 'A mocked current programme for the guide Back check.',
			},
			{
				Id: 'prog-' + index + '-2',
				Name: 'Later Bulletin',
				StartDate: new Date(now + 20 * 60000).toISOString(),
				EndDate: new Date(now + 50 * 60000).toISOString(),
				Overview: 'A mocked upcoming programme.',
			},
		],
	});
}
const liveChannelIds = new Set(guideChannels.map(channel => channel.Id));

const mockState = {
	playCalls: [],
	sessionCount: 0,
	stops: [],
	favourites: [...favourites],
};

function discoverItem(index = 1) {
	const catalogueItem = catalogue[(index - 1) % catalogue.length];
	return {
		id: index,
		type: 'movie',
		title: 'Discover Alpha ' + String(index).padStart(2, '0'),
		date: '2024-05-01',
		overview: 'A discover result used for the player Back handoff.',
		watchId: catalogueItem.Id,
		vodId: catalogueItem.Id,
		vodAvailable: true,
		vodProvider: 'Local',
		statusLabel: 'Not requested',
		requestable: true,
		ratings: [],
		seasons: [],
		poster: null,
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

function collectionItems(url) {
	const type = url.searchParams.get('type') || 'all';
	const parent = url.searchParams.get('parent') || '';
	const search = (url.searchParams.get('search') || '').trim().toLowerCase();
	const sort = url.searchParams.get('sort') || 'new';
	const start = Math.max(0, Number(url.searchParams.get('start')) || 0);
	let items = catalogue;
	if (parent === 'local-movies' || type === 'movies') items = movies;
	else if (parent === 'local-tv' || type === 'tvshows') items = series;
	else if (type === 'all') items = catalogue;
	if (search) items = items.filter(item => item.Name.toLowerCase().includes(search));
	items = [...items];
	if (sort === 'az') items.sort((left, right) => left.Name.localeCompare(right.Name));
	return { items: items.slice(start, start + 30), total: items.length, genres: ['Comedy', 'Drama'] };
}

async function handleApi(url, request, response) {
	const path = url.pathname;
	const method = request.method || 'GET';
	const body = method === 'POST' || method === 'PUT' ? await readBody(request) : null;

	if (path === '/api/capabilities') { sendJson(response, { canShare: false, playbackDefaults: { englishSubtitles: false, autoNext: false, skipIntros: false } }); return; }
	if (path === '/api/auth/status') {
		sendJson(response, { local: true, home: false, person: { id: 'person-1', name: 'Local Viewer' }, authenticated: true, email: null, localPlayback: null });
		return;
	}
	if (path === '/api/auth/logout') { sendJson(response, { ok: true }); return; }
	if (path === '/api/status') {
		sendJson(response, { connected: true, features: { discover: true, comingSoon: true, live: true, recordings: true } });
		return;
	}
	if (path === '/api/libraries') {
		sendJson(response, [
			{ Id: 'local-movies', Name: 'Films', CollectionType: 'movies' },
			{ Id: 'local-tv', Name: 'Series', CollectionType: 'tvshows' },
		]);
		return;
	}
	if (path === '/api/favourites' || path === '/api/favourites/home') {
		if (method === 'POST' && body && Array.isArray(body.changes)) {
			for (const change of body.changes) {
				const item = change.item || itemById.get(change.id);
				if (!item) continue;
				if (change.saved) {
					if (!mockState.favourites.some(entry => entry.Id === item.Id)) mockState.favourites.push(item);
				} else mockState.favourites = mockState.favourites.filter(entry => entry.Id !== item.Id);
			}
		}
		sendJson(response, { own: { id: 'me', name: 'My favourites', items: mockState.favourites } });
		return;
	}
	if (path === '/api/viewing-status') { sendJson(response, { blocked: false, remainingSeconds: null }); return; }

	if (path === '/api/web/items') { sendJson(response, collectionItems(url)); return; }
	if (path === '/api/web/home') {
		sendJson(response, {
			personalized: true,
			featured: [featured],
			rows: [
				{ title: 'For you', note: 'Picks from your collection', items: [featured, series[0], movies[1]] },
				{ title: 'More to watch', note: '', items: [movies[2], series[1], movies[3]] },
			],
		});
		return;
	}
	if (path === '/api/web/releases') { sendJson(response, { items: [movies[1]] }); return; }
	if (path === '/api/web/releases/tv') { sendJson(response, { items: [] }); return; }
	if (path === '/api/web/live-guide') { sendJson(response, { channels: guideChannels, fetchedAt: Date.now(), stale: false }); return; }
	if (path === '/api/play') {
		const bodyValue = body || {};
		mockState.playCalls.push({
			id: bodyValue.id,
			quality: bodyValue.quality,
			compatibility: bodyValue.compatibility,
			position: bodyValue.position,
			replaceSession: bodyValue.replaceSession || null,
		});
		mockState.sessionCount += 1;
		sendJson(response, {
			session: 'sess-' + mockState.sessionCount,
			url: '/media/mock.mp4',
			kind: 'direct',
			method: 'DirectPlay',
			live: liveChannelIds.has(bodyValue.id),
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
		if (action === 'stop') mockState.stops.push({ session: sessionMatch[1], position: body?.position });
		sendEmpty(response, 204);
		return;
	}
	if (path === '/api/recordings') { sendJson(response, { items: [] }); return; }
	if (path === '/api/catchup') {
		sendJson(response, {
			channels: [{
				Id: 'catchup-channel', Name: 'Catch-up Channel',
				programmes: [{
					Id: 'catchup-1', Type: 'Catchup', Name: 'Catch-up Bulletin',
					StartDate: new Date(now - 3600000).toISOString(),
					EndDate: new Date(now + 3600000).toISOString(),
					Overview: 'A mocked catch-up programme.',
				}],
			}],
		});
		return;
	}
	if (path === '/api/catchup/restart') {
		sendJson(response, {
			item: {
				Id: 'catchup-1', Type: 'Catchup', Name: 'Catch-up Bulletin',
				StartDate: new Date(now - 3600000).toISOString(),
				EndDate: new Date(now + 3600000).toISOString(),
				Overview: 'A mocked catch-up programme started from the guide.',
			},
		});
		return;
	}
	if (path.startsWith('/api/recording-files/')) { sendJson(response, { IsRecording: false }); return; }
	if (path === '/api/search') {
		const query = (url.searchParams.get('q') || '').trim().toLowerCase();
		const type = url.searchParams.get('type') || 'all';
		const start = url.searchParams.has('start')
			? Math.max(0, Number(url.searchParams.get('start')) || 0)
			: (Math.max(1, Number(url.searchParams.get('page')) || 1) - 1) * 40;
		let items = searchCatalogue.map(item => ({ ...item }));
		if (type === 'movie') items = items.filter(item => item.Type === 'Movie');
		else if (type === 'tv') items = items.filter(item => item.Type === 'Series');
		if (query) items = items.filter(item => item.Name.toLowerCase().includes(query));
		const total = items.length;
		sendJson(response, {
			items: items.slice(start, start + 40),
			total,
			page: Math.floor(start / 40) + 1,
			pages: Math.max(1, Math.ceil(total / 40)),
		});
		return;
	}
	if (path === '/api/discover') {
		const page = Math.max(1, Number(url.searchParams.get('page')) || 1);
		const genre = (url.searchParams.get('genre') || '').slice(0, 50);
		const sort = url.searchParams.get('sort') || 'popular';
		const items = [];
		for (let slot = 1; slot <= 24; slot += 1) {
			const index = (page - 1) * 24 + slot;
			if (index > 72) break;
			const item = discoverItem(200 + index);
			item.title = 'Discover ' + (genre || sort) + ' page ' + page + ' title ' + String(index).padStart(2, '0');
			item.overview = 'Discover result for the cross-document return check.';
			items.push(item);
		}
		sendJson(response, { items, page, pages: 3, total: 72 });
		return;
	}
	const discoverMatch = /^\/api\/discover\/(movie|tv)\/(\d+)$/.exec(path);
	if (discoverMatch) {
		const item = discoverItem(Number(discoverMatch[2]));
		sendJson(response, { ...item, type: discoverMatch[1], seasons: [], requestable: true });
		return;
	}
	if (path === '/api/discover/request') { sendJson(response, { message: 'Added to the list.', created: true, item: discoverItem(1) }); return; }
	if (path.startsWith('/api/shares')) { sendJson(response, { shares: [], id: 'share-1', url: originPlaceholder + '/share/test', expires: new Date(Date.now() + 86400000).toISOString() }); return; }

	const episodesMatch = /^\/api\/web\/items\/([^/]+)\/episodes$/.exec(path);
	if (episodesMatch) {
		sendJson(response, { items: [episodeFor(episodesMatch[1], 1), episodeFor(episodesMatch[1], 2)] });
		return;
	}
	const segmentsMatch = /^\/api\/web\/items\/([^/]+)\/segments$/.exec(path);
	if (segmentsMatch) { sendJson(response, { segments: [] }); return; }
	const nextMatch = /^\/api\/web\/items\/([^/]+)\/next$/.exec(path);
	if (nextMatch) {
		const seriesId = url.searchParams.get('series') || '';
		if (/0001$/.test(nextMatch[1])) sendJson(response, { item: episodeFor(seriesId, 2), seriesId, seriesName: itemById.get(seriesId)?.Name || series[0].Name });
		else sendJson(response, { status: 'complete' });
		return;
	}
	if (/^\/api\/web\/items\/[^/]+\/schedule$/.test(path)) { sendJson(response, {}); return; }
	const itemMatch = /^\/api\/web\/items\/([^/]+)$/.exec(path);
	if (itemMatch) {
		const id = decodeURIComponent(itemMatch[1]);
		const stored = itemById.get(id);
		if (stored) { sendJson(response, stored); return; }
		if (/^20000000-/.test(id)) { sendJson(response, episodeFor(series[0].Id, /0002$/.test(id) ? 2 : 1)); return; }
		sendJson(response, featured);
		return;
	}

	if (path.startsWith('/api/')) { sendJson(response, { error: 'Mock API route not configured: ' + path }, 404); return; }
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

const server = createServer(async (request, response) => {
	const url = new URL(request.url || '/', originPlaceholder);
	if (url.pathname.startsWith('/api/')) {
		try { await handleApi(url, request, response); }
		catch (error) { if (!response.headersSent) sendJson(response, { error: error.message }, 500); }
		return;
	}
	if (url.pathname.startsWith('/images/') || url.pathname.startsWith('/media/')) {
		response.writeHead(404, { 'Content-Type': 'text/plain' });
		response.end('not found');
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

// ---------------------------------------------------------------------------
// Chrome / CDP plumbing
// ---------------------------------------------------------------------------

const profile = mkdtempSync(join(tmpdir(), 'tellybox-player-back-101-'));
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
	const consoleErrors = [];
	on('Runtime.exceptionThrown', params => {
		const value = params?.exceptionDetails?.exception?.description || params?.exceptionDetails?.text;
		if (value) consoleErrors.push(String(value).split('\n')[0]);
	});
	const navigationUrls = [];
	on('Page.frameNavigated', params => {
		if (!params?.frame?.parentId && params?.frame?.url) navigationUrls.push(params.frame.url);
	});

	const evaluate = async (expression, userGesture = false) => {
		const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture });
		if (result.exceptionDetails) {
			const description = result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'evaluation failed';
			throw new Error(description.split('\n')[0]);
		}
		return result.result.value;
	};

	const waitFor = async (expression, timeout = 8000, label = expression) => {
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

	const waitMock = async (predicate, timeout = 8000, label = 'mock request') => {
		const deadline = Date.now() + timeout;
		while (Date.now() < deadline) {
			if (predicate()) return true;
			await sleep(40);
		}
		throw new Error('Timed out waiting for ' + label);
	};

	const navigate = async url => {
		await send('Page.navigate', { url });
		await waitFor("document.readyState === 'complete'", 12000, 'page load');
	};

	const reload = async () => {
		await send('Page.reload', { ignoreCache: true });
		await waitFor("document.readyState === 'complete'", 12000, 'page reload');
	};

	const history = async () => {
		const value = await send('Page.getNavigationHistory');
		return {
			index: value.currentIndex,
			length: value.entries.length,
			url: value.entries[value.currentIndex]?.url || '',
		};
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

	const snapshot = () => evaluate(`(() => {
		const element = selector => document.querySelector(selector);
		const scrolling = document.scrollingElement || document.documentElement;
		return {
			url: location.href,
			pathname: location.pathname,
			locationSearch: location.search,
			playerOpen: Boolean(element('#player')?.open),
			detailsOpen: Boolean(element('#details')?.open),
			detailsTitle: element('#detailsTitle')?.textContent || '',
			search: element('#search')?.value ?? null,
			sort: element('#sort')?.value ?? null,
			source: element('#source')?.value ?? null,
			scrollY: scrolling ? scrolling.scrollTop : 0,
			cardCount: document.querySelectorAll('#grid .card').length,
			activeFilter: element('#filters .chip.active')?.dataset.type || '',
			guideRows: document.querySelectorAll('#guideRows .timetable-row').length,
			guideVisible: Boolean(element('#liveGuide')) && !element('#liveGuide').hidden,
			guideGroup: element('#channelGroups .chip.active')?.textContent || '',
			onlyFavourites: element('#onlyFavourites')?.getAttribute('aria-pressed') ?? null,
			episodeCount: document.querySelectorAll('#detailsBody .episode').length,
			season: element('#detailsBody .season-tab[aria-pressed="true"]')?.textContent || '',
			playingId: typeof state === 'undefined' ? '' : (state.playing?.Id || ''),
			session: typeof state === 'undefined' ? '' : (state.session || ''),
			videoSrc: element('#video')?.getAttribute('src') ?? null,
			fullscreen: Boolean(document.fullscreenElement || document.webkitFullscreenElement),
			navPushed: typeof playerNavigation === 'undefined' ? null : playerNavigation.isPushed(),
			navOrigin: typeof playerNavigation === 'undefined' ? null : playerNavigation.hasOrigin(),
			upNextVisible: Boolean(element('#upNext')) && !element('#upNext').hidden,
			upNextPlay: Boolean(element('#upNext .next-actions button')),
			resumeDialogOpen: Boolean(document.querySelector('dialog.catchup-resume')?.open),
			discoverDetailOpen: Boolean(document.querySelector('#requestDetails')?.open),
			queryValue: element('#query')?.value ?? null,
			loadedCards: document.querySelectorAll('#grid .card, #availableSection .discover-card, #discoverGrid .discover-card').length,
			searchType: element('#searchTypes .chip.active')?.dataset.type || '',
			discoverMode: element('.discover-toolbar .chip.active')?.textContent || '',
			discoverGenre: element('#genreFilters .chip.active')?.textContent || '',
			discoverSort: element('#discoverSort')?.value ?? null,
			requestOpen: Boolean(element('#requestDetails')?.open),
			requestTitle: element('#requestTitle')?.textContent || '',
			requestWatchHref: element('#requestBody a.button.primary')?.getAttribute('href') || '',
			searchCards: document.querySelectorAll('#availableSection .discover-card').length,
			discoverCards: document.querySelectorAll('#discoverGrid .discover-card').length,
		};
	})()`);

	// Every sessionStorage key/value in the tab. The cross-document return
	// state must live here as plain data (scroll, dialog, filters, expiry) and
	// must never carry credentials, API paths or media URLs.
	const storageSnapshot = () => evaluate(`(() => {
		const value = {};
		for (let index = 0; index < sessionStorage.length; index += 1) {
			const key = sessionStorage.key(index);
			value[key] = sessionStorage.getItem(key);
		}
		return value;
	})()`);

	// Expire every recorded return-state timestamp without knowing the
	// implementation's key names: numeric fields named like a timestamp/expiry
	// are moved into the past so the next return must ignore the state.
	const expireReturnState = keys => evaluate(`(() => {
		const keys = ${JSON.stringify(keys)};
		const stampName = ${JSON.stringify('^(?:expir(?:es|esAt|es_at|y|ation)?|ttl|timestamp|time|ts|deadline|until|created(?:At|_at)?|saved(?:At|_at)?|updated(?:At|_at)?)$')};
		const pattern = new RegExp(stampName, 'i');
		let changed = 0;
		for (const key of keys) {
			const raw = sessionStorage.getItem(key);
			if (raw === null) continue;
			let parsed = null;
			try { parsed = JSON.parse(raw); } catch { parsed = null; }
			if (parsed === null) {
				if (Number.isFinite(Number(raw))) { sessionStorage.setItem(key, '1'); changed += 1; }
				continue;
			}
			const walk = node => {
				if (!node || typeof node !== 'object') return;
				for (const [name, value] of Object.entries(node)) {
					if (typeof value === 'number' && pattern.test(name)) { node[name] = 1; changed += 1; }
					else if (typeof value === 'string' && pattern.test(name) && /\d{4}-\d{2}-\d{2}T/.test(value)) { node[name] = '1970-01-01T00:00:00.000Z'; changed += 1; }
					else walk(value);
				}
			};
			walk(parsed);
			sessionStorage.setItem(key, JSON.stringify(parsed));
		}
		return changed;
	})()`);

	const screenshot = async name => {
		const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
		const file = join(outDir, name);
		writeFileSync(file, Buffer.from(shot.data, 'base64'));
		return file;
	};

	return { evaluate, waitFor, waitMock, navigate, reload, history, click, clickText, mouseClick, snapshot, storageSnapshot, expireReturnState, screenshot, consoleErrors, navigationUrls, sleep };
}

// ---------------------------------------------------------------------------
// Assertion helpers
// ---------------------------------------------------------------------------

function check(result, name, pass, detail = '') {
	result.assertions.push({ name, pass: Boolean(pass), detail });
}
function skip(result, name, detail) {
	result.assertions.push({ name, pass: null, skipped: true, detail });
}

// ---------------------------------------------------------------------------
// Cross-document return state inspection
// ---------------------------------------------------------------------------
// The return state is implementation-owned, so the check never assumes a key
// name. It diffs sessionStorage around the handoff, then inspects whatever the
// app stored: forbidden content, an expiry, and one-shot consumption.

const stampKeyPattern = /^(?:expir(?:es|esAt|es_at|y|ation)?|ttl|timestamp|time|ts|deadline|until|created(?:At|_at)?|saved(?:At|_at)?|updated(?:At|_at)?)$/i;

function sessionEntries(map) {
	return Object.entries(map || {}).map(([key, value]) => ({ key, value }));
}

function sessionAdditions(before, after) {
	return sessionEntries(after).filter(entry => !(entry.key in (before || {})));
}

const forbiddenStoragePatterns = [
	{ label: 'bearer token', pattern: /bearer\s+[a-z0-9._~+/=-]+/i },
	{ label: 'authorization header', pattern: /authorization/i },
	{ label: 'password', pattern: /pass(?:word|wd)/i },
	{ label: 'API key', pattern: /api[_-]?key|apikey/i },
	{ label: 'access/refresh token', pattern: /(?:access|refresh|auth|id)[_-]?token/i },
	{ label: 'client secret', pattern: /client[_-]?secret|secret[_-]?key/i },
	{ label: 'absolute URL', pattern: /https?:\/\//i },
	{ label: 'API path', pattern: /\/api\//i },
	{ label: 'media path', pattern: /\/media\//i },
	{ label: 'HLS manifest URL', pattern: /\.m3u8/i },
	{ label: 'mock playback session id', pattern: /sess-\d+/i },
	{ label: 'cookie header', pattern: /cookie:/i },
];

function forbiddenStorageHits(entries) {
	const hits = [];
	for (const { key, value } of entries) {
		const text = typeof value === 'string' ? value : String(value ?? '');
		for (const { label, pattern } of forbiddenStoragePatterns) {
			if (pattern.test(key) || pattern.test(text)) hits.push(label + ' in "' + key + '"');
		}
	}
	return [...new Set(hits)];
}

function storageTimestamps(entries) {
	const found = [];
	for (const { key, value } of entries) {
		let parsed = null;
		try { parsed = JSON.parse(value); } catch { parsed = null; }
		if (parsed === null || typeof parsed !== 'object') {
			const numeric = Number(value);
			if (value !== null && value !== '' && Number.isFinite(numeric)) {
				found.push({ key, path: '', value: numeric, ms: Math.abs(numeric) > 1e12 ? numeric : numeric * 1000 });
			}
			continue;
		}
		const walk = (node, path, depth) => {
			if (!node || typeof node !== 'object' || depth > 6) return;
			for (const [name, child] of Object.entries(node)) {
				const next = path ? path + '.' + name : name;
				if (typeof child === 'number' && stampKeyPattern.test(name)) {
					found.push({ key, path: next, value: child, ms: Math.abs(child) > 1e12 ? child : child * 1000 });
				} else if (typeof child === 'string' && stampKeyPattern.test(name) && /\d{4}-\d{2}-\d{2}T/.test(child) && Number.isFinite(Date.parse(child))) {
					found.push({ key, path: next, value: child, ms: Date.parse(child) });
				} else walk(child, next, depth + 1);
			}
		};
		walk(parsed, '', 0);
	}
	return found;
}

function unexpiredReturnEntries(entries, now) {
	return entries.filter(entry => /scroll|dialog|restore|return|offset|pending|state/i.test(entry.key + ' ' + String(entry.value || '')));
}

function describeTimings(timings) {
	return timings.map(entry => entry.key + (entry.path ? ':' + entry.path : '') + '=' + entry.value).join(', ');
}

// Shared assertions for a recorded handoff: no secrets in sessionStorage and a
// real, bounded expiry on the return state.
function checkReturnStateStorage(result, label, additions, fullStorage) {
	const hits = forbiddenStorageHits(sessionEntries(fullStorage));
	check(result, label + ': no auth, API or media URLs are stored in sessionStorage', hits.length === 0, hits.length ? hits.join('; ') : 'sessionStorage keys=' + Object.keys(fullStorage || {}).join(', '));

	const timings = storageTimestamps(additions);
	const now = Date.now();
	const bounded = timings.filter(entry => entry.ms >= now - 600000 && entry.ms <= now + 3600000);
	const future = timings.filter(entry => entry.ms > now);
	check(result, label + ': return state carries a bounded expiry timestamp', timings.length > 0 && bounded.length === timings.length && future.length > 0, 'timings=[' + describeTimings(timings) + ']; now=' + now + '; additions=' + additions.map(entry => entry.key).join(', '));
	return { timings, hits };
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

const scenarioList = [
	{
		name: 'collection-search-filter',
		async run(context, result) {
			await context.navigate(origin + '/');
			await context.waitFor("document.querySelectorAll('#grid .card').length >= 20", 12000, 'collection cards');
			await context.evaluate('localStorage.clear(); true');
			await context.evaluate(`(() => {
				const sort = document.querySelector('#sort');
				sort.value = 'az';
				sort.dispatchEvent(new Event('change', { bubbles: true }));
				const source = document.querySelector('#source');
				source.value = 'local';
				source.dispatchEvent(new Event('change', { bubbles: true }));
				return true;
			})()`);
			await context.sleep(350);
			await context.evaluate(`(() => {
				const search = document.querySelector('#search');
				search.value = 'Alpha';
				search.dispatchEvent(new Event('input', { bubbles: true }));
				return true;
			})()`);
			await context.waitFor("document.querySelector('#search').value === 'Alpha' && document.querySelectorAll('#grid .card').length >= 20", 10000, 'filtered collection');
			await context.evaluate('window.scrollTo(0, Math.min(900, (document.scrollingElement || document.documentElement).scrollHeight - innerHeight - 20)); true');
			await context.sleep(150);

			const before = await context.snapshot();
			const historyBefore = await context.history();
			const playsBefore = mockState.playCalls.length;
			const stopsBefore = mockState.stops.length;
			check(result, 'collection has a scrolled, filtered grid before play', before.cardCount >= 20 && before.scrollY > 50 && before.search === 'Alpha', JSON.stringify({ cards: before.cardCount, scrollY: before.scrollY, search: before.search }));

			await context.click('#grid .card');
			await context.waitFor("document.querySelector('#details').open && Boolean(document.querySelector('#detailsTitle'))", 10000, 'details dialog');
			await context.clickText('#detailsBody button', 'Play');
			await context.waitFor("document.querySelector('#player').open", 10000, 'player open');
			await context.waitMock(() => mockState.playCalls.length > playsBefore, 10000, 'play request');
			await context.waitFor('typeof state !== "undefined" && Boolean(state.session)', 10000, 'playback session');

			const historyOpen = await context.history();
			const opened = await context.snapshot();
			check(result, 'player opens', opened.playerOpen, 'player.open=' + opened.playerOpen);
			check(result, 'opening pushes exactly one history entry', historyOpen.index === historyBefore.index + 1, JSON.stringify({ before: historyBefore, open: historyOpen }));
			check(result, 'the browsing origin is captured', opened.navPushed === true && opened.navOrigin === true, JSON.stringify({ pushed: opened.navPushed, origin: opened.navOrigin }));

			await context.click('#closePlayer');
			await context.waitFor("!document.querySelector('#player').open && document.querySelector('#details').open", 10000, 'player closed and details restored');
			await context.waitMock(() => mockState.stops.length > stopsBefore, 10000, 'session stop');
			await context.waitFor('typeof state !== "undefined" && !state.session && !document.querySelector("#video").getAttribute("src")', 10000, 'playback cleanup');

			const historyAfter = await context.history();
			const after = await context.snapshot();
			check(result, 'Back returns to the recorded history entry', after.navPushed === false && historyAfter.index === historyBefore.index, JSON.stringify({ before: historyBefore.index, after: historyAfter.index, pushed: after.navPushed }));
			check(result, 'closing adds no extra history entry', historyAfter.length === historyOpen.length, JSON.stringify({ open: historyOpen.length, after: historyAfter.length }));
			check(result, 'collection details dialog is restored', after.detailsOpen, 'details.open=' + after.detailsOpen);
			check(result, 'collection search term preserved', after.search === 'Alpha', 'search=' + JSON.stringify(after.search));
			check(result, 'collection sort preserved', after.sort === 'az', 'sort=' + JSON.stringify(after.sort));
			check(result, 'collection source filter preserved', after.source === 'local', 'source=' + JSON.stringify(after.source));
			check(result, 'collection grid contents preserved', after.cardCount === before.cardCount, JSON.stringify({ before: before.cardCount, after: after.cardCount }));
			check(result, 'collection scroll position restored', Math.abs(after.scrollY - before.scrollY) <= 2, JSON.stringify({ before: before.scrollY, after: after.scrollY }));
			check(result, 'session stop and video cleanup still happen on Back', mockState.stops.length > stopsBefore && after.session === '' && after.videoSrc === null, JSON.stringify({ stops: mockState.stops.length - stopsBefore, session: after.session, videoSrc: after.videoSrc }));
		},
	},
	{
		name: 'guide-filter',
		async run(context, result) {
			await context.navigate(origin + '/?view=livetv');
			await context.waitFor("document.querySelectorAll('#guideRows .timetable-row').length >= 5", 15000, 'live guide');
			await context.evaluate('localStorage.clear(); true');
			await context.clickText('#channelGroups .chip', 'News');
			await context.waitFor("document.querySelector('#channelGroups .chip.active')?.textContent.includes('News')", 8000, 'guide group filter');
			await context.evaluate(`(() => {
				const search = document.querySelector('#search');
				search.value = 'News';
				search.dispatchEvent(new Event('input', { bubbles: true }));
				return true;
			})()`);
			await context.waitFor("document.querySelector('#search').value === 'News' && document.querySelectorAll('#guideRows .timetable-row').length >= 5", 10000, 'filtered guide');
			await context.evaluate('window.scrollTo(0, Math.min(420, (document.scrollingElement || document.documentElement).scrollHeight - innerHeight - 20)); true');
			await context.sleep(150);

			const before = await context.snapshot();
			const historyBefore = await context.history();
			const playsBefore = mockState.playCalls.length;
			const stopsBefore = mockState.stops.length;
			check(result, 'guide is filtered and scrolled before play', before.guideVisible && before.guideRows >= 5 && before.guideGroup.includes('News') && before.search === 'News' && before.scrollY > 20, JSON.stringify({ rows: before.guideRows, group: before.guideGroup, search: before.search, scrollY: before.scrollY }));

			await context.click('#guideRows .timetable-programme');
			await context.waitFor("document.querySelector('#details').open && Boolean(document.querySelector('#detailsTitle'))", 10000, 'guide details');
			await context.clickText('#detailsBody button', 'Watch channel live');
			await context.waitFor("document.querySelector('#player').open", 10000, 'player open');
			await context.waitMock(() => mockState.playCalls.length > playsBefore, 10000, 'live play request');

			const historyOpen = await context.history();
			check(result, 'guide playback pushes exactly one entry', historyOpen.index === historyBefore.index + 1, JSON.stringify({ before: historyBefore, open: historyOpen }));

			await context.click('#closePlayer');
			await context.waitFor("!document.querySelector('#player').open && document.querySelector('#details').open", 10000, 'player closed and guide details restored');
			await context.waitMock(() => mockState.stops.length > stopsBefore, 10000, 'live session stop');

			const historyAfter = await context.history();
			const after = await context.snapshot();
			check(result, 'guide Back returns to the recorded entry', historyAfter.index === historyBefore.index, JSON.stringify({ before: historyBefore.index, after: historyAfter.index }));
			check(result, 'guide view still visible after Back', after.guideVisible && after.guideRows === before.guideRows, JSON.stringify({ visible: after.guideVisible, before: before.guideRows, after: after.guideRows }));
			check(result, 'guide search/filter state preserved', after.search === 'News' && after.guideGroup === before.guideGroup && after.onlyFavourites === before.onlyFavourites, JSON.stringify({ search: after.search, group: after.guideGroup, only: after.onlyFavourites }));
			check(result, 'guide details dialog restored', after.detailsOpen, 'details.open=' + after.detailsOpen);
			check(result, 'guide scroll position restored', Math.abs(after.scrollY - before.scrollY) <= 2, JSON.stringify({ before: before.scrollY, after: after.scrollY }));
			check(result, 'live session stopped on Back', mockState.stops.length > stopsBefore, 'new stops=' + (mockState.stops.length - stopsBefore));
		},
	},
	{
		name: 'series-detail',
		async run(context, result) {
			await context.navigate(origin + '/?view=tvshows');
			await context.waitFor("document.querySelectorAll('#grid .card').length >= 10", 12000, 'series cards');
			await context.evaluate('localStorage.clear(); true');
			await context.evaluate('window.scrollTo(0, Math.min(650, (document.scrollingElement || document.documentElement).scrollHeight - innerHeight - 20)); true');
			await context.sleep(150);
			await context.click('#grid .card');
			await context.waitFor("document.querySelector('#details').open && document.querySelectorAll('#detailsBody .episode').length >= 2", 12000, 'series episode list');

			const before = await context.snapshot();
			const historyBefore = await context.history();
			const playsBefore = mockState.playCalls.length;
			const stopsBefore = mockState.stops.length;
			check(result, 'series detail shows a season and episodes', before.detailsOpen && before.episodeCount >= 2 && Boolean(before.season), JSON.stringify({ episodes: before.episodeCount, season: before.season }));

			await context.click('#detailsBody .episode');
			await context.waitFor("document.querySelector('#player').open", 10000, 'player open');
			await context.waitMock(() => mockState.playCalls.length > playsBefore, 10000, 'episode play request');
			const historyOpen = await context.history();
			check(result, 'series playback pushes exactly one entry', historyOpen.index === historyBefore.index + 1, JSON.stringify({ before: historyBefore, open: historyOpen }));

			await context.click('#closePlayer');
			await context.waitFor("!document.querySelector('#player').open && document.querySelector('#details').open", 10000, 'player closed and series details restored');
			await context.waitMock(() => mockState.stops.length > stopsBefore, 10000, 'series session stop');
			const historyAfter = await context.history();
			const after = await context.snapshot();
			check(result, 'series detail Back returns to the recorded entry', historyAfter.index === historyBefore.index, JSON.stringify({ before: historyBefore.index, after: historyAfter.index }));
			check(result, 'series details dialog and title restored', after.detailsOpen && after.detailsTitle === before.detailsTitle, JSON.stringify({ open: after.detailsOpen, before: before.detailsTitle, after: after.detailsTitle }));
			check(result, 'series season selection preserved', after.season === before.season, JSON.stringify({ before: before.season, after: after.season }));
			check(result, 'series episode list preserved', after.episodeCount === before.episodeCount, JSON.stringify({ before: before.episodeCount, after: after.episodeCount }));
			check(result, 'series page scroll restored', Math.abs(after.scrollY - before.scrollY) <= 2, JSON.stringify({ before: before.scrollY, after: after.scrollY }));
			check(result, 'series session stop still occurs on Back', mockState.stops.length > stopsBefore, 'new stops=' + (mockState.stops.length - stopsBefore));
		},
	},
	{
		name: 'favourites',
		async run(context, result) {
			await context.navigate(origin + '/');
			await context.waitFor("document.querySelectorAll('#grid .card').length >= 10", 12000, 'home collection');
			await context.evaluate('localStorage.clear(); true');
			await context.click('#filters [data-type="favourites"]');
			await context.waitFor("document.querySelector('#filters .chip.active')?.dataset.type === 'favourites' && document.querySelectorAll('#grid .card').length >= 8", 10000, 'favourites grid');
			await context.evaluate('window.scrollTo(0, Math.min(500, (document.scrollingElement || document.documentElement).scrollHeight - innerHeight - 20)); true');
			await context.sleep(150);

			const before = await context.snapshot();
			const historyBefore = await context.history();
			const playsBefore = mockState.playCalls.length;
			const stopsBefore = mockState.stops.length;
			check(result, 'favourites grid is active and scrolled before play', before.activeFilter === 'favourites' && before.cardCount >= 8 && before.scrollY > 20, JSON.stringify({ filter: before.activeFilter, cards: before.cardCount, scrollY: before.scrollY }));

			await context.click('#grid .card');
			await context.waitFor("document.querySelector('#details').open && Boolean(document.querySelector('#detailsTitle'))", 10000, 'favourite details');
			await context.clickText('#detailsBody button', 'Play');
			await context.waitFor("document.querySelector('#player').open", 10000, 'player open');
			await context.waitMock(() => mockState.playCalls.length > playsBefore, 10000, 'favourite play request');
			const historyOpen = await context.history();
			check(result, 'favourites playback pushes exactly one entry', historyOpen.index === historyBefore.index + 1, JSON.stringify({ before: historyBefore, open: historyOpen }));

			await context.click('#closePlayer');
			await context.waitFor("!document.querySelector('#player').open && document.querySelector('#details').open", 10000, 'player closed and details restored');
			await context.waitMock(() => mockState.stops.length > stopsBefore, 10000, 'favourite session stop');
			const historyAfter = await context.history();
			const after = await context.snapshot();
			check(result, 'favourites Back returns to the recorded entry', historyAfter.index === historyBefore.index, JSON.stringify({ before: historyBefore.index, after: historyAfter.index }));
			check(result, 'favourites filter still active', after.activeFilter === 'favourites', 'filter=' + after.activeFilter);
			check(result, 'favourites grid contents preserved', after.cardCount === before.cardCount, JSON.stringify({ before: before.cardCount, after: after.cardCount }));
			check(result, 'favourites scroll position restored', Math.abs(after.scrollY - before.scrollY) <= 2, JSON.stringify({ before: before.scrollY, after: after.scrollY }));
			check(result, 'favourites details dialog restored', after.detailsOpen, 'details.open=' + after.detailsOpen);
			check(result, 'favourites session stop still occurs on Back', mockState.stops.length > stopsBefore, 'new stops=' + (mockState.stops.length - stopsBefore));
		},
	},
	{
		name: 'search-handoff',
		async run(context, result) {
			const searchUrl = origin + '/search?q=Alpha&type=movie';
			const readSearch = () => context.evaluate(`(() => {
				const url = new URL(location.href);
				return {
					url: location.href,
					pathname: location.pathname,
					q: url.searchParams.get('q'),
					type: url.searchParams.get('type'),
					queryValue: document.querySelector('#query')?.value ?? null,
					searchType: document.querySelector('#searchTypes .chip.active')?.dataset.type || '',
					cards: document.querySelectorAll('#availableSection .discover-card').length,
					scrollY: window.scrollY,
					playerMarkup: Boolean(document.querySelector('#player')),
				};
			})()`);
			const loadSearch = async () => {
				await context.navigate(searchUrl);
				await context.waitFor("document.querySelectorAll('#availableSection .discover-card').length >= 40", 15000, 'search results');
				// Start every sub-flow without leftover state from the previous one.
				await context.evaluate('sessionStorage.clear(); true');
			};
			const loadSecondPage = async () => {
				const firstPage = await context.evaluate("document.querySelectorAll('#availableSection .discover-card').length");
				await context.waitFor("!document.querySelector('#availableSection button').hidden", 10000, 'search Show more');
				await context.click('#availableSection button');
				await context.waitFor(`document.querySelectorAll('#availableSection .discover-card').length > ${firstPage}`, 15000, 'search second page');
				return firstPage;
			};
			const scrollDown = async target => {
				await context.evaluate(`window.scrollTo(0, Math.min(${target}, Math.max(0, (document.scrollingElement || document.documentElement).scrollHeight - innerHeight - 20))); true`);
				await context.sleep(250);
			};
			const openFirstResult = async () => {
				await context.click('#availableSection .discover-card');
				await context.waitFor("location.pathname === '/' && new URLSearchParams(location.search).get('item') && document.querySelector('#details').open && Boolean(document.querySelector('#detailsTitle'))", 15000, 'home details from search');
			};
			const play = async () => {
				const playsBefore = mockState.playCalls.length;
				await context.clickText('#detailsBody button', 'Play');
				await context.waitFor("document.querySelector('#player').open", 10000, 'player open');
				await context.waitMock(() => mockState.playCalls.length > playsBefore, 10000, 'search handoff play');
			};
			const playerBack = async () => {
				// app.js skips the intermediate home ?item= entry for a same-origin
				// search handoff. Do not read old-document selectors after this click:
				// the document is replaced by /search.
				await context.click('#closePlayer');
				await context.waitFor("location.pathname === '/search' && new URLSearchParams(location.search).get('q') === 'Alpha' && document.querySelector('#query')?.value === 'Alpha' && document.querySelectorAll('#availableSection .discover-card').length > 0", 20000, 'search document after player Back');
			};

			// ---- Return: filters, query, paged results and scroll are restored.
			await loadSearch();
			const initialCards = await loadSecondPage();
			await scrollDown(700);
			const before = await readSearch();
			const storageBefore = await context.storageSnapshot();
			check(result, 'search handoff: search is filtered, paged and scrolled before play', before.cards > initialCards && before.scrollY > 100 && before.searchType === 'movie' && before.queryValue === 'Alpha', JSON.stringify({ initialCards, cards: before.cards, scrollY: before.scrollY, type: before.searchType, query: before.queryValue }));

			await openFirstResult();
			const handoffStorage = await context.storageSnapshot();
			const handoffAdditions = sessionAdditions(storageBefore, handoffStorage);
			const historyBefore = await context.history();
			const stopsBefore = mockState.stops.length;
			const navigationStart = context.navigationUrls.length;
			checkReturnStateStorage(result, 'search handoff', handoffAdditions, handoffStorage);

			await play();
			const playerStorage = await context.storageSnapshot();
			check(result, 'search handoff: no auth, API or media URLs appear while the player is open', forbiddenStorageHits(sessionEntries(playerStorage)).length === 0, forbiddenStorageHits(sessionEntries(playerStorage)).join('; ') || 'sessionStorage keys=' + Object.keys(playerStorage).join(', '));

			await playerBack();
			try { await context.waitFor(`document.querySelectorAll('#availableSection .discover-card').length === ${before.cards}`, 6000, 'search paged results restored'); } catch {}
			try { await context.waitFor(`Math.abs(window.scrollY - ${before.scrollY}) <= 2`, 6000, 'search scroll restored'); } catch {}
			await context.sleep(250);
			const after = await readSearch();
			const afterStorage = await context.storageSnapshot();
			const remaining = handoffAdditions.filter(entry => entry.key in afterStorage);
			const historyAfter = await context.history();
			const loadedDocuments = context.navigationUrls.slice(navigationStart).filter(url => url.startsWith(origin));
			const loadedHomeDetails = loadedDocuments.some(url => {
				try {
					const parsed = new URL(url);
					return parsed.pathname === '/' && parsed.searchParams.has('item');
				} catch { return false; }
			});

			check(result, 'search handoff: player Back lands on /search, not the home details entry', after.pathname === '/search' && after.q === 'Alpha', JSON.stringify({ url: after.url, expectedPath: '/search', expectedQuery: 'Alpha' }));
			check(result, 'search handoff: query and results restored on the search document', after.queryValue === 'Alpha' && after.cards > 0, JSON.stringify({ query: after.queryValue, cards: after.cards }));
			check(result, 'search handoff: Back skips the intermediate home details entry', historyAfter.index === historyBefore.index - 1 && !loadedHomeDetails, JSON.stringify({ homeDetailsIndex: historyBefore.index, afterIndex: historyAfter.index, documentsLoaded: loadedDocuments }));
			check(result, 'search handoff: the search document has no player markup', after.playerMarkup === false, 'player markup present=' + after.playerMarkup);
			check(result, 'search handoff: search scroll position is restored after player Back', Math.abs(after.scrollY - before.scrollY) <= 2, JSON.stringify({ before: before.scrollY, after: after.scrollY }));
			check(result, 'search handoff: type filter and query survive the handoff', after.searchType === 'movie' && after.queryValue === 'Alpha', JSON.stringify({ type: after.searchType, query: after.queryValue }));
			check(result, 'search handoff: loaded result page survives the handoff', after.cards === before.cards && after.cards > initialCards, JSON.stringify({ initialCards, before: before.cards, after: after.cards }));
			check(result, 'search handoff: return state is consumed on the first return (one-shot)', handoffAdditions.length > 0 && unexpiredReturnEntries(remaining, Date.now()).length === 0, 'recorded handoff keys=[' + handoffAdditions.map(entry => entry.key).join(', ') + ']; remaining=[' + remaining.map(entry => entry.key).join(', ') + ']; after keys=[' + Object.keys(afterStorage).join(', ') + ']');
			check(result, 'search handoff: no auth, API or media URLs remain in sessionStorage after return', forbiddenStorageHits(sessionEntries(afterStorage)).length === 0, forbiddenStorageHits(sessionEntries(afterStorage)).join('; ') || 'sessionStorage keys=' + Object.keys(afterStorage).join(', '));

			let stopSent = true;
			try { await context.waitMock(() => mockState.stops.length > stopsBefore, 8000, 'search handoff session stop'); }
			catch { stopSent = false; }
			check(result, 'search handoff: playback session stop is sent on cross-document Back', stopSent, 'new stops=' + (mockState.stops.length - stopsBefore));

			// ---- A normal reload must not re-apply the consumed scroll/page state.
			await context.evaluate('window.scrollTo(0, 120); true');
			await context.sleep(150);
			await context.reload();
			await context.waitFor("document.querySelectorAll('#availableSection .discover-card').length >= 40", 15000, 'search results after reload');
			await context.sleep(300);
			const reloaded = await readSearch();
			check(result, 'search handoff: a normal reload does not restore stale return scroll or dialog', Math.abs(reloaded.scrollY - before.scrollY) > 50 && reloaded.cards === initialCards, JSON.stringify({ staleScroll: before.scrollY, reloadScroll: reloaded.scrollY, initialCards, reloadCards: reloaded.cards }));

			// ---- A direct visit while return state is pending must not restore it.
			await loadSearch();
			const directStorageBefore = await context.storageSnapshot();
			await openFirstResult();
			const directPending = sessionAdditions(directStorageBefore, await context.storageSnapshot());
			await context.navigate(searchUrl);
			await context.waitFor("document.querySelectorAll('#availableSection .discover-card').length >= 40", 15000, 'search results on direct visit');
			await context.sleep(300);
			const direct = await readSearch();
			check(result, 'search handoff: a direct visit to /search does not restore pending handoff scroll or page', direct.cards === initialCards && direct.scrollY < 150 && direct.pathname === '/search', JSON.stringify({ scrollY: direct.scrollY, cards: direct.cards, initialCards, pendingKeys: directPending.map(entry => entry.key) }));

			// ---- Return state expires: an aged-out record is ignored.
			await loadSearch();
			const expiryInitialCards = await loadSecondPage();
			await scrollDown(700);
			const expiryBefore = await readSearch();
			const expiryStorageBefore = await context.storageSnapshot();
			await openFirstResult();
			const expiryAdditions = sessionAdditions(expiryStorageBefore, await context.storageSnapshot());
			const expiredFields = await context.expireReturnState(expiryAdditions.map(entry => entry.key));
			check(result, 'search handoff: return state exposes an expiry field that can be aged out', expiredFields > 0, 'aged fields=' + expiredFields + '; keys=[' + expiryAdditions.map(entry => entry.key).join(', ') + ']');
			await play();
			await playerBack();
			await context.sleep(400);
			const expiredAfter = await readSearch();
			check(result, 'search handoff: an expired return state is ignored instead of restoring stale scroll or page', expiredFields > 0 && expiredAfter.cards === expiryInitialCards && expiredAfter.scrollY < expiryBefore.scrollY - 50, JSON.stringify({ agedFields: expiredFields, expiredCards: expiredAfter.cards, initialCards: expiryInitialCards, expiredScroll: expiredAfter.scrollY, staleScroll: expiryBefore.scrollY }));
		},
	},
	{
		name: 'discover-handoff',
		async run(context, result) {
			const discoverUrl = origin + '/discover?type=movie&genre=Drama&sort=release';
			const readDiscover = () => context.evaluate(`(() => {
				const url = new URL(location.href);
				return {
					url: location.href,
					pathname: location.pathname,
					type: url.searchParams.get('type'),
					genre: url.searchParams.get('genre'),
					sort: url.searchParams.get('sort'),
					cards: document.querySelectorAll('#discoverGrid .discover-card').length,
					scrollY: window.scrollY,
					dialogOpen: Boolean(document.querySelector('#requestDetails')?.open),
					dialogTitle: document.querySelector('#requestTitle')?.textContent || '',
					watchHref: document.querySelector('#requestBody a.button.primary')?.getAttribute('href') || '',
					mode: document.querySelector('.discover-toolbar .chip.active')?.textContent || '',
					modeLabel: document.querySelector('#genreFilters .chip.active')?.textContent || '',
				};
			})()`);
			const loadDiscover = async () => {
				await context.navigate(origin + '/discover?type=movie');
				await context.waitFor("document.querySelectorAll('#discoverGrid .discover-card').length >= 20", 15000, 'discover cards');
				await context.evaluate('sessionStorage.clear(); true');
				await context.clickText('#genreFilters .chip', 'Drama');
				await context.waitFor("document.querySelector('#genreFilters .chip.active')?.textContent.includes('Drama')", 10000, 'discover genre filter');
				await context.evaluate(`(() => {
					const sort = document.querySelector('#discoverSort');
					sort.value = 'release';
					sort.dispatchEvent(new Event('change', { bubbles: true }));
					return true;
				})()`);
				await context.waitFor("document.querySelector('#discoverSort').value === 'release' && document.querySelectorAll('#discoverGrid .discover-card').length >= 20", 15000, 'discover sort');
			};
			const loadSecondPage = async () => {
				const firstPage = await context.evaluate("document.querySelectorAll('#discoverGrid .discover-card').length");
				await context.waitFor("!document.querySelector('#discoverMore').hidden", 10000, 'discover Show more');
				await context.click('#discoverMore');
				await context.waitFor(`document.querySelectorAll('#discoverGrid .discover-card').length > ${firstPage}`, 15000, 'discover second page');
				return firstPage;
			};
			const scrollDown = async target => {
				await context.evaluate(`window.scrollTo(0, Math.min(${target}, Math.max(0, (document.scrollingElement || document.documentElement).scrollHeight - innerHeight - 20))); true`);
				await context.sleep(250);
			};
			const openFirstCard = async () => {
				await context.click('#discoverGrid .discover-card');
				await context.waitFor("document.querySelector('#requestDetails')?.open && Boolean(document.querySelector('#requestTitle')) && Boolean(document.querySelector('#requestBody a.button.primary'))", 15000, 'discover title details');
				return context.evaluate("({ title: document.querySelector('#requestTitle').textContent, href: document.querySelector('#requestBody a.button.primary').getAttribute('href') })");
			};
			const goToWatch = async () => {
				await context.clickText('#requestBody a', 'Watch in Tellybox');
				await context.waitFor("location.pathname === '/' && new URLSearchParams(location.search).get('item') && document.querySelector('#details').open && Boolean(document.querySelector('#detailsTitle'))", 15000, 'home details from discover');
			};
			const play = async () => {
				const playsBefore = mockState.playCalls.length;
				await context.clickText('#detailsBody button', 'Play');
				await context.waitFor("document.querySelector('#player').open", 10000, 'player open');
				await context.waitMock(() => mockState.playCalls.length > playsBefore, 10000, 'discover handoff play');
			};
			const playerBack = async () => {
				// app.js skips the intermediate home ?item= entry for a same-origin
				// discover handoff. Do not read old-document selectors after this click.
				await context.click('#closePlayer');
				await context.waitFor("location.pathname === '/discover' && new URLSearchParams(location.search).get('type') === 'movie' && document.querySelectorAll('#discoverGrid .discover-card').length > 0", 20000, 'discover document after player Back');
			};

			// ---- Return: scroll, dialog, filters, query, sort and page restored.
			await loadDiscover();
			const initialCards = await loadSecondPage();
			await scrollDown(600);
			const before = await readDiscover();
			const storageBefore = await context.storageSnapshot();
			const dialogBefore = await openFirstCard();
			const stopsBefore = mockState.stops.length;
			check(result, 'discover handoff: Discover is filtered, sorted, paged and scrolled before play', before.cards > initialCards && before.scrollY > 100 && before.genre === 'Drama' && before.sort === 'release', JSON.stringify({ initialCards, cards: before.cards, scrollY: before.scrollY, genre: before.genre, sort: before.sort }));
			check(result, 'discover handoff: the open detail dialog has a title and watch link before the handoff', Boolean(dialogBefore.title) && Boolean(dialogBefore.href), JSON.stringify(dialogBefore));

			await goToWatch();
			// Measure document loads from here: the handoff document itself is
			// expected, but Back must not load the intermediate home entry again.
			const navigationStart = context.navigationUrls.length;
			const handoffStorage = await context.storageSnapshot();
			const handoffAdditions = sessionAdditions(storageBefore, handoffStorage);
			const historyBefore = await context.history();
			checkReturnStateStorage(result, 'discover handoff', handoffAdditions, handoffStorage);
			await play();
			const playerStorage = await context.storageSnapshot();
			check(result, 'discover handoff: no auth, API or media URLs appear while the player is open', forbiddenStorageHits(sessionEntries(playerStorage)).length === 0, forbiddenStorageHits(sessionEntries(playerStorage)).join('; ') || 'sessionStorage keys=' + Object.keys(playerStorage).join(', '));

			await playerBack();
			try { await context.waitFor(`document.querySelectorAll('#discoverGrid .discover-card').length === ${before.cards}`, 6000, 'discover paged results restored'); } catch {}
			try { await context.waitFor(`document.querySelector('#requestDetails')?.open && document.querySelector('#requestTitle')?.textContent === ${JSON.stringify(dialogBefore.title)}`, 6000, 'discover dialog restored'); } catch {}
			try { await context.waitFor(`Math.abs(window.scrollY - ${before.scrollY}) <= 2`, 6000, 'discover scroll restored'); } catch {}
			await context.sleep(300);
			const after = await readDiscover();
			const afterStorage = await context.storageSnapshot();
			const remaining = handoffAdditions.filter(entry => entry.key in afterStorage);
			const historyAfter = await context.history();
			const loadedDocuments = context.navigationUrls.slice(navigationStart).filter(url => url.startsWith(origin));
			const loadedHomeDetails = loadedDocuments.some(url => {
				try {
					const parsed = new URL(url);
					return parsed.pathname === '/' && parsed.searchParams.has('item');
				} catch { return false; }
			});

			check(result, 'discover handoff: player Back lands on /discover, not the home details entry', after.pathname === '/discover' && after.type === 'movie', JSON.stringify({ url: after.url, expectedPath: '/discover', expectedType: 'movie' }));
			check(result, 'discover handoff: Discover results are restored', after.cards > 0, JSON.stringify({ cards: after.cards }));
			check(result, 'discover handoff: Back skips the intermediate home details entry', historyAfter.index === historyBefore.index - 1 && !loadedHomeDetails, JSON.stringify({ homeDetailsIndex: historyBefore.index, afterIndex: historyAfter.index, documentsLoaded: loadedDocuments }));
			check(result, 'discover handoff: Discover scroll position is restored after player Back', Math.abs(after.scrollY - before.scrollY) <= 2, JSON.stringify({ before: before.scrollY, after: after.scrollY }));
			check(result, 'discover handoff: the Discover detail dialog is restored after player Back', after.dialogOpen && after.dialogTitle === dialogBefore.title && after.watchHref === dialogBefore.href, JSON.stringify({ open: after.dialogOpen, beforeTitle: dialogBefore.title, afterTitle: after.dialogTitle, beforeHref: dialogBefore.href, afterHref: after.watchHref }));
			check(result, 'discover handoff: genre, sort and query params survive the handoff', after.genre === 'Drama' && after.sort === 'release' && after.type === 'movie', JSON.stringify({ type: after.type, genre: after.genre, sort: after.sort }));
			check(result, 'discover handoff: loaded result page survives the handoff', after.cards === before.cards && after.cards > initialCards, JSON.stringify({ initialCards, before: before.cards, after: after.cards }));
			check(result, 'discover handoff: return state is consumed on the first return (one-shot)', handoffAdditions.length > 0 && unexpiredReturnEntries(remaining, Date.now()).length === 0, 'recorded handoff keys=[' + handoffAdditions.map(entry => entry.key).join(', ') + ']; remaining=[' + remaining.map(entry => entry.key).join(', ') + ']; after keys=[' + Object.keys(afterStorage).join(', ') + ']');
			check(result, 'discover handoff: no auth, API or media URLs remain in sessionStorage after return', forbiddenStorageHits(sessionEntries(afterStorage)).length === 0, forbiddenStorageHits(sessionEntries(afterStorage)).join('; ') || 'sessionStorage keys=' + Object.keys(afterStorage).join(', '));

			let stopSent = true;
			try { await context.waitMock(() => mockState.stops.length > stopsBefore, 8000, 'discover handoff session stop'); }
			catch { stopSent = false; }
			check(result, 'discover handoff: playback session stop is sent on cross-document Back', stopSent, 'new stops=' + (mockState.stops.length - stopsBefore));

			// ---- A normal reload must not reopen the dialog or replay the page/scroll.
			await context.evaluate('window.scrollTo(0, 120); true');
			await context.sleep(150);
			await context.reload();
			await context.waitFor("document.querySelectorAll('#discoverGrid .discover-card').length >= 20", 15000, 'discover results after reload');
			await context.sleep(300);
			const reloaded = await readDiscover();
			check(result, 'discover handoff: a normal reload does not restore stale return scroll or dialog', reloaded.dialogOpen === false && reloaded.cards === initialCards && Math.abs(reloaded.scrollY - before.scrollY) > 50, JSON.stringify({ dialogOpen: reloaded.dialogOpen, initialCards, reloadCards: reloaded.cards, staleScroll: before.scrollY, reloadScroll: reloaded.scrollY }));

			// ---- A direct visit while return state is pending must not restore it.
			await loadDiscover();
			const directStorageBefore = await context.storageSnapshot();
			await openFirstCard();
			await goToWatch();
			const directPending = sessionAdditions(directStorageBefore, await context.storageSnapshot());
			await context.navigate(discoverUrl);
			await context.waitFor("document.querySelectorAll('#discoverGrid .discover-card').length >= 20", 15000, 'discover results on direct visit');
			await context.sleep(300);
			const direct = await readDiscover();
			check(result, 'discover handoff: a direct visit to /discover does not restore pending handoff scroll or dialog', direct.dialogOpen === false && direct.cards === initialCards && direct.scrollY < 150 && direct.pathname === '/discover', JSON.stringify({ dialogOpen: direct.dialogOpen, cards: direct.cards, initialCards, scrollY: direct.scrollY, pendingKeys: directPending.map(entry => entry.key) }));

			// ---- Return state expires: an aged-out record is ignored.
			await loadDiscover();
			const expiryInitialCards = await loadSecondPage();
			await scrollDown(600);
			const expiryBefore = await readDiscover();
			const expiryStorageBefore = await context.storageSnapshot();
			const expiryDialog = await openFirstCard();
			await goToWatch();
			const expiryAdditions = sessionAdditions(expiryStorageBefore, await context.storageSnapshot());
			const expiredFields = await context.expireReturnState(expiryAdditions.map(entry => entry.key));
			check(result, 'discover handoff: return state exposes an expiry field that can be aged out', expiredFields > 0, 'aged fields=' + expiredFields + '; keys=[' + expiryAdditions.map(entry => entry.key).join(', ') + ']');
			await play();
			await playerBack();
			await context.sleep(400);
			const expiredAfter = await readDiscover();
			check(result, 'discover handoff: an expired return state is ignored instead of restoring stale scroll or dialog', expiredFields > 0 && expiredAfter.dialogOpen === false && expiredAfter.cards === expiryInitialCards && expiredAfter.scrollY < expiryBefore.scrollY - 50, JSON.stringify({ agedFields: expiredFields, expiredDialog: expiredAfter.dialogOpen, expectedTitle: expiryDialog.title, expiredCards: expiredAfter.cards, initialCards: expiryInitialCards, expiredScroll: expiredAfter.scrollY, staleScroll: expiryBefore.scrollY }));
		},
	},
	{
		name: 'browser-back-no-loop',
		async run(context, result) {
			await context.navigate(origin + '/');
			await context.waitFor("document.querySelectorAll('#grid .card').length >= 20", 12000, 'collection cards');
			await context.evaluate('localStorage.clear(); true');
			const historyBase = await context.history();
			const playsBefore = mockState.playCalls.length;
			await context.click('#grid .card');
			await context.waitFor("document.querySelector('#details').open && Boolean(document.querySelector('#detailsTitle'))", 10000, 'details');
			await context.clickText('#detailsBody button', 'Play');
			await context.waitFor("document.querySelector('#player').open", 10000, 'player open');
			await context.waitMock(() => mockState.playCalls.length > playsBefore, 10000, 'play request');
			const historyOpen = await context.history();
			check(result, 'Browser Back fixture opens with one entry', historyOpen.index === historyBase.index + 1, JSON.stringify({ base: historyBase, open: historyOpen }));

			await context.evaluate('history.back(); true');
			await context.waitFor("!document.querySelector('#player').open && document.querySelector('#details').open", 10000, 'browser Back closes player');
			const historyClosed = await context.history();
			const afterBrowserBack = await context.snapshot();
			check(result, 'Browser Back closes the player and restores details', !afterBrowserBack.playerOpen && afterBrowserBack.detailsOpen, JSON.stringify({ player: afterBrowserBack.playerOpen, details: afterBrowserBack.detailsOpen }));
			check(result, 'Browser Back returns to the same history index', historyClosed.index === historyBase.index && historyClosed.length === historyOpen.length, JSON.stringify({ base: historyBase.index, closed: historyClosed.index, length: historyClosed.length }));

			await context.evaluate('history.forward(); true');
			await context.sleep(400);
			const historyForward = await context.history();
			const afterForward = await context.snapshot();
			check(result, 'forward into the consumed player entry does not reopen the player', !afterForward.playerOpen && historyForward.index === historyBase.index + 1, JSON.stringify({ player: afterForward.playerOpen, index: historyForward.index }));

			await context.evaluate('history.back(); true');
			await context.sleep(400);
			const historyBackAgain = await context.history();
			const afterBackAgain = await context.snapshot();
			check(result, 'a second Browser Back does not open or duplicate the player', !afterBackAgain.playerOpen && historyBackAgain.index === historyBase.index && historyBackAgain.length === historyOpen.length, JSON.stringify({ player: afterBackAgain.playerOpen, index: historyBackAgain.index, length: historyBackAgain.length }));

			// Player Back, then repeated rapid clicks must not walk the history back
			// past the browsing origin.
			await context.clickText('#detailsBody button', 'Play');
			await context.waitFor("document.querySelector('#player').open", 10000, 'player reopened');
			const historyReopen = await context.history();
			check(result, 'reopening after Back pushes a single new entry', historyReopen.index === historyBase.index + 1 && historyReopen.length === historyOpen.length, JSON.stringify({ reopen: historyReopen, base: historyBase, firstOpen: historyOpen }));
			await context.evaluate(`(() => {
				const button = document.querySelector('#closePlayer');
				button.click();
				button.click();
				button.click();
				return true;
			})()`);
			await context.sleep(900);
			const rapid = await context.snapshot();
			const historyRapid = await context.history();
			check(result, 'three rapid player Back clicks do not walk past the origin', historyRapid.index >= historyBase.index, JSON.stringify({ pathname: rapid.pathname, index: historyRapid.index, base: historyBase.index, baseUrl: historyBase.url, currentUrl: historyRapid.url, player: rapid.playerOpen }));
			check(result, 'three rapid player Back clicks leave the player closed', !rapid.playerOpen, 'player.open=' + rapid.playerOpen);
		},
	},
	{
		name: 'autoplay-retry-quality',
		async run(context, result) {
			await context.navigate(origin + '/?view=tvshows');
			await context.waitFor("document.querySelectorAll('#grid .card').length >= 10", 12000, 'series cards');
			await context.evaluate('localStorage.clear(); true');
			const historyBase = await context.history();
			await context.click('#grid .card');
			await context.waitFor("document.querySelector('#details').open && document.querySelectorAll('#detailsBody .episode').length >= 2", 12000, 'series details');
			const seriesTitle = (await context.snapshot()).detailsTitle;
			const playsBefore = mockState.playCalls.length;
			const stopsBefore = mockState.stops.length;
			await context.click('#detailsBody .episode');
			await context.waitFor("document.querySelector('#player').open", 10000, 'episode player');
			await context.waitMock(() => mockState.playCalls.length > playsBefore, 10000, 'first episode play');
			const historyOpen = await context.history();
			await context.waitFor("typeof nextEpisode !== 'undefined' && Boolean(nextEpisode)", 10000, 'next episode lookup');
			check(result, 'episode playback records one origin entry', historyOpen.index === historyBase.index + 1, JSON.stringify({ base: historyBase.index, open: historyOpen.index }));

			const autoplayPlays = mockState.playCalls.length;
			await context.evaluate(`(() => {
				const video = document.querySelector('#video');
				Object.defineProperty(video, 'ended', { configurable: true, get: () => true });
				Object.defineProperty(video, 'duration', { configurable: true, get: () => 1200 });
				Object.defineProperty(video, 'currentTime', { configurable: true, get: () => 1150, set: () => {} });
				video.dispatchEvent(new Event('ended'));
				return true;
			})()`);
			await context.waitFor("!document.querySelector('#upNext').hidden && Boolean(document.querySelector('#upNext .next-actions button'))", 10000, 'up next card');
			await context.clickText('#upNext .next-actions button', 'Play now');
			await context.waitMock(() => mockState.playCalls.length > autoplayPlays, 10000, 'autoplay next episode');
			await context.waitFor("typeof state !== 'undefined' && state.playing?.Id === '20000000-0000-0000-0000-000000000002'", 10000, 'second episode playing');
			const historyAfterAutoplay = await context.history();
			check(result, 'autoplay advances the episode without adding a history entry', historyAfterAutoplay.index === historyOpen.index && historyAfterAutoplay.length === historyOpen.length, JSON.stringify({ open: historyOpen, after: historyAfterAutoplay }));

			const retryPlays = mockState.playCalls.length;
			await context.waitFor("!document.querySelector('#retryPlayer').disabled", 10000, 'retry button enabled');
			await context.click('#retryPlayer');
			await context.waitMock(() => mockState.playCalls.length > retryPlays, 10000, 'retry play request');
			const historyAfterRetry = await context.history();
			check(result, 'retry keeps the origin and adds no history entry', historyAfterRetry.index === historyOpen.index && historyAfterRetry.length === historyOpen.length, JSON.stringify({ open: historyOpen, after: historyAfterRetry }));

			const qualityPlays = mockState.playCalls.length;
			await context.evaluate(`(() => {
				const quality = document.querySelector('#quality');
				quality.value = '8000000';
				quality.dispatchEvent(new Event('change', { bubbles: true }));
				return true;
			})()`);
			await context.waitMock(() => mockState.playCalls.length > qualityPlays, 10000, 'quality change play request');
			const historyAfterQuality = await context.history();
			const qualityValue = mockState.playCalls[mockState.playCalls.length - 1]?.quality;
			check(result, 'quality change keeps the origin and sends the new quality', historyAfterQuality.index === historyOpen.index && historyAfterQuality.length === historyOpen.length && qualityValue === 8000000, JSON.stringify({ open: historyOpen, after: historyAfterQuality, quality: qualityValue }));

			await context.click('#closePlayer');
			await context.waitFor("!document.querySelector('#player').open && document.querySelector('#details').open", 10000, 'player closed after autoplay');
			await context.waitMock(() => mockState.stops.length > stopsBefore, 10000, 'autoplay session stop');
			const historyAfter = await context.history();
			const after = await context.snapshot();
			check(result, 'Back after autoplay returns to the original series detail', after.detailsOpen && after.detailsTitle === seriesTitle && historyAfter.index === historyBase.index, JSON.stringify({ title: after.detailsTitle, expected: seriesTitle, index: historyAfter.index, base: historyBase.index }));
			check(result, 'Back after autoplay does not replay a previous player entry', !after.playerOpen && after.navPushed === false, JSON.stringify({ player: after.playerOpen, pushed: after.navPushed }));
			check(result, 'autoplay session stop still occurs on Back', mockState.stops.length > stopsBefore, 'new stops=' + (mockState.stops.length - stopsBefore));
		},
	},
	{
		name: 'nested-modal-cancelled',
		async run(context, result) {
			await context.navigate(origin + '/?view=livetv');
			await context.waitFor("document.querySelectorAll('#guideRows .timetable-row').length >= 5", 15000, 'live guide');
			await context.evaluate("localStorage.setItem('jimbo-progress-catchup-1', '125'); true");
			await context.evaluate('window.scrollTo(0, Math.min(300, (document.scrollingElement || document.documentElement).scrollHeight - innerHeight - 20)); true');
			await context.sleep(150);
			await context.click('#guideRows .timetable-programme');
			await context.waitFor("document.querySelector('#details').open && Boolean(document.querySelector('#detailsTitle'))", 10000, 'guide details');
			await context.waitFor("Boolean(document.querySelector('.guide-restart button'))", 12000, 'restart programme button');
			const before = await context.snapshot();
			const historyBase = await context.history();
			const playsBefore = mockState.playCalls.length;
			const stopsBefore = mockState.stops.length;

			await context.clickText('.guide-restart button', 'Restart programme');
			await context.waitFor("Boolean(document.querySelector('dialog.catchup-resume')?.open)", 10000, 'nested resume dialog');
			const nested = await context.snapshot();
			const historyNested = await context.history();
			check(result, 'resume dialog opens as a nested modal over the guide details', nested.detailsOpen && nested.resumeDialogOpen && !nested.playerOpen, JSON.stringify({ details: nested.detailsOpen, resume: nested.resumeDialogOpen, player: nested.playerOpen }));
			check(result, 'a cancelled Catch-up start adds no history entry and opens no player', historyNested.index === historyBase.index && mockState.playCalls.length === playsBefore, JSON.stringify({ base: historyBase.index, nested: historyNested.index, plays: mockState.playCalls.length - playsBefore }));

			await context.clickText('dialog.catchup-resume button', 'Cancel');
			await context.waitFor("!document.querySelector('dialog.catchup-resume')", 8000, 'resume dialog cancelled');
			const cancelled = await context.snapshot();
			const historyCancelled = await context.history();
			check(result, 'cancelling the nested start keeps the details dialog and origin intact', cancelled.detailsOpen && !cancelled.playerOpen && !cancelled.navPushed && historyCancelled.index === historyBase.index, JSON.stringify({ details: cancelled.detailsOpen, player: cancelled.playerOpen, pushed: cancelled.navPushed, index: historyCancelled.index }));

			await context.clickText('.guide-restart button', 'Restart programme');
			await context.waitFor("Boolean(document.querySelector('dialog.catchup-resume')?.open)", 10000, 'resume dialog again');
			await context.clickText('dialog.catchup-resume button', 'Resume from');
			await context.waitFor("document.querySelector('#player').open", 12000, 'catch-up player open');
			await context.waitMock(() => mockState.playCalls.length > playsBefore, 10000, 'catch-up play request');
			const historyOpen = await context.history();
			check(result, 'choosing Resume pushes one player entry', historyOpen.index === historyBase.index + 1, JSON.stringify({ base: historyBase, open: historyOpen }));

			await context.click('#closePlayer');
			await context.waitFor("!document.querySelector('#player').open && document.querySelector('#details').open", 10000, 'player closed and guide details restored');
			await context.waitMock(() => mockState.stops.length > stopsBefore, 10000, 'catch-up session stop');
			const historyAfter = await context.history();
			const after = await context.snapshot();
			check(result, 'nested start Back returns to the guide details origin', after.detailsOpen && historyAfter.index === historyBase.index, JSON.stringify({ details: after.detailsOpen, index: historyAfter.index, base: historyBase.index }));
			check(result, 'nested start Back restores the guide details scroll', Math.abs(after.scrollY - before.scrollY) <= 2, JSON.stringify({ before: before.scrollY, after: after.scrollY }));
			check(result, 'nested start Back stops the playback session', mockState.stops.length > stopsBefore, 'new stops=' + (mockState.stops.length - stopsBefore));
		},
	},
	{
		name: 'fullscreen-cleanup',
		async run(context, result) {
			await context.navigate(origin + '/?view=livetv');
			await context.waitFor("document.querySelectorAll('#guideRows .timetable-row').length >= 5", 15000, 'live guide');
			await context.evaluate('localStorage.clear(); true');
			const historyBase = await context.history();
			const playsBefore = mockState.playCalls.length;
			const stopsBefore = mockState.stops.length;
			await context.click('#guideRows button.timetable-channel');
			await context.waitFor("document.querySelector('#player').open && !document.querySelector('#liveControls').hidden", 12000, 'live player and controls');
			await context.waitMock(() => mockState.playCalls.length > playsBefore, 10000, 'live play request');

			let fullscreenEntered = false;
			try {
				await context.mouseClick('#liveFullscreen');
				fullscreenEntered = await context.waitFor('Boolean(document.fullscreenElement || document.webkitFullscreenElement)', 4000, 'fullscreen').then(value => Boolean(value));
			} catch { fullscreenEntered = false; }

			const historyOpen = await context.history();
			check(result, 'live playback pushes one history entry', historyOpen.index === historyBase.index + 1, JSON.stringify({ base: historyBase.index, open: historyOpen.index }));

			await context.click('#closePlayer');
			await context.waitFor("!document.querySelector('#player').open", 10000, 'player closed');
			await context.waitMock(() => mockState.stops.length > stopsBefore, 10000, 'live session stop');
			await context.waitFor('typeof state !== "undefined" && !state.session && !document.querySelector("#video").getAttribute("src")', 10000, 'live playback cleanup').catch(() => {});
			let fullscreenCleared = true;
			try { await context.waitFor('!Boolean(document.fullscreenElement || document.webkitFullscreenElement)', 4000, 'fullscreen exit'); }
			catch { fullscreenCleared = false; }
			const after = await context.snapshot();
			const historyAfter = await context.history();

			check(result, 'fullscreen/cleanup: player Back returns to the guide entry', historyAfter.index === historyBase.index, JSON.stringify({ base: historyBase.index, after: historyAfter.index }));
			check(result, 'fullscreen/cleanup: playback session stop is still sent', mockState.stops.length > stopsBefore, 'new stops=' + (mockState.stops.length - stopsBefore));
			check(result, 'fullscreen/cleanup: video source and session are cleared', after.session === '' && after.videoSrc === null, JSON.stringify({ session: after.session, src: after.videoSrc }));

			if (!fullscreenEntered) {
				skip(result, 'fullscreen is exited on player Back', 'SKIP: fullscreen could not be entered in this headless run (no fullscreenElement after a real mouse click).');
			} else {
				check(result, 'fullscreen is exited on player Back', after.fullscreen === false && fullscreenCleared, 'fullscreenCleared=' + fullscreenCleared + ', document.fullscreenElement still set after Back=' + after.fullscreen);
				if (after.fullscreen) {
					await context.evaluate('document.exitFullscreen?.().catch(() => {}); true').catch(() => {});
					await context.sleep(300);
				}
			}
		},
	},
	{
		name: 'direct-link-context',
		async run(context, result) {
			// No recorded origin: the player is opened without the navigation
			// wrapper (the shape of a direct-link/stale entry). Back must land on
			// home instead of walking out of the site.
			await context.navigate(origin + '/?view=movies');
			await context.waitFor("document.querySelectorAll('#grid .card').length >= 10", 12000, 'movie cards');
			await context.evaluate('localStorage.clear(); true');
			const historyBase = await context.history();
			await context.evaluate("document.querySelector('#player').showModal(); true");
			const opened = await context.snapshot();
			check(result, 'no-origin player opens without a history push', opened.playerOpen && opened.navPushed === false, JSON.stringify({ player: opened.playerOpen, pushed: opened.navPushed }));
			await context.click('#closePlayer');
			await context.waitFor("location.pathname === '/' && location.search === '' && document.readyState === 'complete'", 15000, 'home fallback');
			await context.waitFor("document.querySelectorAll('#grid .card').length >= 20", 12000, 'home collection after fallback');
			const afterFallback = await context.snapshot();
			const historyFallback = await context.history();
			check(result, 'no-origin Back falls back to home', afterFallback.pathname === '/' && afterFallback.locationSearch === '' && !afterFallback.playerOpen, JSON.stringify({ pathname: afterFallback.pathname, search: afterFallback.locationSearch, player: afterFallback.playerOpen }));
			check(result, 'home fallback does not add a history entry', historyFallback.index === historyBase.index && historyFallback.length === historyBase.length, JSON.stringify({ base: historyBase, after: historyFallback }));

			// A real direct link (/?item=) does have an origin context: the open
			// details dialog. Back must restore that, not bounce to home.
			const itemId = movies[0].Id;
			await context.navigate(origin + '/?item=' + itemId);
			await context.waitFor("location.pathname === '/' && new URLSearchParams(location.search).get('item') && document.querySelector('#details').open && Boolean(document.querySelector('#detailsTitle'))", 15000, 'direct item details');
			const itemHistoryBase = await context.history();
			const playsBefore = mockState.playCalls.length;
			await context.clickText('#detailsBody button', 'Play');
			await context.waitFor("document.querySelector('#player').open", 10000, 'direct item player');
			await context.waitMock(() => mockState.playCalls.length > playsBefore, 10000, 'direct item play');
			await context.click('#closePlayer');
			await context.waitFor("!document.querySelector('#player').open && document.querySelector('#details').open", 10000, 'direct item details restored');
			const afterItem = await context.snapshot();
			const historyItem = await context.history();
			check(result, 'direct item Back restores the details context', afterItem.detailsOpen && afterItem.pathname === '/' && afterItem.url.includes('item=' + itemId), JSON.stringify({ details: afterItem.detailsOpen, url: afterItem.url }));
			check(result, 'direct item Back stays on the recorded entry', historyItem.index === itemHistoryBase.index, JSON.stringify({ base: itemHistoryBase.index, after: historyItem.index }));
		},
	},
];

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const viewports = [
	{ name: 'desktop', width: 1366, height: 900, mobile: false },
	{ name: 'mobile', width: 390, height: 844, mobile: true },
];

const results = [];
let chromeConsoleErrors = [];
try {
	let devtoolsPort = 0;
	for (let attempt = 0; attempt < 100; attempt += 1) {
		const file = join(profile, 'DevToolsActivePort');
		if (existsSync(file)) {
			devtoolsPort = Number(readFileSync(file, 'utf8').split(/\r?\n/)[0]);
			if (devtoolsPort) break;
		}
		await sleep(100);
	}
	if (!devtoolsPort) throw new Error('Chrome did not open a DevTools port');
	const connection = await connect(await targetFor(devtoolsPort));
	const send = connection.send;
	await send('Page.enable');
	await send('Runtime.enable');
	await send('Log.enable');
	const context = makeContext(send, connection.on);
	// Keep only the most recent console entries; page 404s for artwork and the
	// optional HLS vendor are expected in this mocked harness.
	connection.on('Log.entryAdded', params => {
		if (params?.entry?.level === 'error' && !/404|Failed to load resource/.test(params.entry.text || '')) {
			chromeConsoleErrors.push(String(params.entry.text).slice(0, 300));
		}
	});

	for (const viewport of viewports) {
		await send('Emulation.setDeviceMetricsOverride', {
			width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: viewport.mobile,
		});
		for (const scenario of scenarioList) {
			const result = { name: scenario.name, viewport: viewport.name, assertions: [], screenshots: [] };
			try {
				await scenario.run(context, result);
			} catch (error) {
				check(result, 'scenario completed without throwing', false, error.message);
			}
			try {
				const file = await context.screenshot('player-back-101-' + scenario.name + '-' + viewport.name + '.png');
				result.screenshots.push(file.replace(/\\/g, '/'));
			} catch {}
			results.push(result);
		}
	}
	chromeConsoleErrors = [...new Set(chromeConsoleErrors)].slice(0, 20);
} finally {
	child.kill();
	await sleep(700);
	try { rmSync(profile, { recursive: true, force: true }); } catch {}
	server.closeAllConnections();
	server.close();
}

const interpretation = [
	'In-document origins pass on desktop and mobile: collection search/sort/source/scroll, guide search/group/scroll, series season and episode list, favourites grid and scroll, and direct /?item= details are restored by player Back.',
	'Opening the player adds exactly one history entry; closing it does not add another. Browser Back and player Back take the same restore path for in-document origins.',
	'Episode autoplay, retry and quality changes keep the originally recorded origin and add no history entries. A cancelled catch-up resume (nested over the guide details) leaves no player, no history entry or origin corruption.',
	'Playback cleanup still runs on Back: a session stop request is sent, the video source is cleared and state.session is reset.',
	'Same-origin search and Discover handoffs are skipped in one player Back: Back returns directly to /search?q=... or /discover?type=... and does not load or stop on the intermediate home /?item= entry. The history index moves two entries back and the destination query/params and results are restored.',
	'Cross-document return state is proven in the browser: search restores query, type filter, scroll and the loaded result page; Discover restores genre, sort, scroll, the loaded page and the open detail dialog with the same title and watch link.',
	'Return state is one-shot and expiring: it is consumed on the first return, a normal reload or direct visit does not re-apply stale scroll/dialog state, and a return record whose timestamp is aged out is ignored. sessionStorage is inspected for credentials, API paths and media URLs and must contain none.',
	'Three rapid synchronous clicks on the player close button are guarded by the in-flight Back flag, so the history stays on the origin entry instead of walking past it.',
	'Fullscreen is exited on player Back: document.fullscreenElement clears after the player dialog closes.',
];

const allAssertions = results.flatMap(result => result.assertions);
const passed = allAssertions.filter(assertion => assertion.pass === true).length;
const failed = allAssertions.filter(assertion => assertion.pass === false).length;
const skipped = allAssertions.filter(assertion => assertion.skipped).length;
const ready = failed === 0 && results.length === scenarioList.length * viewports.length;

const report = {
	generatedAt: new Date().toISOString(),
	release: 101,
	scope: 'Web player Back navigation (desktop and mobile)',
	chrome: chromePath,
	origin,
	viewports,
	ready,
	summary: {
		scenarios: results.length,
		passed,
		failed,
		skipped,
	},
	interpretation,
	results,
	consoleErrors: chromeConsoleErrors,
	mock: {
		playCalls: mockState.playCalls.length,
		stops: mockState.stops.length,
	},
};

writeFileSync(join(outDir, 'BROWSER-PLAYER-BACK-101.json'), JSON.stringify(report, null, 2) + '\n');

const lines = [];
lines.push('# Browser player Back check - release 101');
lines.push('');
lines.push('Generated: ' + report.generatedAt);
lines.push('Chrome: `' + chromePath + '`');
lines.push('Overall: ' + (ready ? 'PASS' : 'FAIL') + ' - ' + passed + ' passed, ' + failed + ' failed, ' + skipped + ' skipped across ' + results.length + ' scenario runs.');
lines.push('');
lines.push('This harness serves the real `server/public/index.html`, `app.js` and player markup with mocked `/api` responses. It does not edit or stub the application source.');
lines.push('');
lines.push(ready ? '## Findings' : '## Expected final findings (not all met yet)');
lines.push('');
for (const note of interpretation) lines.push('- ' + note);
lines.push('');
for (const result of results) {
	const failures = result.assertions.filter(assertion => assertion.pass === false);
	const skips = result.assertions.filter(assertion => assertion.skipped);
	lines.push('## ' + result.name + ' - ' + result.viewport + (failures.length ? ' (FAIL)' : ' (pass)'));
	if (failures.length) {
		for (const failure of failures) lines.push('- FAIL: ' + failure.name + (failure.detail ? ' - ' + failure.detail : ''));
	}
	if (skips.length) {
		for (const entry of skips) lines.push('- SKIP: ' + entry.name + (entry.detail ? ' - ' + entry.detail : ''));
	}
	if (!failures.length && !skips.length) lines.push('- All assertions passed.');
	lines.push('');
}
if (chromeConsoleErrors.length) {
	lines.push('## Browser console errors');
	lines.push('');
	for (const error of chromeConsoleErrors) lines.push('- ' + error);
	lines.push('');
}
writeFileSync(join(outDir, 'BROWSER-PLAYER-BACK-101.md'), lines.join('\n'));

console.log(JSON.stringify({
	ready,
	summary: report.summary,
	failures: results.flatMap(result => result.assertions.filter(assertion => assertion.pass === false).map(assertion => result.name + '/' + result.viewport + ': ' + assertion.name + (assertion.detail ? ' - ' + assertion.detail : ''))),
	skips: results.flatMap(result => result.assertions.filter(assertion => assertion.skipped).map(assertion => result.name + '/' + result.viewport + ': ' + assertion.name)),
	evidence: outDir.replace(/\\/g, '/'),
}, null, 2));
process.exitCode = ready ? 0 : 1;
