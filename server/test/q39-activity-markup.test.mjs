/* Q39 REGRESSION (0.26.50 batch): Activity downloads markup and rendering.
 *
 * Already covered elsewhere, not repeated here: the downloading default and
 * its summary omission (activity-downloads-default-143), the probe/filter
 * lifecycle (activity-downloads-batch-2026-11-20), the filter allowlist
 * (qbittorrent-filters-144), and the lower-bound counts at module level
 * (qbittorrent-filters-144, qbittorrent-batch-2026-11-20).
 *
 * New cells pinned here:
 *  - the "Read-only monitoring" paragraph is gone from the page and renderers;
 *  - the downloads filter lives in the heading actions, not the panel body;
 *  - #downloadsList carries qb-compact-list; the panel keeps one button;
 *  - the seeding summary omits the pill's count (143 only pins downloading);
 *  - the Everything summary must not repeat the pill's count either;
 *  - unknown download values are omitted, never printed as "Not reported";
 *  - lower-bound counts are disclosed in the Activity panel itself;
 *  - torrent names render through textContent only.
 *
 * Offline: static markup checks plus the existing vm fake-DOM style.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const activityHtml = readFileSync(new URL('../public/activity.html', import.meta.url), 'utf8');
const activityJs = readFileSync(new URL('../public/activity.js', import.meta.url), 'utf8');
const summaryJs = readFileSync(new URL('../public/activity-summary.js', import.meta.url), 'utf8');
const downloadsJs = activityJs.slice(activityJs.indexOf('// #region downloads-monitor'), activityJs.indexOf('// #endregion downloads-monitor'));
const downloadsPanel = activityHtml.slice(activityHtml.indexOf('<section id="downloadsPanel"'), activityHtml.indexOf('<p class="auth-note">Updates automatically'));

test('the Read-only monitoring paragraph is gone from the Activity page and renderers', () => {
	for (const [name, source] of [['activity.html', activityHtml], ['activity.js', activityJs], ['activity-summary.js', summaryJs]]) {
		assert.doesNotMatch(source, /Read-only monitoring/i, name + ' must not carry the removed paragraph');
	}
});

test('the downloads filter lives in the heading actions and the list is a compact list', () => {
	assert.ok(downloadsPanel.length > 0, 'the downloads panel exists');
	// Exactly one filter select, inside the heading actions div, after the
	// heading and before the status/list body.
	assert.equal((downloadsPanel.match(/id="downloadsFilter"/g) || []).length, 1);
	const actionsStart = downloadsPanel.indexOf('<div class="streams-heading-actions">');
	assert.ok(actionsStart > downloadsPanel.indexOf('id="downloadsHeading"'), 'the actions belong to the heading');
	const actions = downloadsPanel.slice(actionsStart, downloadsPanel.indexOf('</div>', actionsStart));
	assert.match(actions, /<label class="downloads-filter">Showing<select id="downloadsFilter">/, 'the filter is a heading action');
	assert.match(actions, /<option value="downloading" selected>Downloading<\/option>/);
	assert.match(actions, /<option value="seeding">Seeding<\/option>/);
	assert.match(actions, /<option value="all">Everything<\/option>/);
	assert.ok(downloadsPanel.indexOf('id="downloadsFilter"') < downloadsPanel.indexOf('id="downloadsStatus"'), 'the filter is not in the panel body');
	assert.match(downloadsPanel, /<div id="downloadsList" class="activity-list qb-compact-list"><\/div>/, '#downloadsList keeps the compact list class');
	// One button per read-only panel: only Refresh, never a torrent action.
	assert.equal((downloadsPanel.match(/<button\b/g) || []).length, 1, 'the read-only downloads panel keeps exactly one button');
	assert.match(downloadsPanel, /<button class="button secondary" id="downloadsRefresh" type="button">Refresh downloads<\/button>/);
});

/* The existing fake-DOM harness (after activity-downloads-default-143). */
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
	return {
		hidden: false, visibilityState: 'visible', activeElement: null, nodes,
		createElement: tag => new Element(tag),
		createTextNode: text => Object.assign(new Element('text'), { textContent: text }),
		querySelector: key => nodes[key] ||= new Element(),
		addEventListener() {}
	};
}
function walk(root, output = []) { output.push(root); for (const child of root.children || []) walk(child, output); return output; }
function textOf(root) { return walk(root).map(node => node.textContent).filter(Boolean).join(' | '); }
async function settle() { for (let index = 0; index < 8; index += 1) await new Promise(resolve => setImmediate(resolve)); }

const ACTIVE = { name: 'Downloading Alpha', state: 'downloading', stateLabel: 'Downloading', progress: 0.375, size: 1000, dlspeed: 4500000, upspeed: 120000, eta: 900, ratio: 1.25 };
const SEEDING = { name: 'Seeding Beta', state: 'uploading', stateLabel: 'Seeding', progress: 1, size: 900, dlspeed: 0, upspeed: 20000, eta: null, ratio: 2.5 };
const SEEDING_TWO = { ...SEEDING, name: 'Seeding Gamma' };
const COUNTS = { downloading: 1, queued: 0, seeding: 2, paused: 0, checking: 0, moving: 0, attention: 0, other: 0 };

function payload(filter, { rows, counts = COUNTS, countsLowerBound = [] } = {}) {
	const visible = rows !== undefined ? rows
		: filter === 'downloading' ? [ACTIVE]
			: filter === 'seeding' ? [SEEDING, SEEDING_TWO] : [ACTIVE, SEEDING, SEEDING_TWO];
	return {
		readOnly: true, generatedAt: Date.now(), configured: true, enabled: true, state: 'ok',
		reachable: true, stale: false, checkedAt: Date.now(), filter,
		sampleSize: visible.length, hasMore: false, counts, countsLowerBound, rows: visible
	};
}

