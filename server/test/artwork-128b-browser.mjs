/* ARTWORK-128B - real-browser acceptance evidence (owner C).
 *
 * Starts the synthetic loopback fixture (real server.mjs plus fake Dispatcharr,
 * Seerr and Jellyfin) and drives the unmodified public app in headless Chrome.
 * Every Home/Discover request goes through the real routes; only the external
 * TMDB image host is fulfilled locally with the fixture PNG (loopback evidence,
 * not real provider art). Nothing in the page is mocked.
 *
 * One scenario per Node process so the metadata and in-memory caches are
 * genuinely cold. The `all` scenario spawns one child process per profile.
 *
 *   cd server
 *   $env:ARTWORK128B_PROFILE='desktop'; node test/artwork-128b-browser.mjs home-slow
 *   $env:ARTWORK128B_PROFILE='mobile';  node test/artwork-128b-browser.mjs home-slow
 *   node test/artwork-128b-browser.mjs all
 *
 * Scenarios:
 *   home-slow            5.2 s metadata lookup, no click/manual API loop
 *   home-36              36 streamed candidates, instant metadata
 *   mixed-nav            details open/close, same-doc Home, Discover->Home, warm
 *   continue-change      browser progress/watched -> real Home click context refresh
 *   real-artwork-preview saved public poster bytes served by the TMDB route
 *   restart-budget       controlled restart:true probe (frontend only)
 *   discover-cold-warm   5 providers, Netflix delayed 2.5 s, reload warm
 *   discover-degraded    Seerr Discover down, honest error + retry recovery
 *   discover-restart-write / discover-restart-read  two-process disk restart
 *   all                  orchestrates the list above (desktop + mobile)
 *
 * EVIDENCE_DIR overrides outputs/Tellybox-artwork-128/evidence-128b/.
 * CHROME_PATH overrides Chrome discovery. If Chrome is unavailable every
 * scenario prints SKIP and exits 0; no pass is ever claimed without a render.
 *
 * No production access, deployment, restart, provider change or product edit.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { release, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { png, startArtworkFixture } from './artwork-128-fixture.mjs';

const scriptPath = fileURLToPath(import.meta.url);
const scenario = String(process.argv[2] || process.env.ARTWORK128B_SCENARIO || 'all').trim().toLowerCase();
const profileName = String(process.argv[3] || process.env.ARTWORK128B_PROFILE || 'desktop').trim().toLowerCase();
const VIEWPORTS = {
	desktop: { width: 1440, height: 900, mobile: false },
	mobile: { width: 390, height: 844, mobile: true }
};
const outDir = process.env.EVIDENCE_DIR
	? process.env.EVIDENCE_DIR.replace(/[\\/]$/, '')
	: fileURLToPath(new URL('../../outputs/Tellybox-artwork-128/evidence-128b/', import.meta.url));
const restartDir = process.env.ARTWORK128B_RESTART_DIR
	? process.env.ARTWORK128B_RESTART_DIR.replace(/[\\/]$/, '')
	: join(outDir, 'restart-cache');
const RESTART_SEERR_PORT = 39471;
const SCENARIOS = ['home-slow', 'home-36', 'mixed-nav', 'continue-change', 'real-artwork-preview', 'restart-budget', 'discover-cold-warm', 'discover-degraded', 'discover-restart-write', 'discover-restart-read'];
const ORCHESTRATED = [
	['home-slow', 'desktop'], ['home-slow', 'mobile'],
	['home-36', 'desktop'], ['home-36', 'mobile'],
	['mixed-nav', 'desktop'], ['mixed-nav', 'mobile'],
	['continue-change', 'desktop'], ['continue-change', 'mobile'],
	['discover-cold-warm', 'desktop'], ['discover-cold-warm', 'mobile'],
	['discover-degraded', 'desktop'], ['discover-degraded', 'mobile'],
	['discover-restart-write', 'desktop'], ['discover-restart-read', 'desktop']
];

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const now = () => Math.round(performance.now());

function chromeExecutable() {
	return [
		process.env.CHROME_PATH,
		'C:/Program Files/Google/Chrome/Application/chrome.exe',
		'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
		join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
		'/usr/bin/google-chrome',
		'/usr/bin/google-chrome-stable',
		'/usr/bin/chromium',
		'/usr/bin/chromium-browser',
		'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
	].filter(Boolean).find(candidate => existsSync(candidate));
}

function portFree(port) {
	return new Promise(resolve => {
		const probe = createServer();
		probe.once('error', () => resolve(false));
		probe.listen(port, '127.0.0.1', () => probe.close(() => resolve(true)));
	});
}

// ---------------------------------------------------------------------------
// Chrome DevTools Protocol plumbing
// ---------------------------------------------------------------------------

async function targetFor(port) {
	for (let attempt = 0; attempt < 150; attempt += 1) {
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

function createNetworkRecorder() {
	let phase = 'idle';
	let startedAt = 0;
	let active = false;
	let entries = [];
	let byId = new Map();
	return {
		start(name) {
			phase = name;
			startedAt = Date.now();
			active = true;
		},
		stop() { active = false; },
		request(params) {
			if (!active || byId.has(params.requestId)) return;
			let path = '';
			try { path = new URL(params.request?.url || '').pathname; } catch {}
			const entry = {
				phase,
				url: String(params.request?.url || ''),
				path,
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
			const entry = byId.get(params.requestId);
			if (!entry || !active) return;
			entry.status = Number(params.response?.status) || 0;
			entry.fromCache = Boolean(params.response?.fromDiskCache || params.response?.fromMemoryCache || params.response?.fromServiceWorker);
			entry.mime = String(params.response?.mimeType || '');
			const contentLength = params.response?.headers?.['Content-Length'] ?? params.response?.headers?.['content-length'];
			if (Number.isFinite(Number(contentLength))) entry.contentLength = Number(contentLength);
		},
		finished(params) {
			const entry = byId.get(params.requestId);
			if (!entry) return;
			entry.end = Date.now() - startedAt;
			if (Number.isFinite(params.encodedDataLength)) entry.encodedBytes = params.encodedDataLength;
		},
		failed(params) {
			const entry = byId.get(params.requestId);
			if (!entry) return;
			entry.end = Date.now() - startedAt;
			entry.error = String(params.errorText || 'failed').slice(0, 80);
		},
		snapshot(onlyPhase = phase) {
			return entries.filter(entry => entry.phase === onlyPhase);
		},
		all() { return entries.slice(); }
	};
}

function summarizeNetwork(entries, phase) {
	const mine = entries.filter(entry => entry.phase === phase);
	const home = mine.filter(entry => entry.path === '/api/web/home' && entry.method === 'POST');
	const artwork = mine.filter(entry => entry.path === '/api/web/home/artwork' && entry.method === 'POST');
	const discover = mine.filter(entry => entry.path.startsWith('/api/discover'));
	const images = mine.filter(entry => entry.resourceType === 'Image' || entry.url.startsWith('https://image.tmdb.org/'));
	const notFound = mine.filter(entry => entry.status === 404);
	const encoded = mine.filter(entry => Number.isFinite(entry.encodedBytes)).reduce((sum, entry) => sum + entry.encodedBytes, 0);
	return {
		phase,
		totalRequests: mine.length,
		finishedRequests: mine.filter(entry => entry.end !== null).length,
		encodedBytes: encoded,
		home: {
			count: home.length,
			statuses: home.map(entry => entry.status),
			timings: home.map(entry => ({ start: entry.start, end: entry.end, status: entry.status }))
		},
		artwork: {
			count: artwork.length,
			statuses: artwork.map(entry => entry.status),
			timings: artwork.map(entry => ({ start: entry.start, end: entry.end, status: entry.status }))
		},
		discover: {
			count: discover.length,
			paths: [...new Set(discover.map(entry => entry.path))],
			statuses: discover.map(entry => entry.status)
		},
		images: { count: images.length, paths: [...new Set(images.map(entry => entry.path))].slice(0, 6) },
		notFound: { count: notFound.length, paths: [...new Set(notFound.map(entry => entry.path))].slice(0, 12) },
		firstArtworkEndMs: mine.filter(entry => entry.path.startsWith('/api/web/tmdb-art/') || entry.path.startsWith('/api/web/art/')).map(entry => entry.end).filter(value => value !== null)[0] ?? null,
		firstDiscoverEndMs: discover.map(entry => entry.end).filter(value => value !== null)[0] ?? null
	};
}

// ---------------------------------------------------------------------------
// Page instrumentation (runs before every new document)
// ---------------------------------------------------------------------------

const instrumentation = String.raw`
(() => {
	const state = window.__b128 = {
		fetch: [], skeletonTimes: [], marks: [], firstRowAt: null, authAt: null,
		firstArtworkImageAt: null, imageErrors: 0, homeResponses: 0, artworkResponses: 0
	};
	const originalFetch = window.fetch;
	window.fetch = async function (...args) {
		const first = args[0];
		const raw = typeof first === 'string' ? first : (first && (first.href || first.url)) || '';
		let path = '';
		try { path = new URL(raw, location.href).pathname; } catch {}
		const started = performance.now();
		const entry = { path, at: Math.round(started), status: 0, ms: null, doneAt: null, failed: false };
		state.fetch.push(entry);
		let response;
		try { response = await originalFetch.apply(this, args); }
		catch (error) { entry.failed = true; entry.ms = Math.round(performance.now() - started); entry.doneAt = Math.round(performance.now()); throw error; }
		entry.status = response.status;
		entry.ms = Math.round(performance.now() - started);
		entry.doneAt = Math.round(performance.now());
		if (path === '/api/auth/status' && response.ok) state.authAt = Math.round(performance.now());
		if (path === '/api/web/home') {
			state.homeResponses += 1;
			response.clone().json().then(data => {
				entry.availability = data && data.availability ? data.availability.artwork || null : null;
				entry.rowIds = Array.isArray(data && data.rows) ? data.rows.map(row => row.id) : [];
				entry.itemIds = Array.isArray(data && data.rows) ? data.rows.flatMap(row => (row.items || []).map(item => item && item.Id)).filter(Boolean) : [];
			}).catch(() => {});
		} else if (path === '/api/web/home/artwork') {
			state.artworkResponses += 1;
			response.clone().json().then(data => {
				entry.availability = data && data.availability ? data.availability : null;
				entry.updates = Array.isArray(data && data.updates) ? data.updates.length : 0;
				entry.restart = Boolean(data && data.restart);
			}).catch(() => {});
		} else if (path.startsWith('/api/discover')) {
			response.clone().json().then(data => {
				entry.cacheState = data && data.cacheState || null;
				entry.items = Array.isArray(data && data.items) ? data.items.length : null;
			}).catch(() => {});
		}
		return response;
	};
	state.mark = name => state.marks.push({ name, t: Math.round(performance.now()) });
	document.addEventListener('error', event => {
		if (event.target instanceof HTMLImageElement) {
			state.imageErrors += 1;
			if (!state.firstArtworkImageAt) state.firstArtworkImageAt = Math.round(performance.now());
		}
	}, true);
	let skeleton = false;
	const observer = new MutationObserver(() => {
		if (!state.firstRowAt && document.querySelector('#homeRows [data-tellybox-item]')) {
			state.firstRowAt = Math.round(performance.now());
		}
		const present = Boolean(document.querySelector('#homeRows .home-row--skeleton'));
		if (present && !skeleton) { skeleton = true; state.skeletonTimes.push(Math.round(performance.now())); }
		else if (!present) skeleton = false;
	});
	try { observer.observe(document, { childList: true, subtree: true, attributes: true }); } catch {}
})();
`;

// ---------------------------------------------------------------------------
// Page helpers
// ---------------------------------------------------------------------------

function makePage(send, recorder) {
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
			await sleep(40);
		}
		throw new Error('Timed out waiting for ' + label + ' (last: ' + JSON.stringify(last) + ')');
	};
	const screenshot = async file => {
		const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
		writeFileSync(join(outDir, file), Buffer.from(shot.data, 'base64'));
		return file;
	};
	const navigate = async (url, expected) => {
		await send('Page.navigate', { url });
		await sleep(50);
		await waitFor(`location.href.startsWith(${JSON.stringify(expected)}) && document.readyState === 'complete'`, 20000, 'navigation to ' + expected);
	};
	const reload = async (expected) => {
		await send('Page.reload', { ignoreCache: false });
		await sleep(60);
		await waitFor(`document.readyState === 'complete' && location.href.startsWith(${JSON.stringify(expected)})`, 20000, 'reload of ' + expected);
	};
	const clickElement = async selector => {
		const point = await evaluate(`(() => {
			const element = document.querySelector(${JSON.stringify(selector)});
			if (!element) return null;
			element.scrollIntoView({ block: 'center', inline: 'center' });
			const box = element.getBoundingClientRect();
			return { x: box.x + box.width / 2, y: box.y + box.height / 2, label: (element.getAttribute('aria-label') || element.textContent || '').trim().slice(0, 80) };
		})()`);
		if (!point) throw new Error('Could not find ' + selector);
		await sleep(120);
		const box = await evaluate(`(() => {
			const element = document.querySelector(${JSON.stringify(selector)});
			if (!element) return null;
			const rect = element.getBoundingClientRect();
			return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
		})()`);
		if (!box) throw new Error('Could not re-measure ' + selector);
		await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
		await sleep(20);
		await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
		await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
		return point;
	};
	const clickPoint = async point => {
		await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
		await sleep(20);
		await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
		await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
	};
	// The primary nav is a normal list of links, but it is collapsed behind the
	// Menu button on the mobile layout. A real user opens it before clicking.
	const navPoint = async href => {
		const measure = () => evaluate(`(() => {
			const link = [...document.querySelectorAll('#siteNavigation a[href]')].find(anchor => anchor.getAttribute('href') === ${JSON.stringify(href)});
			if (!link) return null;
			const box = link.getBoundingClientRect();
			const style = getComputedStyle(link);
			return { x: box.x + box.width / 2, y: box.y + box.height / 2, width: box.width, height: box.height, visible: style.display !== 'none' && style.visibility !== 'hidden' && box.width > 0 && box.height > 0 };
		})()`);
		let point = await measure();
		if (!point) return null;
		if (!point.visible) {
			const toggle = await evaluate(`(() => {
				const button = document.querySelector('#menuToggle');
				if (!button) return null;
				const box = button.getBoundingClientRect();
				return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
			})()`);
			if (toggle) {
				await clickPoint(toggle);
				await sleep(220);
				point = await measure();
			}
		}
		return point;
	};
	const prepareNav = async href => {
		const point = await navPoint(href);
		if (!point || !point.visible) throw new Error('Could not find a visible nav link for ' + href);
		return point;
	};
	const clickNav = async href => {
		const point = await prepareNav(href);
		await clickPoint(point);
		return point;
	};
	// On the mobile layout the Menu panel is an overlay. A click can be consumed
	// as the panel settles, so retry the measured real click instead of assuming
	// the first dispatch navigated.
	const clickNavAndWait = async (href, expression, label) => {
		let lastError = null;
		for (let attempt = 0; attempt < 3; attempt += 1) {
			await clickNav(href);
			try {
				await waitFor(expression, 8000, label);
				return;
			} catch (error) {
				lastError = error;
				await sleep(450);
			}
		}
		throw lastError || new Error('Navigation click failed: ' + label);
	};
	const pageNow = () => evaluate('Math.round(performance.now())');
	const fetchLog = () => evaluate('(window.__b128 && window.__b128.fetch) || []');
	const marks = () => evaluate('(window.__b128 && window.__b128.marks) || []');
	const skeletonTimes = () => evaluate('(window.__b128 && window.__b128.skeletonTimes) || []');
	const timeOrigin = () => evaluate('performance.timeOrigin');
	const navigationEntries = () => evaluate("performance.getEntriesByType('navigation').length");
	return { send, evaluate, waitFor, screenshot, navigate, reload, clickElement, clickPoint, clickNav, clickNavAndWait, prepareNav, pageNow, fetchLog, marks, skeletonTimes, timeOrigin, navigationEntries, recorder };
}

const homeRowExpression = `(() => {
	const rows = [...document.querySelectorAll('#homeRows .home-row')];
	const holders = [...document.querySelectorAll('#homeRows [data-tellybox-item]')];
	const ids = [...new Set(holders.map(holder => holder.dataset.tellyboxItem))];
	return {
		rowCount: rows.length,
		rowIds: rows.map(row => (/home-row--([a-z0-9_-]+)/.exec(row.className) || [])[1] || row.className),
		holders: holders.length,
		unique: ids.length,
		ids
	};
})()`;

const decodeExpression = `(() => {
	const holders = [...document.querySelectorAll('#homeRows [data-tellybox-item]')];
	const seen = new Set();
	const pending = [];
	let decoded = 0;
	for (const holder of holders) {
		const id = holder.dataset.tellyboxItem;
		if (seen.has(id)) continue;
		seen.add(id);
		const image = holder.querySelector('.poster img') || holder.querySelector('.continue-art-image');
		if (image && !image.hidden && image.complete && image.naturalWidth > 0) decoded += 1;
		else pending.push(id);
	}
	return { unique: seen.size, decoded, pending: pending.slice(0, 10) };
})()`;

const revealRowsExpression = `(async () => {
	const rows = [...document.querySelectorAll('#homeRows .home-row')];
	for (const row of rows) {
		row.scrollIntoView({ block: 'center', inline: 'nearest' });
		await new Promise(resolve => setTimeout(resolve, 120));
		const scroller = row.querySelector('.home-row-grid') || row;
		if (scroller && scroller.scrollWidth > scroller.clientWidth) {
			scroller.scrollLeft = scroller.scrollWidth;
			await new Promise(resolve => setTimeout(resolve, 160));
			scroller.scrollLeft = 0;
		}
	}
	const host = document.scrollingElement || document.documentElement;
	if (host) host.scrollTop = 0;
	return rows.length;
})()`;

async function waitHomeDecoded(page, timeout, label) {
	const deadline = Date.now() + timeout;
	let last = null;
	while (Date.now() < deadline) {
		try { await page.evaluate(revealRowsExpression); } catch {}
		last = await page.evaluate(decodeExpression);
		if (last.unique > 0 && last.decoded === last.unique) return last;
		await sleep(200);
	}
	const detail = await page.evaluate(`(() => ({
		last: ${JSON.stringify(last)},
		rows: [...document.querySelectorAll('#homeRows .home-row')].map(row => ({ className: row.className, holders: row.querySelectorAll('[data-tellybox-item]').length, ids: [...row.querySelectorAll('[data-tellybox-item]')].map(h => h.dataset.tellyboxItem).slice(0, 4) })),
		pending: [...document.querySelectorAll('#homeRows [data-tellybox-item]')].filter(h => { const i = h.querySelector('.poster img'); return !(i && !i.hidden && i.complete && i.naturalWidth > 0); }).slice(0, 4).map(h => { const i = h.querySelector('.poster img'); return { id: h.dataset.tellyboxItem, src: i ? new URL(i.src, location.href).pathname : '', hidden: i ? Boolean(i.hidden) : null, complete: i ? i.complete : null, width: i ? i.naturalWidth : null, failed: i?.dataset.tellyboxFailed || '' }; }),
		holders: document.querySelectorAll('#homeRows [data-tellybox-item]').length,
		homeHidden: document.querySelector('#homeFeed')?.hidden,
		body: (document.querySelector('#homeFeedStatus')?.textContent || '').slice(0, 120)
	}))()`);
	throw new Error('Timed out waiting for ' + label + ' (' + JSON.stringify(detail) + ')');
}

const discoverTraceExpression = `(() => {
	const parent = document.querySelector('#discoveryFeeds');
	if (!parent) return [];
	const now = Math.round(performance.now());
	const shelves = [...parent.querySelectorAll('section.discovery-shelf')].map(section => ({
		t: now,
		title: section.querySelector('h2')?.textContent || '',
		cards: section.querySelectorAll('.discover-card').length
	}));
	const holders = [...parent.children].filter(child => child.tagName === 'DIV').map(child => (child.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 90));
	return { t: now, shelves, holders, cards: parent.querySelectorAll('.discover-card').length };
})()`;

async function waitShelves(page, count, timeout, label) {
	const deadline = Date.now() + timeout;
	let last = null;
	while (Date.now() < deadline) {
		last = await page.evaluate(discoverTraceExpression);
		if (last && last.shelves.length >= count) return last;
		await sleep(60);
	}
	throw new Error('Timed out waiting for ' + label + ' (' + JSON.stringify(last) + ')');
}

const discoverDecodeExpression = `(() => {
	const images = [...document.querySelectorAll('#discoveryFeeds img, #discoverGrid img')];
	const visible = images.filter(image => {
		const rect = image.getBoundingClientRect();
		return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < innerHeight && rect.right > 0 && rect.left < innerWidth;
	});
	const decoded = visible.filter(image => image.complete && image.naturalWidth > 0);
	return { total: images.length, visible: visible.length, decoded: decoded.length };
})()`;

async function waitDiscoverImages(page, timeout, label) {
	const deadline = Date.now() + timeout;
	let last = null;
	while (Date.now() < deadline) {
		last = await page.evaluate(discoverDecodeExpression);
		if (last && last.visible > 0 && last.decoded === last.visible) return last;
		await sleep(120);
	}
	throw new Error('Timed out waiting for ' + label + ' (' + JSON.stringify(last) + ')');
}

// ---------------------------------------------------------------------------
// Fixture catalogues (synthetic, deterministic)
// ---------------------------------------------------------------------------

const iso = hourOffset => new Date(Date.UTC(2026, 10, 18, 12) - hourOffset * 3600000).toISOString();
const movie = (id, tmdb, name, genre, hour) => ({ id, tmdb_id: tmdb, name, year: 2026, genre, created_at: iso(hour) });

const SLOW_MOVIES = [
	movie(81100, 911001, 'Ashfall', 'Drama', 0),
	movie(81101, 911002, 'Bright Harbour', 'Comedy', 1),
	movie(81102, 911003, 'Cold Meridian', 'Thriller', 2),
	movie(81103, 911004, 'Dust and Glass', 'Action', 3)
];

const BUDGET_GENRES = ['Drama', 'Comedy', 'Action', 'Thriller', 'Family', 'History'];
const BUDGET_MOVIES = Array.from({ length: 36 }, (_, index) =>
	movie(81200 + index, 912000 + index, 'Continuation Film ' + (index + 1), BUDGET_GENRES[index % BUDGET_GENRES.length], index));

const MIXED_MOVIES = [
	movie(81300, 913001, 'The Long Tide', 'Drama', 0),
	movie(81301, 913002, 'Neon Orchard', 'Science Fiction', 1),
	movie(81302, 913003, 'Paper Kingdom', 'Family', 2),
	movie(81303, 913004, 'Last Train North', 'Thriller', 3),
	movie(81304, 913005, 'Amber Room', 'History', 4),
	movie(81305, 913006, 'Weekend Detectives', 'Comedy', 5)
];

// Three catalogue titles deliberately share TMDB ids with the synthetic
// Discover rails, so a cached card can prove current VOD availability is
// recomputed per response rather than persisted.
// Real browser-local Continue signals: one partially watched film and one
// watched marker, then the same film completed on the second Home click.
const CONTINUE_MOVIES = [
	movie(81500, 915001, 'Continue Test One', 'Drama', 0),
	movie(81501, 915002, 'Continue Test Two', 'Comedy', 1),
	movie(81502, 915003, 'Continue Test Three', 'Thriller', 2)
];
const CONTINUE_PROGRESS_ID = 'dispatch-movie-81500';
const CONTINUE_WATCHED_ID = 'dispatch-movie-81501';
const CONTINUE_REMAINING_ID = 'dispatch-movie-81502';

const DISCOVER_MOVIES = [
	movie(81400, 920001, 'Fixture Catalogue Film', 'Drama', 0),
	movie(81401, 920081, 'Netflix Catalogue Film', 'Action', 1),
	movie(81402, 925311, 'Paramount Catalogue Film', 'Thriller', 2),
	movie(81403, 930001, 'Unrelated Catalogue Film One', 'Comedy', 3),
	movie(81404, 930002, 'Unrelated Catalogue Film Two', 'Family', 4),
	movie(81405, 930003, 'Unrelated Catalogue Film Three', 'History', 5)
];

// ---------------------------------------------------------------------------
// Evidence collection
// ---------------------------------------------------------------------------

function newEvidence(childProfile, extra = {}) {
	const viewport = VIEWPORTS[childProfile] || VIEWPORTS.desktop;
	return {
		scenario,
		profile: childProfile,
		viewport: { width: viewport.width, height: viewport.height, mobile: viewport.mobile },
		fixtureOnly: true,
		externalProviderUsed: false,
		externalImages: 'https://image.tmdb.org/* fulfilled locally with the fixture PNG by CDP',
		environment: {
			os: process.platform + ' ' + release(),
			node: process.version,
			chrome: '',
			headless: true
		},
		assertions: [],
		phases: {},
		pageExceptions: [],
		logErrors: [],
		screenshots: [],
		limitations: [
			'Synthetic loopback catalogue; no production provider, credential or network was used.',
			'TMDB artwork and Discover posters are the fixture PNG, not real provider images.',
			'This is staged code evidence only; it does not claim production or rollout readiness.'
		],
		...extra
	};
}

function check(evidence, phase, name, pass, detail = '') {
	evidence.assertions.push({ phase, name, pass: Boolean(pass), detail });
	console.log((pass ? 'PASS ' : 'FAIL ') + phase + ': ' + name + (detail ? ' - ' + detail : ''));
}

// ---------------------------------------------------------------------------
// Home scenarios
// ---------------------------------------------------------------------------

async function scenarioHomeSlow(page, fixture, evidence) {
	fixture.calls.setMode('slow', 5200);
	page.recorder.start('home-slow');
	await page.navigate(fixture.base + '/', fixture.base + '/');
	await page.waitFor("document.readyState === 'complete'", 15000, 'page load');
	await page.waitFor("document.querySelectorAll('#homeRows [data-tellybox-item]').length > 0", 15000, 'Home rows');
	const rows = await page.evaluate(homeRowExpression);
	const initialLog = await page.fetchLog();
	const homeEntry = initialLog.filter(entry => entry.path === '/api/web/home').sort((a, b) => a.at - b.at)[0];
	const initial = homeEntry?.availability || null;
	const target = rows.ids[0];
	const targetSelector = `[data-tellybox-item="${target}"]`;
	const initialCard = await page.evaluate(`(() => {
		const holder = document.querySelector(${JSON.stringify(targetSelector)});
		const image = holder?.querySelector('.poster img');
		return { id: ${JSON.stringify(target)}, src: image ? new URL(image.src, location.href).pathname : '', hidden: image ? Boolean(image.hidden) : null, width: image ? image.naturalWidth : 0 };
	})()`);
	await page.waitFor(`(() => {
		const holder = document.querySelector(${JSON.stringify(targetSelector)});
		const image = holder?.querySelector('.poster img');
		return Boolean(image && !image.hidden && image.complete && image.naturalWidth > 0);
	})()`, 18000, 'the first card image to decode');
	const firstDecodeAt = await page.pageNow();
	await waitHomeDecoded(page, 10000, 'every visible Home card to decode');
	const allDecodeAt = await page.pageNow();
	await page.evaluate(revealRowsExpression);
	await page.evaluate("window.scrollTo(0, 0)");
	await sleep(250);
	const countsBefore = await page.fetchLog();
	const network = summarizeNetwork(page.recorder.all(), 'home-slow');
	page.recorder.stop();
	await sleep(3600);
	const countsAfter = await page.fetchLog();
	const finalLog = countsAfter;
	const homePosts = finalLog.filter(entry => entry.path === '/api/web/home').length;
	const artworkPosts = finalLog.filter(entry => entry.path === '/api/web/home/artwork').length;
	const settledHome = countsAfter.filter(entry => entry.path === '/api/web/home').length;
	const settledArtwork = countsAfter.filter(entry => entry.path === '/api/web/home/artwork').length;
	const artworkWithUpdates = finalLog.filter(entry => entry.path === '/api/web/home/artwork' && entry.updates > 0);
	const finalArtworkAvailability = finalLog.filter(entry => entry.path === '/api/web/home/artwork' && entry.availability).map(entry => entry.availability).at(-1) || null;
	const shot = await page.screenshot('home-slow-' + evidence.profile + '.png');
	evidence.screenshots.push(shot);
	evidence.phases['home-slow'] = {
		rows,
		metadataDelayMs: 5200,
		initialHome: homeEntry || null,
		initialArtworkAvailability: initial,
		initialCard,
		firstDecodeAt,
		allDecodeAt,
		homePosts,
		artworkPosts,
		artworkWithUpdates: artworkWithUpdates.map(entry => ({ at: entry.at, updates: entry.updates, remaining: entry.availability?.remaining })),
		finalArtworkAvailability,
		settledRequests: {
			beforeSleep: {
				home: countsBefore.filter(entry => entry.path === '/api/web/home').length,
				artwork: countsBefore.filter(entry => entry.path === '/api/web/home/artwork').length
			},
			afterSleep: { home: settledHome, artwork: settledArtwork }
		},
		network,
		screenshot: shot
	};
	check(evidence, 'home-slow', 'the real Home route responded 200', network.home.statuses.includes(200), JSON.stringify(network.home.statuses));
	check(evidence, 'home-slow', 'cold Home did not block on the 5.2 s lookup', Number(homeEntry?.ms) < 2000, 'home response ' + homeEntry?.ms + 'ms');
	check(evidence, 'home-slow', 'the unresolved card was reported as remaining', Number(initial?.remaining) >= 1, JSON.stringify(initial));
	check(evidence, 'home-slow', 'the first card image decoded without a details click or manual API loop', firstDecodeAt <= 16000, 'decode at ' + firstDecodeAt + 'ms (app budget ~24.4 s)');
	const finalDecode = await page.evaluate(decodeExpression);
	check(evidence, 'home-slow', 'every visible card image eventually decoded', allDecodeAt <= 24000, JSON.stringify({ ...finalDecode, allDecodeAt }));
	check(evidence, 'home-slow', 'the bounded artwork continuation delivered the late artwork', artworkWithUpdates.length >= 1, 'responses with updates: ' + artworkWithUpdates.length);
	check(evidence, 'home-slow', 'artwork checks stayed within the five-attempt budget', artworkPosts >= 1 && artworkPosts <= 5, 'artwork POSTs: ' + artworkPosts);
	check(evidence, 'home-slow', 'Home POSTs stayed tiny (initial plus allowed reconcile)', homePosts <= 2, 'home POSTs: ' + homePosts);
	check(evidence, 'home-slow', 'polling stopped after completion (no infinite loop)', countsBefore.filter(entry => entry.path === '/api/web/home/artwork').length === settledArtwork && countsBefore.filter(entry => entry.path === '/api/web/home').length === settledHome, JSON.stringify({ before: { home: countsBefore.filter(entry => entry.path === '/api/web/home').length, artwork: countsBefore.filter(entry => entry.path === '/api/web/home/artwork').length }, after: { home: settledHome, artwork: settledArtwork } }));
}

async function scenarioHome36(page, fixture, evidence) {
	// A 300 ms synthetic lookup is still effectively instant next to the 5.2 s
	// scenario, but it keeps the startup favourites reconcile from sometimes
	// resolving every card before the bounded continuation can observe the
	// unrequested remainder. The 36-vs-24 budget premise is unchanged.
	fixture.calls.setMode('ok', 300);
	evidence.fixture.metadataDelayMs = 300;
	page.recorder.start('home-36');
	await page.navigate(fixture.base + '/', fixture.base + '/');
	await page.waitFor("document.readyState === 'complete'", 15000, 'page load');
	await page.waitFor("document.querySelectorAll('#homeRows [data-tellybox-item]').length > 0", 15000, 'Home rows');
	await page.waitFor("(window.__b128.fetch || []).some(entry => entry.path === '/api/web/home' && entry.availability)", 10000, 'the initial availability payload');
	const rows = await page.evaluate(homeRowExpression);
	const initial = await page.evaluate(`(() => {
		const entry = (window.__b128.fetch || []).filter(item => item.path === '/api/web/home' && item.availability).sort((a, b) => a.at - b.at)[0];
		return entry ? entry.availability : null;
	})()`);
	const allDecoded = await waitHomeDecoded(page, 20000, 'all 36-candidate visible cards');
	await page.evaluate(revealRowsExpression);
	await page.evaluate('window.scrollTo(0, 0)');
	await sleep(3000);
	const logAtSettle = await page.fetchLog();
	const network = summarizeNetwork(page.recorder.all(), 'home-36');
	page.recorder.stop();
	await sleep(3200);
	const logAfter = await page.fetchLog();
	const homePosts = logAfter.filter(entry => entry.path === '/api/web/home').length;
	const artworkPosts = logAfter.filter(entry => entry.path === '/api/web/home/artwork').length;
	const artworkResponses = logAfter.filter(entry => entry.path === '/api/web/home/artwork');
	const finalAvailability = artworkResponses.filter(entry => entry.availability).map(entry => entry.availability).at(-1) || null;
	const shot = await page.screenshot('home-36-' + evidence.profile + '.png');
	evidence.screenshots.push(shot);
	evidence.phases['home-36'] = {
		catalogueTitles: fixture.rows.length,
		metadataDelayMs: 300,
		rows,
		initialArtworkAvailability: initial,
		allDecoded,
		homePosts,
		artworkPosts,
		homeAttempts: logAfter.filter(entry => entry.path === '/api/web/home').map(entry => ({ at: entry.at, doneAt: entry.doneAt, status: entry.status, availability: entry.availability })),
		artworkAttempts: artworkResponses.map(entry => ({ at: entry.at, status: entry.status, updates: entry.updates, availability: entry.availability })),
		finalArtworkAvailability: finalAvailability,
		settledRequests: {
			beforeSleep: {
				home: logAtSettle.filter(entry => entry.path === '/api/web/home').length,
				artwork: logAtSettle.filter(entry => entry.path === '/api/web/home/artwork').length
			},
			afterSleep: ({ home: homePosts, artwork: artworkPosts })
		},
		network,
		screenshot: shot
	};
	check(evidence, 'home-36', 'the fixture supplied 36 unique streamed titles', fixture.rows.length === 36, String(fixture.rows.length));
	check(evidence, 'home-36', 'Home reported unrequested visible artwork work', Number(initial?.remaining) > 0, JSON.stringify(initial));
	check(evidence, 'home-36', 'the initial response spent the bounded 24-card budget', Number(initial?.requested) === 24 || Number(initial?.pending) === 24, JSON.stringify(initial));
	check(evidence, 'home-36', 'the artwork continuation was used for the remaining candidates', artworkPosts >= 1 && artworkPosts <= 5, 'artwork POSTs: ' + artworkPosts);
	check(evidence, 'home-36', 'every card the Home renderer displays decoded', allDecoded.unique >= 12 && allDecoded.decoded === allDecoded.unique, JSON.stringify({ ...allDecoded, serverVisible: initial?.visible, note: 'the Home renderer keeps only continue/new-episodes/for-you/new and dedupes across rows' }));
	check(evidence, 'home-36', 'the remaining count settled to zero', Number(finalAvailability?.remaining) === 0, JSON.stringify(finalAvailability));
	check(evidence, 'home-36', 'no full Home re-POST per artwork check', homePosts <= 2, 'home POSTs: ' + homePosts + ', artwork POSTs: ' + artworkPosts);
	check(evidence, 'home-36', 'no unbounded polling after settle', logAtSettle.filter(entry => entry.path === '/api/web/home/artwork').length === artworkPosts && logAtSettle.filter(entry => entry.path === '/api/web/home').length === homePosts, JSON.stringify({ before: logAtSettle.filter(entry => entry.path === '/api/web/home/artwork').length, after: artworkPosts }));
}

// ---------------------------------------------------------------------------
// Continue watching changes through the real Home click
// ---------------------------------------------------------------------------

async function scenarioContinueChange(page, fixture, evidence) {
	fixture.calls.setMode('ok', 0);
	page.recorder.start('continue-change');
	await page.navigate(fixture.base + '/', fixture.base + '/');
	await page.waitFor("document.readyState === 'complete'", 15000, 'page load');
	await page.waitFor("document.querySelectorAll('#homeRows [data-tellybox-item]').length > 0", 15000, 'Home rows');
	await page.waitFor("(window.__b128.fetch || []).some(entry => entry.path === '/api/web/home' && entry.availability)", 10000, 'the initial Home availability');
	await waitHomeDecoded(page, 15000, 'the initial Home cards');
	const baseline = await page.evaluate(homeRowExpression);
	const homeCount = async () => (await page.fetchLog()).filter(entry => entry.path === '/api/web/home').length;
	const artworkCount = async () => (await page.fetchLog()).filter(entry => entry.path === '/api/web/home/artwork').length;

	// --- 1. Browser-local progress + an unrelated watched marker ------------
	// Open any collapsed mobile Menu first: that real click focuses the window
	// and can run the existing focus refresh. The local signals and the measured
	// Home click then happen afterwards, so the context change is caused by the
	// Home click itself on both layouts.
	const progressNav = await page.prepareNav('/');
	const localSignals = await page.evaluate(`(() => {
		localStorage.setItem('jimbo-progress-${CONTINUE_PROGRESS_ID}', '120');
		localStorage.setItem('tellybox-watched-${CONTINUE_WATCHED_ID}', 'true');
		return {
			progress: localStorage.getItem('jimbo-progress-${CONTINUE_PROGRESS_ID}'),
			watched: localStorage.getItem('tellybox-watched-${CONTINUE_WATCHED_ID}')
		};
	})()`);

	// --- 2. Real same-document Home click refreshes the context -------------
	const step1HomeBefore = await homeCount();
	const step1Origin = await page.timeOrigin();
	await page.evaluate("window.__b128.skeletonTimes = []; window.__b128.mark('continue-home-1')");
	const step1ClickAt = await page.pageNow();
	await page.clickPoint(progressNav);
	const continueRow = await page.waitFor(`(() => {
		const row = document.querySelector('#homeRows .home-row--continue');
		const holder = row?.querySelector('[data-tellybox-item="${CONTINUE_PROGRESS_ID}"]');
		return holder ? {
			t: Math.round(performance.now()),
			rowClass: row.className,
			title: row.querySelector('h2')?.textContent || '',
			ids: [...row.querySelectorAll('[data-tellybox-item]')].map(node => node.dataset.tellyboxItem),
			src: holder.querySelector('.continue-art-image') ? new URL(holder.querySelector('.continue-art-image').src, location.href).pathname : '',
			naturalWidth: holder.querySelector('.continue-art-image')?.naturalWidth || 0
		} : false;
	})()`, 12000, 'the Continue watching row for the progressed film');
	await page.waitFor(`(() => {
		const image = document.querySelector('#homeRows .home-row--continue [data-tellybox-item="${CONTINUE_PROGRESS_ID}"] .continue-art-image');
		return Boolean(image && image.complete && image.naturalWidth > 0);
	})()`, 12000, 'the Continue card artwork');
	const continueDecodeAt = await page.pageNow();
	const step1Refresh = await page.waitFor(`(() => {
		const entry = (window.__b128.fetch || []).filter(item => item.path === '/api/web/home' && item.rowIds && Number(item.at) >= ${step1ClickAt - 30}).sort((a, b) => b.at - a.at)[0];
		return entry ? { at: entry.at, status: entry.status, rowIds: entry.rowIds, availability: entry.availability } : false;
	})()`, 12000, 'the Home context refresh after the first click');
	await page.waitFor(`(() => {
		const image = document.querySelector('#homeRows .home-row:not(.home-row--continue) .poster img');
		return Boolean(image && !image.hidden && image.complete && image.naturalWidth > 0);
	})()`, 12000, 'the first normal Home poster after the first click');
	const step1PosterAt = await page.pageNow();
	await waitHomeDecoded(page, 12000, 'all Home cards after the first click');
	const step1 = await page.evaluate(homeRowExpression);
	const step1ContinueIds = await page.evaluate("(() => { const row = document.querySelector('#homeRows .home-row--continue'); return row ? [...row.querySelectorAll('[data-tellybox-item]')].map(node => node.dataset.tellyboxItem) : []; })()");
	const step1HomeAfter = await homeCount();
	const step1ArtworkAfter = await artworkCount();
	const step1OriginAfter = await page.timeOrigin();
	const step1Navigations = await page.navigationEntries();
	await page.evaluate(revealRowsExpression);
	await page.evaluate('window.scrollTo(0, 0)');
	await sleep(250);
	const step1Shot = await page.screenshot('continue-change-progress-' + evidence.profile + '.png');
	evidence.screenshots.push(step1Shot);

	// --- 3. Complete the film, drop its progress, click Home again ----------
	const watchedNav = await page.prepareNav('/');
	const completedSignals = await page.evaluate(`(() => {
		localStorage.removeItem('jimbo-progress-${CONTINUE_PROGRESS_ID}');
		localStorage.setItem('tellybox-watched-${CONTINUE_PROGRESS_ID}', 'true');
		return {
			progress: localStorage.getItem('jimbo-progress-${CONTINUE_PROGRESS_ID}'),
			watched: localStorage.getItem('tellybox-watched-${CONTINUE_PROGRESS_ID}')
		};
	})()`);
	const step2HomeBefore = await homeCount();
	const step2Origin = await page.timeOrigin();
	await page.evaluate("window.__b128.skeletonTimes = []; window.__b128.mark('continue-home-2')");
	const step2ClickAt = await page.pageNow();
	await page.clickPoint(watchedNav);
	const step2Refresh = await page.waitFor(`(() => {
		const entry = (window.__b128.fetch || []).filter(item => item.path === '/api/web/home' && item.rowIds && Number(item.at) >= ${step2ClickAt - 30}).sort((a, b) => b.at - a.at)[0];
		return entry ? { at: entry.at, status: entry.status, rowIds: entry.rowIds, availability: entry.availability } : false;
	})()`, 12000, 'the Home context refresh after the second click');
	const removedAt = await page.waitFor(`(() => {
		const remaining = document.querySelector('#homeRows [data-tellybox-item="${CONTINUE_REMAINING_ID}"] .poster img');
		const decoded = Boolean(remaining && !remaining.hidden && remaining.complete && remaining.naturalWidth > 0);
		const row = document.querySelector('#homeRows .home-row--continue');
		const progressed = document.querySelector('#homeRows [data-tellybox-item="${CONTINUE_PROGRESS_ID}"]');
		const watched = document.querySelector('#homeRows [data-tellybox-item="${CONTINUE_WATCHED_ID}"]');
		return decoded && !row && !progressed && !watched ? Math.round(performance.now()) : false;
	})()`, 12000, 'the Continue row to disappear after the film was watched');
	await waitHomeDecoded(page, 12000, 'all remaining Home cards after the second click');
	const step2 = await page.evaluate(homeRowExpression);
	const step2HomeAfter = await homeCount();
	const step2ArtworkAfter = await artworkCount();
	const step2OriginAfter = await page.timeOrigin();
	const step2Navigations = await page.navigationEntries();
	await page.evaluate(revealRowsExpression);
	await page.evaluate('window.scrollTo(0, 0)');
	await sleep(250);
	const step2Shot = await page.screenshot('continue-change-watched-' + evidence.profile + '.png');
	evidence.screenshots.push(step2Shot);

	const countsAtEnd = { home: step2HomeAfter, artwork: step2ArtworkAfter };
	await sleep(2400);
	const countsAfterSleep = { home: await homeCount(), artwork: await artworkCount() };
	const network = summarizeNetwork(page.recorder.all(), 'continue-change');
	page.recorder.stop();
	const fixtureIds = new Set(fixture.rows.map(row => 'dispatch-movie-' + row.id));
	const step1OnlyFixture = step1.ids.length > 0 && step1.ids.every(id => fixtureIds.has(id));
	const step2OnlyFixture = step2.ids.length > 0 && step2.ids.every(id => fixtureIds.has(id));
	evidence.phases['continue-change'] = {
		baseline,
		localSignals,
		completedSignals,
		step1: {
			clickAt: step1ClickAt,
			continueRow,
			continueAtMs: continueRow.t - step1ClickAt,
			continueDecodeAtMs: continueDecodeAt - step1ClickAt,
			firstPosterAtMs: step1PosterAt - step1ClickAt,
			refresh: step1Refresh,
			homePostsBefore: step1HomeBefore,
			homePostsAfter: step1HomeAfter,
			homePostDelta: step1HomeAfter - step1HomeBefore,
			artworkPosts: step1ArtworkAfter,
			sameDocument: step1Origin === step1OriginAfter && step1Navigations === 1,
			navigationEntries: step1Navigations,
			rows: step1,
			continueIds: step1ContinueIds,
			watchedAbsent: !step1.ids.includes(CONTINUE_WATCHED_ID),
			screenshot: step1Shot
		},
		step2: {
			clickAt: step2ClickAt,
			refresh: step2Refresh,
			continueGoneAtMs: removedAt - step2ClickAt,
			homePostsBefore: step2HomeBefore,
			homePostsAfter: step2HomeAfter,
			homePostDelta: step2HomeAfter - step2HomeBefore,
			artworkPosts: step2ArtworkAfter,
			sameDocument: step2Origin === step2OriginAfter && step2Navigations === 1,
			navigationEntries: step2Navigations,
			rows: step2,
			screenshot: step2Shot
		},
		settledRequests: { beforeSleep: countsAtEnd, afterSleep: countsAfterSleep },
		network
	};

	check(evidence, 'continue-change', 'the baseline Home rendered all three fixture films', baseline.ids.length === 3 && baseline.ids.every(id => fixtureIds.has(id)), JSON.stringify(baseline.ids));
	check(evidence, 'continue-change', 'the real Home click refreshed the context and showed Continue watching', continueRow.title === 'Continue watching' && step1ContinueIds.includes(CONTINUE_PROGRESS_ID), JSON.stringify({ title: continueRow.title, continueIds: step1ContinueIds, refresh: step1Refresh.rowIds }));
	check(evidence, 'continue-change', 'the first click stayed in the same document', step1Origin === step1OriginAfter && step1Navigations === 1, JSON.stringify({ before: step1Origin, after: step1OriginAfter, navigationEntries: step1Navigations }));
	check(evidence, 'continue-change', 'the Continue card artwork decoded', continueRow.naturalWidth > 0, JSON.stringify({ src: continueRow.src, naturalWidth: continueRow.naturalWidth, at: continueRow.t - step1ClickAt }));
	check(evidence, 'continue-change', 'the unrelated watched marker was absent from every Home row', !step1.ids.includes(CONTINUE_WATCHED_ID), JSON.stringify(step1.ids));
	check(evidence, 'continue-change', 'the first click painted only fixture titles', step1OnlyFixture, JSON.stringify(step1.ids));
	// A real click also triggers the existing focus/favourites refresh in this
	// app, so the context POST can be followed by up to two bounded refreshes.
	check(evidence, 'continue-change', 'the first click used bounded context Home POSTs', step1HomeAfter - step1HomeBefore >= 1 && step1HomeAfter - step1HomeBefore <= 3, JSON.stringify({ before: step1HomeBefore, after: step1HomeAfter, contextRefreshAt: step1Refresh.at }));
	check(evidence, 'continue-change', 'the completed film removed Continue watching and itself', !step2.rowIds.includes('continue') && !step2.ids.includes(CONTINUE_PROGRESS_ID) && !step2.ids.includes(CONTINUE_WATCHED_ID), JSON.stringify({ rows: step2.rowIds, ids: step2.ids }));
	check(evidence, 'continue-change', 'the Home feed stayed usable with the remaining film', step2.ids.includes(CONTINUE_REMAINING_ID) && step2OnlyFixture, JSON.stringify(step2.ids));
	check(evidence, 'continue-change', 'the second click used one bounded context Home POST', step2HomeAfter - step2HomeBefore >= 1 && step2HomeAfter - step2HomeBefore <= 2, JSON.stringify({ before: step2HomeBefore, after: step2HomeAfter }));
	check(evidence, 'continue-change', 'the second click stayed in the same document', step2Origin === step2OriginAfter && step2Navigations === 1, JSON.stringify({ before: step2Origin, after: step2OriginAfter, navigationEntries: step2Navigations }));
	check(evidence, 'continue-change', 'artwork polling stayed within the five-attempt budget', step2ArtworkAfter >= 0 && step2ArtworkAfter <= 5, 'artwork POSTs: ' + step2ArtworkAfter);
	check(evidence, 'continue-change', 'no polling continued after the final render', countsAtEnd.home === countsAfterSleep.home && countsAtEnd.artwork === countsAfterSleep.artwork, JSON.stringify({ countsAtEnd, countsAfterSleep }));
}

// ---------------------------------------------------------------------------
// Mixed Home, details and navigation scenario
// ---------------------------------------------------------------------------

async function scenarioMixedNav(page, fixture, evidence) {
	fixture.calls.setMode('slow', 4200);
	page.recorder.start('mixed');
	await page.navigate(fixture.base + '/', fixture.base + '/');
	await page.waitFor("document.readyState === 'complete'", 15000, 'page load');
	await page.waitFor("document.querySelectorAll('#homeRows [data-tellybox-item]').length > 0", 15000, 'Home rows');
	await page.waitFor("(window.__b128.fetch || []).some(entry => entry.path === '/api/web/home' && entry.availability)", 10000, 'the initial Home availability');
	// The first input in this window triggers the existing focus refresh and the
	// favourites reconcile. Let those startup renders settle so a real click on a
	// measured tile cannot land on a sibling that replaced it mid-render. The
	// metadata lookup is still 4.2 s away, so artwork remains unresolved.
	let quiet = -1;
	for (let attempt = 0; attempt < 30; attempt += 1) {
		const count = (await page.fetchLog()).filter(entry => entry.path === '/api/web/home').length;
		if (count >= 2 && count === quiet) break;
		quiet = count;
		await sleep(250);
	}
	await sleep(350);
	const before = await page.evaluate(homeRowExpression);
	const mixedPaint = await page.evaluate("({ authAt: window.__b128 && window.__b128.authAt || null, firstRowAt: window.__b128 && window.__b128.firstRowAt || null })");
	const beforeOrigin = await page.timeOrigin();
	// The first rendered card. With this compact fixture it is fully visible at
	// scrollLeft 0, so the real click needs no horizontal scrolling and cannot
	// race the rail's scroll position.
	const target = before.ids[0];
	const targetSelector = `[data-tellybox-item="${target}"]`;
	const initialCard = await page.evaluate(`(() => {
		const holder = document.querySelector(${JSON.stringify(targetSelector)});
		const image = holder?.querySelector('.poster img');
		const button = holder?.closest('.home-tile')?.querySelector('.home-info');
		button?.scrollIntoView({ block: 'center', inline: 'center' });
		return { id: ${JSON.stringify(target)}, src: image ? new URL(image.src, location.href).pathname : '', width: image ? image.naturalWidth : 0, button: Boolean(button) };
	})()`);
	if (!initialCard.button) throw new Error('The target card has no More info button');
	let morePoint = null;
	const measureDeadline = Date.now() + 5000;
	while (!morePoint && Date.now() < measureDeadline) {
		const candidate = await page.evaluate(`(() => {
			const holder = document.querySelector(${JSON.stringify(targetSelector)});
			const button = holder?.closest('.home-tile')?.querySelector('.home-info');
			if (!button) return null;
			button.scrollIntoView({ block: 'center', inline: 'center' });
			const box = button.getBoundingClientRect();
			const x = box.x + box.width / 2, y = box.y + box.height / 2;
			const hit = document.elementFromPoint(x, y);
			const tile = hit?.closest?.('.home-tile');
			return { x, y, hit: tile?.querySelector('[data-tellybox-item]')?.dataset.tellyboxItem || '', onButton: Boolean(hit?.closest?.('.home-info')), label: button.getAttribute('aria-label') || '' };
		})()`);
		if (candidate && candidate.hit === target && candidate.onButton) morePoint = candidate;
		else await sleep(120);
	}
	if (!morePoint) throw new Error('Could not measure a stable More info button for ' + target);
	const openedAt = await page.pageNow();
	await page.clickPoint(morePoint);
	await page.waitFor("document.querySelector('#details')?.open === true", 8000, 'the details dialog');
	await sleep(250);
	const detailsTarget = await page.evaluate(`(() => {
		const entry = (window.__b128.fetch || []).filter(item => String(item.path || '').startsWith('/api/web/items/') && Number(item.at) >= ${openedAt - 30}).sort((a, b) => a.at - b.at)[0];
		return entry ? entry.path.split('/').pop() : '';
	})()`);
	if (detailsTarget !== target) throw new Error('The real More info click opened ' + (detailsTarget || 'no dialog') + ' instead of ' + target);
	const expectedTitle = fixture.rows.find(row => 'dispatch-movie-' + row.id === target)?.name || '';
	const detailsTitle = await page.waitFor("document.querySelector('#detailsTitle')?.textContent || ''", 12000, 'the details title');
	const updateWhileOpen = await page.waitFor(`(() => {
		const entries = (window.__b128.fetch || []).filter(entry => entry.path === '/api/web/home/artwork' && Number(entry.updates) > 0 && Number(entry.at) >= ${openedAt});
		return entries.length ? entries : false;
	})()`, 18000, 'an artwork update while the details dialog is open');
	const whileOpen = await page.evaluate(`(() => {
		const holder = document.querySelector(${JSON.stringify(targetSelector)});
		const image = holder?.querySelector('.poster img');
		return { open: Boolean(document.querySelector('#details')?.open), src: image ? new URL(image.src, location.href).pathname : '', width: image ? image.naturalWidth : 0, hidden: image ? Boolean(image.hidden) : null };
	})()`);
	await page.clickElement('#closeDetails');
	await page.waitFor("document.querySelector('#details')?.open === false", 8000, 'details to close');
	await page.waitFor(`(() => {
		const holder = document.querySelector(${JSON.stringify(targetSelector)});
		const image = holder?.querySelector('.poster img');
		return Boolean(image && !image.hidden && image.complete && image.naturalWidth > 0);
	})()`, 12000, 'the card artwork after closing details');
	const afterClose = await page.evaluate(`(() => {
		const holder = document.querySelector(${JSON.stringify(targetSelector)});
		const image = holder?.querySelector('.poster img');
		return { src: image ? new URL(image.src, location.href).pathname : '', width: image ? image.naturalWidth : 0, hidden: image ? Boolean(image.hidden) : null };
	})()`);
	const afterRows = await page.evaluate(homeRowExpression);
	await waitHomeDecoded(page, 12000, 'all Home cards after closing details');
	const afterOrigin = await page.timeOrigin();
	const afterNavigations = await page.navigationEntries();
	const mixedLog = await page.fetchLog();
	const mixedNetwork = summarizeNetwork(page.recorder.all(), 'mixed');
	const artworkAt = mixedLog.filter(entry => entry.path === '/api/web/home/artwork' && entry.status === 200).map(entry => entry.at);
	const homeAt = mixedLog.filter(entry => entry.path === '/api/web/home' && entry.status === 200).map(entry => entry.at);
	const homeAfterArtwork = Number.isFinite(Math.min(...artworkAt)) ? homeAt.filter(value => value > Math.min(...artworkAt)).length : 0;
	const mixedShot = await page.screenshot('mixed-details-' + evidence.profile + '.png');
	evidence.screenshots.push(mixedShot);
	evidence.phases.mixed = {
		target,
		detailsTarget,
		detailsTitle,
		expectedTitle,
		openedAt,
		initialCard,
		whileOpen,
		afterClose,
		updateWhileOpen: updateWhileOpen.map(entry => ({ at: entry.at, updates: entry.updates, remaining: entry.availability?.remaining })),
		beforeRows: before,
		afterRows,
		authBeforePaint: mixedPaint,
		reload: { sameTimeOrigin: beforeOrigin === afterOrigin, navigationEntries: afterNavigations },
		requests: { homeAt, artworkAt, homeAfterArtwork },
		network: mixedNetwork,
		screenshot: mixedShot
	};
	check(evidence, 'mixed', 'the real mouse click opened the measured card\'s details', detailsTarget === target && detailsTitle === expectedTitle, JSON.stringify({ target, detailsTarget, detailsTitle, expectedTitle }));
	check(evidence, 'mixed', 'artwork resolved while the details dialog stayed open', updateWhileOpen.length >= 1 && whileOpen.open === true, JSON.stringify({ updates: updateWhileOpen.length, open: whileOpen.open }));
	check(evidence, 'mixed', 'the card image was not stale after closing details', afterClose.width > 0 && afterClose.hidden === false && afterClose.src !== initialCard.src, JSON.stringify({ before: initialCard.src, after: afterClose.src, width: afterClose.width }));
	check(evidence, 'mixed', 'Home row identity was preserved across details', before.rowIds.join('|') === afterRows.rowIds.join('|') && afterRows.rowCount === before.rowCount, JSON.stringify({ before: before.rowIds, after: afterRows.rowIds }));
	check(evidence, 'mixed', 'the page never reloaded during details', beforeOrigin === afterOrigin && afterNavigations === 1, JSON.stringify({ sameTimeOrigin: beforeOrigin === afterOrigin, navigationEntries: afterNavigations }));
	check(evidence, 'mixed', 'no full Home re-POST after artwork continuation began', homeAfterArtwork === 0, JSON.stringify({ homeAt, artworkAt, homeAfterArtwork }));
	check(evidence, 'mixed', 'the startup Home POST count stayed bounded', mixedNetwork.home.count <= 4, 'home POSTs: ' + mixedNetwork.home.count + ' (includes the existing focus/favourites reconcile)');
	check(evidence, 'mixed', 'personalized rows were painted only after auth was known', Number.isFinite(mixedPaint.firstRowAt) && Number.isFinite(mixedPaint.authAt) && mixedPaint.firstRowAt >= mixedPaint.authAt, JSON.stringify(mixedPaint));
	check(evidence, 'mixed', 'the first paint contained only fixture titles', before.ids.length > 0 && before.ids.every(id => fixture.rows.some(row => 'dispatch-movie-' + row.id === id)), JSON.stringify(before.ids));

	// --- Same-document view -> real Home nav click --------------------------
	page.recorder.start('same-doc');
	await page.clickNavAndWait('/?view=movies', "document.readyState === 'complete' && location.search.includes('view=movies')", 'the full-document Films view');
	const moviesOrigin = await page.timeOrigin();
	const moviesHomePosts = (await page.fetchLog()).filter(entry => entry.path === '/api/web/home').length;
	const homeNavPoint = await page.prepareNav('/');
	await page.evaluate("window.__b128.skeletonTimes = []; window.__b128.mark('home-click')");
	const clickAt = await page.pageNow();
	const homePostsBefore = (await page.fetchLog()).filter(entry => entry.path === '/api/web/home').length;
	await page.clickPoint(homeNavPoint);
	const firstRow = await page.waitFor("(() => { const holder = document.querySelector('#homeRows [data-tellybox-item]'); return holder ? { t: Math.round(performance.now()), id: holder.dataset.tellyboxItem } : false; })()", 8000, 'the first Home row after the Home click');
	const skeletonAfterClick = (await page.skeletonTimes()).filter(value => value >= clickAt);
	await page.waitFor(`(() => {
		const holder = document.querySelector('#homeRows [data-tellybox-item]');
		const image = holder?.querySelector('.poster img');
		return Boolean(image && !image.hidden && image.complete && image.naturalWidth > 0);
	})()`, 15000, 'the first visible poster after the Home click');
	const firstPoster = await page.pageNow();
	const sameDocRows = await page.evaluate(homeRowExpression);
	const sameDocOrigin = await page.timeOrigin();
	const sameDocHomePosts = (await page.fetchLog()).filter(entry => entry.path === '/api/web/home').length;
	const sameDocNetwork = summarizeNetwork(page.recorder.all(), 'same-doc');
	page.recorder.stop();
	await page.evaluate('window.scrollTo(0, 0)');
	await sleep(250);
	const sameDocShot = await page.screenshot('same-doc-home-' + evidence.profile + '.png');
	evidence.screenshots.push(sameDocShot);
	evidence.phases.sameDocumentView = {
		clickAt,
		firstRow,
		firstPoster,
		firstRowMs: firstRow.t - clickAt,
		firstPosterMs: firstPoster - clickAt,
		skeletonAfterClick,
		homePostsBefore,
		homePostsAfter: sameDocHomePosts,
		homePostsOnMoviesDocument: moviesHomePosts,
		moviesOrigin,
		sameDocOrigin,
		sameDocument: moviesOrigin === sameDocOrigin,
		rows: sameDocRows,
		network: sameDocNetwork,
		screenshot: sameDocShot
	};
	check(evidence, 'same-doc', 'the Home click stayed in the same document', moviesOrigin === sameDocOrigin, JSON.stringify({ before: moviesOrigin, after: sameDocOrigin }));
	check(evidence, 'same-doc', 'the Home click cleared the view from the URL', (await page.evaluate('location.search')) === '', await page.evaluate('location.href'));
	check(evidence, 'same-doc', 'the first Home row rendered quickly', firstRow.t - clickAt <= 600, 'first row in ' + (firstRow.t - clickAt) + 'ms');
	check(evidence, 'same-doc', 'a visible poster decoded', firstPoster - clickAt <= 8000, 'first poster in ' + (firstPoster - clickAt) + 'ms');
	check(evidence, 'same-doc', 'the click made at most the one cold Home request', sameDocHomePosts - homePostsBefore <= 1, JSON.stringify({ before: homePostsBefore, after: sameDocHomePosts, note: 'the ?view=movies document never started a Home feed; warm-return proof is the separate warm phase' }));
	check(evidence, 'same-doc', 'only fixture titles were painted', sameDocRows.ids.every(id => fixture.rows.some(row => 'dispatch-movie-' + row.id === id)), JSON.stringify(sameDocRows.ids.slice(0, 6)));

	// --- Full-document Discover -> Home click -------------------------------
	page.recorder.start('discover-home');
	fixture.calls.setMode('ok', 0);
	await page.clickNavAndWait('/discover', "document.readyState === 'complete' && location.pathname === '/discover'", 'the Discover document');
	const discoverOrigin = await page.timeOrigin();
	const discoverHomePoint = await page.prepareNav('/');
	await page.evaluate("window.__b128.mark('home-click')");
	const discoverClickAt = await page.evaluate('Math.round(performance.timeOrigin + performance.now())');
	await page.clickPoint(discoverHomePoint);
	const discoverFirstRow = await page.waitFor("(() => { const holder = document.querySelector('#homeRows [data-tellybox-item]'); return holder ? { t: Math.round(performance.now()), abs: Math.round(performance.timeOrigin + performance.now()), id: holder.dataset.tellyboxItem } : false; })()", 12000, 'the first Home row after Discover -> Home');
	await page.waitFor(`(() => {
		const holder = document.querySelector('#homeRows [data-tellybox-item]');
		const image = holder?.querySelector('.poster img');
		return Boolean(image && !image.hidden && image.complete && image.naturalWidth > 0);
	})()`, 15000, 'the first visible poster after Discover -> Home');
	const discoverFirstPoster = await page.evaluate('Math.round(performance.timeOrigin + performance.now())');
	const afterDiscoverRows = await page.evaluate(homeRowExpression);
	const discoverPaint = await page.evaluate("({ authAt: window.__b128 && window.__b128.authAt || null, firstRowAt: window.__b128 && window.__b128.firstRowAt || null })");
	const afterDiscoverOrigin = await page.timeOrigin();
	const afterDiscoverNav = await page.navigationEntries();
	const discoverNetwork = summarizeNetwork(page.recorder.all(), 'discover-home');
	page.recorder.stop();
	await sleep(250);
	const discoverShot = await page.screenshot('discover-home-' + evidence.profile + '.png');
	evidence.screenshots.push(discoverShot);
	evidence.phases.discoverHome = {
		discoverClickAt,
		firstRow: discoverFirstRow,
		firstPoster: discoverFirstPoster,
		clickEpoch: discoverClickAt,
		firstRowMs: discoverFirstRow.abs - discoverClickAt,
		firstPosterMs: discoverFirstPoster - discoverClickAt,
		newDocument: discoverOrigin !== afterDiscoverOrigin,
		navigationEntries: afterDiscoverNav,
		rows: afterDiscoverRows,
		authBeforePaint: discoverPaint,
		network: discoverNetwork,
		screenshot: discoverShot
	};
	check(evidence, 'discover-home', 'Discover -> Home used a full document navigation', discoverOrigin !== afterDiscoverOrigin && afterDiscoverNav >= 1, JSON.stringify({ before: discoverOrigin, after: afterDiscoverOrigin }));
	check(evidence, 'discover-home', 'the first Home row rendered after the click', discoverFirstRow.abs - discoverClickAt <= 8000, 'first row in ' + (discoverFirstRow.abs - discoverClickAt) + 'ms');
	check(evidence, 'discover-home', 'a visible poster decoded after the click', discoverFirstPoster - discoverClickAt <= 12000, 'first poster in ' + (discoverFirstPoster - discoverClickAt) + 'ms');
	check(evidence, 'discover-home', 'only fixture titles were painted', afterDiscoverRows.ids.every(id => fixture.rows.some(row => 'dispatch-movie-' + row.id === id)), JSON.stringify(afterDiscoverRows.ids.slice(0, 6)));
	check(evidence, 'discover-home', 'the new Home document painted only after auth was known', Number.isFinite(discoverPaint.firstRowAt) && Number.isFinite(discoverPaint.authAt) && discoverPaint.firstRowAt >= discoverPaint.authAt, JSON.stringify(discoverPaint));

	// --- Warm same-document return after an offscreen first result ----------
	// Delay the Home response at the browser network layer, switch to the real
	// ?view=movies state through the page's own popstate path while the request
	// is in flight, let the first result land offscreen, then click Home.
	page.homeDelayMs = 2200;
	page.recorder.start('warm-offscreen');
	// This phase asserts a cold skeleton while the first Home response is still
	// in flight. A snapshot from an earlier phase would legally paint cards
	// immediately, so clear the Home cache first.
	await page.evaluate(`(() => {
		try {
			for (let index = localStorage.length - 1; index >= 0; index -= 1) {
				const key = localStorage.key(index);
				if (key && key.startsWith('tellybox-home-v1:')) localStorage.removeItem(key);
			}
		} catch {}
		return true;
	})()`);
	await page.reload(fixture.base + '/');
	await page.waitFor("(window.__b128.fetch || []).some(entry => entry.path === '/api/libraries' && entry.status === 200)", 10000, 'libraries before the same-document switch');
	await page.waitFor("(window.__b128.fetch || []).some(entry => entry.path === '/api/web/home')", 10000, 'the in-flight Home request');
	await page.evaluate(`(() => {
		history.pushState({}, '', '/?view=movies');
		window.dispatchEvent(new PopStateEvent('popstate'));
		return location.search;
	})()`);
	await page.waitFor("location.search.includes('view=movies') && document.querySelector('#homeFeed').hidden === true", 8000, 'the offscreen collection view');
	await page.waitFor(`(() => {
		const entry = (window.__b128.fetch || []).find(item => item.path === '/api/web/home' && item.status === 200 && item.rowIds);
		const cards = document.querySelectorAll('#homeRows [data-tellybox-item]').length;
		return entry && cards === 0 ? entry : false;
	})()`, 12000, 'the first Home result landing while offscreen');
	const offscreenHome = await page.evaluate(`(() => {
		const entry = (window.__b128.fetch || []).find(item => item.path === '/api/web/home' && item.status === 200 && item.rowIds);
		return entry ? { at: entry.at, rowIds: entry.rowIds, itemIds: entry.itemIds } : null;
	})()`);
	page.homeDelayMs = 0;
	const warmHomePostsBefore = (await page.fetchLog()).filter(entry => entry.path === '/api/web/home').length;
	const warmPoint = await page.prepareNav('/');
	await page.evaluate("window.__b128.skeletonTimes = []; window.__b128.mark('warm-home-click')");
	const warmClickAt = await page.pageNow();
	const warmOriginBefore = await page.timeOrigin();
	await page.clickPoint(warmPoint);
	const warmRow = await page.waitFor("(() => { const holder = document.querySelector('#homeRows [data-tellybox-item]'); return holder ? { t: Math.round(performance.now()), id: holder.dataset.tellyboxItem } : false; })()", 3000, 'the warm first row');
	const warmSkeleton = (await page.skeletonTimes()).filter(value => value >= warmClickAt);
	await sleep(700);
	const warmRows = await page.evaluate(homeRowExpression);
	const warmOriginAfter = await page.timeOrigin();
	const warmHomePostsAfter = (await page.fetchLog()).filter(entry => entry.path === '/api/web/home').length;
	const warmNetwork = summarizeNetwork(page.recorder.all(), 'warm-offscreen');
	page.recorder.stop();
	await sleep(200);
	const warmShot = await page.screenshot('warm-return-' + evidence.profile + '.png');
	evidence.screenshots.push(warmShot);
	evidence.phases.warmReturn = {
		offscreenHome,
		clickAt: warmClickAt,
		firstRow: warmRow,
		firstRowMs: warmRow.t - warmClickAt,
		skeletonAfterClick: warmSkeleton,
		homePostsBefore: warmHomePostsBefore,
		homePostsAfter: warmHomePostsAfter,
		sameDocument: warmOriginBefore === warmOriginAfter,
		rows: warmRows,
		network: warmNetwork,
		screenshot: warmShot
	};
	check(evidence, 'warm', 'the first Home result arrived while the collection view was active', Boolean(offscreenHome && offscreenHome.rowIds.length > 0), JSON.stringify({ rows: offscreenHome?.rowIds }));
	check(evidence, 'warm', 'the warm return painted its first row immediately', warmRow.t - warmClickAt <= 300, 'first row in ' + (warmRow.t - warmClickAt) + 'ms');
	check(evidence, 'warm', 'no skeleton flash on the warm return', warmSkeleton.length === 0, JSON.stringify(warmSkeleton));
	check(evidence, 'warm', 'the warm return made no extra Home POST', warmHomePostsAfter === warmHomePostsBefore, JSON.stringify({ before: warmHomePostsBefore, after: warmHomePostsAfter }));
	check(evidence, 'warm', 'the warm return stayed in the same document', warmOriginBefore === warmOriginAfter, JSON.stringify({ before: warmOriginBefore, after: warmOriginAfter }));
	const offscreenIds = new Set(offscreenHome?.itemIds || []);
	check(evidence, 'warm', 'the painted cards came from the offscreen first result', warmRows.ids.length > 0 && warmRows.ids.every(id => offscreenIds.has(id)), JSON.stringify({ offscreenRows: offscreenHome?.rowIds, warmRows: warmRows.rowIds, warmCards: warmRows.ids.length }));
}

// ---------------------------------------------------------------------------
// Real public artwork preview (saved public poster bytes)
// ---------------------------------------------------------------------------

async function scenarioRealArtworkPreview(page, fixture, evidence) {
	fixture.calls.setMode('slow', 2500);
	page.recorder.start('real-artwork-preview');
	await page.navigate(fixture.base + '/', fixture.base + '/');
	await page.waitFor("document.readyState === 'complete'", 15000, 'page load');
	await page.waitFor("document.querySelectorAll('#homeRows [data-tellybox-item]').length > 0", 15000, 'Home rows');
	await page.waitFor("(window.__b128.fetch || []).some(entry => entry.path === '/api/web/home' && entry.availability)", 10000, 'the initial Home availability');
	const rows = await page.evaluate(homeRowExpression);
	const initialHome = await page.evaluate(`(() => {
		const entry = (window.__b128.fetch || []).filter(item => item.path === '/api/web/home' && item.availability).sort((a, b) => a.at - b.at)[0];
		return entry ? { at: entry.at, ms: entry.ms, status: entry.status, availability: entry.availability } : null;
	})()`);
	const firstPoster = await page.waitFor(`(() => {
		const image = document.querySelector('#homeRows .home-row:not(.home-row--continue) .poster img');
		if (!image || image.hidden || !image.complete || image.naturalWidth <= 0) return false;
		return {
			t: Math.round(performance.now()),
			src: new URL(image.src, location.href).pathname,
			naturalWidth: image.naturalWidth,
			naturalHeight: image.naturalHeight
		};
	})()`, 15000, 'the first real poster to decode');
	const firstPosterAt = firstPoster.t;
	await waitHomeDecoded(page, 12000, 'all visible real posters');
	const allPostersAt = await page.pageNow();
	const posters = await page.evaluate(`(() => [...new Set([...document.querySelectorAll('#homeRows [data-tellybox-item]')].map(holder => holder.dataset.tellyboxItem))].map(id => {
		const holder = document.querySelector('#homeRows [data-tellybox-item="' + id + '"]');
		const image = holder?.querySelector('.poster img');
		return image ? { id, src: new URL(image.src, location.href).pathname, complete: image.complete, naturalWidth: image.naturalWidth, naturalHeight: image.naturalHeight, hidden: Boolean(image.hidden) } : null;
	}).filter(Boolean))()`);
	const resources = await page.evaluate(`(() => performance.getEntriesByType('resource').filter(entry => entry.name.includes('/api/web/tmdb-art/')).map(entry => ({ name: new URL(entry.name, location.href).pathname, startTime: Math.round(entry.startTime), responseEnd: Math.round(entry.responseEnd), duration: Math.round(entry.duration), transferSize: entry.transferSize, encodedBodySize: entry.encodedBodySize, decodedBodySize: entry.decodedBodySize })))()`);
	const network = summarizeNetwork(page.recorder.all(), 'real-artwork-preview');
	page.recorder.stop();
	const tmdbResponses = page.recorder.all().filter(entry => entry.phase === 'real-artwork-preview' && entry.path.startsWith('/api/web/tmdb-art/'));
	await page.evaluate(revealRowsExpression);
	await page.evaluate('window.scrollTo(0, 0)');
	await sleep(300);
	const shot = await page.screenshot('real-artwork-preview-' + evidence.profile + '.png');
	evidence.screenshots.push(shot);
	const jpegBytes = tmdbResponses.map(entry => entry.contentLength).find(value => Number.isFinite(value)) ?? null;
	const encodedBytes = tmdbResponses.map(entry => entry.encodedBytes).find(value => Number.isFinite(value)) ?? null;
	const resourceBytes = resources.map(entry => entry.encodedBodySize).find(value => Number.isFinite(value) && value > 0) ?? null;
	evidence.phases['real-artwork-preview'] = {
		representativePublicArtwork: true,
		productionPerformance: false,
		source: 'outputs/Tellybox-artwork-128/evidence-128b/real-public-poster.jpg',
		expectedBytes: 97186,
		metadataDelayMs: 2500,
		rows,
		initialHome,
		firstPoster,
		firstPosterAt,
		allPostersAt,
		posters,
		tmdbResponses: tmdbResponses.map(entry => ({ path: entry.path, status: entry.status, mime: entry.mime, contentLength: entry.contentLength, encodedBytes: entry.encodedBytes, start: entry.start, end: entry.end })),
		resources,
		jpegBytes,
		encodedBytes,
		resourceBytes,
		network,
		screenshot: shot
	};
	check(evidence, 'real-artwork', 'the fixture served the saved 97,186-byte JPEG', [jpegBytes, encodedBytes, resourceBytes].some(value => value === 97186), JSON.stringify({ jpegBytes, encodedBytes, resourceBytes }));
	check(evidence, 'real-artwork', 'the poster route reported image/jpeg', tmdbResponses.some(entry => entry.mime === 'image/jpeg'), JSON.stringify(tmdbResponses.map(entry => entry.mime)));
	check(evidence, 'real-artwork', 'the first real poster decoded with real dimensions', firstPoster.naturalWidth > 0 && firstPoster.naturalHeight > 0 && firstPosterAt <= 8000, JSON.stringify({ src: firstPoster.src, width: firstPoster.naturalWidth, height: firstPoster.naturalHeight, at: firstPosterAt }));
	check(evidence, 'real-artwork', 'every rendered poster decoded from the real bytes', posters.length > 0 && posters.every(poster => poster.complete && poster.naturalWidth > 0 && !poster.hidden), JSON.stringify(posters));
	check(evidence, 'real-artwork', 'the synthetic metadata delay is reported separately from image decode', Number(initialHome?.ms) < 1000 && firstPosterAt > 2500, JSON.stringify({ homeMs: initialHome?.ms, metadataDelayMs: 2500, firstPosterAt }));
	check(evidence, 'real-artwork', 'the artwork continuation stayed bounded', network.artwork.count <= 5, 'artwork POSTs: ' + network.artwork.count);
	check(evidence, 'real-artwork', 'the Home feed was not rebuilt per artwork check', network.home.count <= 2, 'Home POSTs: ' + network.home.count);
}

// ---------------------------------------------------------------------------
// Controlled restart-budget probe (frontend only; backend restart is synthetic)
// ---------------------------------------------------------------------------

async function scenarioRestartBudget(page, fixture, evidence) {
	fixture.calls.setMode('slow', 5200);
	page.recorder.start('restart-budget');
	await page.navigate(fixture.base + '/', fixture.base + '/');
	await page.waitFor("document.readyState === 'complete'", 15000, 'page load');
	await page.waitFor("document.querySelectorAll('#homeRows [data-tellybox-item]').length > 0", 15000, 'Home rows');
	await page.waitFor("(window.__b128.fetch || []).some(entry => entry.path === '/api/web/home' && entry.availability)", 10000, 'the initial Home availability');
	await sleep(800);
	const homeBefore = (await page.fetchLog()).filter(entry => entry.path === '/api/web/home').length;
	const artworkBefore = (await page.fetchLog()).filter(entry => entry.path === '/api/web/home/artwork').length;
	page.artworkRestartMode = true;
	const firstRestart = await page.waitFor(`(() => {
		const entries = (window.__b128.fetch || []).filter(entry => entry.path === '/api/web/home/artwork' && entry.restart === true);
		return entries.length ? { at: entries[0].at, count: entries.length } : false;
	})()`, 10000, 'the controlled restart:true response');
	await sleep(10000);
	const homeAfter = (await page.fetchLog()).filter(entry => entry.path === '/api/web/home').length;
	const artworkAfter = (await page.fetchLog()).filter(entry => entry.path === '/api/web/home/artwork').length;
	const restarts = await page.evaluate("(window.__b128.fetch || []).filter(entry => entry.path === '/api/web/home/artwork' && entry.restart === true).length");
	page.artworkRestartMode = false;
	const network = summarizeNetwork(page.recorder.all(), 'restart-budget');
	page.recorder.stop();
	evidence.phases['restart-budget'] = {
		controlledFrontendProbe: true,
		backendRestartSynthetic: true,
		homeBefore,
		homeAfter,
		homeDelta: homeAfter - homeBefore,
		artworkBefore,
		artworkAfter,
		artworkDelta: artworkAfter - artworkBefore,
		restarts,
		firstRestart,
		network
	};
	check(evidence, 'restart-budget', 'the controlled loop reached a restart:true response', restarts >= 1, JSON.stringify({ restarts, firstRestart }));
	check(evidence, 'restart-budget', 'a forced restart:true caused at most one full Home rebuild', homeAfter - homeBefore <= 1, JSON.stringify({ before: homeBefore, after: homeAfter, delta: homeAfter - homeBefore }));
	check(evidence, 'restart-budget', 'the budget stopped the loop before a repeated restart or Home storm', homeAfter <= 4 && artworkAfter - artworkBefore <= 5, JSON.stringify({ homeAfter, artworkDelta: artworkAfter - artworkBefore, restarts }));
	check(evidence, 'restart-budget', 'the page stayed usable after exhausting the restart budget', await page.evaluate("document.querySelectorAll('#homeRows [data-tellybox-item]').length > 0"), 'rows present');
}

// ---------------------------------------------------------------------------
// Discover scenarios
// ---------------------------------------------------------------------------

function discoverTraceSamples(trace) {
	const samples = trace.slice().sort((a, b) => a.t - b.t);
	const shelfFirst = {};
	const firstCards = [];
	for (const sample of samples) {
		if (sample.t === undefined) continue;
		for (const shelf of sample.shelves || []) {
			if (shelf.title && shelfFirst[shelf.title] === undefined) shelfFirst[shelf.title] = sample.t;
			if (shelf.cards > 0) firstCards.push(sample.t);
		}
	}
	const holderSample = samples.find(sample => (sample.holders || []).length >= 5) || null;
	return {
		shelfFirst,
		firstCardAt: firstCards.length ? Math.min(...firstCards) : null,
		holderOrder: holderSample ? holderSample.holders : [],
		holderAt: holderSample ? holderSample.t : null
	};
}

async function startDiscoverTrace(page) {
	await page.evaluate(`(() => {
		window.__b128.discoverTrace = [];
		window.__b128.discoverStart = Math.round(performance.now());
		if (window.__b128.discoverTimer) clearInterval(window.__b128.discoverTimer);
		const sample = () => {
			const parent = document.querySelector('#discoveryFeeds');
			if (!parent) return;
			window.__b128.discoverTrace.push({
				// Absolute page clock, matching servicesAt and shelfShotAt below.
				t: Math.round(performance.now()),
				shelves: [...parent.querySelectorAll('section.discovery-shelf')].map(section => ({
					title: section.querySelector('h2')?.textContent || '',
					cards: section.querySelectorAll('.discover-card').length
				})),
				holders: [...parent.children].filter(child => child.tagName === 'DIV').map(child => (child.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 90)),
				cards: parent.querySelectorAll('.discover-card').length
			});
		};
		sample();
		window.__b128.discoverTimer = setInterval(sample, 50);
		return window.__b128.discoverStart;
	})()`);
	return page.pageNow();
}

async function stopDiscoverTrace(page) {
	await sleep(2400);
	await page.evaluate("if (window.__b128.discoverTimer) clearInterval(window.__b128.discoverTimer)");
	return page.evaluate('window.__b128.discoverTrace || []');
}

async function servicesShelfSnapshot(page) {
	return page.evaluate(`(() => {
		const parent = document.querySelector('#discoveryFeeds');
		if (!parent) return null;
		const shelves = [...parent.querySelectorAll('section.discovery-shelf')].map(section => ({
			title: section.querySelector('h2')?.textContent || '',
			cards: section.querySelectorAll('.discover-card').length,
			sampleText: (section.querySelector('.discover-card')?.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 100),
			badges: [...section.querySelectorAll('.request-badge')].map(node => node.textContent.trim()).slice(0, 6)
		}));
		const netflixCard = [...parent.querySelectorAll('.discover-card')].find(card => (card.textContent || '').includes('Discover provider 8 2'));
		return {
			holders: [...parent.children].filter(child => child.tagName === 'DIV').length,
			shelves,
			netflixCard: netflixCard ? { text: (netflixCard.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 180), badges: [...netflixCard.querySelectorAll('.request-badge')].map(node => node.textContent.trim()) } : null
		};
	})()`);
}

// Storage deny-list check for the durable public snapshot. The allowlist
// sanitizer is the product's, but this independently proves what reached disk.
function inspectCacheFile(file) {
	try {
		const text = readFileSync(file, 'utf8');
		const data = JSON.parse(text);
		const deny = new Set(['mediainfo', 'watchid', 'jellyfinmediaid', 'vodid', 'vodprovider', 'requests', 'userdata', 'progress', 'favourites', 'requestid']);
		const found = new Set();
		const walk = value => {
			if (Array.isArray(value)) { for (const item of value) walk(item); return; }
			if (!value || typeof value !== 'object') return;
			for (const [key, item] of Object.entries(value)) {
				if (deny.has(key.toLowerCase())) found.add(key);
				walk(item);
			}
		};
		walk(data);
		return {
			file,
			bytes: statSync(file).size,
			entries: Object.keys(data.entries || {}).length,
			fingerprint: data.fingerprint,
			savedAt: data.savedAt,
			denyList: [...deny],
			deniedKeys: [...found],
			leaksSource: /127\.0\.0\.1|fixture-key/.test(text)
		};
	} catch (error) {
		return { file, error: String(error.message || error) };
	}
}

function cacheStatesFor(log, prefix) {
	return log
		.filter(entry => entry.path.startsWith(prefix) && entry.cacheState)
		.map(entry => ({ path: entry.path, cacheState: entry.cacheState, items: entry.items }));
}

async function servicesColdWarm(page, fixture, evidence, phase, { expectCold }) {
	const coldBefore = fixture.calls.discover;
	await page.navigate(fixture.base + '/discover?type=movie', fixture.base + '/discover');
	await page.waitFor("document.querySelectorAll('#discoverGrid .discover-card').length > 0", 15000, 'the Discover film grid');
	const gridBefore = await page.evaluate(discoverDecodeExpression);
	const gridCards = await page.evaluate("document.querySelectorAll('#discoverGrid .discover-card').length");
	page.recorder.start(phase);
	const servicesAt = await startDiscoverTrace(page);
	await page.clickElement('#servicesTab');
	await page.waitFor("document.querySelectorAll('#discoveryFeeds section.discovery-shelf').length >= 5", 12000, 'all five provider shelves');
	const shelfShotAt = await page.pageNow();
	const snapshotCold = await servicesShelfSnapshot(page);
	const images = await waitDiscoverImages(page, 12000, 'visible Discover posters');
	await sleep(250);
	const traceCold = await stopDiscoverTrace(page);
	const servicesAtAfter = await page.pageNow();
	const networkCold = summarizeNetwork(page.recorder.all(), phase);
	page.recorder.stop();
	const logCold = await page.fetchLog();
	const coldUpstream = fixture.calls.discover - coldBefore;
	await page.evaluate("document.querySelector('#discoveryFeeds')?.scrollIntoView({ block: 'start' })");
	await sleep(300);
	const shot = await page.screenshot('discover-' + phase + '-' + evidence.profile + '.png');
	evidence.screenshots.push(shot);
	const trace = discoverTraceSamples(traceCold);
	const timings = Object.fromEntries(Object.entries(trace.shelfFirst).map(([title, value]) => [title, value - servicesAt]));
	return {
		servicesAt,
		allShelvesAt: shelfShotAt,
		allShelvesMs: shelfShotAt - servicesAt,
		shelfTimings: timings,
		holderOrder: trace.holderOrder,
		holderAt: trace.holderAt,
		firstCardAt: trace.firstCardAt === null ? null : trace.firstCardAt - servicesAt,
		snapshot: snapshotCold,
		images,
		gridCards,
		grid: gridBefore,
		upstreamDiscoverCalls: coldUpstream,
		cacheStates: cacheStatesFor(logCold, '/api/discover/provider'),
		network: networkCold,
		screenshot: shot,
		traceSampleCount: traceCold.length
	};
}

async function scenarioDiscoverColdWarm(page, fixture, evidence) {
	fixture.calls.setDiscoverDelay(8, 2500);
	const cold = await servicesColdWarm(page, fixture, evidence, 'discover-cold', { expectCold: true });
	// The services mode writes ?type=services into the URL, so a reload would
	// reopen services rather than the film grid. A fresh document navigation to
	// the film browse URL still uses the same warm server-process cache.
	await page.navigate(fixture.base + '/discover?type=movie', fixture.base + '/discover');
	await page.waitFor("document.querySelectorAll('#discoverGrid .discover-card').length > 0", 15000, 'the warm Discover film grid');
	page.recorder.start('discover-warm');
	const warmUpstreamBefore = fixture.calls.discover;
	const warmGridLog = await page.fetchLog();
	const warmServicesAt = await startDiscoverTrace(page);
	await page.clickElement('#servicesTab');
	await page.waitFor("document.querySelectorAll('#discoveryFeeds section.discovery-shelf').length >= 5", 12000, 'all five warm provider shelves');
	const warmShelvesAt = await page.pageNow();
	const warmSnapshot = await servicesShelfSnapshot(page);
	const warmImages = await waitDiscoverImages(page, 12000, 'visible warm Discover posters');
	const warmTrace = await stopDiscoverTrace(page);
	const warmUpstream = fixture.calls.discover - warmUpstreamBefore;
	const warmNetwork = summarizeNetwork(page.recorder.all(), 'discover-warm');
	page.recorder.stop();
	const warmLog = await page.fetchLog();
	await page.evaluate("document.querySelector('#discoveryFeeds')?.scrollIntoView({ block: 'start' })");
	await sleep(300);
	const warmShot = await page.screenshot('discover-warm-' + evidence.profile + '.png');
	evidence.screenshots.push(warmShot);
	const warmTimings = Object.fromEntries(Object.entries(discoverTraceSamples(warmTrace).shelfFirst).map(([title, value]) => [title, value - warmServicesAt]));

	// Inspect the persisted public snapshot while the fixture directory exists.
	const cache = inspectCacheFile(join(fixture.directory, 'discover-public-cache.json'));

	const coldNetflix = cold.shelfTimings['Netflix'];
	const coldLater = ['Apple TV', 'Disney+', 'Prime Video', 'Paramount+'].map(title => cold.shelfTimings[title]).filter(value => Number.isFinite(value));
	const netflixCard = cold.snapshot?.netflixCard || warmSnapshot?.netflixCard;
	const warm = {
		servicesAt: warmServicesAt,
		allShelvesMs: warmShelvesAt - warmServicesAt,
		shelfTimings: warmTimings,
		snapshot: warmSnapshot,
		images: warmImages,
		upstreamDiscoverCalls: warmUpstream,
		cacheStates: cacheStatesFor(warmLog, '/api/discover/provider'),
		gridCacheStates: cacheStatesFor(warmGridLog, '/api/discover'),
		network: warmNetwork,
		screenshot: warmShot
	};
	evidence.phases.discover = { cold, warm, cache };
	check(evidence, 'discover-cold', 'the film grid rendered real Discover cards', cold.gridCards > 0, 'cards: ' + cold.gridCards);
	const holderNames = ['Netflix', 'Apple TV', 'Disney+', 'Prime Video', 'Paramount+'];
	const holderOrderOk = cold.holderOrder.length >= 5 && holderNames.every((name, index) => String(cold.holderOrder[index] || '').includes(name));
	check(evidence, 'discover-cold', 'all five provider holders were created in order', holderOrderOk, JSON.stringify(cold.holderOrder.slice(0, 5)));
	check(evidence, 'discover-cold', 'the slow provider did not block later shelves', Number.isFinite(coldNetflix) && coldLater.length > 0 && coldLater.some(value => value < coldNetflix), JSON.stringify({ netflix: coldNetflix, later: coldLater }));
	check(evidence, 'discover-cold', 'all five shelves rendered', cold.snapshot?.shelves.length === 5, JSON.stringify(cold.snapshot?.shelves.map(shelf => shelf.title)));
	check(evidence, 'discover-cold', 'the first shelf card appeared quickly', Number(cold.firstCardAt) < 2000, 'first card at ' + cold.firstCardAt + 'ms');
	check(evidence, 'discover-cold', 'visible Discover posters decoded', cold.images.visible > 0 && cold.images.decoded === cold.images.visible, JSON.stringify(cold.images));
	check(evidence, 'discover-cold', 'the cold response came from the upstream loader', cold.cacheStates.every(entry => entry.cacheState === 'miss'), JSON.stringify(cold.cacheStates));
	check(evidence, 'discover-warm', 'the warm reload used the public snapshot with no upstream fetch', warmUpstream === 0, 'upstream Discover calls: ' + warmUpstream);
	check(evidence, 'discover-warm', 'the warm snapshot reported fresh cache hits', warm.cacheStates.length > 0 && warm.cacheStates.every(entry => entry.cacheState === 'fresh'), JSON.stringify(warm.cacheStates));
	check(evidence, 'discover-warm', 'the warm film grid also came from the snapshot', warm.gridCacheStates.some(entry => entry.cacheState === 'fresh'), JSON.stringify(warm.gridCacheStates));
	check(evidence, 'discover-warm', 'all five warm shelves rendered', warmSnapshot?.shelves.length === 5, JSON.stringify(warmSnapshot?.shelves.map(shelf => shelf.title)));
	check(evidence, 'discover-warm', 'the warm first row was faster than the cold slow provider', Number(warm.shelfTimings['Netflix']) < Number(cold.shelfTimings['Netflix']), JSON.stringify({ cold: cold.shelfTimings['Netflix'], warm: warm.shelfTimings['Netflix'] }));
	check(evidence, 'discover-warm', 'warm visible posters decoded', warmImages.visible > 0 && warmImages.decoded === warmImages.visible, JSON.stringify(warmImages));
	check(evidence, 'discover-availability', 'cached cards still show current VOD availability', Boolean(netflixCard && netflixCard.badges.some(text => text.includes('Stream now'))), JSON.stringify(netflixCard));
	check(evidence, 'discover-cache', 'the persisted snapshot contains public entries', Number(cache?.entries) > 0, JSON.stringify(cache));
	check(evidence, 'discover-cache', 'the persisted snapshot has no private fields', cache?.deniedKeys?.length === 0 && cache?.leaksSource === false, JSON.stringify(cache));
}

async function scenarioDiscoverDegraded(page, fixture, evidence) {
	fixture.calls.setDiscoverMode('down', 0);
	page.recorder.start('discover-degraded');
	await page.navigate(fixture.base + '/discover?type=movie', fixture.base + '/discover');
	const gridError = await page.waitFor("(() => { const text = document.querySelector('#discoverStatus')?.textContent || ''; return text && !/Loading|Finding/.test(text) ? text : false; })()", 12000, 'the degraded grid error');
	const gridCards = await page.evaluate("document.querySelectorAll('#discoverGrid .discover-card').length");
	await page.clickElement('#servicesTab');
	await page.waitFor("document.querySelectorAll('#discoveryFeeds > div').length >= 5", 8000, 'five degraded holders');
	const shelfError = await page.waitFor(`(() => {
		const parent = document.querySelector('#discoveryFeeds');
		const holders = [...parent.querySelectorAll(':scope > div')];
		const errors = holders.map(holder => holder.textContent || '').filter(text => /could not complete|not responding|temporarily unavailable/i.test(text));
		return errors.length >= 5 ? { holders: holders.length, errors } : false;
	})()`, 12000, 'five honest per-shelf errors');
	const retries = await page.evaluate("document.querySelectorAll('#discoveryFeeds button').length");
	const degradedShot = await page.evaluate('window.scrollTo(0, 0)');
	const shot = await page.screenshot('discover-degraded-' + evidence.profile + '.png');
	evidence.screenshots.push(shot);
	fixture.calls.setDiscoverMode('ok', 0);
	await page.clickElement('#discoveryFeeds button');
	await page.waitFor("document.querySelectorAll('#discoveryFeeds section.discovery-shelf').length >= 1", 12000, 'the retried shelf');
	const recovered = await servicesShelfSnapshot(page);
	await page.clickElement('#filmsTab');
	await page.waitFor("document.querySelectorAll('#discoverGrid .discover-card').length > 0", 12000, 'the recovered film grid');
	const recoveredGrid = await page.evaluate("document.querySelectorAll('#discoverGrid .discover-card').length");
	const network = summarizeNetwork(page.recorder.all(), 'discover-degraded');
	page.recorder.stop();
	const recoveredShot = await page.screenshot('discover-degraded-recovered-' + evidence.profile + '.png');
	evidence.screenshots.push(recoveredShot);
	evidence.phases.degraded = {
		gridError,
		gridCards,
		shelfError,
		retryButtons: retries,
		recoveredShelves: recovered?.shelves?.length || 0,
		recoveredGrid,
		network,
		screenshots: [shot, recoveredShot]
	};
	check(evidence, 'discover-degraded', 'a down upstream showed an honest grid error instead of hanging', /could not complete|not responding|temporarily unavailable/i.test(String(gridError)), String(gridError).slice(0, 120));
	check(evidence, 'discover-degraded', 'no cards were invented while upstream was down', gridCards === 0, 'cards: ' + gridCards);
	check(evidence, 'discover-degraded', 'every provider shelf showed its own honest error and retry', shelfError.errors.length >= 5 && shelfError.holders >= 5, JSON.stringify({ holders: shelfError.holders, errors: shelfError.errors.length }));
	check(evidence, 'discover-degraded', 'a per-shelf retry recovered without reloading the page', (recovered?.shelves?.length || 0) >= 1, 'shelves: ' + (recovered?.shelves?.length || 0));
	check(evidence, 'discover-degraded', 'the rest of Discover stayed usable after the failure', recoveredGrid > 0, 'grid cards: ' + recoveredGrid);
}

async function discoverRestartWrite(page, fixture, evidence) {
	fixture.calls.setDiscoverDelay(8, 2500);
	await page.navigate(fixture.base + '/discover?type=movie', fixture.base + '/discover');
	await page.waitFor("document.querySelectorAll('#discoverGrid .discover-card').length > 0", 15000, 'the film grid');
	await page.clickElement('#servicesTab');
	await page.waitFor("document.querySelectorAll('#discoveryFeeds section.discovery-shelf').length >= 5", 12000, 'all five provider shelves');
	await waitDiscoverImages(page, 12000, 'visible posters before restart');
	const snapshot = await servicesShelfSnapshot(page);
	const file = join(fixture.directory, 'discover-public-cache.json');
	let cache = null;
	const deadline = Date.now() + 8000;
	while (Date.now() < deadline) {
		try {
			const data = JSON.parse(readFileSync(file, 'utf8'));
			const entries = Object.keys(data.entries || {}).length;
			if (entries >= 6) { cache = { entries, bytes: statSync(file).size, fingerprint: data.fingerprint, savedAt: data.savedAt }; break; }
		} catch {}
		await sleep(150);
	}
	if (!cache) throw new Error('The Discover cache file did not reach six entries');
	await page.evaluate("document.querySelector('#discoveryFeeds')?.scrollIntoView({ block: 'start' })");
	await sleep(250);
	const shot = await page.screenshot('discover-restart-write-' + evidence.profile + '.png');
	evidence.screenshots.push(shot);
	const sanitizer = inspectCacheFile(file);
	evidence.phases.write = {
		directory: fixture.directory,
		seerrPort: RESTART_SEERR_PORT,
		cache,
		sanitizer,
		snapshot,
		upstreamDiscoverCalls: fixture.calls.discover,
		screenshot: shot
	};
	writeFileSync(join(restartDir, 'restart-state.json'), JSON.stringify({
		directory: fixture.directory,
		seerrPort: RESTART_SEERR_PORT,
		cacheEntries: cache.entries,
		savedAt: cache.savedAt,
		fingerprint: cache.fingerprint
	}, null, 2));
	check(evidence, 'restart-write', 'the first process persisted the public snapshot', cache.entries >= 6, JSON.stringify(cache));
	check(evidence, 'restart-write', 'the persisted snapshot has no private fields', sanitizer.deniedKeys.length === 0 && sanitizer.leaksSource === false, JSON.stringify(sanitizer));
	check(evidence, 'restart-write', 'the write process rendered all five shelves', snapshot?.shelves?.length === 5, JSON.stringify(snapshot?.shelves?.map(shelf => shelf.title)));
}

async function discoverRestartRead(page, fixture, evidence) {
	page.recorder.start('restart-read');
	await page.navigate(fixture.base + '/discover?type=movie', fixture.base + '/discover');
	await page.waitFor("document.querySelectorAll('#discoverGrid .discover-card').length > 0", 15000, 'the restored film grid');
	const gridUpstream = fixture.calls.discover;
	const gridLog = await page.fetchLog();
	const gridCards = await page.evaluate("document.querySelectorAll('#discoverGrid .discover-card').length");
	const gridCacheStates = cacheStatesFor(gridLog, '/api/discover');
	await page.clickElement('#servicesTab');
	await page.waitFor("document.querySelectorAll('#discoveryFeeds section.discovery-shelf').length >= 5", 12000, 'restored provider shelves');
	const servicesUpstream = fixture.calls.discover;
	const snapshot = await servicesShelfSnapshot(page);
	const images = await waitDiscoverImages(page, 12000, 'restored visible posters');
	const log = await page.fetchLog();
	const network = summarizeNetwork(page.recorder.all(), 'restart-read');
	page.recorder.stop();
	const states = cacheStatesFor(log, '/api/discover/provider');
	await page.evaluate("document.querySelector('#discoveryFeeds')?.scrollIntoView({ block: 'start' })");
	await sleep(250);
	const shot = await page.screenshot('discover-restart-read-' + evidence.profile + '.png');
	evidence.screenshots.push(shot);
	const sanitizer = inspectCacheFile(join(fixture.directory, 'discover-public-cache.json'));
	evidence.phases.read = {
		gridCards,
		sanitizer,
		gridUpstreamCalls: gridUpstream,
		gridCacheStates,
		servicesUpstreamCalls: servicesUpstream,
		snapshot,
		cacheStates: states,
		images,
		network,
		screenshot: shot
	};
	check(evidence, 'restart-read', 'the restarted process rendered the cached film grid', gridCards > 0, 'cards: ' + gridCards);
	check(evidence, 'restart-read', 'the cached grid needed no upstream Discover fetch', gridUpstream === 0, 'upstream calls: ' + gridUpstream);
	check(evidence, 'restart-read', 'the restarted process rendered all cached provider shelves', snapshot?.shelves?.length === 5, JSON.stringify(snapshot?.shelves?.map(shelf => shelf.title)));
	check(evidence, 'restart-read', 'the cached provider shelves needed no upstream Discover fetch', servicesUpstream === 0, 'upstream calls: ' + servicesUpstream);
	check(evidence, 'restart-read', 'restart hits are reported fresh from disk', states.length > 0 && states.every(entry => entry.cacheState === 'fresh'), JSON.stringify(states));
	check(evidence, 'restart-read', 'restored visible posters decoded', images.visible > 0 && images.decoded === images.visible, JSON.stringify(images));
	check(evidence, 'restart-read', 'restored cached cards keep current VOD availability', Boolean(snapshot?.netflixCard && snapshot.netflixCard.badges.some(text => text.includes('Stream now'))), JSON.stringify(snapshot?.netflixCard));
	check(evidence, 'restart-read', 'the snapshot read after restart still has no private fields', sanitizer.deniedKeys.length === 0 && sanitizer.leaksSource === false, JSON.stringify(sanitizer));
}

// ---------------------------------------------------------------------------
// Browser run
// ---------------------------------------------------------------------------

async function runScenario() {
	const evidence = newEvidence(profileName);
	if (!SCENARIOS.includes(scenario)) throw new Error('Unknown scenario: ' + scenario);
	mkdirSync(outDir, { recursive: true });
	const chromePath = chromeExecutable();
	if (!chromePath) {
		console.log('SKIP: Chrome or Chromium was not found. Set CHROME_PATH to run the ARTWORK-128B browser check.');
		return { evidence, skipped: true, exitCode: 0 };
	}
	const viewport = VIEWPORTS[profileName] || VIEWPORTS.desktop;
	const cleanups = [];
	const scope = { after: fn => { cleanups.push(fn); } };
	let child = null;
	let socket = null;
	let profileDir = null;
	let connection = null;
	let page = null;
	const pageExceptions = [];
	const logErrors = [];
	let fixture = null;
	const started = Date.now();
	try {
		if (scenario === 'discover-restart-read') {
			const stateFile = join(restartDir, 'restart-state.json');
			if (!existsSync(stateFile)) throw new Error('No restart state from the write process: ' + stateFile);
			const state = JSON.parse(readFileSync(stateFile, 'utf8'));
			if (!(await portFree(state.seerrPort))) throw new Error('The fixed Seerr port ' + state.seerrPort + ' is in use; restart reuse is not possible in this process.');
			fixture = await startArtworkFixture(scope, {
				movies: DISCOVER_MOVIES,
				metadataMode: 'ok',
				directory: state.directory,
				seerrPort: state.seerrPort,
				keepDirectory: true
			});
			evidence.restart = { state, directory: state.directory, seerrPort: state.seerrPort };
		} else if (scenario === 'discover-restart-write') {
			mkdirSync(restartDir, { recursive: true });
			for (const name of ['restart-state.json']) {
				try { rmSync(join(restartDir, name), { force: true }); } catch {}
			}
			if (!(await portFree(RESTART_SEERR_PORT))) throw new Error('The fixed Seerr port ' + RESTART_SEERR_PORT + ' is in use; restart reuse is not possible in this process.');
			fixture = await startArtworkFixture(scope, {
				movies: DISCOVER_MOVIES,
				metadataMode: 'ok',
				directory: restartDir,
				seerrPort: RESTART_SEERR_PORT,
				keepDirectory: true
			});
			evidence.restart = { directory: restartDir, seerrPort: RESTART_SEERR_PORT };
		} else if (scenario.startsWith('discover')) {
			fixture = await startArtworkFixture(scope, { movies: DISCOVER_MOVIES, metadataMode: 'ok' });
		} else if (scenario === 'mixed-nav') {
			fixture = await startArtworkFixture(scope, { movies: MIXED_MOVIES, metadataMode: 'ok' });
		} else if (scenario === 'continue-change') {
			fixture = await startArtworkFixture(scope, { movies: CONTINUE_MOVIES, metadataMode: 'ok' });
		} else if (scenario === 'real-artwork-preview') {
			const posterPath = fileURLToPath(new URL('../../outputs/Tellybox-artwork-128/evidence-128b/real-public-poster.jpg', import.meta.url));
			const posterBytes = readFileSync(posterPath);
			if (posterBytes.length !== 97186) throw new Error('The saved public poster is not 97,186 bytes: ' + posterBytes.length);
			fixture = await startArtworkFixture(scope, {
				movies: SLOW_MOVIES,
				metadataMode: 'slow',
				artworkBytes: posterBytes,
				artworkType: 'image/jpeg'
			});
		} else if (scenario === 'restart-budget') {
			fixture = await startArtworkFixture(scope, { movies: SLOW_MOVIES, metadataMode: 'slow' });
		} else if (scenario === 'home-36') {
			fixture = await startArtworkFixture(scope, { movies: BUDGET_MOVIES, metadataMode: 'ok' });
		} else {
			fixture = await startArtworkFixture(scope, { movies: SLOW_MOVIES, metadataMode: 'slow' });
		}
		evidence.fixture = {
			directory: fixture.directory,
			titleIds: fixture.rows.map(row => 'dispatch-movie-' + row.id),
			titles: fixture.rows.length,
			metadataDelayMs: fixture.calls.delayMs,
			discoverDelays: Object.fromEntries(fixture.calls.discoverDelays)
		};

		profileDir = mkdtempSync(join(tmpdir(), 'tellybox-artwork-128b-'));
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
			'about:blank'
		], { stdio: 'ignore' });
		let port = 0;
		for (let attempt = 0; attempt < 150; attempt += 1) {
			const file = join(profileDir, 'DevToolsActivePort');
			if (existsSync(file)) {
				port = Number(readFileSync(file, 'utf8').split(/\r?\n/)[0]);
				if (port) break;
			}
			await sleep(100);
		}
		if (!port) throw new Error('Chrome did not open a DevTools port');
		connection = await connect(await targetFor(port));
		socket = connection.socket;
		const recorder = createNetworkRecorder();
		page = makePage(connection.send, recorder);
		page.homeDelayMs = 0;
		page.artworkRestartMode = false;

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

		await connection.send('Page.enable');
		await connection.send('Runtime.enable');
		await connection.send('Network.enable');
		await connection.send('Log.enable');
		// Local fulfilment of the external TMDB image host only. Loopback proof,
		// not real provider artwork.
		await connection.send('Fetch.enable', {
			patterns: [
				{ urlPattern: 'https://image.tmdb.org/*', requestStage: 'Request' },
				{ urlPattern: '*api/web/home*', requestStage: 'Request' }
			]
		});
		connection.on('Fetch.requestPaused', async params => {
			try {
				const url = String(params.request?.url || '');
				if (url.startsWith('https://image.tmdb.org/')) {
					await connection.send('Fetch.fulfillRequest', {
						requestId: params.requestId,
						responseCode: 200,
						responseHeaders: [
							{ name: 'Content-Type', value: 'image/png' },
							{ name: 'Cache-Control', value: 'no-store' }
						],
						body: png.toString('base64')
					});
					return;
				}
				let path = '';
				try { path = new URL(url).pathname; } catch {}
				// Controlled frontend budget probe only. The real backend does not
				// normally return restart:true in these flows; this scenario forces
				// it to prove the loop cannot turn it into a Home POST storm.
				if (path === '/api/web/home/artwork' && page && page.artworkRestartMode) {
					await connection.send('Fetch.fulfillRequest', {
						requestId: params.requestId,
						responseCode: 200,
						responseHeaders: [
							{ name: 'Content-Type', value: 'application/json' },
							{ name: 'Cache-Control', value: 'no-store' }
						],
						body: Buffer.from(JSON.stringify({
							updates: [],
							availability: { pending: 1, requested: 0, resolved: 0, failed: 0, visible: 4, remaining: 4, limit: 24 },
							restart: true
						})).toString('base64')
					});
					return;
				}
				if (path === '/api/web/home' && page && page.homeDelayMs > 0) {
					await sleep(page.homeDelayMs);
				}
				await connection.send('Fetch.continueRequest', { requestId: params.requestId });
			} catch {
				try { await connection.send('Fetch.continueRequest', { requestId: params.requestId }); } catch {}
			}
		});
		await connection.send('Emulation.setDeviceMetricsOverride', {
			width: viewport.width,
			height: viewport.height,
			deviceScaleFactor: 1,
			mobile: viewport.mobile,
			screenWidth: viewport.width,
			screenHeight: viewport.height
		});
		await connection.send('Page.addScriptToEvaluateOnNewDocument', { source: instrumentation });
		try {
			const version = await connection.send('Browser.getVersion');
			evidence.environment.chrome = String(version.product || '').split(' ')[0];
		} catch {}

		if (scenario === 'home-slow') await scenarioHomeSlow(page, fixture, evidence);
		else if (scenario === 'home-36') await scenarioHome36(page, fixture, evidence);
		else if (scenario === 'mixed-nav') await scenarioMixedNav(page, fixture, evidence);
		else if (scenario === 'continue-change') await scenarioContinueChange(page, fixture, evidence);
		else if (scenario === 'real-artwork-preview') await scenarioRealArtworkPreview(page, fixture, evidence);
		else if (scenario === 'restart-budget') await scenarioRestartBudget(page, fixture, evidence);
		else if (scenario === 'discover-cold-warm') await scenarioDiscoverColdWarm(page, fixture, evidence);
		else if (scenario === 'discover-degraded') await scenarioDiscoverDegraded(page, fixture, evidence);
		else if (scenario === 'discover-restart-write') await discoverRestartWrite(page, fixture, evidence);
		else if (scenario === 'discover-restart-read') await discoverRestartRead(page, fixture, evidence);
		check(evidence, 'harness', 'no uncaught page exceptions', pageExceptions.length === 0, JSON.stringify(pageExceptions.slice(0, 6)));
	} catch (error) {
		check(evidence, 'harness', 'the browser run completed without a harness exception', false, String(error.message || error).split('\n')[0].slice(0, 1600));
		evidence.error = String(error.message || error).split('\n')[0].slice(0, 300);
		if (page) {
			try {
				evidence.diagnostic = await page.evaluate(`(() => ({
					href: location.href,
					title: document.title,
					ready: document.readyState,
					status: document.querySelector('#discoverStatus')?.textContent || document.querySelector('#homeFeedStatus')?.textContent || '',
					rows: document.querySelectorAll('#homeRows [data-tellybox-item]').length,
					discoverCards: document.querySelectorAll('#discoverGrid .discover-card, #discoveryFeeds .discover-card').length,
					fetch: (window.__b128 && window.__b128.fetch || []).slice(-30),
					body: (document.body?.innerText || '').slice(0, 500)
				}))()`);
			} catch {}
		}
	} finally {
		evidence.durationMs = Date.now() - started;
		evidence.pageExceptions = pageExceptions.slice(0, 12);
		evidence.logErrors = logErrors.slice(0, 12);
		evidence.assertions = evidence.assertions;
		evidence.passed = evidence.assertions.length > 0 && evidence.assertions.every(entry => entry.pass);
		try { socket?.close(); } catch {}
		try { child?.kill(); } catch {}
		await sleep(500);
		for (const cleanup of cleanups.reverse()) {
			try { cleanup(); } catch {}
		}
		try { if (profileDir) rmSync(profileDir, { recursive: true, force: true }); } catch {}
	}
	evidence.generatedAt = new Date().toISOString();
	evidence.passed = evidence.assertions.length > 0 && evidence.assertions.every(entry => entry.pass);
	evidence.exitCode = evidence.passed ? 0 : 1;
	const file = join(outDir, scenario + '-' + profileName + '.json');
	writeFileSync(file, JSON.stringify(evidence, null, 2) + '\n');
	const failed = evidence.assertions.filter(entry => !entry.pass).length;
	console.log('');
	console.log('ARTWORK-128B ' + scenario + ' ' + profileName + ': ' + (evidence.passed ? 'PASS' : 'FAIL') +
		' (' + (evidence.assertions.length - failed) + '/' + evidence.assertions.length + ' assertions, ' + evidence.durationMs + 'ms)');
	if (evidence.pageExceptions.length) console.log('  page exceptions: ' + JSON.stringify(evidence.pageExceptions));
	console.log('  evidence: ' + file);
	if (evidence.screenshots.length) console.log('  screenshots: ' + evidence.screenshots.join(', '));
	return { evidence, skipped: false, exitCode: evidence.exitCode };
}

async function orchestrate() {
	if (!chromeExecutable()) {
		console.log('SKIP: Chrome or Chromium was not found. Set CHROME_PATH to run the ARTWORK-128B browser checks.');
		return 0;
	}
	mkdirSync(outDir, { recursive: true });
	mkdirSync(restartDir, { recursive: true });
	try { rmSync(join(restartDir, 'discover-public-cache.json'), { force: true }); } catch {}
	const results = [];
	for (const [name, profile] of ORCHESTRATED) {
		console.log('\n=== ' + name + ' / ' + profile + ' ===');
		const child = spawn(process.execPath, [scriptPath, name, profile], {
			stdio: 'inherit',
			env: { ...process.env, EVIDENCE_DIR: outDir, ARTWORK128B_RESTART_DIR: restartDir }
		});
		const code = await new Promise(resolve => child.on('exit', value => resolve(value ?? 1)));
		let passed = false;
		try { passed = JSON.parse(readFileSync(join(outDir, name + '-' + profile + '.json'), 'utf8')).passed; } catch {}
		results.push({ scenario: name, profile, exitCode: code, passed });
	}
	const summary = {
		generatedAt: new Date().toISOString(),
		environment: { os: process.platform + ' ' + release(), node: process.version, chrome: chromeExecutable() ? 'found' : 'missing' },
		fixtureOnly: true,
		externalProviderUsed: false,
		runs: results,
		passed: results.every(run => run.passed),
		note: 'Staged browser evidence only. Synthetic loopback fixture; not production or rollout readiness.'
	};
	writeFileSync(join(outDir, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
	const failed = results.filter(run => !run.passed);
	console.log('\nARTWORK-128B summary: ' + (failed.length ? 'FAIL' : 'PASS') + ' ' + (results.length - failed.length) + '/' + results.length);
	for (const failedRun of failed) console.log('  FAILED ' + failedRun.scenario + ' / ' + failedRun.profile + ' exit ' + failedRun.exitCode);
	console.log('  evidence: ' + join(outDir, 'summary.json'));
	return failed.length ? 1 : 0;
}

if (scenario === 'all') {
	const code = await orchestrate();
	process.exit(code);
} else {
	const result = await runScenario();
	process.exit(result.exitCode);
}
