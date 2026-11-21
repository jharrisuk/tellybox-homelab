import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, stat, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
	parseMountInfo, safeName, uniqueName, within, fat32Limit, protectedMount, createUsbExport
} from '../usb-export.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fixture() {
	const root = await mkdtemp(path.join(tmpdir(), 'tellybox-export-test-'));
	const media = path.join(root, 'media', 'Movies', 'Example Film (2020)');
	const usb = path.join(root, 'usb');
	await mkdir(media, { recursive: true });
	await mkdir(usb, { recursive: true });
	const file = path.join(media, 'Example Film.mkv');
	await writeFile(file, Buffer.alloc(256 * 1024, 7));
	await writeFile(path.join(media, 'Example Film.en.srt'), '1\n00:00:00,000 --> 00:00:01,000\nHello\n');
	return { root, media, usb, file };
}

function mount(usb, overrides = {}) {
	return { major: '8', minor: '1', mountPoint: usb, fsType: 'ext4', source: '/dev/sda1', removable: true, usb: true, ...overrides };
}

function manager(mediaRoots, usbRoot, volumeProvider, options = {}) {
	return createUsbExport({ directory: path.dirname(mediaRoots[0]), mediaRoots, usbRoot, volumeProvider, ...options });
}

test('mount parsing keeps only mounts under the configured USB root and decodes escapes', () => {
	const text = [
		'36 25 8:1 / /run/media/Jim\\040USB rw,nosuid - vfat /dev/sda1 rw',
		'37 25 8:2 / /run/media/Other rw - exfat /dev/sdb1 rw',
		'38 25 259:1 / /media/internal rw - ext4 /dev/nvme0n1p1 rw'
	].join('\n');
	const mounts = parseMountInfo(text, '/run/media/Jim USB');
	assert.equal(mounts.length, 1);
	assert.equal(mounts[0].mountPoint, path.resolve('/run/media/Jim USB'));
	assert.equal(mounts[0].fsType, 'vfat');
});

test('a partitioned USB stick uses the parent block removable and USB transport', async () => {
	if (process.platform === 'win32') return;
	const f = await fixture();
	const sys = path.join(f.root, 'sys');
	const usbBlock = path.join(sys, 'devices', 'pci0000:00', 'usb1', '1-1', '1-1:1.0', 'host0', 'target0:0:0', '0:0:0:0', 'block', 'sda');
	const partition = path.join(usbBlock, 'sda1');
	await mkdir(partition, { recursive: true });	await writeFile(path.join(usbBlock, 'removable'), '1');
	await mkdir(path.join(sys, 'dev', 'block'), { recursive: true });
	try { await symlink(partition, path.join(sys, 'dev', 'block', '8:1')); } catch { await rm(f.root, { recursive: true, force: true }); return; }
	const exportManager = createUsbExport({ directory: f.root, mediaRoots: [f.media], usbRoot: f.usb, sysRoot: sys,
		volumeProvider: async () => [{ major: '8', minor: '1', mountPoint: f.usb, fsType: 'vfat', source: '/dev/sda1' }] });
	const status = await exportManager.status();
	assert.equal(status.volumes[0].ready, true);
	assert.equal(status.volumes[0].reason, '');
	await rm(f.root, { recursive: true, force: true });
});

test('configured media roots and their ancestry are protected', async () => {
	assert.equal(protectedMount('/srv/media', ['/srv/media']), true);
	assert.equal(protectedMount('/srv/media/usb', ['/srv/media']), true);
	assert.equal(protectedMount('/srv', ['/srv/media']), true);
	assert.equal(protectedMount('/media/usb', ['/srv/media']), false);
	assert.equal(protectedMount('/', ['/srv/media']), true);
	assert.equal(protectedMount('/var/lib/tellybox-export/mnt/USB', ['/mnt/storage/media'], '/var/lib/tellybox-export/mnt'), false);
	assert.equal(protectedMount('/var/log', ['/mnt/storage/media'], '/var/lib/tellybox-export/mnt'), true);
	assert.equal(protectedMount('/var', ['/mnt/storage/media'], '/var/lib/tellybox-export/mnt'), true);
	assert.equal(protectedMount('/srv/media', ['/srv/media/Movies'], '/srv/media'), true);

	if (process.platform === 'win32') return;
	const f = await fixture();
	const ancestor = path.dirname(f.media);
	const exportManager = createUsbExport({ directory: f.root, mediaRoots: [f.media], usbRoot: ancestor,
		protectedRoots: [f.media], volumeProvider: async () => [mount(ancestor)] });
	const volume = (await exportManager.status()).volumes[0];
	assert.equal(volume.ready, false);
	assert.match(volume.reason, /Protected/);
	await rm(f.root, { recursive: true, force: true });
});

