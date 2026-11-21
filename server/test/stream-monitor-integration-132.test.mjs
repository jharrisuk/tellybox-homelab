/* Release 132: real setup-owner session across the real main/setup boundary. */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createSetup } from '../homelab/admin.mjs';

const PASSWORD = 'test-only-password-1234';
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

test('real owner session unlocks the main endpoint; logout revokes it', { timeout: 45000 }, async t => {
	const directory = mkdtempSync(path.join(tmpdir(), 'tellybox-stream-integration-'));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	let calls = 0;
	const streams = { get: async () => { calls += 1; return payload; } };
	const setup = createSetup({ directory, streams, apply: async () => {} });
	const setupServer = setup.app.listen(0, '127.0.0.1');
	await once(setupServer, 'listening');
	t.after(() => setupServer.close());
	const dead = await listen((req, res) => { res.writeHead(503); res.end('{}'); });
	t.after(() => dead.close());
	const local = await listen(() => {});
	t.after(() => local.close());
	Object.assign(process.env, {
		NODE_ENV: 'test', AUTH_DIR: directory, DATA_DIR: directory, CATALOGUE_CACHE_DIR: directory,
		JELLYFIN_URL: 'http://127.0.0.1:' + dead.address().port, DISPATCHARR_URL: 'http://127.0.0.1:' + dead.address().port,
		PORT: String(local.address().port), SETUP_PORT: String(setupServer.address().port),
		LOCAL_HOSTS: '127.0.0.1', LOCAL_NETWORKS: '127.0.0.0/8', PUBLIC_ORIGIN: 'https://remote.test'
	});
	writeFileSync(path.join(directory, 'connection.json'), JSON.stringify({ userId: 'fixture', token: 'fixture-only' }));
	writeFileSync(path.join(directory, 'apps.json'), JSON.stringify({}));
	writeFileSync(path.join(directory, 'account-limits.json'), JSON.stringify({ accounts: {} }));
	writeFileSync(path.join(directory, 'dispatcharr.json'), JSON.stringify({ key: 'fixture-only' }));
	writeFileSync(path.join(directory, 'capabilities.json'), JSON.stringify({ jellyfin: true, library: true, live: false,
		nonstop: false, vod: true, recordings: false, catchup: false, discover: false, comingSoon: false, introdb: false, subtitles: false }));
	const { app } = await import('../server.mjs');
	local.on('request', app);
	const mainBase = 'http://127.0.0.1:' + local.address().port;
	const setupBase = 'http://127.0.0.1:' + setupServer.address().port;
	const mainCall = cookie => fetch(mainBase + '/api/admin/dispatcharr/streams', { headers: cookie ? { Cookie: cookie } : {} });
	const login = await fetch(setupBase + '/api/setup/login', { method: 'POST',
		headers: { 'Content-Type': 'application/json', Origin: setupBase },
		body: JSON.stringify({ bootstrap: JSON.parse(readFileSync(path.join(directory, 'bootstrap.json'), 'utf8')).token, password: PASSWORD }) });
	assert.equal(login.status, 200);
	const cookie = login.headers.get('set-cookie').split(';')[0];

	const denied = await mainCall();
	assert.equal(denied.status, 401);
	assert.equal(calls, 0, 'no setup or upstream work without the owner session');

	const allowed = await mainCall(cookie);
	assert.equal(allowed.status, 200);
	assert.equal(allowed.headers.get('cache-control'), 'no-store');
	assert.deepEqual(await allowed.json(), payload);
	assert.equal(calls, 1);

	const logout = await fetch(setupBase + '/api/setup/logout', { method: 'POST', headers: { Cookie: cookie, Origin: setupBase, 'Content-Type': 'application/json' }, body: '{}' });
	assert.equal(logout.status, 200);
	const revoked = await mainCall(cookie);
	assert.equal(revoked.status, 401, 'the real setup session is gone, so the forwarded cookie is refused');
	assert.equal(calls, 1, 'revocation is checked before a new report is built');
});
