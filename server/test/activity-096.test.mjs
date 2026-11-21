import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import express from 'express';
import { createActivity } from '../activity.mjs';
import { installAuth } from '../auth.mjs';

const alice = 'a'.repeat(32), bob = 'b'.repeat(32), carol = 'c'.repeat(32);
const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function activityFixture(t, metrics = {}) {
	const directory = mkdtempSync(path.join(tmpdir(), 'tellybox-activity-096-'));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	return { directory, activity: createActivity(directory, metrics) };
}

test('snapshot pages and filters server-side with a bounded recent window', async t => {
	const { activity } = activityFixture(t);
	for (let i = 0; i < 250; i++) {
		activity.record('playback', { personId: i % 5 === 0 ? carol : bob, personName: i % 5 === 0 ? 'Carol' : 'Bob',
			local: i % 2 === 0, browser: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
		{ title: 'Episode ' + i, state: 'ended', position: 120, itemId: 'item-' + i, ip: '192.0.2.' + (i % 200) });
	}
	for (let i = 0; i < 3; i++) activity.record('login_success', { personId: alice, personName: 'Alice', ip: '198.51.100.4' });

	const first = activity.snapshot({ recentLimit: 25 });
	assert.equal(first.page.limit, 25);
	assert.equal(first.page.offset, 0);
	assert.equal(first.recent.length, 25);
	assert.equal(first.page.total, 253);
	assert.equal(first.page.hasMore, true);
	assert.ok(first.recent[0].time >= first.recent[1].time, 'recent activity is newest first');

	const deep = activity.snapshot({ recentLimit: 25, recentOffset: 200 });
	assert.equal(deep.page.offset, 200);
	assert.equal(deep.recent.length, 25);
	assert.equal(deep.page.hasMore, true);
	const last = activity.snapshot({ recentLimit: 25, recentOffset: 250 });
	assert.equal(last.recent.length, 3);
	assert.equal(last.page.hasMore, false);

	const capped = activity.snapshot({ recentLimit: 9999 });
	assert.equal(capped.page.limit, 200, 'the server caps a page even if the client asks for more');
	assert.equal(capped.recent.length, 200);

	const bobOnly = activity.snapshot({ user: 'person:' + bob, recentLimit: 200 });
	assert.ok(bobOnly.recent.every(entry => entry.personId === bob));
	assert.equal(bobOnly.page.total, 200);
	const carolOnly = activity.snapshot({ user: 'person:' + carol });
	assert.ok(carolOnly.recent.every(entry => entry.personId === carol));
	assert.equal(carolOnly.page.total, 50);
	const loginOnly = activity.snapshot({ type: 'login' });
	assert.equal(loginOnly.page.total, 3);
	const remoteOnly = activity.snapshot({ type: 'remote', recentLimit: 200 });
	assert.ok(remoteOnly.recent.every(entry => !entry.local));
	const today = activity.snapshot({ date: day.format(new Date()) });
	assert.equal(today.page.total, 253);
	assert.equal(activity.snapshot({ date: '2000-01-01' }).page.total, 0);
	assert.equal(activity.snapshot({ device: 'browser:not-a-browser' }).page.total, 0);
	assert.equal(activity.snapshot({ q: 'episode 42' }).page.total, 1);
	assert.ok(Array.isArray(activity.snapshot().facets.users));
	assert.ok(activity.snapshot().facets.users.some(entry => entry.id === 'person:' + bob && entry.name === 'Bob'));
});

test('last successful sign-in stays separate from viewing, and daily totals use the account window', async t => {
	const { activity } = activityFixture(t, {
		dailySeconds: id => id === 'person:' + alice ? 1800 : null,
		dailyLimitSeconds: id => id === 'person:' + alice ? 7200 : null,
		dailyTimezone: 'Europe/London', dailyDay: () => '2026-11-08',
		bandwidth: () => ({ measuredMbps: 7.4, mbps: 50, activeTransfers: 2 })
	});
	const person = { personId: alice, personName: 'Alice', ip: '198.51.100.9', browser: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)' };
	const item = { Id: 'episode-1', Name: 'Pilot', SeriesName: 'Example', RunTimeTicks: 3600 * 1e7 };
	activity.record('login_success', person);
	activity.begin('s1', person, item);
	activity.update('s1', { state: 'playing', heartbeat: true, position: 0.01, playing: true });
	await sleep(25);
	activity.update('s1', { state: 'playing', heartbeat: true, position: 0.02, playing: true });

	const snapshot = activity.snapshot();
	const user = snapshot.viewing.users.find(entry => entry.id === 'person:' + alice);
	assert.ok(user, 'the viewing user exists');
	assert.equal(user.dailySeconds, 1800);
	assert.equal(user.dailyLimitSeconds, 7200);
	assert.equal(user.dailyTimezone, 'Europe/London');
	assert.equal(user.dailyDay, '2026-11-08');
	assert.ok(Number.isFinite(user.lastLogin), 'the last successful sign-in is recorded');
	assert.ok(user.lastLogin <= Date.now());
	assert.equal(snapshot.bandwidth.measuredMbps, 7.4);
	assert.equal(snapshot.bandwidth.activeTransfers, 2);

	// A local/guest key must not create a phantom account-limit record.
	const other = activity.snapshot();
	assert.ok(other.viewing.users.every(entry => entry.dailySeconds === null || entry.id === 'person:' + alice));
});

test('the Activity API keeps the local/admin guard and passes paging and filters through', async t => {
	const directory = mkdtempSync(path.join(tmpdir(), 'tellybox-activity-api-096-'));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const app = express();
	app.use(express.json());
	const local = await new Promise(resolve => { const server = app.listen(0, '127.0.0.1', () => resolve(server)); });
	const remote = await new Promise(resolve => { const server = app.listen(0, '127.0.0.1', () => resolve(server)); });
	t.after(() => { local.closeAllConnections(); remote.closeAllConnections(); local.close(); remote.close(); });
	const audit = createActivity(directory);
	for (let i = 0; i < 12; i++) audit.record('playback', { personId: alice, personName: 'Alice', local: false, browser: 'Mozilla/5.0 (Windows NT 10.0)' }, { title: 'Thing ' + i, itemId: 'x' + i });
	installAuth(app, { directory, publicDirectory: path.resolve('public'), localPort: local.address().port,
		localHosts: ['127.0.0.1'], localNetworks: ['127.0.0.0/8'], audit });
	const call = (side, route) => fetch(`http://127.0.0.1:${(side === 'local' ? local : remote).address().port}${route}`, { redirect: 'manual' });

	const denied = await call('remote', '/api/activity');
	assert.equal(denied.status, 403, 'remote access without an admin app is refused');
	const page = await call('local', '/api/activity?limit=5&offset=5&type=playback&user=person:' + alice);
	assert.equal(page.status, 200);
	assert.equal(page.headers.get('cache-control'), 'no-store');
	const body = await page.json();
	assert.equal(body.page.limit, 5);
	assert.equal(body.page.offset, 5);
	assert.equal(body.recent.length, 5);
	assert.equal(body.page.total, 12);
	assert.ok(Array.isArray(body.browsers));
});

/* A deliberately small DOM is enough to exercise the shared renderers and the
 * Activity page without a browser. */
class Element {
	constructor(tag = 'div') {
		this.tag = tag; this.children = []; this.textContent = ''; this.className = '';
		this.hidden = false; this.dataset = {}; this.style = {}; this.value = '';
	}
	append(...items) { this.children.push(...items); }
	replaceChildren(...items) { this.children = items; }
	setAttribute(name, value) { this[name] = String(value); }
}
function fakeDocument() {
	const nodes = {};
	return { hidden: false, nodes, createElement: tag => new Element(tag),
		createTextNode: text => Object.assign(new Element('text'), { textContent: text }),
		querySelector: key => nodes[key] ||= new Element() };
}
function all(root) { return [root, ...(root.children || []).flatMap(all)]; }
function textOf(root) { return all(root).map(node => node.textContent).filter(Boolean).join(' | '); }
function loadScripts(context, urls) {
	for (const url of urls) vm.runInNewContext(readFileSync(url, 'utf8'), context);
}

test('shared renderers show five metrics and keep identity independent from access', () => {
	const document = fakeDocument();
	const context = { document };
	vm.runInNewContext(readFileSync(new URL('../public/activity-summary.js', import.meta.url), 'utf8'), context);
	const lib = context.TellyboxActivitySummary;
	assert.ok(lib);

	assert.equal(lib.deviceOf({ browser: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120' }).key, 'desktop');
	assert.equal(lib.deviceOf({ browser: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari' }).key, 'iphone');
	assert.equal(lib.deviceOf({ browser: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/120' }).key, 'android');
	assert.equal(lib.deviceOf({ browser: 'Mozilla/5.0 (Linux; Android 12; BRAVIA 4K) AppleWebKit' }).key, 'tv');
	assert.equal(lib.deviceOf({ browser: 'Mozilla/5.0 (SMART-TV; Linux; Tizen 6.0)' }).key, 'tv');
	assert.equal(lib.deviceOf({}).key, 'unknown');

	// Account identity stays account on the LAN; access and route are separate.
	const lanAccount = { personName: 'Alice', local: true, home: true, mediaRoute: 'local', browser: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)' };
	assert.equal(lib.identityOf(lanAccount).kind, 'account');
	assert.equal(lib.accessOf(lanAccount).kind, 'local');
	assert.equal(lib.routeOf(lanAccount).kind, 'lan');
	const remoteUnknown = { local: false, browser: 'Unknown agent' };
	assert.equal(lib.identityOf(remoteUnknown).kind, 'unknown', 'an IP or browser is never turned into a person');
	assert.equal(lib.accessOf(remoteUnknown).kind, 'remote');
	const localWithoutAccount = { local: true };
	assert.equal(lib.identityOf(localWithoutAccount).kind, 'local');

	const snapshot = {
		stats: { active: 2, plays: 9, remoteIps: 3, failed: 1 },
		bandwidth: { measuredMbps: 6.5, mbps: 50, activeTransfers: 2 },
		active: [
			{ title: 'A very long episode title that must wrap instead of pushing badges off the card', state: 'playing', position: 1800, duration: 3600, updated: Date.now(), ...lanAccount },
			{ title: 'Remote television', state: 'buffering', updated: Date.now(), local: false, mediaRoute: 'relay', browser: 'Mozilla/5.0 (SMART-TV; Linux; Tizen 6.0)' }
		]
	};
	const stats = document.querySelector('#stats');
	lib.renderMetrics(stats, snapshot);
	assert.equal(stats.children.length, 5, 'five metrics share one renderer');
	assert.match(textOf(stats), /Remote upload/);
	assert.match(textOf(stats), /6\.5 Mbps/);

	const watching = document.querySelector('#watching');
	const count = lib.renderWatching(watching, snapshot);
	assert.equal(count, 2);
	assert.match(textOf(watching), /Account: Alice/);
	assert.match(textOf(watching), /Local/);
	assert.match(textOf(watching), /LAN direct/);
	assert.match(textOf(watching), /Unknown viewer/);
	assert.match(textOf(watching), /Internet relay/);
	assert.ok(all(watching).some(node => node.tag === 'details' && node.children.some(child => child.tag === 'summary' && child.textContent === 'Playback details')),
		'diagnostics stay behind a collapsed details element');

	const totals = document.querySelector('#totals');
	lib.renderViewingTotals(totals, { viewing: { since: Date.now(), users: [
		{ id: 'person:' + alice, name: 'Alice', minutes: 90, dailySeconds: 1800, dailyLimitSeconds: 7200, dailyTimezone: 'Europe/London', lastLogin: Date.now() - 3600000 },
		{ id: 'local', name: 'Local', minutes: 10, dailySeconds: null, lastLogin: null }
	] } });
	assert.match(textOf(totals), /Last successful sign-in/);
	assert.match(textOf(totals), /30m of 2h today \(Europe\/London\)/);
	assert.match(textOf(totals), /No successful sign-in recorded/);
});

test('the Activity page requests one bounded page, renders it, and pages on the server', async () => {
	const document = fakeDocument();
	document.querySelector('#filter').value = 'all';
	const longName = 'A very long account name that should wrap instead of overflowing the card and hiding the actions';
	const entries = Array.from({ length: 50 }, (_, i) => ({
		id: 'e' + i, type: i % 7 === 0 ? 'login_success' : 'playback', title: 'Episode ' + i, state: 'ended',
		position: 120, time: Date.now() - i * 60000, ip: '192.0.2.' + i,
		personName: i % 3 === 0 ? longName : '', personId: i % 3 === 0 ? alice : '',
		local: i % 2 === 0, browser: i % 4 === 0 ? '' : 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari'
	}));
	const snapshot = {
		active: [{ title: 'Watching with a long title', state: 'playing', position: 600, duration: 1800, updated: Date.now(),
			personName: longName, personId: alice, local: true, home: true, mediaRoute: 'local', browser: 'Mozilla/5.0 (Windows NT 10.0)' }],
		downloads: [], recent: entries,
		browsers: [{ id: 'b1', ip: '192.0.2.1', browser: 'Mozilla/5.0 (X11; Linux x86_64)', created: Date.now(), localBrowser: false },
			{ id: 'b2', ip: '192.168.0.9', browser: 'Mozilla/5.0 (SMART-TV; Linux; Tizen 6.0)', created: Date.now(), lastSeen: Date.now(), localBrowser: true, personName: 'Alice' }],
		stats: { active: 1, plays: 12, remoteIps: 3, failed: 1 },
		bandwidth: { measuredMbps: 4, mbps: 50, activeTransfers: 1 },
		viewing: { since: Date.now() - 86400000, users: [{ id: 'person:' + alice, name: longName, minutes: 90, dailySeconds: 1800, dailyLimitSeconds: 7200, dailyTimezone: 'Europe/London', lastLogin: Date.now() }] },
		page: { limit: 50, offset: 0, total: 75, hasMore: true, windowDays: 30, retentionDays: 30 },
		facets: { users: [{ id: 'person:' + alice, name: longName }], devices: [{ id: 'browser:b1', name: 'Desktop web' }] },
		historySince: Date.now() - 30 * 86400000,
		lastLogins: {}
	};
	const calls = [];
	const context = { document, Node: Element, setInterval() {}, setTimeout() {}, clearTimeout() {},
		fetch: async url => { calls.push(url); return { ok: true, json: async () => snapshot }; } };
	loadScripts(context, [new URL('../public/activity-summary.js', import.meta.url), new URL('../public/activity.js', import.meta.url)]);
	await new Promise(resolve => setImmediate(resolve));

	assert.match(calls[0], /^\/api\/activity\?/);
	assert.match(calls[0], /limit=50/);
	assert.match(calls[0], /offset=0/);
	assert.match(calls[0], /type=all/);
	assert.equal(document.querySelector('#stats').children.length, 5);
	assert.equal(document.querySelector('#history').children.length, 50, 'only the server page is added to the DOM');
	assert.match(textOf(document.querySelector('#history')), /Account: A very long account name/);
	assert.match(textOf(document.querySelector('#history')), /Diagnostics/);
	assert.match(textOf(document.querySelector('#watching')), /LAN direct/);
	assert.match(textOf(document.querySelector('#browsers')), /Last seen/);
	assert.match(textOf(document.querySelector('#viewingTotals')), /Last successful sign-in/);
	assert.equal(document.querySelector('#historyPrev').disabled, true);
	assert.equal(document.querySelector('#historyNext').disabled, false);

	await document.querySelector('#historyNext').onclick();
	await new Promise(resolve => setImmediate(resolve));
	assert.match(calls.at(-1), /offset=50/);
	document.querySelector('#clearFilters').onclick();
	await new Promise(resolve => setImmediate(resolve));
	assert.match(calls.at(-1), /offset=0/);
	assert.equal(document.querySelector('#filter').value, 'all');
});

test('Activity and Settings share the overview instead of duplicating data', () => {
	const root = new URL('..', import.meta.url);
	const activity = readFileSync(new URL('./public/activity.html', root), 'utf8');
	const settings = readFileSync(new URL('./public/settings.html', root), 'utf8');
	assert.match(activity, /activity-summary\.js/);
	assert.match(settings, /activity-summary\.js/);
	assert.match(settings, /settings-activity\.js/);
	assert.match(settings, /id="settingsActivityStats"/);
	assert.match(settings, /id="settingsWatchingNow"/);
	assert.match(settings, /data-settings="watching"/);
	const script = readFileSync(new URL('./public/settings-activity.js', root), 'utf8');
	assert.match(script, /renderMetrics/);
	assert.match(script, /renderWatching/);
	assert.match(script, /\/api\/activity\/summary/);
	// Neither page should grow its own private copy of the metric list.
	const activityScript = readFileSync(new URL('./public/activity.js', root), 'utf8');
	assert.ok(!/Remote upload - 10s average/.test(activityScript));
});
