/* RELEASE 132 real-browser evidence for Activity -> Streams.
 *
 * Serves the real app on 127.0.0.1, a fake loopback setup owner endpoint that
 * returns sanitized scenario payloads, and drives the real Activity page in
 * headless Chrome at desktop and mobile viewports. No production access.
 *
 *   $env:STREAM132_PROFILE='desktop'; node test/stream-monitor-132-browser.mjs
 *   $env:STREAM132_PROFILE='mobile';  node test/stream-monitor-132-browser.mjs
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

const profile = String(process.env.STREAM132_PROFILE || 'desktop').trim().toLowerCase();
const viewports = { desktop: { width: 1440, height: 900, mobile: false }, mobile: { width: 390, height: 844, mobile: true } };
const viewport = viewports[profile];
if (!viewport) { console.error('STREAM132_PROFILE must be desktop or mobile.'); process.exit(2); }
const outDir = process.env.EVIDENCE_DIR
	? process.env.EVIDENCE_DIR.replace(/[\\/]$/, '')
	: fileURLToPath(new URL('../../outputs/Tellybox-stream-monitor-132/evidence/browser/', import.meta.url));
mkdirSync(outDir, { recursive: true });

const chromePath = [
	process.env.CHROME_PATH,
	'C:/Program Files/Google/Chrome/Application/chrome.exe',
	'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
	'/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'
].filter(Boolean).find(candidate => existsSync(candidate));
if (!chromePath) { console.log('SKIP: Chrome not found.'); process.exit(0); }

const TOKEN = 'f'.repeat(64);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const liveRow = (index, overrides = {}) => ({
	kind: 'live', key: 'live:' + index, title: 'Channel ' + index, typeLabel: 'Live', state: 'running',
	provider: null, profile: 'Default', format: 'hls', codec: 'h264', resolution: '1920x1080', fps: 25,
	audio: 'aac 2ch', averageBitrateKbps: 4200 + index, bytes: 1000000, durationSeconds: 3600,
	connections: { reported: 1, shown: 1, truncated: false,
		items: [{ id: 'Connection 1', app: 'Chrome', format: 'mpegts', connectedAt: 1763450000000, durationSeconds: 120 }] },
	note: null, ...overrides
});
const scenarios = {
	zero: { state: 'ok', reported: { liveChannels: 0, liveClients: 0, vodConnections: 0, catchupConnections: 0 },
		streams: [], truncated: false, rowsReported: 0, rowsShown: 0 },
	one: { state: 'ok', reported: { liveChannels: 1, liveClients: 1, vodConnections: 0, catchupConnections: 0 },
		streams: [liveRow(1)], truncated: false, rowsReported: 1, rowsShown: 1 },
	multiple: { state: 'ok', reported: { liveChannels: 12, liveClients: 14, vodConnections: 2, catchupConnections: 1 },
		streams: [
			...Array.from({ length: 9 }, (_, index) => liveRow(index + 1)),
			liveRow(11, { connections: { reported: 14, shown: 10, truncated: true,
				items: Array.from({ length: 10 }, (_, i) => ({ id: 'Connection ' + (i + 1), app: 'Tellybox', format: 'mpegts', connectedAt: 1763450000000, durationSeconds: 60 })) } }),
			{ kind: 'vod', key: 'vod:1', title: 'A film', typeLabel: 'VOD', state: null,
				provider: 'Multiple providers', profile: 'Multiple profiles',
				format: null, codec: null, resolution: null, fps: null, audio: null, averageBitrateKbps: null, bytes: null,
				durationSeconds: 120, connections: { reported: 2, shown: 2, truncated: false, items: [
					{ id: 'Connection 1', app: 'Tellybox', provider: 'Provider A', profile: 'A', format: 'mpegts', connectedAt: 1763450000000, durationSeconds: 60 },
					{ id: 'Connection 2', app: 'Chrome', provider: 'Provider B', profile: 'B', format: 'mp4', connectedAt: 1763450100000, durationSeconds: 90 }
				] },
				note: 'VOD statistics do not report codec, resolution, bitrate or bytes in this response.' }
		], truncated: true, rowsReported: 12, rowsShown: 11 },
	unknown: { state: 'ok', reported: { liveChannels: 1, liveClients: null, vodConnections: null, catchupConnections: null },
		streams: [liveRow(1, { provider: null, profile: null, format: null, codec: null, resolution: null, fps: null, audio: null,
			averageBitrateKbps: null, bytes: null, durationSeconds: null,
			connections: { reported: null, shown: 0, truncated: false, items: [] } })],
		truncated: false, rowsReported: 1, rowsShown: 1 },
	stale: { state: 'stale', stale: true, reachable: false, notice: 'Dispatcharr could not be checked just now. Showing the last successful report.',
		reported: { liveChannels: 1, liveClients: 1, vodConnections: 0, catchupConnections: 0 },
		streams: [liveRow(1)], truncated: false, rowsReported: 1, rowsShown: 1 }
};

function setupServer() {
	return new Promise(resolve => {
		const server = http.createServer((req, res) => {
			const url = new URL(req.url, 'http://127.0.0.1');
			// The Activity page uses the loopback-only read-only report; the
			// owner route may still be present but is not needed here.
			if (!['/api/setup/dispatcharr/streams', '/api/setup/dispatcharr/streams/readonly'].includes(url.pathname)) {
				res.writeHead(404); return res.end('{}');
			}
			if (url.pathname === '/api/setup/dispatcharr/streams'
				&& !String(req.headers.cookie || '').includes('tellybox_setup=' + TOKEN)) {
				res.writeHead(401, { 'Content-Type': 'application/json' });
				return res.end(JSON.stringify({ error: 'Sign in to configure this installation.' }));
			}
			const name = String(server.scenario || 'one');
			const body = { configured: true, enabled: true, source: 'anotherServer', reachable: true,
				checkedAt: 1763450000000, upstreamAt: 1763450000000, stale: false, notice: 'Dispatcharr answered this monitoring check.',
				...scenarios[name] };
			res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
			res.end(JSON.stringify(body));
		});
		server.listen(0, '127.0.0.1', () => resolve(server));
	});
}

async function mainServer(setupPort, directory) {
	const servers = [];
	const listen = handler => new Promise(resolve => {
		const server = http.createServer(handler);
		server.listen(0, '127.0.0.1', () => { servers.push(server); resolve(server); });
	});
	const dead = await listen((req, res) => { res.writeHead(503); res.end('{}'); });
	const local = await listen(() => {});
	Object.assign(process.env, {
		NODE_ENV: 'test', AUTH_DIR: directory, DATA_DIR: directory, CATALOGUE_CACHE_DIR: directory,
		JELLYFIN_URL: 'http://127.0.0.1:' + dead.address().port, DISPATCHARR_URL: 'http://127.0.0.1:' + dead.address().port,
		PORT: String(local.address().port), SETUP_PORT: String(setupPort), LOCAL_HOSTS: '127.0.0.1',
		LOCAL_NETWORKS: '127.0.0.0/8', PUBLIC_ORIGIN: 'https://remote.test'
	});
	writeFileSync(join(directory, 'connection.json'), JSON.stringify({ userId: 'fixture', token: 'fixture-only' }));
	writeFileSync(join(directory, 'apps.json'), JSON.stringify({}));
	writeFileSync(join(directory, 'account-limits.json'), JSON.stringify({ accounts: {} }));
	writeFileSync(join(directory, 'dispatcharr.json'), JSON.stringify({ key: 'fixture-only' }));
	writeFileSync(join(directory, 'capabilities.json'), JSON.stringify({ jellyfin: true, library: true, live: false, nonstop: false,
		vod: true, recordings: false, catchup: false, discover: false, comingSoon: false, introdb: false, subtitles: false }));
	const { app } = await import('../server.mjs');
	local.on('request', app);
	return { base: 'http://127.0.0.1:' + local.address().port,
		close() { for (const server of servers) { server.closeAllConnections(); server.close(); } } };
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
async function connect(target) {
	const socket = new WebSocket(target.webSocketDebuggerUrl);
	await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
	let id = 0;
	const pending = new Map(), listeners = new Map();
	socket.onmessage = event => {
		const message = JSON.parse(event.data);
		if (message.id && pending.has(message.id)) {
			const { resolve, reject } = pending.get(message.id); pending.delete(message.id);
			if (message.error) reject(new Error(JSON.stringify(message.error))); else resolve(message.result);
		} else if (message.method) for (const listener of listeners.get(message.method) || []) listener(message.params);
	};
	const send = (method, params = {}) => new Promise((resolve, reject) => {
		const messageId = ++id; pending.set(messageId, { resolve, reject });
		socket.send(JSON.stringify({ id: messageId, method, params }));
	});
	return { socket, send };
}

const evidence = { profile, viewport, checks: [], scenarios: {}, screenshots: [] };
function check(name, pass, detail = '') {
	evidence.checks.push({ name, pass: Boolean(pass), detail });
	console.log((pass ? 'PASS ' : 'FAIL ') + name + (detail ? ' - ' + detail : ''));
}

const setup = await setupServer();
const directory = mkdtempSync(join(tmpdir(), 'tellybox-stream-132-'));
const main = await mainServer(setup.address().port, directory);
let chrome, profileDir = '', socket = null;
try {
	profileDir = mkdtempSync(join(tmpdir(), 'tellybox-stream-132-chrome-'));
	chrome = spawn(chromePath, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
		'--no-default-browser-check', '--disable-extensions', '--window-size=' + viewport.width + ',' + viewport.height,
		'--remote-debugging-port=0', '--user-data-dir=' + profileDir, 'about:blank'], { stdio: 'ignore' });
	let port = 0;
	for (let attempt = 0; attempt < 120; attempt += 1) {
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
			await sleep(100);
		}
		throw new Error('Timed out waiting for ' + label + ' (last: ' + JSON.stringify(last) + ')');
	};
	const shot = async name => {
		const image = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
		writeFileSync(join(outDir, name), Buffer.from(image.data, 'base64'));
		evidence.screenshots.push(name);
	};
	const read = () => evaluate(`(() => {
		const status = document.querySelector('#streamsStatus');
		const list = document.querySelector('#streamsList');
		const cards = [...(list?.querySelectorAll('.stream-entry') || [])];
		const vod = cards.find(card => /VOD/.test(card.textContent || ''));
		const firstTable = list?.querySelector('table');
		const vodTable = vod?.querySelector('table');
		return { state: status?.dataset.state || '', text: status?.textContent || '',
			cards: cards.length,
			firstCard: cards[0]?.textContent || '',
			vodText: vod?.textContent || '',
			tableHeaders: [...(firstTable?.querySelectorAll('th') || [])].map(th => th.textContent),
			vodTableHeaders: [...(vodTable?.querySelectorAll('th') || [])].map(th => th.textContent),
			tables: list?.querySelectorAll('table').length || 0,
			signIn: /Sign in as installation administrator/.test(document.body.textContent || '') };
	})()`);

	// The user asked for main-site monitoring: prove the Activity entry is
	// discoverable from Home, not only from Settings.
	setup.scenario = 'one';
	await send('Page.navigate', { url: main.base + '/' });
	await waitFor(`Boolean(document.querySelector('nav a[href="/activity"]'))`, 15000, 'Activity nav entry');
	await evaluate(`document.querySelector('nav a[href="/activity"]').click()`);
	await waitFor(`location.pathname === '/activity'`, 15000, 'Activity page');
	await waitFor(`Boolean(document.querySelector('#tabStreams'))`, 15000, 'Streams tab');
	await evaluate(`document.querySelector('#tabStreams').click()`);
	await waitFor(`document.querySelector('#streamsPanel') && !document.querySelector('#streamsPanel').hidden`, 15000, 'Streams panel from Home');
	await waitFor(`document.querySelector('#streamsStatus')?.dataset.state`, 15000, 'Streams data from Home');
	evidence.homeNavigation = await read();
	await shot('streams-132-' + profile + '-home-navigation.png');
	check('Activity is discoverable from Home navigation', evidence.homeNavigation.state === 'ok', JSON.stringify(evidence.homeNavigation).slice(0, 160));

	for (const name of ['zero', 'one', 'multiple', 'unknown', 'stale']) {
		setup.scenario = name;
		await send('Page.navigate', { url: main.base + '/activity?scenario=' + name + '&v=' + Date.now() + '#streams' });
		await waitFor(`document.querySelector('#streamsPanel') && !document.querySelector('#streamsPanel').hidden`, 15000, 'Streams panel');
		await waitFor(`document.querySelector('#streamsStatus')?.dataset.state`, 15000, 'Streams status');
		await waitFor(`document.querySelector('#streamsStatus').textContent.length > 10`, 15000, 'Streams text');
		await sleep(300);
		const state = await read();
		evidence.scenarios[name] = state;
		await shot('streams-132-' + profile + '-' + name + '.png');
		if (name === 'one' || name === 'multiple') {
			await evaluate(`(() => { const card = document.querySelector('#streamsList .stream-entry'); card?.scrollIntoView({ block: 'start' }); return true; })()`);
			await sleep(250);
			await shot('streams-132-' + profile + '-' + name + '-card.png');
			const full = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
			writeFileSync(join(outDir, 'streams-132-' + profile + '-' + name + '-full.png'), Buffer.from(full.data, 'base64'));
			evidence.screenshots.push('streams-132-' + profile + '-' + name + '-full.png');
		}
		check(name + ' renders', state.state === (name === 'stale' ? 'stale' : 'ok'), JSON.stringify(state).slice(0, 200));
		if (name === 'zero') check('zero says No connections reported', /No connections reported/.test(state.text) && !/all clear|healthy/i.test(state.text), state.text.slice(0, 120));
		if (name === 'one') check('one card with average bitrate and connections', state.cards === 1 && /Mbps avg/.test(state.firstCard) && state.tables >= 1, state.firstCard.slice(0, 200));
		if (name === 'multiple') check('multiple cards and compact truncation summary', state.cards >= 10 && /showing first/i.test(state.text), state.text.slice(0, 200));
		if (name === 'multiple') check('mixed VOD providers and per-connection labels are visible', /Multiple providers/.test(state.vodText) && /Provider A/.test(state.vodText) && /Provider B/.test(state.vodText) && state.vodTableHeaders.includes('Source') && state.vodTableHeaders.includes('Profile'), state.vodText.slice(0, 240));
		if (name === 'unknown') check('unknown values are omitted rather than filled with Not reported', !/Not reported/.test(state.firstCard) && /Channel 1/.test(state.firstCard), state.firstCard.slice(0, 160));
		if (name === 'stale') check('stale is distinct from idle', /last successful/i.test(state.text), state.text.slice(0, 160));
	}
	// No owner cookie: a local viewer still gets the read-only report, with no
	// administrator prompt and no locked teaser.
	await send('Network.clearBrowserCookies');
	setup.scenario = 'one';
	await send('Page.navigate', { url: main.base + '/activity?scenario=auth&v=' + Date.now() + '#streams' });
	await waitFor(`document.querySelector('#streamsStatus')?.dataset.state === 'ok'`, 15000, 'read-only streams');
	const signedOut = await read();
	evidence.scenarios.auth = signedOut;
	await shot('streams-132-' + profile + '-auth.png');
	check('no owner session still shows read-only streams without a prompt', !signedOut.signIn && signedOut.cards === 1, JSON.stringify(signedOut).slice(0, 200));
} catch (error) {
	check('browser run completed', false, error.message);
} finally {
	writeFileSync(join(outDir, 'streams-132-' + profile + '.json'), JSON.stringify(evidence, null, 2));
	try { socket?.close(); } catch {}
	try { chrome?.kill(); } catch {}
	await sleep(400);
	try { rmSync(profileDir, { recursive: true, force: true, maxRetries: 5 }); } catch {}
	main.close(); setup.close(); rmSync(directory, { recursive: true, force: true });
}
const failed = evidence.checks.filter(entry => !entry.pass);
console.log(JSON.stringify({ profile, checks: evidence.checks.length, failed: failed.length }, null, 1));
process.exit(failed.length ? 1 : 0);
