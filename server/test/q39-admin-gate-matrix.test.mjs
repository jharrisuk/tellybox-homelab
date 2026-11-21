/* Q39 REGRESSION (0.26.50 batch): one administrator predicate for the five
 * read-only Activity surfaces.
 *
 * Existing coverage already proves, per route, that local callers are allowed,
 * anonymous remote callers are refused, approved viewer apps are refused and
 * home presence alone is refused for /api/activity/summary and
 * /api/qbittorrent/summary (activity-summary-mount-137, qbittorrent-summary-137,
 * stream-monitor-readonly-138, qbittorrent-downloads-readonly-142). The owner
 * password session is covered for the summary only (activity-readonly-137).
 *
 * This file adds the missing branches of the shipped predicate across ALL FIVE
 * surfaces: approved admin app, installation-password session, and a signed-in
 * person linked to an approved admin app; plus home-only refusal for the page,
 * streams and downloads, immediate effect of a role demotion, and the
 * /api/auth/status admin flag for each caller class.
 *
 * /api/qbittorrent/summary and /api/activity/downloads are the real routes from
 * installQbittorrentRoutes against a synthetic loopback qBittorrent WebUI.
 * /activity and /api/auth/status are the real installAuth routes. The summary
 * and streams guards mirror server.mjs verbatim because those handlers are
 * inline in server.mjs; the final test ties the mirrors to the real source.
 * Everything is offline: loopback sockets, a stubbed home-IP relay fetcher and
 * a stubbed email delivery. No real credential or service is used.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { installAuth } from '../auth.mjs';
import { installQbittorrentRoutes } from '../qbittorrent.mjs';
import { createHomeNetwork } from '../home-network.mjs';

const PUBLIC_ORIGIN = 'https://remote.test';
const HOME_IP = '203.0.113.9'; // TEST-NET-3, a public address the home matcher accepts
const publicDirectory = fileURLToPath(new URL('../public', import.meta.url));
const OWNER_PASSWORD = 'synthetic-q39-owner-password';
const SUMMARY_ERROR = 'Read-only activity statistics are available to installation administrators only.';
const STREAMS_ERROR = 'Upstream stream monitoring is available to installation administrators only.';

const ROUTES = ['/activity', '/api/activity/summary', '/api/activity/streams', '/api/activity/downloads', '/api/qbittorrent/summary'];

function temporaryDirectory(t, prefix) {
	const directory = mkdtempSync(path.join(tmpdir(), prefix));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	return directory;
}

/* Minimal synthetic qBittorrent WebUI, after qbittorrent-summary-137. */
async function startQbUpstream(t) {
	const server = http.createServer(async (req, res) => {
		for await (const chunk of req) { /* drain */ }
		const url = new URL(req.url, 'http://127.0.0.1');
		const text = (status, value, headers = {}) => { res.writeHead(status, { 'content-type': 'text/plain', ...headers }); res.end(value); };
		const json = (status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
		if (url.pathname === '/api/v2/auth/login') return text(200, 'Ok.', { 'set-cookie': 'SID=synthetic-q39; path=/' });
		if (req.headers.cookie !== 'SID=synthetic-q39') return text(401, '');
		if (url.pathname === '/api/v2/app/webapiVersion') return text(200, '2.11.2');
		if (url.pathname === '/api/v2/app/version') return text(200, 'v5.0.3');
		if (url.pathname === '/api/v2/torrents/categories') return json(200, {});
		if (url.pathname === '/api/v2/transfer/info') return json(200, { dl_info_speed: 1000, up_info_speed: 20, connection_status: 'connected' });
		if (url.pathname === '/api/v2/torrents/info') {
			return json(200, [{
				hash: 'a'.repeat(40), name: 'Synthetic Q39 torrent', state: 'downloading', progress: 0.25,
				completed: 250, size: 1000, total_size: 1000, dlspeed: 1000, upspeed: 20, eta: 300, ratio: 0.5,
				category: '', num_seeds: 1, num_complete: 2, num_leechs: 0, num_incomplete: 1,
				added_on: 1700000000, last_activity: 1700000100
			}]);
		}
		return text(404, '');
	});
	server.listen(0, '127.0.0.1');
	await once(server, 'listening');
	t.after(() => { server.closeAllConnections?.(); server.close(); });
	return 'http://127.0.0.1:' + server.address().port;
}

async function fixture(t, { email = false } = {}) {
	const directory = temporaryDirectory(t, 'tellybox-q39-gate-');
	const qbDirectory = temporaryDirectory(t, 'tellybox-q39-gate-qb-');
	const upstream = await startQbUpstream(t);
	writeFileSync(path.join(qbDirectory, 'qbittorrent.json'), JSON.stringify({
		url: upstream + '/', username: 'synthetic-q39-user', password: 'synthetic-q39-secret',
		enabled: true, pollSeconds: 20, stalledMinutes: 30
	}));
	const app = express();
	app.use(express.json());
	const local = app.listen(0, '127.0.0.1');
	const remote = app.listen(0, '127.0.0.1');
	await Promise.all([once(local, 'listening'), once(remote, 'listening')]);
	t.after(() => {
		local.closeAllConnections?.(); remote.closeAllConnections?.();
		local.close(); remote.close();
	});
	const mail = [];
	// The real home matcher, fed by a stubbed relay response (no network).
	const homeNetwork = createHomeNetwork('https://relay.example.test/relay-client-ip', {
		fetcher: async () => new Response(HOME_IP)
	});
	await homeNetwork.refresh();
	assert.equal(homeNetwork.matches(HOME_IP), true);
	const auth = installAuth(app, {
		directory, publicDirectory,
		localPort: local.address().port,
		localHosts: ['127.0.0.1'], localNetworks: ['127.0.0.0/8'],
		publicOrigin: PUBLIC_ORIGIN,
		trustedProxies: ['127.0.0.1'], homeTrustedProxy: '127.0.0.1', homeNetwork,
		setupPort: 8990,
		...(email ? { emailDelivery: async message => { mail.push(message); } } : {})
	});
	// Mirrors of the two inline server.mjs guards, verbatim. The structural test
	// below asserts the real source uses the same predicate and error strings.
	app.get('/api/activity/summary', (req, res) => {
		res.set('Cache-Control', 'no-store');
		if (!auth.isOwnerAdmin(req)) {
			return res.status(403).json({ error: SUMMARY_ERROR });
		}
		res.json({ readOnly: true, stats: { active: 0, downloads: 0, plays: 0, failed: 0, remoteIps: 0 }, active: [], downloadCount: 0 });
	});
	app.get('/api/activity/streams', async (req, res) => {
		res.set('Cache-Control', 'no-store');
		if (!auth.isOwnerAdmin(req)) {
			return res.status(403).json({ error: STREAMS_ERROR });
		}
		res.json({ state: 'ok', streams: [] });
	});
	// The real read-only qBittorrent routes with the production predicate wiring.
	installQbittorrentRoutes(app, {
		requireOwner: (req, res) => { res.status(401).json({ error: 'Sign in as installation administrator.', signInRequired: true }); return false; },
		directory: qbDirectory,
		sameOrigin: () => true,
		allowSummary: req => auth.isOwnerAdmin(req),
		allowDownloads: req => auth.isOwnerAdmin(req)
	});
	const port = side => (side === 'local' ? local : remote).address().port;
	const base = side => 'http://127.0.0.1:' + port(side);
	const request = (side, route, { method = 'GET', body, cookie, headers = {} } = {}) => fetch(base(side) + route, {
		method, redirect: 'manual',
		headers: {
			...(body === undefined ? {} : { 'Content-Type': 'application/json', Origin: base(side) }),
			...(cookie ? { Cookie: cookie } : {}),
			...headers
		},
		body: body === undefined ? undefined : JSON.stringify(body)
	});
	// node:http, not fetch: the home classifier reads the Host header and fetch
	// silently overwrites it with the socket address.
	const raw = (side, route, { method = 'GET', headers = {}, body } = {}) => new Promise((resolve, reject) => {
		const data = body === undefined ? null : JSON.stringify(body);
		const req = http.request({
			host: '127.0.0.1', port: port(side), path: route, method,
			headers: { ...(data === null ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }), ...headers }
		}, response => {
			const chunks = [];
			response.on('data', chunk => chunks.push(chunk));
			response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, text: Buffer.concat(chunks).toString('utf8') }));
		});
		req.on('error', reject);
		req.end(data);
	});
	return { request, raw, base, mail, directory };
}

