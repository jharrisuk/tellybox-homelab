/* Real-browser check for the release 108 still-watching player hook.
 *
 * This serves the real server/public index.html, styles and app.js with stubbed
 * API responses and a stubbed <video> element. It never starts a real stream,
 * never touches production and writes no files outside the browser profile.
 * The 2-hour threshold is shortened through the real monitor instance and a
 * monotonic performance.now() offset, so the prompt, pause, hidden-tab,
 * deferral, Back/Escape, stop, timeout and automatic-next paths all run against
 * the actual app.js wiring.
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const publicDirectory = fileURLToPath(new URL('../public/', import.meta.url));
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
	console.log('SKIP: Chrome or Chromium was not found. Set CHROME_PATH to run the release 108 still-watching browser check.');
	process.exit(0);
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const movie = { Id: 'fixture-movie', Name: 'Still watching fixture film', Type: 'Movie', Source: 'local', RunTimeTicks: 7200 * 1e7, Artwork: '/fixture-poster.png', UserData: {} };
const episodeOne = { Id: 'fixture-episode-1', Name: 'Fixture episode one', Type: 'Episode', SeriesId: 'fixture-series', SeriesName: 'Fixture series', ParentIndexNumber: 1, IndexNumber: 1, Source: 'local', UserData: {} };
const episodeTwo = { Id: 'fixture-episode-2', Name: 'Fixture episode two', Type: 'Episode', SeriesId: 'fixture-series', SeriesName: 'Fixture series', ParentIndexNumber: 1, IndexNumber: 2, Source: 'local', UserData: {} };
const liveChannel = { Id: 'fixture-live', Name: 'Fixture live channel', Type: 'TvChannel', Source: 'Dispatcharr', UserData: {} };

const fixture = { playCalls: 0, sessions: [], stops: [], stoppedSessions: [], consoleErrors: [] };

async function requestJson(request) {
	let raw = '';
	for await (const chunk of request) raw += chunk;
	try { return raw ? JSON.parse(raw) : {}; } catch { return {}; }
}

function sendJson(response, value, status = 200) {
	response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
	response.end(JSON.stringify(value));
}

async function handleApi(url, request, response) {
	const path = url.pathname;
	const method = request.method || 'GET';
	if (path === '/api/capabilities') { sendJson(response, { canShare: false, playbackDefaults: { englishSubtitles: false, autoNext: false, skipIntros: false } }); return; }
	if (path === '/api/auth/status') { sendJson(response, { local: true, home: false, person: null, authenticated: true, email: null, localPlayback: null }); return; }
	if (path === '/api/auth/logout') { sendJson(response, { ok: true }); return; }
	if (path === '/api/status') { sendJson(response, { connected: true, features: { discover: false, comingSoon: false, live: false, recordings: false } }); return; }
	if (path === '/api/libraries') { sendJson(response, [{ Id: 'local-movies', Name: 'Films', CollectionType: 'movies' }]); return; }
	if (path === '/api/favourites' || path === '/api/favourites/home') { sendJson(response, { own: { id: 'me', name: 'My favourites', items: [] } }); return; }
	if (path === '/api/viewing-status') { sendJson(response, { blocked: false, remainingSeconds: null }); return; }
	if (path === '/api/web/items') { sendJson(response, { items: [movie], total: 1, genres: [] }); return; }
	if (path === '/api/web/home') { sendJson(response, { rows: [], featured: [] }); return; }
	if (path === '/api/web/releases' || path === '/api/web/releases/tv') { sendJson(response, { items: [] }); return; }
	if (/^\/api\/web\/items\/[^/]+\/next$/.test(path)) {
		sendJson(response, { status: 'complete', item: null, seriesId: 'fixture-series', suggestions: [] });
		return;
	}
	if (/^\/api\/web\/items\/[^/]+\/segments$/.test(path)) { sendJson(response, { segments: [] }); return; }
	if (path === '/api/play' && method === 'POST') {
		const body = await requestJson(request);
		fixture.playCalls += 1;
		const live = body.id === liveChannel.Id;
		fixture.sessions.push({ id: body.id, live, session: 'fixture-session-' + fixture.playCalls });
		sendJson(response, {
			session: 'fixture-session-' + fixture.playCalls,
			url: '/fixture-media.mp4',
			kind: 'direct',
			method: 'DirectPlay',
			live,
			audio: [],
			subtitles: [],
			subtitleIndex: -1,
			mediaRoute: 'direct',
		});
		return;
	}
	if (/^\/api\/sessions\/[^/]+$/.test(path) && method === 'POST') {
		const body = await requestJson(request);
		fixture.sessions.push({ session: path.split('/').pop(), action: body.action, position: body.position });
		if (body.action === 'stop') fixture.stops.push(body.position || 0);
		sendJson(response, { ok: true });
		return;
	}
	if (path.startsWith('/api/web/art/') || path.startsWith('/images/')) {
		response.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': png.length, 'Cache-Control': 'no-store' });
		response.end(png);
		return;
	}
	if (path.startsWith('/api/')) { sendJson(response, {}); return; }
	sendJson(response, { error: 'Unconfigured fixture route: ' + path }, 404);
}

const contentTypes = {
	'.html': 'text/html; charset=utf-8',
	'.js': 'text/javascript; charset=utf-8',
	'.css': 'text/css; charset=utf-8',
	'.svg': 'image/svg+xml',
	'.png': 'image/png',
	'.ico': 'image/x-icon',
};

const server = createServer(async (request, response) => {
	const url = new URL(request.url || '/', 'http://127.0.0.1');
	if (url.pathname.startsWith('/api/')) {
		try { await handleApi(url, request, response); }
		catch (error) { if (!response.headersSent) sendJson(response, { error: error.message }, 500); }
		return;
	}
	if (url.pathname === '/fixture-media.mp4') {
		response.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': 0, 'Cache-Control': 'no-store' });
		response.end();
		return;
	}
	if (url.pathname === '/vendor/hls.min.js') {
		response.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
		response.end('window.Hls = { isSupported: function () { return false; }, Events: {}, ErrorTypes: {} };');
		return;
	}
	const mapped = url.pathname === '/' ? 'index.html' : url.pathname.replace(/^\//, '');
	const file = join(publicDirectory, mapped);
	if (!file.startsWith(publicDirectory) || !existsSync(file)) {
		if (extname(url.pathname) === '.png') {
			response.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': png.length, 'Cache-Control': 'no-store' });
			response.end(png);
			return;
		}
		if (extname(url.pathname) === '.svg') {
			response.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-store' });
			response.end('<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"></svg>');
			return;
		}
		response.writeHead(404, { 'Content-Type': 'text/plain' });
		response.end('not found');
		return;
	}
	response.writeHead(200, { 'Content-Type': contentTypes[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
	response.end(readFileSync(file));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = 'http://127.0.0.1:' + server.address().port;

const profile = mkdtempSync(join(tmpdir(), 'tellybox-still-watching-108-'));
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
	return {
		socket,
		send: (method, params = {}) => new Promise((resolve, reject) => {
			const messageId = ++id;
			pending.set(messageId, { resolve, reject });
			socket.send(JSON.stringify({ id: messageId, method, params }));
		}),
		on: (method, listener) => {
			const listeners = eventListeners.get(method) || [];
			listeners.push(listener);
			eventListeners.set(method, listeners);
		},
	};
}

const results = { fixtureOnly: true, livePlayback: false, checks: {}, failures: [] };
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
		if (value) fixture.consoleErrors.push(String(value).split('\n')[0]);
	});
	on('Runtime.consoleAPICalled', params => {
		if (params?.type !== 'error') return;
		const text = (params.args || []).map(argument => argument.value ?? argument.description ?? '').join(' ');
		if (text) fixture.consoleErrors.push(text.split('\n')[0]);
	});
	await send('Page.enable');
	await send('Runtime.enable');
	await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });

	const evaluate = async expression => {
		const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
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
			await sleep(50);
		}
		throw new Error('Timed out waiting for ' + label + ' (last: ' + JSON.stringify(last) + ')');
	};
	const check = async (name, fn) => {
		try {
			const detail = await fn();
			results.checks[name] = detail === undefined ? true : detail;
		} catch (error) {
			results.checks[name] = { error: error.message };
			results.failures.push(name);
		}
	};

	await send('Page.navigate', { url: origin + '/' });
	await waitFor("document.readyState === 'complete' && typeof startPlayback === 'function'", 12000, 'app.js load');
	await sleep(600);

	await check('stub video state is installed', async () => evaluate(`(() => {
		const video = document.querySelector('#video');
		const media = window.__media = { paused: true, ended: false, seeking: false, readyState: 4, duration: 120, currentTime: 0, src: '' };
		Object.defineProperty(video, 'paused', { configurable: true, get: () => media.paused });
		Object.defineProperty(video, 'ended', { configurable: true, get: () => media.ended });
		Object.defineProperty(video, 'seeking', { configurable: true, get: () => media.seeking });
		Object.defineProperty(video, 'readyState', { configurable: true, get: () => media.readyState });
		Object.defineProperty(video, 'duration', { configurable: true, get: () => media.duration });
		Object.defineProperty(video, 'currentTime', { configurable: true, get: () => media.currentTime, set: value => { media.currentTime = Number(value) || 0; } });
		Object.defineProperty(video, 'currentSrc', { configurable: true, get: () => media.src });
		Object.defineProperty(video, 'src', { configurable: true, get: () => media.src, set: value => { media.src = String(value); } });
		const remove = video.removeAttribute.bind(video);
		video.removeAttribute = name => { if (name === 'src') media.src = ''; remove(name); };
		video.load = () => {};
		video.play = () => {
			media.paused = false; media.ended = false; media.readyState = 4;
			video.dispatchEvent(new Event('playing'));
			return Promise.resolve();
		};
		video.pause = () => {
			if (media.paused) return;
			media.paused = true;
			video.dispatchEvent(new Event('pause'));
		};
		window.__realNow = performance.now.bind(performance);
		window.__clockOffset = 0;
		performance.now = () => window.__realNow() + window.__clockOffset;
		window.__advance = ms => { window.__clockOffset += Number(ms) || 0; updateStillWatching(); };
		window.__jump = ms => { window.__clockOffset += Number(ms) || 0; };
		return true;
	})()`));

	const start = async (item, options = '') => evaluate(`(async () => {
		await startPlayback(${JSON.stringify(item)}, 0, false${options});
		return true;
	})()`);
	const monitor = () => evaluate(`(() => {
		if (!stillWatching) return null;
		return { state: stillWatching.state, elapsed: stillWatching.elapsedMs, promptElapsed: stillWatching.promptElapsedMs, resume: stillWatching.resumeApplies, marker: stillWatching.marker || '' };
	})()`);
	const fastPrompt = async (threshold = 1000, promptMs = 5000) => evaluate(`(() => {
		stillWatching.thresholdMs = ${Number(threshold)};
		stillWatching.promptMs = ${Number(promptMs)};
		stillWatching.reset(performance.now());
		return true;
	})()`);
	const promptVisible = () => evaluate(`(() => { const node = document.querySelector('#stillWatching'); return Boolean(node && !node.hidden); })()`);
	const keep = () => evaluate('keepWatchingFromPrompt()');
	const playerOpen = () => evaluate("document.querySelector('#player').open");

	await check('films create a resume-capable session monitor', async () => {
		await start(movie);
		const value = await monitor();
		if (!value) throw new Error('no monitor was created');
		if (value.resume !== true) throw new Error('film monitor should save resume position');
		if (!(await playerOpen())) throw new Error('player did not open');
		return value;
	});

	await check('the prompt is an accessible sixty-second alertdialog focused on Keep watching', async () => {
		await fastPrompt(1000, 60000);
		await evaluate('__advance(1500)');
		const state = await evaluate(`(() => {
			const node = document.querySelector('#stillWatching');
			return {
				visible: Boolean(node && !node.hidden),
				role: node?.getAttribute('role') || '',
				labelled: node?.getAttribute('aria-labelledby') || '',
				seconds: document.querySelector('#stillWatchingSeconds')?.textContent || '',
				focus: document.activeElement?.id || '',
				playerOpen: document.querySelector('#player').open,
			};
		})()`);
		if (!state.visible) throw new Error('prompt did not appear');
		if (state.role !== 'alertdialog') throw new Error('prompt role is not alertdialog');
		if (state.labelled !== 'stillWatchingTitle') throw new Error('prompt is not labelled');
		if (state.seconds !== '60') throw new Error('countdown did not start at 60: ' + state.seconds);
		if (state.focus !== 'stillWatchingKeep') throw new Error('Keep watching did not receive focus: ' + state.focus);
		if (!state.playerOpen) throw new Error('prompt should not close the player');
		return state;
	});

	await check('countdown ticks without refocusing or re-announcing', async () => {
		await evaluate("document.querySelector('#stillWatchingStop').focus(); __advance(1000)");
		const state = await evaluate(`(() => ({
			focus: document.activeElement?.id || '',
			seconds: document.querySelector('#stillWatchingSeconds')?.textContent || '',
			prompt: !document.querySelector('#stillWatching').hidden,
		}))()`);
		if (state.focus !== 'stillWatchingStop') throw new Error('focus moved away from Stop: ' + state.focus);
		if (state.seconds !== '59') throw new Error('countdown did not advance to 59: ' + state.seconds);
		if (!state.prompt) throw new Error('prompt disappeared during countdown');
		return state;
	});

	await check('Escape on the prompt is Keep watching, not a close', async () => {
		await evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))");
		const state = await evaluate(`(() => ({
			prompt: !document.querySelector('#stillWatching').hidden,
			playerOpen: document.querySelector('#player').open,
			state: stillWatching?.state || '',
			elapsed: stillWatching?.elapsedMs ?? -1,
		}))()`);
		if (state.prompt) throw new Error('prompt stayed open after Escape');
		if (!state.playerOpen) throw new Error('Escape closed the player');
		if (state.state !== 'watching') throw new Error('Escape did not reset the monitor: ' + state.state);
		if (state.elapsed > 100) throw new Error('Escape did not clear elapsed time: ' + state.elapsed);
		return state;
	});

	await check('paused time never accumulates', async () => {
		await fastPrompt(1000, 5000);
		await evaluate('__media.paused = true; __advance(4000)');
		const paused = await monitor();
		const visible = await promptVisible();
		if (paused.state !== 'watching' || paused.elapsed > 100) throw new Error('paused time accumulated: ' + JSON.stringify(paused));
		if (visible) throw new Error('prompt appeared while paused');
		await evaluate('__media.paused = false; __advance(1200)');
		if (!(await promptVisible())) throw new Error('prompt did not appear after playback resumed');
		await keep();
		return paused;
	});

	await check('hidden tabs neither accumulate nor show the prompt', async () => {
		await fastPrompt(1000, 5000);
		const overridden = await evaluate(`(() => {
			try { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); }
			catch { return false; }
			__advance(4000);
			return true;
		})()`);
		if (!overridden) return 'skipped: document.hidden is not overridable in this browser';
		const state = await monitor();
		if (state.state !== 'watching' || state.elapsed > 100) throw new Error('hidden time accumulated: ' + JSON.stringify(state));
		if (await promptVisible()) throw new Error('prompt appeared while the document was hidden');
		await evaluate(`(() => { delete document.hidden; __advance(1200); })()`);
		if (!(await promptVisible())) throw new Error('prompt did not return when the tab became visible');
		await keep();
		return state;
	});

	await check('a suspended hidden gap is not counted without intermediate ticks', async () => {
		await fastPrompt(1000, 5000);
		const overridden = await evaluate(`(() => {
			try { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); }
			catch { return false; }
			document.dispatchEvent(new Event('visibilitychange'));
			return true;
		})()`);
		if (!overridden) return 'skipped: document.hidden is not overridable in this browser';
		await evaluate('__jump(10800000)');
		await evaluate("delete document.hidden; document.dispatchEvent(new Event('visibilitychange'))");
		const state = await monitor();
		if (state.state !== 'watching' || state.elapsed > 100) throw new Error('suspended hidden time accumulated: ' + JSON.stringify(state));
		await keep();
		return state;
	});

	await check('dismissing a deferring modal at the threshold does not suppress the prompt', async () => {
		await fastPrompt(500, 5000);
		await evaluate("document.querySelector('#upNext').hidden = false; __advance(600)");
		const held = await evaluate(`(() => ({ state: stillWatching.state, deferred: stillWatching.deferred, elapsed: stillWatching.elapsedMs }))()`);
		if (held.state !== 'watching' || !held.deferred) throw new Error('up-next did not defer: ' + JSON.stringify(held));
		await evaluate("document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); __advance(20)");
		await evaluate("document.querySelector('#upNext').hidden = true; __advance(20)");
		const after = await monitor();
		if (after.state !== 'prompt' || !(await promptVisible())) throw new Error('dismissing the modal reset the deferred prompt: ' + JSON.stringify(after));
		await keep();
		return { held, after };
	});

	await check('an open up-next card defers the prompt without stacking', async () => {
		await fastPrompt(1000, 5000);
		await evaluate("document.querySelector('#upNext').hidden = false; __advance(1400)");
		const held = await evaluate(`(() => ({ state: stillWatching.state, deferred: stillWatching.deferred, visible: !document.querySelector('#stillWatching').hidden }))()`);
		if (held.state !== 'watching' || !held.deferred || held.visible) throw new Error('up-next did not defer the prompt: ' + JSON.stringify(held));
		await evaluate("document.querySelector('#upNext').hidden = true; __advance(20)");
		if (!(await promptVisible())) throw new Error('prompt did not appear after up-next closed');
		await keep();
		return held;
	});

	await check('a buffering warning defers the prompt without stacking', async () => {
		await fastPrompt(1000, 5000);
		const value = await evaluate(`(() => {
			window.__originalShown = playbackWarning.isShown;
			playbackWarning.isShown = () => true;
			__advance(1400);
			const held = { state: stillWatching.state, deferred: stillWatching.deferred, visible: !document.querySelector('#stillWatching').hidden };
			playbackWarning.isShown = window.__originalShown;
			__advance(20);
			return { held, after: !document.querySelector('#stillWatching').hidden };
		})()`);
		if (value.held.state !== 'watching' || !value.held.deferred || value.held.visible) throw new Error('warning did not defer the prompt: ' + JSON.stringify(value.held));
		if (!value.after) throw new Error('prompt did not appear after the warning cleared');
		await keep();
		return value;
	});

	await check('another open dialog defers the prompt', async () => {
		await fastPrompt(1000, 5000);
		const value = await evaluate(`(() => {
			const details = document.querySelector('#details');
			details.open = true;
			__advance(1400);
			const held = { state: stillWatching.state, deferred: stillWatching.deferred, visible: !document.querySelector('#stillWatching').hidden };
			details.open = false;
			__advance(20);
			return { held, after: !document.querySelector('#stillWatching').hidden };
		})()`);
		if (value.held.state !== 'watching' || !value.held.deferred || value.held.visible) throw new Error('dialog did not defer the prompt: ' + JSON.stringify(value.held));
		if (!value.after) throw new Error('prompt did not appear after the dialog closed');
		await keep();
		return value;
	});

	await check('browser Back on the prompt keeps watching and keeps the player open', async () => {
		await fastPrompt(1000, 5000);
		await evaluate('__advance(1200)');
		if (!(await promptVisible())) throw new Error('prompt did not appear before Back');
		await evaluate('history.back()');
		await waitFor("document.querySelector('#player').open && document.querySelector('#stillWatching').hidden", 4000, 'Back to keep watching');
		const state = await monitor();
		if (!state || state.state !== 'watching') throw new Error('Back did not reset the monitor: ' + JSON.stringify(state));
		if (state.elapsed > 100) throw new Error('Back did not clear elapsed time: ' + state.elapsed);
		return state;
	});

	await check('Stop watching saves progress, closes playback and starts no new stream', async () => {
		await fastPrompt(1000, 5000);
		await evaluate('__media.currentTime = 42; __advance(1200)');
		if (!(await promptVisible())) throw new Error('prompt did not appear before Stop');
		const playsBefore = fixture.playCalls;
		await evaluate("document.querySelector('#stillWatchingStop').click()");
		await waitFor("!document.querySelector('#player').open", 5000, 'player close after Stop');
		await sleep(100);
		const progress = await evaluate("localStorage.getItem('jimbo-progress-fixture-movie')");
		const state = {
			progress: Number(progress) || 0,
			playsBefore,
			playsAfter: fixture.playCalls,
			stopRecorded: fixture.stops.length > 0,
			monitor: await evaluate('typeof stillWatching === "undefined" ? "missing" : (stillWatching === null ? null : stillWatching.state)'),
		};
		if (state.playsAfter !== playsBefore) throw new Error('Stop started another stream');
		if (state.progress < 40) throw new Error('resume progress was not saved: ' + state.progress);
		if (!state.stopRecorded) throw new Error('the server session was not stopped');
		if (state.monitor !== null) throw new Error('session monitor was not cleared');
		return state;
	});

	await check('the sixty-second timeout closes through the same path', async () => {
		await start(movie);
		await evaluate('__media.currentTime = 33');
		await fastPrompt(700, 400);
		const playsBefore = fixture.playCalls;
		await evaluate('__advance(800)');
		if (!(await promptVisible())) throw new Error('prompt did not appear for timeout');
		await evaluate('__advance(450)');
		await waitFor("!document.querySelector('#player').open", 5000, 'player close after timeout');
		await sleep(100);
		const progress = Number(await evaluate("localStorage.getItem('jimbo-progress-fixture-movie')")) || 0;
		if (fixture.playCalls !== playsBefore) throw new Error('timeout started another stream');
		if (progress < 30) throw new Error('timeout did not save resume progress: ' + progress);
		return { progress, plays: fixture.playCalls };
	});

	await check('live channels create a non-resume monitor and save no resume point', async () => {
		await start(liveChannel);
		const value = await monitor();
		if (!value || value.resume !== false) throw new Error('live monitor should not save a resume point: ' + JSON.stringify(value));
		const live = await evaluate('typeof state === "undefined" ? "missing" : state.live');
		if (live !== true) throw new Error('fixture live playback did not enter live mode');
		await evaluate('__media.currentTime = 10');
		await fastPrompt(700, 400);
		await evaluate('__advance(800)');
		await evaluate('__advance(450)');
		await waitFor("!document.querySelector('#player').open", 5000, 'live player close after timeout');
		await sleep(100);
		const progress = await evaluate("localStorage.getItem('jimbo-progress-fixture-live')");
		if (progress !== null) throw new Error('live timeout saved a resume point: ' + progress);
		return value;
	});

	await check('automatic next preserves elapsed time and a manual retry does not', async () => {
		await start(episodeOne);
		await evaluate("stillWatching.elapsedMs = 2000; stillWatching.marker = 'same-session'");
		await evaluate(`(async () => { await startPlayback(${JSON.stringify(episodeTwo)}, 0, true, { automatic: true }); })()`);
		const automatic = await monitor();
		if (!automatic || automatic.marker !== 'same-session') throw new Error('automatic next replaced the session monitor');
		if (automatic.elapsed < 2000) throw new Error('automatic next reset accumulated time: ' + automatic.elapsed);
		await evaluate(`(async () => { await startPlayback(${JSON.stringify(episodeTwo)}, 0, true); })()`);
		const manual = await monitor();
		if (!manual || manual.marker) throw new Error('manual retry reused the old monitor');
		if (manual.elapsed > 1500) throw new Error('manual retry kept old elapsed time: ' + manual.elapsed);
		await evaluate('closePlayer()');
		await waitFor("!document.querySelector('#player').open", 5000, 'player close after transition check');
		return { automatic, manual };
	});

	results.consoleErrors = fixture.consoleErrors;
	results.requests = { playCalls: fixture.playCalls, sessions: fixture.sessions, stops: fixture.stops };
	const ready = results.failures.length === 0 && fixture.consoleErrors.length === 0;
	results.ready = ready;
	console.log(JSON.stringify(results, null, 2));
	process.exitCode = ready ? 0 : 1;
	socket.close();
} finally {
	child.kill();
	await sleep(700);
	try { rmSync(profile, { recursive: true, force: true }); } catch {}
	server.closeAllConnections();
	server.close();
}
