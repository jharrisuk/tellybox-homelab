import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { importPublicApps } from '../homelab/import-apps.mjs';

async function fixture(t) {
	const root = await mkdtemp(path.join(tmpdir(), 'tellybox-app-bundle-'));
	t.after(() => rm(root, { recursive: true, force: true }));
	const stage = path.join(root, 'stage'), config = path.join(root, 'config');
	await mkdir(stage); await mkdir(config);
	const feed = {};
	for (const flavour of ['phone', 'tv']) {
		const bytes = Buffer.from('signed-APK-fixture-' + flavour);
		feed[flavour] = { package: 'app.tellybox.homelab', flavour, versionCode: 65, versionName: '0.30.0', minSdk: 26,
			url: `https://release.invalid/app-updates/public/Tellybox-${flavour}-0.30.0.apk`, bytes: bytes.length,
			sha256: createHash('sha256').update(bytes).digest('hex'), notes: 'Public release' };
		await writeFile(path.join(stage, `Tellybox-${flavour}-0.30.0.apk`), bytes);
	}
	const save = () => writeFile(path.join(stage, 'latest.json'), JSON.stringify(feed));
	await save();
	return { root, stage, config, feed, save, output: path.join(config, 'media', 'app-updates', 'public') };
}

test('public bundle import publishes a complete pair, is repeatable and preserves the personal feed', async t => {
	const f = await fixture(t), personal = path.join(f.config, 'media', 'app-updates');
	await mkdir(personal, { recursive: true }); await writeFile(path.join(personal, 'latest.json'), 'personal');
	assert.equal((await importPublicApps(f.stage, f.config)).edition, 'public');
	assert.equal((await importPublicApps(f.stage, f.config)).version, '0.30.0');
	assert.deepEqual(JSON.parse(await readFile(path.join(f.output, 'latest.json'), 'utf8')), f.feed);
	assert.equal(await readFile(path.join(personal, 'latest.json'), 'utf8'), 'personal');
	for (const flavour of ['phone', 'tv']) assert.equal((await readFile(path.join(f.output, `Tellybox-${flavour}-0.30.0.apk`))).length, f.feed[flavour].bytes);
});

test('invalid public metadata cannot publish a feed', async t => {
	const alterations = [
		feed => { feed.phone.package = 'uk.co.jimbos.jserver'; },
		feed => { feed.tv.flavour = 'phone'; },
		feed => { feed.tv.versionCode++; },
		feed => { feed.phone.url = 'https://release.invalid/app-updates/public/../outside.apk'; },
		feed => { feed.phone.versionName = '../../outside'; },
		feed => { feed.phone.bytes = 129 * 1024 * 1024; },
		feed => { feed.phone.minSdk = 1; },
		feed => { feed.phone.unexpected = 'data'; },
		feed => { feed.phone.sha256 = '0'.repeat(64); },
		feed => { delete feed.tv; }
	];
	for (const alter of alterations) {
		const f = await fixture(t); alter(f.feed); await f.save();
		await assert.rejects(importPublicApps(f.stage, f.config));
		await assert.rejects(readFile(path.join(f.output, 'latest.json')), { code: 'ENOENT' });
	}
});

test('altered artifacts or reused filenames leave an existing published manifest untouched', async t => {
	const f = await fixture(t); await importPublicApps(f.stage, f.config);
	const manifest = await readFile(path.join(f.output, 'latest.json'), 'utf8');
	const file = path.join(f.stage, 'Tellybox-tv-0.30.0.apk');
	await writeFile(file, 'changed');
	await assert.rejects(importPublicApps(f.stage, f.config), /checksum/);
	f.feed.tv.bytes = 7; f.feed.tv.sha256 = createHash('sha256').update('changed').digest('hex'); await f.save();
	await assert.rejects(importPublicApps(f.stage, f.config), /different bytes/);
	assert.equal(await readFile(path.join(f.output, 'latest.json'), 'utf8'), manifest);
});

test('symlinked input and publication directories are refused', async t => {
	const f = await fixture(t), linked = path.join(f.root, 'linked');
	try { await symlink(f.stage, linked, process.platform === 'win32' ? 'junction' : 'dir'); }
	catch (error) { if (error.code === 'EPERM') { t.skip('Host cannot create test symlinks'); return; } throw error; }
	await assert.rejects(importPublicApps(linked, f.config), /Symbolic links/);
	await symlink(f.stage, path.join(f.config, 'media'), process.platform === 'win32' ? 'junction' : 'dir');
	await assert.rejects(importPublicApps(f.stage, f.config), /Symbolic links/);
});

test('an existing import lock prevents concurrent publication', async t => {
	const f = await fixture(t); await mkdir(path.join(f.config, '.public-app-import.lock'));
	await assert.rejects(importPublicApps(f.stage, f.config), { code: 'EEXIST' });
	await assert.rejects(readFile(path.join(f.output, 'latest.json')), { code: 'ENOENT' });
});