async function enrollViewer(request, name) {
	const enrolled = await request('local', '/api/apps/enroll', { method: 'POST', body: { name } });
	assert.ok([200, 201].includes(enrolled.status), 'local enrolment should succeed: ' + enrolled.status);
	const device = await enrolled.json();
	assert.equal(device.status, 'approved');
	assert.equal(device.role, 'viewer');
	return device;
}

async function setRole(request, id, role) {
	const response = await request('local', '/api/apps/' + id, { method: 'POST', body: { action: 'role', role } });
	assert.equal(response.status, 200);
}

async function ownerCookie(request) {
	assert.equal((await request('local', '/api/auth/password', { method: 'POST', body: { password: OWNER_PASSWORD } })).status, 200);
	const login = await request('remote', '/api/auth/login', { method: 'POST', body: { password: OWNER_PASSWORD } });
	assert.equal(login.status, 200);
	return login.headers.get('set-cookie').split(';')[0];
}

async function personSession(request, mail, email) {
	assert.equal((await request('local', '/api/auth/email/config', {
		method: 'POST', body: { enabled: true, key: 're_fixture_only_123456', from: 'watch@example.test' }
	})).status, 200);
	await request('remote', '/api/auth/email/code', { method: 'POST', body: { email } });
	const list = await (await request('local', '/api/people')).json();
	const person = list.people.find(entry => entry.email === email);
	assert.ok(person, 'the person requested access');
	assert.equal((await request('local', '/api/people', { method: 'POST', body: { id: person.id, action: 'approve' } })).status, 200);
	const sent = await (await request('remote', '/api/auth/email/code', { method: 'POST', body: { email } })).json();
	assert.equal(sent.status, 'code-sent');
	const code = mail.filter(message => message.type === 'code').at(-1).code;
	const verify = await request('remote', '/api/auth/email/verify', { method: 'POST', body: { challenge: sent.challenge, code } });
	assert.equal(verify.status, 200);
	return { cookie: verify.headers.get('set-cookie').split(';')[0], person };
}