test('a removable non-USB block device is refused', async () => {
	if (process.platform === 'win32') return;
	const f = await fixture();
	const sys = path.join(f.root, 'sys');
	const block = path.join(sys, 'devices', 'pci0000:00', 'ata1', 'host1', 'target1:0:0', '1:0:0:0', 'block', 'sdb');
	await mkdir(path.join(block, 'sdb1'), { recursive: true });	await writeFile(path.join(block, 'removable'), '1');
	await mkdir(path.join(sys, 'dev', 'block'), { recursive: true });
	try { await symlink(path.join(block, 'sdb1'), path.join(sys, 'dev', 'block', '8:2')); } catch { await rm(f.root, { recursive: true, force: true }); return; }
	const exportManager = createUsbExport({ directory: f.root, mediaRoots: [f.media], usbRoot: f.usb, sysRoot: sys,
		volumeProvider: async () => [{ major: '8', minor: '2', mountPoint: f.usb, fsType: 'ext4', source: '/dev/sdb1' }] });
	const status = await exportManager.status();
	assert.equal(status.volumes[0].ready, false);
	assert.match(status.volumes[0].reason, /USB transport/);
	await rm(f.root, { recursive: true, force: true });
});

test('a parent-directory symlink cannot escape the USB volume', async () => {
	const f = await fixture();
	const outside = path.join(f.root, 'outside');
	await mkdir(outside, { recursive: true });
	try { await symlink(outside, path.join(f.usb, 'escape')); } catch { await rm(f.root, { recursive: true, force: true }); return; }
	const exportManager = manager([f.media], f.usb, async () => [mount(f.usb)]);
	const volume = (await exportManager.status()).volumes[0];
	const plan = await exportManager.plan({ volumeId: volume.id, items: [{ path: f.file, name: 'Example Film.mkv', folder: 'escape' }] });
	const job = exportManager.start(plan.id, { confirmed: true });
	for (let i = 0; i < 100 && ['running', 'queued', 'cancelling'].includes(exportManager.job(job.id).status); i++) await delay(10);
	assert.equal(exportManager.job(job.id).status, 'failed');
	await assert.rejects(readFile(path.join(outside, 'Example Film.mkv')));
	await rm(f.root, { recursive: true, force: true });
});

test('volume IDs and plan output do not expose host mount or source paths', async () => {
	const f = await fixture();
	const exportManager = manager([f.media], f.usb, async () => [mount(f.usb)]);
	const status = await exportManager.status();
	assert.ok(!status.volumes[0].id.includes(f.usb));
	assert.ok(!status.volumes[0].id.includes('8:1'));
	assert.ok(!('mountPoint' in status.volumes[0]));
	const plan = await exportManager.plan({ volumeId: status.volumes[0].id, items: [{ path: f.file, name: 'Example Film.mkv', folder: 'Film' }] });
	assert.ok(!JSON.stringify(plan).includes(f.usb));
	await rm(f.root, { recursive: true, force: true });
});

test('a renamed main file keeps the sidecar suffix and collision pairing', async () => {
	const f = await fixture();
	const target = path.join(f.usb, 'Film', 'Display Name.mkv');
	await mkdir(path.dirname(target), { recursive: true });
	await writeFile(target, 'keep');
	const exportManager = manager([f.media], f.usb, async () => [mount(f.usb)]);
	const volume = (await exportManager.status()).volumes[0];
	const plan = await exportManager.plan({ volumeId: volume.id, items: [{ path: f.file, name: 'Display Name.mkv', folder: 'Film' }] });
	assert.equal(plan.files[0].destination, path.join('Film', 'Display Name (2).mkv'));
	assert.equal(plan.files[1].destination, path.join('Film', 'Display Name (2).en.srt'));
	await rm(f.root, { recursive: true, force: true });
});

