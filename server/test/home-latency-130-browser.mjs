/* HOME-LATENCY-130 browser evidence.
 *
 * Drives the real server/public app in headless Chrome against a loopback
 * fixture: real server.mjs, real Home route, fake Jellyfin/Dispatcharr/Seerr.
 * Nothing in the page is mocked and no provider, credential or production
 * request is used.
 *
 * One profile per process:
 *   cd server
 *   $env:HOME130_PROFILE='desktop'; node test/home-latency-130-browser.mjs
 *   $env:HOME130_PROFILE='mobile';  node test/home-latency-130-browser.mjs
 *
 * It records the real /api/web/home durations the browser observed for a cold
 * visit, a warm reload, and a reload while one streamed series' provider
 * episode lookup takes 4 s. It also reads the New-episodes rail and records
 * each card's image source and decoded size. The fixture's streamed series has
 * a warm TMDB poster, so the rail must point at the same poster route the Home
 * series cards use instead of the provider route that answered 404 live.
 *
 * If Chrome is unavailable the script prints SKIP and exits 0. A failing
 * assertion exits non-zero.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { release, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

const profileName = String(process.env.HOME130_PROFILE || 'desktop').trim().toLowerCase();
const VIEWPORTS = {
	desktop: { width: 1440, height: 900, mobile: false },
	mobile: { width: 390, height: 844, mobile: true }
};
const viewport = VIEWPORTS[profileName];
if (!viewport) {
	console.error('HOME130_PROFILE must be desktop or mobile.');
	process.exit(2);
}
const outDir = process.env.EVIDENCE_DIR
	? process.env.EVIDENCE_DIR.replace(/[\\/]$/, '')
	: fileURLToPath(new URL('../../outputs/Tellybox-home-latency-130/evidence/', import.meta.url));
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
	console.log('SKIP: Chrome or Chromium was not found. Set CHROME_PATH to run the HOME-LATENCY-130 browser check.');
	process.exit(0);
}

const NOW = '2026-11-18T12:00:00Z';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAADwAAABaCAYAAADkUTU1AAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAHySURBVHhe5cOJTw0AAMfx3x9jTPJSUkpe9+t8HU+vlA5dr+t1X4sW0UKOVotWa5EjRKIZM8bMjBnjP/r5Q76f7aMDmQkm1cGsIybVoWCiSXU4+6hJlZAbMKkS8wMmVaAwyaRKCh0zqZKLk02qlJIUkyq17LhJlRZONanSK06YVBlVaSZVZiTNpMqqSTepgtGTJlV2XYZJlVufaVLlNZwyqQoas0yqUPNpk6qoJWhSlbQGTarS9myTqrwjx6SqiOWYVJXduSZVdW+eSRXpyzepavoLTKrawUKTqm6o0KSqHwmZVA2jRSZV43ixSdU8WWJStUyVmlStF8tMqrbpcpOqYyZsUsUuh02qrtkKk6rnaqVJ1TtXZVLF56tNqoHrEZNqcOGMSTV8s8akGrkdNanGFqMm1cRSrUk1uVxnUk2tnDWpLtytN6mmVxtMqpm1cybVpfVGk2p2o8mkurLZZFLNPWg2qea3Wkyqa4/Om1Q3nrSaVAvbbSbVrWftJtWdnQ6TavFFp0m1tNtpUi3vxUyqldddJtW9/S6TavVtt0m19q7HpFp/32tSbXzoM6k2P8ZNqvuf4ibV1ud+k+rhlwGT6vHXQZNq+9uQSfX0+7BJ9fzHiEm183PUpHr5a8ykevV7zKTa+zNuUr35O2FS7f+bNOl/7Ul9rpLjPJQAAAAASUVORK5CYII=', 'base64');

// The one streamed show whose parent poster is already warm from Seerr/TMDB.
// The poster path is a real TMDB path so the server's existing /api/web/tmdb-art
// route (which the live probe answered 200 image/jpeg) resolves real bytes.
const STREAMED = { id: 8301, tmdb: 155, name: 'Warm poster show', posterPath: '/qJ2tW6WMUDux911r6m7haRef0WH.jpg' };
const OTHER_STREAMED = [8302, 8303, 8304].map((id, index) => ({ id, name: 'Library show ' + (index + 1), created_at: NOW }));
// Streamed duplicates that merge into the two local shows by TMDB identity.
// Their provider detail has no logo/TMDB id, so /api/web/art/series/<id> 404s,
// exactly like the three live Slow Horses / Stanford / Apocalypse aliases.
const CONTINUE_ALIAS = { id: 8398, tmdb: 1111, name: 'Local show', noProviderArt: true };
const EPISODE_ALIAS = { id: 8399, tmdb: 1112, name: 'Quiet local show', noProviderArt: true };
const localSeries = {
	Id: 'a'.repeat(31) + '1', Name: 'Local show', Type: 'Series', Genres: ['Drama'],
	ProviderIds: { Tmdb: '1111' }, DateCreated: NOW, ChildCount: 2,
	ImageTags: { Primary: 'local-series-primary' }, BackdropImageTags: ['local-series-backdrop'],
	UserData: { Played: false, UnplayedItemCount: 2 }
};
const localSeriesTwo = {
	Id: 'a'.repeat(31) + '2', Name: 'Quiet local show', Type: 'Series', Genres: ['Comedy'],
	ProviderIds: { Tmdb: '1112' }, DateCreated: NOW, ChildCount: 1,
	ImageTags: { Primary: 'quiet-series-primary' }, UserData: { Played: false, UnplayedItemCount: 1 }
};
const localEpisodes = [1, 2].map(number => ({
	Id: ('b' + String(number).padStart(31, '0')).slice(0, 32), Name: 'Local episode ' + number, Type: 'Episode',
	SeriesId: localSeries.Id, SeriesName: localSeries.Name, ParentIndexNumber: 1, IndexNumber: number,
	PremiereDate: '2026-11-0' + number, RunTimeTicks: 2400e7, UserData: { Played: false }
}));
const localEpisodeTwo = {
	Id: ('c' + '9'.repeat(31)).slice(0, 32), Name: 'Quiet local episode', Type: 'Episode',
	SeriesId: localSeriesTwo.Id, SeriesName: localSeriesTwo.Name, ParentIndexNumber: 1, IndexNumber: 1,
	PremiereDate: '2026-11-03', RunTimeTicks: 2400e7, UserData: { Played: false }
};

async function startFixture() {
	const directory = mkdtempSync(join(tmpdir(), 'tellybox-home-130-browser-'));
	const servers = [];
	const listen = handler => new Promise(resolve => {
		const server = http.createServer(handler);
		server.listen(0, '127.0.0.1', () => { servers.push(server); resolve(server); });
	});
	const delays = new Map();
	const calls = { providerEpisodes: 0, homeImages: 0 };
	let brokenBackdrop = false;
	const jellyfin = await listen((req, res) => {
		const url = new URL(req.url, 'http://127.0.0.1');
		if (/\/Images\/(Primary|Backdrop)$/i.test(url.pathname)) {
			calls.homeImages += 1;
			if (brokenBackdrop && /\/Images\/Backdrop$/i.test(url.pathname)) {
				res.writeHead(404, { 'Content-Type': 'application/json' });
				return res.end('{}');
			}
			res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': String(png.length) });
			return res.end(png);
		}
		res.setHeader('Content-Type', 'application/json');
		if (url.pathname === '/Items') return res.end(JSON.stringify({ Items: [localSeries, localSeriesTwo], TotalRecordCount: 2 }));
		const item = /^\/Users\/[^/]+\/Items\/([^/]+)$/.exec(url.pathname);
		if (item) {
			const key = decodeURIComponent(item[1]);
			if (key === localSeries.Id) return res.end(JSON.stringify(localSeries));
			if (key === localSeriesTwo.Id) return res.end(JSON.stringify(localSeriesTwo));
			const episode = [...localEpisodes, localEpisodeTwo].find(entry => entry.Id === key);
			if (episode) return res.end(JSON.stringify(episode));
			res.statusCode = 404; return res.end('{}');
		}
		const episodes = /^\/Shows\/([^/]+)\/Episodes$/.exec(url.pathname);
		if (episodes) {
			const key = decodeURIComponent(episodes[1]);
			if (key === localSeries.Id) return res.end(JSON.stringify({ Items: localEpisodes }));
			if (key === localSeriesTwo.Id) return res.end(JSON.stringify({ Items: [localEpisodeTwo] }));
			return res.end(JSON.stringify({ Items: [] }));
		}
		return res.end(JSON.stringify({ Items: [], TotalRecordCount: 0 }));
	});
	const dispatcharr = await listen(async (req, res) => {
		const url = new URL(req.url, 'http://127.0.0.1');
		if (url.pathname.startsWith('/api/vod/vodlogos/') && url.pathname.endsWith('/cache/')) {
			res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': String(png.length) });
			return res.end(png);
		}
		res.setHeader('Content-Type', 'application/json');
		const rows = [STREAMED, ...OTHER_STREAMED, CONTINUE_ALIAS, EPISODE_ALIAS];
		if (url.pathname === '/api/vod/movies/' || url.pathname === '/api/vod/movies') return res.end(JSON.stringify({ results: [], next: null }));
		if (url.pathname === '/api/vod/series/' || url.pathname === '/api/vod/series') return res.end(JSON.stringify({ results: rows, next: null }));
		const info = /^\/api\/vod\/series\/(\d+)\/provider-info\/$/.exec(url.pathname);
		if (info) return res.end(JSON.stringify({ id: Number(info[1]) }));
		const episodes = /^\/api\/vod\/series\/(\d+)\/episodes\/$/.exec(url.pathname);
		if (episodes) {
			calls.providerEpisodes += 1;
			const id = Number(episodes[1]);
			await sleep(delays.get(id) ?? 120);
			return res.end(JSON.stringify([{
				id: id * 10, name: 'Show ' + id + ' - S01E01 - Episode', series: { id },
				season_number: 1, episode_number: 1, air_date: '2026-01-02', duration_secs: 2400, created_at: NOW
			}]));
		}
		const detail = /^\/api\/vod\/series\/(\d+)\/$/.exec(url.pathname);
		if (detail) {
			const row = rows.find(entry => entry.id === Number(detail[1]));
			if (!row) return res.end('{}');
			// The alias rows deliberately have no logo and no tmdb_id, so the
			// provider artwork route answers 404 like the live local titles.
			return res.end(JSON.stringify(row.noProviderArt
				? { id: row.id, name: row.name, description: 'Fixture show', genre: 'Drama' }
				: { ...row, description: 'Fixture show', genre: 'Drama', logo: { id: 9500 } }));
		}
		return res.end(JSON.stringify({ results: [], next: null }));
	});
	const seerr = await listen((req, res) => {
		const url = new URL(req.url, 'http://127.0.0.1');
		const match = /^\/api\/v1\/tv\/(\d+)$/.exec(url.pathname);
		res.setHeader('Content-Type', 'application/json');
		if (match) {
			const id = Number(match[1]);
			return res.end(JSON.stringify({
				id, name: 'Warm poster show', overview: 'Fixture metadata.', firstAirDate: '2026-01-01',
				posterPath: id === STREAMED.tmdb ? STREAMED.posterPath : null,
				voteAverage: 7, voteCount: 100, genres: [{ name: 'Drama' }]
			}));
		}
		return res.end(JSON.stringify({ results: [] }));
	});
	const local = await listen();
	Object.assign(process.env, {
		NODE_ENV: 'test', AUTH_DIR: directory, DATA_DIR: directory, CATALOGUE_CACHE_DIR: directory,
		JELLYFIN_URL: `http://127.0.0.1:${jellyfin.address().port}`,
		DISPATCHARR_URL: `http://127.0.0.1:${dispatcharr.address().port}`,
		SEERR_URL: `http://127.0.0.1:${seerr.address().port}`,
		PORT: String(local.address().port), LOCAL_HOSTS: '127.0.0.1', LOCAL_NETWORKS: '127.0.0.0/8',
		PUBLIC_ORIGIN: 'http://127.0.0.1:' + local.address().port
	});
	const seriesCatalogue = [{
		Id: `dispatch-series-${STREAMED.id}`, Name: STREAMED.name, Type: 'Series', Source: 'streamed', Provider: 'Dispatcharr',
		Genres: ['Drama'], ProviderIds: { Tmdb: String(STREAMED.tmdb) }, VodIds: [STREAMED.id],
		PremiereDate: '2026-01-01', DateCreated: NOW, Artwork: `/api/web/art/series/${STREAMED.id}`
	}, ...OTHER_STREAMED.map(row => ({
		Id: `dispatch-series-${row.id}`, Name: row.name, Type: 'Series', Source: 'streamed', Provider: 'Dispatcharr',
		Genres: ['Drama'], VodIds: [row.id], PremiereDate: '2026-01-01', DateCreated: row.created_at,
		Artwork: `/api/web/art/series/${row.id}`
	})), ...[CONTINUE_ALIAS, EPISODE_ALIAS].map(row => ({
		// Same TMDB identity as the local show, so mergeLibrary attaches the VOD
		// id to the local canonical item and its episodes inherit the alias art.
		Id: `dispatch-series-${row.id}`, Name: row.name, Type: 'Series', Source: 'streamed', Provider: 'Dispatcharr',
		Genres: ['Drama'], ProviderIds: { Tmdb: String(row.tmdb) }, VodIds: [row.id],
		PremiereDate: '2026-01-01', DateCreated: NOW, Artwork: `/api/web/art/series/${row.id}`
	}))];
	writeFileSync(join(directory, 'connection.json'), JSON.stringify({ userId: 'fixture', token: 'fixture-only' }));
	writeFileSync(join(directory, 'apps.json'), JSON.stringify({}));
	writeFileSync(join(directory, 'account-limits.json'), JSON.stringify({ accounts: {} }));
	writeFileSync(join(directory, 'dispatcharr.json'), JSON.stringify({ key: 'fixture-only' }));
	writeFileSync(join(directory, 'seerr.json'), JSON.stringify({ url: `http://127.0.0.1:${seerr.address().port}`, key: 'fixture-key' }));
	writeFileSync(join(directory, 'capabilities.json'), JSON.stringify({
		jellyfin: true, library: true, live: false, nonstop: false, vod: true, recordings: false,
		catchup: false, discover: false, comingSoon: false, introdb: false, subtitles: false
	}));
	writeFileSync(join(directory, 'vod-catalogue.json'), JSON.stringify({ time: Date.now(), items: seriesCatalogue }));
	writeFileSync(join(directory, 'series-links.json'), JSON.stringify({}));
	// One exact unfinished local episode in the genuinely scoped home activity:
	// the Continue row comes from the server path, not browser storage.
	writeFileSync(join(directory, 'activity.json'), JSON.stringify([{
		id: 'local-progress-1', type: 'playback', local: true, itemId: localEpisodes[0].Id,
		seriesId: localSeries.Id, position: 120, duration: 2400, state: 'ended',
		time: Date.now() - 60000, updated: Date.now() - 60000
	}]));
	const { app } = await import('../server.mjs');
	local.on('request', app);
	return {
		base: `http://127.0.0.1:${local.address().port}`, directory, calls, delays,
		setBrokenBackdrop(value) { brokenBackdrop = value === true; },
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
	const listeners = new Map();
	socket.onmessage = event => {
		const message = JSON.parse(event.data);
		if (message.id && pending.has(message.id)) {
			const { resolve, reject } = pending.get(message.id);
			pending.delete(message.id);
			if (message.error) reject(new Error(JSON.stringify(message.error)));
			else resolve(message.result);
		} else if (message.method) {
			for (const listener of listeners.get(message.method) || []) listener(message.params);
		}
	};
	const send = (method, params = {}) => new Promise((resolve, reject) => {
		const messageId = ++id;
		pending.set(messageId, { resolve, reject });
		socket.send(JSON.stringify({ id: messageId, method, params }));
	});
	const on = (method, listener) => {
		const list = listeners.get(method) || [];
		list.push(listener);
		listeners.set(method, list);
	};
	return { socket, send, on };
}

const evidence = { profile: profileName, viewport, startedAt: new Date().toISOString(), checks: [], phases: {} };
function check(name, pass, detail = '') {
	evidence.checks.push({ name, pass: Boolean(pass), detail });
	console.log((pass ? 'PASS ' : 'FAIL ') + name + (detail ? ' - ' + detail : ''));
}

const fixture = await startFixture();
let chrome = null, profileDir = '', socket = null, send = null;
try {
	profileDir = mkdtempSync(join(tmpdir(), 'tellybox-home-130-chrome-'));
	chrome = spawn(chromePath, [
		'--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
		'--no-default-browser-check', '--disable-extensions', '--autoplay-policy=no-user-gesture-required',
		'--window-size=' + viewport.width + ',' + viewport.height,
		'--remote-debugging-port=0', '--user-data-dir=' + profileDir, 'about:blank'
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
	await send('Emulation.setDeviceMetricsOverride', {
		width: viewport.width, height: viewport.height, deviceScaleFactor: 1, mobile: viewport.mobile
	});
	const evaluate = async (expression, userGesture = false) => {
		const result = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture });
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
			await sleep(75);
		}
		throw new Error('Timed out waiting for ' + label + ' (last: ' + JSON.stringify(last) + ')');
	};
	const screenshot = async name => {
		const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
		writeFileSync(join(outDir, name), Buffer.from(shot.data, 'base64'));
		return name;
	};
	const homeDurations = () => evaluate(`(() => performance.getEntriesByType('resource')
		.filter(entry => entry.name.includes('/api/web/home') && !entry.name.includes('/artwork'))
		.map(entry => ({ start: Math.round(entry.startTime), duration: Math.round(entry.duration) })))()`);
	const rowsPainted = `document.querySelectorAll('#homeRows .home-row').length > 0`;
	const resetDurations = `performance.clearResourceTimings()`;

	// 1. Cold visit while one streamed show's provider episode lookup hangs for
	// 4 s, exactly the live shape that used to stack Continue + feed deadlines.
	fixture.delays.set(STREAMED.id, 4200);
	const homeSettled = `(() => {
		const tiles = document.querySelectorAll('#homeRows .home-row .home-tile').length;
		const done = performance.getEntriesByType('resource')
			.some(entry => entry.name.includes('/api/web/home') && !entry.name.includes('/artwork') && entry.responseEnd > 0);
		return tiles > 0 && done;
	})()`;
	await send('Page.navigate', { url: fixture.base + '/' });
	await waitFor(homeSettled, 20000, 'Home feed');
	await sleep(900);
	const coldDurations = await homeDurations();
	const coldRows = await evaluate(`(() => {
		const rows = [...document.querySelectorAll('#homeRows .home-row')].map(row => ({
			id: (/home-row--([a-z0-9_-]+)/.exec(row.className) || [])[1] || '',
			items: row.querySelectorAll('.home-tile').length
		}));
		const ids = [...document.querySelectorAll('#homeRows [data-tellybox-item]')].map(node => node.dataset.tellyboxItem);
		return { rows, ids };
	})()`);
	evidence.phases.cold = { home: coldDurations, rows: coldRows.rows };
	evidence.screenshots = [await screenshot('home-130-' + profileName + '-cold.png')];
	const coldHome = coldDurations.find(entry => entry.duration > 0);
	check('Home stays bounded while a provider lookup hangs', Boolean(coldHome && coldHome.duration < 2600),
		coldHome ? 'home POST ' + coldHome.duration + 'ms' : 'no Home POST observed');
	check('the hanging show is not shown unverified',
		!coldRows.ids.includes('dispatch-series-' + STREAMED.id) && coldRows.rows.some(row => row.items > 0),
		JSON.stringify(coldRows.rows));

	// 2. Let the in-flight lookup settle, then the same Home must be quick.
	fixture.delays.delete(STREAMED.id);
	await sleep(4600);
	await evaluate(resetDurations);
	await send('Page.navigate', { url: fixture.base + '/' });
	await waitFor(homeSettled, 20000, 'Home feed (settled)');
	await sleep(900);
	const settledDurations = await homeDurations();
	evidence.phases.settled = { home: settledDurations };
	evidence.screenshots.push(await screenshot('home-130-' + profileName + '-settled.png'));
	const settledHome = settledDurations.find(entry => entry.duration > 0);
	check('a settled warm Home is quick', Boolean(settledHome && settledHome.duration < 1200),
		settledHome ? 'home POST ' + settledHome.duration + 'ms' : 'no Home POST observed');

	// 3. Seed this Home profile's favourites through the real API, then reload so
	// both the server-side Continue row (seeded activity) and the New-episodes
	// rail render from the real endpoints.
	const authStatus = await evaluate(`(async () => {
		const response = await fetch('/api/auth/status');
		return { code: response.status, body: await response.json() };
	})()`);
	evidence.authStatus = authStatus;
	evidence.homeProbe = await evaluate(`(async () => {
		const response = await fetch('/api/web/home', {
			method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
		});
		const body = await response.json();
		const row = (body.rows || []).find(entry => entry.id === 'continue');
		return { status: response.status, rows: (body.rows || []).map(entry => [entry.id, (entry.items || []).length]),
			continueItems: row ? row.items.map(item => ({ Id: item.Id, Type: item.Type })) : null,
			continueAvailability: body.availability && body.availability.continue,
			rendered: [...document.querySelectorAll('#homeRows .home-row')].map(entry => ({
				className: entry.className, tiles: entry.querySelectorAll('.home-tile').length,
				text: (entry.textContent || '').slice(0, 60)
			})) };
	})()`);
	const seed = await evaluate(`(async () => {
		const current = await (await fetch('/api/favourites')).json();
		const items = [
			${JSON.stringify({ Id: localSeries.Id, Name: localSeries.Name, Type: 'Series' })},
			${JSON.stringify({ Id: localSeriesTwo.Id, Name: localSeriesTwo.Name, Type: 'Series' })},
			${JSON.stringify({ Id: `dispatch-series-${STREAMED.id}`, Name: STREAMED.name, Type: 'Series' })}
		];
		const result = await fetch('/api/favourites', {
			method: 'POST', headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ profileId: current.own.id, changes: items.map(item => ({ id: item.Id, saved: true, item })) })
		});
		return { status: result.status, own: current.own.id };
	})()`);
	check('favourites seeded through the real API', seed.status === 200, JSON.stringify(seed));

	await evaluate(resetDurations);
	await send('Page.navigate', { url: fixture.base + '/' });
	await waitFor(homeSettled, 20000, 'Home feed (warm)');
	await waitFor(`document.querySelectorAll('#homeRows .home-row--new-episodes .home-tile').length > 0`, 20000, 'New-episodes rail');
	await waitFor(`document.querySelectorAll('#homeRows .home-row--continue .continue-card').length > 0`, 20000, 'Continue rail');
	const warmDurations = await homeDurations();
	evidence.phases.warm = { home: warmDurations };
	const rail = await evaluate(`(async () => {
		const tiles = [...document.querySelectorAll('#homeRows .home-row--new-episodes .home-tile')];
		const rows = [...document.querySelectorAll('#homeRows .home-row')].map(row => (/home-row--([a-z0-9_-]+)/.exec(row.className) || [])[1] || '');
		const continueTiles = [...document.querySelectorAll('#homeRows .home-row--continue .continue-card')];
		const continueCards = continueTiles.map(tile => {
			const image = tile.querySelector('.continue-art-image');
			return {
				title: tile.querySelector('.continue-title')?.textContent || '',
				id: tile.dataset.tellyboxItem || '',
				src: image ? new URL(image.src, location.href).pathname : '',
				naturalWidth: image ? image.naturalWidth : 0,
				hidden: image ? Boolean(image.hidden) : null
			};
		});
		const cards = tiles.map(tile => {
			const image = tile.querySelector('.poster img');
			return {
				title: tile.querySelector('h3')?.textContent || '',
				id: tile.querySelector('[data-tellybox-item]')?.dataset.tellyboxItem || '',
				src: image ? new URL(image.src, location.href).pathname : '',
				naturalWidth: image ? image.naturalWidth : 0,
				complete: image ? image.complete : false,
				hidden: image ? Boolean(image.hidden) : null
			};
		});
		return { rows, cards, continueCards, rowsPaintedAt: Math.round(performance.now()) };
	})()`);
	evidence.phases.warm.rail = rail;
	evidence.screenshots.push(await screenshot('home-130-' + profileName + '-warm.png'));

	check('Continue rail shows the exact unfinished local episode',
		rail.continueCards.length === 1 && rail.continueCards[0].id === localEpisodes[0].Id
			&& rail.continueCards[0].naturalWidth > 0,
		JSON.stringify(rail.continueCards));
	check('Continue paints the local show backdrop, not the merged provider alias',
		Boolean(rail.continueCards[0] && rail.continueCards[0].src.startsWith('/images/' + localSeries.Id + '/Backdrop')),
		JSON.stringify(rail.continueCards.map(card => card.src)));
	check('Continue and New episodes are visible together',
		rail.rows.includes('continue') && rail.rows.includes('new-episodes'), rail.rows.join(','));

	check('New-episodes rail renders', rail.cards.length >= 1, 'cards=' + rail.cards.length + ' rows=' + rail.rows.join(','));
	check('a show already in Continue is not repeated in New episodes',
		!rail.cards.some(card => card.id.includes(localEpisodes[0].Id) || card.title === localSeries.Name),
		JSON.stringify(rail.cards.map(card => card.title)));
	const localCard = rail.cards.find(card => card.src.startsWith('/images/' + localSeriesTwo.Id + '/Primary'));
	check('a local episode card uses the parent series image route', Boolean(localCard),
		localCard ? localCard.src : JSON.stringify(rail.cards.map(card => card.src)));
	check('the local episode card decoded real bytes', Boolean(localCard && localCard.naturalWidth > 0),
		localCard ? 'naturalWidth=' + localCard.naturalWidth : 'no local card');
	const streamedCard = rail.cards.find(card => card.src === '/api/web/tmdb-art/tv/' + STREAMED.tmdb + '/poster');
	check('a streamed episode card uses the warm parent poster route', Boolean(streamedCard),
		streamedCard ? streamedCard.src : JSON.stringify(rail.cards.map(card => card.src)));
	check('no New-episodes card is hidden or failed', rail.cards.every(card => card.naturalWidth > 0 && !card.hidden),
		JSON.stringify(rail.cards.map(card => ({ src: card.src, naturalWidth: card.naturalWidth, hidden: card.hidden }))));

	// 4. The show's backdrop route is broken at the source (404). The selected
	// backdrop must fall back to the working poster instead of a blank card.
	fixture.setBrokenBackdrop(true);
	await send('Page.navigate', { url: fixture.base + '/?fallback=' + Date.now() });
	await waitFor(homeSettled, 20000, 'Home feed (broken backdrop)');
	await waitFor(`document.querySelectorAll('#homeRows .home-row--continue .continue-card').length > 0`, 20000, 'Continue rail (broken backdrop)');
	await sleep(800);
	const fallback = await evaluate(`(() => {
		const card = document.querySelector('#homeRows .home-row--continue .continue-card');
		const image = card?.querySelector('.continue-art-image');
		return { src: image ? new URL(image.src, location.href).pathname : '', naturalWidth: image ? image.naturalWidth : 0,
			hidden: image ? Boolean(image.hidden) : null, fallback: image?.dataset.tellyboxFallback || '' };
	})()`);
	evidence.phases.fallback = fallback;
	evidence.screenshots.push(await screenshot('home-131-backdrop-fallback-' + profileName + '.png'));
	check('a 404 Continue backdrop falls back to the working local poster',
		fallback.src.startsWith('/images/' + localSeries.Id + '/Primary') && fallback.naturalWidth > 0 && fallback.hidden === false,
		JSON.stringify(fallback));
} catch (error) {
	check('browser run completed', false, error.message);
} finally {
	writeFileSync(join(outDir, 'home-130-' + profileName + '.json'), JSON.stringify(evidence, null, 2));
	try { socket?.close(); } catch {}
	try { chrome?.kill(); } catch {}
	await sleep(400);
	try { if (profileDir) rmSync(profileDir, { recursive: true, force: true, maxRetries: 5 }); } catch {}
	fixture.close();
}
const failed = evidence.checks.filter(entry => !entry.pass);
console.log(JSON.stringify({ profile: profileName, checks: evidence.checks.length, failed: failed.length, phases: evidence.phases }, null, 1));
process.exit(failed.length ? 1 : 0);

