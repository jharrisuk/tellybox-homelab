import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, stat, rm, open, readlink } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createUsbExport } from '../usb-export.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const mount = (usb, overrides = {}) => ({ major: '8', minor: '1', mountPoint: usb, fsType: 'ext4', source: '/dev/sda1', removable: true, usb: true, ...overrides });

async function fixture(size) {
	const root = await mkdtemp(path.join(tmpdir(), 'tellybox-export-bounded-'));
	const media = path.join(root, 'media', 'Film');
	const usb = path.join(root, 'usb');
	await mkdir(media, { recursive: true }); await mkdir(usb, { recursive: true });
	const file = path.join(media, 'Large Film.mkv');
	await writeFile(file, Buffer.alloc(size, 5));
	return { root, media, usb, file };
}

test('large copies flush dirty pages regularly while keeping the final file intact', async () => {
	const f = await fixture(20 * 1024 * 1024);
	let flushes = 0;
	const openImpl = async (...args) => {
		const handle = await open(...args);
		return new Proxy(handle, {
			get(target, property) {
				if (property === 'datasync') return async () => { flushes++; return target.datasync(); };
				const value = target[property];
				return typeof value === 'function' ? value.bind(target) : value;
			}
		});
	};
	const manager = createUsbExport({ directory: f.root, mediaRoots: [f.media], usbRoot: f.usb, openImpl,
		volumeProvider: async () => [mount(f.usb)] });
	const volume = (await manager.status()).volumes[0];
	const plan = await manager.plan({ volumeId: volume.id, items: [{ path: f.file, name: 'Large Film.mkv', folder: 'Film' }] });
	const job = manager.start(plan.id, { confirmed: true });
	for (let i = 0; i < 400 && ['running', 'queued', 'cancelling'].includes(manager.job(job.id).status); i++) await delay(10);
	assert.equal(manager.job(job.id).status, 'complete');
	assert.equal((await stat(path.join(f.usb, 'Film', 'Large Film.mkv'))).size, 20 * 1024 * 1024);
	assert.ok(flushes >= 2, 'dirty writes are flushed every bounded interval');
	assert.equal((await readFile(path.join(f.usb, 'Film', 'Large Film.mkv'))).subarray(0, 8).toString('hex'), '0505050505050505');
	await rm(f.root, { recursive: true, force: true });
});

test('same-drive exports are still rejected and different drives run one at a time', async () => {
	const f = await fixture(2 * 1024 * 1024);
	const secondUsb = path.join(f.root, 'usb2');
	await mkdir(secondUsb, { recursive: true });
	const volumeProvider = async () => [mount(f.usb), mount(secondUsb, { minor: '2', source: '/dev/sdb1' })];
	const manager = createUsbExport({ directory: f.root, mediaRoots: [f.media], usbRoot: f.usb,
		createReadStreamImpl: (file, options) => (async function* () {
			for await (const chunk of createReadStream(file, options)) { yield chunk; await delay(40); }
		})(),
		volumeProvider });
	const volumes = (await manager.status()).volumes;
	const planA = await manager.plan({ volumeId: volumes[0].id, items: [{ path: f.file, name: 'Together.mkv', folder: 'Film' }] });
	const planB = await manager.plan({ volumeId: volumes[1].id, items: [{ path: f.file, name: 'Together.mkv', folder: 'Film' }] });
	const first = manager.start(planA.id, { confirmed: true });
	assert.throws(() => manager.start(planA.id, { confirmed: true }), /already running on this USB drive/);
	const second = manager.start(planB.id, { confirmed: true });
	assert.equal(second.status, 'queued', 'a second drive waits behind the active export');
	for (let i = 0; i < 400 && ['running', 'queued', 'cancelling'].includes(manager.job(first.id).status); i++) await delay(10);
	assert.equal(manager.job(first.id).status, 'complete');
	for (let i = 0; i < 400 && ['running', 'queued', 'cancelling'].includes(manager.job(second.id).status); i++) await delay(10);
	assert.equal(manager.job(second.id).status, 'complete');
	assert.equal((await stat(path.join(f.usb, 'Film', 'Together.mkv'))).size, 2 * 1024 * 1024);
	assert.equal((await stat(path.join(secondUsb, 'Film', 'Together.mkv'))).size, 2 * 1024 * 1024);
	await rm(f.root, { recursive: true, force: true });
});