async function runDownloads(options = {}) {
	const document = fakeDocument();
	document.querySelector('#filter').value = 'all';
	const context = {
		document, Node: Element, location: { hash: '#downloads' }, AbortController, URLSearchParams,
		window: { addEventListener() {} },
		fetch: async url => {
			const target = String(url);
			if (target.startsWith('/api/activity/downloads')) {
				const filter = new URL(target, 'http://tellybox.test').searchParams.get('filter') || 'all';
				return { ok: true, status: 200, json: async () => payload(filter, options) };
			}
			if (target.startsWith('/api/activity/streams')) return { ok: false, status: 403, json: async () => ({}) };
			return { ok: true, status: 200, json: async () => ({ active: [], downloads: [], recent: [], browsers: [], stats: {}, bandwidth: null, viewing: { users: [] }, page: {}, facets: { users: [], devices: [] }, lastLogins: {} }) };
		},
		setInterval() { return 1; }, setTimeout() { return 1; }, clearTimeout() {}
	};
	vm.runInNewContext(summaryJs, context);
	vm.runInNewContext(activityJs, context);
	await settle();
	return document;
}
async function switchFilter(document, value) {
	document.querySelector('#downloadsFilter').value = value;
	document.querySelector('#downloadsFilter').onchange();
	await settle();
}

test('the seeding summary omits the count already shown in the pill', async () => {
	const document = await runDownloads();
	await switchFilter(document, 'seeding');
	assert.equal(document.querySelector('#downloadsStatusPill').textContent, '2 seeding');
	const summary = textOf(document.querySelector('#downloadsStatus'));
	assert.equal(summary.includes('2 seeding'), false, 'the pill owns the seeding count; the summary must not repeat it');
	assert.match(summary, /1 downloading/, 'the other bucket stays visible');
	assert.match(summary, /3 torrents in the queue/);
});

test('the Everything summary omits the count already shown in the pill', async () => {
	const document = await runDownloads();
	await switchFilter(document, 'all');
	const pill = document.querySelector('#downloadsStatusPill').textContent;
	assert.equal(pill, '3 torrents');
	const summary = textOf(document.querySelector('#downloadsStatus'));
	assert.equal(summary.includes(pill), false,
		'the pill owns the queue count under Everything; the summary repeats it ("3 torrents in the queue")');
});

test('unknown download values from the server are omitted, not printed as Not reported', async () => {
	// The sanitized route can report eta/ratio as null and size/speeds as zero.
	const document = await runDownloads({
		rows: [{ name: 'Sparse row', state: 'downloading', stateLabel: 'Downloading', progress: 0.1, size: 0, dlspeed: 500, upspeed: 0, eta: null, ratio: null }]
	});
	const list = document.querySelector('#downloadsList');
	assert.doesNotMatch(textOf(list), /Not reported/, 'no filler text anywhere in the list');
	const card = list.children[0];
	const metrics = card.children.find(child => child.className === 'qb-line-metrics');
	assert.deepEqual(metrics.children.map(child => child.textContent), ['↓ 500 B/s', '↑ 0 B/s'],
		'a zero size adds no span; unknown eta/ratio add no span; reported zeros stay');
	assert.doesNotMatch(textOf(list), /ETA|ratio/, 'unknown eta and ratio are omitted entirely');
});

test('a download row with unknown speeds omits them instead of printing Not reported', async () => {
	// Renderer-level contract: an unknown value is omitted. (The shipped route
	// coerces speeds to numbers, so this guards the renderer against any
	// payload that carries a null speed.)
	const document = await runDownloads({
		rows: [{ name: 'Unknown speeds', state: 'downloading', stateLabel: 'Downloading', progress: 0.1, size: 1000, dlspeed: null, upspeed: null, eta: null, ratio: null }]
	});
	assert.doesNotMatch(textOf(document.querySelector('#downloadsList')), /Not reported/,
		'unknown speeds must be omitted, not printed as "↓ Not reported" / "↑ Not reported"');
});

test('lower-bound counts are disclosed in the Activity downloads panel', async () => {
	const counts = { ...COUNTS, seeding: 200 };
	const document = await runDownloads({ counts, countsLowerBound: ['seeding'] });
	// Default downloading filter: the seeding bucket is a lower bound.
	assert.equal(document.querySelector('#downloadsStatusPill').textContent, '1 downloading');
	const summary = textOf(document.querySelector('#downloadsStatus'));
	assert.match(summary, /200\+ seeding/, 'the capped bucket is marked as a lower bound');
	// A total that includes a capped bucket is itself a lower bound.
	assert.match(summary, /201\+ torrents in the queue/);
	assert.match(summary, /Counts marked \+ are lower bounds/);
	await switchFilter(document, 'seeding');
	assert.equal(document.querySelector('#downloadsStatusPill').textContent, '200+ seeding', 'the pill marks the bound too');
});

test('torrent names render through textContent only, never as markup', async () => {
	const hostile = '<img src=x onerror=alert(1)>" onload="evil';
	const document = await runDownloads({
		rows: [{ ...ACTIVE, name: hostile }]
	});
	const card = document.querySelector('#downloadsList').children[0];
	const title = card.children.find(child => child.className.includes('qb-line-title'));
	assert.equal(title.textContent, hostile, 'the name is literal text, not parsed markup');
	assert.equal(title.title, hostile);
	assert.doesNotMatch(downloadsJs, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/, 'the downloads renderer builds DOM nodes only');
	for (const node of walk(document.querySelector('#downloadsList'))) {
		assert.equal(node.innerHTML, undefined, 'no node ever receives innerHTML');
	}
});
