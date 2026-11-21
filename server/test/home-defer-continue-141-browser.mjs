/* Release 141: browser measurement for the deferred web Home.
 *
 * One profile per process:
 *   cd server
 *   $env:DEFER_MODE='defer'; node test/home-defer-continue-141-browser.mjs
 *   $env:DEFER_MODE='today'; node test/home-defer-continue-141-browser.mjs
 *
 * "defer" is the new client flow (body.deferContinue + /api/web/home/continue).
 * "today" keeps the current single complete response: a document-start script
 * removes deferContinue from the Home request, exactly the request the old
 * client sent, so the server's existing wait is measured unchanged.
 *
 * The fixture makes the exact Continue episode resolve through the slow
 * single-item Jellyfin read (1300 ms). That read is used only by homeContinue,
 * never by the feed itself. It records time-to-first-rows for a cold and a warm
 * visit, when Continue lands, and the Home/API request counts.
 *
 * If Chrome is unavailable the script prints SKIP and exits 0.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

const mode = String(process.env.DEFER_MODE || '').trim().toLowerCase();
if (!['defer', 'today'].includes(mode)) {
	console.error("DEFER_MODE must be 'defer' or 'today'.");
	process.exit(2);
}
const outDir = process.env.EVIDENCE_DIR
	? process.env.EVIDENCE_DIR.replace(/[\\/]$/, '')
	: fileURLToPath(new URL('../../outputs/Tellybox-home-defer-141/evidence/', import.meta.url));
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
	console.log('SKIP: Chrome or Chromium was not found. Set CHROME_PATH to run the deferred Home browser measurement.');
	process.exit(0);
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const NOW = '2026-11-18T12:00:00Z';
const film = (id, name, genre, created) => ({
	Id: id, Name: name, Type: 'Movie', Genres: [genre], RunTimeTicks: 7200e7,
	DateCreated: created, PremiereDate: '2026-01-01', UserData: { Played: false }
});
const series = {
	Id: '11111111111111111111111111111111', Name: 'Deferred Test Show', Type: 'Series',
	Genres: ['Drama'], DateCreated: NOW, ChildCount: 1, UserData: { Played: false, UnplayedItemCount: 1 }
};
const episode = {
	Id: '66666666666666666666666666666666', Name: 'The exact slow episode', Type: 'Episode',
	SeriesId: series.Id, SeriesName: series.Name, ParentIndexNumber: 1, IndexNumber: 1,
	RunTimeTicks: 3000e7, PremiereDate: '2026-11-01', UserData: { Played: false }
};
const films = [
	film('22222222222222222222222222222222', 'Cold Drama Film', 'Drama', '2026-11-10T12:00:00Z'),
	film('33333333333333333333333333333333', 'Comedy Film', 'Comedy', '2026-11-09T12:00:00Z'),
	film('44444444444444444444444444444444', 'Action Film', 'Action', '2026-11-08T12:00:00Z'),
	film('55555555555555555555555555555555', 'Family Film', 'Family', '2026-11-07T12:00:00Z')
];
const SLOW_ITEM_MS = 1300;

async function startFixture() {
	const directory = mkdtempSync(join(tmpdir(), 'tellybox-home-defer-141-browser-'));
	const servers = [];
	const listen = handler => new Promise(resolve => {
		const server = http.createServer(handler);
		server.listen(0, '127.0.0.1', () => { servers.push(server); resolve(server); });
	});
	const itemById = new Map([...films, series, episode].map(item => [item.Id, item]));
	const calls = { slowItem: 0 };
	const jellyfin = await listen((req, res) => {
		const url = new URL(req.url, 'http://127.0.0.1');
		res.setHeader('Content-Type', 'application/json');
		if (url.pathname === '/Items') return res.end(JSON.stringify({ Items: [...films, series], TotalRecordCount: films.length + 1 }));
		const itemMatch = url.pathname.match(/^\/Users\/[^/]+\/Items\/([^/]+)$/);
		if (itemMatch) {
			const id = decodeURIComponent(itemMatch[1]);
			if (id === episode.Id) {
				calls.slowItem += 1;
				setTimeout(() => { try { res.end(JSON.stringify(episode)); } catch { /* client gone */ } }, SLOW_ITEM_MS);
				return;
			}
			const item = itemById.get(id);
			if (!item) { res.statusCode = 404; return res.end('{}'); }
			return res.end(JSON.stringify(item));
		}
		const showMatch = url.pathname.match(/^\/Shows\/([^/]+)\/Episodes$/);
		if (showMatch) return res.end(JSON.stringify({ Items: [episode], TotalRecordCount: 1 }));
		if (url.pathname.startsWith('/Users/')) return res.end(JSON.stringify({ Items: [] }));
		res.end('{}');
	});
	const local = await listen();
	Object.assign(process.env, {
		NODE_ENV: 'test', AUTH_DIR: directory, DATA_DIR: directory, CATALOGUE_CACHE_DIR: directory,
		JELLYFIN_URL: `http://127.0.0.1:${jellyfin.address().port}`,
		DISPATCHARR_URL: 'http://127.0.0.1:1',
		PORT: String(local.address().port), LOCAL_HOSTS: '127.0.0.1', LOCAL_NETWORKS: '127.0.0.0/8',
		PUBLIC_ORIGIN: 'http://127.0.0.1:' + local.address().port
	});
	writeFileSync(join(directory, 'connection.json'), JSON.stringify({ userId: 'fixture', token: 'fixture-only' }));
	writeFileSync(join(directory, 'apps.json'), JSON.stringify({}));
	writeFileSync(join(directory, 'account-limits.json'), JSON.stringify({ accounts: {} }));
	writeFileSync(join(directory, 'dispatcharr.json'), JSON.stringify({ key: 'fixture-only' }));
	writeFileSync(join(directory, 'capabilities.json'), JSON.stringify({
		jellyfin: true, library: true, live: false, nonstop: false, vod: true, recordings: false,
		catchup: false, discover: false, comingSoon: false, introdb: false, subtitles: false
	}));
	writeFileSync(join(directory, 'activity.json'), JSON.stringify([]));
	const { app } = await import('../server.mjs');
	local.on('request', app);
	return {
		base: `http://127.0.0.1:${local.address().port}`, calls,
		close() { for (const server of servers) { server.closeAllConnections(); server.close(); } rmSync(directory, { recursive: true, force: true }); }
	};
}

