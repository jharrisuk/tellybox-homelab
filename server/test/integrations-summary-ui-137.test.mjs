/* qBittorrent read-only statistics on the Settings page.
 *
 * Configuration moved to installation settings on port 8990. The main Settings
 * page may show aggregate counts to a trusted local/home caller, but it never
 * renders a form, a credential field or a configuration action.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

class Element {
	constructor(tag = 'div') {
		this.tag = tag;
		this.children = [];
		this.textContent = '';
		this.className = '';
		this.id = '';
		this.name = '';
		this.placeholder = '';
		this.href = '';
	}
	append(...items) { this.children.push(...items); }
	replaceChildren(...items) { this.children = items; }
	querySelector() { return null; }
}

function fakeDocument() {
	const nodes = {};
	return {
		nodes,
		createElement: tag => new Element(tag),
		createTextNode: text => Object.assign(new Element('text'), { textContent: String(text) }),
		querySelector: key => (nodes[key] ||= new Element())
	};
}

function all(root) {
	return [root, ...(root.children || []).flatMap(all)];
}

function textOf(root) {
	return all(root).map(node => node.textContent).filter(Boolean).join(' | ');
}

function tagsOf(root) {
	return all(root).map(node => node.tag).filter(tag => tag !== 'text');
}

function valuesOf(root) {
	return all(root).filter(node => node.className === 'activity-stat-value').map(node => node.textContent);
}

async function flush() {
	for (let i = 0; i < 24; i++) await Promise.resolve();
}

const summaryFixture = {
	readOnly: true,
	state: 'ok',
	configured: true,
	enabled: true,
	reachable: true,
	stale: false,
	counts: { downloading: 3, queued: 2, seeding: 9, paused: 0, checking: 0, moving: 0, attention: 1, other: 0 },
	countsLowerBound: ['downloading'],
	transfer: { downloadSpeed: 4200000, uploadSpeed: 1100000, connection: 'connected' },
	checkedAt: 1700000000000,
	hasMore: true
};

function loadSettings({ status = 200, summary }) {
	const document = fakeDocument();
	const root = document.querySelector('#qbittorrentSettings');
	const requested = [];
	const context = {
		document,
		fetch: async url => {
			requested.push(String(url));
			if (summary === undefined) return { status, ok: false, json: async () => ({}) };
			return { status, ok: status === 200, json: async () => summary };
		}
	};
	vm.runInNewContext(readFileSync(new URL('../public/qbittorrent-settings.js', import.meta.url), 'utf8'), context);
	return { root, requested, text: () => textOf(root) };
}

function assertReadOnlyPanel(root, body) {
	const tags = tagsOf(root);
	for (const forbidden of ['form', 'input', 'button', 'select', 'textarea']) {
		assert.equal(tags.includes(forbidden), false, 'the read-only panel has no ' + forbidden);
	}
	const links = all(root).filter(node => node.tag === 'a');
	assert.equal(links.length, 0, 'configuration is not linked from the read-only panel');
	for (const node of all(root)) {
		if (node.tag === 'a') continue;
		assert.equal(node.name, '', 'no field name is set');
		assert.equal(node.placeholder, '', 'no credential placeholder is set');
		assert.equal(node.href, '', 'no navigation action is set');
	}
	assert.doesNotMatch(body, /\bsave\b/i);
	assert.doesNotMatch(body, /\bremove\b/i);
	assert.doesNotMatch(body, /\bdelete\b/i);
	assert.doesNotMatch(body, /\bconfirm\b/i);
	assert.doesNotMatch(body, /leave blank/i);
	assert.doesNotMatch(body, /password|username field/i);
	assert.doesNotMatch(body, /magnet:/i);
	assert.doesNotMatch(body, /\btracker\b/i);
	assert.doesNotMatch(body, /\b[a-f0-9]{40}\b/i, 'no torrent hash is rendered');
}

test('a readable summary renders activity counts and no controls', async () => {
	const { root, requested, text } = loadSettings({ summary: summaryFixture });
	await flush();
	const body = text();

	assert.match(body, /Downloads/i);
	assert.match(body, /Connected\./i);
	assert.match(body, /Downloading/i);
	assert.match(body, /Queued/i);
	assert.match(body, /Seeding/i);
	assert.match(body, /Need attention/i);
	assert.deepEqual(valuesOf(root), ['3', '2', '9', '1'], 'the activity grid shows the reported counts');
	assert.match(body, /MB\/s down/i);
	assert.match(body, /lower bound/i, 'a capped query count is disclosed as a lower bound');
	assert.match(body, /Last checked/i);
	assert.match(body, /installation settings on port 8990/i);

	assertReadOnlyPanel(root, body);
	assert.deepEqual(requested, ['/api/qbittorrent/summary'], 'the page asks only for the sanitized summary');
});

test('a remote caller is told statistics are unavailable and gets no controls', async () => {
	const { root, text } = loadSettings({ status: 403 });
	await flush();
	const body = text();

	assert.match(body, /available at home or to an installation administrator/i);
	assertReadOnlyPanel(root, body);
});

test('a switched-off integration says so without implying a zero queue', async () => {
	const summary = {
		readOnly: true, state: 'disabled', configured: true, enabled: false,
		counts: { downloading: 0, queued: 0, seeding: 0, paused: 0, checking: 0, moving: 0, attention: 0, other: 0 },
		transfer: null, checkedAt: 0, hasMore: false
	};
	const { root, text } = loadSettings({ summary });
	await flush();
	const body = text();

	assert.match(body, /Switched off/i);
	assert.deepEqual(valuesOf(root), [], 'a disabled integration does not imply a zero download queue');
	assertReadOnlyPanel(root, body);
});

test('an unreachable integration reports the failure instead of a zero queue', async () => {
	const summary = {
		readOnly: true, state: 'unreachable', configured: true, enabled: true,
		reachable: false, stale: false,
		counts: { downloading: 0, queued: 0, seeding: 0, paused: 0, checking: 0, moving: 0, attention: 0, other: 0 },
		transfer: null, checkedAt: 1700000000000, hasMore: false
	};
	const { root, text } = loadSettings({ summary });
	await flush();
	const body = text();

	assert.match(body, /Could not reach qBittorrent/i);
	assert.deepEqual(valuesOf(root), [], 'a failed check must not look like zero downloads');
	assertReadOnlyPanel(root, body);
});
