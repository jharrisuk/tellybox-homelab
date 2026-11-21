import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const fallbackScript = readFileSync(new URL('../public/asset-fallback.js', import.meta.url), 'utf8');
const outDir = fileURLToPath(new URL('../../outputs/Tellybox-static-cdn-094/evidence/', import.meta.url));
if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
const chromePath = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe',
	'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
	'/usr/bin/chromium', '/usr/bin/chromium-browser'].filter(Boolean).find(path => existsSync(path));
if (!chromePath) { console.log('SKIP: Chrome or Chromium was not found. Set CHROME_PATH.'); process.exit(0); }

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const requests = { origin: [], cdn: [] };
let cdnMode = 'ok';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const listen = handler => new Promise(resolve => { const server = createServer(handler); server.listen(0, '127.0.0.1', () => resolve(server)); });

function page(origin, cdn, mode) {
	const remote = mode !== 'local';
	const style = remote ? `${cdn}/style.css` : '/style.css';
	const image = remote ? `${cdn}/tellybox-logo.png` : '/tellybox-logo.png';
	const art = remote ? `${cdn}/tellybox/art/fixture/hash/image.png` : '/tellybox/art/fixture/hash/image.png';
	return `<!doctype html><html><head><meta charset="utf-8"><title>cdn-fixture</title>
<script src="/asset-fallback.js"></script>
<link rel="stylesheet" href="${style}"${remote ? ' data-tellybox-local="/style.css"' : ''}>
<script src="/app.js" defer></script></head><body>
<img id="brand" src="${image}"${remote ? ' data-tellybox-local="/tellybox-logo.png"' : ''}>
<img id="art" src="${art}"${remote ? ' data-tellybox-local="/tellybox/art/fixture/hash/image.png"' : ''}>
<script>document.title='ready'</script></body></html>`;
}

const origin = await listen((req, res) => {
	const url = new URL(req.url, 'http://origin');
	requests.origin.push(url.pathname);
	if (url.pathname === '/' || url.pathname === '/index.html') {
		res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
		res.end(page(originUrl, cdnUrl, url.searchParams.get('mode') || 'remote'));
	} else if (url.pathname === '/asset-fallback.js') {
		res.writeHead(200, { 'Content-Type': 'text/javascript' }); res.end(fallbackScript);
	} else if (url.pathname === '/style.css') {
		res.writeHead(200, { 'Content-Type': 'text/css' }); res.end('body{background:rgb(0,128,0)}');
	} else if (url.pathname === '/app.js') {
		res.writeHead(200, { 'Content-Type': 'text/javascript' }); res.end('document.body.dataset.localScript="loaded"');
	} else if (url.pathname === '/tellybox-logo.png') {
		res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': png.length }); res.end(png);
	} else if (url.pathname.startsWith('/tellybox/art/')) {
		res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': png.length }); res.end(png);
	} else { res.writeHead(404); res.end(); }
});
const cdn = await listen((req, res) => {
	const url = new URL(req.url, 'http://cdn');
	requests.cdn.push(url.pathname);
	if (cdnMode === 'fail') { res.writeHead(404); res.end(); return; }
	if (cdnMode === 'hang') return;
	if (url.pathname === '/style.css') {
		res.writeHead(200, { 'Content-Type': 'text/css' }); res.end('body{background:rgb(255,0,0)}');
	} else if (url.pathname === '/tellybox-logo.png' || url.pathname.startsWith('/tellybox/art/')) {
		res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': png.length }); res.end(png);
	} else { res.writeHead(404); res.end(); }
});
const originUrl = `http://127.0.0.1:${origin.address().port}`;
const cdnUrl = `http://127.0.0.1:${cdn.address().port}`;