async function targetFor(port) {
	for (let attempt = 0; attempt < 120; attempt += 1) {
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
	socket.onmessage = event => {
		const message = JSON.parse(event.data);
		if (!message.id || !pending.has(message.id)) return;
		const { resolve, reject } = pending.get(message.id);
		pending.delete(message.id);
		if (message.error) reject(new Error(JSON.stringify(message.error)));
		else resolve(message.result);
	};
	const send = (method, params = {}) => new Promise((resolve, reject) => {
		const messageId = ++id;
		pending.set(messageId, { resolve, reject });
		socket.send(JSON.stringify({ id: messageId, method, params }));
	});
	return { socket, send };
}

const fixture = await startFixture();
let chrome = null, profileDir = '', socket = null, send = null;
const evidence = { mode, slowItemMs: SLOW_ITEM_MS, startedAt: new Date().toISOString(), visits: {} };
try {
	profileDir = mkdtempSync(join(tmpdir(), 'tellybox-home-defer-141-chrome-'));
	chrome = spawn(chromePath, [
		'--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
		'--no-default-browser-check', '--disable-extensions',
		'--window-size=1440,900', '--remote-debugging-port=0',
		'--user-data-dir=' + profileDir, 'about:blank'
	], { stdio: 'ignore' });
	let port = 0;
	for (let attempt = 0; attempt < 120; attempt += 1) {
		const file = join(profileDir, 'DevToolsActivePort');
		if (existsSync(file)) {
			port = Number(readFileSync(file, 'utf8').split(/\r?\n/)[0]);
			if (port) break;
		}
		await sleep(100);
	}
	if (!port) throw new Error('Chrome did not open a DevTools port');
	const connection = await connect(await targetFor(port));
	send = connection.send; socket = connection.socket;
	await send('Page.enable');
	await send('Runtime.enable');
	await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });

	const evaluate = async expression => {
		const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
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
			try { last = await evaluate(expression); if (last) return last; } catch (error) { last = error.message; }
			await sleep(50);
		}
		throw new Error('Timed out waiting for ' + label + ' (last: ' + JSON.stringify(last) + ')');
	};

	// Browser-owned progress is the only evidence that makes Continue resolve the
	// exact episode through the slow single-item reader. Seed it before app.js.
	await send('Page.addScriptToEvaluateOnNewDocument', {
		source: `try { if (!localStorage.getItem('jimbo-progress-${episode.Id}')) localStorage.setItem('jimbo-progress-${episode.Id}', '240'); } catch (e) {}`
	});
	if (mode === 'today') {
		// The old client sent the same body without the opt-in flag. Remove it
		// before the request leaves the page; the server then takes its unchanged
		// complete-response path.
		await send('Page.addScriptToEvaluateOnNewDocument', {
			source: `(() => {
				const original = window.fetch.bind(window);
				window.fetch = (input, init) => {
					try {
						const url = typeof input === 'string' ? input : (input && (input.href || input.url)) || '';
						if (init && typeof init.body === 'string' && /\\/api\\/web\\/home$/.test(url)) {
							const body = JSON.parse(init.body);
							if (body && body.deferContinue === true) {
								delete body.deferContinue;
								init = { ...init, body: JSON.stringify(body) };
							}
						}
					} catch (e) {}
					return original(input, init);
				};
			})();`
		});
	}

	const visit = async (label, suffix) => {
		await send('Page.navigate', { url: fixture.base + '/?' + suffix });
		await waitFor(`document.querySelectorAll('#homeRows .home-row:not(.home-row--skeleton) .home-tile').length > 0`, 20000, label + ' first rows');
		const firstRowsMs = await evaluate('Math.round(performance.now())');
		let continueRowMs = null;
		try {
			await waitFor(`document.querySelectorAll('#homeRows .home-row--continue:not(.home-row--skeleton) .continue-card:not(.continue-card--skeleton)').length > 0`, 8000, label + ' Continue row');
			continueRowMs = await evaluate('Math.round(performance.now())');
		} catch { continueRowMs = null; }
		// Let the initial availability/artwork continuations issue their bounded
		// requests so the count describes the whole first screen.
		await sleep(2500);
		const resource = await evaluate(`(() => performance.getEntriesByType('resource')
			.filter(entry => entry.name.includes('/api/'))
			.map(entry => ({ name: new URL(entry.name).pathname, start: Math.round(entry.startTime), duration: Math.round(entry.duration) })))()`);
		const main = resource.filter(entry => entry.name === '/api/web/home');
		const continueRequest = resource.filter(entry => entry.name === '/api/web/home/continue');
		const artwork = resource.filter(entry => entry.name === '/api/web/home/artwork');
		const rowIds = await evaluate(`[...document.querySelectorAll('#homeRows .home-row')].map(row => (/home-row--([a-z0-9_-]+)/.exec(row.className) || [])[1] || '')`);
		const result = {
			firstRowsMs, continueRowMs, rowIds,
			homeMainRequests: main.length,
			continueRequests: continueRequest.length,
			artworkRequests: artwork.length,
			homeMainMs: main.length ? main[0].duration : null,
			continueMs: continueRequest.length ? continueRequest[0].duration : null,
			apiRequests: resource.length,
			homeRequests: main.length + continueRequest.length + artwork.length
		};
		evidence.visits[label] = result;
		await send('Page.captureScreenshot', { format: 'png' }).then(shot =>
			writeFileSync(join(outDir, 'home-defer-141-' + mode + '-' + label + '.png'), Buffer.from(shot.data, 'base64')));
		return result;
	};

	const cold = await visit('cold', 'cold=' + Date.now());
	await send('Page.navigate', { url: 'about:blank' });
	await sleep(250);
	const warm = await visit('warm', 'warm=' + Date.now());

	evidence.checks = [
		{ name: 'first rows painted', pass: Boolean(cold.firstRowsMs > 0 && warm.firstRowsMs > 0), detail: JSON.stringify({ cold: cold.firstRowsMs, warm: warm.firstRowsMs }) },
		{ name: 'Continue row eventually appeared', pass: Boolean(cold.continueRowMs && warm.continueRowMs), detail: JSON.stringify({ cold: cold.continueRowMs, warm: warm.continueRowMs }) }
	];
	if (mode === 'defer') {
		evidence.checks.push({ name: 'deferred rows beat Continue', pass: cold.firstRowsMs + 50 < cold.continueRowMs,
			detail: 'rows ' + cold.firstRowsMs + 'ms, continue ' + cold.continueRowMs + 'ms' });
		evidence.checks.push({ name: 'Continue used its own request', pass: cold.continueRequests >= 1,
			detail: 'continue requests=' + cold.continueRequests });
	} else {
		evidence.checks.push({ name: 'the complete response waited for the slow Continue read',
			pass: cold.firstRowsMs >= SLOW_ITEM_MS, detail: 'first rows ' + cold.firstRowsMs + 'ms' });
		evidence.checks.push({ name: 'no separate Continue request', pass: cold.continueRequests === 0,
			detail: 'continue requests=' + cold.continueRequests });
	}
} catch (error) {
	evidence.error = error.message;
} finally {
	evidence.fixture = { slowItemCalls: fixture.calls.slowItem };
	writeFileSync(join(outDir, 'home-defer-141-' + mode + '.json'), JSON.stringify(evidence, null, 2));
	try { socket?.close(); } catch {}
	try { chrome?.kill(); } catch {}
	await sleep(400);
	try { if (profileDir) rmSync(profileDir, { recursive: true, force: true, maxRetries: 5 }); } catch {}
	fixture.close();
}
console.log(JSON.stringify(evidence, null, 1));
const failed = (evidence.checks || []).filter(entry => !entry.pass);
process.exit(evidence.error || failed.length ? 1 : 0);
