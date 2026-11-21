/* DISPATCHARR ADMIN STATUS 129 - real-browser evidence.
 *
 * Starts the real homelab admin app (`createSetup`) with a synthetic loopback
 * fetcher for Dispatcharr's aggregate `/proxy/stats/` response, seeds a valid
 * Dispatcharr configuration, logs in through the real `/api/setup/login`
 * route, sets the resulting administrator cookie in headless Chrome, and
 * renders the real authenticated settings page.
 *
 * Run one profile per process:
 *   cd server
 *   $env:DISPATCHARR129_PROFILE='desktop'; node test/dispatcharr-status-129-browser.mjs
 *   $env:DISPATCHARR129_PROFILE='mobile';  node test/dispatcharr-status-129-browser.mjs
 *
 * EVIDENCE_DIR overrides outputs/Tellybox-dispatcharr-status-129/evidence/.
 * CHROME_PATH overrides Chrome discovery. If Chrome is unavailable the script
 * prints SKIP and exits 0; no pass is claimed without a rendered page.
 *
 * No production access, deployment, provider playback or product edit.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { release, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultConfig, materialize } from '../homelab/config.mjs';
import { createSetup } from '../homelab/admin.mjs';
import { catalogueCacheDirectory } from '../homelab/dispatcharr-status.mjs';

const profileName = String(process.env.DISPATCHARR129_PROFILE || process.argv[2] || 'desktop').trim().toLowerCase();
const VIEWPORTS = {
	desktop: { width: 1440, height: 900, mobile: false },
	mobile: { width: 390, height: 844, mobile: true }
};
const viewport = VIEWPORTS[profileName];
if (!viewport) {
	console.error('DISPATCHARR129_PROFILE must be desktop or mobile.');
	process.exit(2);
}
const outDir = process.env.EVIDENCE_DIR
	? process.env.EVIDENCE_DIR.replace(/[\\/]$/, '')
	: fileURLToPath(new URL('../../outputs/Tellybox-dispatcharr-status-129/evidence/', import.meta.url));
mkdirSync(outDir, { recursive: true });

const PASSWORD = 'test-only-password-1234';
const BASE_TIME = 1763450000000;
const HEALTHY = {
	live: { channels: 12, count: 99, timestamp: '2026-11-18T10:00:00.000Z' },
	vod: { vod_connections: 3, total_connections: 7, timestamp: 1763450100 },
	catchup: { timeshift_sessions: 2, total_connections: 5, timestamp: 1763450200 }
};
const SECRET_NEEDLES = [
	'vod_connections', 'timeshift_sessions', 'total_connections',
	'liveChannels', 'vodConnections', 'catchupConnections', 'liveChannelsAt',
	'dispatcharr.invalid', 'test-only-key', '192.0.2.10', 'http://', 'https://',
	'X-API-Key', 'Authorization'
];

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const jsonResponse = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const chromeExecutable = () => [
	process.env.CHROME_PATH,
	'C:/Program Files/Google/Chrome/Application/chrome.exe',
	'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
	join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
	'/usr/bin/google-chrome',
	'/usr/bin/google-chrome-stable',
	'/usr/bin/chromium',
	'/usr/bin/chromium-browser',
	'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
].filter(Boolean).find(candidate => existsSync(candidate));

// ---------------------------------------------------------------------------
// CDP plumbing
// ---------------------------------------------------------------------------

async function targetFor(port) {
	for (let attempt = 0; attempt < 150; attempt += 1) {
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
	const listeners = new Map();
	socket.onmessage = event => {
		const message = JSON.parse(event.data);
		if (message.id && pending.has(message.id)) {
			const { resolve, reject } = pending.get(message.id);
			pending.delete(message.id);
			if (message.error) reject(new Error(JSON.stringify(message.error)));
			else resolve(message.result);
		} else if (message.method) {
			for (const listener of listeners.get(message.method) || []) listener(message.params);
		}
	};
	const send = (method, params = {}) => new Promise((resolve, reject) => {
		const messageId = ++id;
		pending.set(messageId, { resolve, reject });
		socket.send(JSON.stringify({ id: messageId, method, params }));
	});
	const on = (method, listener) => {
		const list = listeners.get(method) || [];
		list.push(listener);
		listeners.set(method, list);
	};
	return { socket, send, on };
}

function createRecorder() {
	let phase = 'idle', startedAt = 0, active = false;
	const entries = [], byId = new Map();
	return {
		start(name) { phase = name; startedAt = Date.now(); active = true; },
		stop() { active = false; },
		request(params) {
			if (!active || byId.has(params.requestId)) return;
			let path = '', query = '';
			try { const url = new URL(params.request?.url || ''); path = url.pathname; query = url.search; } catch {}
			const entry = { phase, url: String(params.request?.url || ''), path, query, method: params.request?.method || 'GET', start: Date.now() - startedAt, end: null, status: 0, bytes: null };
			byId.set(params.requestId, entry);
			entries.push(entry);
		},
		response(params) {
			const entry = byId.get(params.requestId);
			if (entry) entry.status = Number(params.response?.status) || 0;
		},
		finished(params) {
			const entry = byId.get(params.requestId);
			if (!entry) return;
			entry.end = Date.now() - startedAt;
			if (Number.isFinite(params.encodedDataLength)) entry.bytes = params.encodedDataLength;
		},
		failed(params) {
			const entry = byId.get(params.requestId);
			if (entry) { entry.end = Date.now() - startedAt; entry.error = String(params.errorText || 'failed'); }
		},
		snapshot(onlyPhase = phase) { return entries.filter(entry => entry.phase === onlyPhase); },
		all() { return entries.slice(); }
	};
}

const instrumentation = String.raw`
(() => {
	window.__ds = { fetch: [], hiddenRequests: 0 };
	const original = window.fetch;
	window.fetch = async function (...args) {
		const first = args[0];
		const raw = typeof first === 'string' ? first : (first && (first.href || first.url)) || '';
		let path = '', query = '';
		try { const url = new URL(raw, location.href); path = url.pathname; query = url.search; } catch {}
		const started = performance.now();
		const entry = { path, query, at: Math.round(started), status: 0, ms: null };
		window.__ds.fetch.push(entry);
		try {
			const response = await original.apply(this, args);
			entry.status = response.status;
			entry.ms = Math.round(performance.now() - started);
			if (path === '/api/setup/dispatcharr/status') {
				response.clone().json().then(data => { entry.state = data && data.state; }).catch(() => {});
			}
			return response;
		} catch (error) {
			entry.failed = true;
			entry.ms = Math.round(performance.now() - started);
			throw error;
		}
	};
})();
`;

function makePage(connection) {
	const { send } = connection;
	const evaluate = async (expression, userGesture = false) => {
		const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture });
		if (result.exceptionDetails) {
			const description = result.exceptionDetails.exception?.description || result.exceptionDetails.text || 'evaluation failed';
			throw new Error(String(description).split('\n')[0]);
		}
		return result.result.value;
	};
	const waitFor = async (expression, timeout, label) => {
		const deadline = Date.now() + timeout;
		let last = null;
		while (Date.now() < deadline) {
			try {
				last = await evaluate(expression);
				if (last) return last;
			} catch (error) { last = error.message; }
			await sleep(40);
		}
		throw new Error('Timed out waiting for ' + label + ' (last: ' + JSON.stringify(last) + ')');
	};
	const screenshot = async file => {
		const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
		writeFileSync(join(outDir, file), Buffer.from(shot.data, 'base64'));
		return file;
	};
	const click = async selector => {
		const point = await evaluate(`(() => {
			const element = document.querySelector(${JSON.stringify(selector)});
			if (!element) return null;
			element.scrollIntoView({ block: 'center', inline: 'center' });
			const box = element.getBoundingClientRect();
			return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
		})()`);
		if (!point) throw new Error('Could not find ' + selector);
		await sleep(120);
		const box = await evaluate(`(() => { const element = document.querySelector(${JSON.stringify(selector)}); if (!element) return null; const rect = element.getBoundingClientRect(); return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }; })()`);
		if (!box) throw new Error('Could not re-measure ' + selector);
		await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
		await sleep(20);
		await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
		await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
	};
	return { send, evaluate, waitFor, screenshot, click };
}

// ---------------------------------------------------------------------------
// Admin fixture
// ---------------------------------------------------------------------------

function dispatcharrConfig(overrides = {}) {
	const config = defaultConfig();
	config.network.publicOrigin = 'https://tellybox.example';
	config.services.dispatcharr = {
		enabled: true,
		location: 'anotherServer',
		url: 'http://dispatcharr.invalid:9191',
		key: 'test-only-key',
		live: true,
		vod: true,
		catchup: true,
		...overrides
	};
	return config;
}

async function startAdmin({ config, fetcher }) {
	const directory = mkdtempSync(join(tmpdir(), 'tellybox-dispatcharr-129-browser-'));
	writeFileSync(join(directory, 'configuration.json'), JSON.stringify(config, null, '\t'));
	let statsCalls = 0;
	let mode = 'healthy';
	const wrappedFetcher = async (url, options) => {
		const value = String(url);
		if (value.endsWith('/proxy/stats/')) {
			statsCalls += 1;
			if (mode === 'auth') return jsonResponse({ detail: 'Invalid token' }, 401);
			if (mode === 'unreachable') throw Object.assign(Error('connect ECONNREFUSED'), { name: 'TypeError' });
			return jsonResponse(HEALTHY);
		}
		if (fetcher) return fetcher(url, options);
		throw Object.assign(Error('offline'), { name: 'TypeError' });
	};
	const setup = createSetup({
		directory,
		fetcher: wrappedFetcher,
		clock: () => BASE_TIME,
		apply: async () => {}
	});
	const server = setup.app.listen(0, '127.0.0.1');
	await once(server, 'listening');
	const base = 'http://127.0.0.1:' + server.address().port;
	const bootstrap = JSON.parse(readFileSync(join(directory, 'bootstrap.json'), 'utf8')).token;
	const login = await fetch(base + '/api/setup/login', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Origin: base },
		body: JSON.stringify({ bootstrap, password: PASSWORD })
	});
	if (login.status !== 200) throw new Error('Admin login failed: ' + login.status + ' ' + await login.text());
	const cookie = login.headers.get('set-cookie').split(';')[0];
	const value = cookie.slice(cookie.indexOf('=') + 1);
	return {
		base,
		cookieValue: value,
		directory,
		setup,
		statsCalls: () => statsCalls,
		setMode: next => { mode = next; },
		close() { try { server.closeAllConnections(); server.close(); } catch {} try { rmSync(directory, { recursive: true, force: true }); } catch {} }
	};
}

// Seed the exact cache directory the saved configuration materializes, with the
// real shapes the status route reads. This is the positive populated case; the
// existing healthy scenario intentionally keeps these unavailable.
function seedCatalogueCache(app) {
	const saved = app.setup.store.get();
	const env = materialize(saved, app.directory);
	const directory = catalogueCacheDirectory(app.directory, saved);
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	writeFileSync(join(directory, 'vod-catalogue.json'), JSON.stringify({
		time: BASE_TIME - 5000,
		items: [{ Id: 'catalogue-a' }, { Id: 'catalogue-b' }, { Id: 'catalogue-c' }, { Id: 'catalogue-d' }, { Id: 'catalogue-e' }]
	}));
	writeFileSync(join(directory, 'dispatcharr-guide.json'), JSON.stringify({
		channels: [
			{ programmes: [{ Name: 'Morning' }, { Name: 'Noon' }] },
			{ programmes: [{ Name: 'Evening' }] },
			{ programmes: [] }
		],
		fetchedAt: BASE_TIME - 6000,
		available: true,
		stale: false
	}));
	return { env, directory };
}

// ---------------------------------------------------------------------------
// Scenario helpers
// ---------------------------------------------------------------------------

const panelExpression = `(() => {
	const root = document.querySelector('#dispatcharrStatus');
	const panel = document.querySelector('#dispatcharrStatusPanel');
	if (!root || !panel) return null;
	const metrics = {};
	for (const list of root.querySelectorAll('dl')) {
		const children = [...list.children];
		for (let index = 0; index + 1 < children.length; index += 2) metrics[children[index].textContent] = children[index + 1].textContent;
	}
	return {
		panelHidden: panel.hidden,
		panelStatus: panel.dataset.status || '',
		state: root.dataset.state || '',
		text: root.innerText || '',
		html: root.innerHTML || '',
		metrics,
		source: root.querySelector('.dispatcharr-source')?.textContent || '',
		checked: root.querySelector('.dispatcharr-checked')?.textContent || '',
		note: root.querySelector('.dispatcharr-note')?.textContent || '',
		busy: root.getAttribute('aria-busy') || ''
	};
})()`;

const sanitizeFindings = text => SECRET_NEEDLES.filter(needle => String(text).includes(needle));

async function openAdmin(page, app, phase) {
	await page.send('Network.setCookie', {
		name: 'tellybox_setup',
		value: app.cookieValue,
		url: app.base + '/',
		path: '/',
		httpOnly: true,
		sameSite: 'Strict'
	});
	page.recorder.start(phase);
	const navAt = Date.now();
	await page.send('Page.navigate', { url: app.base + '/' });
	await page.waitFor("document.readyState === 'complete'", 20000, 'the admin page');
	await page.waitFor("!document.querySelector('#settings')?.hidden", 15000, 'the authenticated settings area');
	const panel = await page.waitFor("(() => { const root = document.querySelector('#dispatcharrStatus'); return root && (root.dataset.state || root.textContent) ? { at: Math.round(performance.now()), text: root.innerText || '' } : false; })()", 15000, 'the Dispatcharr status panel');
	const panelMs = await page.evaluate('Math.round(performance.now())');
	await page.waitFor("document.querySelector('#dispatcharrStatus')?.getAttribute('aria-busy') === 'false'", 10000, 'the status request to settle');
	const settled = await page.evaluate(panelExpression);
	return { panel, panelMs, wallMs: Date.now() - navAt, settled };
}

async function screenshotPanel(page, file, { fullPanel = false } = {}) {
	await page.evaluate("document.querySelector('#dispatcharrStatusPanel')?.scrollIntoView({ block: 'start' })");
	await sleep(280);
	if (fullPanel) {
		const clip = await page.evaluate(`(() => {
			const panel = document.querySelector('#dispatcharrStatusPanel');
			const rect = panel.getBoundingClientRect();
			return { x: rect.x + scrollX, y: rect.y + scrollY, width: rect.width, height: rect.height, scale: 1 };
		})()`);
		const shot = await page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip });
		writeFileSync(join(outDir, file), Buffer.from(shot.data, 'base64'));
		return file;
	}
	return page.screenshot(file);
}

function summarizeRequests(recorder, phase) {
	const entries = recorder.snapshot(phase);
	const status = entries.filter(entry => entry.path === '/api/setup/dispatcharr/status');
	return {
		total: entries.length,
		statusCount: status.length,
		statusUrls: status.map(entry => entry.path + entry.query),
		refreshCount: status.filter(entry => entry.query === '?refresh=1').length,
		configCount: entries.filter(entry => entry.path === '/api/setup/config').length,
		entries: entries.map(entry => ({ path: entry.path, query: entry.query, status: entry.status, start: entry.start, end: entry.end, bytes: entry.bytes }))
	};
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const evidence = {
	job: 'dispatcharr-status-129-browser',
	profile: profileName,
	viewport,
	fixtureOnly: true,
	productionTouched: false,
	environment: { os: process.platform + ' ' + release(), node: process.version, chrome: '', headless: true },
	generatedAt: new Date().toISOString(),
	scenarios: {},
	assertions: [],
	pageExceptions: [],
	console: [],
	screenshots: [],
	limitations: [
		'Synthetic loopback Dispatcharr aggregate response; no production Dispatcharr, credential or network was used.',
		'The admin application, login route, cookie session, status route and page are the real implementation.',
		'This is staged browser evidence only; it does not claim rollout readiness.',
		'The 30-second poll is not waited out; hidden/visible behaviour is exercised with a real visibilitychange and the structural source check.'
	],
	passed: false
};
const checks = [];
const check = (phase, name, pass, detail = '') => {
	checks.push({ phase, name, pass: Boolean(pass), detail });
	console.log((pass ? 'PASS ' : 'FAIL ') + phase + ': ' + name + (detail ? ' - ' + detail : ''));
};
let exitCode = 1;
let child = null;
let socket = null;
let profileDir = null;
let connection = null;
let page = null;
const apps = [];
const consoleLines = [];
const pageExceptions = [];

try {
	const chromePath = chromeExecutable();
	if (!chromePath) {
		console.log('SKIP: Chrome or Chromium was not found. Set CHROME_PATH to run the Dispatcharr status browser check.');
		writeFileSync(join(outDir, 'dispatcharr-status-129-' + profileName + '.json'), JSON.stringify({ ...evidence, skipped: true, reason: 'Chrome not found' }, null, 2) + '\n');
		process.exit(0);
	}
	profileDir = mkdtempSync(join(tmpdir(), 'tellybox-dispatcharr-129-'));
	child = spawn(chromePath, [
		'--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
		'--no-default-browser-check', '--disable-extensions',
		'--window-size=' + viewport.width + ',' + viewport.height,
		'--remote-debugging-port=0', '--user-data-dir=' + profileDir, 'about:blank'
	], { stdio: 'ignore' });
	let port = 0;
	for (let attempt = 0; attempt < 150; attempt += 1) {
		const file = join(profileDir, 'DevToolsActivePort');
		if (existsSync(file)) { port = Number(readFileSync(file, 'utf8').split(/\r?\n/)[0]); if (port) break; }
		await sleep(100);
	}
	if (!port) throw new Error('Chrome did not open a DevTools port');
	connection = await connect(await targetFor(port));
	socket = connection.socket;
	const recorder = createRecorder();
	page = makePage(connection);
	page.recorder = recorder;
	connection.on('Network.requestWillBeSent', params => recorder.request(params));
	connection.on('Network.responseReceived', params => recorder.response(params));
	connection.on('Network.loadingFinished', params => recorder.finished(params));
	connection.on('Network.loadingFailed', params => recorder.failed(params));
	connection.on('Runtime.exceptionThrown', params => {
		const value = params?.exceptionDetails?.exception?.description || params?.exceptionDetails?.text;
		if (value) pageExceptions.push(String(value).split('\n')[0].slice(0, 300));
	});
	const captureConsole = params => {
		const text = params?.args?.map(arg => arg.value ?? arg.description ?? '').join(' ') || params?.entry?.text || '';
		if (text) consoleLines.push(String(text).slice(0, 300));
	};
	connection.on('Runtime.consoleAPICalled', captureConsole);
	connection.on('Log.entryAdded', params => { if (params?.entry?.text) consoleLines.push(String(params.entry.text).slice(0, 300)); });
	await connection.send('Page.enable');
	await connection.send('Runtime.enable');
	await connection.send('Network.enable');
	await connection.send('Log.enable');
	await connection.send('Emulation.setDeviceMetricsOverride', {
		width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: viewport.mobile,
		screenWidth: viewport.width, screenHeight: viewport.height
	});
	await connection.send('Page.addScriptToEvaluateOnNewDocument', { source: instrumentation });
	try {
		const version = await connection.send('Browser.getVersion');
		evidence.environment.chrome = String(version.product || '').split(' ')[0];
	} catch {}

	// 1. Healthy -------------------------------------------------------------
	const healthyApp = await startAdmin({ config: dispatcharrConfig() });
	apps.push(healthyApp);
	const healthy = await openAdmin(page, healthyApp, 'healthy');
	const healthyMetrics = healthy.settled.metrics;
	const healthyPanelFindings = sanitizeFindings(healthy.settled.text + ' ' + healthy.settled.html);
	const healthyConsoleFindings = sanitizeFindings(consoleLines.join('\n'));
	const healthyShot = await screenshotPanel(page, 'dispatcharr-status-healthy-' + profileName + '.png');
	evidence.screenshots.push(healthyShot);

	const healthyStatusBefore = healthyApp.statsCalls();
	const refreshStatusBefore = summarizeRequests(recorder, 'healthy').statusCount;
	await page.click('#dispatcharrStatusRefresh');
	const refresh = await page.waitFor(`(() => {
		const entry = (window.__ds && window.__ds.fetch || []).filter(item => item.path === '/api/setup/dispatcharr/status' && item.query === '?refresh=1').at(-1);
		return entry ? entry : false;
	})()`, 10000, 'the manual refresh request');
	await page.waitFor("document.querySelector('#dispatcharrStatus')?.getAttribute('aria-busy') === 'false'", 10000, 'the manual refresh to settle');
	const refreshPanel = await page.evaluate(panelExpression);
	const refreshRequests = summarizeRequests(recorder, 'healthy');
	const refreshUpstreamDelta = healthyApp.statsCalls() - healthyStatusBefore;

	// Hidden / visible controller behavior (real visibilitychange).
	const hiddenBefore = summarizeRequests(recorder, 'healthy').statusCount;
	await page.evaluate(`(() => {
		Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
		document.dispatchEvent(new Event('visibilitychange'));
		return true;
	})()`);
	await sleep(1200);
	const hiddenAfter = summarizeRequests(recorder, 'healthy').statusCount;
	await page.evaluate(`(() => {
		delete document.hidden;
		document.dispatchEvent(new Event('visibilitychange'));
		return true;
	})()`);
	const visibleRequest = await page.waitFor(`(() => (window.__ds && window.__ds.fetch || []).filter(item => item.path === '/api/setup/dispatcharr/status').length > ${hiddenAfter ? hiddenAfter : 0})()`, 5000, 'the visible-return status request').catch(() => false);
	const visibleAfter = summarizeRequests(recorder, 'healthy').statusCount;
	const structural = (() => {
		try {
			const source = readFileSync(new URL('../homelab/public/setup.js', import.meta.url), 'utf8');
			return {
				hiddenClearsTimer: /if \(doc\.hidden\) \{ clear\(\); return; \}/.test(source),
				visibilityListener: /addEventListener\('visibilitychange', onVisibility\)/.test(source),
				settingsGate: /isVisible: \(\) => !\$\('#settings'\)\.hidden && !document\.hidden/.test(source)
			};
		} catch (error) { return { error: String(error.message || error) }; }
	})();

	evidence.scenarios.healthy = {
		panelMs: healthy.panelMs,
		wallMs: healthy.wallMs,
		panel: healthy.settled,
		metrics: healthyMetrics,
		requests: summarizeRequests(recorder, 'healthy'),
		upstreamStatsCalls: healthyApp.statsCalls(),
		manualRefresh: {
			request: refresh,
			upstreamDelta: refreshUpstreamDelta,
			requests: refreshRequests,
			panel: refreshPanel
		},
		visibility: {
			hiddenBefore,
			hiddenAfter,
			visibleAfter,
			visibleRequestSeen: Boolean(visibleRequest),
			structural
		},
		sanitizer: { panelFindings: healthyPanelFindings, consoleFindings: healthyConsoleFindings },
		screenshot: healthyShot
	};
	check('healthy', 'the real admin settings area authenticated and rendered', healthy.settled.panelHidden === false, JSON.stringify({ wallMs: healthy.wallMs }));
	check('healthy', 'the Dispatcharr panel reported healthy', healthy.settled.state === 'healthy', JSON.stringify({ state: healthy.settled.state, text: healthy.settled.text.slice(0, 80) }));
	check('healthy', 'the panel showed the saved source and checked time', healthy.settled.source === 'Source: Another server' && /^Last checked: (?!Unknown)/.test(healthy.settled.checked), JSON.stringify({ source: healthy.settled.source, checked: healthy.settled.checked }));
	check('healthy', 'live channels, VOD and catch-up counts rendered', healthyMetrics['Live upstream channels'] === '12' && healthyMetrics['VOD connections'] === '3' && healthyMetrics['Catch-up connections'] === '2', JSON.stringify(healthyMetrics));
	check('healthy', 'the panel content arrived promptly', healthy.panelMs <= 5000, 'panel at ' + healthy.panelMs + 'ms');
	check('healthy', 'manual Refresh used ?refresh=1 and bypassed the cache', refresh.query === '?refresh=1' && refreshUpstreamDelta >= 1, JSON.stringify({ request: refresh, upstreamDelta: refreshUpstreamDelta }));
	check('healthy', 'no raw stats keys, URLs, IPs or credentials reached the panel', healthyPanelFindings.length === 0, JSON.stringify(healthyPanelFindings));
	check('healthy', 'no raw stats keys, URLs, IPs or credentials reached the console', healthyConsoleFindings.length === 0, JSON.stringify(healthyConsoleFindings.slice(0, 5)));
	check('healthy', 'hidden visibility cleared polling and visible return refreshed', hiddenAfter === hiddenBefore && visibleAfter > hiddenAfter && structural.hiddenClearsTimer && structural.visibilityListener && structural.settingsGate, JSON.stringify({ hiddenBefore, hiddenAfter, visibleAfter, structural }));

	// 2. Populated local catalogue + guide -----------------------------------
	const populatedApp = await startAdmin({ config: dispatcharrConfig() });
	apps.push(populatedApp);
	const seeded = seedCatalogueCache(populatedApp);
	const populated = await openAdmin(page, populatedApp, 'populated');
	// Capture the whole panel so the mobile screenshot includes both the
	// catalogue count and the guide channel/coverage rows below the fold.
	const populatedShot = await screenshotPanel(page, 'dispatcharr-status-populated-' + profileName + '.png', { fullPanel: true });
	evidence.screenshots.push(populatedShot);
	evidence.scenarios.populated = {
		panelMs: populated.panelMs,
		cache: { directory: seeded.directory, materialized: seeded.env.CATALOGUE_CACHE_DIR === seeded.directory },
		panel: populated.settled,
		requests: summarizeRequests(recorder, 'populated'),
		upstreamStatsCalls: populatedApp.statsCalls(),
		screenshot: populatedShot
	};
	const populatedMetrics = populated.settled.metrics;
	const catalogueTitles = Number(String(populatedMetrics['Catalogue titles'] || '').replace(/,/g, ''));
	const guideChannels = Number(populatedMetrics['Guide channels']);
	check('populated', 'the populated catalogue is available with a positive title count', populatedMetrics.Catalogue === 'Available' && catalogueTitles > 0 && populatedMetrics['Catalogue titles'] !== 'Unknown', JSON.stringify({ Catalogue: populatedMetrics.Catalogue, titles: populatedMetrics['Catalogue titles'] }));
	check('populated', 'the populated guide is available with positive channels', populatedMetrics.Guide === 'Available' && guideChannels > 0 && populatedMetrics['Guide channels'] !== 'Unknown', JSON.stringify({ Guide: populatedMetrics.Guide, channels: populatedMetrics['Guide channels'] }));
	check('populated', 'the guide coverage is positive and explicit', populatedMetrics['Guide coverage'] === '2 of 3 channels have listings', JSON.stringify(populatedMetrics['Guide coverage']));
	check('populated', 'catalogue and guide timestamps are populated, not Unknown', populatedMetrics['Last catalogue refresh'] && populatedMetrics['Last catalogue refresh'] !== 'Unknown' && populatedMetrics['Guide fetched'] && populatedMetrics['Guide fetched'] !== 'Unknown', JSON.stringify({ catalogue: populatedMetrics['Last catalogue refresh'], guide: populatedMetrics['Guide fetched'] }));
	check('populated', 'the populated panel still reports connected upstream counts', populated.settled.state === 'healthy' && populatedMetrics['Live upstream channels'] === '12', JSON.stringify({ state: populated.settled.state, counts: { live: populatedMetrics['Live upstream channels'], vod: populatedMetrics['VOD connections'], catchup: populatedMetrics['Catch-up connections'] } }));

	// 3. Disabled ------------------------------------------------------------
	const disabledApp = await startAdmin({ config: dispatcharrConfig({ enabled: false }) });
	apps.push(disabledApp);
	const disabled = await openAdmin(page, disabledApp, 'disabled');
	const disabledShot = await screenshotPanel(page, 'dispatcharr-status-disabled-' + profileName + '.png');
	evidence.screenshots.push(disabledShot);
	evidence.scenarios.disabled = {
		panelMs: disabled.panelMs,
		panel: disabled.settled,
		requests: summarizeRequests(recorder, 'disabled'),
		upstreamStatsCalls: disabledApp.statsCalls(),
		screenshot: disabledShot
	};
	check('disabled', 'a switched-off integration is visible but honest', disabled.settled.panelHidden === false && disabled.settled.state === 'disabled' && /switched off/i.test(disabled.settled.text), JSON.stringify({ state: disabled.settled.state, text: disabled.settled.text.slice(0, 100) }));
	check('disabled', 'a switched-off integration shows no activity counts', disabled.settled.metrics['Live upstream channels'] === undefined && disabledApp.statsCalls() === 0, JSON.stringify({ metrics: disabled.settled.metrics, upstream: disabledApp.statsCalls() }));

	// 3. Unconfigured --------------------------------------------------------
	const unconfiguredConfig = defaultConfig();
	unconfiguredConfig.network.publicOrigin = 'https://tellybox.example';
	unconfiguredConfig.services.dispatcharr = { enabled: true, location: 'onThisServer', key: 'test-only-key', live: true };
	const unconfiguredApp = await startAdmin({ config: unconfiguredConfig });
	apps.push(unconfiguredApp);
	const unconfigured = await openAdmin(page, unconfiguredApp, 'unconfigured');
	const unconfiguredShot = await screenshotPanel(page, 'dispatcharr-status-unconfigured-' + profileName + '.png');
	evidence.screenshots.push(unconfiguredShot);
	evidence.scenarios.unconfigured = {
		panelMs: unconfigured.panelMs,
		panel: unconfigured.settled,
		requests: summarizeRequests(recorder, 'unconfigured'),
		upstreamStatsCalls: unconfiguredApp.statsCalls(),
		screenshot: unconfiguredShot
	};
	check('unconfigured', 'an unusable address hides the panel instead of inventing zeroes', unconfigured.settled.panelHidden === true && unconfigured.settled.state === 'unconfigured', JSON.stringify({ hidden: unconfigured.settled.panelHidden, state: unconfigured.settled.state }));
	check('unconfigured', 'no upstream request was made without a usable address', unconfiguredApp.statsCalls() === 0, String(unconfiguredApp.statsCalls()));

	// 4. Auth-failed ---------------------------------------------------------
	const authApp = await startAdmin({ config: dispatcharrConfig() });
	authApp.setMode('auth');
	apps.push(authApp);
	const auth = await openAdmin(page, authApp, 'auth-failed');
	const authShot = await screenshotPanel(page, 'dispatcharr-status-auth-failed-' + profileName + '.png');
	evidence.screenshots.push(authShot);
	evidence.scenarios.authFailed = {
		panelMs: auth.panelMs,
		panel: auth.settled,
		requests: summarizeRequests(recorder, 'auth-failed'),
		upstreamStatsCalls: authApp.statsCalls(),
		screenshot: authShot
	};
	check('auth-failed', 'an auth failure is labelled and not shown as healthy', auth.settled.state === 'auth-failed' && /Sign-in failed/i.test(auth.settled.text), JSON.stringify({ state: auth.settled.state, text: auth.settled.text.slice(0, 100) }));
	check('auth-failed', 'an auth failure shows no fabricated zero counts', auth.settled.metrics['Live upstream channels'] === undefined && !/\b0\b/.test(auth.settled.metrics['Live upstream channels'] || ''), JSON.stringify(auth.settled.metrics));

	// 5. Unreachable ---------------------------------------------------------
	const unreachableApp = await startAdmin({ config: dispatcharrConfig() });
	unreachableApp.setMode('unreachable');
	apps.push(unreachableApp);
	const unreachable = await openAdmin(page, unreachableApp, 'unreachable');
	const unreachableShot = await screenshotPanel(page, 'dispatcharr-status-unreachable-' + profileName + '.png');
	evidence.screenshots.push(unreachableShot);
	evidence.scenarios.unreachable = {
		panelMs: unreachable.panelMs,
		panel: unreachable.settled,
		requests: summarizeRequests(recorder, 'unreachable'),
		upstreamStatsCalls: unreachableApp.statsCalls(),
		screenshot: unreachableShot
	};
	check('unreachable', 'an unreachable upstream is labelled and not shown as healthy', unreachable.settled.state === 'unreachable' && /Unreachable/i.test(unreachable.settled.text), JSON.stringify({ state: unreachable.settled.state, text: unreachable.settled.text.slice(0, 100) }));
	check('unreachable', 'an unreachable upstream shows no fabricated zero counts', unreachable.settled.metrics['Live upstream connections'] === undefined && unreachable.settled.metrics['Live upstream channels'] === undefined, JSON.stringify(unreachable.settled.metrics));
} catch (error) {
	check('harness', 'the browser run completed without a harness exception', false, String(error.message || error).split('\n')[0].slice(0, 500));
	evidence.error = String(error.message || error).split('\n')[0].slice(0, 500);
	if (page) {
		try {
			evidence.diagnostic = await page.evaluate(`(() => ({
				href: location.href,
				ready: document.readyState,
				settingsHidden: document.querySelector('#settings')?.hidden,
				panel: document.querySelector('#dispatcharrStatus')?.innerText || '',
				state: document.querySelector('#dispatcharrStatus')?.dataset.state || '',
				fetch: (window.__ds && window.__ds.fetch || []).slice(-20),
				body: (document.body?.innerText || '').slice(0, 600)
			}))()`);
		} catch {}
	}
} finally {
	evidence.generatedAt = new Date().toISOString();
	evidence.assertions = checks;
	evidence.pageExceptions = pageExceptions.slice(0, 10);
	evidence.console = consoleLines.slice(0, 30);
	evidence.passed = checks.length > 0 && checks.every(entry => entry.pass);
	evidence.exitCode = evidence.passed ? 0 : 1;
	try { socket?.close(); } catch {}
	try { child?.kill(); } catch {}
	for (const app of apps) { try { app.close(); } catch {} }
	await sleep(500);
	try { if (profileDir) rmSync(profileDir, { recursive: true, force: true }); } catch {}
	const file = join(outDir, 'dispatcharr-status-129-' + profileName + '.json');
	writeFileSync(file, JSON.stringify(evidence, null, 2) + '\n');
	const failed = checks.filter(entry => !entry.pass).length;
	console.log('');
	console.log('DISPATCHARR-STATUS-129 ' + profileName + ': ' + (evidence.passed ? 'PASS' : 'FAIL') + ' (' + (checks.length - failed) + '/' + checks.length + ' assertions)');
	if (pageExceptions.length) console.log('  page exceptions: ' + JSON.stringify(pageExceptions.slice(0, 5)));
	console.log('  evidence: ' + file);
	if (evidence.screenshots.length) console.log('  screenshots: ' + evidence.screenshots.join(', '));
	process.exit(evidence.exitCode);
}
