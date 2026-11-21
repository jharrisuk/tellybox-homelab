import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { createActivity } from '../activity.mjs';
import { installAuth } from '../auth.mjs';
import { installAdminPush, notification, notificationTypes, wantsNotification } from '../admin-push.mjs';
import { createHomeAssistantTokens } from '../home-assistant.mjs';
import { createRefreshAlertTokens, installRefreshAlert, refreshAlertPayload, ALERT_PATH, ALERT_TYPE } from '../refresh-alert.mjs';
import { createSetup } from '../homelab/admin.mjs';

function directory(t) {
	const dir = mkdtempSync(path.join(tmpdir(), 'tellybox-refresh-alert-'));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}
async function listen(t, app, host = '127.0.0.1') {
	const server = await new Promise(resolve => { const value = app.listen(0, host, () => resolve(value)); });
	t.after(() => { server.closeAllConnections(); server.close(); });
	return server;
}
const payload = overrides => ({ title: 'Nightly refresh complete', message: 'Snapshot refreshed from source.', result: 'success', run_id: '8a1c2f6e-3b4d-4f50-9a1b-2c3d4e5f6a7b', source: 'td136-refresh', ...overrides });
const post = (base, body, headers = {}) => fetch(base + ALERT_PATH, {
	method: 'POST', redirect: 'manual',
	headers: { 'Content-Type': 'application/json', ...headers },
	body: typeof body === 'string' ? body : JSON.stringify(body)
});
const alerts = activity => activity.snapshot().recent.filter(event => event.type === ALERT_TYPE);

test('refresh alert tokens are separate from Home Assistant tokens, hashed at rest and rotatable', t => {
	const dir = directory(t), store = createRefreshAlertTokens(dir);
	assert.deepEqual(store.status(), { configured: false });
	assert.equal(store.verify('0'.repeat(64)), false);
	const created = store.create();
	assert.match(created.token, /^[a-f0-9]{64}$/);
	assert.equal(store.status().configured, true);
	assert.equal(store.verify(created.token), true);
	assert.equal(store.verify(created.token.toUpperCase()), false);
	assert.throws(() => store.create(), { status: 409 });
	const saved = readFileSync(path.join(dir, 'refresh-alert-token.json'), 'utf8');
	assert.ok(!saved.includes(created.token));
	assert.match(JSON.parse(saved).tokenHash, /^[a-f0-9]{64}$/);
	const reopened = createRefreshAlertTokens(dir);
	assert.equal(reopened.verify(created.token), true);
	const rotated = reopened.rotate();
	assert.notEqual(rotated.token, created.token);
	assert.equal(reopened.verify(created.token), false);
	assert.equal(reopened.verify(rotated.token), true);
	assert.deepEqual(createRefreshAlertTokens(dir).revoke(), { revoked: true, configured: false });
	assert.equal(createRefreshAlertTokens(dir).verify(rotated.token), false);
	// The two credentials never share a file or a verification path.
	const ha = createHomeAssistantTokens(dir).create();
	assert.equal(store.verify(ha.token), false);
	assert.equal(createHomeAssistantTokens(dir).verify(rotated.token), false);
	assert.equal(existsSync(path.join(dir, 'home-assistant-token.json')), true);
});

