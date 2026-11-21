import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import express from 'express';
import { installAuth } from '../auth.mjs';
import { createActivity } from '../activity.mjs';

/* Release 137: trusted home/LAN viewers get a sanitized read-only summary.
 * The full Activity log, account/browser details and every write path stay
 * behind the existing local/admin guard. */

const FAKE = {
	ip: '192.0.2.137',
	remoteIp: '203.0.113.137',
	unknownIp: '203.0.113.138',
	mediaIp: '198.51.100.137',
	email: 'viewer137@example.test',
	ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) SecretAgent/137.0',
	remoteUa: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari/137.0 SecretAgent',
	itemId: 'item-private-137',
	seriesId: 'series-private-137',
	personId: 'person-private-137',
	deviceId: 'device-private-137',
	browserId: 'browser-private-137',
	deviceName: 'Private device 137',
	secret: 'tok_live_private_137',
	sessionId: 'session-private-137'
};

function keysOf(value, output = new Set()) {
	if (Array.isArray(value)) {
		for (const item of value) keysOf(item, output);
	} else if (value && typeof value === 'object') {
		for (const [key, item] of Object.entries(value)) {
			output.add(key);
			keysOf(item, output);
		}
	}
	return output;
}

test('activity.summary returns sanitized aggregate statistics and active playback only', t => {
	const directory = mkdtempSync(path.join(tmpdir(), 'tellybox-activity-readonly-137-'));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const activity = createActivity(directory, {
		bandwidth: () => ({ measuredMbps: 12.5, mbps: 50, activeTransfers: 2, transferredBytes: 999, secret: FAKE.secret })
	});
	const episode = { Id: FAKE.itemId, Name: 'Synthetic episode', SeriesName: 'Synthetic series', Type: 'Episode',
		SeriesId: FAKE.seriesId, RunTimeTicks: 1800 * 1e7 };

	activity.begin(FAKE.sessionId, {
		personId: FAKE.personId, personName: 'Synthetic Viewer', deviceId: FAKE.deviceId, browserId: FAKE.browserId,
		local: true, home: true, ip: FAKE.ip, mediaIp: FAKE.mediaIp, ipSource: 'trusted proxy',
		email: FAKE.email, browser: FAKE.ua, deviceName: FAKE.deviceName, mediaRoute: 'local', method: 'DirectPlay'
	}, episode, { purpose: 'watch', secret: FAKE.secret });
	activity.update(FAKE.sessionId, { heartbeat: true, state: 'playing', position: 240 });

	activity.begin('session-remote-137', {
		personId: FAKE.personId + '-remote', personName: 'Remote Viewer', local: false, home: false,
		ip: FAKE.remoteIp, browser: FAKE.remoteUa, mediaRoute: 'relay', method: 'Relay'
	}, { Id: FAKE.itemId + '-remote', Name: 'Remote synthetic', Type: 'Movie', RunTimeTicks: 3600 * 1e7 }, { purpose: 'watch' });
	activity.update('session-remote-137', { heartbeat: true, state: 'paused', position: 60 });

	// Local access without a person is labelled locally, never turned into an account.
	activity.begin('session-local-137', { local: true, home: false, ip: FAKE.ip }, {
		Id: FAKE.itemId + '-local', Name: 'Local synthetic', Type: 'Movie', RunTimeTicks: 600 * 1e7
	}, { purpose: 'watch' });
	activity.update('session-local-137', { heartbeat: true, state: 'playing', position: 30 });

	// An unknown remote viewer stays unknown even with a captured agent string.
	activity.begin('session-unknown-137', { local: false, home: false, ip: FAKE.unknownIp }, {
		Id: FAKE.itemId + '-unknown', Name: 'Unknown synthetic', Type: 'Movie'
	}, { purpose: 'watch' });
	activity.update('session-unknown-137', { heartbeat: true, state: 'buffering' });

	// A download is an active transfer, not a viewer and not a play.
	activity.beginDownload('download-137', {
		personId: FAKE.personId, personName: 'Synthetic Viewer', deviceId: FAKE.deviceId,
		local: true, ip: FAKE.ip, browser: FAKE.ua, email: FAKE.email
	}, { Id: FAKE.itemId + '-download', Name: 'Downloaded synthetic' }, { totalBytes: 1000, offset: 10 });
	activity.downloadProgress('download-137', 20);

	const summary = activity.summary();
	assert.equal(summary.readOnly, true);
	assert.ok(Number.isFinite(summary.generatedAt) && summary.generatedAt > 0, 'generatedAt is a timestamp');
	assert.deepEqual(summary.stats, { active: 4, downloads: 1, plays: 4, failed: 0, remoteIps: 2 });
	assert.equal(summary.downloadCount, 1);
	assert.deepEqual(summary.bandwidth, { measuredMbps: 12.5, mbps: 50, activeTransfers: 2 });

	assert.equal(summary.active.length, 4, 'downloads never appear as watching');
	const byTitle = new Map(summary.active.map(entry => [entry.title, entry]));
	const episodeView = byTitle.get('Synthetic series · Synthetic episode');
	assert.ok(episodeView, 'the active episode is present');
	assert.equal(episodeView.state, 'playing');
	assert.equal(episodeView.purpose, 'watch');
	assert.equal(episodeView.position, 240);
	assert.equal(episodeView.duration, 1800);
	assert.ok(episodeView.updated > 0);
	assert.equal(episodeView.mediaRoute, 'local');
	assert.equal(episodeView.method, 'DirectPlay');
	assert.equal(episodeView.local, true);
	assert.equal(episodeView.home, true);
	assert.equal(episodeView.personName, 'Synthetic Viewer');
	assert.equal(episodeView.viewerKind, 'account');
	assert.equal(episodeView.deviceLabel, 'Windows desktop');

	const remoteView = byTitle.get('Remote synthetic');
	assert.equal(remoteView.local, false);
	assert.equal(remoteView.state, 'paused');
	assert.equal(remoteView.position, 60);
	assert.equal(remoteView.mediaRoute, 'relay');
	assert.equal(remoteView.deviceLabel, 'iPhone');

	const localView = byTitle.get('Local synthetic');
	assert.equal(localView.personName, 'Local access');
	assert.equal(localView.viewerKind, 'local');
	assert.equal(localView.deviceLabel, 'Unknown device');

	const unknownView = byTitle.get('Unknown synthetic');
	assert.equal(unknownView.personName, 'Unknown viewer');
	assert.equal(unknownView.viewerKind, 'unknown');
	assert.equal(unknownView.deviceLabel, 'Unknown device');

	const serialized = JSON.stringify(summary);
	for (const value of Object.values(FAKE)) {
		assert.ok(!serialized.includes(value), 'the summary must not contain ' + value);
	}
	assert.ok(!serialized.includes('SecretAgent'), 'no raw user-agent fragment is exposed');
	assert.ok(!serialized.includes('Mozilla/5.0'), 'no raw user-agent prefix is exposed');

	const keys = keysOf(summary);
	for (const forbidden of ['ip', 'ipSource', 'mediaIp', 'email', 'browser', 'personId', 'deviceId', 'browserId',
		'itemId', 'seriesId', 'id', 'reason', 'recent', 'facets', 'viewing', 'browsers', 'lastLogins']) {
		assert.ok(!keys.has(forbidden), 'forbidden key is absent: ' + forbidden);
	}
});

