/* Local Chrome check for the release 099 buffering warning banner.
 * Uses the real playback-warning policy and real banner CSS at desktop and
 * mobile widths. It does not start a stream or touch production. */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const publicDirectory = fileURLToPath(new URL('../public/', import.meta.url));
const outDir = fileURLToPath(new URL('../../outputs/Tellybox-buffering-099/evidence/', import.meta.url));
mkdirSync(outDir, { recursive: true });
const chromePath = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe',
	'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/usr/bin/chromium']
	.filter(Boolean).find(candidate => existsSync(candidate));
if (!chromePath) { console.log('SKIP: Chrome or Chromium not found. Set CHROME_PATH.'); process.exit(0); }

const page = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/style.css"><script src="/playback-warning.js"></script></head><body class="activity-page">
<button id="safeFocus">Keep focus here</button>
<section id="playbackTrouble" class="playback-trouble" role="alert" hidden>
<p>Playback is struggling. This may be a slow connection or a temporary stream issue. Try again or choose a lower quality.</p>
<div class="playback-trouble-actions"><button id="troubleRetry">Retry</button><button id="troubleLower">Lower quality</button><button id="troubleDismiss">Dismiss</button><button id="troubleBack">Back</button></div></section>
<script>const m=new TellyboxBufferingWarning.Monitor({continuousMs:60000,cumulativeMs:999999});m.reset(0,'a');let r,shown=false;for(let s=1;s<=80;s++){r=m.update({now:s*1000,streamKey:'a',buffering:true,paused:false,seeking:false,ended:false});if(r.show)shown=true;}if(shown)document.querySelector('#playbackTrouble').hidden=false;document.querySelector('#troubleDismiss').onclick=()=>{document.querySelector('#playbackTrouble').hidden=true;};window.__warning=m;window.__shown=shown;document.querySelector('#safeFocus').focus();</script></body></html>`;
const types = { '.js': 'text/javascript', '.css': 'text/css' };
const server = createServer((request, response) => {
	const url = new URL(request.url, 'http://127.0.0.1');
	if (url.pathname === '/') { response.writeHead(200, { 'Content-Type': 'text/html' }); response.end(page); return; }
	const file = join(publicDirectory, url.pathname.replace(/^\//, ''));
	if (!existsSync(file)) { response.writeHead(404); response.end(); return; }
	response.writeHead(200, { 'Content-Type': types[extname(file)] || 'text/plain' });
	response.end(readFileSync(file));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const profile = mkdtempSync(join(tmpdir(), 'tellybox-buffer-099-'));
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
const results = [];
try {
	let port = 0;
	for (let i = 0; i < 100; i++) { const file = join(profile, 'DevToolsActivePort'); if (existsSync(file)) { port = Number(readFileSync(file, 'utf8').split(/\r?\n/)[0]); if (port) break; } await sleep(100); }
	const send = await connect(await target(port));
	await send('Page.enable'); await send('Runtime.enable');
	const evaluate = async expression => { const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (result.exceptionDetails) throw new Error(result.exceptionDetails.text); return result.result.value; };
	for (const viewport of [{ name: 'desktop', width: 1180, height: 900, mobile: false }, { name: 'mobile', width: 390, height: 844, mobile: true }]) {
		await send('Emulation.setDeviceMetricsOverride', { width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: viewport.mobile });
		await send('Page.navigate', { url: origin + '/' });
		await sleep(250);
		const state = await evaluate(`(() => { const panel=document.querySelector('#playbackTrouble'), buttons=[...panel.querySelectorAll('button')]; return { shown:!panel.hidden, role:panel.getAttribute('role'), buttons:buttons.length, focus:document.activeElement?.id, overflow:document.documentElement.scrollWidth-window.innerWidth, width:panel.getBoundingClientRect().width, top:panel.getBoundingClientRect().top }; })()`);
		const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
		writeFileSync(join(outDir, 'buffering-warning-099-' + viewport.name + '.png'), Buffer.from(shot.data, 'base64'));
		await evaluate("document.querySelector('#troubleDismiss').click(); true");
		const hidden = await evaluate("document.querySelector('#playbackTrouble').hidden");
		results.push({ viewport: viewport.name, state, hiddenAfterDismiss: hidden });
	}
	const ready = results.every(row => row.state.shown && row.state.role === 'alert' && row.state.buttons === 4 && row.state.focus === 'safeFocus' && row.state.overflow <= 1 && row.state.width > 0 && row.hiddenAfterDismiss);
	const report = { ready, results };
	writeFileSync(join(outDir, 'BROWSER-BUFFERING-WARNING-099.json'), JSON.stringify(report, null, 2) + '\n');
	console.log(JSON.stringify(report, null, 2));
	process.exitCode = ready ? 0 : 1;
} finally {
	child.kill(); await sleep(700); try { rmSync(profile, { recursive: true, force: true }); } catch {}
	server.closeAllConnections(); server.close();
}