test('only the installation administrator can create, rotate or revoke the ingest credential', async t => {
	const dir = directory(t), setup = createSetup({ directory: dir, apply: async () => {} });
	const server = setup.app.listen(0, '127.0.0.1');
	await new Promise(resolve => server.once('listening', resolve));
	t.after(() => { server.closeAllConnections(); server.close(); });
	const base = 'http://127.0.0.1:' + server.address().port;
	const req = (route, body, headers = {}) => fetch(base + '/api/setup/' + route, {
		method: body === undefined ? 'GET' : 'POST',
		headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json', Origin: base }), ...headers },
		body: body === undefined ? undefined : JSON.stringify(body)
	});
	assert.equal((await req('refresh-alert')).status, 401);
	assert.equal((await req('refresh-alert', { action: 'create' })).status, 401);
	const bootstrap = JSON.parse(readFileSync(path.join(dir, 'bootstrap.json'), 'utf8')).token;
	const claimed = await req('login', { bootstrap, password: 'test-only-password-1234' });
	assert.equal(claimed.status, 200);
	const headers = { Cookie: claimed.headers.get('set-cookie').split(';')[0] };
	assert.deepEqual(await (await req('refresh-alert', undefined, headers)).json(), { configured: false });
	assert.equal((await req('refresh-alert', { action: 'create' }, { ...headers, Origin: 'https://evil.example' })).status, 403);
	assert.equal((await req('refresh-alert', { action: 'unknown' }, headers)).status, 400);
	const created = await (await req('refresh-alert', { action: 'create' }, headers)).json();
	assert.match(created.token, /^[a-f0-9]{64}$/);
	assert.equal(Object.hasOwn(created, 'tokenHash'), false);
	assert.equal((await req('refresh-alert', { action: 'create' }, headers)).status, 409);
	const file = path.join(dir, 'access', 'refresh-alert-token.json');
	assert.equal(existsSync(file), true);
	assert.ok(!readFileSync(file, 'utf8').includes(created.token));
	assert.equal(existsSync(path.join(dir, 'access', 'home-assistant-token.json')), false);
	const rotated = await (await req('refresh-alert', { action: 'rotate' }, headers)).json();
	assert.notEqual(rotated.token, created.token);
	assert.equal(createRefreshAlertTokens(path.join(dir, 'access')).verify(created.token), false);
	assert.equal(createRefreshAlertTokens(path.join(dir, 'access')).verify(rotated.token), true);
	assert.deepEqual(await (await req('refresh-alert', { action: 'revoke' }, headers)).json(), { revoked: true, configured: false });
	assert.equal(createRefreshAlertTokens(path.join(dir, 'access')).verify(rotated.token), false);
});