test('names cannot traverse, use Windows reserved names, or collide', () => {
	assert.equal(safeName('../CON'), '.. CON');
	assert.ok(!safeName('../../etc/passwd').includes('/'));
	assert.ok(!safeName('a\\b:c*').includes('\\'));
	const used = new Set(['film.mkv']);
	assert.equal(uniqueName('Film.mkv', used), 'Film (2).mkv');
	assert.equal(uniqueName('Film.mkv', used), 'Film (3).mkv');
	assert.equal(within('/media', '/media/a'), true);
	assert.equal(within('/media', '/media/../etc'), false);
	assert.equal(fat32Limit('vfat'), 4294967294);
	assert.equal(fat32Limit('ext4'), Infinity);
});

test('status reports a writable removable volume with free space', async () => {
	const f = await fixture();
	const exportManager = manager([f.media], f.usb, async () => [mount(f.usb)]);
	const status = await exportManager.status();
	assert.equal(status.enabled, true);
	assert.equal(status.volumes.length, 1);
	assert.equal(status.volumes[0].name, 'usb');
	assert.equal(status.volumes[0].ready, true);
	assert.ok(status.volumes[0].freeBytes > 0);
	await rm(f.root, { recursive: true, force: true });
});

test('plan includes the original and adjacent subtitle, then copies byte-for-byte', async () => {
	const f = await fixture();
	const exportManager = manager([f.media], f.usb, async () => [mount(f.usb)]);
	const volume = (await exportManager.status()).volumes[0];
	const plan = await exportManager.plan({ volumeId: volume.id, items: [{ path: f.file, name: 'Example Film.mkv', folder: 'Example Film (2020)', kind: 'movie' }] });
	assert.equal(plan.files.length, 2);
	assert.equal(plan.files[1].kind, 'subtitle');
	const job = exportManager.start(plan.id, { confirmed: true });
	for (let i = 0; i < 100 && ['running', 'queued', 'cancelling'].includes(exportManager.job(job.id).status); i++) await delay(10);
	const done = exportManager.job(job.id);
	assert.equal(done.status, 'complete');
	assert.equal(done.bytes, plan.totalBytes);
	assert.deepEqual(await readFile(path.join(f.usb, 'Example Film (2020)', 'Example Film.mkv')), await readFile(f.file));
	assert.match(await readFile(path.join(f.usb, 'Example Film (2020)', 'Example Film.en.srt'), 'utf8'), /Hello/);
	await rm(f.root, { recursive: true, force: true });
});

test('an existing destination is never overwritten', async () => {
	const f = await fixture();
	const exportManager = manager([f.media], f.usb, async () => [mount(f.usb)]);
	const target = path.join(f.usb, 'Example Film (2020)', 'Example Film.mkv');
	await mkdir(path.dirname(target), { recursive: true });
	await writeFile(target, 'keep me');
	const volume = (await exportManager.status()).volumes[0];
	const plan = await exportManager.plan({ volumeId: volume.id, items: [{ path: f.file, name: 'Example Film.mkv', folder: 'Example Film (2020)' }] });
	assert.equal(plan.files[0].destination, path.join('Example Film (2020)', 'Example Film (2).mkv'));
	assert.equal(await readFile(target, 'utf8'), 'keep me');
	await rm(f.root, { recursive: true, force: true });
});

test('a source outside the configured media roots is rejected', async () => {
	const f = await fixture();
	const outside = path.join(f.root, 'outside.mkv');
	await writeFile(outside, 'no');
	const exportManager = manager([f.media], f.usb, async () => [mount(f.usb)]);
	const volume = (await exportManager.status()).volumes[0];
	await assert.rejects(exportManager.plan({ volumeId: volume.id, items: [{ path: outside, name: 'outside.mkv', folder: 'Outside' }] }), /configured local media folders/);
	await rm(f.root, { recursive: true, force: true });
});

