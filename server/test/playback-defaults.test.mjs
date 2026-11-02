import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import { installAuth } from '../auth.mjs';
import { createActivity } from '../activity.mjs';
import { createPlaybackDefaults } from '../playback-defaults.mjs';

const defaults = { englishSubtitles: false, autoNext: false, skipIntros: false };

test('a failed disk write keeps the previous effective defaults', t => {
	const directory = mkdtempSync(path.join(tmpdir(), 'tellybox-playback-write-'));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const store = createPlaybackDefaults(directory);
	store.set({ englishSubtitles: true });
	mkdirSync(path.join(directory, 'playback-defaults.json.tmp'));
	assert.throws(() => store.set({ englishSubtitles: false }));
	assert.equal(store.status().englishSubtitles, true);
	assert.equal(createPlaybackDefaults(directory).status().englishSubtitles, true);
});

test('playback defaults start safely off, persist explicit choices and reject invalid writes', t => {
	const directory = mkdtempSync(path.join(tmpdir(), 'tellybox-playback-defaults-'));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const store = createPlaybackDefaults(directory);
	assert.deepEqual(store.status(), defaults);
	assert.deepEqual(store.set({ englishSubtitles: true, autoNext: false, skipIntros: true }), { englishSubtitles: true, autoNext: false, skipIntros: true });
	assert.deepEqual(JSON.parse(readFileSync(path.join(directory, 'playback-defaults.json'), 'utf8')), { englishSubtitles: true, autoNext: false, skipIntros: true });
	assert.deepEqual(createPlaybackDefaults(directory).status(), { englishSubtitles: true, autoNext: false, skipIntros: true });
	assert.throws(() => store.set({ englishSubtitles: 'true' }), /on or off/);
	assert.throws(() => store.set(null), /each playback default/);
	assert.deepEqual(store.status(), { englishSubtitles: true, autoNext: false, skipIntros: true }, 'a rejected write leaves the saved defaults alone');
});

test('a malformed persisted file fails safely to all defaults off', t => {
	const directory = mkdtempSync(path.join(tmpdir(), 'tellybox-playback-defaults-bad-'));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	writeFileSync(path.join(directory, 'playback-defaults.json'), JSON.stringify({ englishSubtitles: 'yes', autoNext: 1, skipIntros: null }));
	const store = createPlaybackDefaults(directory);
	assert.deepEqual(store.status(), defaults);
});

async function fixture(t, directory, extra = {}) {
	const app = express();
	app.use(express.json());
	const local = await new Promise(resolve => { const server = app.listen(0, '127.0.0.1', () => resolve(server)); });
	const remote = await new Promise(resolve => { const server = app.listen(0, '127.0.0.1', () => resolve(server)); });
	t.after(() => { local.closeAllConnections(); remote.closeAllConnections(); local.close(); remote.close(); });
	const audit = createActivity(directory);
	installAuth(app, {
		directory, publicDirectory: path.resolve('public'), localPort: local.address().port,
		localHosts: ['127.0.0.1'], localNetworks: ['127.0.0.0/8'], audit,
		installationCapabilities: { library: true, live: true, nonstop: true, discover: true },
		...extra
	});
	const base = side => `http://127.0.0.1:${(side === 'local' ? local : remote).address().port}`;
	const request = (side, route, body, cookie, headers = {}) => fetch(base(side) + route, {
		method: body === undefined ? 'GET' : 'POST', redirect: 'manual',
		headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json', Origin: base(side) }), ...(cookie ? { Cookie: cookie } : {}), ...headers },
		body: body === undefined ? undefined : JSON.stringify(body)
	});
	return { request, base };
}

test('viewer capabilities expose only the three defaults while writes require the existing admin boundary', async t => {
	const directory = mkdtempSync(path.join(tmpdir(), 'tellybox-playback-auth-'));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const store = createPlaybackDefaults(directory);
	const { request } = await fixture(t, directory, { playbackDefaults: store });

	let capabilities = await (await request('local', '/api/capabilities')).json();
	assert.deepEqual(capabilities.playbackDefaults, defaults);
	assert.deepEqual(Object.keys(capabilities.playbackDefaults).sort(), ['autoNext', 'englishSubtitles', 'skipIntros']);
	assert.equal(JSON.stringify(capabilities).includes('directory'), false);
	assert.equal((await request('remote', '/api/auth/playback-defaults')).status, 403);
	assert.equal((await request('remote', '/api/auth/playback-defaults', { englishSubtitles: true })).status, 403);
	assert.equal((await request('remote', '/api/capabilities')).status, 401);

	assert.deepEqual(await (await request('local', '/api/auth/playback-defaults')).json(), defaults);
	assert.deepEqual(await (await request('local', '/api/auth/playback-defaults', { englishSubtitles: true, autoNext: false, skipIntros: true })).json(), { englishSubtitles: true, autoNext: false, skipIntros: true });
	capabilities = await (await request('local', '/api/capabilities')).json();
	assert.deepEqual(capabilities.playbackDefaults, { englishSubtitles: true, autoNext: false, skipIntros: true });
	assert.deepEqual(capabilities.live, true, 'live remains available and unchanged');
	assert.deepEqual(capabilities.nonstop, true, '24/7 remains available and unchanged');

	const viewer = await (await request('local', '/api/apps/enroll', { name: 'Viewer phone' })).json();
	assert.equal((await request('remote', '/api/auth/playback-defaults', { englishSubtitles: false }, undefined, { Authorization: 'Bearer ' + viewer.token })).status, 403);
	await request('local', '/api/apps/' + viewer.id, { action: 'role', role: 'admin' });
	assert.equal((await request('remote', '/api/auth/playback-defaults', undefined, undefined, { Authorization: 'Bearer ' + viewer.token })).status, 200);
	assert.equal((await request('remote', '/api/auth/playback-defaults', { englishSubtitles: false }, undefined, { Authorization: 'Bearer ' + viewer.token })).status, 200);
	assert.deepEqual(createPlaybackDefaults(directory).status(), { englishSubtitles: false, autoNext: false, skipIntros: true });
});
