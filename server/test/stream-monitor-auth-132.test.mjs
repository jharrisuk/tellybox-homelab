/* Release 132: the setup-side streams endpoint is owner-session only and checks
 * the session before any cache/upstream work and again after the await. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createSetup } from '../homelab/admin.mjs';

const PASSWORD = 'test-only-password-1234';
const TOKEN = 'a'.repeat(64);
const body = { configured: true, enabled: true, source: 'anotherServer', state: 'ok', reachable: true,
	checkedAt: 1763450000000, upstreamAt: 1763450000000, stale: false, notice: 'Dispatcharr answered this monitoring check.',
	reported: { liveChannels: 0, liveClients: 0, vodConnections: 0, catchupConnections: 0 },
	truncated: false, rowsReported: 0, rowsShown: 0, streams: [] };

async function fixture(t, { get } = {}) {
	const directory = mkdtempSync(path.join(tmpdir(), 'tellybox-stream-auth-'));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const calls = [];
	const streams = { calls, get: get || (async ({ refresh } = {}) => { calls.push(refresh); return body; }) };
	let now = 1763450000000;
	const setup = createSetup({ directory, streams, clock: () => now, apply: async () => {} });
	const server = setup.app.listen(0, '127.0.0.1');
	await once(server, 'listening');
	t.after(() => server.close());
	const base = 'http://127.0.0.1:' + server.address().port;
	const call = (headers = {}, query = '') => fetch(base + '/api/setup/dispatcharr/streams' + query, { headers });
	const readOnly = (query = '') => fetch(base + '/api/setup/dispatcharr/streams/readonly' + query);
	const login = async () => {
		const response = await fetch(base + '/api/setup/login', { method: 'POST',
			headers: { 'Content-Type': 'application/json', Origin: base },
			body: JSON.stringify({ bootstrap: JSON.parse(readFileSync(path.join(directory, 'bootstrap.json'), 'utf8')).token, password: PASSWORD }) });
		assert.equal(response.status, 200);
		return response.headers.get('set-cookie').split(';')[0];
	};
	return { base, call, readOnly, login, calls, advance: ms => { now += ms; } };
}

test('the streams route needs a real owner session before any work', async t => {
	const { call, login, calls } = await fixture(t);
	assert.equal((await call()).status, 401);
	assert.equal((await call({ Cookie: 'tellybox_setup=' + TOKEN })).status, 401, 'a forged 64-hex cookie is not a session');
	assert.equal(calls.length, 0, 'no cache read or upstream work without the owner session');

	const cookie = await login();
	const response = await call({ Cookie: cookie });
	assert.equal(response.status, 200);
	assert.equal(response.headers.get('cache-control'), 'no-store');
	assert.deepEqual(await response.json(), body);
	assert.deepEqual(calls, [false]);
	await call({ Cookie: cookie }, '?refresh=1');
	assert.deepEqual(calls, [false, true]);
});

test('the loopback-only read-only route returns the same sanitized report without an owner session', async t => {
	const { readOnly, calls } = await fixture(t);
	const response = await readOnly();
	assert.equal(response.status, 200);
	assert.equal(response.headers.get('cache-control'), 'no-store');
	assert.deepEqual(await response.json(), body);
	assert.deepEqual(calls, [false], 'no session is needed, but the cache/upstream path is still used');
	await readOnly('?refresh=1');
	assert.deepEqual(calls, [false, true]);
});

test('a session revoked while the report is being built gets 401', async t => {
	let release;
	const gate = new Promise(resolve => { release = resolve; });
	let entered;
	const started = new Promise(resolve => { entered = resolve; });
	const { call, login, advance } = await fixture(t, { get: async () => { entered(); await gate; return body; } });
	const cookie = await login();
	const pending = call({ Cookie: cookie });
	await started;
	advance(3700000);
	release();
	const response = await pending;
	assert.equal(response.status, 401, 'the post-await check rejects a revoked session');
});
