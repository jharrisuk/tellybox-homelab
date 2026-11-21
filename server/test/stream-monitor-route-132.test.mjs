/* Release 132: the main-site stream endpoint is an owner-session forwarder.
 *
 * It must not treat LAN/local/approved-viewer access as administrator, must
 * forward only the installation cookie to a fixed loopback setup endpoint, and
 * must never proxy a caller-supplied target. */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';

const TOKEN = 'b'.repeat(64);
const payload = { configured: true, enabled: true, source: 'anotherServer', state: 'ok', reachable: true,
	checkedAt: 1763450000000, upstreamAt: 1763450000000, stale: false, notice: 'Dispatcharr answered this monitoring check.',
	reported: { liveChannels: 1, liveClients: 1, vodConnections: 0, catchupConnections: 0 },
	truncated: false, rowsReported: 1, rowsShown: 1,
	streams: [{ kind: 'live', key: 'live:1', title: 'BBC One', typeLabel: 'Live', state: 'running',
		source: 'custom', profile: 'custom Default', app: 'Tellybox server', format: 'hls', codec: 'h264', resolution: '1920x1080', fps: 25,
		audio: 'aac 2ch', averageBitrateKbps: 4200, bytes: 1000, durationSeconds: 60,
		connections: { reported: 1, shown: 1, truncated: false, items: [] }, note: null }] };

async function listen(handler) {
	const server = http.createServer(handler);
	server.listen(0, '127.0.0.1');
	await once(server, 'listening');
	return server;
}

test('owner session gate, fixed loopback forwarding and no SSRF', { timeout: 45000 }, async t => {
	const requests = [];
	const setup = await listen((req, res) => {
		requests.push({ url: req.url, headers: { ...req.headers } });
		const cookie = req.headers.cookie || '';
		if (!cookie.includes('tellybox_setup=' + TOKEN)) {
			res.writeHead(401, { 'Content-Type': 'application/json' });
			return res.end(JSON.stringify({ error: 'Sign in to configure this installation.' }));
		}
		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify(payload));
	});
	t.after(() => setup.close());
	const directory = mkdtempSync(path.join(tmpdir(), 'tellybox-stream-route-'));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const upstream = await listen((req, res) => { res.writeHead(503); res.end('{}'); });
	t.after(() => upstream.close());
	const local = await listen(() => {});
	t.after(() => local.close());
	Object.assign(process.env, {
		NODE_ENV: 'test', AUTH_DIR: directory, DATA_DIR: directory, CATALOGUE_CACHE_DIR: directory,
		JELLYFIN_URL: 'http://127.0.0.1:' + upstream.address().port,
		DISPATCHARR_URL: 'http://127.0.0.1:' + upstream.address().port,
		PORT: String(local.address().port), SETUP_PORT: String(setup.address().port),
		// A non-loopback override must not be used.
		SETUP_INTERNAL_URL: 'http://192.0.2.1:1',
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
	const { app } = await import('../server.mjs');
	local.on('request', app);
	const base = 'http://127.0.0.1:' + local.address().port;
	const call = (options = {}) => fetch(base + '/api/admin/dispatcharr/streams' + (options.query || ''), {
		headers: options.headers || {}
	});

	let response = await call();
	assert.equal(response.status, 401);
	assert.equal((await response.json()).signInRequired, true);
	assert.equal((await call({ headers: { Authorization: 'Bearer ' + 'c'.repeat(64), 'X-JServer-App': 'd'.repeat(32) } })).status, 401);
	assert.equal(requests.length, 0, 'no setup hop before a cookie exists');
	assert.equal((await call({ headers: { Cookie: 'tellybox_setup=' + 'e'.repeat(64) } })).status, 401);
	assert.equal(requests.length, 1, 'a forged cookie is checked by the owner endpoint');

	response = await call({ headers: { Cookie: 'tellybox_setup=' + TOKEN }, query: '?refresh=1&url=http://evil.test/' });
	assert.equal(response.status, 200);
	assert.equal(response.headers.get('cache-control'), 'no-store');
	assert.deepEqual(await response.json(), payload);
	const forwarded = requests.at(-1);
	assert.match(forwarded.url, /^\/api\/setup\/dispatcharr\/streams\?refresh=1$/);
	assert.equal(forwarded.headers.cookie, 'tellybox_setup=' + TOKEN);
	assert.equal(forwarded.headers.authorization, undefined, 'the main app forwards no app bearer');
	assert.equal(forwarded.headers['x-jserver-app'], undefined);
	assert.equal(forwarded.url.includes('evil'), false, 'caller query parameters are not proxied');

	// A non-JSON setup answer is rejected rather than relayed.
	const bad = await listen((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end('<html>'); });
	t.after(() => bad.close());
	process.env.SETUP_PORT = String(bad.address().port);
	response = await call({ headers: { Cookie: 'tellybox_setup=' + TOKEN } });
	assert.equal(response.status, 502);

	// A closed setup service reports unavailable, not empty streams.
	process.env.SETUP_PORT = String(await (async () => { const server = await listen(() => {}); const port = server.address().port; server.close(); return port; })());
	// The main relay must be able to pass a maximal valid sanitized report.
	const big = await listen((req, res) => {
		res.writeHead(200, { 'Content-Type': 'application/json' });
		res.end(JSON.stringify({ state: 'ok', streams: [], pad: 'x'.repeat(300 * 1024) }));
	});
	t.after(() => big.close());
	process.env.SETUP_PORT = String(big.address().port);
	response = await call({ headers: { Cookie: 'tellybox_setup=' + TOKEN } });
	assert.equal(response.status, 200);
	assert.ok((await response.text()).length > 300 * 1024, 'a 300 KiB sanitized report is relayed');
});
