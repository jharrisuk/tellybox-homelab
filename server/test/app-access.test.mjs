import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { installAuth } from '../auth.mjs';
import { createActivity } from '../activity.mjs';

async function fixture(t, homeNetwork) {
	const directory = mkdtempSync(path.join(tmpdir(), 'jserver-apps-'));
	const app = express(); app.use(express.json());
	const local = await new Promise(resolve => { const server = app.listen(0, '127.0.0.1', () => resolve(server)); });
	const remote = await new Promise(resolve => { const server = app.listen(0, '127.0.0.1', () => resolve(server)); });
	t.after(() => { local.closeAllConnections(); remote.closeAllConnections(); local.close(); remote.close(); rmSync(directory, { recursive: true, force: true }); });
	const base = side => `http://127.0.0.1:${(side === 'local' ? local : remote).address().port}`;
	const audit = createActivity(directory);
	let mbps = 50;
	const access = installAuth(app, { directory, audit, homeNetwork, trustedProxies: ['127.0.0.1'], homeTrustedProxy: '127.0.0.1', publicOrigin: 'https://127.0.0.1:' + remote.address().port, serverHealth: async () => ({ host: { cpuPercent: 10 } }), uploadLimit: { status: () => ({ mbps }), set: value => ({ mbps: mbps = value }) }, publicDirectory: path.resolve('public'), localPort: local.address().port, localHosts: ['127.0.0.1'], localNetworks: ['127.0.0.0/8'] });
	app.get('/api/items', (req, res) => res.json({ owner: req.jserverOwner, role: req.jserverApp?.role }));
	app.get('/stream/continuous', (req, res) => res.write('first'));
	const call = (side, route, body, token, extra = {}) => fetch(base(side) + route, { method: body ? 'POST' : 'GET', headers: { ...(body ? { 'Content-Type': 'application/json', Origin: base(side) } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(side === 'remote' ? { 'X-Forwarded-Proto': 'https', Origin: 'https://127.0.0.1:' + remote.address().port } : {}), ...extra }, body: body ? JSON.stringify(body) : undefined });
	return { call, access, directory, audit };
}

const stableHeader = { 'X-Tellybox-Device-Id': '12345678-1234-1234-1234-123456789abc' };
test('recognised home reinstall reuses its ID and favourites, rotates token, and never inherits admin', async t => {
	const { call } = await fixture(t);
	const first = await (await call('local', '/api/apps/enroll', { name: 'TV' }, undefined, stableHeader)).json();
	const favourites = await (await call('local', '/api/favourites', undefined, first.token)).json();
	await call('local', '/api/favourites', { profileId: favourites.own.id, changes: [{ id: 'film1', saved: true, item: { Id: 'film1', Name: 'Film', Type: 'Movie' } }] }, first.token);
	await call('local', `/api/apps/${first.id}`, { action: 'role', role: 'admin' });
	const repeat = await (await call('remote', '/api/apps/enroll', { name: 'Renamed TV' }, first.token, stableHeader)).json();
	assert.equal(repeat.id, first.id); assert.equal(repeat.token, first.token); assert.equal(repeat.role, 'admin');
	assert.equal((await call('remote', '/api/apps/enroll', { name: 'TV' }, undefined, stableHeader)).status, 409);
	const restored = await (await call('local', '/api/apps/enroll', { name: 'TV' }, undefined, stableHeader)).json();
	assert.equal(restored.id, first.id); assert.equal(restored.role, 'viewer'); assert.notEqual(restored.token, first.token);
	assert.equal((await call('remote', '/api/items', undefined, first.token)).status, 401);
	const saved = await (await call('local', '/api/favourites', undefined, restored.token)).json();
	assert.equal(saved.own.id, favourites.own.id); assert.equal(saved.own.items[0].Id, 'film1');
	const list = await (await call('local', '/api/apps')).json(); assert.equal(list.devices.length, 1); assert.equal(list.devices[0].identified, true); assert.ok(list.devices[0].lastSeen);
	assert.ok(!JSON.stringify(list).includes(stableHeader['X-Tellybox-Device-Id']));
});

test('upgrades bind the old authorised record without merging similarly named devices', async t => {
	const { call } = await fixture(t);
	const first = await (await call('local', '/api/apps/enroll', { name: 'Same TV' })).json();
	const second = await (await call('local', '/api/apps/enroll', { name: 'Same TV' })).json();
	await call('local', `/api/apps/${first.id}`, { action: 'role', role: 'admin' });
	const me = await (await call('local', '/api/apps/me', undefined, first.token, stableHeader)).json();
	assert.equal(me.id, first.id); assert.equal(me.identified, true); assert.equal(me.role, 'admin');
	const collision = await (await call('local', '/api/apps/me', undefined, second.token, stableHeader)).json();
	assert.equal(collision.id, second.id); assert.equal(collision.identified, false);
	const restored = await (await call('local', '/api/apps/enroll', { name: 'Same TV' }, undefined, stableHeader)).json();
	assert.equal(restored.id, first.id);
	assert.equal((await (await call('local', '/api/apps')).json()).devices.length, 2);
});

test('revoked and expired identities fail closed even after reinstall and remain tombstones', async t => {
	const { call, directory } = await fixture(t);
	const first = await (await call('local', '/api/apps/enroll', { name: 'TV' }, undefined, stableHeader)).json();
	await call('local', `/api/apps/${first.id}`, { action: 'revoke' });
	assert.equal((await call('local', '/api/apps/enroll', { name: 'TV' }, undefined, stableHeader)).status, 403);
	assert.equal((await call('local', '/api/apps/enroll', { name: 'TV' }, first.token)).status, 403);
	const file = path.join(directory, 'apps.json'), entries = JSON.parse(readFileSync(file, 'utf8'));
	for (const record of Object.values(entries)) record.expires = Date.now() - 1;
	writeFileSync(file, JSON.stringify(entries));
	await call('local', '/api/apps/enroll', { name: 'Other TV' });
	assert.equal((await call('local', '/api/apps/enroll', { name: 'TV' }, undefined, stableHeader)).status, 403);
	assert.equal(Object.values(JSON.parse(readFileSync(file, 'utf8'))).filter(record => record.id === first.id).length, 1);
});

test('invalid identifiers rejected and known UUID alone never authorises remote access', async t => {
	const { call } = await fixture(t);
	assert.equal((await call('local', '/api/apps/enroll', { name: 'TV' }, undefined, { 'X-Tellybox-Device-Id': 'bad' })).status, 400);
	const first = await (await call('remote', '/api/apps/enroll', { name: 'TV' }, undefined, stableHeader)).json();
	assert.equal(first.status, 'pending');
	assert.equal((await call('remote', '/api/items', undefined, undefined, stableHeader)).status, 401);
	assert.equal((await call('remote', '/api/apps/enroll', { name: 'TV' }, undefined, stableHeader)).status, 409);
});

test('home installs auto-approve as viewers, and only admins can approve remote apps or change roles', async t => {
	const { call, access, directory } = await fixture(t);
	const first = await (await call('local', '/api/apps/enroll', { name: 'Owner phone', role: 'admin' })).json();
	assert.equal(first.role, 'viewer'); assert.equal(first.status, 'approved');
	assert.equal((await call('local', '/api/items', undefined, first.token)).status, 200);
	assert.equal((await call('remote', '/api/items', undefined, first.token)).status, 200);
	assert.equal((await call('local', '/api/items', undefined, undefined, { 'X-jServer-App': 'android' })).status, 401);
	assert.equal((await call('remote', '/api/apps', undefined, first.token)).status, 403);
	assert.equal((await call('local', `/api/apps/${first.id}`, { action: 'role', role: 'admin' })).status, 200);
	const owner = await (await call('remote', '/api/items', undefined, first.token)).json();
	assert.equal(owner.role, 'admin'); assert.ok(access.validOwner(owner.owner));
	const second = await (await call('remote', '/api/apps/enroll', { name: 'Guest phone' })).json();
	assert.equal((await call('remote', `/api/apps/${second.id}`, { action: 'approve', role: 'viewer' }, first.token)).status, 200);
	assert.equal((await call('remote', '/api/items', undefined, second.token)).status, 200);
	assert.equal((await call('remote', `/api/apps/${second.id}`, { action: 'role', role: 'admin' }, second.token)).status, 403);
	assert.equal((await call('remote', `/api/apps/${second.id}`, { action: 'role', role: 'admin' }, first.token, { Origin: 'https://evil.test' })).status, 403);
	assert.equal((await call('remote', `/api/apps/${second.id}`, { action: 'role', role: 'admin' }, first.token)).status, 200);
	assert.equal((await call('remote', '/api/apps', undefined, second.token)).status, 200);
	assert.ok(!readFileSync(path.join(directory, 'apps.json'), 'utf8').includes(first.token));
	const listing = await (await call('local', '/api/apps')).text(); assert.ok(!listing.includes(first.token));
});

test('server settings and request notifications require explicit admin access, including on LAN', async t => {
	const { call, audit } = await fixture(t);
	const device = await (await call('local', '/api/apps/enroll', { name: 'Admin phone' })).json();
	for (const route of ['/api/apps', '/api/apps/notifications', '/api/auth/upload-limit', '/api/activity', '/api/auth/server-health']) {
		assert.equal((await call('local', route, undefined, undefined, { 'X-jServer-App': 'android' })).status, 403);
		assert.equal((await call('local', route, undefined, device.token)).status, 403);
		assert.equal((await call('remote', route)).status, 403);
	}
	await call('local', `/api/apps/${device.id}`, { action: 'approve', role: 'viewer' });
	assert.equal((await call('remote', '/api/auth/upload-limit', { mbps: 30 }, device.token)).status, 403);
	assert.equal((await call('local', '/api/auth/server-health', undefined, device.token)).status, 403);
	assert.equal((await call('remote', '/api/auth/server-health', undefined, device.token)).status, 403);
	assert.equal((await call('local', '/api/auth/server-health')).status, 200);
	await call('local', `/api/apps/${device.id}`, { action: 'role', role: 'admin' });
	const health = await call('remote', '/api/auth/server-health', undefined, device.token);
	assert.equal(health.status, 200); assert.equal(health.headers.get('cache-control'), 'no-store');
	assert.equal((await call('remote', '/api/auth/upload-limit', { mbps: 30 }, device.token)).status, 200);
	assert.equal((await (await call('remote', '/api/auth/upload-limit', undefined, device.token)).json()).mbps, 30);
	audit.record('media_request', { ip: 'private-address', browser: 'private-agent' }, { title: 'Example film', mediaId: 123 });
	audit.record('login_failed', { ip: 'private-address' });
	const feed = await (await call('remote', '/api/apps/notifications', undefined, device.token)).json();
	assert.equal(feed.notifications.length, 1);
	assert.ok(feed.notifications.some(event => event.message === 'A guest requested Example film'));
	assert.ok(!JSON.stringify(feed).includes('private-'));
	assert.equal((await call('remote', '/api/apps/notifications?since=bad', undefined, device.token)).status, 400);
	await call('local', `/api/apps/${device.id}`, { action: 'revoke' });
	assert.equal((await call('remote', '/api/apps/notifications', undefined, device.token)).status, 403);
});

test('revoking an app cuts off streams and invalid tokens never fall back to local access', async t => {
	const { call, access } = await fixture(t);
	const device = await (await call('local', '/api/apps/enroll', { name: 'Test phone' })).json();
	await call('local', `/api/apps/${device.id}`, { action: 'approve', role: 'viewer' });
	const { owner } = await (await call('remote', '/api/items', undefined, device.token)).json();
	const stream = await call('remote', '/stream/continuous', undefined, device.token);
	const reader = stream.body.getReader(); await reader.read(); const closed = assert.rejects(reader.read());
	await call('local', `/api/apps/${device.id}`, { action: 'revoke' }); await closed;
	assert.equal(access.validOwner(owner), false);
	assert.equal((await call('local', '/api/items', undefined, device.token)).status, 401);
	assert.equal((await call('local', '/api/items', undefined, 'invalid')).status, 401);
	assert.equal((await call('local', '/api/items')).status, 200);
	assert.equal((await call('local', `/api/apps/${device.id}`, { action: 'approve', role: 'admin' })).status, 409);
});

test('trusted home proxy can approve viewers, remote requests and forged home headers cannot', async t => {
	const { call } = await fixture(t, { matches: ip => ip === '203.0.113.10' });
	const proxy = { 'CF-Connecting-IP': '203.0.113.10' };
	const home = await (await call('remote', '/api/apps/enroll', { name: 'Home TV', role: 'admin' }, undefined, proxy)).json();
	assert.equal(home.status, 'approved'); assert.equal(home.role, 'viewer');
	assert.equal((await call('remote', '/api/apps', undefined, home.token, proxy)).status, 403);
	const away = await (await call('remote', '/api/apps/enroll', { name: 'Away phone' }, undefined, { ...proxy, 'CF-Connecting-IP': '203.0.113.11' })).json();
	assert.equal(away.status, 'pending');
	assert.equal((await call('remote', '/api/items', undefined, away.token)).status, 401);
	const forged = await (await call('local', '/api/apps/enroll', { name: 'Wrong entry point' }, undefined, { Origin: '', 'X-Forwarded-Proto': 'https', 'CF-Connecting-IP': '203.0.113.10' })).json();
	assert.equal(forged.status, 'pending');
	const upgraded = await (await call('local', '/api/apps/me', undefined, away.token)).json();
	assert.equal(upgraded.status, 'approved'); assert.equal(upgraded.role, 'viewer');
	await call('local', '/api/apps/' + away.id, { action: 'revoke' });
	assert.equal((await (await call('local', '/api/apps/me', undefined, away.token)).json()).status, 'revoked');
});

test('expired credentials are not resurrected when a device returns home', async t => {
	const { call, directory } = await fixture(t);
	const device = await (await call('remote', '/api/apps/enroll', { name: 'Old phone' })).json();
	const file = path.join(directory, 'apps.json'), records = JSON.parse(readFileSync(file, 'utf8'));
	for (const record of Object.values(records)) record.expires = Date.now() - 1;
	writeFileSync(file, JSON.stringify(records));
	assert.equal((await (await call('local', '/api/apps/me', undefined, device.token)).json()).status, 'expired');
	assert.equal((await call('local', '/api/items', undefined, device.token)).status, 401);
});
