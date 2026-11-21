import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

/* Focused DOM regression for the release 098 browser sign-out row binding.
 * The old renderer used `for (var browser of browsers)`, so every onclick
 * closure revoked the final row. These tests click the first, middle and last
 * rows across rerenders and verify both the revoke id and that only the target
 * row disappears. */

class Element {
	constructor(tag = 'div') {
		this.tag = tag;
		this.children = [];
		this.textContent = '';
		this.className = '';
		this.hidden = false;
		this.dataset = {};
		this.style = {};
		this.value = '';
	}
	append(...items) { this.children.push(...items); }
	replaceChildren(...items) { this.children = items; }
	setAttribute(name, value) { this[name] = String(value); }
	addEventListener() {}
}
function fakeDocument(selectors = {}) {
	const nodes = {};
	const document = {
		hidden: false,
		nodes,
		createElement: tag => new Element(tag),
		createTextNode: text => Object.assign(new Element('text'), { textContent: text }),
		querySelector: key => nodes[key] ||= new Element()
	};
	for (const [key, value] of Object.entries(selectors)) document.querySelector(key).value = value;
	return document;
}
function walk(root, output = []) {
	output.push(root);
	for (const child of root.children || []) walk(child, output);
	return output;
}
function textOf(root) {
	return walk(root).map(node => node.textContent).filter(Boolean).join(' | ');
}
function rows(root) {
	return walk(root).filter(node => node.tag === 'tr');
}
function buttons(root) {
	return walk(root).filter(node => node.tag === 'button' && node.textContent === 'Sign out');
}
function rowTexts(host) {
	return rows(host).map(row => textOf(row));
}
async function settle() {
	await new Promise(resolve => setImmediate(resolve));
	await new Promise(resolve => setImmediate(resolve));
}
function snapshotWith(browsers) {
	return {
		active: [], downloads: [], recent: [],
		browsers,
		stats: { active: 0, plays: 0, remoteIps: 0, failed: 0 },
		bandwidth: null,
		viewing: { since: Date.now(), users: [] },
		page: { limit: 50, offset: 0, total: 0, hasMore: false, retentionDays: 30 },
		facets: { users: [], devices: [] },
		historySince: Date.now(), lastLogins: {}
	};
}
function browser(id, name) {
	// These binding tests are about which displayed row owns which callback, not
	// about newest-first ordering. A shared constant timestamp keeps the rendered
	// order deterministic even when Date.now() crosses a millisecond between
	// fixtures. Newest-first ordering has its own distinct-timestamp coverage.
	return { id, personName: name, browser: 'Mozilla/5.0 (Windows NT 10.0)', created: 1700000000000,
		lastSeen: 1700000000000, localBrowser: false, ip: '192.0.2.' + id.slice(1) };
}

test('shared renderer binds first, middle and last sign-out buttons per row across rerenders', () => {
	const document = fakeDocument();
	const context = { document };
	vm.runInNewContext(readFileSync(new URL('../public/activity-summary.js', import.meta.url), 'utf8'), context);
	const lib = context.TellyboxActivitySummary;
	const host = document.querySelector('#browsers');
	const calls = [];
	const list = [browser('b1', 'Browser A'), browser('b2', 'Browser B'), browser('b3', 'Browser C'), browser('b4', 'Browser D')];

	lib.renderBrowsers(host, { browsers: list }, { onSignOut: entry => calls.push(entry.id) });
	assert.equal(buttons(host).length, 4);
	buttons(host)[0].onclick();
	buttons(host)[2].onclick();
	buttons(host)[3].onclick();
	assert.deepEqual(calls, ['b1', 'b3', 'b4'], 'first, middle and last must revoke their own ids');

	calls.length = 0;
	lib.renderBrowsers(host, { browsers: [list[2], list[0], list[3], list[1]] }, { onSignOut: entry => calls.push(entry.id) });
	buttons(host)[0].onclick();
	buttons(host)[1].onclick();
	buttons(host)[3].onclick();
	assert.deepEqual(calls, ['b3', 'b1', 'b2'], 'a rerender must not leave stale closures');
});

test('Activity sign-out removes only the clicked browser across rerenders and keeps failed revokes visible', async () => {
	const document = fakeDocument({ '#filter': 'all' });
	let browsers = [browser('b1', 'Browser A'), browser('b2', 'Browser B'), browser('b3', 'Browser C'), browser('b4', 'Browser D')];
	const revokes = [];
	let failRevoke = false;
	const fetch = async (url, options = {}) => {
		if (url.startsWith('/api/activity')) return { ok: true, json: async () => snapshotWith(browsers) };
		if (url === '/api/auth/revoke-browser') {
			const body = JSON.parse(options.body);
			if (failRevoke) return { ok: false, status: 500, json: async () => ({ error: 'Revoke failed' }) };
			revokes.push(body.id);
			browsers = browsers.filter(entry => entry.id !== body.id);
			return { ok: true, json: async () => ({ ok: true }) };
		}
		throw new Error('unexpected request ' + url);
	};
	const context = { document, Node: Element, fetch, setInterval() {}, setTimeout() {}, clearTimeout() {} };
	for (const file of ['../public/activity-summary.js', '../public/activity.js']) {
		vm.runInNewContext(readFileSync(new URL(file, import.meta.url), 'utf8'), context);
	}
	await settle();

	const host = document.querySelector('#browsers');
	assert.equal(buttons(host).length, 4, 'four saved browsers are rendered');
	assert.match(rowTexts(host).join('\n'), /Browser A/);

	buttons(host)[1].onclick();
	await settle();
	assert.deepEqual(revokes, ['b2'], 'middle row revokes its own id');
	assert.equal(buttons(host).length, 3);
	assert.doesNotMatch(rowTexts(host).join('\n'), /Browser B/);
	assert.match(rowTexts(host).join('\n'), /Browser A/);
	assert.match(rowTexts(host).join('\n'), /Browser C/);
	assert.match(rowTexts(host).join('\n'), /Browser D/);

	buttons(host)[2].onclick();
	await settle();
	assert.deepEqual(revokes, ['b2', 'b4'], 'last row after rerender revokes its own id');
	assert.equal(buttons(host).length, 2);
	assert.deepEqual(rowTexts(host).filter(text => /Browser/.test(text)).map(text => text.match(/Browser [A-D]/)[0]), ['Browser A', 'Browser C']);

	buttons(host)[0].onclick();
	await settle();
	assert.deepEqual(revokes, ['b2', 'b4', 'b1'], 'first row after rerender revokes its own id');
	assert.equal(buttons(host).length, 1);
	assert.match(rowTexts(host).join('\n'), /Browser C/);

	failRevoke = true;
	buttons(host)[0].onclick();
	await settle();
	assert.equal(buttons(host).length, 1, 'a failed revoke must leave the row visible');
	assert.match(rowTexts(host).join('\n'), /Browser C/);
	assert.match(document.querySelector('#activityMessage').textContent, /Revoke failed/);
	assert.deepEqual(revokes, ['b2', 'b4', 'b1'], 'a failed revoke must not be recorded as a success');
});
