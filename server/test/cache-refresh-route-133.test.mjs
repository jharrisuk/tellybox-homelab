/* Release 133: main-app cache status/refresh route boundary.
 *
 * No cookie or a forged cookie is denied; the owner-session probe is the only
 * authority. A refresh needs same-origin JSON, coalesces repeats and never
 * exposes a caller-supplied target. Upstream fetches are stubbed in this test.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';

const TOKEN = 'd'.repeat(64);
const listen = async handler => {
	const server = http.createServer(handler);
	server.listen(0, '127.0.0.1');
	await once(server, 'listening');
	return server;
};

test('cache status and refresh require the real owner session', { timeout: 45000 }, async t => {
	const setup = await listen((req, res) => {
		res.setHeader('Content-Type', 'application/json');
		if (req.url === '/api/setup/session' && (req.headers.cookie || '').includes('tellybox_setup=' + TOKEN)) {
			res.writeHead(200);
			return res.end(JSON.stringify({ ok: true }));
		}
		res.writeHead(401);
		res.end(JSON.stringify({ error: 'Sign in.' }));
	});
	t.after(() => setup.close());
	const directory = mkdtempSync(path.join(tmpdir(), 'tellybox-cache-route-'));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const upstream = await listen((req, res) => { res.writeHead(503, { 'Content-Type': 'application/json' }); res.end('{}'); });
	t.after(() => upstream.close());
	const local = await listen(() => {});
	t.after(() => local.close());
	Object.assign(process.env, {
		NODE_ENV: 'test', AUTH_DIR: directory, DATA_DIR: directory, CATALOGUE_CACHE_DIR: directory,
		JELLYFIN_URL: 'http://127.0.0.1:' + upstream.address().port,
		DISPATCHARR_URL: 'http://127.0.0.1:' + upstream.address().port,
		PORT: String(local.address().port), SETUP_PORT: String(setup.address().port),
		LOCAL_HOSTS: '127.0.0.1', LOCAL_NETWORKS: '127.0.0.0/8', PUBLIC_ORIGIN: 'https://remote.test'
	});
	writeFileSync(path.join(directory, 'connection.json'), JSON.stringify({ userId: 'fixture', token: 'fixture-only' }));
	writeFileSync(path.join(directory, 'apps.json'), JSON.stringify({}));
	writeFileSync(path.join(directory, 'account-limits.json'), JSON.stringify({ accounts: {} }));
	writeFileSync(path.join(directory, 'capabilities.json'), JSON.stringify({
		jellyfin: true, library: true, live: false, nonstop: false, vod: false, recordings: false,
		catchup: false, discover: false, comingSoon: false, introdb: false, subtitles: false
	}));
	// Only loopback test traffic reaches the network; any accidental upstream
	// call gets an empty JSON answer instead of a real provider request.
	const realFetch = globalThis.fetch;
	globalThis.fetch = async (input, options) => {
		const url = String(input?.url || input);
		if (url.startsWith('http://127.0.0.1:')) return realFetch(input, options);
		return new Response(JSON.stringify({ results: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
	};
	t.after(() => { globalThis.fetch = realFetch; });
	const { app } = await import('../server.mjs');
	local.on('request', app);
	const base = 'http://127.0.0.1:' + local.address().port;
	const status = headers => fetch(base + '/api/admin/cache/status', { headers });
	const refresh = (headers, body = { scope: 'all' }) => fetch(base + '/api/admin/cache/refresh', {
		method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base, ...headers }, body: JSON.stringify(body)
	});

	let response = await status();
	assert.equal(response.status, 401);
	assert.equal((await response.json()).signInRequired, true);
	assert.equal((await status({ Cookie: 'tellybox_setup=' + 'e'.repeat(64) })).status, 401, 'a forged cookie is refused');

	response = await status({ Cookie: 'tellybox_setup=' + TOKEN });
	assert.equal(response.status, 200);
	assert.equal(response.headers.get('cache-control'), 'no-store');
	const idle = await response.json();
	assert.equal(idle.state, 'idle');
	assert.deepEqual(Object.keys(idle.lastSuccess).sort(), ['discover', 'index', 'trending']);
	assert.deepEqual(Object.keys(idle.nextExpected).sort(), ['discover', 'index', 'trending']);
	assert.equal(JSON.stringify(idle).includes(directory), false, 'no filesystem path is exposed');

	assert.equal((await refresh({}, { scope: 'all' })).status, 401, 'a refresh needs the owner session');
	assert.equal((await refresh({ Cookie: 'tellybox_setup=' + TOKEN, Origin: 'https://evil.test' })).status, 403, 'cross-origin refresh is refused');

	response = await refresh({ Cookie: 'tellybox_setup=' + TOKEN });
	assert.equal(response.status, 202);
	const accepted = await response.json();
	assert.equal(accepted.accepted || accepted.reason === 'coalesced', true);
	const duplicate = await refresh({ Cookie: 'tellybox_setup=' + TOKEN });
	assert.equal([202, 429].includes(duplicate.status), true, 'a repeat is coalesced or rate-limited');

	// Let the queued empty tasks settle, then confirm the status is readable.
	await new Promise(resolve => setTimeout(resolve, 250));
	response = await status({ Cookie: 'tellybox_setup=' + TOKEN });
	assert.equal(response.status, 200);
	const after = await response.json();
	assert.equal(typeof after.running, 'boolean');
});
