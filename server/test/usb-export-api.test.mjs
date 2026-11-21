import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createUsbExport, installUsbExport, adminAllowed } from '../usb-export.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

test('admin gate never lets a local viewer app token through', () => {
	const req = headers => ({ get: name => headers[name.toLowerCase()] || '' });
	assert.equal(adminAllowed(req({}), { isLocal: () => true, isAdmin: () => false }), true);
	assert.equal(adminAllowed(req({ authorization: 'Bearer viewer' }), { isLocal: () => true, isAdmin: () => false }), false);
	assert.equal(adminAllowed(req({ 'x-jserver-app': 'viewer' }), { isLocal: () => true, isAdmin: () => false }), false);
	assert.equal(adminAllowed(req({ authorization: 'Bearer admin' }), { isLocal: () => false, isAdmin: () => true }), true);
});

test('export API rejects remote callers and non-same-origin writes', async t => {
	const root = await mkdtemp(path.join(tmpdir(), 'tellybox-export-api-'));
	t.after(() => rm(root, { recursive: true, force: true }));
	const media = path.join(root, 'media'), usb = path.join(root, 'usb');
	await mkdir(media, { recursive: true }); await mkdir(usb, { recursive: true });
	const file = path.join(media, 'Film.mkv');
	await writeFile(file, Buffer.alloc(4096, 3));
	const manager = createUsbExport({ directory: root, mediaRoots: [media], usbRoot: usb,
		volumeProvider: async () => [{ major: '8', minor: '1', mountPoint: usb, fsType: 'ext4', source: '/dev/sda1', removable: true, usb: true }] });
	const app = express();
	app.use(express.json());
	app.use((req, res, next) => { req.jserverOrigin = 'http://home.test'; req.jserverViewer = { id: 'admin' }; next(); });
	installUsbExport(app, {
		manager, allowed: req => req.get('x-admin') === 'yes',
		resolve: async ids => ids ? [{ path: file, name: 'Film.mkv', folder: 'Film', kind: 'movie' }] : { enabled: true, movies: [{ id: 'film-1', name: 'Film' }], series: [], episodes: [], recordings: [] }
	});
	app.use((error, req, res, next) => res.status(error.status || 500).json({ error: error.message }));
	const server = await new Promise(resolve => { const value = app.listen(0, '127.0.0.1', () => resolve(value)); });
	t.after(() => new Promise(resolve => server.close(resolve)));
	const base = `http://127.0.0.1:${server.address().port}`;
	const call = (route, options = {}) => fetch(base + route, options);

	assert.equal((await call('/api/export/status')).status, 403);
	let response = await call('/api/export/status', { headers: { 'x-admin': 'yes' } });
	assert.equal(response.status, 200);
	const status = await response.json();
	assert.equal(status.enabled, true);
	assert.equal(status.volumes.length, 1);

	response = await call('/api/export/plan', { method: 'POST', headers: { 'x-admin': 'yes', 'Content-Type': 'application/json' },
		body: JSON.stringify({ volumeId: status.volumes[0].id, itemIds: ['film-1'] }) });
	assert.equal(response.status, 403, 'same-origin is required');

	response = await call('/api/export/plan', { method: 'POST', headers: { 'x-admin': 'yes', 'Content-Type': 'application/json', Origin: 'http://home.test' },
		body: JSON.stringify({ volumeId: status.volumes[0].id, itemIds: ['film-1'] }) });
	assert.equal(response.status, 200);
	const plan = await response.json();
	assert.equal(plan.files.length, 1);

	response = await call('/api/export/start', { method: 'POST', headers: { 'x-admin': 'yes', 'Content-Type': 'application/json', Origin: 'http://home.test' },
		body: JSON.stringify({ planId: plan.id, confirm: false }) });
	assert.equal(response.status, 400);

	response = await call('/api/export/start', { method: 'POST', headers: { 'x-admin': 'yes', 'Content-Type': 'application/json', Origin: 'http://home.test' },
		body: JSON.stringify({ planId: plan.id, confirm: true }) });
	assert.equal(response.status, 200);
	const job = await response.json();
	for (let i = 0; i < 100; i++) {
		const state = await (await call('/api/export/jobs/' + job.id, { headers: { 'x-admin': 'yes' } })).json();
		if (!['running', 'queued'].includes(state.status)) { assert.equal(state.status, 'complete'); break; }
		await delay(10);
	}
	assert.deepEqual(await readFile(path.join(usb, 'Film', 'Film.mkv')), await readFile(file));

	const finish = await call('/api/export/finish', { method: 'POST', headers: { 'x-admin': 'yes', 'Content-Type': 'application/json', Origin: 'http://home.test' },
		body: JSON.stringify({ volumeId: status.volumes[0].id }) });
	assert.equal(finish.status, 200);
	const finished = await finish.json();
	assert.equal(finished.filesFlushed, true);
	assert.equal(finished.safeToRemove, false);
});
