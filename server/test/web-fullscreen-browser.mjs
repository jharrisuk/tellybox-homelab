import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const style = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
const shareStyle = readFileSync(new URL('../public/share-player.css', import.meta.url), 'utf8');
const output = process.argv[2] || fileURLToPath(new URL('./fullscreen-artifacts/', import.meta.url));
const chromePath = [
	process.env.CHROME_PATH,
	'C:/Program Files/Google/Chrome/Application/chrome.exe',
	'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
	'/usr/bin/google-chrome',
	'/usr/bin/google-chrome-stable',
	'/usr/bin/chromium',
	'/usr/bin/chromium-browser',
	'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean).find(path => existsSync(path));

if (!chromePath) {
	console.log('SKIP: Chrome or Chromium was not found. Set CHROME_PATH to run the browser viewport check.');
	process.exit(0);
}

if (!existsSync(output)) {
	const { mkdirSync } = await import('node:fs');
	mkdirSync(output, { recursive: true });
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function fixture(kind) {
	const stylesheet = kind === 'share' ? '/share-player.css' : '/style.css';
	const stage = `<div id="stage" class="${kind === 'share' ? 'screen' : 'video-stage'}"><video id="video" muted playsinline autoplay preload="auto"></video>
<div id="liveControls" class="live-controls"><span class="live-badge">LIVE</span><button id="fullscreen" type="button">Fullscreen</button></div></div>`;
	const markup = kind === 'share' ? stage : `<dialog id="player">${stage}</dialog>`;
	return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="${stylesheet}">
<style>html,body{margin:0;background:#000}#source{display:none}</style></head>
<body>
${markup}
<canvas id="source" width="1280" height="720"></canvas>
<script>
const canvas = document.getElementById('source');
const context = canvas.getContext('2d');
const colours = ['#101510', '#c9f47d', '#5c7a4a', '#e9f3df', '#26321f', '#8bb35f'];
function draw(now) {
	const width = canvas.width, height = canvas.height;
	for (let i = 0; i < colours.length; i++) {
		context.fillStyle = colours[i];
		context.fillRect(Math.floor(i * width / colours.length), 0, Math.ceil(width / colours.length), height);
	}
	context.fillStyle = '#101510';
	context.fillRect(0, height * 0.36, width, height * 0.28);
	context.fillStyle = '#c9f47d';
	context.font = 'bold 54px system-ui';
	context.textAlign = 'center';
	context.fillText('SYNTHETIC TEST MEDIA ' + (Math.floor(now / 1000) % 2 ? 'A' : 'B'), width / 2, height * 0.55);
	requestAnimationFrame(draw);
}
requestAnimationFrame(draw);
const video = document.getElementById('video');
const player = document.getElementById('player');
if (player) player.showModal();
try { video.srcObject = canvas.captureStream(30); } catch {}
video.play().catch(() => {});
document.getElementById('fullscreen').onclick = () => {
	const stage = document.getElementById('stage');
	const request = stage.requestFullscreen || stage.webkitRequestFullscreen;
	if (request) request.call(stage);
	else if (video.webkitEnterFullscreen) video.webkitEnterFullscreen();
};
</script></body></html>`;
}

function startServer() {
	const server = createServer((request, response) => {
		const path = (request.url || '/').split('?')[0];
		if (path === '/style.css') {
			response.writeHead(200, { 'Content-Type': 'text/css' });
			response.end(style);
		} else if (path === '/share-player.css') {
			response.writeHead(200, { 'Content-Type': 'text/css' });
			response.end(shareStyle);
		} else if (path === '/main' || path === '/share') {
			response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
			response.end(fixture(path.slice(1)));
		} else {
			response.writeHead(404);
			response.end('not found');
		}
	});
	return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function targetFor(profile, port) {
	for (let i = 0; i < 80; i++) {
		try {
			const response = await fetch(`http://127.0.0.1:${port}/json/list`);
			const list = await response.json();
			const page = list.find(target => target.type === 'page');
			if (page) return page;
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
	const waiters = new Map();
	socket.onmessage = event => {
		const message = JSON.parse(event.data);
		if (message.id && pending.has(message.id)) {
			const { resolve, reject } = pending.get(message.id);
			pending.delete(message.id);
			if (message.error) reject(new Error(JSON.stringify(message.error)));
			else resolve(message.result);
		}
		if (message.method) {
			const listeners = waiters.get(message.method) || [];
			waiters.set(message.method, []);
			for (const listener of listeners) listener(message.params);
		}
	};
	const send = (method, params = {}) => new Promise((resolve, reject) => {
		const messageId = ++id;
		pending.set(messageId, { resolve, reject });
		socket.send(JSON.stringify({ id: messageId, method, params }));
	});
	const waitFor = method => new Promise(resolve => {
		const listeners = waiters.get(method) || [];
		listeners.push(resolve);
		waiters.set(method, listeners);
	});
	return { socket, send, waitFor };
}

async function main() {
	const server = await startServer();
	const port = server.address().port;
	const profile = mkdtempSync(join(tmpdir(), 'tellybox-fullscreen-'));
	const child = spawn(chromePath, [
		'--headless=new',
		'--disable-gpu',
		'--hide-scrollbars',
		'--no-first-run',
		'--no-default-browser-check',
		'--disable-extensions',
		'--autoplay-policy=no-user-gesture-required',
		'--remote-debugging-port=0',
		`--user-data-dir=${profile}`,
		'about:blank',
	], { stdio: 'ignore' });

	const results = [];
	try {
		let devtoolsPort = 0;
		for (let i = 0; i < 80; i++) {
			const file = join(profile, 'DevToolsActivePort');
			if (existsSync(file)) {
				devtoolsPort = Number(readFileSync(file, 'utf8').split(/\r?\n/)[0]);
				if (devtoolsPort) break;
			}
			await sleep(100);
		}
		if (!devtoolsPort) throw new Error('Chrome did not open a DevTools port');
		const target = await targetFor(profile, devtoolsPort);
		const { socket, send, waitFor } = await connect(target);
		await send('Page.enable');
		await send('Runtime.enable');

		for (const viewport of [{ name: 'portrait', width: 390, height: 844 }, { name: 'landscape', width: 844, height: 390 }]) {
			for (const kind of ['main', 'share']) {
				await send('Emulation.setDeviceMetricsOverride', {
					width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: true,
				});
				const loaded = waitFor('Page.loadEventFired');
				await send('Page.navigate', { url: `http://127.0.0.1:${port}/${kind}` });
				await loaded;
				await send('Runtime.evaluate', {
					expression: `new Promise(resolve => { const video = document.getElementById('video'); if (video.readyState >= 2) return resolve(); video.addEventListener('canplay', resolve, { once: true }); setTimeout(resolve, 3000); })`,
					awaitPromise: true,
				});
				await sleep(300);

				const point = await send('Runtime.evaluate', {
					expression: `(() => { const button = document.getElementById('fullscreen'); const rect = button.getBoundingClientRect(); return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }; })()`,
					returnByValue: true,
				});
				await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.result.value.x, y: point.result.value.y, button: 'left', clickCount: 1 });
				await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.result.value.x, y: point.result.value.y, button: 'left', clickCount: 1 });

				let fullscreen = false;
				for (let i = 0; i < 40; i++) {
					const state = await send('Runtime.evaluate', {
						expression: 'Boolean(document.fullscreenElement || document.webkitFullscreenElement)',
						returnByValue: true,
					});
					if (state.result.value) { fullscreen = true; break; }
					await sleep(100);
				}
				if (!fullscreen) throw new Error(`${kind} ${viewport.name}: fullscreen did not start`);

				const measured = await send('Runtime.evaluate', {
					expression: `(() => {
						const stage = document.getElementById('stage');
						const video = document.getElementById('video');
						const controls = document.getElementById('liveControls');
						const stageRect = stage.getBoundingClientRect();
						const videoRect = video.getBoundingClientRect();
						const videoStyle = getComputedStyle(video);
						const controlsStyle = getComputedStyle(controls);
						return {
							viewport: { width: innerWidth, height: innerHeight },
							stage: { x: stageRect.x, y: stageRect.y, width: stageRect.width, height: stageRect.height },
							video: { x: videoRect.x, y: videoRect.y, width: videoRect.width, height: videoRect.height },
							objectFit: videoStyle.objectFit,
							objectPosition: videoStyle.objectPosition,
							maxHeight: videoStyle.maxHeight,
							controls: { left: parseFloat(controlsStyle.left), right: parseFloat(controlsStyle.right), bottom: parseFloat(controlsStyle.bottom) },
							fullscreen: Boolean(document.fullscreenElement || document.webkitFullscreenElement)
						};
					})()`,
					returnByValue: true,
				});
				const value = measured.result.value;
				const failures = [];
				if (!value.fullscreen) failures.push('fullscreen state is false');
				if (Math.abs(value.stage.width - viewport.width) > 1 || Math.abs(value.stage.height - viewport.height) > 1) {
					failures.push(`stage ${value.stage.width}x${value.stage.height} does not fill ${viewport.width}x${viewport.height}`);
				}
				if (Math.abs(value.video.width - viewport.width) > 1 || Math.abs(value.video.height - viewport.height) > 1) {
					failures.push(`video ${value.video.width}x${value.video.height} does not fill ${viewport.width}x${viewport.height}`);
				}
				if (value.objectFit !== 'contain') failures.push(`object-fit is ${value.objectFit}, expected contain`);
				if (!['100%', 'none'].includes(value.maxHeight) && !(parseFloat(value.maxHeight) >= viewport.height)) {
					failures.push(`max-height is ${value.maxHeight}, expected 100%, none or at least ${viewport.height}px`);
				}
				if (!(value.controls.bottom >= 14)) failures.push(`safe-area bottom is ${value.controls.bottom}, expected at least 14`);
				if (!(value.controls.left >= 0)) failures.push(`safe-area left is ${value.controls.left}`);
				if (!(value.controls.right >= 0)) failures.push(`safe-area right is ${value.controls.right}`);

				const shot = await send('Page.captureScreenshot', { format: 'png' });
				const { writeFileSync } = await import('node:fs');
				writeFileSync(join(output, `${kind}-${viewport.name}.png`), Buffer.from(shot.data, 'base64'));
				results.push({ kind, viewportName: viewport.name, ...value, failures });
				console.log(`${kind} ${viewport.name}: ${failures.length ? 'FAIL' : 'PASS'} ${JSON.stringify(value)}`);

				await send('Runtime.evaluate', {
					expression: `Promise.resolve(document.exitFullscreen ? document.exitFullscreen() : (document.webkitExitFullscreen ? document.webkitExitFullscreen() : null)).catch(() => {})`,
					awaitPromise: true,
				});
				await sleep(200);
			}
		}
		socket.close();
		const failures = results.flatMap(result => result.failures.map(failure => `${result.kind} ${result.viewportName}: ${failure}`));
		if (failures.length) {
			console.error(failures.join('\n'));
			process.exitCode = 1;
		}
	} finally {
		child.kill();
		server.close();
		try { rmSync(profile, { recursive: true, force: true }); } catch {}
	}
}

main().catch(error => {
	console.error(error);
	process.exitCode = 1;
});
