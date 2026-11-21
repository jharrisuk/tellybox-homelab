/* Local headless Chrome check for release 105 Home playability.
 *
 * This serves the real server/public Home UI with local stubbed API fixtures.
 * It never starts a real stream, never touches production, never uses live
 * playback, never mutates a provider catalogue and never writes outside the
 * release 105 evidence folder.
 *
 * The fixture models the release 105 Home rail: one available Series with two
 * episodes, one Movie with no artwork at all and one Movie whose artwork route
 * fails to decode. A confirmed-empty Series exists in the catalogue and its
 * details route returns { items: [], notice: '' }, but the Home feed is stubbed
 * without it because browser code cannot perform the server-side episode
 * filter. The direct-details case exercises its informative empty state.
 *
 * If Chrome or Chromium is unavailable the check prints SKIP and exits 0; it
 * never claims a browser pass without running one.
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const publicDirectory = fileURLToPath(new URL('../public/', import.meta.url));
const outDir = fileURLToPath(new URL('../../outputs/Tellybox-playable-home-105/evidence/', import.meta.url));
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
	console.log('SKIP: Chrome or Chromium was not found. Set CHROME_PATH to run the release 105 Home browser check.');
	process.exit(0);
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const originPlaceholder = 'http://127.0.0.1';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const posterSvg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="300" height="450" viewBox="0 0 300 450"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#4a6040"/><stop offset="1" stop-color="#182016"/></linearGradient></defs><rect width="300" height="450" fill="url(#g)"/><circle cx="150" cy="180" r="62" fill="none" stroke="#c4ed80" stroke-width="8"/><path d="M132 148l50 32-50 32z" fill="#c4ed80"/><text x="150" y="320" fill="#c4ed80" font-family="Georgia, serif" font-size="24" text-anchor="middle">Fixture</text></svg>');
const brokenImage = Buffer.from('This fixture route deliberately returns bytes that are not a decodable image.');

function fixtureSeries(id, name, artwork = '/fixture-poster.svg') {
	return {
		Id: id,
		Name: name,
		Type: 'Series',
		Source: 'streamed',
		Provider: 'Fixture catalogue',
		Genres: ['Drama'],
		ProductionYear: 2024,
		Overview: 'A fixture series used only by the local release 105 browser check.',
		Artwork: artwork,
		UserData: {},
	};
}

function fixtureMovie(id, name, artwork) {
	const item = {
		Id: id,
		Name: name,
		Type: 'Movie',
		Source: 'streamed',
		Provider: 'Fixture catalogue',
		Genres: ['Drama'],
		ProductionYear: 2024,
		RunTimeTicks: 7200 * 1e7,
		Overview: 'A fixture film used only by the local release 105 browser check.',
		Ratings: [{ source: 'Viewer score', value: 8, max: 10, votes: 500 }],
		UserData: {},
	};
	if (artwork) item.Artwork = artwork;
	return item;
}

function fixtureEpisode(id, series, index, name) {
	return {
		Id: id,
		Name: name,
		Type: 'Episode',
		Source: 'local',
		SeriesId: series.Id,
		SeriesName: series.Name,
		ParentIndexNumber: 1,
		IndexNumber: index,
		RunTimeTicks: 2400 * 1e7,
		Overview: 'Fixture episode ' + index + ' for ' + series.Name + '.',
		Artwork: '/fixture-poster.svg',
		UserData: {},
	};
}

const emptySeries = fixtureSeries('90000000-0000-4000-8000-000000000001', 'The Royals');
const availableSeries = fixtureSeries('90000000-0000-4000-8000-000000000002', 'Final Table');
const noArtworkMovie = fixtureMovie('90000000-0000-4000-8000-000000000003', '3 Way');
const brokenArtworkMovie = fixtureMovie('90000000-0000-4000-8000-000000000004', 'Dear You', '/fixture-broken-artwork.png');
const episodes = [
	fixtureEpisode('91000000-0000-4000-8000-000000000001', availableSeries, 1, 'The opening course'),
	fixtureEpisode('91000000-0000-4000-8000-000000000002', availableSeries, 2, 'The final course'),
];
const catalogue = [emptySeries, availableSeries, noArtworkMovie, brokenArtworkMovie];
const catalogueById = new Map(catalogue.map(item => [item.Id, item]));

// The empty series is deliberately not in this feed. The server removes
// confirmed-empty series before Home renders; a browser fixture must mirror
// that post-filter state, otherwise it would test browser-side filtering that
// does not exist.
const homeFeedFixture = {
	personalized: true,
	coldStart: false,
	generatedAt: '2026-11-09T09:00:00.000Z',
	rows: [
		{
			id: 'new',
			title: 'Recently added',
			note: 'New in the collection and streamed catalogue',
			items: [availableSeries, noArtworkMovie, brokenArtworkMovie],
		},
	],
	featured: [{ ...availableSeries, _reason: 'Picked for you' }],
};

const state = {
	homeRequests: 0,
	homeFeedNames: [],
	detailRequests: [],
	episodeRequests: [],
	playRequests: [],
	playResponses: 0,
	sessionStops: [],
	consoleErrors: [],
	logErrors: [],
};

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

function sendUndecodableImage(response) {
	response.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': brokenImage.length, 'Cache-Control': 'no-store' });
	response.end(brokenImage);
}

async function readJsonBody(request) {
	let body = '';
	for await (const chunk of request) body += chunk;
	try { return JSON.parse(body || '{}'); } catch { return {}; }
}

async function handleApi(url, request, response) {
	const path = url.pathname;
	const method = request.method || 'GET';
	if (path === '/api/version') { sendJson(response, { version: '0.27.0' }); return; }
	if (path === '/api/capabilities') {
		sendJson(response, { canShare: false, playbackDefaults: { englishSubtitles: false, autoNext: false, skipIntros: false } });
		return;
	}
	if (path === '/api/auth/status') {
		sendJson(response, { local: true, home: false, person: { id: 'person-1', name: 'Local Viewer' }, authenticated: true, email: null, localPlayback: null });
		return;
	}
	if (path === '/api/auth/logout') { sendJson(response, { ok: true }); return; }
	if (path === '/api/status') {
		sendJson(response, { connected: true, features: { discover: false, comingSoon: false, live: false, recordings: false } });
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
		sendJson(response, { own: { id: 'me', name: 'My favourites', items: [] } });
		return;
	}
	if (path === '/api/viewing-status') { sendJson(response, { blocked: false, remainingSeconds: null }); return; }
	if (path === '/api/coming-soon') { sendJson(response, { movies: [], tv: [] }); return; }
	if (path === '/api/web/items') {
		sendJson(response, { items: catalogue, total: catalogue.length, genres: ['Drama'] });
		return;
	}
	if (path === '/api/web/home') {
		state.homeRequests += 1;
		state.homeFeedNames = homeFeedFixture.rows.flatMap(row => row.items.map(item => item.Name));
		sendJson(response, homeFeedFixture);
		return;
	}
	if (path === '/api/web/releases') { sendJson(response, { items: [] }); return; }
	if (path === '/api/web/releases/tv') { sendJson(response, { items: [] }); return; }

	const episodeMatch = /^\/api\/web\/items\/([^/]+)\/episodes$/.exec(path);
	if (episodeMatch) {
		const id = decodeURIComponent(episodeMatch[1]);
		state.episodeRequests.push(id);
		if (id === availableSeries.Id) { sendJson(response, { items: episodes, notice: '' }); return; }
		if (id === emptySeries.Id) { sendJson(response, { items: [], notice: '' }); return; }
		sendJson(response, { items: [], notice: '' });
		return;
	}

	const playTargetMatch = /^\/api\/web\/play-target\/([^/]+)$/.exec(path);
	if (playTargetMatch) {
		const id = decodeURIComponent(playTargetMatch[1]);
		const item = catalogueById.get(id);
		if (item?.Type === 'Series' && id === availableSeries.Id) {
			sendJson(response, { id: episodes[0].Id, type: 'Episode', name: episodes[0].Name, seriesId: item.Id, seriesName: item.Name, position: 0, reason: 'next' });
			return;
		}
		if (item?.Type === 'Series') {
			sendJson(response, { error: 'Everything available in this series has been watched.', code: 'SERIES_COMPLETE' }, 409);
			return;
		}
		sendJson(response, item || { error: 'Fixture item not found.' }, item ? 200 : 404);
		return;
	}

	const itemMatch = /^\/api\/web\/items\/([^/]+)$/.exec(path);
	if (itemMatch) {
		const id = decodeURIComponent(itemMatch[1]);
		state.detailRequests.push(id);
		const item = catalogueById.get(id);
		if (item) sendJson(response, item);
		else sendJson(response, { error: 'Fixture item not found.' }, 404);
		return;
	}

	if (path === '/api/play' && method === 'POST') {
		const body = await readJsonBody(request);
		state.playRequests.push({ id: body.id || null, body });
		// The browser check closes the player before this controlled response
		// arrives, so startPlayback's stale-generation/closed-player branch stops
		// the fixture session and never attaches a media URL.
		await sleep(700);
		state.playResponses += 1;
		sendJson(response, {
			session: 'fixture-session-1',
			kind: 'audio',
			mediaRoute: 'fixture',
			method: 'Fixture',
			live: false,
			url: '',
			audio: [],
			subtitles: [],
		});
		return;
	}
	if (path.startsWith('/api/sessions/') && method === 'POST') {
		state.sessionStops.push(path);
		sendJson(response, { ok: true });
		return;
	}
	if (path.startsWith('/api/recording-files/')) { sendJson(response, { IsRecording: false }); return; }
	if (path.startsWith('/api/web/art/') || path.startsWith('/images/')) { sendPng(response); return; }
	if (path.startsWith('/api/')) { sendJson(response, {}); return; }
	sendJson(response, { error: 'Mock API route not configured: ' + path }, 404);
}

const htmlRoutes = new Map([['/', 'index.html']]);
const server = createServer(async (request, response) => {
	const url = new URL(request.url || '/', originPlaceholder);
	if (url.pathname === '/fixture-poster.svg') {
		response.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Content-Length': posterSvg.length, 'Cache-Control': 'no-store' });
		response.end(posterSvg);
		return;
	}
	if (url.pathname === '/fixture-poster.png') { sendPng(response); return; }
	if (url.pathname === '/fixture-broken-artwork.png') { sendUndecodableImage(response); return; }
	// A missing artwork path still returns bytes, so Chrome records a decode
	// failure for the card instead of a network 404. The card must remove the
	// image and leave its text placeholder visible.
	if (url.pathname.startsWith('/images/')) { sendUndecodableImage(response); return; }
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
	const mapped = htmlRoutes.get(url.pathname);
	const file = mapped ? join(publicDirectory, mapped) : join(publicDirectory, url.pathname.replace(/^\//, ''));
	if (!file.startsWith(publicDirectory) || !existsSync(file)) {
		response.writeHead(404, { 'Content-Type': 'text/plain' });
		response.end('not found');
		return;
	}
	response.writeHead(200, { 'Content-Type': contentTypes[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
	response.end(readFileSync(file));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = 'http://127.0.0.1:' + server.address().port;

const profile = mkdtempSync(join(tmpdir(), 'tellybox-playable-home-105-'));
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
	providerMutation: false,
	checks: {},
	consoleErrors: state.consoleErrors,
	logErrors: state.logErrors,
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
		if (value) state.consoleErrors.push(String(value).split('\n')[0]);
	});
	on('Runtime.consoleAPICalled', params => {
		if (params?.type !== 'error') return;
		const text = (params.args || []).map(argument => argument.value ?? argument.description ?? '').join(' ');
		if (text) state.consoleErrors.push(text.split('\n')[0]);
	});
	on('Log.entryAdded', params => {
		if (params?.entry?.level === 'error') state.logErrors.push(String(params.entry.text || '').split('\n')[0] + ' | ' + String(params.entry.url || ''));
	});
	await send('Page.enable');
	await send('Runtime.enable');
	await send('Log.enable');
	await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });

	const evaluate = async expression => {
		const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
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
	const waitMock = async (predicate, timeout = 8000, label = 'fixture request') => {
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
	const screenshot = async name => {
		const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
		writeFileSync(join(outDir, name), Buffer.from(shot.data, 'base64'));
		return name;
	};
	const scrollTo = selector => evaluate(`(() => { const node = document.querySelector(${JSON.stringify(selector)}); if (!node) return false; node.scrollIntoView({ block: 'center', inline: 'nearest' }); return true; })()`);
	const clickTile = name => evaluate(`(() => {
		const tile = [...document.querySelectorAll('#homeRows .home-tile')].find(node => node.querySelector('h3')?.textContent === ${JSON.stringify(name)});
		const button = tile?.querySelector('button.card');
		if (!button) return false;
		button.click();
		return true;
	})()`);

	const snapshotHome = () => evaluate(`(() => {
		const posterState = tile => {
			const poster = tile.querySelector('.poster');
			const image = poster?.querySelector('img');
			const fallback = poster?.querySelector('.fallback');
			return {
				hasImage: Boolean(image),
				imageComplete: image ? image.complete : null,
				naturalWidth: image ? image.naturalWidth : 0,
				imageSource: image ? (image.currentSrc || image.src || '') : '',
				fallbackText: fallback?.textContent || '',
				fallbackVisible: fallback ? Boolean(fallback.getClientRects().length) : false,
				posterVisible: poster ? Boolean(poster.getClientRects().length) : false
			};
		};
		const rows = [...document.querySelectorAll('#homeRows .home-row')].map(section => ({
			title: section.querySelector('.shelf-heading h3')?.textContent || '',
			note: section.querySelector('.shelf-description')?.textContent || '',
			items: [...section.querySelectorAll('.home-tile')].map(tile => {
				const card = tile.querySelector('button.card');
				return {
					name: card?.querySelector('h3')?.textContent || '',
					label: card?.getAttribute('aria-label') || '',
					more: tile.querySelector('.home-info')?.getAttribute('aria-label') || '',
					poster: posterState(tile)
				};
			})
		}));
		const allPosterImages = [...document.querySelectorAll('#homeRows .home-tile .poster img')];
		return {
			homeFeedVisible: Boolean(document.querySelector('#homeFeed')) && !document.querySelector('#homeFeed').hidden,
			homeLabelledBy: document.querySelector('#homeFeed')?.getAttribute('aria-labelledby') || '',
			status: document.querySelector('#homeFeedStatus')?.textContent || '',
			rows,
			hero: {
				visible: Boolean(document.querySelector('#homeHero')) && !document.querySelector('#homeHero').hidden,
				title: document.querySelector('#homeHeroTitle')?.textContent || '',
				playText: document.querySelector('#homeHeroPlay')?.textContent || '',
				playHidden: Boolean(document.querySelector('#homeHeroPlay')?.hidden),
				detailsLabel: document.querySelector('#homeHeroDetails')?.getAttribute('aria-label') || '',
				imageComplete: document.querySelector('#homeHeroImage')?.complete ?? null,
				imageNaturalWidth: document.querySelector('#homeHeroImage')?.naturalWidth ?? 0
			},
			posterImages: allPosterImages.map(image => ({
				complete: image.complete,
				naturalWidth: image.naturalWidth,
				source: image.currentSrc || image.src || ''
			}))
		};
	})()`);

	const snapshotDetails = () => evaluate(`(() => {
		const dialog = document.querySelector('#details');
		const body = document.querySelector('#detailsBody');
		return {
			open: Boolean(dialog?.open),
			title: document.querySelector('#detailsTitle')?.textContent || '',
			eyebrow: body?.querySelector('.eyebrow')?.textContent || '',
			meta: body?.querySelector('.detail-meta')?.textContent || '',
			overview: body?.querySelector('.overview')?.textContent || '',
			seasonTabs: [...(body?.querySelectorAll('.season-tab') || [])].map(node => node.textContent || ''),
			episodes: [...(body?.querySelectorAll('.episode') || [])].map(node => ({
				title: node.querySelector('.episode-title')?.textContent || '',
				label: node.getAttribute('aria-label') || ''
			})),
			episodeListText: body?.querySelector('.episode-list')?.textContent || '',
			continueButton: body?.querySelector('.series-continue')?.textContent || '',
			primaryButtons: [...(body?.querySelectorAll('.button.primary') || [])].map(node => node.textContent || ''),
			artHasImage: Boolean(body?.querySelector('.detail-art')),
			artComplete: body?.querySelector('.detail-art')?.complete ?? null,
			artNaturalWidth: body?.querySelector('.detail-art')?.naturalWidth ?? 0
		};
	})()`);

	let checksPassed = true;
	const check = (name, condition, detail) => {
		results.checks[name] = { pass: Boolean(condition), detail };
		if (!condition) checksPassed = false;
	};

	await navigate(origin + '/');
	await waitFor("(() => { const row = [...document.querySelectorAll('#homeRows .home-row')].find(section => section.querySelector('.shelf-heading h3')?.textContent === 'Recently added'); return Boolean(row && row.querySelectorAll('.home-tile').length === 3); })()", 12000, 'Recently added row');
	await scrollTo('#homeRows .home-row');
	const artworkSettled = `(() => {
		const tiles = [...document.querySelectorAll('#homeRows .home-tile')];
		const tile = name => tiles.find(node => node.querySelector('h3')?.textContent === name);
		const available = tile(${JSON.stringify(availableSeries.Name)});
		const missing = tile(${JSON.stringify(noArtworkMovie.Name)});
		const broken = tile(${JSON.stringify(brokenArtworkMovie.Name)});
		if (!available || !missing || !broken) return false;
		const image = available.querySelector('.poster img');
		return !missing.querySelector('.poster img')
			&& !broken.querySelector('.poster img')
			&& Boolean(image && image.complete && image.naturalWidth > 0);
	})()`;
	await waitFor(artworkSettled, 12000, 'home artwork settled');
	await sleep(250);

	const home = await snapshotHome();
	const row = home.rows.find(entry => entry.title === 'Recently added');
	const itemByName = name => (row?.items || []).find(item => item.name === name);
	const available = itemByName(availableSeries.Name);
	const missing = itemByName(noArtworkMovie.Name);
	const broken = itemByName(brokenArtworkMovie.Name);
	const renderedNames = home.rows.flatMap(entry => entry.items.map(item => item.name));

	check('home feed visible', home.homeFeedVisible === true, home.homeFeedVisible);
	check('home feed labelled', home.homeLabelledBy === 'homeFeedTitle', home.homeLabelledBy);
	check('recently added row present', Boolean(row), row?.title || 'missing');
	check('fixture feed excludes confirmed-empty series', !state.homeFeedNames.includes(emptySeries.Name), state.homeFeedNames);
	check('confirmed-empty series absent from rails', !renderedNames.includes(emptySeries.Name), renderedNames);
	check('only fixture series and movies rendered', JSON.stringify(renderedNames) === JSON.stringify([availableSeries.Name, noArtworkMovie.Name, brokenArtworkMovie.Name]), renderedNames);
	check('available series present', Boolean(available), available || 'missing');
	check('missing-art movie present', Boolean(missing), missing || 'missing');
	check('broken-art movie present', Boolean(broken), broken || 'missing');
	check('series card is not a play label', Boolean(available?.label) && !/^Play /.test(available.label), available?.label);
	check('series card accessible label', available?.label === availableSeries.Name + ', Series', available?.label);
	check('missing-art movie play label', missing?.label === 'Play ' + noArtworkMovie.Name, missing?.label);
	check('broken-art movie play label', broken?.label === 'Play ' + brokenArtworkMovie.Name, broken?.label);
	check('series more-info label', available?.more === 'More info about ' + availableSeries.Name, available?.more);
	check('missing-art more-info label', missing?.more === 'More info about ' + noArtworkMovie.Name, missing?.more);
	check('broken-art more-info label', broken?.more === 'More info about ' + brokenArtworkMovie.Name, broken?.more);
	check('available series poster loaded', available?.poster.hasImage === true && available.poster.imageComplete === true && available.poster.naturalWidth > 0, available?.poster);
	check('missing-art movie image removed', missing?.poster.hasImage === false, missing?.poster);
	check('missing-art movie placeholder visible', missing?.poster.fallbackVisible === true && missing.poster.fallbackText === noArtworkMovie.Name, missing?.poster);
	check('broken-art movie image removed', broken?.poster.hasImage === false, broken?.poster);
	check('broken-art movie placeholder visible', broken?.poster.fallbackVisible === true && broken.poster.fallbackText === brokenArtworkMovie.Name, broken?.poster);
	check('no broken poster image remains', home.posterImages.every(image => image.complete && image.naturalWidth > 0), home.posterImages);
	check('hero says view episodes for series', home.hero.visible === true && home.hero.playText === 'View episodes' && home.hero.playHidden === false, home.hero);
	check('home request reached fixture', state.homeRequests >= 1, state.homeRequests);

	await scrollTo('#homeRows .home-row');
	await sleep(150);
	const homeShot = await screenshot('HOME-PLAYABLE-105.png');
	await scrollTo('#homeHero');
	await sleep(150);
	const heroShot = await screenshot('HOME-PLAYABLE-105-HERO.png');

	const playsBeforeSeries = state.playRequests.length;
	const seriesClicked = await clickTile(availableSeries.Name);
	await waitFor("document.querySelector('#details')?.open === true && document.querySelector('#detailsTitle')?.textContent === " + JSON.stringify(availableSeries.Name), 12000, 'series details');
	await waitFor("document.querySelectorAll('#detailsBody .episode').length === 2", 12000, 'series episodes');
	const seriesDetails = await snapshotDetails();
	check('available series card opens details', seriesClicked === true && seriesDetails.open === true, { seriesClicked, open: seriesDetails.open });
	check('series details title', seriesDetails.title === availableSeries.Name, seriesDetails.title);
	check('series details shows season', seriesDetails.seasonTabs.some(text => text.includes('Season 1') && text.includes('2 episodes')), seriesDetails.seasonTabs);
	check('series details shows two episodes', seriesDetails.episodes.length === 2, seriesDetails.episodes);
	check('series episode titles', JSON.stringify(seriesDetails.episodes.map(episode => episode.title)) === JSON.stringify(episodes.map(episode => episode.Name)), seriesDetails.episodes);
	check('series details has no generic play button', !seriesDetails.primaryButtons.some(text => text.trim() === '▶  Play'), seriesDetails.primaryButtons);
	check('series card did not start playback', state.playRequests.length === playsBeforeSeries && !state.playRequests.some(request => request.id === availableSeries.Id || episodes.some(episode => episode.Id === request.id)), state.playRequests);
	await sleep(150);
	const seriesShot = await screenshot('SERIES-DETAILS-105.png');
	await evaluate("(() => { const dialog = document.querySelector('#details'); const selector = document.querySelector('#detailsBody .season-selector'); if (dialog && selector) dialog.scrollTop = selector.offsetTop - 24; return true; })()");
	await sleep(200);
	const seriesEpisodesShot = await screenshot('SERIES-DETAILS-105-EPISODES.png');

	await evaluate("document.querySelector('#closeDetails')?.click()");
	await waitFor("document.querySelector('#details')?.open === false", 8000, 'series details closed');

	const playsBeforeMovie = state.playRequests.length;
	const movieClicked = await clickTile(noArtworkMovie.Name);
	await waitMock(() => state.playRequests.length > playsBeforeMovie, 12000, 'movie playback request');
	const moviePlay = state.playRequests[state.playRequests.length - 1];
	await waitFor("document.querySelector('#player')?.open === true", 8000, 'player dialog');
	check('movie card requests playback', movieClicked === true && state.playRequests.length === playsBeforeMovie + 1, { movieClicked, count: state.playRequests.length - playsBeforeMovie });
	check('movie playback uses movie id', moviePlay?.id === noArtworkMovie.Id && moviePlay?.body?.id === noArtworkMovie.Id, moviePlay);
	check('movie playback is not a series id', ![emptySeries.Id, availableSeries.Id, ...episodes.map(episode => episode.Id)].includes(moviePlay?.id), moviePlay?.id);
	await evaluate("document.querySelector('#closePlayer')?.click()");
	await waitFor("document.querySelector('#player')?.open === false", 8000, 'player closed');
	await waitMock(() => state.playResponses >= 1, 8000, 'controlled play response');
	await sleep(250);
	const mediaState = await evaluate("(() => { const video = document.querySelector('#video'); return { currentSrc: video?.currentSrc || '', src: video?.getAttribute('src') || '', paused: video?.paused ?? null }; })()");
	check('controlled play fixture never attached media', mediaState.currentSrc === '' && mediaState.src === '', mediaState);
	check('controlled play fixture session was stopped', state.sessionStops.some(path => path.includes('fixture-session-1')), state.sessionStops);

	await navigate(origin + '/?item=' + encodeURIComponent(emptySeries.Id));
	await waitFor("document.querySelector('#details')?.open === true && document.querySelector('#detailsTitle')?.textContent === " + JSON.stringify(emptySeries.Name), 12000, 'empty series details');
	await waitFor("document.querySelector('#detailsBody .episode-list')?.textContent.includes('No episodes are available for this series yet.')", 12000, 'empty series message');
	const emptyDetails = await snapshotDetails();
	check('empty series direct details opens', emptyDetails.open === true, emptyDetails.open);
	check('empty series details title', emptyDetails.title === emptySeries.Name, emptyDetails.title);
	check('empty series informative state', emptyDetails.episodeListText.includes('No episodes are available for this series yet. It may appear later; try again.'), emptyDetails.episodeListText);
	check('empty series has no seasons or episodes', emptyDetails.seasonTabs.length === 0 && emptyDetails.episodes.length === 0, { seasons: emptyDetails.seasonTabs, episodes: emptyDetails.episodes });
	check('empty series direct details did not start playback', !state.playRequests.some(request => request.id === emptySeries.Id), state.playRequests.map(request => request.id));
	check('empty series details fetched empty episodes', state.episodeRequests.includes(emptySeries.Id), state.episodeRequests);
	await evaluate("(() => { const dialog = document.querySelector('#details'); if (dialog) dialog.scrollTop = dialog.scrollHeight; return true; })()");
	await sleep(200);
	const emptyShot = await screenshot('EMPTY-SERIES-DETAILS-105.png');

	await sleep(400);
	check('no console errors', state.consoleErrors.length === 0, state.consoleErrors);
	check('no browser log errors', state.logErrors.length === 0, state.logErrors);

	results.ok = checksPassed;
	results.fixture = {
		emptySeries: { id: emptySeries.Id, name: emptySeries.Name, feed: 'omitted; direct details only' },
		availableSeries: { id: availableSeries.Id, name: availableSeries.Name, episodes: episodes.map(episode => episode.Name) },
		noArtworkMovie: { id: noArtworkMovie.Id, name: noArtworkMovie.Name, artwork: null },
		brokenArtworkMovie: { id: brokenArtworkMovie.Id, name: brokenArtworkMovie.Name, artwork: brokenArtworkMovie.Artwork },
	};
	results.requests = {
		home: state.homeRequests,
		details: state.detailRequests,
		episodes: state.episodeRequests,
		play: state.playRequests,
		playResponses: state.playResponses,
		sessionStops: state.sessionStops,
	};
	results.renderedRails = home.rows;
	results.seriesDetails = seriesDetails;
	results.emptySeriesDetails = emptyDetails;
	results.consoleErrors = state.consoleErrors;
	results.logErrors = state.logErrors;
	results.screenshots = [homeShot, heroShot, seriesShot, seriesEpisodesShot, emptyShot];
	writeFileSync(join(outDir, 'BROWSER-PLAYABLE-HOME-105.json'), JSON.stringify(results, null, 2) + '\n');
	console.log(JSON.stringify(results, null, 2));
	process.exitCode = checksPassed ? 0 : 1;
	socket.close();
} finally {
	child.kill();
	await sleep(700);
	try { rmSync(profile, { recursive: true, force: true }); } catch {}
	server.closeAllConnections();
	server.close();
}
