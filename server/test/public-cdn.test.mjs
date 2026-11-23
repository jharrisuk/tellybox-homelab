import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import {
	PUBLIC_CDN_ASSETS, createPublicAssetCdn, normalizePublicAssetOrigin
} from '../public-assets.mjs';
import { defaultConfig, materialize, validateConfig } from '../homelab/config.mjs';

const origin = 'https://cdn.example.test';
async function fixture(t) {
	const directory = await mkdtemp(path.join(tmpdir(), 'tellybox-cdn-'));
	t.after(() => rm(directory, { recursive: true, force: true }));
	await writeFile(path.join(directory, 'style.css'), 'body{color:#fff}\n');
	await writeFile(path.join(directory, 'tellybox-logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
	await writeFile(path.join(directory, 'index.html'), `<!doctype html><html><head>
<link rel="icon" href="/icon.svg"><link rel="stylesheet" href="/style.css">
<script src="/app.js" defer></script></head><body>
<img src="/tellybox-logo.png" alt="Brand">
<img src="/images/private/poster.jpg" alt="Private artwork">
<img src="/api/dispatcharr/channels/1/image" alt="Channel logo">
<script src="/api/private.js"></script></body></html>`);
	return directory;
}

test('CDN is disabled by default and invalid origins fail closed', async t => {
	const directory = await fixture(t);
	for (const value of ['', 'http://cdn.example.test', 'https://cdn.example.test/assets',
		'https://user:pass@cdn.example.test', 'https://cdn.example.test/?x=1', 'https://cdn.example.test/#x',
		'https://169.254.169.254', 'not-a-url']) {
		const cdn = createPublicAssetCdn({ directory, origin: value });
		assert.equal(cdn.enabled, false, value);
		assert.equal(cdn.origin, '', value);
		const html = await readFile(path.join(directory, 'index.html'), 'utf8');
		assert.equal(cdn.rewrite(html), html, value);
	}
	assert.equal(normalizePublicAssetOrigin(origin + '/'), origin);
});

test('enabled CDN version-keys only public CSS and static branding', async t => {
	const directory = await fixture(t);
	const cdn = createPublicAssetCdn({ directory, origin });
	assert.equal(cdn.enabled, true);
	assert.ok(cdn.assets.has('style.css'));
	assert.ok(cdn.assets.has('tellybox-logo.png'));
	assert.ok(!cdn.assets.has('app.js'));
	assert.match(cdn.assets.get('style.css'), /^https:\/\/cdn\.example\.test\/tellybox\/[a-f0-9]{12}\/style\.css$/);
	const html = cdn.rewrite(await readFile(path.join(directory, 'index.html'), 'utf8'));
	assert.match(html, /href="https:\/\/cdn\.example\.test\/tellybox\/[a-f0-9]{12}\/style\.css" data-tellybox-local="\/style\.css"/);
	assert.match(html, /src="https:\/\/cdn\.example\.test\/tellybox\/[a-f0-9]{12}\/tellybox-logo\.png" data-tellybox-local="\/tellybox-logo\.png"/);
	assert.match(html, /<script src="\/asset-fallback\.js"><\/script>/);
	assert.ok(html.indexOf('/asset-fallback.js') < html.indexOf(cdn.assets.get('style.css')));
	assert.match(html, /src="\/app\.js" defer/);
	assert.match(html, /src="\/images\/private\/poster\.jpg"/);
	assert.match(html, /src="\/api\/dispatcharr\/channels\/1\/image"/);
	assert.match(html, /src="\/api\/private\.js"/);
	assert.ok(!html.includes('/tellybox/' + cdn.versions.get('style.css') + '/app.js'));
	for (const name of ['app.js', 'share-hls.js', 'vendor/hls.min.js', 'images/private/poster.jpg']) {
		assert.ok(!cdn.assets.has(name), name);
	}
	assert.deepEqual(PUBLIC_CDN_ASSETS.filter(name => !name.endsWith('.css')).sort(),
		['icon.svg', 'tellybox-logo.png', 'tellybox-logo.webp', 'tellybox-mark.svg', 'tellybox-wordmark.png', 'tmdb-logo.svg']);
});

test('content hash changes invalidate the CDN URL', async t => {
	const directory = await fixture(t);
	const first = createPublicAssetCdn({ directory, origin });
	await writeFile(path.join(directory, 'style.css'), 'body{color:#000}\n');
	const second = createPublicAssetCdn({ directory, origin });
	assert.notEqual(first.assets.get('style.css'), second.assets.get('style.css'));
	assert.notEqual(first.versions.get('style.css'), second.versions.get('style.css'));
});

test('HTML pages are rewritten through sendFile while APIs and private images are untouched', async t => {
	const directory = await fixture(t);
	const cdn = createPublicAssetCdn({ directory, origin });
	const app = express();
	app.use(cdn.middleware());
	app.get('/private.html', (req, res) => res.sendFile(path.join(directory, 'index.html')));
	app.use(cdn.page());
	app.use(express.static(directory));
	const server = app.listen(0, '127.0.0.1');
	await new Promise(resolve => server.once('listening', resolve));
	t.after(() => { server.closeAllConnections(); server.close(); });
	const base = `http://127.0.0.1:${server.address().port}`;
	const root = await (await fetch(base + '/')).text();
	assert.match(root, /cdn\.example\.test\/tellybox\//);
	assert.match(root, /src="\/images\/private\/poster\.jpg"/);
	const privatePage = await (await fetch(base + '/private.html')).text();
	assert.match(privatePage, /cdn\.example\.test\/tellybox\//);
	const css = await fetch(base + '/style.css');
	assert.equal(css.status, 200);
	assert.match(await css.text(), /#fff/);
});

test('installation config accepts only an HTTPS asset CDN origin and materializes it explicitly', async t => {
	const directory = await mkdtemp(path.join(tmpdir(), 'tellybox-cdn-config-'));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const setup = readFileSync(new URL('../homelab/public/setup.js', import.meta.url), 'utf8');
	assert.match(setup, /assetCdnOrigin: \['Public CSS and branding CDN'/);
	const base = defaultConfig();
	assert.equal(base.network.assetCdnOrigin, '');
	const valid = defaultConfig();
	valid.network.assetCdnOrigin = origin + '/';
	const checked = validateConfig(valid);
	assert.equal(checked.network.assetCdnOrigin, origin);
	assert.equal(materialize(checked, directory).PUBLIC_ASSET_CDN_ORIGIN, origin);
	const disabled = validateConfig(defaultConfig());
	assert.equal(materialize(disabled, directory).PUBLIC_ASSET_CDN_ORIGIN, '');
	for (const value of ['http://cdn.example.test', 'https://cdn.example.test/assets',
		'https://user:pass@cdn.example.test', 'https://cdn.example.test/?x=1', 'https://169.254.169.254']) {
		const invalid = defaultConfig();
		invalid.network.assetCdnOrigin = value;
		assert.throws(() => validateConfig(invalid), /service address|HTTP\(S\)|origin|query|fragment|credentials|Metadata|link-local/, value);
	}
});

test('verified CDN never rewrites an asset the origin cannot serve', async t => {
	const directory = await fixture(t);
	const requested = [];
	const missing = async url => { requested.push(String(url)); return new Response(null, { status: 404 }); };
	const cdn = createPublicAssetCdn({ directory, origin, verify: true, fetchImpl: missing, recheckMs: 0 });
	await cdn.probe();
	const html = await readFile(path.join(directory, 'index.html'), 'utf8');
	assert.equal(cdn.rewrite(html), html, 'a 404 asset must stay on the local path');
	assert.match(cdn.rewrite(html), /href="\/style\.css"/);
	assert.equal(cdn.trusted.size, 0);
	assert.ok(requested.length >= 2, 'each candidate URL is probed');
});

test('verified CDN rewrites only after a successful probe', async t => {
	const directory = await fixture(t);
	const seen = [];
	const served = async (url, init) => {
		seen.push([String(url), init?.method]);
		const css = String(url).endsWith('.css');
		return new Response(css ? 'body{}' : Buffer.from([1, 2]), {
			status: 200,
			headers: { 'content-type': css ? 'text/css; charset=utf-8' : 'image/png' },
		});
	};
	const cdn = createPublicAssetCdn({ directory, origin, verify: true, fetchImpl: served, recheckMs: 0, autoProbe: false });
	const html = await readFile(path.join(directory, 'index.html'), 'utf8');
	assert.equal(cdn.rewrite(html), html, 'nothing is rewritten before the probe finishes');
	await cdn.probe();
	assert.ok(cdn.trusted.has('style.css'));
	assert.ok(cdn.trusted.has('tellybox-logo.png'));
	const rewritten = cdn.rewrite(html);
	assert.match(rewritten, /href="https:\/\/cdn\.example\.test\/tellybox\/[a-f0-9]{12}\/style\.css" data-tellybox-local="\/style\.css"/);
	assert.match(rewritten, /<script src="\/asset-fallback\.js"><\/script>/);
	assert.ok(seen.some(([url, method]) => method === 'HEAD' && url.includes('style.css')));
});

test('a 200 that is not the expected media type is not trusted', async t => {
	const directory = await fixture(t);
	const wrongType = async () => new Response('<html>nope</html>', {
		status: 200,
		headers: { 'content-type': 'text/html; charset=utf-8' },
	});
	const cdn = createPublicAssetCdn({ directory, origin, verify: true, fetchImpl: wrongType, recheckMs: 0 });
	await cdn.probe();
	assert.equal(cdn.trusted.size, 0, 'an HTML error page must not pass as CSS or an image');
});

test('HEAD-refusing stores are verified with a ranged GET', async t => {
	const directory = await fixture(t);
	const calls = [];
	const headRefused = async (url, init) => {
		calls.push(init?.method || 'GET');
		if (init?.method === 'HEAD') return new Response(null, { status: 405 });
		return new Response('x', { status: 206, headers: { 'content-type': String(url).endsWith('.css') ? 'text/css' : 'image/png' } });
	};
	const cdn = createPublicAssetCdn({ directory, origin, verify: true, fetchImpl: headRefused, recheckMs: 0 });
	await cdn.probe();
	assert.ok(cdn.trusted.has('style.css'));
	assert.ok(calls.includes('GET'));
});

test('a redirecting or typeless CDN response is never trusted', async t => {
	const directory = await fixture(t);
	const redirect = async () => new Response(null, { status: 302, headers: { location: 'https://internal.test/style.css' } });
	const first = createPublicAssetCdn({ directory, origin, verify: true, fetchImpl: redirect, autoProbe: false, recheckMs: 0 });
	await first.probe();
	assert.equal(first.trusted.size, 0, 'a redirect must not be followed');

	const typeless = async () => new Response('body', { status: 200 });
	const second = createPublicAssetCdn({ directory, origin, verify: true, fetchImpl: typeless, autoProbe: false, recheckMs: 0 });
	await second.probe();
	assert.equal(second.trusted.size, 0, 'a response without a content type is not proof');
});
