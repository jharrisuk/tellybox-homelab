import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import { installAuth } from '../auth.mjs';
import {
	createHomeAssistantIntegration, createHomeAssistantTokens, createInstallationIdentity,
	installHomeAssistantStats, STATS_PATH, STATS_SCHEMA, STATS_VERSION
} from '../home-assistant.mjs';

const directory = t => { const value = mkdtempSync(path.join(tmpdir(), 'tellybox-home-assistant-')); t.after(() => rmSync(value, { recursive: true, force: true })); return value; };
const listen = async (t, app, host = '127.0.0.1') => {
	const server = await new Promise(resolve => { const value = app.listen(0, host, () => resolve(value)); });
	t.after(() => { server.closeAllConnections(); server.close(); });
	return server;
};
const fakeHealth = overrides => ({
	host: { stale: false, sampledAt: 1000, cpuPercent: 0, uptimeSeconds: 900, memory: { total: 100, available: 40 }, disks: [
		{ id: 'disk-a', label: 'Media', available: true, total: 1000, used: 500, free: 500 },
		{ id: 'disk-b', label: 'Backups', available: false, total: 2000, used: 1500, free: null }
	] },
	service: { uptimeSeconds: 123.4 }, ...overrides
});
const fakeActivity = () => ({
	active: [
		{ id: 'one', state: 'playing', local: false, mediaRoute: 'local', purpose: 'playback', title: 'Private title', ip: '192.0.2.10', email: 'private@example.test' },
		{ id: 'two', state: 'paused', local: true, mediaRoute: 'remote', purpose: 'playback', title: 'Another private title' }
	],
	downloads: [{ title: 'Private download' }],
	stats: { active: 2, downloads: 1 }
});
const fakeUpload = () => ({ mbps: 50, measuredMbps: 12.34, measurementSeconds: 10 });

test('Home Assistant tokens are high entropy, stored only as a hash, persistent and revocable', t => {
	const dir = directory(t), store = createHomeAssistantTokens(dir);
	assert.deepEqual(store.status(), { configured: false });
	const created = store.create();
	assert.match(created.token, /^[a-f0-9]{64}$/);
	assert.equal(created.configured, true);
	assert.equal(store.verify(created.token), true);
	assert.equal(store.verify(created.token.toUpperCase()), false);
	assert.equal(store.verify('0'.repeat(64)), false);
	assert.throws(() => store.create(), { status: 409 });
	const saved = readFileSync(path.join(dir, 'home-assistant-token.json'), 'utf8');
	assert.ok(!saved.includes(created.token));
	assert.match(JSON.parse(saved).tokenHash, /^[a-f0-9]{64}$/);
	const reopened = createHomeAssistantTokens(dir);
	assert.equal(reopened.verify(created.token), true);
	const rotated = reopened.rotate();
	assert.equal(reopened.verify(created.token), false);
	assert.equal(reopened.verify(rotated.token), true);
	assert.notEqual(rotated.token, created.token);
	assert.ok(rotated.rotatedAt >= rotated.createdAt);
	assert.deepEqual(createHomeAssistantTokens(dir).revoke(), { revoked: true, configured: false });
	assert.equal(createHomeAssistantTokens(dir).verify(rotated.token), false);
	assert.deepEqual(createHomeAssistantTokens(dir).revoke(), { revoked: false, configured: false });
});

test('a partially corrupted token record fails closed for both status and verification', t => {
	const dir = directory(t), store = createHomeAssistantTokens(dir), created = store.create();
	const file = path.join(dir, 'home-assistant-token.json'), record = JSON.parse(readFileSync(file, 'utf8'));
	delete record.id;
	writeFileSync(file, JSON.stringify(record));
	const reopened = createHomeAssistantTokens(dir);
	assert.deepEqual(reopened.status(), { configured: false });
	assert.equal(reopened.verify(created.token), false);
});

test('installation identity survives restarts and stays separate from token rotation', t => {
	const dir = directory(t);
	const first = createInstallationIdentity(dir), second = createInstallationIdentity(dir);
	assert.equal(first.id, second.id);
	assert.match(first.id, /^[a-f0-9-]{36}$/);
	const store = createHomeAssistantTokens(dir), created = store.create();
	assert.equal(createInstallationIdentity(dir).id, first.id);
	store.rotate();
	assert.equal(store.verify(created.token), false);
	assert.equal(createInstallationIdentity(dir).id, first.id);
});

