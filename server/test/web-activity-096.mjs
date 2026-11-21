/* Browser regression for Activity 096. Serves the real public files and a
 * deterministic /api/activity snapshot, then checks the desktop five-column
 * row, mobile wrapping, long names, unknown devices, expandable diagnostics
 * and the shared Settings overview. */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const publicDirectory = fileURLToPath(new URL('../public/', import.meta.url));
const outDir = fileURLToPath(new URL('../../outputs/Tellybox-activity-096/evidence/', import.meta.url));
mkdirSync(outDir, { recursive: true });

const chromePath = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe',
	'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
	'/usr/bin/chromium', '/usr/bin/chromium-browser'].filter(Boolean).find(candidate => existsSync(candidate));
if (!chromePath) { console.log('SKIP: Chrome or Chromium was not found. Set CHROME_PATH.'); process.exit(0); }

const now = Date.now();
const longName = 'Alexandra Montgomery-Featherstonehaugh the Third';
const longTitle = 'The Extraordinarily Long Episode Title That Must Wrap Instead of Widening the Whole Page or Hiding the Badges';
const unknownAgents = ['', 'Roku/DVP-9.10 (519.10E04111A)', 'Some television box that does not identify itself'];
const devices = ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0 Safari/537.36',
	'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1',
	'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/120.0 Mobile Safari/537.36',
	'Mozilla/5.0 (SMART-TV; Linux; Tizen 6.0) AppleWebKit/537.36 SamsungBrowser/4.0',
	'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/119.0 Safari/537.36'];
const recent = Array.from({ length: 50 }, (_, index) => ({
	id: 'event-' + index,
	type: index % 9 === 0 ? 'login_success' : index % 7 === 0 ? 'login_failed' : 'playback',
	time: now - index * 60000,
	title: index % 4 === 0 ? longTitle : 'Episode ' + (index + 1),
	state: index % 9 === 0 || index % 7 === 0 ? '' : 'ended',
	position: 540 + index,
	personId: index % 3 === 0 ? 'a'.repeat(32) : '',
	personName: index % 3 === 0 ? longName : '',
	local: index % 2 === 0,
	home: index % 2 === 0,
	mediaRoute: index % 2 === 0 ? 'local' : index % 3 === 0 ? 'relay' : 'remote',
	ip: '192.0.2.' + (index + 1),
	browser: index % 5 === 0 ? unknownAgents[index % unknownAgents.length] : devices[index % devices.length],
	reason: index % 7 === 0 && index % 9 !== 0 ? 'Incorrect password' : '',
	email: index % 9 === 0 ? 'alex@example.test' : index % 7 === 0 ? 'person@example.test' : ''
}));
const users = [
	{ id: 'person:' + 'a'.repeat(32), name: longName, seconds: 5400, minutes: 90, dailySeconds: 1800, dailyMinutes: 30, dailyLimitSeconds: 7200, dailyTimezone: 'Europe/London', dailyDay: '2026-11-08', lastLogin: now - 3600000 },
	{ id: 'local', name: 'Local', seconds: 600, minutes: 10, dailySeconds: null, dailyMinutes: null, dailyLimitSeconds: null, dailyTimezone: null, dailyDay: null, lastLogin: null }
];
const snapshot = {
	active: [
		{ id: 's1', title: longTitle, state: 'playing', position: 1800, duration: 3600, updated: now - 8000,
			personName: longName, personId: 'a'.repeat(32), local: true, home: true, mediaRoute: 'local',
			browser: devices[0], ip: '192.168.0.20', method: 'DirectPlay', remoteMbps: 0 },
		{ id: 's2', title: 'Remote television', state: 'buffering', position: 120, duration: 2400, updated: now - 4000,
			local: false, mediaRoute: 'relay', browser: devices[3], ip: '198.51.100.7', mediaIp: '203.0.113.9', method: 'Relay', remoteMbps: 4.2 },
		{ id: 's3', title: 'Unknown device stream', state: 'paused', position: 60, duration: 0, updated: now - 20000,
			local: false, mediaRoute: 'remote', browser: '', ip: '198.51.100.8' }
	],
	downloads: [],
	recent,
	browsers: [
		{ id: 'b1', ip: '198.51.100.4', browser: devices[1], created: now - 86400000, expires: now + 86400000, personName: '' },
		{ id: 'b2', ip: '192.168.0.9', browser: devices[3], created: now - 172800000, lastSeen: now - 120000, localBrowser: true, personName: longName }
	],
	stats: { active: 3, plays: 27, remoteIps: 4, failed: 2 },
	bandwidth: { measuredMbps: 6.4, mbps: 50, activeTransfers: 2 },
	viewing: { since: now - 86400000 * 12, users },
	page: { limit: 50, offset: 0, total: 137, hasMore: true, windowDays: 30, retentionDays: 30 },
	facets: {
		users: [{ id: 'person:' + 'a'.repeat(32), name: longName }, { id: 'local', name: 'Local access' }],
		devices: [{ id: 'browser:b1', name: 'iPhone' }, { id: 'browser:b2', name: 'TV' }]
	},
	historySince: now - 86400000 * 30,
	lastLogins: {}
};

