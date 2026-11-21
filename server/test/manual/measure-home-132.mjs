/* Measure the Home page in headless Chrome (CDP) against a local fixture.
 *
 * This is a manual evidence harness, not part of `node --test test/*.test.mjs`.
 * It serves the real server/public directory with a deterministic API and
 * realistic image payloads, then reports cold and warm request count, encoded
 * bytes, FCP, LCP and the number of /api/web/home requests. The live production
 * server is never contacted.
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

const publicRoot = process.env.PUBLIC_DIR
	? resolve(process.env.PUBLIC_DIR)
	: fileURLToPath(new URL('../../public/', import.meta.url));
const mode = process.env.MODE === 'before' ? 'before' : 'after';
const hlsFile = fileURLToPath(new URL('../../node_modules/hls.js/dist/hls.min.js', import.meta.url));
const chromePath = ['C:/Program Files/Google/Chrome/Application/chrome.exe',
	'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe'].find(existsSync);
if (!chromePath) {
	console.log('SKIP: Chrome was not found.');
	process.exit(0);
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const imageSvg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="600">'
	+ '<rect width="400" height="600" fill="#2a3328"/><rect x="40" y="40" width="320" height="520" fill="#4a5a45"/>'
	+ '<text x="200" y="300" fill="#c7ed89" font-size="28" text-anchor="middle">Tellybox</text>'
	+ '<!--' + ' artwork padding '.repeat(7000) + '--></svg>');
const contentTypes = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
	'.svg': 'image/svg+xml', '.png': 'image/png', '.webp': 'image/webp' };

function movies(count) {
	return Array.from({ length: count }, (_, index) => ({
		Id: ('m' + index.toString(16).padStart(31, '0')).slice(0, 32),
		Name: 'Fixture film ' + (index + 1), Type: 'Movie', Source: 'local', ProductionYear: 2024,
		RunTimeTicks: 7200e7, Genres: ['Drama'], Artwork: '',
		ArtworkLocal: `/images/m${index}/Primary?width=400`,
		BackdropArtworkLocal: `/images/m${index}/Backdrop?width=640`
	}));
}

const catalogue = movies(40);
const homePayload = {
	personalized: true, coldStart: false, generatedAt: new Date().toISOString(),
	rows: [
		{ id: 'continue', title: 'Continue watching', note: 'Right where you left off', items: catalogue.slice(0, 7) },
		{ id: 'for-you', title: 'Picked for you', note: '', items: catalogue.slice(7, 19) },
		{ id: 'new', title: 'Recently added', note: 'New in the collection', items: catalogue.slice(19, 31) }
	],
	featured: catalogue.slice(0, 2),
	availability: { pending: 0, checked: 0, queued: 0, continue: { complete: true },
		artwork: { pending: 0, requested: 0, resolved: 0, failed: 0, visible: 0, remaining: 0, limit: 24 } }
};

const state = { home: 0, favourites: 0, releases: 0, tunnel: 0, image: 0 };
const server = createServer((req, res) => {
	const url = new URL(req.url, 'http://127.0.0.1');
	let pathname = decodeURIComponent(url.pathname);
	const json = (body, delay = 0) => setTimeout(() => {
		res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
		res.end(JSON.stringify(body));
	}, delay);
	if (pathname === '/api/capabilities') return json({ canShare: false, playbackDefaults: {} });
	if (pathname === '/api/auth/status') return json({ local: true, home: false, email: false, person: null, authenticated: true, scope: 'local' });
	if (pathname === '/api/status') return json({ connected: true, features: {} });
	if (pathname === '/api/libraries') return json([]);
	if (pathname === '/api/favourites/home' || pathname === '/api/favourites') {
		state.favourites += 1;
		return json({ own: { id: 'me', name: 'Home favourites', items: [] } }, 100);
	}
	if (pathname === '/api/web/home') {
		state.home += 1;
		// The live server's settled feed is memoised for 45 s. The after run
		// models that reuse; the before run always rebuilds.
		const delay = mode === 'before' || state.home === 1 ? 2200 : 30;
		let body = '';
		req.on('data', chunk => { body += chunk; });
		return req.on('end', () => json(homePayload, delay));
	}
	if (pathname === '/api/web/releases/episodes') {
		state.releases += 1;
		return json({ items: [] }, 200);
	}
	if (pathname === '/api/auth/tunnel') {
		state.tunnel += 1;
		return json({ url: 'https://example.invalid' }, 2000);
	}
	if (pathname.startsWith('/images/')) {
		state.image += 1;
		res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Content-Length': imageSvg.length, 'Cache-Control': 'private, max-age=86400' });
		return res.end(imageSvg);
	}
	if (pathname === '/') pathname = '/index.html';
	if (pathname === '/vendor/hls.min.js') {
		const bytes = readFileSync(hlsFile);
		const etag = '"' + createHash('sha256').update(bytes).digest('hex').slice(0, 16) + '"';
		const headers = { 'Content-Type': 'text/javascript; charset=utf-8', ETag: etag,
			'Cache-Control': mode === 'before' ? 'no-store' : 'public, max-age=31536000, immutable' };
		if (mode !== 'before' && req.headers['if-none-match'] === etag) { res.writeHead(304, headers); return res.end(); }
		headers['Content-Length'] = bytes.length;
		res.writeHead(200, headers);
		return res.end(bytes);
	}
	const file = resolve(publicRoot, normalize(pathname).replace(/^([/\\])+/, ''));
	if (!file.startsWith(resolve(publicRoot)) || !existsSync(file)) {
		res.writeHead(404, { 'Content-Type': 'text/plain' });
		return res.end('not found');
	}
	const bytes = readFileSync(file);
	const etag = '"' + createHash('sha256').update(bytes).digest('hex').slice(0, 16) + '"';
	const headers = { 'Content-Type': contentTypes[extname(file)] || 'application/octet-stream', ETag: etag };
	if (mode === 'before') headers['Cache-Control'] = 'no-store';
	else if (pathname === '/app.js' || pathname === '/style.css' || pathname === '/home-124.css'
		|| pathname === '/tellybox-logo.png' || pathname === '/tellybox-logo.webp') headers['Cache-Control'] = 'max-age=0, must-revalidate';
	else headers['Cache-Control'] = 'no-store';
	if (mode !== 'before' && req.headers['if-none-match'] === etag) {
		res.writeHead(304, headers);
		return res.end();
	}
	headers['Content-Length'] = bytes.length;
	res.writeHead(200, headers);
	res.end(bytes);
});

const port = await new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const origin = 'http://127.0.0.1:' + port;

const profile = mkdtempSync(join(tmpdir(), 'tellybox-home-132-'));
const chrome = spawn(chromePath, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
	'--no-default-browser-check', '--disable-extensions', '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'], { stdio: 'ignore' });

async function targetFor(debugPort) {
	for (let attempt = 0; attempt < 100; attempt += 1) {
		try {
			const list = await (await fetch('http://127.0.0.1:' + debugPort + '/json/list')).json();
			const page = list.find(entry => entry.type === 'page');
			if (page) return page;
		} catch {}
		await sleep(100);
	}
	throw new Error('Chrome target unavailable');
}

async function connect(target) {
	const socket = new WebSocket(target.webSocketDebuggerUrl);
	await new Promise((res, rej) => { socket.onopen = res; socket.onerror = rej; });
	let id = 0;
	const pending = new Map();
	const listeners = new Map();
	socket.onmessage = event => {
		const message = JSON.parse(event.data);
		if (message.id && pending.has(message.id)) {
			const entry = pending.get(message.id); pending.delete(message.id);
			if (message.error) entry.reject(new Error(JSON.stringify(message.error))); else entry.resolve(message.result);
		} else if (message.method) for (const listener of listeners.get(message.method) || []) listener(message.params);
	};
	return {
		socket,
		send: (method, params = {}) => new Promise((res, rej) => { const messageId = ++id; pending.set(messageId, { resolve: res, reject: rej }); socket.send(JSON.stringify({ id: messageId, method, params })); }),
		on: (method, listener) => { const list = listeners.get(method) || []; list.push(listener); listeners.set(method, list); }
	};
}

const run = { requests: 0, bytes: 0, home: 0, favourites: 0, releases: 0, tunnel: 0, hls: 0, fcp: 0, lcp: 0, rows: 0, errors: [] };
let debugPort = 0;
for (let attempt = 0; attempt < 100 && !debugPort; attempt += 1) {
	const file = join(profile, 'DevToolsActivePort');
	if (existsSync(file)) debugPort = Number(readFileSync(file, 'utf8').split(/\r?\n/)[0]) || 0;
	if (!debugPort) await sleep(100);
}
const { send, on, socket } = await connect(await targetFor(debugPort));
await send('Page.enable');
await send('Runtime.enable');
await send('Network.enable');
await send('Network.setCacheDisabled', { cacheDisabled: false });
await send('Page.addScriptToEvaluateOnNewDocument', { source: `
	window.__perf = { fcp: 0, lcp: 0 };
	try {
		new PerformanceObserver(list => { for (const entry of list.getEntries()) if (entry.name === 'first-contentful-paint') window.__perf.fcp = entry.startTime; })
			.observe({ type: 'paint', buffered: true });
		new PerformanceObserver(list => { for (const entry of list.getEntries()) window.__perf.lcp = entry.startTime; })
			.observe({ type: 'largest-contentful-paint', buffered: true });
	} catch {}
` });

let measuring = false;
on('Network.requestWillBeSent', params => {
	if (!measuring || !params.request.url.startsWith(origin)) return;
	run.requests += 1;
	if (params.request.url.includes('/api/web/home') && !params.request.url.includes('/artwork')) run.home += 1;
	if (params.request.url.includes('/api/favourites')) run.favourites += 1;
	if (params.request.url.includes('/api/web/releases/episodes')) run.releases += 1;
	if (params.request.url.includes('/api/auth/tunnel')) run.tunnel += 1;
	if (params.request.url.includes('/vendor/hls.min.js')) run.hls += 1;
});
on('Network.loadingFinished', params => { if (measuring) run.bytes += Number(params.encodedDataLength) || 0; });
on('Runtime.exceptionThrown', params => run.errors.push(String(params?.exceptionDetails?.exception?.description || params?.exceptionDetails?.text || '').split('\n')[0]));
on('Runtime.consoleAPICalled', params => { if (params?.type === 'error') run.errors.push((params.args || []).map(a => a.value ?? a.description ?? '').join(' ').split('\n')[0]); });

async function evaluate(expression) {
	const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
	if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
	return result.result.value;
}

async function measure(label, reload) {
	for (const key of ['requests', 'bytes', 'home', 'favourites', 'releases', 'tunnel', 'hls', 'fcp', 'lcp', 'rows', 'tiles']) run[key] = 0;
	run.errors = [];
	measuring = true;
	if (reload) await send('Page.reload', { ignoreCache: false });
	else await send('Page.navigate', { url: origin + '/' });
	for (let attempt = 0; attempt < 100; attempt += 1) {
		await sleep(100);
		try { if (await evaluate("document.querySelectorAll('#homeRows .home-row').length > 0")) break; } catch {}
	}
	await sleep(5000);
	const perf = await evaluate('window.__perf || { fcp: 0, lcp: 0 }');
	run.fcp = Math.round(perf.fcp); run.lcp = Math.round(perf.lcp);
	run.rows = await evaluate("document.querySelectorAll('#homeRows .home-row').length");
	run.tiles = await evaluate("document.querySelectorAll('#homeRows .home-tile, #homeRows .continue-card:not(.continue-card--skeleton)').length");
	run.rowIds = await evaluate("Array.from(document.querySelectorAll('#homeRows .home-row')).map(row => row.className.split(' ').filter(name => name.startsWith('home-row--')).join(' ') + '|' + (row.querySelector('h2')?.textContent || '').trim())");
	measuring = false;
	return { label, ...run, bytesMB: Math.round(run.bytes / 1024 / 10) / 100 };
}

const cold = await measure('cold', false);
// A reload uses the same document cache; it is the browser's warm view.
const warm = await measure('warm', true);
const result = {
	origin,
	before: { requests: 77, bytesMB: 5.66, fcp: 64, lcp: 4180, home: 2 },
	cold, warm,
	pageErrors: run.errors,
};
writeFileSync(join(tmpdir(), 'tellybox-home-132-measure.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
socket.close();
chrome.kill();
server.close();
await sleep(600);
try { rmSync(profile, { recursive: true, force: true }); } catch { /* Chrome may still hold a lock; the OS temp cleaner removes it. */ }