/* Assert the whole five-surface row for one caller. `expect` maps each route to
 * its required status; the page must also carry the real Activity markup. */
async function assertRow(request, { cookie, headers = {} }, expect) {
	for (const route of ROUTES) {
		const response = await request('remote', route, { cookie, headers });
		assert.equal(response.status, expect[route], route);
		if (route === '/activity' && expect[route] === 200) {
			assert.match(await response.text(), /id="downloadsPanel"/, 'the real Activity page is served');
		} else {
			await response.text();
		}
	}
}

const ALLOWED = Object.fromEntries(ROUTES.map(route => [route, 200]));
const GUARD_DENIED = Object.fromEntries(ROUTES.map(route => [route, 403]));
const GATE_DENIED = { '/activity': 403, '/api/activity/summary': 401, '/api/activity/streams': 401, '/api/activity/downloads': 401, '/api/qbittorrent/summary': 401 };

test('a local caller is an administrator on all five surfaces', async t => {
	const { request } = await fixture(t);
	for (const route of ROUTES) {
		const response = await request('local', route);
		assert.equal(response.status, 200, route);
		await response.text();
	}
	const status = await (await request('local', '/api/auth/status')).json();
	assert.equal(status.admin, true);
	assert.equal(status.local, true);
});

test('an anonymous remote caller is refused everywhere and status discloses only admin:false', async t => {
	const { request } = await fixture(t);
	await assertRow(request, {}, GATE_DENIED);
	const response = await request('remote', '/api/auth/status');
	assert.equal(response.status, 200);
	// The anonymous remote body carries no identity, no installation address,
	// no scope and no playback origin: just the bounded status flags.
	assert.deepEqual(await response.json(), {
		email: false, local: false, home: false, authenticated: false,
		admin: false, configured: false, person: null, localPlayback: null
	});
});