const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png' };
const server = createServer((request, response) => {
	const url = new URL(request.url, 'http://127.0.0.1');
	if (url.pathname === '/api/activity') {
		response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
		response.end(JSON.stringify({ ...snapshot, page: { ...snapshot.page, offset: Number(url.searchParams.get('offset')) || 0, limit: Number(url.searchParams.get('limit')) || 50 } }));
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

const profile = mkdtempSync(join(tmpdir(), 'tellybox-activity-096-'));
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
		await waitFor("document.querySelectorAll('#stats .activity-stat').length === 5 && document.querySelectorAll('#history .activity-entry').length > 0", 'activity page');
		await sleep(250);
		const layout = await evaluate(`(() => {
			const rect = node => { const r = node.getBoundingClientRect(); return { top: Math.round(r.top), left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width), height: Math.round(r.height) }; };
			const cards = [...document.querySelectorAll('#stats .activity-stat')].map(rect);
			const grid = document.querySelector('#stats');
			const entries = [...document.querySelectorAll('#history .activity-entry')].map(node => ({ rect: rect(node), overflow: node.scrollWidth - node.clientWidth }));
			const titles = [...document.querySelectorAll('#history .activity-entry-title')].map(node => ({ rect: rect(node), text: node.textContent }));
			const watching = [...document.querySelectorAll('#watching .activity-entry')].map(rect);
			return {
				cards, watching,
				columns: getComputedStyle(grid).gridTemplateColumns.split(' ').length,
				pageOverflow: document.documentElement.scrollWidth - window.innerWidth,
				bodyOverflow: document.body.scrollWidth - window.innerWidth,
				entryOverflow: Math.max(0, ...entries.map(entry => entry.overflow)),
				entryCount: entries.length,
				firstEntryRight: entries[0]?.rect.right,
				titleWrapped: titles.some(title => title.rect.height > 24),
				titleOverflow: Math.max(0, ...titles.map(title => title.rect.right - (entries[titles.indexOf(title)]?.rect.right || 0))),
				detailsOpen: [...document.querySelectorAll('#history details')].some(details => details.open),
				detailControls: document.querySelectorAll('#history details summary').length,
				icons: document.querySelectorAll('.device-icon').length,
				ariaLabels: document.querySelectorAll('#watching [aria-label], #history [aria-label]').length,
				unknownIcons: document.querySelectorAll('.device-icon.is-unknown').length,
				statsText: [...document.querySelectorAll('#stats .activity-stat')].map(card => card.textContent),
				totalsText: document.querySelector('#viewingTotals')?.textContent || '',
				browsersText: document.querySelector('#browsers')?.textContent || '',
				filters: ['#filter', '#userFilter', '#deviceFilter', '#dateFilter', '#ipFilter'].every(selector => Boolean(document.querySelector(selector))),
				paging: document.querySelector('#historyNext')?.disabled === false
			};
		})()`);
		// Capture the overview from the top, then prove the diagnostics are usable.
		await evaluate('window.scrollTo(0, 0); true');
		await sleep(120);
		await screenshot('activity-' + viewport.name + '.png');
		await evaluate(`(() => { const summary = document.querySelector('#history details summary'); if (summary) { summary.click(); summary.focus(); } return true; })()`);
		await sleep(120);
		layout.expanded = await evaluate("Boolean(document.querySelector('#history details[open]'))");
		layout.expandedHeight = await evaluate("document.querySelector('#history details[open]')?.getBoundingClientRect().height || 0");
		await evaluate("document.querySelector('#history details[open]')?.scrollIntoView({ block: 'center' }); true");
		await sleep(120);
		await screenshot('activity-' + viewport.name + '-details.png');
		if (viewport.name === 'desktop') {
			await evaluate("document.querySelector('#totalsHeading').scrollIntoView({ block: 'start' }); true");
			await sleep(120);
			await screenshot('activity-desktop-totals.png');
			await evaluate("document.querySelector('#browsersHeading').scrollIntoView({ block: 'start' }); true");
			await sleep(120);
			await screenshot('activity-desktop-browsers.png');
		}
		results.push({ viewport, layout });
	}

	// Settings Watching overview must render the same five metric values.
	await send('Emulation.setDeviceMetricsOverride', { width: 1180, height: 900, deviceScaleFactor: 1, mobile: false });
	await send('Page.navigate', { url: origin + '/settings#activity' });
	await waitFor("(() => { const panel = document.querySelector('[data-settings=\"watching\"]'); return Boolean(panel && !panel.hidden && document.querySelectorAll('#settingsActivityStats .activity-stat').length === 5); })()", 'settings overview');
	await sleep(300);
	const settings = await evaluate(`(() => {
		const rect = node => { const r = node.getBoundingClientRect(); return { top: Math.round(r.top), width: Math.round(r.width), right: Math.round(r.right) }; };
		const cards = [...document.querySelectorAll('#settingsActivityStats .activity-stat')].map(rect);
		return {
			cards,
			values: [...document.querySelectorAll('#settingsActivityStats .activity-stat')].map(card => card.textContent),
			watching: document.querySelectorAll('#settingsWatchingNow .activity-entry').length,
			identity: Boolean(document.querySelector('#settingsWatchingNow .identity-account')),
			icons: document.querySelectorAll('#settingsWatchingNow .device-icon').length,
			pageOverflow: document.documentElement.scrollWidth - window.innerWidth
		};
	})()`);
	await screenshot('settings-watching-desktop.png');
	await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
	await sleep(250);
	const settingsMobile = await evaluate(`(() => ({ pageOverflow: document.documentElement.scrollWidth - window.innerWidth,
		columns: getComputedStyle(document.querySelector('#settingsActivityStats')).gridTemplateColumns.split(' ').length }))()`);
	await screenshot('settings-watching-mobile.png');
	results.push({ viewport: { name: 'settings', width: 1180, height: 900 }, settings, settingsMobile });

	let ready = true;
	for (const row of results.filter(entry => entry.layout)) {
		const { layout, viewport } = row;
		if (viewport.name === 'desktop') {
			if (layout.cards.length !== 5) ready = false;
			if (Math.max(...layout.cards.map(card => card.top)) - Math.min(...layout.cards.map(card => card.top)) > 1) ready = false;
			if (Math.max(...layout.cards.map(card => card.width)) - Math.min(...layout.cards.map(card => card.width)) > 1) ready = false;
			if (layout.columns !== 5) ready = false;
		} else if (layout.columns < 2 || layout.columns > 3) ready = false;
		if (layout.pageOverflow > 1 || layout.bodyOverflow > 1) ready = false;
		if (layout.entryOverflow > 1) ready = false;
		if (!layout.filters || !layout.paging) ready = false;
		if (!/Europe\/London/.test(layout.totalsText) || !/Last successful sign-in/.test(layout.totalsText)) ready = false;
		if (!/Not recorded/.test(layout.browsersText)) ready = false;
		if (viewport.name === 'mobile' && !layout.titleWrapped) ready = false;
		if (layout.detailsOpen) ready = false;
		if (layout.detailControls !== layout.entryCount) ready = false;
		if (layout.icons < 3 || layout.unknownIcons < 1) ready = false;
		if (layout.ariaLabels < 4) ready = false;
		if (!layout.expanded || !(layout.expandedHeight > 0)) ready = false;
	}
	const settingsRow = results.find(entry => entry.settings);
	if (!settingsRow) ready = false;
	else {
		if (settingsRow.settings.cards.length !== 5) ready = false;
		if (settingsRow.settings.watching < 1 || !settingsRow.settings.identity) ready = false;
		const desktopRow = results.find(entry => entry.viewport.name === 'desktop');
		if (!desktopRow || JSON.stringify(settingsRow.settings.values) !== JSON.stringify(desktopRow.layout.statsText)) ready = false;
		if (!desktopRow || settingsRow.settings.watching !== desktopRow.layout.watching.length) ready = false;
		if (settingsRow.settings.pageOverflow > 1) ready = false;
		if (Math.max(...settingsRow.settings.cards.map(card => card.top)) - Math.min(...settingsRow.settings.cards.map(card => card.top)) > 1) ready = false;
		if (settingsRow.settingsMobile.pageOverflow > 1) ready = false;
		if (settingsRow.settingsMobile.columns > 3) ready = false;
	}

	const report = { ready, results };
	writeFileSync(join(outDir, 'BROWSER-ACTIVITY-096.json'), JSON.stringify(report, null, 2) + '\n');
	writeFileSync(join(outDir, 'BROWSER-ACTIVITY-096.txt'), JSON.stringify(report, null, 2) + '\n');
	console.log(JSON.stringify(report, null, 2));
	process.exitCode = ready ? 0 : 1;
} finally {
	child.kill();
	await sleep(800);
	try { rmSync(profile, { recursive: true, force: true }); } catch {}
	server.closeAllConnections();
	server.close();
}
