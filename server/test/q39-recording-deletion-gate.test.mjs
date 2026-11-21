/* Q39 REGRESSION (0.26.50 batch): recording deletion uses the shipped
 * administrator/home predicate, not a bespoke gate.
 *
 * recording-deletion.test.mjs already covers the guard mechanics (same origin,
 * JSON, explicit confirm) and the manager's safety rules with a synthetic
 * `allowed` function. server.mjs wires the real predicate:
 *   allowed: req => auth.isHome(req) || auth.isOwnerAdmin(req)
 * No existing test exercises that composition. This file does, with the real
 * installAuth, the real installRecordingDeletion and the real manager against
 * a fake Jellyfin (after the existing fixture). The structural test pins the
 * wiring in server.mjs.
 *
 * Offline: loopback sockets, a stubbed home-IP relay fetcher, synthetic app
 * tokens and a synthetic installation password.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { installAuth } from '../auth.mjs';
import { createRecordingDeletion, installRecordingDeletion } from '../recording-deletion.mjs';
import { createHomeNetwork } from '../home-network.mjs';

const publicDirectory = fileURLToPath(new URL('../public', import.meta.url));
const HOME_IP = '203.0.113.9';
const OWNER_PASSWORD = 'synthetic-q39-deletion-password';
const id = 'a'.repeat(32), root = 'b'.repeat(32);

/* The existing recording-deletion fixture: a fake Jellyfin with one deletable
 * filesystem recording inside the Recordings library. */
function managerFixture() {
	const calls = [];
	const state = { busy: false, timers: [], item: { Id: id, Name: 'Saved show', Type: 'Movie', LocationType: 'FileSystem', CanDelete: true, Path: '/recordings/show.ts' } };
	const jelly = async (route, options = {}) => {
		calls.push([route, options]);
		if (options.method === 'DELETE') return null;
		if (route.endsWith('/Views')) return { Items: [{ Id: root, Name: 'Recordings' }] };
		if (route.includes('/Ancestors')) return [{ Id: root }];
		if (route === '/LiveTv/Timers') return { Items: state.timers };
		if (route.startsWith('/Items?')) return { Items: [state.item], TotalRecordCount: 1 };
		return state.item;
	};
	const manager = createRecordingDeletion({
		jelly, userId: () => id, busy: () => state.busy,
		recordings: { item: async () => null, remove: async () => {} },
		invalidated: () => calls.push(['invalidated'])
	});
	return { manager, calls, state };
}