test('an approved viewer app is authenticated but is not an administrator on any surface', async t => {
	const { request } = await fixture(t);
	const viewer = await enrollViewer(request, 'Q39 viewer app');
	await assertRow(request, { headers: { Authorization: 'Bearer ' + viewer.token } }, GUARD_DENIED);
	const status = await (await request('remote', '/api/auth/status', { headers: { Authorization: 'Bearer ' + viewer.token } })).json();
	assert.equal(status.admin, false);
	// Note: `authenticated` is cookie-session-only by design (auth.mjs
	// authenticated()); an app bearer authenticates at the gate, not as a
	// browser sign-in. The batch specifies only the admin flag here.
});

test('an approved admin app is an administrator on all five surfaces, and a demotion applies immediately', async t => {
	const { request } = await fixture(t);
	const app = await enrollViewer(request, 'Q39 admin app');
	await setRole(request, app.id, 'admin');
	const headers = { Authorization: 'Bearer ' + app.token };
	await assertRow(request, { headers }, ALLOWED);
	const status = await (await request('remote', '/api/auth/status', { headers })).json();
	assert.equal(status.admin, true, 'status reports the admin app as administrator');
	// The predicate is evaluated per request: the same token loses access as
	// soon as the role changes, without a new enrolment or restart.
	await setRole(request, app.id, 'viewer');
	await assertRow(request, { headers }, GUARD_DENIED);
	assert.equal((await (await request('remote', '/api/auth/status', { headers })).json()).admin, false);
});

test('an installation-password session is an administrator on all five surfaces remotely', async t => {
	const { request } = await fixture(t);
	const cookie = await ownerCookie(request);
	await assertRow(request, { cookie }, ALLOWED);
	const status = await (await request('remote', '/api/auth/status', { cookie })).json();
	assert.equal(status.admin, true);
	assert.equal(status.authenticated, true);
	assert.equal(status.local, false, 'the owner session is remote, not local access');
});

test('a signed-in person linked to an approved admin app is an administrator on all five surfaces', async t => {
	const { request, mail } = await fixture(t, { email: true });
	const adminApp = await enrollViewer(request, 'Q39 linked admin app');
	await setRole(request, adminApp.id, 'admin');
	const { cookie, person } = await personSession(request, mail, 'linked-admin@example.test');
	// The existing role model: the person is linked to the admin app's device.
	assert.equal((await request('local', '/api/people', { method: 'POST', body: { id: person.id, action: 'device', deviceId: adminApp.id } })).status, 200);
	await assertRow(request, { cookie }, ALLOWED);
	const status = await (await request('remote', '/api/auth/status', { cookie })).json();
	assert.equal(status.admin, true);
	assert.equal(status.person, 'linked-admin@example.test');
	assert.equal(status.local, false);
});

test('a signed-in person without an admin-app link stays a viewer on every surface', async t => {
	const { request, mail } = await fixture(t, { email: true });
	const viewerApp = await enrollViewer(request, 'Q39 linked viewer app');
	const { cookie, person } = await personSession(request, mail, 'plain-viewer@example.test');
	// Linked to a viewer app, not an admin app: still no administrator role.
	assert.equal((await request('local', '/api/people', { method: 'POST', body: { id: person.id, action: 'device', deviceId: viewerApp.id } })).status, 200);
	await assertRow(request, { cookie }, GUARD_DENIED);
	const status = await (await request('remote', '/api/auth/status', { cookie })).json();
	assert.equal(status.admin, false);
	assert.equal(status.authenticated, true);
	// Removing the link keeps the person a viewer (no link at all).
	assert.equal((await request('local', '/api/people', { method: 'POST', body: { id: person.id, action: 'unlink', deviceId: viewerApp.id } })).status, 200);
	await assertRow(request, { cookie }, GUARD_DENIED);
});

