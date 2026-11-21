import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

/* Focused release 098 coverage for the Activity / Logs split, stable
 * newest-first ordering and refresh-safe tab/filter/pagination state. */

class Element {
	constructor(tag = 'div', document = null) {
		this.tag = tag;
		this.document = document;
		this.children = [];
		this.textContent = '';
		this.className = '';
		this.hidden = false;
		this.dataset = {};
		this.style = {};
		this.value = '';
		this.listeners = {};
		this.tabIndex = 0;
	}
	append(...items) { this.children.push(...items); }
	replaceChildren(...items) { this.children = items; }
	setAttribute(name, value) { this[name] = String(value); }
	getAttribute(name) { return this[name] === undefined ? null : String(this[name]); }
	addEventListener(name, handler) { (this.listeners[name] ||= []).push(handler); }
	focus() { if (this.document) this.document.activeElement = this; }
}
function fakeDocument(selectors = {}) {
	const nodes = {};
	const document = {
		hidden: false,
		activeElement: null,
		nodes,
		createElement(tag) { return new Element(tag, document); },
		createTextNode(text) { return Object.assign(new Element('text', document), { textContent: text }); },
		querySelector(key) { return nodes[key] ||= new Element('div', document); }
	};
	for (const [key, value] of Object.entries(selectors)) document.querySelector(key).value = value;
	return document;
}
function walk(root, output = []) {
	output.push(root);
	for (const child of root.children || []) walk(child, output);
	return output;
}
function textOf(root) { return walk(root).map(node => node.textContent).filter(Boolean).join(' | '); }
function buttons(root) { return walk(root).filter(node => node.tag === 'button' && node.textContent === 'Sign out'); }
async function settle() {
	await new Promise(resolve => setImmediate(resolve));
	await new Promise(resolve => setImmediate(resolve));
}
const now = Date.now();
function event(index, overrides = {}) {
	return { id: 'e' + index, type: 'playback', time: now - index * 60000, title: 'Event ' + index,
		state: 'ended', position: 60, local: false, browser: 'Mozilla/5.0 (Windows NT 10.0)', ...overrides };
}
function snapshot() {
	return {
		active: [], downloads: [],
		recent: [event(0), event(1), event(2), event(3), event(4), event(5), event(6)],
		browsers: [
			{ id: 'b4', personName: 'Unknown date', browser: 'Mozilla/5.0', localBrowser: false },
			{ id: 'b5', personName: 'Oldest', browser: 'Mozilla/5.0', created: now - 3 * 3600000, localBrowser: false },
			{ id: 'b2', personName: 'Tie first', browser: 'Mozilla/5.0', created: now - 2 * 3600000, localBrowser: false },
			{ id: 'b1', personName: 'Newest', browser: 'Mozilla/5.0', created: now - 3600000, localBrowser: false },
			{ id: 'b3', personName: 'Tie second', browser: 'Mozilla/5.0', created: now - 2 * 3600000, localBrowser: false }
		],
		stats: { active: 0, plays: 0, remoteIps: 0, failed: 0 }, bandwidth: null,
		viewing: { since: now, users: [] }, page: { limit: 7, offset: 0, total: 7, hasMore: false, retentionDays: 30 },
		facets: { users: [], devices: [] }, historySince: now, lastLogins: {}
	};
}

test('Activity owns the default compact view and Logs owns filters, full history and diagnostics', () => {
	const html = readFileSync(new URL('../public/activity.html', import.meta.url), 'utf8');
	assert.match(html, /role="tablist"/);
	assert.match(html, /id="tabActivity"[^>]*role="tab"[^>]*aria-selected="true"[^>]*aria-controls="activityPanel"[^>]*tabindex="0"/);
	assert.match(html, /id="tabLogs"[^>]*role="tab"[^>]*aria-selected="false"[^>]*aria-controls="logsPanel"[^>]*tabindex="-1"/);
	assert.match(html, /id="activityPanel"[^>]*role="tabpanel"[^>]*aria-labelledby="tabActivity"[^>]*tabindex="0"/);
	assert.match(html, /id="logsPanel"[^>]*role="tabpanel"[^>]*aria-labelledby="tabLogs"[^>]*tabindex="0"[^>]*hidden/);
	assert.match(html, /id="recentPreview"/);
	assert.match(html, /id="openLogs"/);
	assert.match(html, /id="history"/);
	const preview = html.indexOf('id="recentPreview"');
	const browsers = html.indexOf('id="browsers"');
	const totals = html.indexOf('id="viewingTotals"');
	const logs = html.indexOf('id="logsPanel"');
	assert.ok(preview > 0 && preview < browsers && browsers < totals, 'recent activity is near the top of Activity');
	assert.ok(logs > totals, 'the full log panel follows the Activity panel and is hidden by default');
});

