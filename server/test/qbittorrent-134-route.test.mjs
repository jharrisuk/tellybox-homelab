/* Release 134: the qBittorrent routes use the real release-132 owner boundary.
 *
 * A LAN/local request, a forged setup cookie, a viewer or an admin app bearer
 * is not the installation owner. The monitoring route must make no upstream
 * request before the owner session is confirmed, and every mutating route
 * requires JSON from the same origin.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createSetup } from '../homelab/admin.mjs';

const PASSWORD = 'test-only-password-1234';
const QB_PASSWORD = 'test-only-qbittorrent-password';
const HASH = 'a'.repeat(40);

async function listen(handler) {
	const server = http.createServer(handler);
	server.listen(0, '127.0.0.1');
	await once(server, 'listening');
	return server;
}

function row() {
	return {
		hash: HASH, name: 'Owner only download', state: 'downloading', progress: 0.25,
		completed: 250, size: 1000, total_size: 1200, dlspeed: 1000, upspeed: 20, eta: 300,
		category: 'Movies', num_seeds: 1, num_complete: 2, num_leechs: 0, num_incomplete: 1,
		added_on: 1700000000, last_activity: 1700000100
	};
}

async function startQb(t) {
	const state = { calls: [], torrents: [row()] };
	const server = await listen(async (req, res) => {
		const chunks = [];
		for await (const chunk of req) chunks.push(chunk);
		const body = Buffer.concat(chunks).toString('utf8');
		const url = new URL(req.url, 'http://127.0.0.1');
		state.calls.push({ method: req.method, path: url.pathname, url: req.url, headers: { ...req.headers }, body });
		const text = (status, value, headers = {}) => { res.writeHead(status, { 'content-type': 'text/plain', ...headers }); res.end(value); };
		const json = (status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
		if (url.pathname === '/api/v2/auth/login') return text(200, 'Ok.', { 'set-cookie': 'SID=route-test; path=/' });
		if (req.headers.cookie !== 'SID=route-test') return text(401, '');
		if (url.pathname === '/api/v2/app/webapiVersion') return text(200, '2.11.2');
		if (url.pathname === '/api/v2/app/version') return text(200, 'v5.0.3');
		if (url.pathname === '/api/v2/torrents/categories') return json(200, { Movies: { name: 'Movies', savePath: '/srv/private' } });
		if (url.pathname === '/api/v2/transfer/info') return json(200, { dl_info_speed: 1000, up_info_speed: 20, connection_status: 'connected' });
		if (url.pathname === '/api/v2/torrents/info') {
			const hashes = url.searchParams.get('hashes');
			const rows = hashes ? state.torrents.filter(item => hashes.split('|').includes(item.hash)) : state.torrents;
			return json(200, rows);
		}
		if (url.pathname === '/api/v2/torrents/delete') {
			const form = new URLSearchParams(body);
			state.torrents = state.torrents.filter(item => !String(form.get('hashes') || '').split('|').includes(item.hash));
			return text(200, '');
		}
		return text(404, '');
	});
	t.after(() => { server.closeAllConnections?.(); server.close(); });
	return { base: 'http://127.0.0.1:' + server.address().port, state };
}

test('qBittorrent is owner-session only, CSRF-bound and makes no request before authorisation', { timeout: 45000 }, async t => {
	const directory = mkdtempSync(path.join(tmpdir(), 'tellybox-qbittorrent-route-'));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const qb = await startQb(t);
	const setup = createSetup({ directory, apply: async () => {} });
	const setupServer = setup.app.listen(0, '127.0.0.1');
	await once(setupServer, 'listening');
	t.after(() => setupServer.close());
	const dead = await listen((req, res) => { res.writeHead(503); res.end('{}'); });
	t.after(() => dead.close());
	const local = await listen(() => {});
	t.after(() => local.close());
	Object.assign(process.env, {
		NODE_ENV: 'test', AUTH_DIR: directory, DATA_DIR: directory, CATALOGUE_CACHE_DIR: directory,
		JELLYFIN_URL: 'http://127.0.0.1:' + dead.address().port,
		DISPATCHARR_URL: 'http://127.0.0.1:' + dead.address().port,
		PORT: String(local.address().port), SETUP_PORT: String(setupServer.address().port),
		LOCAL_HOSTS: '127.0.0.1', LOCAL_NETWORKS: '127.0.0.0/8', PUBLIC_ORIGIN: 'https://remote.test'
	});
	writeFileSync(path.join(directory, 'connection.json'), JSON.stringify({ userId: 'fixture', token: 'fixture-only' }));
	writeFileSync(path.join(directory, 'apps.json'), JSON.stringify({}));
	writeFileSync(path.join(directory, 'account-limits.json'), JSON.stringify({ accounts: {} }));
	writeFileSync(path.join(directory, 'dispatcharr.json'), JSON.stringify({ key: 'fixture-only' }));
	writeFileSync(path.join(directory, 'capabilities.json'), JSON.stringify({
		jellyfin: true, library: true, live: false, nonstop: false, vod: true, recordings: false,
		catchup: false, discover: false, comingSoon: false, introdb: false, subtitles: false
	}));
	writeFileSync(path.join(directory, 'qbittorrent.json'), JSON.stringify({
		url: qb.base, username: 'owner', password: QB_PASSWORD, enabled: true, pollSeconds: 15, stalledMinutes: 30
	}));
	const { app } = await import('../server.mjs');
	local.on('request', app);
	const mainBase = 'http://127.0.0.1:' + local.address().port;
	const setupBase = 'http://127.0.0.1:' + setupServer.address().port;
	const call = (route, { method = 'GET', body, headers = {} } = {}) => fetch(mainBase + route, {
		method,
		headers: {
			...(body === undefined ? {} : { 'content-type': 'application/json', Origin: mainBase }),
			...headers
		},
		body: body === undefined ? undefined : JSON.stringify(body)
	});
	const login = await fetch(setupBase + '/api/setup/login', {
		method: 'POST', headers: { 'Content-Type': 'application/json', Origin: setupBase },
		body: JSON.stringify({ bootstrap: JSON.parse(readFileSync(path.join(directory, 'bootstrap.json'), 'utf8')).token, password: PASSWORD })
	});
	assert.equal(login.status, 200);
	const cookie = login.headers.get('set-cookie').split(';')[0];
	const owner = { Cookie: cookie };

	let response = await call('/api/qbittorrent/downloads');
	assert.equal(response.status, 401);
	assert.equal(qb.state.calls.length, 0, 'no qBittorrent request without an owner session');
	assert.equal((await call('/api/qbittorrent/status')).status, 401);
	assert.equal((await call('/api/qbittorrent/status', { headers: { Cookie: 'tellybox_setup=' + 'b'.repeat(64) } })).status, 401);
	assert.equal(qb.state.calls.length, 0, 'a forged 64-hex setup cookie is checked by setup and makes no upstream request');
	assert.equal((await call('/api/qbittorrent/status', { headers: { Authorization: 'Bearer ' + 'c'.repeat(64), 'X-JServer-App': 'android' } })).status, 401);
	assert.equal(qb.state.calls.length, 0);
	assert.equal((await call('/api/qbittorrent/downloads', { headers: { 'X-Forwarded-For': '192.168.0.42' } })).status, 401, 'LAN forwarding alone is not authority');
	assert.equal((await call('/api/qbittorrent/summary', { headers: { 'X-Forwarded-For': '192.168.0.42' } })).status, 401, 'forged forwarding never creates trusted-local statistics');

	// A real approved viewer, then admin, app bearer is still not the installation owner.
	const enrolled = await call('/api/apps/enroll', { method: 'POST', body: { name: 'Owner phone' } });
	assert.ok([200, 201].includes(enrolled.status), 'enrolment should succeed: ' + enrolled.status);
	const appToken = await enrolled.json();
	response = await call('/api/qbittorrent/downloads', { headers: { Authorization: 'Bearer ' + appToken.token } });
	assert.equal(response.status, 401, 'a viewer app token does not unlock the owner download list');
	await call('/api/apps/' + appToken.id, { method: 'POST', body: { action: 'role', role: 'admin' } });
	response = await call('/api/qbittorrent/downloads', { headers: { Authorization: 'Bearer ' + appToken.token } });
	assert.equal(response.status, 401, 'an admin app token does not unlock the owner download list');
	assert.equal(qb.state.calls.length, 0);

	response = await call('/api/qbittorrent/status', { headers: owner });
	assert.equal(response.status, 200);
	assert.equal(response.headers.get('cache-control'), 'no-store');
	const statusText = await response.text();
	for (const secret of [QB_PASSWORD, 'owner', qb.base, HASH]) assert.equal(statusText.includes(secret), false, secret);

	response = await call('/api/qbittorrent/downloads', { headers: owner });
	assert.equal(response.status, 200);
	assert.equal(response.headers.get('cache-control'), 'no-store');
	const body = await response.json();
	assert.equal(body.state, 'ok');
	assert.equal(body.rows.length, 1);
	assert.equal(body.rows[0].name, 'Owner only download');
	assert.equal(JSON.stringify(body).includes(HASH), false);
	assert.ok(qb.state.calls.some(item => item.path === '/api/v2/torrents/info'));

	// The production mount order also gives a trusted local page the bounded
	// summary. It carries counts only, never a name, hash or saved credential.
	response = await call('/api/qbittorrent/summary');
	assert.equal(response.status, 200);
	assert.equal(response.headers.get('cache-control'), 'no-store');
	const summary = await response.json();
	assert.equal(summary.readOnly, true);
	assert.equal(summary.state, 'ok');
	assert.equal(summary.counts.downloading, 1);
	assert.equal(summary.sampleSize, 1);
	const summaryText = JSON.stringify(summary);
	for (const secret of [QB_PASSWORD, 'owner', qb.base, HASH, 'Owner only download']) {
		assert.equal(summaryText.includes(secret), false, 'summary must not contain ' + secret);
	}

	// CSRF: same-origin JSON is required. An arbitrary hash body cannot delete.
	const beforeDelete = qb.state.calls.filter(item => item.path === '/api/v2/torrents/delete').length;
	response = await call('/api/qbittorrent/delete', { method: 'POST', body: { hashes: 'all' }, headers: { Origin: 'https://evil.test', ...owner } });
	assert.equal(response.status, 403);
	response = await call('/api/qbittorrent/delete', { method: 'POST', body: { hashes: 'all' }, headers: owner });
	assert.equal(response.status, 409);
	assert.equal(qb.state.calls.filter(item => item.path === '/api/v2/torrents/delete').length, beforeDelete);

	response = await call('/api/qbittorrent/config', { method: 'POST', body: { enabled: false }, headers: { Origin: 'https://evil.test', ...owner } });
	assert.equal(response.status, 403);
	response = await call('/api/qbittorrent/config', { method: 'POST', body: { enabled: false }, headers: { ...owner, 'content-type': 'text/plain' } });
	assert.equal(response.status, 403);

	response = await call('/activity/downloads');
	assert.equal(response.status, 401);
	response = await call('/activity/downloads', { headers: owner });
	assert.equal(response.status, 200);
	assert.match(response.headers.get('content-type') || '', /text\/html/);
	const page = await response.text();
	assert.match(page, /Activity downloads/);
	assert.match(page, /Remove torrent, keep files/);
	assert.match(page, /cannot be recovered/);

	const callsBeforeLogout = qb.state.calls.length;
	const logout = await fetch(setupBase + '/api/setup/logout', {
		method: 'POST', headers: { Cookie: cookie, Origin: setupBase, 'Content-Type': 'application/json' }, body: '{}'
	});
	assert.equal(logout.status, 200);
	assert.equal((await call('/api/qbittorrent/downloads', { headers: owner })).status, 401, 'a signed-out owner session stops immediately');
	assert.equal(qb.state.calls.length, callsBeforeLogout, 'no qBittorrent request after logout');
});