test('home/LAN presence alone is not an administrator on any of the five surfaces', async t => {
	const { raw } = await fixture(t);
	const homeHeaders = { Host: 'remote.test', 'X-Forwarded-Proto': 'https', 'CF-Connecting-IP': HOME_IP };
	// Prove the classifier really says home:true, local:false for this socket,
	// so the refusals below are the home branch and not a missing classifier.
	const status = await raw('remote', '/api/auth/status', { headers: homeHeaders });
	assert.equal(status.status, 200);
	const state = JSON.parse(status.text);
	assert.equal(state.home, true);
	assert.equal(state.local, false);
	assert.equal(state.admin, false, 'being at home is not an administrator role');
	for (const route of ROUTES) {
		const response = await raw('remote', route, { headers: homeHeaders });
		assert.equal(response.status, 403, route + ' must refuse a home-only viewer');
	}
	// Without the relay-verified client address the same proxy request is only
	// an unauthenticated remote caller.
	const notHome = await raw('remote', '/api/auth/status', { headers: { Host: 'remote.test', 'X-Forwarded-Proto': 'https' } });
	assert.equal(JSON.parse(notHome.text).home, false);
	for (const route of ROUTES.slice(1)) {
		assert.equal((await raw('remote', route, { headers: { Host: 'remote.test', 'X-Forwarded-Proto': 'https' } })).status, 401, route);
	}
});

test('all five surfaces share the one shipped predicate and the full log stays stricter', () => {
	const serverSource = readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
	const authSource = readFileSync(new URL('../auth.mjs', import.meta.url), 'utf8');

	// The two inline server.mjs guards use auth.isOwnerAdmin, and this file's
	// mirrors use the same error strings.
	const summary = /app\.get\('\/api\/activity\/summary',[\s\S]{0,400}?\n\}\);/.exec(serverSource);
	assert.ok(summary, 'server.mjs registers the summary route');
	assert.match(summary[0], /auth\.isOwnerAdmin\(req\)/);
	assert.ok(summary[0].includes(SUMMARY_ERROR), 'the mirrored summary error matches the real route');
	const streamsStart = serverSource.indexOf("app.get('/api/activity/streams'");
	assert.ok(streamsStart >= 0, 'server.mjs registers the streams route');
	const streamsBlock = serverSource.slice(streamsStart, streamsStart + 500);
	assert.match(streamsBlock, /if\(!auth\.isOwnerAdmin\(req\)\)/);
	assert.ok(streamsBlock.includes(STREAMS_ERROR), 'the mirrored streams error matches the real route');

	// The qBittorrent read-only routes are wired to the same predicate.
	const wiring = /installQbittorrentRoutes\(app,\{[\s\S]{0,300}?\}\);/.exec(serverSource);
	assert.ok(wiring, 'server.mjs wires the qBittorrent routes');
	assert.match(wiring[0], /allowSummary:req=>auth\.isOwnerAdmin\(req\)/);
	assert.match(wiring[0], /allowDownloads:req=>auth\.isOwnerAdmin\(req\)/);

	// The Activity page uses the same predicate inside installAuth.
	const page = /app\.get\(\['\/activity', '\/activity\.html'\],[\s\S]{0,300}?\}\);/.exec(authSource);
	assert.ok(page, 'auth.mjs registers the Activity page');
	assert.match(page[0], /if \(!ownerAdmin\(req\)\)/);

	// One definition: local OR approved admin app OR owner session OR a person
	// linked to an approved admin app. Home presence is deliberately absent.
	const definition = /function ownerAdmin\(req\) \{[\s\S]{0,300}?\n\t\}/.exec(authSource);
	assert.ok(definition, 'auth.mjs defines ownerAdmin');
	assert.match(definition[0], /if \(local\(req\)\) return true;/);
	assert.match(definition[0], /apps\.resolve\(req\)/);
	assert.match(definition[0], /device\?\.role === 'admin'/);
	assert.match(definition[0], /ownerSession\(req\) \|\| personAdmin\(req\)/);
	assert.doesNotMatch(definition[0], /home\(req\)/, 'home presence is not part of the administrator predicate');
	const personAdmin = /function personAdmin\(req\) \{[\s\S]{0,400}?\n\t\}/.exec(authSource);
	assert.ok(personAdmin);
	assert.match(personAdmin[0], /device\.role === 'admin'/);
	assert.match(personAdmin[0], /people\.device\(device\.id\)\.personId === session\.personId/);

	// The full log is NOT widened to the owner predicate: it keeps the stricter
	// local/admin-app gate (an owner password cookie alone must not read it).
	assert.match(authSource, /app\.get\('\/api\/activity', apps\.requireAdmin/, 'the full log keeps apps.requireAdmin');
});
