/* Release 134 P1: real owner-session revocation during suspended qBittorrent
 * lookup and destructive login. The qBittorrent endpoint is a local mock; no
 * external network, torrent or file is touched.
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

function gate() {
	let release;
	let entered;
	const enteredPromise = new Promise(resolve => { entered = resolve; });
	const waitPromise = new Promise(resolve => { release = resolve; });
	return {
		entered: enteredPromise,
		release: () => release(),
		async wait() { entered(); await waitPromise; }
	};
}

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
	const state = { calls: [], deletes: [], blockInfo: null, blockLogin: null };
	const server = await listen(async (req, res) => {
		const chunks = [];
		for await (const chunk of req) chunks.push(chunk);
		const body = Buffer.concat(chunks).toString('utf8');
		const url = new URL(req.url, 'http://127.0.0.1');
		state.calls.push({ method: req.method, path: url.pathname, body });
		const text = (status, value, headers = {}) => { res.writeHead(status, { 'content-type': 'text/plain', ...headers }); res.end(value); };
		const json = (status, value) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
		if (url.pathname === '/api/v2/auth/login') {
			const block = state.blockLogin;
			if (block) { state.blockLogin = null; await block.wait(); }
			return text(200, 'Ok.', { 'set-cookie': 'SID=route-test; path=/' });
		}
		if (req.headers.cookie !== 'SID=route-test') return text(401, '');
		if (url.pathname === '/api/v2/app/webapiVersion') return text(200, '2.11.2');
		if (url.pathname === '/api/v2/app/version') return text(200, 'v5.0.3');
		if (url.pathname === '/api/v2/torrents/categories') return json(200, {});
		if (url.pathname === '/api/v2/transfer/info') return json(200, { dl_info_speed: 0, up_info_speed: 0, connection_status: 'connected' });
		if (url.pathname === '/api/v2/torrents/info') {
			const block = state.blockInfo;
			if (block) { state.blockInfo = null; await block.wait(); }
			return json(200, [row()]);
		}
		if (url.pathname === '/api/v2/torrents/delete') {
			state.deletes.push({ body });
			return text(200, '');
		}
		return text(404, '');
	});
	t.after(() => { server.closeAllConnections?.(); server.close(); });
	return { base: 'http://127.0.0.1:' + server.address().port, state };
}

test('a revoked owner session stops delete during lookup and destructive login', { timeout: 45000 }, async t => {
	const directory = mkdtempSync(path.join(tmpdir(), 'tellybox-qbittorrent-race-route-'));
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
	const loginOwner = async () => {
		const login = await fetch(setupBase + '/api/setup/login', {
			method: 'POST', headers: { 'Content-Type': 'application/json', Origin: setupBase },
			body: JSON.stringify({
				bootstrap: JSON.parse(readFileSync(path.join(directory, 'bootstrap.json'), 'utf8')).token,
				password: PASSWORD
			})
		});
		assert.equal(login.status, 200);
		return login.headers.get('set-cookie').split(';')[0];
	};
	const logoutOwner = async cookie => {
		const logout = await fetch(setupBase + '/api/setup/logout', {
			method: 'POST', headers: { Cookie: cookie, Origin: setupBase, 'Content-Type': 'application/json' }, body: '{}'
		});
		assert.equal(logout.status, 200);
	};
	const prepare = async cookie => {
		const owner = { Cookie: cookie };
		const listing = await call('/api/qbittorrent/downloads', { headers: owner });
		assert.equal(listing.status, 200);
		const data = await listing.json();
		const confirmation = await call('/api/qbittorrent/confirm', {
			method: 'POST', body: { id: data.rows[0].id, action: 'remove' }, headers: owner
		});
		assert.equal(confirmation.status, 200);
		const review = await confirmation.json();
		assert.match(review.token, /^[a-f0-9]{64}$/);
		return { owner, review };
	};

	// Phase 1: the real owner session is revoked while the commit's torrent
	// lookup is suspended. The post-lookup owner check must fail closed.
	let cookie = await loginOwner();
	let { owner, review } = await prepare(cookie);
	let blocked = gate();
	qb.state.blockInfo = blocked;
	let pending = call('/api/qbittorrent/delete', { method: 'POST', body: { token: review.token }, headers: owner });
	await blocked.entered;
	await logoutOwner(cookie);
	blocked.release();
	let response = await pending;
	assert.equal(response.status, 401);
	assert.equal(qb.state.deletes.length, 0, 'no delete after logout during lookup');

	// Phase 2: the owner session is revoked while the destructive login is
	// suspended, after the first post-lookup owner check has passed. The final
	// owner check must stop the POST.
	cookie = await loginOwner();
	({ owner, review } = await prepare(cookie));
	blocked = gate();
	qb.state.blockLogin = blocked;
	pending = call('/api/qbittorrent/delete', { method: 'POST', body: { token: review.token }, headers: owner });
	await blocked.entered;
	await logoutOwner(cookie);
	blocked.release();
	response = await pending;
	assert.equal(response.status, 401);
	assert.equal(qb.state.deletes.length, 0, 'no delete after logout during destructive login');
});