test('the summary route is administrator only, no-store, and has no write path', async t => {
	const directory = mkdtempSync(path.join(tmpdir(), 'tellybox-activity-readonly-route-137-'));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const app = express();
	app.use(express.json());
	const local = await new Promise(resolve => { const server = app.listen(0, '127.0.0.1', () => resolve(server)); });
	const remote = await new Promise(resolve => { const server = app.listen(0, '127.0.0.1', () => resolve(server)); });
	t.after(() => { local.closeAllConnections(); remote.closeAllConnections(); local.close(); remote.close(); });
	const activity = createActivity(directory);
	activity.begin('route-watch-137', { local: true, home: true, personName: 'Route Viewer', ip: FAKE.ip, browser: FAKE.ua },
		{ Id: 'route-item-137', Name: 'Route synthetic', Type: 'Movie', RunTimeTicks: 1200 * 1e7 }, { purpose: 'watch' });
	activity.update('route-watch-137', { heartbeat: true, state: 'playing', position: 10 });
	const auth = installAuth(app, { directory, publicDirectory: path.resolve('public'), localPort: local.address().port,
		localHosts: ['127.0.0.1'], localNetworks: ['127.0.0.0/8'], audit: activity });
	const isAdmin = req => req.jserverApp?.role === 'admin';
	// Mirrors the new server.mjs route: no forwarded address or browser hostname
	// is consulted for the decision.
	app.get('/api/activity/summary', (req, res) => {
		res.set('Cache-Control', 'no-store');
		if (!(auth.isOwnerAdmin(req))) {
			return res.status(403).json({ error: 'Read-only activity statistics are available to installation administrators only.' });
		}
		res.json(activity.summary());
	});
	const base = side => `http://127.0.0.1:${(side === 'local' ? local : remote).address().port}`;
	const request = (side, route, body, cookie, headers = {}) => fetch(base(side) + route, {
		method: body === undefined ? 'GET' : 'POST', redirect: 'manual',
		headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json', Origin: base(side) }), ...(cookie ? { Cookie: cookie } : {}), ...headers },
		body: body === undefined ? undefined : JSON.stringify(body)
	});

	const localSummary = await request('local', '/api/activity/summary');
	assert.equal(localSummary.status, 200);
	assert.equal(localSummary.headers.get('cache-control'), 'no-store');
	const localBody = await localSummary.json();
	assert.equal(localBody.readOnly, true);
	assert.equal(localBody.active.length, 1);
	assert.equal(localBody.active[0].title, 'Route synthetic');
	assert.ok(!JSON.stringify(localBody).includes(FAKE.ip));
	assert.ok(!JSON.stringify(localBody).includes(FAKE.ua));

	// The installation password is an owner credential, so this session is now
	// an administrator even though the request is remote.
	const password = 'synthetic-readonly-137-password';
	assert.equal((await request('local', '/api/auth/password', { password })).status, 200);
	const login = await request('remote', '/api/auth/login', { password });
	assert.equal(login.status, 200);
	const cookie = login.headers.get('set-cookie').split(';')[0];
	const ownerSummary = await request('remote', '/api/activity/summary', undefined, cookie);
	assert.equal(ownerSummary.status, 200, 'the installation owner is an administrator');
	assert.equal((await ownerSummary.json()).readOnly, true);

	// Spoofed forwarded headers never turn an anonymous caller into an owner.
	const spoofed = await request('remote', '/api/activity/summary', undefined, undefined, {
		'X-Forwarded-For': '127.0.0.1', 'CF-Connecting-IP': '127.0.0.1'
	});
	assert.equal(spoofed.status, 401, 'an anonymous caller is stopped by the auth gate');
	assert.equal(spoofed.headers.get('cache-control'), 'no-store');

	// An unauthenticated remote request still hits the existing auth gate.
	assert.equal((await request('remote', '/api/activity/summary')).status, 401);

	const before = JSON.stringify(activity.snapshot());
	const posted = await request('local', '/api/activity/summary', {});
	assert.ok([404, 405].includes(posted.status), 'the summary route has no write method');
	assert.equal(JSON.stringify(activity.snapshot()), before, 'a rejected write does not mutate activity');
});

