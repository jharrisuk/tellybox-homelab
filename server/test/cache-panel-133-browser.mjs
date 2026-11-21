/* RELEASE 133 browser evidence for the owner-only shared-cache panel.
 *
 * Real server.mjs and real settings.html in headless Chrome. A fake loopback
 * setup app validates the installation cookie; every non-loopback fetch is
 * answered with empty JSON so no provider is contacted. Desktop and mobile.
 *
 *   $env:CACHE133_PROFILE='desktop'; node test/cache-panel-133-browser.mjs
 *   $env:CACHE133_PROFILE='mobile';  node test/cache-panel-133-browser.mjs
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

const profile = String(process.env.CACHE133_PROFILE || 'desktop').trim().toLowerCase();
const viewports = { desktop: { width: 1440, height: 1000, mobile: false }, mobile: { width: 390, height: 844, mobile: true } };
const viewport = viewports[profile];
if (!viewport) { console.error('CACHE133_PROFILE must be desktop or mobile.'); process.exit(2); }
const outDir = process.env.EVIDENCE_DIR
	? process.env.EVIDENCE_DIR.replace(/[\\/]$/, '')
	: fileURLToPath(new URL('../../outputs/Tellybox-server-preload-133/evidence/browser/', import.meta.url));
mkdirSync(outDir, { recursive: true });
const chromePath = [
	process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe',
	'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome',
	'/usr/bin/chromium', '/usr/bin/chromium-browser'
].filter(Boolean).find(candidate => existsSync(candidate));
if (!chromePath) { console.log('SKIP: Chrome not found.'); process.exit(0); }

const TOKEN = 'a'.repeat(64);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const listen = handler => new Promise(resolve => {
	const server = http.createServer(handler);
	server.listen(0, '127.0.0.1', () => resolve(server));
});
async function targetFor(port) {
	for (let attempt = 0; attempt < 100; attempt++) {
		try {
			const list = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
			const page = list.find(target => target.type === 'page');
			if (page) return page;
		} catch {}
		await sleep(100);
	}
	throw new Error('Chrome target unavailable');
}
async function connect(target) {
	const socket = new WebSocket(target.webSocketDebuggerUrl);
	await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
	let id = 0;
	const pending = new Map();
	socket.onmessage = event => {
		const message = JSON.parse(event.data);
		if (message.id && pending.has(message.id)) {
			const { resolve, reject } = pending.get(message.id); pending.delete(message.id);
			if (message.error) reject(new Error(JSON.stringify(message.error))); else resolve(message.result);
		}
	};
	const send = (method, params = {}) => new Promise((resolve, reject) => {
		const messageId = ++id; pending.set(messageId, { resolve, reject });
		socket.send(JSON.stringify({ id: messageId, method, params }));
	});
	return { socket, send };
}
const evidence = { profile, viewport, checks: [], screenshots: [] };
const check = (name, pass, detail = '') => {
	evidence.checks.push({ name, pass: Boolean(pass), detail });
	console.log((pass ? 'PASS ' : 'FAIL ') + name + (detail ? ' - ' + detail : ''));
};

const setup = await listen((req, res) => {
	res.setHeader('Content-Type', 'application/json');
	if (req.url === '/api/setup/session' && String(req.headers.cookie || '').includes('tellybox_setup=' + TOKEN)) {
		res.writeHead(200); return res.end(JSON.stringify({ ok: true }));
	}
	res.writeHead(401); res.end(JSON.stringify({ error: 'Sign in.' }));
});
const dead = await listen((req, res) => { res.writeHead(503, { 'Content-Type': 'application/json' }); res.end('{}'); });
const local = await listen(() => {});
const directory = mkdtempSync(join(tmpdir(), 'tellybox-cache-133-browser-'));
Object.assign(process.env, {
	NODE_ENV: 'test', AUTH_DIR: directory, DATA_DIR: directory, CATALOGUE_CACHE_DIR: directory,
	JELLYFIN_URL: 'http://127.0.0.1:' + dead.address().port,
	DISPATCHARR_URL: 'http://127.0.0.1:' + dead.address().port,
	PORT: String(local.address().port), SETUP_PORT: String(setup.address().port),
	LOCAL_HOSTS: '127.0.0.1', LOCAL_NETWORKS: '127.0.0.0/8', PUBLIC_ORIGIN: 'https://remote.test'
});
for (const [name, body] of Object.entries({
	'connection.json': { userId: 'fixture', token: 'fixture-only' },
	'apps.json': {}, 'account-limits.json': { accounts: {} },
	'capabilities.json': { jellyfin: true, library: true, live: false, nonstop: false, vod: false, recordings: false,
		catchup: false, discover: false, comingSoon: false, introdb: false, subtitles: false },
	'server-limits.json': {}
})) writeFileSync(join(directory, name), JSON.stringify(body));
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, options) => {
	const url = String(input?.url || input);
	if (url.startsWith('http://127.0.0.1:')) return realFetch(input, options);
	return new Response(JSON.stringify({ results: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
};
const { app } = await import('../server.mjs');
local.on('request', app);

let chrome, profileDir = '', socket = null;
const cleanup = () => {
	try { socket?.close(); } catch {}
	try { chrome?.kill(); } catch {}
	globalThis.fetch = realFetch;
	try { setup.close(); dead.close(); local.close(); } catch {}
	setTimeout(() => rmSync(directory, { recursive: true, force: true }), 100);
};
process.on('exit', cleanup);
try {
	profileDir = mkdtempSync(join(tmpdir(), 'tellybox-cache-133-chrome-'));
	chrome = spawn(chromePath, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
		'--no-default-browser-check', '--disable-extensions', '--window-size=' + viewport.width + ',' + viewport.height,
		'--remote-debugging-port=0', '--user-data-dir=' + profileDir, 'about:blank'], { stdio: 'ignore' });
	let port = 0;
	for (let attempt = 0; attempt < 120; attempt++) {
		const file = join(profileDir, 'DevToolsActivePort');
		if (existsSync(file)) { port = Number(readFileSync(file, 'utf8').split(/\r?\n/)[0]); if (port) break; }
		await sleep(100);
	}
	if (!port) throw new Error('Chrome did not open a DevTools port');
	const connection = await connect(await targetFor(port));
	socket = connection.socket; const send = connection.send;
	await send('Page.enable'); await send('Runtime.enable'); await send('Network.enable');
	await send('Emulation.setDeviceMetricsOverride', { width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: viewport.mobile });
	await send('Network.setCookie', { name: 'tellybox_setup', value: TOKEN, domain: '127.0.0.1', path: '/', httpOnly: false });
	const evaluate = async expression => {
		const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
		if (result.exceptionDetails) throw new Error(String(result.exceptionDetails.exception?.description || result.exceptionDetails.text).split('\n')[0]);
		return result.result.value;
	};
	const waitFor = async (expression, timeout, label) => {
		const deadline = Date.now() + timeout; let last = null;
		while (Date.now() < deadline) {
			try { last = await evaluate(expression); if (last) return last; } catch (error) { last = error.message; }
			await sleep(150);
		}
		throw new Error('Timed out waiting for ' + label + ' (last: ' + JSON.stringify(last) + ')');
	};
	const shot = async name => {
		const image = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
		writeFileSync(join(outDir, name), Buffer.from(image.data, 'base64'));
		evidence.screenshots.push(name);
	};
	const base = 'http://127.0.0.1:' + local.address().port;
	await send('Page.navigate', { url: base + '/settings.html?v=' + Date.now() });
	await waitFor(`document.querySelector('[data-panel="server"]')`, 15000, 'settings tabs');
	await evaluate(`document.querySelector('[data-panel="server"]').click()`);
	await waitFor(`document.querySelector('[data-settings="server"]') && !document.querySelector('[data-settings="server"]').hidden`, 10000, 'server panel');
	const read = () => evaluate(`(() => {
		const status = document.querySelector('#cacheStatus');
		const box = document.querySelector('#cacheMaintenance');
		const button = document.querySelector('#refreshCaches');
		const rect = box?.getBoundingClientRect();
		return { text: status?.textContent || '', buttonDisabled: Boolean(button?.disabled),
			logItems: [...(document.querySelectorAll('#cacheLog li') || [])].map(li => li.textContent),
			overflow: rect ? Math.round(rect.right - innerWidth) : null,
			right: rect ? Math.round(rect.right) : null, viewport: innerWidth,
			schedule: document.querySelector('#cacheSchedule')?.textContent || '' };
	})()`);
	await waitFor(`document.querySelector('#cacheStatus')?.textContent && !/Checking/.test(document.querySelector('#cacheStatus').textContent)`, 15000, 'cache status');
	const initial = await read();
	check('the shared-cache panel renders on the real settings page', /Ready|up to date/.test(initial.text), initial.text);
	check('the owner refresh button is available', initial.buttonDisabled === false);
	check('the panel explains the automatic schedule and scope', /charts and index hourly/.test(initial.schedule), initial.schedule);
	await shot('cache-panel-' + profile + '.png');

	await evaluate(`document.querySelector('#refreshCaches').click()`);
	await waitFor(`document.querySelectorAll('#cacheLog li').length > 0 || /up to date/.test(document.querySelector('#cacheStatus').textContent)`, 30000, 'queued refresh result');
	const after = await read();
	check('a queued owner refresh reports a bounded log entry', after.logItems.length > 0, JSON.stringify(after.logItems.slice(-2)));
	check('the log names the real refresh scope', after.logItems.some(line => /series index|default charts|browse/.test(line)), after.logItems.at(-1) || '');
	check('the panel has no horizontal overflow at this viewport', after.overflow !== null && after.overflow <= 1 && after.right > 0, 'right=' + after.right + ' viewport=' + after.viewport);
	const clipped = await evaluate(`(() => { const r = document.querySelector('#cacheMaintenance').getBoundingClientRect(); return { x: Math.max(0, r.left), y: Math.max(0, r.top), width: Math.min(innerWidth, r.width), height: Math.min(innerHeight, r.height), scale: 1 }; })()`);
	if (clipped.width > 0 && clipped.height > 0) {
		const image = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false, clip: clipped });
		writeFileSync(join(outDir, 'cache-panel-card-' + profile + '.png'), Buffer.from(image.data, 'base64'));
		evidence.screenshots.push('cache-panel-card-' + profile + '.png');
	}

	// Without the installation cookie the panel must not pretend to be authorised.
	await send('Network.clearBrowserCookies');
	await send('Page.navigate', { url: base + '/settings.html?v=' + Date.now() });
	await waitFor(`/Sign in/.test(document.querySelector('#cacheStatus')?.textContent || '')`, 15000, 'sign-in notice');
	const signedOut = await read();
	check('without an owner session the panel asks for sign-in', /Sign in/.test(signedOut.text), signedOut.text);
	check('without an owner session the refresh button is disabled', signedOut.buttonDisabled === true);
	await shot('cache-panel-signed-out-' + profile + '.png');

	const failed = evidence.checks.filter(entry => !entry.pass);
	if (failed.length) {
		writeFileSync(join(outDir, 'cache-panel-' + profile + '.json'), JSON.stringify(evidence, null, 2));
		console.error('CACHE-133 ' + profile + ': FAIL (' + failed.length + '/' + evidence.checks.length + ')');
		process.exitCode = 1;
	} else {
		writeFileSync(join(outDir, 'cache-panel-' + profile + '.json'), JSON.stringify(evidence, null, 2));
		console.log('CACHE-133 ' + profile + ': PASS (' + evidence.checks.length + '/' + evidence.checks.length + ')');
	}
} finally {
	try { socket?.close(); } catch {}
	try { chrome?.kill(); } catch {}
	try { setup.close(); dead.close(); local.close(); } catch {}
	try { rmSync(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {}
}
