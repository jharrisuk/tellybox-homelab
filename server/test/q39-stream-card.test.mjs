/* Q39 REGRESSION (0.26.50 batch): upstream stream card markup.
 *
 * stream-monitor-ui-132 already pins the streams region's source-level safety
 * (textContent only, approved fields, no identifiers, all-unknown column
 * omission, one Refresh button) and the picked-stream line. This file adds
 * DOM-level proof of the shipped card shape, which no existing test renders:
 *  - one state badge: kind alone for tautological states (active/running/
 *    playing/ok), kind + state only for a real change such as paused;
 *  - media facts render as labelled chips, unknown facts add no chip;
 *  - the metrics line carries bytes/duration/connection count, unknowns omit;
 *  - the connection table drops columns that only repeat the card-level value,
 *    keeps partially-known columns with one dash, keeps positional labels;
 *  - provider is accepted as an alias for source, and Dispatcharr is never a
 *    source under either field;
 *  - hostile titles stay literal text.
 *
 * Offline: the existing vm fake-DOM style, synthetic payloads only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const activityJs = readFileSync(new URL('../public/activity.js', import.meta.url), 'utf8');
const summaryJs = readFileSync(new URL('../public/activity-summary.js', import.meta.url), 'utf8');

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
function byClass(root, name) { return walk(root).filter(node => String(node.className || '').split(/\s+/).includes(name)); }
async function settle() { for (let index = 0; index < 8; index += 1) await new Promise(resolve => setImmediate(resolve)); }

const BASE = {
	kind: 'live', title: 'Channel', typeLabel: 'Live', state: 'active',
	source: 'custom', profile: 'custom Default', app: 'Android TV', format: 'hls',
	codec: 'h264', resolution: '1920x1080', fps: 25, audio: 'aac 2ch',
	averageBitrateKbps: 4200, bytes: 1000, durationSeconds: 60,
	connections: { reported: null, shown: null, truncated: false, items: [] }, note: null
};

async function renderStreams(streams) {
	const document = fakeDocument();
	document.querySelector('#filter').value = 'all';
	const payload = {
		configured: true, enabled: true, source: 'onThisServer', state: 'ok', reachable: true,
		checkedAt: '2026-11-18T12:00:00.000Z', upstreamAt: '2026-11-18T11:59:30.000Z', stale: false,
		notice: '', reported: { liveChannels: streams.length, liveClients: 0, vodConnections: 0, catchupConnections: 0 },
		truncated: false, rowsReported: streams.length, rowsShown: streams.length, streams
	};
	const context = {
		document, Node: Element, location: { hash: '#streams' }, AbortController, URLSearchParams,
		window: { addEventListener() {} },
		fetch: async url => ({
			ok: true, status: 200,
			json: async () => String(url).startsWith('/api/activity/streams') ? payload
				: { active: [], downloads: [], recent: [], browsers: [], stats: {}, bandwidth: null, viewing: { users: [] }, page: {}, facets: { users: [], devices: [] }, lastLogins: {} }
		}),
		setInterval() { return 1; }, setTimeout() { return 1; }, clearTimeout() {}
	};
	vm.runInNewContext(summaryJs, context);
	vm.runInNewContext(activityJs, context);
	await settle();
	return document.querySelector('#streamsList').children;
}

const headOf = card => byClass(card, 'activity-entry-head')[0];
const badgesOf = card => headOf(card).children.filter(child => String(child.className).includes('activity-badge'));
const tableOf = card => byClass(card, 'activity-table')[0] || null;
const headersOf = table => table.children[0].children[0].children.map(th => th.textContent);
const bodyRowsOf = table => table.children[1].children.map(row => row.children.map(td => td.textContent));

test('one state badge: kind alone for tautological states, kind plus a real change otherwise', async () => {
	const cards = await renderStreams([
		{ ...BASE, title: 'Channel A', state: 'active' },
		{ ...BASE, title: 'Channel B', state: 'running' },
		{ ...BASE, title: 'Channel C', state: 'playing' },
		{ ...BASE, title: 'Channel D', state: 'ok' },
		{ ...BASE, title: 'Channel E', state: null },
		{ ...BASE, title: 'Channel F', state: 'paused' },
		{ ...BASE, title: 'Film G', typeLabel: 'VOD', state: 'playing' }
	]);
	assert.equal(cards.length, 7);
	for (const [index, expected] of [[0, 'Live'], [1, 'Live'], [2, 'Live'], [3, 'Live'], [4, 'Live'], [6, 'VOD']]) {
		const badges = badgesOf(cards[index]);
		assert.equal(badges.length, 1, 'exactly one state badge in the card head');
		assert.equal(badges[0].textContent, expected, 'no duplicate Live + active badge');
		assert.equal(badges[0].className, 'activity-badge stream-kind', 'a tautological state adds no status class');
		assert.doesNotMatch(textOf(cards[index]), /active|running|playing|\bok\b/i, 'the tautology is never printed');
	}
	const paused = badgesOf(cards[5]);
	assert.equal(paused.length, 1);
	assert.equal(paused[0].textContent, 'Live · Paused', 'a real state change is appended to the kind');
	assert.match(paused[0].className, /status-paused/);
	assert.doesNotMatch(textOf(cards[5]), /Not reported/);
});

test('media facts render as labelled chips and unknown facts add no chip', async () => {
	const cards = await renderStreams([
		{ ...BASE, title: 'Full facts' },
		{ ...BASE, title: 'No facts', codec: null, resolution: null, fps: null, audio: null, format: null, averageBitrateKbps: null }
	]);
	const chips = byClass(cards[0], 'stream-chips')[0];
	assert.ok(chips, 'the media chips container exists');
	assert.deepEqual(chips.children.map(chip => chip.getAttribute('aria-label')), [
		'Resolution: 1920x1080', 'Frame rate: 25 fps', 'Video codec: h264',
		'Audio: aac 2ch', 'Format: hls', 'Average bitrate: 4.2 Mbps avg'
	], 'chips keep the reference order and carry accessible labels');
	assert.deepEqual(chips.children.map(chip => chip.textContent), [
		'1920x1080', '25 fps', 'h264', 'aac 2ch', 'hls', '4.2 Mbps avg'
	]);
	assert.equal(byClass(cards[1], 'stream-chips').length, 0, 'no chips container when every media fact is unknown');
	assert.doesNotMatch(textOf(cards[1]), /Not reported/, 'unknown media facts are omitted, not filler');
});

test('the metrics line carries reported bytes, duration and connection count only', async () => {
	const cards = await renderStreams([
		{ ...BASE, title: 'Known metrics', connections: { reported: 1, shown: 1, truncated: false, items: [] } },
		{ ...BASE, title: 'Unknown metrics', bytes: null, durationSeconds: null },
		{ ...BASE, title: 'Large metrics', bytes: 1073741824, durationSeconds: 3661, connections: { reported: 2, shown: 2, truncated: false, items: [] } }
	]);
	assert.equal(byClass(cards[0], 'stream-metrics')[0].textContent, '1,000 B · 0:01:00 · 1 connection');
	assert.equal(byClass(cards[1], 'stream-metrics').length, 0, 'no metrics line when nothing is reported');
	assert.doesNotMatch(textOf(cards[1]), /Not reported/);
	assert.equal(byClass(cards[2], 'stream-metrics')[0].textContent, '1 GB · 1:01:01 · 2 connections');
});

test('the connection table drops columns that only repeat the card-level value', async () => {
	const connectedAt = '2026-11-18T11:58:00.000Z';
	const cards = await renderStreams([
		{
			...BASE, title: 'Single viewer',
			connections: {
				reported: 1, shown: 1, truncated: false, items: [
					{ id: 'secret-connection-id', clientIp: '203.0.113.5', app: 'Android TV', source: 'custom', profile: 'custom Default', format: 'hls', connectedAt, durationSeconds: 60 }
				]
			}
		},
		{
			...BASE, title: 'Mixed apps',
			connections: {
				reported: 2, shown: 2, truncated: false, items: [
					{ app: 'Android TV', source: 'custom', profile: 'custom Default', format: 'hls', connectedAt, durationSeconds: 60 },
					{ app: 'VLC', source: 'custom', profile: 'custom Default', format: 'hls', connectedAt, durationSeconds: 90 }
				]
			}
		},
		{
			...BASE, title: 'Partial profile',
			connections: {
				reported: 2, shown: 2, truncated: false, items: [
					{ app: 'Android TV', profile: 'custom Default', connectedAt, durationSeconds: 60 },
					{ app: null, profile: null, connectedAt, durationSeconds: 60 }
				]
			}
		},
		{
			...BASE, title: 'Only times',
			connections: { reported: 1, shown: 1, truncated: false, items: [{ connectedAt }] }
		}
	]);
	// A single connection that restates the card keeps only the positional
	// label and the facts that are not already on the card.
	assert.deepEqual(headersOf(tableOf(cards[0])), ['Connection', 'Connected', 'Duration']);
	const singleRow = bodyRowsOf(tableOf(cards[0]))[0];
	assert.equal(singleRow[0], 'Connection 1');
	assert.ok(singleRow[1] && singleRow[1] !== '—', 'the known connected time renders');
	assert.equal(singleRow[2], '0:01:00');
	// A column with a genuinely different value survives.
	assert.deepEqual(headersOf(tableOf(cards[1])), ['Connection', 'App', 'Connected', 'Duration']);
	assert.deepEqual(bodyRowsOf(tableOf(cards[1])).map(row => row[1]), ['Android TV', 'VLC']);
	// Partially unknown columns survive with one dash for each missing cell.
	assert.deepEqual(headersOf(tableOf(cards[2])), ['Connection', 'App', 'Profile', 'Connected', 'Duration']);
	assert.deepEqual(bodyRowsOf(tableOf(cards[2])).map(row => row[1]), ['Android TV', '—']);
	assert.deepEqual(bodyRowsOf(tableOf(cards[2])).map(row => row[2]), ['custom Default', '—']);
	// Every detail column unknown: only the positional label and known times.
	assert.deepEqual(headersOf(tableOf(cards[3])), ['Connection', 'Connected']);
	for (const card of cards) {
		assert.doesNotMatch(textOf(card), /secret-connection-id|203\.0\.113\.5/, 'upstream identifiers and addresses never render');
		assert.doesNotMatch(textOf(card), /Not reported/, 'omitted columns never print filler');
	}
});

test('provider is accepted as an alias for source, and Dispatcharr is never a source', async () => {
	const connectedAt = '2026-11-18T11:58:00.000Z';
	const cards = await renderStreams([
		{
			...BASE, title: 'Provider only', source: undefined, provider: 'Account X',
			connections: { reported: 1, shown: 1, truncated: false, items: [{ provider: 'Account X', connectedAt, durationSeconds: 60 }] }
		},
		{
			...BASE, title: 'Different connection provider', source: undefined, provider: 'Account X',
			connections: { reported: 1, shown: 1, truncated: false, items: [{ provider: 'Other Account', connectedAt, durationSeconds: 60 }] }
		},
		{ ...BASE, title: 'Tautology source', source: 'Dispatcharr', provider: 'Real Provider' },
		{ ...BASE, title: 'Tautology provider', source: undefined, provider: 'Dispatcharr' }
	]);
	assert.match(textOf(byClass(cards[0], 'stream-subline')[0]), /Account X/, 'the provider alias renders on the card');
	assert.deepEqual(headersOf(tableOf(cards[0])), ['Connection', 'Connected', 'Duration'],
		'a connection provider equal to the card provider is a repeating column and is dropped');
	assert.deepEqual(headersOf(tableOf(cards[1])), ['Connection', 'Source', 'Connected', 'Duration'],
		'a different connection provider keeps the Source column');
	assert.deepEqual(bodyRowsOf(tableOf(cards[1])).map(row => row[1]), ['Other Account']);
	assert.doesNotMatch(textOf(cards[2]), /Dispatcharr/, 'an explicit source wins over the provider alias and is still filtered');
	assert.doesNotMatch(textOf(cards[3]), /Dispatcharr/, 'the provider alias is filtered too');
});

test('a hostile stream title stays literal text', async () => {
	const hostile = '<img src=x onerror=alert(1)>" onload="evil';
	const cards = await renderStreams([{ ...BASE, title: hostile }]);
	const title = byClass(cards[0], 'activity-entry-title')[0];
	assert.equal(title.textContent, hostile, 'the title is textContent, never parsed markup');
	for (const node of walk(cards[0])) assert.equal(node.innerHTML, undefined);
});
