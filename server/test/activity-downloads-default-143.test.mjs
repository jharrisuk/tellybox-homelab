/* Release 143: Activity lands on Downloads when the viewer may read it, and
 * both download lists default to the currently downloading torrents. The
 * landing selection reuses the existing tab bar, the existing single poll and
 * the existing deep links; a refused viewer falls back to Activity. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { DOWNLOADS_PAGE as ownerPage } from '../qbittorrent-page.mjs';

const activityHtml = readFileSync(new URL('../public/activity.html', import.meta.url), 'utf8');
const activityJs = readFileSync(new URL('../public/activity.js', import.meta.url), 'utf8');
const ownerJs = readFileSync(new URL('../public/qbittorrent-downloads.js', import.meta.url), 'utf8');

class Element {
	constructor(tag = 'div') {
		this.tag = tag; this.children = []; this.textContent = ''; this.className = '';
		this.hidden = false; this.disabled = false; this.dataset = {}; this.style = {};
		this.value = ''; this.tabIndex = 0; this.listeners = {};
	}
	append(...items) { this.children.push(...items); }
	replaceChildren(...items) { this.children = items; }
	setAttribute(name, value) { this[name] = String(value); }
	getAttribute(name) { return this[name] === undefined ? null : String(this[name]); }
	addEventListener(name, handler) { (this.listeners[name] ||= []).push(handler); }
	focus() {}
}

function fakeDocument() {
	const nodes = {};
	const document = {
		hidden: false, visibilityState: 'visible', activeElement: null, nodes,
		createElement: tag => new Element(tag),
		createTextNode: text => Object.assign(new Element('text'), { textContent: text }),
		querySelector: key => nodes[key] ||= new Element(),
		addEventListener() {}
	};
	return document;
}
function walk(root, output = []) {
	output.push(root);
	for (const child of root.children || []) walk(child, output);
	return output;
}
function textOf(root) { return walk(root).map(node => node.textContent).filter(Boolean).join(' | '); }
async function settle() {
	for (let index = 0; index < 6; index += 1) await new Promise(resolve => setImmediate(resolve));
}
const downloadCalls = calls => calls.filter(call => String(call.url).startsWith('/api/activity/downloads'));
const downloadFilter = call => new URL(String(call.url), 'http://tellybox.test').searchParams.get('filter');
function activitySnapshot() {
	const now = Date.now();
	return {
		active: [], downloads: [],
		recent: [{ id: 'e1', type: 'playback', time: now, title: 'Recent', state: 'ended', position: 60, local: false, browser: 'Browser' }],
		browsers: [], stats: { active: 0, plays: 0, remoteIps: 0, failed: 0 }, bandwidth: null,
		viewing: { since: now, users: [] }, page: { limit: 7, offset: 0, total: 1, hasMore: false, retentionDays: 30 },
		facets: { users: [], devices: [] }, historySince: now, lastLogins: {}
	};
}
const ACTIVE = { name: 'Downloading Alpha', state: 'downloading', stateLabel: 'Downloading', progress: 0.375, size: 1000, dlspeed: 4500000, upspeed: 120000, eta: 900, ratio: 1.25 };
const SEEDING = { name: 'Seeding Beta', state: 'uploading', stateLabel: 'Seeding', progress: 1, size: 900, dlspeed: 0, upspeed: 20000, eta: null, ratio: 2.5 };
const SEEDING_TWO = { ...SEEDING, name: 'Seeding Gamma' };
const ALL_ROWS = [ACTIVE, SEEDING, SEEDING_TWO];
const COUNTS = { downloading: 1, queued: 0, seeding: 2, paused: 0, checking: 0, moving: 0, attention: 0, other: 0 };

function downloadsPayload(filter = 'downloading', { rows, counts } = {}) {
	const visible = rows !== undefined ? rows
		: filter === 'downloading' ? [ACTIVE]
			: filter === 'seeding' ? [SEEDING, SEEDING_TWO] : ALL_ROWS;
	return {
		readOnly: true, generatedAt: Date.now(), configured: true, enabled: true, state: 'ok',
		reachable: true, stale: false, checkedAt: Date.now(), filter,
		sampleSize: visible.length, hasMore: false, counts: counts || COUNTS, countsLowerBound: [], rows: visible
	};
}

async function runActivity({ hash = '', downloadsAllowed = true, activityAccess = 'owner', probeError = false, downloads = filter => downloadsPayload(filter) } = {}) {
	const document = fakeDocument();
	const calls = [];
	const timers = new Set();
	const intervals = [];
	let id = 0;
	document.querySelector('#filter').value = 'all';
	const context = {
		document, Node: Element, location: { hash }, AbortController,
		fetch: async (url, options = {}) => {
			calls.push({ url: String(url), options });
			const target = String(url);
			if (target.startsWith('/api/activity/downloads')) {
				if (probeError) throw new TypeError('Failed to fetch');
				if (!downloadsAllowed) return { ok: false, status: 403, json: async () => ({ error: 'Only at home.' }) };
				const filter = new URL(target, 'http://tellybox.test').searchParams.get('filter') || 'all';
				return { ok: true, status: 200, json: async () => downloads(filter) };
			}
			if (target.startsWith('/api/activity/streams')) {
				return { ok: false, status: 403, json: async () => ({ error: 'No streams.' }) };
			}
			if (target === '/api/activity/summary') {
				return { ok: true, status: 200, json: async () => activitySnapshot() };
			}
			if (target === '/api/activity' || target.startsWith('/api/activity?')) {
				return activityAccess === 'readOnly'
					? { ok: false, status: 403, json: async () => ({ error: 'Only at home.' }) }
					: { ok: true, status: 200, json: async () => activitySnapshot() };
			}
			return { ok: true, status: 200, json: async () => activitySnapshot() };
		},
		setInterval(handler, delay) { intervals.push(delay); return ++id; },
		setTimeout(handler, delay) { const handle = ++id; timers.add(handle); return handle; },
		clearTimeout(handle) { timers.delete(handle); }
	};
	vm.runInNewContext(readFileSync(new URL('../public/activity-summary.js', import.meta.url), 'utf8'), context);
	vm.runInNewContext(activityJs, context);
	await settle();
	return { document, calls, timers, intervals };
}

test('Activity and the owner page both default to the downloading filter', () => {
	assert.match(activityHtml, /id="downloadsFilter"[^>]*>[\s\S]*?<option value="downloading" selected>Downloading<\/option>/);
	assert.match(activityHtml, /id="downloadsPanel"[\s\S]*?id="downloadsFilter"/);
	assert.match(ownerPage, /id="qbFilter"[^>]*>[\s\S]*?<option value="downloading" selected>Downloading<\/option>/);
	assert.match(ownerJs, /filter: 'downloading'/);
	assert.match(activityJs, /filter: 'downloading'/);
	// The read-only list keeps a non-destructive filter, never a torrent action.
	assert.doesNotMatch(activityHtml.slice(activityHtml.indexOf('id="downloadsPanel"')), />\s*(?:Remove torrent|Delete torrent|Pause|Resume)[^<]*<\/button>/i);
});

test('Activity lands on the Activity tab, and Downloads opens from its deep link with the downloading filter', async () => {
	const landing = await runActivity();
	assert.equal(landing.document.querySelector('#tabActivity').getAttribute('aria-selected'), 'true', 'Activity is the landing tab');
	assert.equal(landing.document.querySelector('#activityPanel').hidden, false);
	assert.equal(landing.document.querySelector('#downloadsPanel').hidden, true);
	assert.equal(downloadCalls(landing.calls).length, 0, 'the landing view does not read downloads');

	const { document, calls, timers, intervals } = await runActivity({ hash: '#downloads' });

	const downloadsTab = document.querySelector('#tabDownloads');
	assert.equal(downloadsTab.getAttribute('aria-selected'), 'true', 'the deep link opens Downloads');
	assert.equal(downloadsTab.getAttribute('tabindex'), '0');
	assert.equal(document.querySelector('#downloadsPanel').hidden, false);
	assert.equal(document.querySelector('#activityPanel').hidden, true);
	assert.equal(document.querySelector('#tabActivity').getAttribute('aria-selected'), 'false');
	assert.equal(downloadCalls(calls).length, 1, 'opening Downloads reads the list once');
	assert.equal(downloadFilter(downloadCalls(calls)[0]), 'downloading', 'the first read asks qBittorrent for downloading');
	assert.equal(calls.some(call => call.url.startsWith('/api/qbittorrent/')), false, 'owner routes are never used');
	assert.equal(intervals.length, 1, 'the existing activity interval is untouched');
	assert.equal(timers.size, 1, 'the downloads poll keeps its one existing timer');

	const list = textOf(document.querySelector('#downloadsList'));
	assert.match(list, /Downloading Alpha/);
	assert.doesNotMatch(list, /Seeding Beta|Seeding Gamma/, 'seeding torrents are not the default list');
	assert.doesNotMatch(textOf(document.querySelector('#downloadsStatus')), /1 downloading/, 'the pill owns the active filter count, so the summary omits it');
	assert.match(textOf(document.querySelector('#downloadsStatus')), /2 seeding/);
	assert.match(textOf(document.querySelector('#downloadsStatus')), /3 torrents in the queue/);
	assert.equal(document.querySelector('#downloadsStatusPill').textContent, '1 downloading');

	// Switching the filter is one new server read for the selected filter. It
	// reuses the same single poll timer and abandons any earlier reading.
	document.querySelector('#downloadsFilter').value = 'seeding';
	document.querySelector('#downloadsFilter').onchange();
	await settle();
	assert.equal(downloadCalls(calls).length, 2, 'filtering reads the selected filter once');
	assert.equal(downloadFilter(downloadCalls(calls)[1]), 'seeding', 'the second read asks for seeding');
	assert.equal(timers.size, 1, 'filtering does not add a timer');
	assert.match(textOf(document.querySelector('#downloadsList')), /Seeding Beta/);
	assert.match(textOf(document.querySelector('#downloadsList')), /Seeding Gamma/);
	assert.equal(document.querySelector('#downloadsStatusPill').textContent, '2 seeding');
});

test('a denied viewer falls back to Activity and loses the Downloads tab', async () => {
	const { document, calls, timers } = await runActivity({ activityAccess: 'readOnly', downloadsAllowed: false });
	assert.equal(document.querySelector('#tabActivity').getAttribute('aria-selected'), 'true');
	assert.equal(document.querySelector('#activityPanel').hidden, false);
	assert.equal(document.querySelector('#tabDownloads').hidden, true);
	assert.equal(document.querySelector('#tabDownloads').getAttribute('aria-selected'), 'false');
	assert.equal(document.querySelector('#tabDownloads').getAttribute('tabindex'), '-1');
	assert.equal(document.querySelector('#downloadsPanel').hidden, true);
	assert.equal(document.querySelector('#downloadsList').children.length, 0);
	const blocking = downloadCalls(calls).length;
	assert.equal(blocking, 1, 'one probe refusal is enough to remove the surface');
	assert.equal(timers.size, 0, 'a refused probe never starts the downloads poll');
});

test('an allowed read-only viewer keeps the tab and opens it from the probe cache', async () => {
	const { document, calls, timers } = await runActivity({ activityAccess: 'readOnly' });
	const tab = document.querySelector('#tabDownloads');
	assert.equal(tab.hidden, false, 'the probe keeps the tab for an allowed viewer');
	assert.equal(document.querySelector('#downloadsPanel').hidden, true, 'the probe does not open the panel');
	assert.equal(downloadCalls(calls).length, 1, 'exactly one probe');
	assert.equal(timers.size, 0, 'no poll until the tab is opened');

	tab.onclick();
	await settle();

	assert.equal(downloadCalls(calls).length, 1, 'opening renders the cached payload without a second request');
	assert.equal(document.querySelector('#downloadsPanel').hidden, false);
	assert.match(textOf(document.querySelector('#downloadsList')), /Downloading Alpha/);
	assert.doesNotMatch(textOf(document.querySelector('#downloadsList')), /Seeding Beta/);
	assert.equal(document.querySelector('#downloadsStatusPill').textContent, '1 downloading');
	assert.equal(timers.size, 1, 'the poll starts only after the tab opens');
});

test('a probe network error is silent and leaves the Downloads tab available', async () => {
	const { document, calls, timers } = await runActivity({ activityAccess: 'readOnly', probeError: true });
	assert.equal(document.querySelector('#tabDownloads').hidden, false, 'a probe failure does not hide the tab');
	assert.equal(document.querySelector('#tabActivity').getAttribute('aria-selected'), 'true');
	assert.equal(document.querySelector('#activityPanel').hidden, false);
	assert.equal(document.querySelector('#downloadsPanel').hidden, true);
	assert.equal(downloadCalls(calls).length, 1);
	assert.equal(timers.size, 0);
	assert.doesNotMatch(document.querySelector('#activityMessage').textContent, /Failed to fetch|unavailable/i, 'the probe error never reaches the page message');

	// The tab still works and the click path reports the failure in place.
	document.querySelector('#tabDownloads').onclick();
	await settle();
	assert.equal(downloadCalls(calls).length, 2, 'the click path retries');
	assert.match(textOf(document.querySelector('#downloadsStatus')), /Status unavailable/);
});

test('the #downloads deep link still works and #logs is unchanged', async () => {
	const deepLink = await runActivity({ hash: '#downloads' });
	assert.equal(deepLink.document.querySelector('#tabDownloads').getAttribute('aria-selected'), 'true');
	assert.equal(deepLink.document.querySelector('#downloadsPanel').hidden, false);
	const logs = await runActivity({ hash: '#logs' });
	assert.equal(logs.document.querySelector('#tabLogs').getAttribute('aria-selected'), 'true');
	assert.equal(logs.document.querySelector('#logsPanel').hidden, false);
	assert.equal(downloadCalls(logs.calls).length, 0, 'Logs does not start the download poll');
});

test('an empty downloading view names the seeding and queue counts instead of going blank', async () => {
	const emptyCounts = { downloading: 0, queued: 0, seeding: 2, paused: 0, checking: 0, moving: 0, attention: 0, other: 0 };
	const { document } = await runActivity({
		hash: '#downloads',
		downloads: filter => downloadsPayload(filter, { rows: [], counts: emptyCounts })
	});
	const list = document.querySelector('#downloadsList');
	const text = textOf(list);
	assert.ok(list.children.length > 0, 'the panel renders an empty state rather than nothing');
	assert.match(text, /Nothing is downloading right now/);
	assert.match(text, /2 torrents in the queue/);
	assert.match(text, /2 seeding/);
	assert.match(text, /Choose Seeding or Everything/);
	assert.equal(document.querySelector('#downloadsStatusPill').hidden, true);
});

test('the owner list defaults to downloading and the empty state uses queue counts', async () => {
	const document = fakeDocument();
	const calls = [];
	const timers = new Set();
	let id = 0;
	const payload = {
		configured: true, enabled: true, reachable: true, stale: false, state: 'ok',
		generation: 'g1', checkedAt: Date.now(), upstreamAt: Date.now(),
		filters: { categories: [], applied: { filter: 'downloading', category: null } },
		page: { limit: 50, offset: 0, count: 0, hasMore: false, nextOffset: null, previousOffset: null },
		global: { downloadSpeed: 0, uploadSpeed: 0, connection: 'connected' },
		rows: [], summary: { rows: 0, attention: 0, downloading: 0 }
	};
	const queue = { counts: { downloading: 0, queued: 0, seeding: 3, paused: 0, checking: 0, moving: 0, attention: 0, other: 2 } };
	const context = {
		document, setTimeout(handler, delay) { const handle = ++id; timers.add(handle); return handle; },
		clearTimeout(handle) { timers.delete(handle); }, clearInterval() {}, setInterval() { return ++id; },
		AbortController, URLSearchParams, window: { addEventListener() {} },
		fetch: async (url, options = {}) => {
			calls.push({ url: String(url), options });
			if (String(url) === '/api/qbittorrent/summary') return { ok: true, status: 200, json: async () => queue };
			return { ok: true, status: 200, json: async () => payload };
		}
	};
	vm.runInNewContext(ownerJs, context);
	await settle();

	const list = calls.find(call => call.url.startsWith('/api/qbittorrent/downloads?'));
	assert.ok(list, 'the list is requested');
	assert.match(list.url, /filter=downloading/, 'the owner list defaults to downloading');
	assert.equal(document.querySelector('#qbFilter').value, 'downloading');
	assert.match(document.querySelector('#qbCount').textContent, /0 downloading/);
	const empty = document.querySelector('#qbEmpty');
	assert.equal(empty.hidden, false);
	assert.match(empty.textContent, /Nothing is downloading right now/);
	assert.match(empty.textContent, /5 torrents in the queue/);
	assert.match(empty.textContent, /3 seeding/);
	assert.equal(timers.size, 1, 'the queue counts reuse the existing poll timer');
	assert.equal(calls.filter(call => call.url === '/api/qbittorrent/summary').length, 1, 'counts are read once from the existing summary route');
});
