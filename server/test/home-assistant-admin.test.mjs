import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createSetup } from '../homelab/admin.mjs';
import { createHomeAssistantTokens } from '../home-assistant.mjs';

async function fixture(t, dir) {
	const setup = createSetup({ directory: dir, apply: async () => {} });
	const server = setup.app.listen(0, '127.0.0.1');
	await once(server, 'listening');
	t.after(() => server.close());
	const base = 'http://127.0.0.1:' + server.address().port;
	const req = (route, body, headers = {}) => fetch(base + '/api/setup/' + route, {
		method: body === undefined ? 'GET' : 'POST',
		headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json', Origin: base }), ...headers },
		body: body === undefined ? undefined : JSON.stringify(body)
	});
	const login = () => req('login', { password: 'test-only-password-1234' });
	return { base, req, login };
}

function directory(t) { const dir = mkdtempSync(path.join(tmpdir(), 'tellybox-home-assistant-admin-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; }

test('Home Assistant token management requires the installation administrator', async t => {
	const f = await fixture(t, directory(t));
	assert.equal((await f.req('home-assistant')).status, 401);
	assert.equal((await f.req('home-assistant', { action: 'create' })).status, 401);
});

test('installation settings expose create, rotate, revoke and one-time copy controls', () => {
	const html = readFileSync(new URL('../homelab/public/index.html', import.meta.url), 'utf8');
	const script = readFileSync(new URL('../homelab/public/setup.js', import.meta.url), 'utf8');
	for (const id of ['homeAssistantPanel', 'homeAssistantCreate', 'homeAssistantRotate', 'homeAssistantRevoke', 'homeAssistantToken', 'homeAssistantCopy']) assert.ok(html.includes(`id="${id}"`), id);
	assert.ok(script.includes("request('home-assistant', { action: 'create' })"));
	assert.ok(script.includes("request('home-assistant', { action: 'rotate' })"));
	assert.ok(script.includes("request('home-assistant', { action: 'revoke' })"));
	assert.ok(script.includes('not shown again'));
	assert.ok(html.includes('shown only once'));
});

test('create, rotate and revoke return the raw token once and persist only its hash', async t => {
	const dir = directory(t), f = await fixture(t, dir);
	const bootstrap = JSON.parse(readFileSync(path.join(dir, 'bootstrap.json'), 'utf8')).token;
	const claimed = await f.req('login', { bootstrap, password: 'test-only-password-1234' });
	assert.equal(claimed.status, 200);
	const cookie = claimed.headers.get('set-cookie').split(';')[0], headers = { Cookie: cookie };

	let response = await f.req('home-assistant', undefined, headers);
	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), { configured: false });

	assert.equal((await f.req('home-assistant', { action: 'create' }, { ...headers, Origin: 'https://evil.example' })).status, 403);
	assert.equal((await f.req('home-assistant', { action: 'unknown' }, headers)).status, 400);

	response = await f.req('home-assistant', { action: 'create' }, headers);
	assert.equal(response.status, 201);
	const created = await response.json();
	assert.equal(created.configured, true);
	assert.match(created.token, /^[a-f0-9]{64}$/);
	assert.equal(Object.hasOwn(created, 'tokenHash'), false);
	assert.equal((await f.req('home-assistant', { action: 'create' }, headers)).status, 409);

	const file = path.join(dir, 'access', 'home-assistant-token.json');
	assert.equal(existsSync(file), true);
	const saved = readFileSync(file, 'utf8');
	assert.ok(!saved.includes(created.token));
	const store = createHomeAssistantTokens(path.join(dir, 'access'));
	assert.equal(store.verify(created.token), true);

	const status = await (await f.req('home-assistant', undefined, headers)).json();
	assert.equal(status.configured, true);
	assert.equal(Object.hasOwn(status, 'tokenHash'), false);
	assert.equal(JSON.stringify(status).includes(created.token), false);

	response = await f.req('home-assistant', { action: 'rotate' }, headers);
	assert.equal(response.status, 200);
	const rotated = await response.json();
	assert.notEqual(rotated.token, created.token);
	assert.equal(store.verify(created.token), false);
	assert.equal(store.verify(rotated.token), true);

	// A fresh setup process reads the same shared access directory.
	const restarted = await fixture(t, dir);
	const relogin = await restarted.login();
	assert.equal(relogin.status, 200);
	const restartedHeaders = { Cookie: relogin.headers.get('set-cookie').split(';')[0] };
	const afterRestart = await (await restarted.req('home-assistant', undefined, restartedHeaders)).json();
	assert.equal(afterRestart.configured, true);
	assert.equal(afterRestart.rotatedAt, rotated.rotatedAt);
	assert.equal(store.verify(rotated.token), true);

	response = await f.req('home-assistant', { action: 'revoke' }, headers);
	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), { revoked: true, configured: false });
	assert.equal(existsSync(file), false);
	assert.equal(store.verify(rotated.token), false);
	assert.deepEqual(await (await f.req('home-assistant', undefined, headers)).json(), { configured: false });
});