async function routeFixture(t, { push = false } = {}) {
	const dir = directory(t), tokens = createRefreshAlertTokens(dir), created = tokens.create();
	const activity = createActivity(dir);
	const app = express();
	app.disable('x-powered-by');
	// Same order as server.mjs: the ingest route owns its body limit before the
	// ordinary parser, and the admin push path is installed afterwards.
	installRefreshAlert(app, { tokens, record: (...args) => activity.record(...args) });
	app.use(express.json());
	let role = 'admin', sends = 0;
	let deliveredResolve;
	const delivered = new Promise(resolve => { deliveredResolve = resolve; });
	if (push) {
		const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
		writeFileSync(path.join(dir, 'firebase-client.json'), JSON.stringify({ projectId: 'fixture-project', applicationId: 'fixture-app', apiKey: 'fixture-public-key', senderId: '123456' }));
		writeFileSync(path.join(dir, 'firebase-service-account.json'), JSON.stringify({ project_id: 'fixture-project', client_email: 'fixture@fixture-project.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) }));
		installAdminPush(app, {
			directory: dir, admin: (req, res, next) => next(), writeCheck: (req, res, next) => next(),
			record: () => ({ id: 'fixture-device', role }), devices: () => [{ id: 'fixture-device', role }],
			audit: activity,
			fetcher: async (url, options) => {
				if (url.includes('oauth2.googleapis.com')) return Response.json({ access_token: 'fixture-token', expires_in: 3600 });
				sends++;
				deliveredResolve(JSON.parse(options.body));
				return Response.json({ name: 'fixture-message' });
			}
		});
	}
	const server = await listen(t, app);
	return { dir, tokens, created, activity, base: 'http://127.0.0.1:' + server.address().port, sends: () => sends, delivered };
}

test('a valid ingest token creates exactly one admin alert and wakes the existing push path', async t => {
	const f = await routeFixture(t, { push: true });
	const registered = await fetch(f.base + '/api/apps/push/register', {
		method: 'POST', headers: { 'Content-Type': 'application/json' },
		// Exactly what current app builds register: the five legacy types.
		body: JSON.stringify({ token: 'fixture-device-token-not-real', types: ['app_requested', 'person_requested', 'media_request', 'login_success', 'watch_started'] })
	});
	assert.equal(registered.status, 200);
	const response = await post(f.base, payload({ title: '  <b>Nightly</b>\u0000refresh  ', message: 'Done\n<b>all</b> good\u0007' }), { Authorization: 'Bearer ' + f.created.token });
	assert.equal(response.status, 202);
	assert.equal(response.headers.get('cache-control'), 'no-store');
	assert.deepEqual(await response.json(), { accepted: true });
	const created = alerts(f.activity);
	assert.equal(created.length, 1);
	assert.equal(created[0].type, 'refresh_alert');
	assert.equal(created[0].title, 'bNightly/b refresh');
	assert.equal(created[0].message, 'Done ball/b good');
	assert.equal(created[0].runId, payload().run_id);
	assert.equal(created[0].source, 'td136-refresh');
	const message = await f.delivered;
	assert.deepEqual(message.message.data, { eventId: created[0].id });
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(f.sends(), 1);
	assert.deepEqual(notification(created[0]), { id: created[0].id, time: created[0].time, type: 'refresh_alert', title: 'bNightly/b refresh', message: created[0].message });
});

test('the ingest route refuses every credential except its own and exists only as POST', async t => {
	const f = await routeFixture(t);
	const valid = { Authorization: 'Bearer ' + f.created.token };
	assert.equal((await fetch(f.base + ALERT_PATH, { method: 'GET', headers: valid })).status, 405);
	const get = await fetch(f.base + ALERT_PATH, { method: 'GET' });
	assert.equal(get.status, 405);
	assert.equal(get.headers.get('allow'), 'POST');
	assert.equal((await post(f.base, payload(), {})).status, 401);
	assert.equal((await post(f.base, payload(), { Authorization: 'Bearer ' + '0'.repeat(64) })).status, 401);
	const ha = createHomeAssistantTokens(f.dir).create();
	assert.equal((await post(f.base, payload(), { Authorization: 'Bearer ' + ha.token })).status, 401);
	// A cookie or an app/session token is never inspected by this route.
	assert.equal((await post(f.base, payload(), { Cookie: 'jserver_session=' + 'a'.repeat(64) })).status, 401);
	assert.equal((await post(f.base, payload(), { Authorization: 'Bearer ' + 'a'.repeat(64), Cookie: 'tellybox_setup=' + 'b'.repeat(64) })).status, 401);
	assert.equal((await fetch(f.base + ALERT_PATH + '?token=' + f.created.token, {
		method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload())
	})).status, 401);
	assert.equal(alerts(f.activity).length, 0);
	assert.equal((await post(f.base, payload(), valid)).status, 202);
	const rotated = f.tokens.rotate();
	assert.equal((await post(f.base, payload(), valid)).status, 401);
	assert.equal((await post(f.base, payload(), { Authorization: 'Bearer ' + rotated.token })).status, 202);
	assert.equal(alerts(f.activity).length, 2);
	f.tokens.revoke();
	assert.equal((await post(f.base, payload(), { Authorization: 'Bearer ' + rotated.token })).status, 401);
	assert.equal(alerts(f.activity).length, 2);
});

test('oversize, malformed and unknown-field bodies are refused without creating an alert', async t => {
	const f = await routeFixture(t);
	const valid = { Authorization: 'Bearer ' + f.created.token };
	let response = await post(f.base, { ...payload(), message: 'x'.repeat(5000) }, valid);
	assert.equal(response.status, 413);
	response = await post(f.base, '{"title":', valid);
	assert.equal(response.status, 400);
	response = await post(f.base, payload(), { ...valid, 'Content-Type': 'text/plain' });
	assert.equal(response.status, 400);
	response = await post(f.base, { ...payload(), extra: 'nope' }, valid);
	assert.equal(response.status, 400);
	response = await post(f.base, { ...payload(), title: undefined }, valid);
	assert.equal(response.status, 400);
	response = await post(f.base, payload({ result: 'two words' }), valid);
	assert.equal(response.status, 400);
	assert.equal(alerts(f.activity).length, 0);
});

test('sanitisation bounds every field and removes markup and control characters', () => {
	assert.equal(refreshAlertPayload(payload({ message: 'x'.repeat(400) })).message.length, 300);
	const alert = refreshAlertPayload(payload({
		title: '\u0000'.repeat(300) + 'Refresh' + '<img src=x onerror=alert(1)>',
		message: 'line one\nline two\t\u2028line three <script>alert(1)</script>'
	}));
	assert.equal(alert.title.slice(-1), ')');
	assert.equal(alert.title, 'Refreshimg src=x onerror=alert(1)');
	assert.ok(!/[<>\u0000-\u001f\u007f\u2028\u2029]/.test(alert.message));
	assert.equal(alert.message, 'line one line two line three scriptalert(1)/script');
	assert.equal(refreshAlertPayload({ ...payload(), title: '\u0000' }), null);
	assert.equal(refreshAlertPayload([payload()]), null);
});

test('an approved admin app token and an owner cookie cannot post an alert', async t => {
	const dir = directory(t), tokens = createRefreshAlertTokens(dir), created = tokens.create();
	const activity = createActivity(dir);
	const app = express();
	app.disable('x-powered-by');
	// Same order as server.mjs: ingest route first, viewer/app gate afterwards.
	installRefreshAlert(app, { tokens, record: (...args) => activity.record(...args) });
	app.use(express.json());
	const local = await listen(t, app, '127.0.0.1');
	installAuth(app, { directory: path.join(dir, 'auth'), publicDirectory: path.resolve('public'), localPort: local.address().port, localHosts: ['127.0.0.1'], localNetworks: ['127.0.0.0/8'] });
	const base = 'http://127.0.0.1:' + local.address().port;
	const enrolled = await fetch(base + '/api/apps/enroll', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ name: 'Admin phone' }) });
	assert.equal(enrolled.status, 201);
	const device = await enrolled.json();
	assert.equal((await fetch(base + '/api/apps/' + device.id, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ action: 'role', role: 'admin' }) })).status, 200);
	assert.equal((await post(base, payload(), { Authorization: 'Bearer ' + device.token })).status, 401);
	assert.equal((await post(base, payload(), { Cookie: 'jserver_session=' + 'a'.repeat(64), Origin: base })).status, 401);
	assert.equal((await post(base, payload(), { Authorization: 'Bearer ' + created.token })).status, 202);
});

