/* Read-only Activity -> Streams access for a trusted local/home viewer.
 *
 * The full log and the owner-session stream route keep their existing guards.
 * This test proves the new sanitized path is local/home/admin only, forwards no
 * caller URL or cookie, and never renders the panel for a remote non-admin. */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';

const payload = { configured: true, enabled: true, source: 'anotherServer', state: 'ok', reachable: true,
	checkedAt: 1763450000000, upstreamAt: 1763450000000, stale: false, notice: 'Dispatcharr answered this monitoring check.',
	reported: { liveChannels: 1, liveClients: 1, vodConnections: 0, catchupConnections: 0 },
	truncated: false, rowsReported: 1, rowsShown: 1,
	streams: [{ kind: 'live', key: 'live:1', title: 'BBC One', typeLabel: 'Live', state: 'running',
		source: 'custom', profile: 'custom Default', app: 'Android TV', format: 'hls', codec: 'h264', resolution: '1920x1080', fps: 25,
		audio: 'aac 2ch', averageBitrateKbps: 4200, bytes: 1000, durationSeconds: 60,
		connections: { reported: 1, shown: 1, truncated: false, items: [] }, note: null }] };

async function listen(handler) {
	const server = http.createServer(handler);
	server.listen(0, '127.0.0.1');
	await once(server, 'listening');
	return server;
}

test('local read-only streams work without an owner session; remote non-admin gets 403 and no panel', { timeout: 45000 }, async t => {
	const requests = [];
	const setup = await listen((req, res) => {
		requests.push({ url: req.url, headers: { ...req.headers } });
		if (req.url !== '/api/setup/dispatcharr/streams/readonly' && !req.url.startsWith('/api/setup/dispatcharr/streams/readonly?')) {
			res.writeHead(404, { 'Content-Type': 'application/json' });
			return res.end('{}');
		}
		res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
		res.end(JSON.stringify(payload));
	});
	t.after(() => setup.close());
	const dead = await listen((req, res) => { res.writeHead(503); res.end('{}'); });
	t.after(() => dead.close());
	const local = await listen(() => {});
	const remote = await listen(() => {});
	t.after(() => {
		local.closeAllConnections?.(); local.close();
		remote.closeAllConnections?.(); remote.close();
	});
	const directory = mkdtempSync(path.join(tmpdir(), 'tellybox-stream-readonly-'));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
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
	writeFileSync(path.join(directory, 'capabilities.json'), JSON.stringify({
		jellyfin: true, library: true, live: true, nonstop: false, vod: true, recordings: false,
		catchup: false, discover: false, comingSoon: false, introdb: false, subtitles: false
	}));
	const { app } = await import('../server.mjs');
	local.on('request', app);
	remote.on('request', app);
	const localBase = 'http://127.0.0.1:' + local.address().port;
	const remoteBase = 'http://127.0.0.1:' + remote.address().port;
	const call = (base, route, headers = {}) => fetch(base + route, { headers });

	const page = await call(localBase, '/activity');
	assert.equal(page.status, 200);
	assert.match(await page.text(), /id="streamsPanel"/, 'a local viewer gets the real panel');
	const localStatus = await (await call(localBase, '/api/auth/status')).json();
	assert.equal(localStatus.admin, true, 'the local settings page is an administrator');
	const remoteStatus = await (await call(remoteBase, '/api/auth/status')).json();
	assert.equal(remoteStatus.admin, false, 'an anonymous remote caller is not an administrator');

	const streams = await call(localBase, '/api/activity/streams');
	assert.equal(streams.status, 200);
	assert.equal(streams.headers.get('cache-control'), 'no-store');
	assert.deepEqual(await streams.json(), payload);
	assert.equal(requests.at(-1).headers.cookie, undefined, 'no owner cookie is forwarded');
	assert.equal(requests.at(-1).headers.authorization, undefined);

	await call(localBase, '/api/activity/streams?refresh=1&url=http://evil.test/');
	assert.equal(requests.at(-1).url, '/api/setup/dispatcharr/streams/readonly?refresh=1');
	assert.equal(requests.at(-1).url.includes('evil'), false, 'caller query parameters are not proxied');

	// Anonymous remote callers are stopped by the auth gate. An approved viewer
	// app is authenticated but is not an installation administrator, so the
	// streams route answers its own 403.
	const enrolled = await fetch(localBase + '/api/apps/enroll', { method: 'POST',
		headers: { 'Content-Type': 'application/json', Origin: localBase }, body: JSON.stringify({ name: 'Remote viewer 138' }) });
	assert.ok([200, 201].includes(enrolled.status));
	const viewer = await enrolled.json();
	const denied = await call(remoteBase, '/api/activity/streams', { Authorization: 'Bearer ' + viewer.token });
	assert.equal(denied.status, 403);
	assert.equal(denied.headers.get('cache-control'), 'no-store');
	assert.match((await denied.json()).error, /installation administrators only/i);
	assert.equal((await call(remoteBase, '/api/activity/streams')).status, 401, 'anonymous remote is refused by the auth gate');

	const remotePage = await call(remoteBase, '/activity');
	assert.equal(remotePage.status, 403, 'a remote non-admin does not get the page at all');
	const remoteBody = await remotePage.text();
	assert.equal(remoteBody.includes('streamsPanel'), false, 'no streams panel or locked teaser is rendered');
});