async function targetFor(port) {
	for (let i = 0; i < 80; i++) {
		try {
			const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
			const target = list.find(item => item.type === 'page');
			if (target) return target;
		} catch {}
		await sleep(100);
	}
	throw new Error('Chrome did not expose a page target');
}
async function connect(target) {
	const socket = new WebSocket(target.webSocketDebuggerUrl);
	await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
	let id = 0;
	const pending = new Map();
	socket.onmessage = event => {
		const message = JSON.parse(event.data);
		if (message.id && pending.has(message.id)) {
			const { resolve, reject } = pending.get(message.id);
			pending.delete(message.id);
			if (message.error) reject(new Error(JSON.stringify(message.error)));
			else resolve(message.result);
		}
	};
	const send = (method, params = {}) => new Promise((resolve, reject) => {
		const messageId = ++id;
		pending.set(messageId, { resolve, reject });
		socket.send(JSON.stringify({ id: messageId, method, params }));
	});
	return { socket, send };
}
const profile = mkdtempSync(join(tmpdir(), 'tellybox-cdn-browser-'));
const child = spawn(chromePath, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
	'--no-default-browser-check', '--disable-extensions', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'],
	{ stdio: 'ignore' });
const results = [];
try {
	let port = 0;
	for (let i = 0; i < 80; i++) {
		const file = join(profile, 'DevToolsActivePort');
		if (existsSync(file)) { port = Number(readFileSync(file, 'utf8').split(/\r?\n/)[0]); if (port) break; }
		await sleep(100);
	}
	if (!port) throw new Error('Chrome did not open a DevTools port');
	const { send } = await connect(await targetFor(port));
	await send('Page.enable'); await send('Runtime.enable');
	await send('Emulation.setDeviceMetricsOverride', { width: 900, height: 700, deviceScaleFactor: 1, mobile: false });
	for (const scenario of [
		{ name: 'local', mode: 'local', cdn: 'ok', expect: 'local' },
		{ name: 'remote', mode: 'remote', cdn: 'ok', expect: 'cdn' },
		{ name: 'remote-cdn-404', mode: 'remote', cdn: 'fail', expect: 'fallback' },
		{ name: 'remote-cdn-hung', mode: 'remote', cdn: 'hang', expect: 'fallback' },
	]) {
		requests.origin.length = 0; requests.cdn.length = 0;
		cdnMode = scenario.cdn;
		await send('Page.navigate', { url: `${originUrl}/?mode=${scenario.mode}&cdn=${scenario.cdn}` });
		await sleep(scenario.expect === 'fallback' ? 4200 : 1200);
		const state = await send('Runtime.evaluate', {
			expression: `(() => ({ background: getComputedStyle(document.body).backgroundColor, brand: document.getElementById('brand').naturalWidth, art: document.getElementById('art').naturalWidth, localScript: document.body.dataset.localScript || '', title: document.title }))()`,
			returnByValue: true,
		});
		const shot = await send('Page.captureScreenshot', { format: 'png' });
		writeFileSync(join(outDir, `BROWSER-${scenario.name}.png`), Buffer.from(shot.data, 'base64'));
		results.push({ scenario: scenario.name, expect: scenario.expect, ...state.result.value,
			originRequests: [...requests.origin], cdnRequests: [...requests.cdn] });
	}
} finally {
	child.kill();
	await sleep(800);
	try { rmSync(profile, { recursive: true, force: true }); } catch {}
	origin.closeAllConnections(); origin.close(); cdn.closeAllConnections(); cdn.close();
}
writeFileSync(join(outDir, 'BROWSER-LOCAL-REMOTE-094.json'), JSON.stringify(results, null, 2) + '\n');
let failed = false;
for (const row of results) {
	if (row.brand < 1 || row.art < 1 || row.localScript !== 'loaded') failed = true;
	if (row.expect === 'local' && (row.background !== 'rgb(0, 128, 0)' || row.cdnRequests.length)) failed = true;
	if (row.expect === 'cdn' && (row.background !== 'rgb(255, 0, 0)' || !row.cdnRequests.some(path => path.endsWith('/style.css')))) failed = true;
	if (row.expect === 'fallback' && row.background !== 'rgb(0, 128, 0)') failed = true;
}
writeFileSync(join(outDir, 'BROWSER-LOCAL-REMOTE-094.txt'), JSON.stringify({ ready: !failed, results }, null, 2) + '\n');
console.log(JSON.stringify({ ready: !failed, results }, null, 2));
process.exit(failed ? 1 : 0);
