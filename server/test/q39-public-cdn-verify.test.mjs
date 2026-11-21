/* Q39 REGRESSION (0.26.50 batch): public asset CDN verification.
 *
 * public-cdn.test.mjs already covers: 404 leaves the local path, a successful
 * probe rewrites and injects the fallback, a wrong content type is not trusted,
 * redirects are not followed, typeless responses are not trusted, and
 * HEAD-refusing stores fall back to a ranged GET.
 *
 * This file adds the cells that batch shipped but no test pins:
 *  - 302/typeless answers must leave the markup untouched AND inject no
 *    fallback script (the existing tests only assert trusted.size there);
 *  - a mixed probe rewrites only the proven asset, with exactly one fallback;
 *  - a throwing/timeout probe never rewrites;
 *  - a recheck demotes an asset that stops resolving and the served page
 *    reverts to local paths (cache invalidation);
 *  - the verify middleware serves local paths before the probe, CDN paths
 *    after it, and never rewrites for a local caller;
 *  - a ranged GET with the wrong content type is not trusted either.
 *
 * Offline: every probe answer is a stubbed fetchImpl; the express fixture is
 * loopback-only.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import express from 'express';
import { createPublicAssetCdn } from '../public-assets.mjs';

const origin = 'https://cdn.example.test';

function fixture(t) {
	const directory = mkdtempSync(path.join(tmpdir(), 'tellybox-q39-cdn-'));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	writeFileSync(path.join(directory, 'style.css'), 'body{color:#fff}\n');
	writeFileSync(path.join(directory, 'tellybox-logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
	writeFileSync(path.join(directory, 'index.html'), `<!doctype html><html><head>
<link rel="stylesheet" href="/style.css"><script src="/app.js" defer></script></head><body>
<img src="/tellybox-logo.png" alt="Brand"></body></html>`);
	return directory;
}
const htmlOf = directory => readFileSync(path.join(directory, 'index.html'), 'utf8');
const fallbackCount = html => (html.match(/<script src="\/asset-fallback\.js"><\/script>/g) || []).length;

test('a 302, typeless or 404 probe leaves the local path and injects no fallback script', async t => {
	const directory = fixture(t);
	const answers = {
		redirect: async () => new Response(null, { status: 302, headers: { location: 'https://elsewhere.test/style.css' } }),
		typeless: async () => new Response('body{}', { status: 200 }),
		missing: async () => new Response(null, { status: 404 })
	};
	for (const [label, fetchImpl] of Object.entries(answers)) {
		const cdn = createPublicAssetCdn({ directory, origin, verify: true, fetchImpl, autoProbe: false, recheckMs: 0 });
		await cdn.probe();
		const html = htmlOf(directory);
		assert.equal(cdn.rewrite(html), html, label + ': the markup stays byte-for-byte local');
		assert.equal(fallbackCount(cdn.rewrite(html)), 0, label + ': no fallback script is injected');
		assert.match(cdn.rewrite(html), /href="\/style\.css"/, label);
		assert.match(cdn.rewrite(html), /src="\/tellybox-logo\.png"/, label);
		assert.equal(cdn.trusted.size, 0, label);
	}
});

test('a mixed probe rewrites only the proven asset and injects exactly one fallback', async t => {
	const directory = fixture(t);
	const fetchImpl = async url => String(url).endsWith('.css')
		? new Response('body{}', { status: 200, headers: { 'content-type': 'text/css; charset=utf-8' } })
		: new Response(null, { status: 404 });
	const cdn = createPublicAssetCdn({ directory, origin, verify: true, fetchImpl, autoProbe: false, recheckMs: 0 });
	await cdn.probe();
	assert.deepEqual([...cdn.trusted], ['style.css']);
	const rewritten = cdn.rewrite(htmlOf(directory));
	assert.match(rewritten, /href="https:\/\/cdn\.example\.test\/tellybox\/[a-f0-9]{12}\/style\.css" data-tellybox-local="\/style\.css"/);
	assert.match(rewritten, /src="\/tellybox-logo\.png"/, 'the unproven branding stays local');
	assert.equal(rewritten.includes('data-tellybox-local="/tellybox-logo.png"'), false);
	assert.equal(fallbackCount(rewritten), 1, 'one fallback script covers every rewritten asset');
	assert.match(rewritten, /src="\/app\.js" defer/, 'JavaScript never moves to the CDN');
});

test('a probe that throws or times out never rewrites', async t => {
	const directory = fixture(t);
	for (const fetchImpl of [
		async () => { throw new TypeError('network down'); },
		async () => { throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }); }
	]) {
		const cdn = createPublicAssetCdn({ directory, origin, verify: true, fetchImpl, autoProbe: false, recheckMs: 0 });
		await cdn.probe();
		assert.equal(cdn.trusted.size, 0);
		const html = htmlOf(directory);
		assert.equal(cdn.rewrite(html), html);
		assert.equal(fallbackCount(cdn.rewrite(html)), 0);
	}
});

test('a recheck demotes an asset that stops resolving and the page reverts to local paths', async t => {
	const directory = fixture(t);
	let serve = true;
	const fetchImpl = async url => serve
		? new Response('x', { status: 200, headers: { 'content-type': String(url).endsWith('.css') ? 'text/css' : 'image/png' } })
		: new Response(null, { status: 404 });
	const cdn = createPublicAssetCdn({ directory, origin, verify: true, fetchImpl, autoProbe: false, recheckMs: 0 });
	await cdn.probe();
	assert.equal(cdn.trusted.size, 2);
	const html = htmlOf(directory);
	assert.notEqual(cdn.rewrite(html), html, 'the proven assets are rewritten first');

	serve = false;
	await cdn.probe();
	assert.equal(cdn.trusted.size, 0, 'the recheck removes both assets');
	assert.equal(cdn.rewrite(html), html, 'the rewrite reverts to the local paths');
	assert.equal(fallbackCount(cdn.rewrite(html)), 0, 'and the fallback script goes with it');
});

test('verify middleware serves local before the probe, CDN after, and never rewrites local callers', async t => {
	const directory = fixture(t);
	let serve = false;
	const fetchImpl = async url => serve
		? new Response('x', { status: 200, headers: { 'content-type': String(url).endsWith('.css') ? 'text/css' : 'image/png' } })
		: new Response(null, { status: 404 });
	const cdn = createPublicAssetCdn({ directory, origin, verify: true, fetchImpl, autoProbe: false, recheckMs: 0 });
	const isLocal = req => req.get('x-test-local') === '1';
	const app = express();
	app.use(cdn.middleware({ isLocal }));
	app.use(cdn.page({ isLocal }));
	app.use(express.static(directory));
	const server = app.listen(0, '127.0.0.1');
	await once(server, 'listening');
	t.after(() => { server.closeAllConnections?.(); server.close(); });
	const base = 'http://127.0.0.1:' + server.address().port;

	const before = await (await fetch(base + '/')).text();
	assert.match(before, /href="\/style\.css"/, 'before the probe the page keeps local paths');
	assert.equal(fallbackCount(before), 0);

	serve = true;
	await cdn.probe();
	const after = await (await fetch(base + '/')).text();
	assert.match(after, /cdn\.example\.test\/tellybox\/[a-f0-9]{12}\/style\.css/, 'after the probe the page uses the CDN');
	assert.equal(fallbackCount(after), 1);

	const local = await (await fetch(base + '/', { headers: { 'x-test-local': '1' } })).text();
	assert.match(local, /href="\/style\.css"/, 'a local caller is never rewritten');
	assert.equal(fallbackCount(local), 0);

	// The CDN stops serving: the next recheck must revert the served page too,
	// not keep the cached rewrite.
	serve = false;
	await cdn.probe();
	const reverted = await (await fetch(base + '/')).text();
	assert.match(reverted, /href="\/style\.css"/, 'the served page reverts after a failed recheck');
	assert.equal(fallbackCount(reverted), 0);
});

test('a HEAD-refusing store is only trusted when the ranged GET has the expected type', async t => {
	const directory = fixture(t);
	const calls = [];
	const fetchImpl = async (url, init) => {
		calls.push(init?.method || 'GET');
		if (init?.method === 'HEAD') return new Response(null, { status: 405 });
		// The ranged GET answers with an HTML error page, not the asset type.
		return new Response('<html>nope</html>', { status: 206, headers: { 'content-type': 'text/html' } });
	};
	const cdn = createPublicAssetCdn({ directory, origin, verify: true, fetchImpl, autoProbe: false, recheckMs: 0 });
	await cdn.probe();
	assert.ok(calls.includes('GET'), 'the ranged GET was attempted');
	assert.equal(cdn.trusted.size, 0, 'a wrong-type ranged GET is not proof either');
	const html = htmlOf(directory);
	assert.equal(cdn.rewrite(html), html);
});