test('aggregate stats keep real zero distinct from missing or stale readings and never include titles or identities', async t => {
	const dir = directory(t);
	const integration = createHomeAssistantIntegration({
		directory: dir, activity: { snapshot: fakeActivity }, serverHealth: async () => fakeHealth(),
		uploadLimit: { status: fakeUpload }, version: '1.2.3', clock: () => 5000
	});
	const stats = await integration.stats();
	assert.equal(stats.schema, STATS_SCHEMA);
	assert.equal(stats.schemaVersion, STATS_VERSION);
	assert.equal(stats.generatedAt, 5000);
	assert.match(stats.installationId, /^[a-f0-9-]{36}$/);
	assert.equal(stats.server.version, '1.2.3');
	assert.equal(stats.server.hostStatus, 'ok');
	assert.equal(stats.server.cpuPercent, 0);
	assert.equal(stats.server.memoryPercent, 60);
	assert.equal(stats.server.uptimeSeconds, 123.4);
	assert.equal(stats.server.hostUptimeSeconds, 900);
	assert.deepEqual(stats.streams, { active: 1, connected: 2, paused: 1, local: 1, remote: 1 });
	assert.deepEqual(stats.downloads, { active: 1 });
	assert.deepEqual(stats.upload, { configuredMbps: 50, unlimited: false, measuredMbps: 12.34, measurementSeconds: 10 });
	assert.equal(stats.server.disks[0].id, 'disk-a');
	assert.equal(stats.server.disks[0].availableBytes, 500);
	assert.equal(stats.server.disks[1].availableBytes, null);
	const text = JSON.stringify(stats);
	for (const value of ['Private title', 'Another private title', 'private@example.test', '192.0.2.10', 'Private download', '/private/path', 'provider.example.test']) assert.ok(!text.includes(value), value);
});

test('stale and missing host samples make host metrics unavailable instead of reporting zero', async t => {
	const dir = directory(t);
	const stale = createHomeAssistantIntegration({
		directory: dir, activity: { snapshot: () => ({ active: [], downloads: [] }) },
		serverHealth: async () => fakeHealth({ host: { ...fakeHealth().host, stale: true, cpuPercent: 0 } }),
		uploadLimit: { status: fakeUpload }, version: '1.2.3'
	});
	let stats = await stale.stats();
	assert.equal(stats.server.hostStatus, 'stale');
	for (const key of ['cpuPercent', 'memoryPercent', 'hostUptimeSeconds', 'memoryTotalBytes', 'memoryAvailableBytes']) assert.equal(stats.server[key], null, key);
	assert.equal(stats.server.disks[0].availableBytes, null);
	assert.equal(stats.server.uptimeSeconds, 123.4);
	const missing = createHomeAssistantIntegration({
		directory: dir, activity: { snapshot: () => ({ active: [], downloads: [] }) },
		serverHealth: async () => ({ host: null, service: { uptimeSeconds: 1 } }),
		uploadLimit: { status: fakeUpload }, version: '1.2.3'
	});
	stats = await missing.stats();
	assert.equal(stats.server.hostStatus, 'missing');
	assert.equal(stats.server.cpuPercent, null);
	assert.equal(stats.server.memoryPercent, null);
	assert.deepEqual(stats.server.disks, []);
	assert.equal(stats.streams.active, 0);
});

test('downloads count current work only and ignore completed or failed entries', async t => {
	const integration = createHomeAssistantIntegration({
		directory: directory(t), activity: { snapshot: () => ({ active: [], downloads: [{ state: 'downloading' }, { state: 'ended' }, { state: 'failed' }] }) },
		serverHealth: async () => fakeHealth(), uploadLimit: { status: fakeUpload }, version: '1.2.3'
	});
	assert.deepEqual((await integration.stats()).downloads, { active: 1 });
});

test('missing activity arrays stay unavailable instead of becoming fabricated zero counts', async t => {
	const integration = createHomeAssistantIntegration({
		directory: directory(t), activity: { snapshot: () => ({}) },
		serverHealth: async () => fakeHealth(), uploadLimit: { status: fakeUpload }, version: '1.2.3'
	});
	const stats = await integration.stats();
	assert.deepEqual(stats.streams, { active: null, connected: null, paused: null, local: null, remote: null });
	assert.deepEqual(stats.downloads, { active: null });
});

