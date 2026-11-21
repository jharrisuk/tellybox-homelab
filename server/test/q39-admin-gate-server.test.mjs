/* Q39 REGRESSION (0.26.50 batch): the administrator branches on the REAL
 * server.mjs routes, end to end.
 *
 * stream-monitor-readonly-138 already proves the real streams route for local,
 * anonymous and viewer-app callers; activity-summary-mount-137 proves the real
 * summary route for the same classes; qbittorrent-downloads-readonly-142 proves
 * the real downloads route at the installAuth boundary. What no existing test
 * proves on the real server is the two positive remote administrator branches
 * — an approved admin app bearer and an installation-password session — across
 * all five surfaces, including the real streams proxy hop and the real
 * qBittorrent reads. That is this file.
 *
 * Everything is offline: the qBittorrent WebUI, the setup monitoring hop and
 * the Jellyfin/Dispatcharr upstreams are synthetic loopback servers. Email
 * sign-in is never enabled here (the real server has no delivery stub), so no
 * person branch is attempted; that branch is covered at the installAuth
 * boundary in q39-admin-gate-matrix.test.mjs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';

const OWNER_PASSWORD = 'synthetic-q39-server-password';
const STREAM_PAYLOAD = {
	configured: true, enabled: true, source: 'anotherServer', state: 'ok', reachable: true,
	checkedAt: 1763450000000, upstreamAt: 1763450000000, stale: false, notice: '',
	reported: { liveChannels: 1, liveClients: 1, vodConnections: 0, catchupConnections: 0 },
	truncated: false, rowsReported: 0, rowsShown: 0, streams: []
};
const ROUTES = ['/activity', '/api/activity/summary', '/api/activity/streams', '/api/activity/downloads', '/api/qbittorrent/summary'];

async function listen(handler) {
	const server = http.createServer(handler);
	server.listen(0, '127.0.0.1');
	await once(server, 'listening');
	return server;
}

/* Synthetic qBittorrent WebUI (after qbittorrent-summary-137). */
async function startQbUpstream(t) {
	const state = { requests: [] };
	const server = await listen(async (req, res) => {
		for await (const chunk of req) { /* drain */ }
		const url = new URL(req.url, 'http://127.0.0.1');
		state.requests.push(url.pathname);
		const text = (status, value, headers = {}) => { res.writeHead(status, { 'content-type': 'text/plain', ...headers }); res.end(value); };
		const json = (status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
		if (url.pathname === '/api/v2/auth/login') return text(200, 'Ok.', { 'set-cookie': 'SID=synthetic-q39-server; path=/' });
		if (req.headers.cookie !== 'SID=synthetic-q39-server') return text(401, '');
		if (url.pathname === '/api/v2/app/webapiVersion') return text(200, '2.11.2');
		if (url.pathname === '/api/v2/app/version') return text(200, 'v5.0.3');
		if (url.pathname === '/api/v2/torrents/categories') return json(200, {});
		if (url.pathname === '/api/v2/transfer/info') return json(200, { dl_info_speed: 1000, up_info_speed: 20, connection_status: 'connected' });
		if (url.pathname === '/api/v2/torrents/info') {
			return json(200, [{
				hash: 'b'.repeat(40), name: 'Synthetic Q39 server torrent', state: 'downloading', progress: 0.5,
				completed: 500, size: 1000, total_size: 1000, dlspeed: 1000, upspeed: 20, eta: 300, ratio: 0.5,
				category: '', num_seeds: 1, num_complete: 2, num_leechs: 0, num_incomplete: 1,
				added_on: 1700000000, last_activity: 1700000100
			}]);
		}
		return text(404, '');
	});
	t.after(() => { server.closeAllConnections?.(); server.close(); });
	return { base: 'http://127.0.0.1:' + server.address().port, state };
}

test('admin app and owner session are administrators on all five real server routes', { timeout: 60000 }, async t => {
	const directory = mkdtempSync(path.join(tmpdir(), 'tellybox-q39-server-'));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const dead = await listen((req, res) => { res.writeHead(503); res.end('{}'); });
	t.after(() => { dead.closeAllConnections?.(); dead.close(); });
	const setup = await listen((req, res) => {
		if (req.url === '/api/setup/dispatcharr/streams/readonly' || req.url.startsWith('/api/setup/dispatcharr/streams/readonly?')) {
			res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
			return res.end(JSON.stringify(STREAM_PAYLOAD));
		}
		res.writeHead(404, { 'Content-Type': 'application/json' });
		res.end('{}');
	});
	t.after(() => { setup.closeAllConnections?.(); setup.close(); });
	const qb = await startQbUpstream(t);
	const local = await listen(() => {});
	const remote = await listen(() => {});
	t.after(() => {
		local.closeAllConnections?.(); remote.closeAllConnections?.();
		local.close(); remote.close();
	});
	Object.assign(process.env, {
		NODE_ENV: 'test', AUTH_DIR: directory, DATA_DIR: directory, CATALOGUE_CACHE_DIR: directory,
		JELLYFIN_URL: 'http://127.0.0.1:' + dead.address().port,
		DISPATCHARR_URL: 'http://127.0.0.1:' + dead.address().port,
		PORT: String(local.address().port), SETUP_PORT: String(setup.address().port),
		LOCAL_HOSTS: '127.0.0.1', LOCAL_NETWORKS: '127.0.0.0/8', PUBLIC_ORIGIN: 'https://remote.test'
	});
	writeFileSync(path.join(directory, 'connection.json'), JSON.stringify({ userId: 'fixture', token: 'fixture-only' }));
	writeFileSync(path.join(directory, 'apps.json'), JSON.stringify({}));
	writeFileSync(path.join(directory, 'account-limits.json'), JSON.stringify({ accounts: {} }));
	writeFileSync(path.join(directory, 'dispatcharr.json'), JSON.stringify({ key: 'fixture-only' }));
	writeFileSync(path.join(directory, 'qbittorrent.json'), JSON.stringify({
		url: qb.base + '/', username: 'synthetic-q39-user', password: 'synthetic-q39-secret',
		enabled: true, pollSeconds: 20, stalledMinutes: 30
	}));
	writeFileSync(path.join(directory, 'capabilities.json'), JSON.stringify({
		jellyfin: true, library: true, live: true, nonstop: false, vod: true, recordings: false,
		catchup: false, discover: false, comingSoon: false, introdb: false, subtitles: false
	}));
	const { app } = await import('../server.mjs');
	local.on('request', app);
	remote.on('request', app);
	const localBase = 'http://127.0.0.1:' + local.address().port;
	const remoteBase = 'http://127.0.0.1:' + remote.address().port;
	const call = (base, route, { method = 'GET', body, headers = {} } = {}) => fetch(base + route, {
		method, redirect: 'manual',
		headers: {
			...(body === undefined ? {} : { 'Content-Type': 'application/json', Origin: base }),
			...headers
		},
		body: body === undefined ? undefined : JSON.stringify(body)
	});
	const row = async (headers, expect) => {
		for (const route of ROUTES) {
			const response = await call(remoteBase, route, { headers });
			assert.equal(response.status, expect, route);
			if (route === '/activity' && expect === 200) assert.match(await response.text(), /id="streamsPanel"/);
			else if (route === '/api/activity/streams' && expect === 200) assert.deepEqual(await response.json(), STREAM_PAYLOAD);
			else if (expect === 200) {
				const body = await response.json();
				assert.equal(body.readOnly, true, route + ' answers the sanitized read model');
			} else await response.text();
		}
	};

	// A real approved viewer app: authenticated, but refused on every surface.
	const enrolled = await call(localBase, '/api/apps/enroll', { method: 'POST', body: { name: 'Q39 server viewer' } });
	assert.ok([200, 201].includes(enrolled.status));
	const viewer = await enrolled.json();
	assert.equal(viewer.role, 'viewer');
	const bearer = { Authorization: 'Bearer ' + viewer.token };
	for (const route of ROUTES) {
		const response = await call(remoteBase, route, { headers: bearer });
		assert.equal(response.status, 403, route + ' refuses a viewer app');
		await response.text();
	}
	assert.equal((await (await call(remoteBase, '/api/auth/status', { headers: bearer })).json()).admin, false);

	// Promote the same installation to admin: every surface opens, including
	// the real streams proxy hop and the real qBittorrent reads.
	const promoted = await call(localBase, '/api/apps/' + viewer.id, { method: 'POST', body: { action: 'role', role: 'admin' } });
	assert.equal(promoted.status, 200);
	await row(bearer, 200);
	assert.equal((await (await call(remoteBase, '/api/auth/status', { headers: bearer })).json()).admin, true);
	assert.ok(qb.state.requests.length > 0, 'the allowed reads really reached the synthetic qBittorrent');

	// An installation-password session is the other remote administrator
	// branch: set the password locally, sign in remotely, reuse the cookie.
	assert.equal((await call(localBase, '/api/auth/password', { method: 'POST', body: { password: OWNER_PASSWORD } })).status, 200);
	const login = await call(remoteBase, '/api/auth/login', { method: 'POST', body: { password: OWNER_PASSWORD } });
	assert.equal(login.status, 200);
	const cookie = login.headers.get('set-cookie').split(';')[0];
	await row({ Cookie: cookie }, 200);
	const ownerStatus = await (await call(remoteBase, '/api/auth/status', { headers: { Cookie: cookie } })).json();
	assert.equal(ownerStatus.admin, true);
	assert.equal(ownerStatus.local, false);
	assert.equal(ownerStatus.authenticated, true);

	// Anonymous remote callers stay refused on the two surfaces no existing
	// full-server test covers (downloads and qBittorrent summary), and the
	// admin flag stays false.
	assert.equal((await call(remoteBase, '/api/activity/downloads')).status, 401);
	assert.equal((await call(remoteBase, '/api/qbittorrent/summary')).status, 401);
	assert.equal((await (await call(remoteBase, '/api/auth/status')).json()).admin, false);
});