test('tabs, sorting, preview and refresh preserve selection, filter and pagination', async () => {
	const document = fakeDocument({ '#filter': 'all' });
	const calls = [];
	const context = {
		document, Node: Element,
		fetch: async url => { calls.push(url); return { ok: true, json: async () => snapshot() }; },
		setInterval() {}, setTimeout() {}, clearTimeout() {}
	};
	for (const file of ['../public/activity-summary.js', '../public/activity.js']) {
		vm.runInNewContext(readFileSync(new URL(file, import.meta.url), 'utf8'), context);
	}
	await settle();

	const activityTab = document.querySelector('#tabActivity');
	const downloadsTab = document.querySelector('#tabDownloads');
	const logsTab = document.querySelector('#tabLogs');
	const activityPanel = document.querySelector('#activityPanel');
	const logsPanel = document.querySelector('#logsPanel');
	const downloadsPanel = document.querySelector('#downloadsPanel');
	assert.equal(activityTab.getAttribute('aria-selected'), 'true', 'Activity is the landing tab');
	assert.equal(activityPanel.hidden, false);
	assert.equal(downloadsTab.getAttribute('aria-selected'), 'false');
	assert.equal(logsTab.getAttribute('aria-selected'), 'false');
	assert.equal(downloadsPanel.hidden, true);
	assert.equal(logsPanel.hidden, true);

	// Downloads stays one click away.
	downloadsTab.onclick();
	assert.equal(downloadsTab.getAttribute('aria-selected'), 'true');
	assert.equal(activityTab.getAttribute('aria-selected'), 'false');
	assert.equal(downloadsPanel.hidden, false);
	assert.equal(activityPanel.hidden, true);
	assert.equal(logsPanel.hidden, true);
	activityTab.onclick();
	assert.equal(activityTab.getAttribute('aria-selected'), 'true');
	assert.equal(downloadsTab.getAttribute('aria-selected'), 'false');
	assert.equal(activityPanel.hidden, false);
	assert.equal(downloadsPanel.hidden, true);
	assert.equal(logsPanel.hidden, true);

	assert.equal(document.querySelector('#recentPreview').children.length, 5, 'preview is compact');
	assert.equal(document.querySelector('#history').children.length, 7, 'Logs keeps the full page');
	assert.match(textOf(document.querySelector('#recentPreview')), /Event 0/);
	assert.doesNotMatch(textOf(document.querySelector('#recentPreview')), /Event 5/, 'preview stops at five');

	const ids = buttons(document.querySelector('#browsers')).map(button => button.dataset.browserId);
	assert.deepEqual(ids, ['b1', 'b2', 'b3', 'b5', 'b4'], 'newest first, stable tie, unknown last');

	// Pagination changes the offset and refreshes through the server.
	document.querySelector('#historyNext').onclick();
	await settle();
	assert.match(calls.at(-1), /offset=50/);

	logsTab.onclick();
	assert.equal(logsTab.getAttribute('aria-selected'), 'true');
	assert.equal(activityTab.getAttribute('aria-selected'), 'false');
	assert.equal(logsPanel.hidden, false);
	assert.equal(activityPanel.hidden, true);

	document.querySelector('#filter').value = 'login';
	document.querySelector('#filter').focus();
	await context.refresh();
	await settle();
	assert.equal(logsTab.getAttribute('aria-selected'), 'true', 'refresh keeps the selected tab');
	assert.equal(logsPanel.hidden, false);
	assert.equal(document.querySelector('#filter').value, 'login', 'refresh keeps the filter');
	assert.match(calls.at(-1), /offset=50/);
	assert.match(calls.at(-1), /type=login/);
	assert.equal(document.activeElement, document.querySelector('#filter'), 'refresh does not steal focus');

	// The Activity shortcut switches to Logs without resetting state.
	activityTab.onclick();
	document.querySelector('#openLogs').onclick();
	assert.equal(logsTab.getAttribute('aria-selected'), 'true');
	assert.equal(logsPanel.hidden, false);

	// Arrow keys move and activate the neighbouring tab with focus.
	activityTab.focus();
	const keydown = activityTab.listeners.keydown[0];
	assert.ok(keydown, 'tab keyboard handler is installed');
	keydown({ key: 'ArrowRight', preventDefault() {} });
	assert.equal(logsTab.getAttribute('aria-selected'), 'true');
	assert.equal(document.activeElement, logsTab);
	keydown({ key: 'Home', preventDefault() {} });
	assert.equal(activityTab.getAttribute('aria-selected'), 'true');
	assert.equal(document.activeElement, activityTab);
});