test('the ingest route is rate limited per credential at twelve a minute', async t => {
	const f = await routeFixture(t);
	const valid = { Authorization: 'Bearer ' + f.created.token };
	for (let i = 0; i < 12; i++) assert.equal((await post(f.base, payload({ run_id: 'run-' + i }), valid)).status, 202);
	const limited = await post(f.base, payload({ run_id: 'run-12' }), valid);
	assert.equal(limited.status, 429);
	assert.ok(Number(limited.headers.get('retry-after')) >= 1);
	assert.equal(alerts(f.activity).length, 12);
	// A rotated credential starts a fresh bucket and the old one stays refused.
	const rotated = f.tokens.rotate();
	assert.equal((await post(f.base, payload({ run_id: 'run-13' }), { Authorization: 'Bearer ' + rotated.token })).status, 202);
	assert.equal(alerts(f.activity).length, 13);
});

test('legacy full subscriptions receive the new installation alert without widening a narrowed one', () => {
	assert.ok(notificationTypes.includes('refresh_alert'));
	assert.equal(wantsNotification({ types: ['app_requested', 'person_requested', 'media_request', 'login_success', 'watch_started'] }, 'refresh_alert'), true);
	assert.equal(wantsNotification({ types: ['refresh_alert'] }, 'refresh_alert'), true);
	assert.equal(wantsNotification({ types: ['watch_started'] }, 'refresh_alert'), false);
	assert.equal(wantsNotification({ types: ['app_requested', 'watch_started'] }, 'refresh_alert'), false);
	assert.equal(wantsNotification({}, 'refresh_alert'), false);
	assert.equal(wantsNotification({ types: ['app_requested', 'person_requested', 'media_request', 'login_success', 'watch_started'] }, 'login_success'), true);
	assert.equal(wantsNotification({ types: ['refresh_alert'] }, 'login_success'), false);
});