async function fixture(t) {
	const directory = mkdtempSync(path.join(tmpdir(), 'tellybox-q39-deletion-'));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const app = express();
	app.use(express.json());
	const local = app.listen(0, '127.0.0.1');
	const remote = app.listen(0, '127.0.0.1');
	await Promise.all([once(local, 'listening'), once(remote, 'listening')]);
	t.after(() => {
		local.closeAllConnections?.(); remote.closeAllConnections?.();
		local.close(); remote.close();
	});
	const homeNetwork = createHomeNetwork('https://relay.example.test/relay-client-ip', {
		fetcher: async () => new Response(HOME_IP)
	});
	await homeNetwork.refresh();
	const auth = installAuth(app, {
		directory, publicDirectory,
		localPort: local.address().port,
		localHosts: ['127.0.0.1'], localNetworks: ['127.0.0.0/8'],
		publicOrigin: 'https://remote.test',
		trustedProxies: ['127.0.0.1'], homeTrustedProxy: '127.0.0.1', homeNetwork,
		setupPort: 8990
	});
	const { manager, calls } = managerFixture();
	const events = [];
	// The production composition from server.mjs, mirrored here and pinned by
	// the structural test below.
	installRecordingDeletion(app, {
		manager,
		allowed: req => auth.isHome(req) || auth.isOwnerAdmin(req),
		audit: (...event) => events.push(event)
	});
	app.use((err, req, res, next) => res.status(err.status || 500).json({ error: err.message }));
	const port = side => (side === 'local' ? local : remote).address().port;
	const base = side => 'http://127.0.0.1:' + port(side);
	const request = (side, route, { method = 'GET', body, cookie, headers = {} } = {}) => fetch(base(side) + route, {
		method, redirect: 'manual',
		headers: {
			...(body === undefined ? {} : { 'Content-Type': 'application/json', Origin: base(side) }),
			...(cookie ? { Cookie: cookie } : {}),
			...headers
		},
		body: body === undefined ? undefined : JSON.stringify(body)
	});
	const rawGet = (route, headers = {}) => new Promise((resolve, reject) => {
		const req = http.request({ host: '127.0.0.1', port: port('remote'), path: route, method: 'GET', headers }, response => {
			const chunks = [];
			response.on('data', chunk => chunks.push(chunk));
			response.on('end', () => resolve({ status: response.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
		});
		req.on('error', reject);
		req.end();
	});
	const rawPost = (route, { headers = {}, body }) => new Promise((resolve, reject) => {
		const data = JSON.stringify(body);
		const req = http.request({
			host: '127.0.0.1', port: port('remote'), path: route, method: 'POST',
			headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...headers }
		}, response => {
			const chunks = [];
			response.on('data', chunk => chunks.push(chunk));
			response.on('end', () => resolve({ status: response.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
		});
		req.on('error', reject);
		req.end(data);
	});
	return { request, rawGet, rawPost, base, calls, events };
}

const inspectRoute = '/api/recording-files/' + id;
const deleteRoute = inspectRoute + '/delete';

async function enroll(request, name, role) {
	const enrolled = await request('local', '/api/apps/enroll', { method: 'POST', body: { name } });
	assert.ok([200, 201].includes(enrolled.status));
	const device = await enrolled.json();
	if (role === 'admin') {
		assert.equal((await request('local', '/api/apps/' + device.id, { method: 'POST', body: { action: 'role', role: 'admin' } })).status, 200);
	}
	return device;
}

async function assertDeletionWorks(request, { cookie, headers = {} }, calls, events) {
	const before = calls.length;
	const inspect = await request('remote', inspectRoute, { cookie, headers });
	assert.equal(inspect.status, 200, 'the caller may inspect the recording');
	assert.equal((await inspect.json()).CanDelete, true);
	const deleted = await request('remote', deleteRoute, { method: 'POST', body: { confirm: true }, cookie, headers });
	assert.equal(deleted.status, 200, 'the caller may delete the recording');
	assert.deepEqual(await deleted.json(), { ok: true });
	assert.equal(calls.filter(call => call[1]?.method === 'DELETE').length, 1, 'exactly one upstream deletion');
	assert.equal(events.at(-1)[0], 'recording_deleted', 'the deletion is audited');
	assert.ok(calls.length > before);
}

test('an anonymous remote caller cannot inspect or delete, and no upstream call is made', async t => {
	const { request, calls } = await fixture(t);
	assert.equal((await request('remote', inspectRoute)).status, 401);
	assert.equal((await request('remote', deleteRoute, { method: 'POST', body: { confirm: true } })).status, 401);
	// Spoofed forwarding headers never create local/home authority.
	for (const headers of [{ 'X-Forwarded-For': '127.0.0.1' }, { 'CF-Connecting-IP': HOME_IP }]) {
		assert.equal((await request('remote', inspectRoute, { headers })).status, 401);
		assert.equal((await request('remote', deleteRoute, { method: 'POST', body: { confirm: true }, headers })).status, 401);
	}
	assert.equal(calls.length, 0, 'a refused caller never reaches Jellyfin');
});

test('a local caller may inspect and delete', async t => {
	const { request, calls, events } = await fixture(t);
	const inspect = await request('local', inspectRoute);
	assert.equal(inspect.status, 200);
	assert.equal((await inspect.json()).CanDelete, true);
	const deleted = await request('local', deleteRoute, { method: 'POST', body: { confirm: true } });
	assert.equal(deleted.status, 200);
	assert.equal(calls.filter(call => call[1]?.method === 'DELETE').length, 1);
	assert.equal(events.at(-1)[0], 'recording_deleted');
});

test('an approved admin app may inspect and delete remotely; a viewer app may not', async t => {
	const { request, calls, events } = await fixture(t);
	const viewer = await enroll(request, 'Q39 deletion viewer', 'viewer');
	const viewerHeaders = { Authorization: 'Bearer ' + viewer.token };
	assert.equal((await request('remote', inspectRoute, { headers: viewerHeaders })).status, 403);
	assert.equal((await request('remote', deleteRoute, { method: 'POST', body: { confirm: true }, headers: viewerHeaders })).status, 403);
	assert.equal(calls.length, 0, 'a refused viewer app never reaches Jellyfin');
	const admin = await enroll(request, 'Q39 deletion admin', 'admin');
	await assertDeletionWorks(request, { headers: { Authorization: 'Bearer ' + admin.token } }, calls, events);
});

test('an installation-password session may inspect and delete remotely', async t => {
	const { request, calls, events } = await fixture(t);
	assert.equal((await request('local', '/api/auth/password', { method: 'POST', body: { password: OWNER_PASSWORD } })).status, 200);
	const login = await request('remote', '/api/auth/login', { method: 'POST', body: { password: OWNER_PASSWORD } });
	assert.equal(login.status, 200);
	await assertDeletionWorks(request, { cookie: login.headers.get('set-cookie').split(';')[0] }, calls, events);
});

test('a trusted home viewer may inspect and delete (the shipped at-home branch)', async t => {
	const { rawGet, rawPost, calls, events } = await fixture(t);
	const homeHeaders = { Host: 'remote.test', 'X-Forwarded-Proto': 'https', 'CF-Connecting-IP': HOME_IP };
	// Prove the classifier says home:true, local:false for this socket first,
	// so the allow below is the home branch and not local access.
	const status = await rawGet('/api/auth/status', homeHeaders);
	assert.equal(status.status, 200);
	const state = JSON.parse(status.text);
	assert.equal(state.home, true);
	assert.equal(state.local, false);
	assert.equal(state.admin, false, 'a home viewer is not an administrator, but deletion is allowed at home');
	const inspect = await rawGet(inspectRoute, homeHeaders);
	assert.equal(inspect.status, 200);
	assert.equal(JSON.parse(inspect.text).CanDelete, true);
	const deleted = await rawPost(deleteRoute, { headers: { ...homeHeaders, Origin: 'https://remote.test' }, body: { confirm: true } });
	assert.equal(deleted.status, 200);
	assert.equal(calls.filter(call => call[1]?.method === 'DELETE').length, 1);
	assert.equal(events.at(-1)[0], 'recording_deleted');
});

test('server.mjs wires recording deletion to the shipped home/administrator predicate', () => {
	const source = readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
	assert.match(source, /installRecordingDeletion\(app,\{manager:recordingDeletion,allowed:req=>auth\.isHome\(req\)\|\|auth\.isOwnerAdmin\(req\),audit:activity\.record\}\);/,
		'recording deletion keeps the isHome || isOwnerAdmin composition and the activity audit');
});
