/* Local Chrome check for artwork fallback chain (release 103).
 * No live playback, production request or broad artwork crawl. */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const publicDirectory = fileURLToPath(new URL('../public/', import.meta.url));
const outDir = fileURLToPath(new URL('../../outputs/Tellybox-artwork-fix-103/evidence/', import.meta.url));
mkdirSync(outDir, { recursive: true });
const chromePath = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe',
	'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/usr/bin/chromium']
	.filter(Boolean).find(candidate => existsSync(candidate));
if (!chromePath) { console.log('SKIP: Chrome or Chromium not found. Set CHROME_PATH.'); process.exit(0); }

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const page = `<!doctype html><html><head><meta charset="utf-8"><script src="/asset-fallback.js"></script><script src="/artwork-fallback.js"></script></head><body>
<img id="signed-to-local" src="/broken-signed.jpg" data-tellybox-local="/local.jpg" data-tellybox-poster="/poster.jpg" data-tellybox-fallback="1" alt="">
<img id="local-to-poster" src="/broken-local.jpg" data-tellybox-local="/missing.jpg" data-tellybox-poster="/poster.jpg" alt="">
<img id="poster-only" src="/broken-poster.jpg" data-tellybox-poster="/poster.jpg" alt="">
<img id="hung" src="/hang.jpg" data-tellybox-local="/local.jpg" data-tellybox-poster="/poster.jpg" data-tellybox-fallback="1" alt="">
<img id="no-fallback" src="/broken-none.jpg" onerror="this.dataset.failed='1'" alt="">
<script>window.__ready=false;
Promise.all([...document.images].map(img=>new Promise(resolve=>{
 if(img.complete)return resolve();img.addEventListener('load',resolve,{once:true});img.addEventListener('error',resolve,{once:true});setTimeout(resolve,3000);
}))).then(()=>{window.__ready=true;});</script></body></html>`;

const types = { '.js': 'text/javascript', '.jpg': 'image/jpeg' };
const server = createServer((request, response) => {
	const url = new URL(request.url, 'http://127.0.0.1');
	if (url.pathname === '/') { response.writeHead(200, { 'Content-Type': 'text/html' }); response.end(page); return; }
	if (url.pathname === '/local.jpg' || url.pathname === '/poster.jpg') {
		response.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': png.length }); response.end(png); return;
	}
	if (url.pathname === '/hang.jpg') return; // intentionally never responds
	if (url.pathname === '/artwork-fallback.js' || url.pathname === '/asset-fallback.js') {
		response.writeHead(200, { 'Content-Type': 'text/javascript' }); response.end(readFileSync(join(publicDirectory, url.pathname.slice(1)))); return;
	}
	response.writeHead(404, { 'Content-Type': 'text/plain' }); response.end('missing');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const profile = mkdtempSync(join(tmpdir(), 'tellybox-artwork-103-'));
const child = spawn(chromePath, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
	'--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
async function target(port) {
	for (let i = 0; i < 100; i++) {
		try { const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); const page = list.find(x => x.type === 'page'); if (page) return page; } catch {}
		await sleep(100);
	}
	throw new Error('Chrome target unavailable');
}
async function connect(targetValue) {
	const socket = new WebSocket(targetValue.webSocketDebuggerUrl);
	await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
	let id = 0; const pending = new Map();
	socket.onmessage = event => { const message = JSON.parse(event.data); if (message.id && pending.has(message.id)) { const { resolve, reject } = pending.get(message.id); pending.delete(message.id); message.error ? reject(new Error(JSON.stringify(message.error))) : resolve(message.result); } };
	return (method, params = {}) => new Promise((resolve, reject) => { const messageId = ++id; pending.set(messageId, { resolve, reject }); socket.send(JSON.stringify({ id: messageId, method, params })); });
}
const results = {};
try {
	let port = 0;
	for (let i = 0; i < 100; i++) { const file = join(profile, 'DevToolsActivePort'); if (existsSync(file)) { port = Number(readFileSync(file, 'utf8').split(/\r?\n/)[0]); if (port) break; } await sleep(100); }
	const send = await connect(await target(port));
	await send('Page.enable'); await send('Runtime.enable');
	const evaluate = async expression => { const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.text); return result.result.value; };
	await send('Page.navigate', { url: origin + '/' });
	for (let i = 0; i < 80; i++) { if (await evaluate('window.__ready === true')) break; await sleep(100); }
	await sleep(1200);
	const state = await evaluate(`(() => { const row = id => { const img=document.getElementById(id); return { src: img.src, path: new URL(img.src).pathname, width: img.naturalWidth, failed: img.dataset.failed || '', stage: img.dataset.tellyboxArtworkStage || '' }; }; return { ready: window.__ready === true, signed: row('signed-to-local'), local: row('local-to-poster'), poster: row('poster-only'), hung: row('hung'), none: row('no-fallback') }; })()`);
	const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
	writeFileSync(join(outDir, 'artwork-fallback-103.png'), Buffer.from(shot.data, 'base64'));
	const ready = state.ready && state.signed.path === '/local.jpg' && state.signed.width > 0 &&
		state.local.path === '/poster.jpg' && state.local.width > 0 &&
		state.poster.path === '/poster.jpg' && state.poster.width > 0 &&
		state.hung.path === '/local.jpg' && state.hung.width > 0 &&
		state.none.failed === '1';
	results.ready = ready; results.state = state;
	writeFileSync(join(outDir, 'BROWSER-ARTWORK-FALLBACK-103.json'), JSON.stringify(results, null, 2) + '\n');
	console.log(JSON.stringify(results, null, 2));
	process.exitCode = ready ? 0 : 1;
} finally {
	child.kill(); await sleep(700); try { rmSync(profile, { recursive: true, force: true }); } catch {}
	server.closeAllConnections(); server.close();
}