test('a 403 from the full log renders the sanitized summary and hides admin controls', async () => {
	class Element {
		constructor(tag = 'div') {
			this.tag = tag; this.children = []; this.textContent = ''; this.className = '';
			this.hidden = false; this.disabled = false; this.dataset = {}; this.style = {}; this.value = '';
		}
		append(...items) { this.children.push(...items); }
		replaceChildren(...items) { this.children = items; }
		setAttribute(name, value) { this[name] = String(value); }
		getAttribute(name) { return this[name] === undefined ? null : String(this[name]); }
		focus() {}
	}
	function fakeDocument() {
		const nodes = {}, sections = {};
		const sectionKeys = new Set(['#recentPreviewHeading', '#browsersHeading', '#totalsHeading']);
		const document = {
			hidden: false, visibilityState: 'visible',
			createElement: tag => new Element(tag),
			createTextNode: text => Object.assign(new Element('text'), { textContent: text }),
			sectionFor: key => sections[key],
			querySelector: key => {
				if (!nodes[key]) {
					const node = new Element();
					node.closest = selector => selector === 'section' && sectionKeys.has(key)
						? (sections[key] ||= new Element('section')) : null;
					nodes[key] = node;
				}
				return nodes[key];
			}
		};
		return document;
	}
	function all(root) { return [root, ...(root.children || []).flatMap(all)]; }
	function textOf(root) { return all(root).map(node => node.textContent).filter(Boolean).join(' | '); }
	const document = fakeDocument();
	const summary = {
		generatedAt: Date.now(), readOnly: true,
		stats: { active: 1, downloads: 0, plays: 2, failed: 0, remoteIps: 1 },
		bandwidth: null,
		active: [{ title: 'Synthetic local film', state: 'playing', purpose: 'watch', position: 10, duration: 100,
			updated: Date.now(), local: true, home: true, personName: 'Local access', viewerKind: 'local', deviceLabel: 'Android TV' }],
		downloadCount: 0
	};
	const calls = [];
	const context = { document, Node: Element, setInterval() {}, setTimeout() {}, clearTimeout() {},
		fetch: async url => {
			calls.push(url);
			if (url === '/api/activity/summary') return { ok: true, status: 200, json: async () => summary };
			return { ok: false, status: 403, json: async () => ({ error: 'Administrator access required.' }) };
		} };
	vm.runInNewContext(readFileSync(new URL('../public/activity-summary.js', import.meta.url), 'utf8'), context);
	vm.runInNewContext(readFileSync(new URL('../public/activity.js', import.meta.url), 'utf8'), context);
	await new Promise(resolve => setImmediate(resolve));
	await new Promise(resolve => setImmediate(resolve));

	const fullLog = calls.findIndex(url => url.startsWith('/api/activity?'));
	const summaryIndex = calls.indexOf('/api/activity/summary');
	const downloadsIndex = calls.findIndex(url => String(url).startsWith('/api/activity/downloads'));
	assert.ok(fullLog >= 0 && summaryIndex > fullLog, 'the full log is requested before the read-only summary');
	assert.ok(downloadsIndex > summaryIndex, 'the visibility probe runs after the read-only decision');
	assert.equal(document.querySelector('#tabDownloads').hidden, true, 'a refused downloads list removes its tab');
	assert.equal(document.querySelector('#downloadsPanel').hidden, true);
	assert.equal(document.querySelector('#stats').children.length, 5, 'metrics still render from the summary');
	assert.match(textOf(document.querySelector('#watching')), /Local access/);
	assert.match(textOf(document.querySelector('#watching')), /Android TV/);
	assert.match(document.querySelector('#activityMessage').textContent, /Read-only statistics/);
	assert.equal(document.querySelector('.settings-actions').hidden, true, 'the Password settings link and revoke-all container are hidden');
	assert.equal(document.querySelector('#revokeAll').hidden, true);
	assert.equal(document.querySelector('#revokeAll').disabled, true);
	assert.equal(document.querySelector('#revokeAll').onclick, null);
	assert.equal(document.querySelector('#tabLogs').hidden, true);
	assert.equal(document.querySelector('#browsers').hidden, true);
	assert.equal(document.querySelector('#viewingTotals').hidden, true);
	assert.equal(document.querySelector('#downloadingSection').hidden, true);
	assert.equal(document.querySelector('#recentPreview').children.length, 0, 'no recent events are rendered in read-only mode');
	assert.equal(document.sectionFor('#recentPreviewHeading').hidden, true, 'the whole Recent activity section, including its note, is hidden');
	assert.equal(document.sectionFor('#browsersHeading').hidden, true, 'the whole Signed-in remote browsers section is hidden');
	assert.equal(document.sectionFor('#totalsHeading').hidden, true, 'the whole Time watched section is hidden');
	assert.equal(document.querySelector('#activityPanel').hidden, false, 'Activity stays visible');
	assert.equal(document.querySelector('#watching').hidden, false, 'Watching now stays visible');
});