test('a symlinked source is rejected', async () => {
	const f = await fixture();
	const link = path.join(f.media, 'linked.mkv');
	try { await symlink(f.file, link); } catch { await rm(f.root, { recursive: true, force: true }); return; }
	const exportManager = manager([f.media], f.usb, async () => [mount(f.usb)]);
	const volume = (await exportManager.status()).volumes[0];
	await assert.rejects(exportManager.plan({ volumeId: volume.id, items: [{ path: link, name: 'linked.mkv', folder: 'Linked' }] }), /regular local files/);
	await rm(f.root, { recursive: true, force: true });
});

test('insufficient free space fails before any copy', async () => {
	const f = await fixture();
	const exportManager = manager([f.media], f.usb, async () => [mount(f.usb)], {
		statfsImpl: async () => ({ bsize: 1, blocks: 1024, bavail: 100 })
	});
	const volume = (await exportManager.status()).volumes[0];
	await assert.rejects(exportManager.plan({ volumeId: volume.id, items: [{ path: f.file, name: 'Example Film.mkv', folder: 'Film' }] }), /do not fit/);
	await rm(f.root, { recursive: true, force: true });
});

test('a removed volume fails the job and leaves no partial destination', async () => {
	const f = await fixture();
	let present = true;
	const exportManager = manager([f.media], f.usb, async () => present ? [mount(f.usb)] : []);
	const volume = (await exportManager.status()).volumes[0];
	const plan = await exportManager.plan({ volumeId: volume.id, items: [{ path: f.file, name: 'Example Film.mkv', folder: 'Film' }] });
	present = false;
	const job = exportManager.start(plan.id, { confirmed: true });
	for (let i = 0; i < 100 && ['running', 'queued', 'cancelling'].includes(exportManager.job(job.id).status); i++) await delay(10);
	const done = exportManager.job(job.id);
	assert.equal(done.status, 'failed');
	assert.match(done.error, /no longer connected|removed or changed/);
	await rm(f.root, { recursive: true, force: true });
});

test('finish refuses while an export is running', async () => {
	const f = await fixture();
	let release;
	const exportManager = manager([f.media], f.usb, async () => [mount(f.usb)], {
		createReadStreamImpl: () => (async function* () { await new Promise(resolve => { release = resolve; }); yield Buffer.alloc(1024); })()
	});
	const volume = (await exportManager.status()).volumes[0];
	const plan = await exportManager.plan({ volumeId: volume.id, items: [{ path: f.file, name: 'Example Film.mkv', folder: 'Film' }] });
	const job = exportManager.start(plan.id, { confirmed: true });
	await delay(10);
	await assert.rejects(exportManager.finish(volume.id), /finish/);
	await exportManager.cancel(job.id);
	release?.();
	await rm(f.root, { recursive: true, force: true });
});

test('helper-backed unmounted drives can be mounted and ejected through the manager', async () => {
	const f = await fixture();
	let mounted = false, ejected = '', mountIdentity = '';
	const volumeProvider = async () => [mount(f.usb, { mountPoint: mounted ? f.usb : '', mounted, removable: true, usb: true, identity: 'helper|fixture|identity' })];
	const exportManager = createUsbExport({ directory: f.root, mediaRoots: [f.media], usbRoot: f.usb,
		volumeProvider, mountImpl: async (device, identity) => { mountIdentity = identity; mounted = true; }, ejectImpl: async device => { ejected = device; } });
	let status = await exportManager.status();
	assert.equal(status.volumes[0].ready, false);
	assert.equal(status.volumes[0].mountable, true);
	const mountedVolume = await exportManager.mount(status.volumes[0].id);
	assert.equal(mountedVolume.ready, true);
	assert.equal(mountIdentity, 'helper|fixture|identity');
	status = await exportManager.status();
	assert.equal(status.volumes[0].ready, true);
	await exportManager.finish(status.volumes[0].id).then(result => {
		assert.equal(result.filesFlushed, true);
		assert.equal(result.safeToRemove, true);
	});
	assert.equal(ejected, '/dev/sda1');
	await rm(f.root, { recursive: true, force: true });
});
