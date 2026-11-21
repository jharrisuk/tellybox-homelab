/* NIGHT BATCH 2026-11-20: Activity downloads visibility probe.
 *
 * The one probe on page load must be tied to the filter it was requested for,
 * aborted when that filter changes, and must not leave an empty panel when it
 * fails after the viewer has already opened Downloads.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const activityJs = readFileSync(new URL('../public/activity.js', import.meta.url), 'utf8');

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
function walk(root, output = []) {
	output.push(root);
	for (const child of root.children || []) walk(child, output);
	return output;
}
function textOf(root) { return walk(root).map(node => node.textContent).filter(Boolean).join(' | '); }
async function settle() {
	for (let index = 0; index < 8; index += 1) await new Promise(resolve => setImmediate(resolve));
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

function downloadsPayload(filter) {
	const visible = filter === 'downloading' ? [ACTIVE] : filter === 'seeding' ? [SEEDING, SEEDING_TWO] : ALL_ROWS;
	return {
		readOnly: true, generatedAt: Date.now(), configured: true, enabled: true, state: 'ok',
		reachable: true, stale: false, checkedAt: Date.now(), filter,
		sampleSize: visible.length, hasMore: false, counts: COUNTS, countsLowerBound: [], rows: visible
	};
}
const jsonResponse = body => ({ ok: true, status: 200, json: async () => body });

async function runActivity({ downloads }) {
	const document = fakeDocument();
	const calls = [];
	const timers = new Set();
	let id = 0;
	let downloadIndex = 0;
	document.querySelector('#filter').value = 'all';
	const context = {
		document, Node: Element, location: { hash: '' }, AbortController, URLSearchParams,
		window: { addEventListener() {} },
		fetch: async (url, options = {}) => {
			const target = String(url);
			calls.push({ url: target, options });
			if (target.startsWith('/api/activity/downloads')) {
				const filter = new URL(target, 'http://tellybox.test').searchParams.get('filter') || 'all';
				return downloads(filter, downloadIndex++);
			}
			if (target.startsWith('/api/activity/streams')) {
				return { ok: false, status: 403, json: async () => ({ error: 'No streams.' }) };
			}
			if (target === '/api/activity/summary') {
				return { ok: true, status: 200, json: async () => activitySnapshot() };
			}
			if (target === '/api/activity' || target.startsWith('/api/activity?')) {
				return { ok: false, status: 403, json: async () => ({ error: 'Only at home.' }) };
			}
			return { ok: true, status: 200, json: async () => activitySnapshot() };
		},
		setInterval(handler, delay) { void handler; void delay; return ++id; },
		setTimeout(handler, delay) { void handler; void delay; const handle = ++id; timers.add(handle); return handle; },
		clearTimeout(handle) { timers.delete(handle); }
	};
	vm.runInNewContext(readFileSync(new URL('../public/activity-summary.js', import.meta.url), 'utf8'), context);
	vm.runInNewContext(activityJs, context);
	await settle();
	return { document, calls, timers };
}

test('the visibility probe is bound to its captured filter and aborted on a filter change', async () => {
	let releaseProbe;
	const probeGate = new Promise(resolve => { releaseProbe = resolve; });
	const { document, calls, timers } = await runActivity({
		downloads: async (filter, index) => index === 0 ? probeGate : jsonResponse(downloadsPayload(filter))
	});

	const probe = downloadCalls(calls)[0];
	assert.ok(probe, 'the page-load probe ran');
	assert.equal(downloadFilter(probe), 'downloading', 'the probe asks for the filter selected when it started');
	assert.ok(probe.options.signal, 'the probe carries an abort signal');

	// The viewer changes the filter while the probe is still in flight. The
	// probe must be aborted and its late answer must be discarded, never cached
	// under the newer filter.
	document.querySelector('#downloadsFilter').value = 'seeding';
	document.querySelector('#downloadsFilter').onchange();
	await settle();
	assert.equal(probe.options.signal.aborted, true, 'a filter change aborts the probe');

	releaseProbe(jsonResponse(downloadsPayload('downloading')));
	await settle();

	document.querySelector('#tabDownloads').onclick();
	await settle();

	const callsAfterOpen = downloadCalls(calls);
	assert.equal(callsAfterOpen.length, 2, 'opening Downloads reads the newly selected filter instead of reusing the stale probe');
	assert.equal(downloadFilter(callsAfterOpen[1]), 'seeding');
	assert.match(textOf(document.querySelector('#downloadsList')), /Seeding Beta/);
	assert.doesNotMatch(textOf(document.querySelector('#downloadsList')), /Downloading Alpha/,
		'a downloading payload is never shown under the Seeding label');
	assert.equal(timers.size, 1, 'the successful refresh keeps the single poll timer');
});

test('a probe that fails after Downloads opens falls through to exactly one refresh', async () => {
	let rejectProbe;
	const probeGate = new Promise((resolve, reject) => { rejectProbe = reject; });
	const { document, calls, timers } = await runActivity({
		downloads: async (filter, index) => index === 0 ? probeGate : jsonResponse(downloadsPayload(filter))
	});
	assert.equal(downloadCalls(calls).length, 1);

	// Open Downloads while the probe is still running. With the old behaviour
	// startDownloadsPanel returned and the probe failure left the panel empty.
	document.querySelector('#tabDownloads').onclick();
	await settle();
	assert.equal(downloadCalls(calls).length, 1, 'the open does not duplicate the in-flight probe');

	rejectProbe(new TypeError('Failed to fetch'));
	await settle();

	const refreshed = downloadCalls(calls);
	assert.equal(refreshed.length, 2, 'the failed probe triggers exactly one refresh');
	assert.equal(downloadFilter(refreshed[1]), 'downloading');
	assert.match(textOf(document.querySelector('#downloadsList')), /Downloading Alpha/,
		'the panel is populated instead of staying empty');
	assert.equal(timers.size, 1, 'the fallback refresh schedules the single poll timer');
});