test('a queued export can be cancelled before it starts and leaves no file', async () => {
	const f = await fixture(2 * 1024 * 1024);
	const secondUsb = path.join(f.root, 'usb2');
	await mkdir(secondUsb, { recursive: true });
	const manager = createUsbExport({ directory: f.root, mediaRoots: [f.media], usbRoot: f.usb,
		createReadStreamImpl: (file, options) => (async function* () {
			for await (const chunk of createReadStream(file, options)) { yield chunk; await delay(40); }
		})(),
		volumeProvider: async () => [mount(f.usb), mount(secondUsb, { minor: '2', source: '/dev/sdb1' })] });
	const volumes = (await manager.status()).volumes;
	const planA = await manager.plan({ volumeId: volumes[0].id, items: [{ path: f.file, name: 'First.mkv', folder: 'Film' }] });
	const planB = await manager.plan({ volumeId: volumes[1].id, items: [{ path: f.file, name: 'Never.mkv', folder: 'Film' }] });
	const first = manager.start(planA.id, { confirmed: true });
	const second = manager.start(planB.id, { confirmed: true });
	assert.equal(second.status, 'queued');
	await manager.cancel(second.id);
	for (let i = 0; i < 400 && ['running', 'queued', 'cancelling'].includes(manager.job(first.id).status); i++) await delay(10);
	assert.equal(manager.job(first.id).status, 'complete');
	for (let i = 0; i < 400 && ['running', 'queued', 'cancelling'].includes(manager.job(second.id).status); i++) await delay(10);
	assert.equal(manager.job(second.id).status, 'cancelled');
	await assert.rejects(stat(path.join(secondUsb, 'Film', 'Never.mkv')));
	await rm(f.root, { recursive: true, force: true });
});

test('a destination rejected after O_EXCL creation removes the empty file', { skip: process.platform !== 'linux' }, async () => {
	const f = await fixture(1024 * 1024);
	let reads = 0;
	const manager = createUsbExport({ directory: f.root, mediaRoots: [f.media], usbRoot: f.usb,
		readlinkImpl: async (...args) => { reads++; return reads === 2 ? '/outside-the-volume' : readlink(...args); },
		volumeProvider: async () => [mount(f.usb)] });
	const volume = (await manager.status()).volumes[0];
	const plan = await manager.plan({ volumeId: volume.id, items: [{ path: f.file, name: 'Rejected.mkv', folder: 'Film' }] });
	const job = manager.start(plan.id, { confirmed: true });
	for (let i = 0; i < 200 && ['running', 'queued', 'cancelling'].includes(manager.job(job.id).status); i++) await delay(10);
	assert.equal(manager.job(job.id).status, 'failed');
	await assert.rejects(stat(path.join(f.usb, 'Film', 'Rejected.mkv')), /ENOENT/);
	await rm(f.root, { recursive: true, force: true });
});

test('cancellation removes its own partial file and leaves an existing file untouched', async () => {
	const f = await fixture(8 * 1024 * 1024);
	await mkdir(path.join(f.usb, 'Film'), { recursive: true });
	await writeFile(path.join(f.usb, 'Film', 'Keep Me.mkv'), 'existing');
	const manager = createUsbExport({ directory: f.root, mediaRoots: [f.media], usbRoot: f.usb,
		createReadStreamImpl: (file, options) => (async function* () {
			for await (const chunk of createReadStream(file, options)) { yield chunk; await delay(30); }
		})(),
		volumeProvider: async () => [mount(f.usb)] });
	const volume = (await manager.status()).volumes[0];
	const plan = await manager.plan({ volumeId: volume.id, items: [{ path: f.file, name: 'Cancelled.mkv', folder: 'Film' }] });
	assert.equal(plan.files[0].destination, path.join('Film', 'Cancelled.mkv'));
	const job = manager.start(plan.id, { confirmed: true });
	await delay(60);
	await manager.cancel(job.id);
	for (let i = 0; i < 400 && ['running', 'queued', 'cancelling'].includes(manager.job(job.id).status); i++) await delay(10);
	const done = manager.job(job.id);
	assert.equal(done.status, 'cancelled');
	await assert.rejects(stat(path.join(f.usb, 'Film', 'Cancelled.mkv')));
	assert.equal(await readFile(path.join(f.usb, 'Film', 'Keep Me.mkv'), 'utf8'), 'existing');
	await rm(f.root, { recursive: true, force: true });
});
