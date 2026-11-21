/* Release 133: owner-session validation for the manual cache refresh.
 *
 * The main app must not trust LAN/local access. It forwards only the
 * installation cookie to the setup app's session probe, which returns no
 * identity or configuration. Forged, missing and unreachable cases fail
 * closed. */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createSetup } from '../homelab/admin.mjs';
import { createOwnerSession } from '../owner-session.mjs';

const PASSWORD = 'test-only-password-1234';
const TOKEN = 'c'.repeat(64);

async function setupFixture(t) {
	const directory = mkdtempSync(path.join(tmpdir(), 'tellybox-owner-session-'));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const setup = createSetup({ directory, clock: () => 1_800_000_000_000, apply: async () => {} });
	const server = setup.app.listen(0, '127.0.0.1');
	await once(server, 'listening');
	t.after(() => server.close());
	const base = 'http://127.0.0.1:' + server.address().port;
	const login = async () => {
		const response = await fetch(base + '/api/setup/login', {
			method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base },
			body: JSON.stringify({ bootstrap: JSON.parse(readFileSync(path.join(directory, 'bootstrap.json'), 'utf8')).token, password: PASSWORD })
		});
		assert.equal(response.status, 200);
		return response.headers.get('set-cookie').split(';')[0];
	};
	return { base, login };
}

test('the setup session probe returns no identity and rejects missing/forged cookies', async t => {
	const { base, login } = await setupFixture(t);
	const probe = headers => fetch(base + '/api/setup/session', { headers });
	assert.equal((await probe()).status, 401);
	assert.equal((await probe({ Cookie: 'tellybox_setup=' + TOKEN })).status, 401, 'a forged 64-hex cookie is not a session');
	const cookie = await login();
	const response = await probe({ Cookie: cookie });
	assert.equal(response.status, 200);
	assert.equal(response.headers.get('cache-control'), 'no-store');
	assert.deepEqual(await response.json(), { ok: true });
});

test('the main app accepts only a real owner session and fails closed when setup is down', async t => {
	const { base, login } = await setupFixture(t);
	const check = createOwnerSession({ origin: base, timeoutMs: 2000 });
	const request = cookie => ({ get: () => cookie || undefined });
	assert.deepEqual(await check(request('')), { ok: false, unavailable: false }, 'no cookie is a clean 401');
	assert.deepEqual(await check(request('tellybox_setup=' + TOKEN)), { ok: false, unavailable: false }, 'forged cookie is denied by setup');
	const cookie = await login();
	assert.deepEqual(await check(request(cookie)), { ok: true, unavailable: false });

	const down = http.createServer();
	down.listen(0, '127.0.0.1');
	await once(down, 'listening');
	const port = down.address().port;
	await new Promise(resolve => down.close(resolve));
	const offline = createOwnerSession({ origin: 'http://127.0.0.1:' + port, timeoutMs: 250 });
	assert.deepEqual(await offline(request(cookie)), { ok: false, unavailable: true }, 'an unreachable setup app is not treated as the owner');
});
