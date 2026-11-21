/* ARTWORK-128 - real app browser evidence.
 *
 * Starts the synthetic loopback fixture (real server.mjs + fake Dispatcharr,
 * Seerr and Jellyfin) and drives the real server/public app in headless Chrome
 * at a desktop or mobile viewport. The browser hits the real /api/web/home and
 * /api/web/art routes; nothing in the page is mocked.
 *
 * Run one profile per process so each run has a genuinely cold metadata cache:
 *   cd server
 *   $env:ARTWORK128_PROFILE='desktop'; node test/artwork-128-browser.mjs
 *   $env:ARTWORK128_PROFILE='mobile';  node test/artwork-128-browser.mjs
 *
 * Optional deferred-artwork scenario (details opened before the card resolves):
 *   $env:ARTWORK128_PROFILE='desktop'; $env:ARTWORK128_SCENARIO='deferred'; node test/artwork-128-browser.mjs
 *   $env:ARTWORK128_PROFILE='mobile';  $env:ARTWORK128_SCENARIO='deferred'; node test/artwork-128-browser.mjs
 * It defaults to a 2500 ms metadata delay, opens the details dialog while the
 * card still uses the failing provider route, waits for the fixture queue to
 * settle, closes details, and requires the card image to swap in place with no
 * page reload. It writes browser-deferred-<profile>.json.
 *
 * EVIDENCE_DIR overrides the default outputs/Tellybox-artwork-128/evidence/.
 * If Chrome is unavailable the script prints SKIP and exits 0; it never claims
 * a pass without rendering the app. A failing assertion exits non-zero.
 *
 * No production access, provider, credential or deployment is used.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { release, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { IDS, startArtworkFixture } from './artwork-128-fixture.mjs';

const profileName = String(process.env.ARTWORK128_PROFILE || 'desktop').trim().toLowerCase();
const VIEWPORTS = {
	desktop: { width: 1440, height: 900, mobile: false },
	mobile: { width: 390, height: 844, mobile: true }
};
const viewport = VIEWPORTS[profileName];
if (!viewport) {
	console.error('ARTWORK128_PROFILE must be desktop or mobile.');
	process.exit(2);
}

const outDir = process.env.EVIDENCE_DIR
	? process.env.EVIDENCE_DIR.replace(/[\\/]$/, '')
	: fileURLToPath(new URL('../../outputs/Tellybox-artwork-128/evidence/', import.meta.url));
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
	console.log('SKIP: Chrome or Chromium was not found. Set CHROME_PATH to run the ARTWORK-128 browser check.');
	process.exit(0);
}

// A deliberately empty metadata cache is genuinely cold. The fixture's lookup
// latency is raised so the first Home paint really uses the provider artwork
// route, exactly as a cold production visit does; the app's bounded retry then
// rehydrates the card. The override exists for diagnosis only.
const scenario = process.env.ARTWORK128_SCENARIO === 'deferred' ? 'deferred' : 'standard';
const defaultDelayMs = scenario === 'deferred' ? 2500 : 700;
const metadataDelayMs = Math.max(0, Number(process.env.ARTWORK128_METADATA_DELAY_MS ?? defaultDelayMs) || 0);
// Diagnostic fallback only. The shared fixture now reports a connected library,
// so the real client must boot without touching /api/status. Set this to 1 only
// to investigate an older fixture that still reports every feature as disabled.
const statusOverride = process.env.ARTWORK128_STATUS_OVERRIDE === '1';
const BAD_ID = 'dispatch-movie-' + IDS.badPoster;
const BAD_TITLE = 'Gentle Monster';
const BAD_PROVIDER_PATH = '/api/web/art/movie/' + IDS.badPoster;
const BAD_TMDB_PATH = '/api/web/tmdb-art/movie/1473148/poster';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const cleanups = [];
const scope = { after: fn => { cleanups.push(fn); } };
const assertions = [];

function check(phase, name, pass, detail = '') {
	assertions.push({ phase, name, pass: Boolean(pass), detail });
	console.log((pass ? 'PASS ' : 'FAIL ') + phase + ': ' + name + (detail ? ' - ' + detail : ''));
}

// ---------------------------------------------------------------------------
// CDP plumbing
// ---------------------------------------------------------------------------

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

const pathOf = value => {
	try { return new URL(value).pathname; } catch { return ''; }
};

function createNetworkRecorder() {
	let phase = '';
	let startedAt = 0;
	let active = false;
	let entries = [];
	let byId = new Map();
	const record = params => {
		if (!active) return null;
		const entry = byId.get(params.requestId);
		return entry || null;
	};
	return {
		start(name) {
			phase = name;
			startedAt = Date.now();
			entries = [];
			byId = new Map();
			active = true;
		},
		stop() { active = false; },
		request(params) {
			if (!active || byId.has(params.requestId)) return;
			const entry = {
				path: pathOf(params.request?.url),
				method: params.request?.method || 'GET',
				resourceType: params.type || '',
				start: Date.now() - startedAt,
				end: null,
				status: 0,
				encodedBytes: null,
				fromCache: false,
				error: ''
			};
			byId.set(params.requestId, entry);
			entries.push(entry);
		},
		response(params) {
			const entry = record(params);
			if (!entry) return;
			entry.status = Number(params.response?.status) || 0;
			entry.fromCache = Boolean(params.response?.fromDiskCache || params.response?.fromMemoryCache || params.response?.fromServiceWorker);
		},
		finished(params) {
			const entry = record(params);
			if (!entry) return;
			entry.end = Date.now() - startedAt;
			if (Number.isFinite(params.encodedDataLength)) entry.encodedBytes = params.encodedDataLength;
		},
		failed(params) {
			const entry = record(params);
			if (!entry) return;
			entry.end = Date.now() - startedAt;
			entry.error = String(params.errorText || 'failed').slice(0, 80);
		},
		summary() {
			const home = entries.filter(entry => entry.path === '/api/web/home');
			const finishedHome = home.filter(entry => entry.end !== null);
			const isProviderArt = entry => entry.path.startsWith('/api/web/art/');
			const isTmdbArt = entry => entry.path.startsWith('/api/web/tmdb-art/');
			const artwork = entries.filter(entry => isProviderArt(entry) || isTmdbArt(entry));
			const finishedArtwork = artwork.filter(entry => entry.end !== null);
			const encoded = entries
				.filter(entry => Number.isFinite(entry.encodedBytes))
				.reduce((sum, entry) => sum + entry.encodedBytes, 0);
			const notFound = entries.filter(entry => entry.status === 404);
			return {
				phase,
				totalRequests: entries.length,
				finishedRequests: entries.filter(entry => entry.end !== null).length,
				homeRequests: home.length,
				homeStatus: finishedHome[0]?.status || 0,
				homeTimingMs: finishedHome[0]?.end ?? null,
				providerArtworkRequests: entries.filter(isProviderArt).length,
				tmdbArtworkRequests: entries.filter(isTmdbArt).length,
				firstArtworkTimingMs: finishedArtwork[0]?.end ?? null,
				notFoundResponses: notFound.length,
				notFoundPaths: [...new Set(notFound.map(entry => entry.path))].slice(0, 12),
				encodedBytes: encoded,
				fullCollectionRequests: entries.filter(entry => entry.path === '/api/web/items').length,
				badCardProviderRequests: entries
					.filter(entry => entry.path === BAD_PROVIDER_PATH)
					.map(entry => entry.status),
				badCardProvider404: entries.some(entry => entry.path === BAD_PROVIDER_PATH && entry.status === 404),
				badCardTmdbRequests: entries
					.filter(entry => entry.path === BAD_TMDB_PATH)
					.map(entry => entry.status),
				homeTimings: home
					.filter(entry => entry.end !== null)
					.map(entry => ({ start: entry.start, end: entry.end, status: entry.status })),
				badCardTimings: entries
					.filter(entry => entry.path === BAD_PROVIDER_PATH || entry.path === BAD_TMDB_PATH)
					.map(entry => ({ path: entry.path, start: entry.start, end: entry.end, status: entry.status }))
			};
		}
	};
}

// ---------------------------------------------------------------------------
// Browser run
// ---------------------------------------------------------------------------

let child = null;
let socket = null;
let profileDir = null;
let send = null;
let recorder = null;
const pageExceptions = [];
const logErrors = [];
const evidence = {
	profile: profileName,
	scenario,
	viewport: { width: viewport.width, height: viewport.height, mobile: viewport.mobile },
	fixtureOnly: true,
	externalProviderUsed: false,
	catalogue: scenario === 'deferred'
		? 'single fixture title dispatch-movie-69227; isolates the deferred artwork pass'
		: 'shared fixture catalogue',
	metadataDelayMs,
	environment: {
		os: process.platform + ' ' + release(),
		node: process.version,
		chrome: '',
		headless: true
	},
	titleIds: [],
	badCardId: BAD_ID,
	phases: {},
	assertions,
	passed: false
};
let exitCode = 1;

try {
	const fixture = await startArtworkFixture(scope, scenario === 'deferred' ? {
		// The deferred scenario isolates the artwork-rehydration branch. With the
		// full fixture, arriving metadata re-scores and reorders every row, so the
		// client takes the row-rebuild branch instead. One title (the same
		// provider-missing card) keeps row identity stable while the real metadata
		// and artwork routes still resolve.
		movies: [{ id: IDS.badPoster, name: BAD_TITLE, tmdb_id: 1473148, year: 2026, genre: 'Drama', created_at: '2026-11-18T10:00:00Z' }]
	} : undefined);
	evidence.titleIds = fixture.rows.map(row => 'dispatch-movie-' + row.id);
	// Provider metadata latency is what makes the cold paint use the provider
	// artwork route; the fixture is otherwise deterministic and loopback-only.
	fixture.calls.setMode('ok', metadataDelayMs);

	profileDir = mkdtempSync(join(tmpdir(), 'tellybox-artwork-128-browser-'));
	child = spawn(chromePath, [
		'--headless=new',
		'--disable-gpu',
		'--hide-scrollbars',
		'--no-first-run',
		'--no-default-browser-check',
		'--disable-extensions',
		'--autoplay-policy=no-user-gesture-required',
		'--window-size=' + viewport.width + ',' + viewport.height,
		'--remote-debugging-port=0',
		'--user-data-dir=' + profileDir,
		'about:blank',
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
	send = connection.send;
	socket = connection.socket;

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
			try {
				last = await evaluate(expression);
				if (last) return last;
			} catch (error) { last = error.message; }
			await sleep(75);
		}
		throw new Error('Timed out waiting for ' + label + ' (last: ' + JSON.stringify(last) + ')');
	};
	const screenshot = async name => {
		const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
		writeFileSync(join(outDir, name), Buffer.from(shot.data, 'base64'));
		return name;
	};
	const scrollToBadCard = async () => {
		await evaluate(`(() => {
			const holder = document.querySelector('[data-tellybox-item="${BAD_ID}"]');
			const tile = holder && holder.closest('.home-tile');
			(tile || holder)?.scrollIntoView({ block: 'center', inline: 'center' });
			return true;
		})()`);
		await sleep(250);
	};
	const badCardState = () => evaluate(`(() => {
		const holder = document.querySelector('[data-tellybox-item="${BAD_ID}"]');
		const image = holder?.querySelector('.poster img');
		const title = holder?.querySelector('h3');
		const box = title?.getBoundingClientRect();
		const style = title ? getComputedStyle(title) : null;
		const rows = [...document.querySelectorAll('#homeRows .home-row')];
		return {
			exists: Boolean(holder),
			srcPath: image ? new URL(image.src, location.href).pathname : '',
			naturalWidth: image ? image.naturalWidth : 0,
			imageHidden: image ? Boolean(image.hidden) : null,
			failedMarker: image?.dataset.tellyboxFailed || '',
			titleText: title?.textContent || '',
			titleVisible: Boolean(style && style.display !== 'none' && style.visibility !== 'hidden' && box && box.width > 0 && box.height > 0),
			artworkErrors: Number(window.__artworkErrors) || 0,
			rowCount: rows.length,
			rowIds: rows.map(row => (/home-row--([a-z0-9_-]+)/.exec(row.className) || [])[1] || '')
		};
	})()`);
	const badImageReady = `(() => {
		const holder = document.querySelector('[data-tellybox-item="${BAD_ID}"]');
		const image = holder?.querySelector('.poster img');
		return Boolean(image && !image.hidden && image.complete && image.naturalWidth > 0);
	})()`;
	const waitHomeRows = () => waitFor(
		`(() => document.querySelectorAll('#homeRows .home-row').length > 0 && document.querySelector('[data-tellybox-item="${BAD_ID}"]') !== null)()`,
		15000, 'Home rows with the fixture card'
	);

	recorder = createNetworkRecorder();
	connection.on('Network.requestWillBeSent', params => recorder.request(params));
	connection.on('Network.responseReceived', params => recorder.response(params));
	connection.on('Network.loadingFinished', params => recorder.finished(params));
	connection.on('Network.loadingFailed', params => recorder.failed(params));
	connection.on('Runtime.exceptionThrown', params => {
		const value = params?.exceptionDetails?.exception?.description || params?.exceptionDetails?.text;
		if (value) pageExceptions.push(String(value).split('\n')[0].slice(0, 200));
	});
	connection.on('Log.entryAdded', params => {
		if (params?.entry?.level === 'error') logErrors.push(String(params.entry.text || '').split('\n')[0].slice(0, 200));
	});

	await send('Page.enable');
	await send('Runtime.enable');
	await send('Network.enable');
	await send('Log.enable');
	// No /api/status rewriting by default: the shared fixture now reports a
	// connected library, and the real client must boot against it untouched.
	if (statusOverride) {
		await send('Fetch.enable', { patterns: [{ urlPattern: '*/api/status', requestStage: 'Response' }] });
		connection.on('Fetch.requestPaused', async params => {
			try {
				if (params.responseStatusCode && params.responseStatusCode === 200) {
					const body = await send('Fetch.getResponseBody', { requestId: params.requestId });
					const text = body.base64Encoded ? Buffer.from(body.body, 'base64').toString('utf8') : body.body;
					const value = JSON.parse(text);
					if (value && value.features && typeof value.features === 'object') {
						value.features.library = true;
						value.features.vod = true;
						value.connected = true;
						await send('Fetch.fulfillRequest', {
							requestId: params.requestId,
							responseCode: params.responseStatusCode,
							responseHeaders: params.responseHeaders,
							body: Buffer.from(JSON.stringify(value)).toString('base64')
						});
						return;
					}
				}
				await send('Fetch.continueRequest', { requestId: params.requestId });
			} catch {
				try { await send('Fetch.continueRequest', { requestId: params.requestId }); } catch {}
			}
		});
		evidence.statusFeatureOverride = 'diagnostic only: ARTWORK128_STATUS_OVERRIDE=1 rewrote the /api/status feature flags';
	}
	// Measure the real phone/desktop layout, not a resized window.
	await send('Emulation.setDeviceMetricsOverride', {
		width: viewport.width,
		height: viewport.height,
		deviceScaleFactor: 1,
		mobile: viewport.mobile,
		screenWidth: viewport.width,
		screenHeight: viewport.height
	});
	// Instrument image errors before any app script runs.
	await send('Page.addScriptToEvaluateOnNewDocument', {
		source: "window.__artworkErrors=0; document.addEventListener('error', e=>{ if(e.target instanceof HTMLImageElement) window.__artworkErrors++; }, true);"
	});
	if (scenario === 'deferred') {
		// Record every src/hidden change on Home card images so a deferred swap
		// (or a regression) is visible in the evidence.
		await send('Page.addScriptToEvaluateOnNewDocument', {
			source: `
				window.__artworkTrace = [];
				const record = node => {
					if (!(node instanceof HTMLImageElement)) return;
					const holder = node.closest && node.closest('[data-tellybox-item]');
					if (!holder) return;
					window.__artworkTrace.push({
						t: Math.round(performance.now()),
						id: holder.dataset.tellyboxItem,
						src: node.getAttribute('src') || '',
						hidden: Boolean(node.hidden),
						failed: node.dataset.tellyboxFailed || ''
					});
					if (window.__artworkTrace.length > 400) window.__artworkTrace.splice(0, 200);
				};
				new MutationObserver(records => {
					for (const change of records) {
						if (change.type === 'attributes') record(change.target);
						else for (const node of change.addedNodes) {
							if (node instanceof HTMLImageElement) record(node);
							else if (node.querySelectorAll) for (const image of node.querySelectorAll('img')) record(image);
						}
					}
				}).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['src', 'hidden', 'data-tellybox-failed'] });
				window.__homeResponses = [];
				window.__deferredMarks = [];
				const originalFetch = window.fetch;
				window.fetch = async (...args) => {
					const response = await originalFetch(...args);
					try {
						if (String(args[0]).includes('/api/web/home')) {
							response.clone().json().then(data => {
								const items = (data?.rows || []).flatMap(row => Array.isArray(row.items) ? row.items : []);
								const bad = items.find(item => item?.Id === '${BAD_ID}');
								window.__homeResponses.push({
									t: Math.round(performance.now()),
									home: true,
									artwork: data?.availability?.artwork || null,
									bad: bad?.Artwork || '',
									rows: (data?.rows || []).map(row => row.id),
									rowItems: (data?.rows || []).map(row => row.id + ':' + (row.items || []).map(item => item?.Id).join(','))
								});
							}).catch(() => {});
						}
					} catch {}
					return response;
				};
			`
		});
	}
	try {
		const version = await send('Browser.getVersion');
		evidence.environment.chrome = String(version.product || '').split(' ')[0];
	} catch {}

	// -----------------------------------------------------------------------
	// Deferred artwork: open details while the card is unresolved, close, and
	// require the in-place swap without a reload.
	// -----------------------------------------------------------------------
	async function runDeferredScenario() {
		recorder.start('deferred');
		const seerrBefore = fixture.calls.seerr;
		await send('Page.navigate', { url: fixture.base + '/' });
		await waitFor("document.readyState === 'complete'", 15000, 'page load');
		await waitHomeRows();
		// The cold paint must already be the failing provider route.
		await waitFor(`(() => {
			const holder = document.querySelector('[data-tellybox-item="${BAD_ID}"]');
			const image = holder?.querySelector('.poster img');
			return Boolean(image && (image.dataset.tellyboxFailed === '1' || (image.complete && image.naturalWidth === 0)));
		})()`, 10000, 'the failed provider artwork on the cold card');
		const beforeOpen = await badCardState();
		// Let the startup Home requests and their renders settle so the dialog
		// race is about artwork only, not a row render that happens to land as the
		// dialog opens. Metadata is still ~2.5 s away at this point.
		try { await waitFor('(window.__homeResponses || []).length >= 2', 5000, 'the startup Home responses'); } catch {}
		await sleep(400);
		const timeOrigin = await evaluate('performance.timeOrigin');
		const point = await evaluate(`(() => {
			const holder = document.querySelector('[data-tellybox-item="${BAD_ID}"]');
			const button = holder?.closest('.home-tile')?.querySelector('.home-info');
			if (!button) return null;
			button.scrollIntoView({ block: 'center', inline: 'center' });
			const label = button.getAttribute('aria-label') || '';
			// A DOM click opens the same real dialog without a window focus event,
			// which would queue an unrelated Home refresh as the dialog opens.
			button.click();
			return { clicked: true, label };
		})()`);
		if (!point) throw new Error('Could not find the bad card More info button');
		await waitFor("document.querySelector('#details')?.open === true", 10000, 'the details dialog');
		const openedAtPage = await evaluate('Math.round(performance.now())');
		await evaluate("window.__deferredMarks && window.__deferredMarks.push({ t: Math.round(performance.now()), mark: 'details-open' })");
		// Wait for every displayed lookup to start, then for the last one to
		// finish. The fixture counts a lookup when it starts.
		const queueDeadline = Date.now() + 30000;
		while (fixture.calls.seerr < fixture.rows.length && Date.now() < queueDeadline) await sleep(150);
		if (fixture.calls.seerr < fixture.rows.length) throw new Error('The metadata queue did not start every visible lookup');
		// Close only after a real Home response has delivered the resolved artwork
		// to the client. That is the state the deferred pass must apply.
		await waitFor(`(window.__homeResponses || []).some(entry => entry.bad && entry.bad !== '${BAD_PROVIDER_PATH}')`, 20000, 'a Home response carrying resolved artwork');
		await sleep(150);
		// The bounded Home refresh must have completed while details was open.
		const networkDuring = recorder.summary();
		const secondHomeSeen = networkDuring.homeRequests >= 2;
		const detailsTitle = await waitFor("document.querySelector('#detailsTitle')?.textContent || ''", 5000, 'the details title');
		const whileOpen = await badCardState();
		const detailsOpenBeforeClose = await evaluate("document.querySelector('#details')?.open === true");
		const seerrWhileOpen = fixture.calls.seerr;
		const closed = await evaluate(`(() => { const button = document.querySelector('#closeDetails'); if (!button) return false; button.click(); return true; })()`);
		if (!closed) throw new Error('Could not close the details dialog');
		await waitFor("document.querySelector('#details')?.open === false", 8000, 'the details dialog to close');
		const closedAtPage = await evaluate('Math.round(performance.now())');
		await evaluate("window.__deferredMarks && window.__deferredMarks.push({ t: Math.round(performance.now()), mark: 'details-close' })");
		try {
			await waitFor(badImageReady, 12000, 'the deferred artwork after closing details');
		} catch (error) {
			// Diagnostic only: prove whether the deferred swap was missed by the
			// close handler or never armed. A synthetic window focus makes the app
			// re-run applyDeferredHomeArtwork without a reload.
			const afterTimeout = await badCardState();
			await evaluate("window.dispatchEvent(new Event('focus'))");
			await sleep(1500);
			const afterFocus = await badCardState();
			evidence.phases.deferredDiagnostic = { afterTimeout, afterFocus, detailsOpenBeforeClose };
			throw error;
		}
		await sleep(350);
		await scrollToBadCard();
		const afterClose = await badCardState();
		const seerrAfter = fixture.calls.seerr;
		const timeOriginAfter = await evaluate('performance.timeOrigin');
		const navigationCount = await evaluate("performance.getEntriesByType('navigation').length");
		const artworkTrace = await evaluate("(window.__artworkTrace || []).slice(-60)");
		const homeResponses = await evaluate("window.__homeResponses || []");
		const marks = await evaluate("window.__deferredMarks || []");
		const network = recorder.summary();
		recorder.stop();
		const shot = await screenshot(profileName + '-deferred.png');
		evidence.phases.deferred = {
			network,
			seerr: { before: seerrBefore, whileOpen: seerrWhileOpen, after: seerrAfter, expected: fixture.rows.length },
			card: { beforeOpen, whileOpen, afterClose },
			details: { title: detailsTitle, secondHomeSeen, openedAtPage, closedAtPage },
			reload: { timeOriginSame: timeOriginAfter === timeOrigin, navigationEntries: navigationCount },
			artworkTrace,
			homeResponses,
			marks,
			screenshot: shot
		};

		check('deferred', 'the real Home route responded 200', network.homeStatus === 200, 'status ' + network.homeStatus);
		check('deferred', 'the card still used the failing provider artwork when details opened',
			beforeOpen.srcPath === BAD_PROVIDER_PATH && beforeOpen.naturalWidth === 0,
			JSON.stringify({ src: beforeOpen.srcPath, width: beforeOpen.naturalWidth, hidden: beforeOpen.imageHidden }));
		check('deferred', 'the real details dialog opened before artwork resolved',
			detailsTitle === BAD_TITLE, JSON.stringify({ clicked: point.label, title: detailsTitle }));
		check('deferred', 'the bounded Home refresh ran while details owned the screen',
			secondHomeSeen === true, 'homeRequests=' + network.homeRequests);
		check('deferred', 'resolved artwork stayed deferred behind the dialog',
			whileOpen.srcPath === BAD_PROVIDER_PATH && (whileOpen.imageHidden === true || whileOpen.naturalWidth === 0),
			JSON.stringify({ src: whileOpen.srcPath, width: whileOpen.naturalWidth, hidden: whileOpen.imageHidden }));
		check('deferred', 'closing details applied the deferred artwork without a page reload',
			afterClose.srcPath === BAD_TMDB_PATH && afterClose.naturalWidth > 0 && afterClose.imageHidden === false,
			JSON.stringify({ src: afterClose.srcPath, width: afterClose.naturalWidth, hidden: afterClose.imageHidden }));
		check('deferred', 'the page never reloaded during the deferred scenario',
			timeOriginAfter === timeOrigin && navigationCount === 1,
			JSON.stringify({ sameTimeOrigin: timeOriginAfter === timeOrigin, navigationEntries: navigationCount }));
		check('deferred', 'the deferred pass made no extra metadata lookup',
			seerrAfter === seerrWhileOpen && seerrAfter === fixture.rows.length,
			JSON.stringify({ whileOpen: seerrWhileOpen, after: seerrAfter, expected: fixture.rows.length }));
		check('deferred', 'Home never requested the full collection', network.fullCollectionRequests === 0, 'requests: ' + network.fullCollectionRequests);
		check('deferred', 'the bad card title remains visible', afterClose.titleVisible, afterClose.titleText);
	}

	if (scenario === 'deferred') {
		await runDeferredScenario();
		throw Object.assign(new Error('deferred scenario complete'), { deferredComplete: true });
	}

	// -----------------------------------------------------------------------
	// Cold: fresh fixture process, empty metadata cache, fresh browser profile
	// -----------------------------------------------------------------------
	recorder.start('cold');
	const seerrBeforeCold = fixture.calls.seerr;
	await send('Page.navigate', { url: fixture.base + '/' });
	await waitFor("document.readyState === 'complete'", 15000, 'page load');
	await waitHomeRows();
	// The first paint must be a provider-artwork card. The real image error is
	// what the app's bounded refresh observes before the TMDB copy is available.
	await waitFor('window.__artworkErrors >= 1', 10000, 'a real image error during the cold paint');
	await waitFor(badImageReady, 12000, 'the bad card image after the cold refresh');
	await sleep(350);
	await scrollToBadCard();
	const coldState = await badCardState();
	const seerrAfterCold = fixture.calls.seerr;
	const coldNetwork = recorder.summary();
	recorder.stop();
	const coldShot = await screenshot(profileName + '-cold.png');
	evidence.phases.cold = {
		network: coldNetwork,
		seerr: { before: seerrBeforeCold, after: seerrAfterCold, delta: seerrAfterCold - seerrBeforeCold },
		card: coldState,
		screenshot: coldShot
	};

	check('cold', 'the real Home route responded 200', coldNetwork.homeStatus === 200, 'status ' + coldNetwork.homeStatus);
	check('cold', 'Home rendered at least one row', coldState.rowCount > 0, 'rows: ' + coldState.rowIds.join(','));
	check('cold', 'the provider-missing card is displayed', coldState.exists && coldState.titleText === BAD_TITLE, JSON.stringify({ exists: coldState.exists, title: coldState.titleText }));
	check('cold', 'Home did not request the full collection', coldNetwork.fullCollectionRequests === 0, 'requests: ' + coldNetwork.fullCollectionRequests);
	check('cold', 'the cold card first used the provider artwork route', coldNetwork.badCardProviderRequests.length > 0, 'statuses: ' + JSON.stringify(coldNetwork.badCardProviderRequests));
	check('cold', 'the real image-error/fallback path ran', coldState.artworkErrors >= 1, '__artworkErrors=' + coldState.artworkErrors);
	check('cold', 'the bad card ends with a working image', coldState.naturalWidth > 0 && coldState.imageHidden === false, JSON.stringify({ src: coldState.srcPath, width: coldState.naturalWidth, hidden: coldState.imageHidden }));
	check('cold', 'the bad card title text is visible', coldState.titleVisible, coldState.titleText);
	check('cold', 'the cold visit warmed displayed metadata once', seerrAfterCold > seerrBeforeCold, 'seerr ' + seerrBeforeCold + ' -> ' + seerrAfterCold);
	check('cold', 'the working image is the TMDB route or the provider route now resolves',
		coldState.srcPath === BAD_TMDB_PATH || (coldState.srcPath === BAD_PROVIDER_PATH && coldNetwork.badCardProvider404 === false) || coldState.srcPath.startsWith('/api/web/tmdb-art/'),
		coldState.srcPath);

	// -----------------------------------------------------------------------
	// Warm: same fixture and browser profile, real page reload
	// -----------------------------------------------------------------------
	recorder.start('warm');
	const seerrBeforeWarm = fixture.calls.seerr;
	await send('Page.reload');
	await waitFor("document.readyState === 'complete'", 15000, 'warm page load');
	await waitHomeRows();
	await waitFor(badImageReady, 12000, 'the warm bad card image');
	await sleep(350);
	await scrollToBadCard();
	const warmState = await badCardState();
	const seerrAfterWarm = fixture.calls.seerr;
	const warmNetwork = recorder.summary();
	recorder.stop();
	const warmShot = await screenshot(profileName + '-warm.png');
	evidence.phases.warm = {
		network: warmNetwork,
		seerr: { before: seerrBeforeWarm, after: seerrAfterWarm, delta: seerrAfterWarm - seerrBeforeWarm },
		card: warmState,
		screenshot: warmShot
	};

	check('warm', 'the real Home route responded 200', warmNetwork.homeStatus === 200, 'status ' + warmNetwork.homeStatus);
	check('warm', 'Home rendered the fixture rows again', warmState.rowCount > 0, 'rows: ' + warmState.rowIds.join(','));
	check('warm', 'Home did not request the full collection', warmNetwork.fullCollectionRequests === 0, 'requests: ' + warmNetwork.fullCollectionRequests);
	check('warm', 'the bad card image loads on the warm visit', warmState.naturalWidth > 0 && warmState.imageHidden === false, JSON.stringify({ src: warmState.srcPath, width: warmState.naturalWidth }));
	check('warm', 'the warm visit reuses cached artwork and makes no metadata lookup', seerrAfterWarm === seerrBeforeWarm, 'seerr delta ' + (seerrAfterWarm - seerrBeforeWarm));
	check('warm', 'the warm card uses the TMDB artwork route', warmState.srcPath === BAD_TMDB_PATH, warmState.srcPath);

	// -----------------------------------------------------------------------
	// Navigation: open and close the real details dialog on the bad card
	// -----------------------------------------------------------------------
	recorder.start('navigation');
	const seerrBeforeNavigation = fixture.calls.seerr;
	const point = await evaluate(`(() => {
		const holder = document.querySelector('[data-tellybox-item="${BAD_ID}"]');
		const button = holder?.closest('.home-tile')?.querySelector('.home-info');
		if (!button) return null;
		button.scrollIntoView({ block: 'center', inline: 'center' });
		const box = button.getBoundingClientRect();
		return { x: box.x + box.width / 2, y: box.y + box.height / 2, label: button.getAttribute('aria-label') || '' };
	})()`);
	if (!point) throw new Error('Could not find the bad card More info button');
	await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
	await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
	await waitFor("document.querySelector('#details')?.open === true", 10000, 'the details dialog');
	const detailsTitle = await waitFor("document.querySelector('#detailsTitle')?.textContent || ''", 10000, 'the details title');
	const clickedClose = await evaluate(`(() => { const button = document.querySelector('#closeDetails'); if (!button) return false; button.click(); return true; })()`);
	if (!clickedClose) throw new Error('Could not close the details dialog');
	await waitFor("document.querySelector('#details')?.open === false", 8000, 'the details dialog to close');
	await waitHomeRows();
	await waitFor(badImageReady, 10000, 'the bad card image after details navigation');
	await sleep(350);
	await scrollToBadCard();
	const navigationState = await badCardState();
	const seerrAfterNavigation = fixture.calls.seerr;
	const navigationNetwork = recorder.summary();
	recorder.stop();
	const navigationShot = await screenshot(profileName + '-navigation.png');
	evidence.phases.navigation = {
		network: navigationNetwork,
		seerr: { before: seerrBeforeNavigation, after: seerrAfterNavigation, delta: seerrAfterNavigation - seerrBeforeNavigation },
		card: navigationState,
		details: { open: true, title: detailsTitle, closed: true },
		screenshot: navigationShot
	};

	const rowsKept = coldState.rowIds.every(id => navigationState.rowIds.includes(id));
	check('navigation', 'the real details dialog opened for the bad card', detailsTitle === BAD_TITLE, JSON.stringify({ clicked: point.label, title: detailsTitle }));
	check('navigation', 'the details dialog closed again', clickedClose === true, 'close button clicked');
	check('navigation', 'Home kept every row after returning from details', navigationState.rowCount >= coldState.rowCount && rowsKept, JSON.stringify({ before: coldState.rowIds, after: navigationState.rowIds }));
	check('navigation', 'the bad card image still loads after navigation', navigationState.naturalWidth > 0 && navigationState.imageHidden === false, JSON.stringify({ src: navigationState.srcPath, width: navigationState.naturalWidth }));
} catch (error) {
	if (!error?.deferredComplete) {
		check('harness', 'the browser run completed without a harness exception', false, String(error.message || error).split('\n')[0].slice(0, 300));
		evidence.error = String(error.message || error).split('\n')[0].slice(0, 300);
		if (send) {
			try {
				evidence.diagnostic = await (async () => {
					const result = await send('Runtime.evaluate', {
						returnByValue: true,
						expression: `(() => ({
							path: location.pathname,
							title: document.title,
							ready: document.readyState,
							status: document.querySelector('#status')?.textContent || '',
							homeFeedHidden: Boolean(document.querySelector('#homeFeed')?.hidden),
							rows: document.querySelectorAll('#homeRows .home-row').length,
							cards: document.querySelectorAll('[data-tellybox-item]').length,
							badCard: (() => {
								const holder = document.querySelector('[data-tellybox-item="${BAD_ID}"]');
								const image = holder?.querySelector('.poster img');
								return {
									exists: Boolean(holder),
									src: image ? new URL(image.src, location.href).pathname : '',
									hidden: image ? Boolean(image.hidden) : null,
									complete: image ? image.complete : null,
									width: image ? image.naturalWidth : null,
									failed: image?.dataset.tellyboxFailed || ''
								};
							})(),
							artworkTrace: (window.__artworkTrace || []).slice(-40),
							homeResponses: window.__homeResponses || [],
							marks: window.__deferredMarks || [],
							bodyText: (document.body?.innerText || '').slice(0, 400)
						}))()`
					});
					return result.result?.value || null;
				})();
			} catch {}
			try { if (recorder) evidence.diagnosticNetwork = recorder.summary(); } catch {}
		}
		exitCode = 1;
	}
} finally {
	try { socket?.close(); } catch {}
	try { child?.kill(); } catch {}
	await sleep(600);
	for (const cleanup of cleanups.reverse()) {
		try { cleanup(); } catch {}
	}
	try { if (profileDir) rmSync(profileDir, { recursive: true, force: true }); } catch {}

	evidence.pageExceptions = pageExceptions.slice(0, 10);
	evidence.logErrors = logErrors.slice(0, 10);
	evidence.assertions = assertions;
	evidence.passed = assertions.length > 0 && assertions.every(entry => entry.pass);
	exitCode = evidence.passed ? 0 : 1;
	evidence.exitCode = exitCode;
	const evidenceFile = join(outDir, (scenario === 'deferred' ? 'browser-deferred-' : 'browser-') + profileName + '.json');
	try {
		writeFileSync(evidenceFile, JSON.stringify(evidence, null, 2) + '\n');
	} catch (error) {
		console.error('Could not write evidence: ' + (error.message || error));
		exitCode = 1;
	}
	const failed = assertions.filter(entry => !entry.pass).length;
	console.log('');
	console.log('ARTWORK-128 ' + scenario + ' ' + profileName + ' ' + viewport.width + 'x' + viewport.height + ': ' +
		(evidence.passed ? 'PASS' : 'FAIL') + ' (' + (assertions.length - failed) + '/' + assertions.length + ' assertions)');
	for (const phase of Object.keys(evidence.phases)) {
		const value = evidence.phases[phase];
		if (!value?.network) continue;
		console.log('  ' + phase + ': home=' + value.network.homeTimingMs + 'ms firstArtwork=' + value.network.firstArtworkTimingMs +
			'ms requests=' + value.network.totalRequests + ' homeRequests=' + value.network.homeRequests +
			' artRequests=' + (value.network.providerArtworkRequests + value.network.tmdbArtworkRequests) +
			' 404s=' + value.network.notFoundResponses + ' bytes=' + value.network.encodedBytes +
			' seerrDelta=' + (value.seerr.delta ?? ((value.seerr.after ?? 0) - (value.seerr.before ?? 0))));
	}
	console.log('  evidence: ' + evidenceFile);
	process.exit(exitCode);
}