async function fixture(t, { token = true, stats } = {}) {
	const dir = directory(t), store = createHomeAssistantTokens(dir), created = token ? store.create() : null;
	const integration = { tokens: store, stats: stats || (async () => createHomeAssistantIntegration({
		directory: dir, activity: { snapshot: fakeActivity }, serverHealth: async () => fakeHealth(),
		uploadLimit: { status: fakeUpload }, version: '1.2.3'
	}).stats()) };
	const app = express();
	app.use(express.json());
	// Register before the viewer gate, as the real server does.
	installHomeAssistantStats(app, { integration });
	const local = await listen(t, app, '127.0.0.1');
	const remote = await listen(t, app, '127.0.0.2');
	const authDir = path.join(dir, 'auth');
	installAuth(app, { directory: authDir, publicDirectory: path.resolve('public'), localPort: local.address().port, localHosts: ['127.0.0.1'], localNetworks: ['127.0.0.0/8'] });
	app.get('/after-gate', (req, res) => res.json({ ok: true }));
	const base = side => `http://${side === 'local' ? '127.0.0.1' : '127.0.0.2'}:${(side === 'local' ? local : remote).address().port}`;
	const call = (side, route, { token: bearer, method, headers = {}, body } = {}) => fetch(base(side) + route, {
		method: method || (body === undefined ? 'GET' : 'POST'), redirect: 'manual',
		headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json', Origin: base(side) }), ...(bearer === undefined ? {} : { Authorization: 'Bearer ' + bearer }), ...headers },
		body: body === undefined ? undefined : JSON.stringify(body)
	});
	return { dir, store, created, integration, base, call };
}

test('stats endpoint requires only the dedicated bearer token, before the viewer gate', async t => {
	const f = await fixture(t);
	let response = await f.call('local', STATS_PATH);
	assert.equal(response.status, 401);
	response = await f.call('remote', STATS_PATH);
	assert.equal(response.status, 401);
	assert.equal((await f.call('remote', STATS_PATH, { token: '0'.repeat(64) })).status, 401);
	assert.equal((await f.call('remote', STATS_PATH, { headers: { Cookie: 'jserver_session=' + 'a'.repeat(64) } })).status, 401);
	assert.equal((await f.call('remote', STATS_PATH, { headers: { Authorization: 'Basic dGVzdDp0ZXN0' } })).status, 401);
	response = await f.call('remote', STATS_PATH + '?token=' + f.created.token);
	assert.equal(response.status, 401);
	assert.equal((await f.call('remote', STATS_PATH, { token: f.created.token, headers: { Authorization: 'Bearer ' + 'a'.repeat(200) } })).status, 401);

	const enrolled = await f.call('local', '/api/apps/enroll', { body: { name: 'Living room TV' } });
	assert.equal(enrolled.status, 201);
	const device = await enrolled.json();
	assert.equal((await f.call('local', '/api/apps/' + device.id, { body: { action: 'role', role: 'admin' } })).status, 200);
	assert.equal((await f.call('local', STATS_PATH, { token: device.token })).status, 401);
	assert.equal((await f.call('remote', STATS_PATH, { token: device.token })).status, 401);

	response = await f.call('remote', STATS_PATH, { token: f.created.token, headers: { Origin: 'https://evil.example' } });
	assert.equal(response.status, 200);
	assert.equal(response.headers.get('cache-control'), 'no-store');
	assert.equal(response.headers.get('vary'), 'Authorization');
	assert.equal(response.headers.get('access-control-allow-origin'), null);
	const stats = await response.json();
	assert.equal(stats.schema, STATS_SCHEMA);
	assert.equal(stats.installationId, (await f.integration.stats()).installationId);
});

test('stats endpoint is GET only and a token cannot unlock the ordinary viewer routes', async t => {
	const f = await fixture(t);
	const post = await f.call('local', STATS_PATH, { token: f.created.token, method: 'POST', body: { anything: true } });
	assert.equal(post.status, 405);
	assert.equal(post.headers.get('allow'), 'GET');
	assert.equal((await f.call('remote', '/after-gate')).status, 401);
	assert.equal((await f.call('remote', '/after-gate', { token: f.created.token })).status, 401);
});

test('fresh installations stay disabled and a failing collector returns a generic 503', async t => {
	const fresh = await fixture(t, { token: false });
	assert.equal((await fresh.call('local', STATS_PATH)).status, 401);
	assert.equal(fresh.store.status().configured, false);

	const failing = await fixture(t, { stats: async () => { throw Error('private provider detail'); } });
	const response = await failing.call('local', STATS_PATH, { token: failing.created.token });
	assert.equal(response.status, 503);
	assert.deepEqual(await response.json(), { error: 'Tellybox statistics are temporarily unavailable.' });
});

test('disk labels do not expose paths and unknown media routes are not guessed from viewer locality', async t => {
	const health=fakeHealth();health.host.disks[0].label='/private/path';
	const activity=fakeActivity();delete activity.active[0].mediaRoute;delete activity.active[1].mediaRoute;
	const integration=createHomeAssistantIntegration({directory:directory(t),activity:{snapshot:()=>activity},serverHealth:async()=>health,uploadLimit:{status:fakeUpload},version:'1.2.3'});
	const stats=await integration.stats();
	assert.equal(stats.streams.local,0);assert.equal(stats.streams.remote,0);
	assert.equal(stats.server.disks[0].name,'Disk');
	assert.ok(!JSON.stringify(stats).includes('/private/path'));
});
