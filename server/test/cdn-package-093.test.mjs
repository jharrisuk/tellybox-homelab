import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { PUBLIC_CDN_ASSETS } from '../public-assets.mjs';

const tool = fileURLToPath(new URL('../tools/package-cdn-assets.mjs', import.meta.url));
const publicDir = fileURLToPath(new URL('../public', import.meta.url));
const packageAssets = (source, out) => execFileSync(process.execPath, [tool, '--source', source, '--out', out], { encoding: 'utf8' });
const manifest = out => JSON.parse(readFileSync(path.join(out, 'manifest.json'), 'utf8'));
const sha = data => createHash('sha256').update(data).digest('hex');

function fixture(t) {
	const root = mkdtempSync(path.join(tmpdir(), 'tellybox-cdn-package-'));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const source = path.join(root, 'source'), out = path.join(root, 'out');
	mkdirSync(source, { recursive: true });
	for (const name of PUBLIC_CDN_ASSETS) copyFileSync(path.join(publicDir, name), path.join(source, name));
	writeFileSync(path.join(source, 'private.js'), 'do not publish');
	return { root, source, out };
}

test('packaging creates exact allowlisted hash directories and repeatable manifests', t => {
	const f = fixture(t);
	packageAssets(f.source, f.out);
	const first = manifest(f.out);
	assert.equal(first.assets.length, PUBLIC_CDN_ASSETS.length);
	assert.equal(first.versions.length, PUBLIC_CDN_ASSETS.length);
	assert.ok(!JSON.stringify(first).includes('private.js'));
	assert.ok(existsSync(path.join(f.out, 'manifest.json')));
	assert.ok(existsSync(path.join(f.out, 'CHECKSUMS.sha256')));
	const style = first.assets.find(entry => entry.name === 'style.css');
	const v1 = readFileSync(path.join(f.out, 'tellybox', style.hash, 'style.css'));
	assert.equal(style.sha256, sha(v1));
	assert.ok(!existsSync(path.join(f.out, 'tellybox', style.hash, 'private.js')));
	assert.ok(!existsSync(path.join(f.out, 'tellybox', style.hash, 'app.js')));
	packageAssets(f.source, f.out);
	assert.deepEqual(manifest(f.out), first, 'repeat packaging is deterministic');
});

test('old exact-hash versions are retained unchanged and current URLs move on update', t => {
	const f = fixture(t);
	packageAssets(f.source, f.out);
	const before = manifest(f.out);
	const v1 = before.assets.find(entry => entry.name === 'style.css');
	const oldBytes = readFileSync(path.join(f.out, 'tellybox', v1.hash, 'style.css'));
	writeFileSync(path.join(f.source, 'style.css'), 'body{background:#123456}\n');
	packageAssets(f.source, f.out);
	const after = manifest(f.out);
	const v2 = after.assets.find(entry => entry.name === 'style.css');
	assert.notEqual(v2.hash, v1.hash);
	assert.deepEqual(readFileSync(path.join(f.out, 'tellybox', v1.hash, 'style.css')), oldBytes);
	assert.ok(readFileSync(path.join(f.out, 'tellybox', v2.hash, 'style.css'), 'utf8').includes('#123456'));
	assert.ok(after.versions.some(entry => entry.path === v1.path && entry.current === false));
	assert.ok(after.versions.some(entry => entry.path === v2.path && entry.current === true));
	const checksums = readFileSync(path.join(f.out, 'CHECKSUMS.sha256'), 'utf8');
	assert.match(checksums, /tellybox\/[a-f0-9]{12}\/style\.css/);
});

test('check mode fails after source changes until assets are packaged again', t => {
	const f = fixture(t);
	packageAssets(f.source, f.out);
	execFileSync(process.execPath, [tool, '--source', f.source, '--out', f.out, '--check'], { encoding: 'utf8' });
	writeFileSync(path.join(f.source, 'style.css'), 'changed without packaging\n');
	assert.throws(() => execFileSync(process.execPath, [tool, '--source', f.source, '--out', f.out, '--check'], { encoding: 'utf8' }));
});