test('Settings and Activity use the sanitized read-only summary without changing the admin path', () => {	const root = new URL('../public/', import.meta.url);
	const settings = readFileSync(new URL('settings-activity.js', root), 'utf8');
	assert.match(settings, /\/api\/activity\/summary/);
	assert.doesNotMatch(settings, /fetch\('\/api\/activity\?/);
	assert.match(settings, /renderMetrics/);
	assert.match(settings, /renderWatching/);
	assert.match(settings, /read-only/i);

	const activity = readFileSync(new URL('activity.js', root), 'utf8');
	assert.match(activity, /\/api\/activity\/summary/);
	assert.match(activity, /response\.status\s*===\s*403/);
	assert.match(activity, /renderReadOnly/);
	assert.match(activity, /READ-ONLY STATISTICS/);
	assert.match(activity, /'\.settings-actions'/, 'the read-only view hides the Password settings link and revoke-all container');
	assert.match(activity, /closest\('section'\)/, 'the read-only view hides the whole parent section and its explanatory note');
	assert.match(activity, /\/api\/activity' \+ \(query \? '\?' \+ query : ''\)/, 'the admin path still requests the full log');

	// Keep the real server route aligned with the mirrored authorization test
	// above, so a future edit cannot silently widen it.
	const serverSource = readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
	const route = /app\.get\('\/api\/activity\/summary',[\s\S]{0,400}?\n\}\);/.exec(serverSource);
	assert.ok(route, 'server.mjs registers the summary route');
	assert.match(route[0], /res\.set\('Cache-Control', 'no-store'\)/);
	assert.match(route[0], /auth\.isOwnerAdmin\(req\)/, 'the summary guard is the shared administrator predicate');
	assert.match(route[0], /activity\.summary\(\)/);
	assert.doesNotMatch(route[0], /req\.(?:query|body|params)/, 'the summary decision does not read caller input');

	// The renderer accepts the coarse device label instead of a raw agent.
	const context = {};
	vm.runInNewContext(readFileSync(new URL('activity-summary.js', root), 'utf8'), context);
	const lib = context.TellyboxActivitySummary;
	assert.ok(lib);
	assert.equal(lib.deviceOf({ deviceLabel: 'Windows desktop' }).label, 'Windows desktop');
	assert.equal(lib.deviceOf({ deviceLabel: 'Android TV' }).key, 'tv');
	assert.equal(lib.deviceOf({ deviceLabel: 'iPhone' }).key, 'iphone');
	assert.equal(lib.identityOf({ personName: 'Local access', viewerKind: 'local' }).kind, 'local');
	assert.equal(lib.identityOf({ personName: 'Unknown viewer', viewerKind: 'unknown' }).kind, 'unknown');
});
