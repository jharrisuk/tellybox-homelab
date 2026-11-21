/* Browser regression for release 098 Activity/Logs tabs.
 * Serves the real public files and a deterministic activity snapshot with
 * mixed/unknown browser sign-in dates. Verifies desktop and mobile tab
 * visibility, default Activity preview, Logs filters/history, keyboard tab
 * switching, and that the correctly sorted browser row is the one revoked. */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const publicDirectory = fileURLToPath(new URL('../public/', import.meta.url));
const outDir = fileURLToPath(new URL('../../outputs/Tellybox-browser-signout-098/evidence/', import.meta.url));
mkdirSync(outDir, { recursive: true });
const chromePath = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe',
	'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
	'/usr/bin/chromium', '/usr/bin/chromium-browser'].filter(Boolean).find(candidate => existsSync(candidate));
if (!chromePath) { console.log('SKIP: Chrome or Chromium was not found. Set CHROME_PATH.'); process.exit(0); }

const now = Date.now();
const recent = Array.from({ length: 12 }, (_, index) => ({
	id: 'event-' + index, type: index === 2 ? 'login_success' : 'playback', time: now - index * 60000,
	title: 'Event ' + (index + 1), state: index === 2 ? '' : 'ended', position: 60 + index,
	personName: index % 3 === 0 ? 'Alice' : '', local: index % 2 === 0,
	browser: 'Mozilla/5.0 (Windows NT 10.0)', ip: '192.0.2.' + (index + 1)
}));
let browsers = [
	{ id: 'b-old', personName: 'Old browser', browser: 'Mozilla/5.0 (Windows NT 10.0)', created: now - 3 * 3600000, localBrowser: false },
	{ id: 'b-unknown', personName: 'Unknown date', browser: 'Mozilla/5.0 (Windows NT 10.0)', localBrowser: false },
	{ id: 'b-tie1', personName: 'Tie one', browser: 'Mozilla/5.0 (Windows NT 10.0)', created: now - 2 * 3600000, localBrowser: false },
	{ id: 'b-new', personName: 'Newest browser', browser: 'Mozilla/5.0 (Windows NT 10.0)', created: now - 3600000, localBrowser: false },
	{ id: 'b-tie2', personName: 'Tie two', browser: 'Mozilla/5.0 (Windows NT 10.0)', created: now - 2 * 3600000, localBrowser: false }
];
const revoked = [];
const snapshot = () => ({
	active: [], downloads: [], recent,
	browsers,
	stats: { active: 0, plays: 3, remoteIps: 1, failed: 1 }, bandwidth: null,
	viewing: { since: now, users: [] },
	page: { limit: 50, offset: 0, total: recent.length, hasMore: false, retentionDays: 30 },
	facets: { users: [{ id: 'person:alice', name: 'Alice' }], devices: [{ id: 'browser:b-new', name: 'Desktop web' }] },
	historySince: now - 86400000, lastLogins: {}
});
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };
const server = createServer(async (request, response) => {
	const url = new URL(request.url, 'http://127.0.0.1');
	if (url.pathname === '/api/activity') {
		response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
		response.end(JSON.stringify(snapshot()));
		return;
	}
	if (url.pathname === '/api/auth/revoke-browser') {
		let body = '';
		for await (const chunk of request) body += chunk;
		const id = JSON.parse(body || '{}').id;
		revoked.push(id);
		browsers = browsers.filter(browser => browser.id !== id);
		response.writeHead(200, { 'Content-Type': 'application/json' });
		response.end('{"ok":true}');
		return;
	}
	if (url.pathname.startsWith('/api/')) {
		response.writeHead(200, { 'Content-Type': 'application/json' }); response.end('{}'); return;
	}
	if (url.pathname === '/settings') {
		response.writeHead(200, { 'Content-Type': types['.html'] });
		response.end(readFileSync(join(publicDirectory, 'settings.html'))); return;
	}
	if (url.pathname === '/') {
		response.writeHead(200, { 'Content-Type': types['.html'] });
		response.end(readFileSync(join(publicDirectory, 'activity.html'))); return;
	}
	const file = normalize(join(publicDirectory, decodeURIComponent(url.pathname)));
	if (!file.startsWith(publicDirectory) || !existsSync(file)) { response.writeHead(404); response.end('not found'); return; }
	response.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream' });
	response.end(readFileSync(file));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function targetFor(port) {
	for (let i = 0; i < 100; i++) {
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

const profile = mkdtempSync(join(tmpdir(), 'tellybox-activity-tabs-098-'));
const child = spawn(chromePath, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
	'--no-default-browser-check', '--disable-extensions', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'],
	{ stdio: 'ignore' });
const results = [];
try {
	let port = 0;
	for (let i = 0; i < 100; i++) {
		const file = join(profile, 'DevToolsActivePort');
		if (existsSync(file)) { port = Number(readFileSync(file, 'utf8').split(/\r?\n/)[0]); if (port) break; }
		await sleep(100);
	}
	if (!port) throw new Error('Chrome did not open a DevTools port');
	const { send } = await connect(await targetFor(port));
	await send('Page.enable'); await send('Runtime.enable');
	async function evaluate(expression) {
		const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
		if (result.exceptionDetails) throw new Error(result.exceptionDetails.text + ' ' + JSON.stringify(result.exceptionDetails.exception));
		return result.result.value;
	}
	async function waitFor(expression, label) {
		for (let i = 0; i < 120; i++) {
			if (await evaluate(expression)) return;
			await sleep(100);
		}
		throw new Error('Timed out waiting for ' + label);
	}
	async function screenshot(name) {
		const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
		writeFileSync(join(outDir, name), Buffer.from(shot.data, 'base64'));
	}

	for (const viewport of [{ name: 'desktop', width: 1180, height: 900, mobile: false }, { name: 'mobile', width: 390, height: 844, mobile: true }]) {
		await send('Emulation.setDeviceMetricsOverride', { width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: viewport.mobile });
		await send('Page.navigate', { url: origin + '/' });
		await waitFor("document.querySelectorAll('#stats .activity-stat').length === 5 && document.querySelectorAll('#recentPreview .activity-entry').length === 5 && document.querySelectorAll('#browsers button').length === 5", 'activity tabs');
		await sleep(150);
		const layout = await evaluate(`(() => {
			const tablist = document.querySelector('.activity-tabs');
			const tabs = [...document.querySelectorAll('.activity-tab')];
			const preview = document.querySelectorAll('#recentPreview .activity-entry');
			const history = document.querySelectorAll('#history .activity-entry');
			const browserRows = [...document.querySelectorAll('#browsers tbody tr')];
			return {
				tablistRole: tablist.getAttribute('role'),
				tablistVisible: tablist.getBoundingClientRect().height > 0,
				tabs: tabs.map(tab => ({ text: tab.textContent, selected: tab.getAttribute('aria-selected'), visible: tab.getBoundingClientRect().height > 0 })),
				activityHidden: document.querySelector('#activityPanel').hidden,
				logsHidden: document.querySelector('#logsPanel').hidden,
				previewCount: preview.length,
				previewHasDetails: Boolean(document.querySelector('#recentPreview details')),
				previewText: document.querySelector('#recentPreview').textContent,
				historyCount: history.length,
				historyHasDetails: document.querySelectorAll('#history details').length,
				browserIds: browserRows.map(row => row.getAttribute('data-browser-id')),
				browserText: browserRows.map(row => row.textContent),
				filterVisible: document.querySelector('#filter').getBoundingClientRect().width > 0,
				pageOverflow: document.documentElement.scrollWidth - window.innerWidth
			};
		})()`);
		await screenshot('activity-tabs-098-' + viewport.name + '.png');

		await evaluate("document.querySelector('#tabLogs').click(); true");
		await sleep(150);
		const logs = await evaluate(`(() => ({
			selected: document.querySelector('#tabLogs').getAttribute('aria-selected'),
			activityHidden: document.querySelector('#activityPanel').hidden,
			logsHidden: document.querySelector('#logsPanel').hidden,
			filtersVisible: document.querySelector('#filter').getBoundingClientRect().width > 0,
			historyCount: document.querySelectorAll('#history .activity-entry').length,
			detailsClosed: ![...document.querySelectorAll('#history details')].some(details => details.open),
			tabVisible: document.querySelector('#tabLogs').getBoundingClientRect().height > 0,
			pageOverflow: document.documentElement.scrollWidth - window.innerWidth
		}))()`);
		await screenshot('activity-logs-098-' + viewport.name + '.png');

		// Keyboard: focus Activity and move right into Logs.
		await evaluate("document.querySelector('#tabActivity').focus(); true");
		const keyboard = await evaluate(`(() => {
			const tab = document.querySelector('#tabActivity');
			tab.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
			return { selected: document.querySelector('#tabLogs').getAttribute('aria-selected'), focused: document.activeElement === document.querySelector('#tabLogs') };
		})()`);

		// Refresh must keep the selected tab, filter and focus.
		await evaluate("document.querySelector('#filter').value = 'login'; document.querySelector('#filter').focus(); true");
		const refresh = await evaluate(`(async () => {
			if (typeof refresh === 'function') await refresh();
			return {
				selected: document.querySelector('#tabLogs').getAttribute('aria-selected'),
				filter: document.querySelector('#filter').value,
				logsHidden: document.querySelector('#logsPanel').hidden,
				focused: document.activeElement === document.querySelector('#filter')
			};
		})()`);
		results.push({ viewport, layout, logs, keyboard, refresh });
	}

	// Click the middle row after newest-first sorting. It must revoke only that id.
	await send('Emulation.setDeviceMetricsOverride', { width: 1180, height: 900, deviceScaleFactor: 1, mobile: false });
	await send('Page.navigate', { url: origin + '/' });
	await waitFor("document.querySelectorAll('#browsers button').length === 5", 'sorted browsers');
	const before = await evaluate("[...document.querySelectorAll('#browsers tbody tr')].map(row => row.getAttribute('data-browser-id'))");
	await evaluate("document.querySelectorAll('#browsers button')[1].click(); true");
	await waitFor("document.querySelectorAll('#browsers button').length === 4", 'target browser removal');
	const after = await evaluate("[...document.querySelectorAll('#browsers tbody tr')].map(row => row.getAttribute('data-browser-id'))");
	results.push({ revoke: { before, after, revoked } });

	let ready = true;
	for (const row of results.filter(entry => entry.layout)) {
		if (row.layout.tablistRole !== 'tablist' || !row.layout.tablistVisible) ready = false;
		if (row.layout.tabs.length !== 4 || !row.layout.tabs.every(tab => tab.visible)) ready = false;
		if (row.layout.tabs[0].selected !== 'true' || row.layout.tabs[1].selected !== 'false') ready = false;
		if (row.layout.activityHidden || !row.layout.logsHidden) ready = false;
		if (row.layout.previewCount !== 5 || row.layout.previewHasDetails) ready = false;
		if (row.layout.historyCount !== 12 || row.layout.historyHasDetails !== 12) ready = false;
		if (row.layout.pageOverflow > 1 || row.layout.filterVisible) ready = false;
		if (row.logs.selected !== 'true' || !row.logs.activityHidden || row.logs.logsHidden) ready = false;
		if (!row.logs.filtersVisible || row.logs.historyCount !== 12 || !row.logs.detailsClosed || !row.logs.tabVisible) ready = false;
		if (row.logs.pageOverflow > 1) ready = false;
		if (!row.keyboard.selected || !row.keyboard.focused) ready = false;
		if (row.refresh.selected !== 'true' || row.refresh.filter !== 'login' || row.refresh.logsHidden || !row.refresh.focused) ready = false;
	}
	const revoke = results.find(entry => entry.revoke)?.revoke;
	if (!revoke) ready = false;
	else {
		const expectedBefore = ['b-new', 'b-tie1', 'b-tie2', 'b-old', 'b-unknown'];
		if (JSON.stringify(revoke.before) !== JSON.stringify(expectedBefore)) ready = false;
		if (revoke.revoked[0] !== 'b-tie1') ready = false;
		if (JSON.stringify(revoke.after) !== JSON.stringify(['b-new', 'b-tie2', 'b-old', 'b-unknown'])) ready = false;
	}

	const report = { ready, results };
	writeFileSync(join(outDir, 'BROWSER-ACTIVITY-TABS-098.json'), JSON.stringify(report, null, 2) + '\n');
	console.log(JSON.stringify(report, null, 2));
	process.exitCode = ready ? 0 : 1;
} finally {
	child.kill();
	await sleep(800);
	try { rmSync(profile, { recursive: true, force: true }); } catch {}
	server.closeAllConnections();
	server.close();
}
