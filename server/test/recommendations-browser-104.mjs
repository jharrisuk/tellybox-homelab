/* Local headless Chrome check for release 104 Home recommendations.
 *
 * This serves the real server/public Home UI with local stubbed API fixtures.
 * It never starts a real stream, never touches production, never uses live
 * playback and never writes outside the release 104 evidence folder.
 *
 * The fixture models a six-hour recommendation window: a reload in the same
 * window must show the same "Picked for you" titles, while advancing the
 * fixture to a fresh generation must replace them. The check also records the
 * accessible labels on the recommendation cards and the featured rotation.
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
const outDir = fileURLToPath(new URL('../../outputs/Tellybox-recommendations-104/evidence/', import.meta.url));
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
	console.log('SKIP: Chrome or Chromium was not found. Set CHROME_PATH to run the release 104 Home browser check.');
	process.exit(0);
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const originPlaceholder = 'http://127.0.0.1';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');

function fixtureItem(id, name, type = 'Movie') {
	return {
		Id: id,
		Name: name,
		Type: type,
		Source: 'local',
		Genres: ['Drama'],
		ProductionYear: 2024,
		RunTimeTicks: 7200 * 1e7,
		Ratings: [{ source: 'Viewer score', value: 8, max: 10, votes: 500 }],
		Artwork: '/fixture-poster.png',
		UserData: {},
	};
}

const picksA = Array.from({ length: 12 }, (_, index) => fixtureItem(
	'40000000-0000-4000-8000-' + String(index + 1).padStart(12, '0'),
	'Window A pick ' + String(index + 1).padStart(2, '0'),
	index % 2 ? 'Series' : 'Movie'
));
const picksB = Array.from({ length: 12 }, (_, index) => fixtureItem(
	'50000000-0000-4000-8000-' + String(index + 1).padStart(12, '0'),
	'Window B pick ' + String(index + 1).padStart(2, '0'),
	index % 2 ? 'Series' : 'Movie'
));
const continueItems = [
	fixtureItem('60000000-0000-4000-8000-000000000001', 'Continue fixture film'),
	fixtureItem('60000000-0000-4000-8000-000000000002', 'Continue fixture series', 'Series'),
];
const favouriteItems = [fixtureItem('61000000-0000-4000-8000-000000000001', 'Favourite fixture film')];
const filmItems = Array.from({ length: 6 }, (_, index) => fixtureItem(
	'62000000-0000-4000-8000-' + String(index + 1).padStart(12, '0'),
	'Film rail fixture ' + String(index + 1).padStart(2, '0')
));
const recentItems = Array.from({ length: 6 }, (_, index) => fixtureItem(
	'63000000-0000-4000-8000-' + String(index + 1).padStart(12, '0'),
	'Recent rail fixture ' + String(index + 1).padStart(2, '0')
));
const topItems = Array.from({ length: 6 }, (_, index) => fixtureItem(
	'64000000-0000-4000-8000-' + String(index + 1).padStart(12, '0'),
	'Top rail fixture ' + String(index + 1).padStart(2, '0')
));

const state = {
	generation: 0,
	homeRequests: 0,
	playCalls: 0,
	consoleErrors: [],
};

function homeFeed(generation) {
	const picks = generation === 0 ? picksA : picksB;
	return {
		personalized: true,
		coldStart: false,
		generatedAt: '2026-11-08T15:17:23.000Z',
		rows: [
			{ id: 'continue', title: 'Continue watching', note: '', items: continueItems },
			{ id: 'favourites', title: 'Your favourites', note: 'Ready when you are', items: favouriteItems },
			{ id: 'for-you', title: 'Picked for you', note: 'A varied start from the collection', items: picks },
			{ id: 'films', title: 'Films for you', note: '', items: filmItems },
			{ id: 'new', title: 'Recently added', note: 'New in the collection and streamed catalogue', items: recentItems },
			{ id: 'top', title: 'Top rated in your collection', note: '', items: topItems },
		],
		featured: picks.slice(0, 2).map(item => ({ ...item, _reason: 'Picked for you' })),
	};
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

async function handleApi(url, request, response) {
	const path = url.pathname;
	const method = request.method || 'GET';
	if (path === '/api/version') { sendJson(response, { version: '0.26.23' }); return; }
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
	if (path === '/api/web/items') {
		sendJson(response, { items: [...picksA, ...continueItems, ...favouriteItems, ...filmItems], total: 31, genres: ['Drama'] });
		return;
	}
	if (path === '/api/web/home') {
		state.homeRequests += 1;
		sendJson(response, homeFeed(state.generation));
		return;
	}
	if (path === '/api/web/releases') { sendJson(response, { items: [] }); return; }
	if (path === '/api/web/releases/tv') { sendJson(response, { items: [] }); return; }
	if (path === '/api/play') {
		state.playCalls += 1;
		sendJson(response, { error: 'Fixture only: playback is not started by this check.' }, 400);
		return;
	}
	if (path === '/api/__fixture/advance' && method === 'POST') {
		state.generation = 1;
		sendJson(response, { generation: state.generation });
		return;
	}
	if (path === '/api/__fixture/state') {
		sendJson(response, { generation: state.generation, homeRequests: state.homeRequests, playCalls: state.playCalls });
		return;
	}
	if (path.startsWith('/api/web/art/') || path.startsWith('/images/')) { sendPng(response); return; }
	if (path.startsWith('/api/')) { sendJson(response, {}); return; }
	sendJson(response, { error: 'Mock API route not configured: ' + path }, 404);
}

const htmlRoutes = new Map([['/', 'index.html']]);
const server = createServer(async (request, response) => {
	const url = new URL(request.url || '/', originPlaceholder);
	if (url.pathname === '/fixture-poster.png') { sendPng(response); return; }
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

const profile = mkdtempSync(join(tmpdir(), 'tellybox-recommendations-104-'));
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

const results = { fixtureOnly: true, livePlayback: false, checks: {}, consoleErrors: state.consoleErrors };
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
		if (params?.entry?.level === 'error') state.consoleErrors.push(String(params.entry.text || '').split('\n')[0]);
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
	const reload = async () => {
		await send('Page.reload', { ignoreCache: true });
		await waitFor("document.readyState === 'complete'", 12000, 'page reload');
	};
	const click = async selector => {
		const clicked = await evaluate(`(() => { const node = document.querySelector(${JSON.stringify(selector)}); if (!node) return false; node.click(); return true; })()`);
		if (!clicked) throw new Error('Could not click ' + selector);
	};
	const snapshot = () => evaluate(`(() => {
		const rows = [...document.querySelectorAll('#homeRows .home-row')].map(section => ({
			title: section.querySelector('.shelf-heading h3')?.textContent || '',
			note: section.querySelector('.shelf-description')?.textContent || '',
			items: [...section.querySelectorAll('.home-tile button.card')].map(card => ({
				name: card.querySelector('h3')?.textContent || '',
				label: card.getAttribute('aria-label') || '',
				more: card.parentElement?.querySelector('.home-info')?.getAttribute('aria-label') || ''
			}))
		}));
		return {
			homeFeedVisible: Boolean(document.querySelector('#homeFeed')) && !document.querySelector('#homeFeed').hidden,
			homeLabelledBy: document.querySelector('#homeFeed')?.getAttribute('aria-labelledby') || '',
			heroLabel: document.querySelector('#homeHero')?.getAttribute('aria-label') || '',
			homeTitle: document.querySelector('#homeFeedTitle')?.textContent || '',
			homeDescription: document.querySelector('#homeFeedDescription')?.textContent || '',
			homeStatus: document.querySelector('#homeFeedStatus')?.textContent || '',
			rows,
			heroEyebrow: document.querySelector('#homeHeroEyebrow')?.textContent || '',
			heroTitle: document.querySelector('#homeHeroTitle')?.textContent || '',
			heroDots: [...document.querySelectorAll('#homeHeroDots .hero-dot')].map(dot => ({
				label: dot.getAttribute('aria-label') || '',
				pressed: dot.getAttribute('aria-pressed') || '',
				text: dot.textContent || ''
			})),
			heroControls: ['#homeHeroPrev', '#homeHeroNext', '#homeHeroPlay', '#homeHeroDetails'].map(selector => {
				const node = document.querySelector(selector);
				return { selector, label: node?.getAttribute('aria-label') || '', text: node?.textContent || '', hidden: Boolean(node?.hidden) };
			})
		};
	})()`);
	const pickedRow = value => (value.rows || []).find(row => row.title === 'Picked for you');
	const names = row => (row?.items || []).map(item => item.name);
	const showPickedRow = () => evaluate(`(() => {
		const row = [...document.querySelectorAll('#homeRows .home-row')].find(section => section.querySelector('.shelf-heading h3')?.textContent === 'Picked for you');
		if (!row) return false;
		row.scrollIntoView({ block: 'center', inline: 'nearest' });
		return true;
	})()`);

	let checksPassed = true;
	const check = (name, condition, detail) => {
		results.checks[name] = { pass: Boolean(condition), detail };
		if (!condition) checksPassed = false;
	};

	await navigate(origin + '/');
	await waitFor("(() => { const row = [...document.querySelectorAll('#homeRows .home-row')].find(section => section.querySelector('.shelf-heading h3')?.textContent === 'Picked for you'); return Boolean(row && row.querySelectorAll('.home-tile').length); })()", 12000, 'Picked for you row');
	const before = await snapshot();
	const beforeRow = pickedRow(before);
	const beforeNames = names(beforeRow);
	check('home feed visible', before.homeFeedVisible === true, before.homeFeedVisible);
	check('home feed labelled', before.homeLabelledBy === 'homeFeedTitle', before.homeLabelledBy);
	check('featured region labelled', before.heroLabel === 'Featured title', before.heroLabel);
	check('home heading', before.homeTitle === 'For you', before.homeTitle);
	check('personalised description', before.homeDescription.startsWith('A varied mix based on what you watch and keep.'), before.homeDescription);
	check('picked for you row present', Boolean(beforeRow), beforeRow?.title || 'missing');
	check('first window items', JSON.stringify(beforeNames) === JSON.stringify(picksA.map(item => item.Name)), beforeNames);
	check('picked note', beforeRow?.note === 'A varied start from the collection', beforeRow?.note);
	check('picked card count', beforeNames.length === 12, beforeNames.length);
	check('play labels', (beforeRow?.items || []).every((item, index) => item.label === (picksA[index].Type === 'Series' ? picksA[index].Name + ', Series' : 'Play ' + picksA[index].Name)), (beforeRow?.items || []).map(item => item.label));
	check('more info labels', (beforeRow?.items || []).every((item, index) => item.more === 'More info about ' + picksA[index].Name), (beforeRow?.items || []).map(item => item.more));
	check('featured dots', before.heroDots.length === 2, before.heroDots);
	check('featured labels', before.heroDots[0]?.label === 'Featured title 1: Window A pick 01' && before.heroDots[1]?.label === 'Featured title 2: Window A pick 02', before.heroDots);
	check('featured pressed state', before.heroDots[0]?.pressed === 'true' && before.heroDots[1]?.pressed === 'false', before.heroDots.map(dot => dot.pressed));
	check('hero rotation labels', before.heroControls.find(control => control.selector === '#homeHeroPrev')?.label === 'Previous featured title' && before.heroControls.find(control => control.selector === '#homeHeroNext')?.label === 'Next featured title', before.heroControls);
	check('initial home request', state.homeRequests >= 1, state.homeRequests);
	await showPickedRow();
	await sleep(200);
	const shotA = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
	writeFileSync(join(outDir, 'HOME-RECOMMENDATIONS-104-A.png'), Buffer.from(shotA.data, 'base64'));

	await reload();
	await waitFor("(() => { const row = [...document.querySelectorAll('#homeRows .home-row')].find(section => section.querySelector('.shelf-heading h3')?.textContent === 'Picked for you'); return Boolean(row && row.querySelectorAll('.home-tile').length); })()", 12000, 'Picked for you row after reload');
	await waitMock(() => state.homeRequests >= 2, 8000, 'second home request');
	const sameWindow = await snapshot();
	check('stable within a window', JSON.stringify(names(pickedRow(sameWindow))) === JSON.stringify(beforeNames), names(pickedRow(sameWindow)));

	const advanced = await fetch(origin + '/api/__fixture/advance', { method: 'POST' }).then(response => response.json());
	check('fixture window advanced', advanced.generation === 1, advanced);
	await click('#homeFeedRefresh');
	await waitFor(`(() => { const row = [...document.querySelectorAll('#homeRows .home-row')].find(section => section.querySelector('.shelf-heading h3')?.textContent === 'Picked for you'); return row?.querySelector('.home-tile h3')?.textContent === ${JSON.stringify(picksB[0].Name)}; })()`, 12000, 'fresh generation picks');
	const after = await snapshot();
	const afterNames = names(pickedRow(after));
	check('fresh generation changed picks', JSON.stringify(afterNames) === JSON.stringify(picksB.map(item => item.Name)), afterNames);
	check('window selections differ', afterNames.some(name => !beforeNames.includes(name)) && beforeNames.some(name => !afterNames.includes(name)), { before: beforeNames, after: afterNames });
	check('fresh generation refreshed hero', after.heroDots[0]?.label === 'Featured title 1: Window B pick 01', after.heroDots);
	await showPickedRow();
	await sleep(200);
	const shotB = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
	writeFileSync(join(outDir, 'HOME-RECOMMENDATIONS-104-B.png'), Buffer.from(shotB.data, 'base64'));

	await click('#homeFeedRefresh');
	await waitMock(() => state.homeRequests >= 4, 8000, 'third home request');
	await sleep(150);
	const stableAgain = await snapshot();
	check('stable after refresh in the same window', JSON.stringify(names(pickedRow(stableAgain))) === JSON.stringify(afterNames), names(pickedRow(stableAgain)));
	check('no playback was started', state.playCalls === 0, state.playCalls);
	await sleep(300);
	check('no console errors', state.consoleErrors.length === 0, state.consoleErrors);

	results.ok = checksPassed;
	results.window = { before: beforeNames, after: afterNames };
	results.requests = { home: state.homeRequests, play: state.playCalls };
	results.screenshot = ['HOME-RECOMMENDATIONS-104-A.png', 'HOME-RECOMMENDATIONS-104-B.png'];
	results.accessibility = { pickedCards: beforeRow?.items || [], featuredDots: before.heroDots, heroControls: before.heroControls };
	writeFileSync(join(outDir, 'BROWSER-RECOMMENDATIONS-104.json'), JSON.stringify(results, null, 2) + '\n');
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
