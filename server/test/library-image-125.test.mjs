import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';
import {
	createLibraryImageHandler, createTagCache, clampImageWidth, libraryImageEtag,
	ifNoneMatchMatches, trustedImageTag, imageTagsFromItem, LIBRARY_IMAGE_CACHE,
} from '../library-image.mjs';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const id = '0123456789abcdef0123456789abcdef';
const other = 'fedcba9876543210fedcba9876543210';

async function listen(handler) {
	const server = http.createServer(handler);
	await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
	return server;
}

function createUpstream() {
	const state = {
		primary: 'primary-tag-v1', backdrop: 'backdrop-tag-v1', parentId: '',
		itemStatus: 200, imageStatus: 200, metadata: [], images: [],
	};
	const server = http.createServer((req, res) => {
		const url = new URL(req.url, 'http://upstream');
		if (/^\/Items\/[a-f0-9-]{32,36}$/i.test(url.pathname)) {
			state.metadata.push(url.pathname);
			if (state.itemStatus !== 200) {
				res.writeHead(state.itemStatus, { 'content-type': 'application/json' });
				return res.end('{"error":"no"}');
			}
			res.writeHead(200, { 'content-type': 'application/json' });
			return res.end(JSON.stringify({
				Id: url.pathname.split('/').pop(),
				ImageTags: state.primary ? { Primary: state.primary } : {},
				BackdropImageTags: state.backdrop ? [state.backdrop] : [],
				ParentBackdropItemId: state.parentId,
			}));
		}
		const match = /^\/Items\/([a-f0-9-]{32,36})\/Images\/(Primary|Backdrop)$/i.exec(url.pathname);
		if (match) {
			state.images.push({
				id: match[1], kind: match[2], width: url.searchParams.get('maxWidth'),
				quality: url.searchParams.get('quality'), auth: req.headers.authorization || '',
			});
			if (state.imageStatus !== 200) {
				res.writeHead(state.imageStatus, { 'content-type': 'text/plain' });
				return res.end('no');
			}
			res.writeHead(200, { 'content-type': 'image/png', 'content-length': String(png.length) });
			return res.end(png);
		}
		res.writeHead(404, { 'content-type': 'text/plain' });
		res.end('not found');
	});
	return { server, state };
}

function app({ upstream, authorize, readTags = null }) {
	const instance = express();
	// Mirrors the real gate: every request starts as no-store, and the viewer is
	// only ever set by this authentication middleware.
	instance.use((req, res, next) => {
		res.setHeader('Cache-Control', 'no-store');
		const viewer = req.get('x-test-viewer');
		if (viewer) req.jserverViewer = { id: viewer };
		if (req.get('x-test-local') === '1') req.jserverLocal = true;
		next();
	});
	instance.all('/images/:id/:kind', createLibraryImageHandler({
		upstream, headers: () => ({ Authorization: 'Bearer fixture' }), authorize, readTags,
		logger: { error: () => {} },
	}));
	return instance;
}

async function start(instance) {
	const server = instance.listen(0, '127.0.0.1');
	await new Promise(resolve => server.once('listening', resolve));
	return { server, base: `http://127.0.0.1:${server.address().port}` };
}

async function suite(t, options = {}) {
	const upstream = createUpstream();
	await new Promise(resolve => upstream.server.listen(0, '127.0.0.1', resolve));
	const instance = app({
		upstream: new URL(`http://127.0.0.1:${upstream.server.address().port}`),
		authorize: options.authorize || ((req) => req.get('x-test-allow') !== '0'),
		readTags: options.readTags,
	});
	const running = await start(instance);
	t.after(() => {
		running.server.closeAllConnections();
		running.server.close();
		upstream.server.closeAllConnections();
		upstream.server.close();
	});
	return { base: running.base, state: upstream.state };
}

const viewer = headers => ({ headers: { 'x-test-viewer': 'email:fixture', ...headers } });

test('a successful 200 is private,no-cache with a strong trusted-tag ETag', async t => {
	const { base, state } = await suite(t);
	const response = await fetch(`${base}/images/${id}/Primary?width=400`, viewer());
	assert.equal(response.status, 200);
	assert.equal(response.headers.get('cache-control'), LIBRARY_IMAGE_CACHE);
	assert.equal(response.headers.get('cache-control'), 'private, no-cache');
	assert.match(response.headers.get('etag'), /^"tb125-[a-f0-9]{40}"$/);
	assert.match(response.headers.get('content-type'), /^image\/png/);
	assert.deepEqual(Buffer.from(await response.arrayBuffer()), png);
	assert.equal(state.images.length, 1);
	assert.equal(state.images[0].width, '400');
	assert.equal(state.images[0].quality, '85');
	assert.equal(state.images[0].auth, 'Bearer fixture');

	const head = await fetch(`${base}/images/${id}/Primary?width=400`, { method: 'HEAD', ...viewer() });
	assert.equal(head.status, 200);
	assert.equal(head.headers.get('cache-control'), LIBRARY_IMAGE_CACHE);
	assert.equal(head.headers.get('etag'), response.headers.get('etag'), 'HEAD reports the same validator');
	assert.equal(await head.text(), '', 'HEAD has no body');
});

test('a matching If-None-Match returns 304 after auth without fetching the image body', async t => {
	const { base, state } = await suite(t);
	const first = await fetch(`${base}/images/${id}/Primary?width=400`, viewer());
	const etag = first.headers.get('etag');
	const images = state.images.length;

	const revalidated = await fetch(`${base}/images/${id}/Primary?width=400`, viewer({ 'If-None-Match': etag }));
	assert.equal(revalidated.status, 304);
	assert.equal(revalidated.headers.get('cache-control'), LIBRARY_IMAGE_CACHE);
	assert.equal(revalidated.headers.get('etag'), etag);
	assert.equal(await revalidated.text(), '');
	assert.equal(state.images.length, images, 'a 304 never fetches the upstream image');

	const weak = await fetch(`${base}/images/${id}/Primary?width=400`, viewer({ 'If-None-Match': `W/${etag}, "other"` }));
	assert.equal(weak.status, 304, 'weak comparison accepts an equivalent weak validator');
	const star = await fetch(`${base}/images/${id}/Primary?width=400`, viewer({ 'If-None-Match': '*' }));
	assert.equal(star.status, 200, 'a wildcard must not claim a representation before the provider answers');
	assert.equal(state.images.length, images + 1);
});

test('authentication and authorization run before any 304', async t => {
	const { base, state } = await suite(t);
	const first = await fetch(`${base}/images/${id}/Primary?width=400`, viewer());
	const etag = first.headers.get('etag');

	const anonymous = await fetch(`${base}/images/${id}/Primary?width=400`, { headers: { 'If-None-Match': etag } });
	assert.equal(anonymous.status, 401);
	assert.equal(anonymous.headers.get('cache-control'), 'no-store');
	assert.equal(anonymous.headers.get('etag'), null, '401 carries no reusable validator');

	const denied = await fetch(`${base}/images/${id}/Primary?width=400`, viewer({ 'x-test-allow': '0', 'If-None-Match': etag }));
	assert.equal(denied.status, 403);
	assert.equal(denied.headers.get('cache-control'), 'no-store');
	assert.equal(denied.headers.get('etag'), null, '403 carries no reusable validator');

	// A different viewer/account switching browser session cannot reuse the
	// previous viewer's validator for a now-forbidden item.
	const switched = await fetch(`${base}/images/${id}/Primary?width=400`, {
		headers: { 'x-test-viewer': 'email:someone-else', 'x-test-allow': '0', 'If-None-Match': etag },
	});
	assert.equal(switched.status, 403);
	assert.notEqual(switched.status, 304);

	const metadata = state.metadata.length;
	await fetch(`${base}/images/${id}/Primary?width=400`, viewer({ 'x-test-allow': '0' }));
	assert.equal(state.metadata.length, metadata, 'a denied request never reads item metadata');
});

test('a changed tag, width or kind produces a different validator', async t => {
	const { base, state } = await suite(t);
	const first = await fetch(`${base}/images/${id}/Primary?width=400`, viewer());
	const etag = first.headers.get('etag');

	state.primary = 'primary-tag-v2';
	const changed = await fetch(`${base}/images/${id}/Primary?width=400`, viewer({ 'If-None-Match': etag }));
	assert.equal(changed.status, 200, 'a changed tag must revalidate to a fresh 200');
	const changedEtag = changed.headers.get('etag');
	assert.notEqual(changedEtag, etag);

	const wider = await fetch(`${base}/images/${id}/Primary?width=800`, viewer());
	assert.notEqual(wider.headers.get('etag'), changedEtag, 'width is part of the validator');
	const backdrop = await fetch(`${base}/images/${id}/Backdrop?width=400`, viewer());
	assert.notEqual(backdrop.headers.get('etag'), changedEtag, 'kind is part of the validator');
	assert.equal(state.images.at(-1).kind, 'Backdrop');
});

test('without a trusted tag the route keeps the current private,no-store behaviour', async t => {
	const { base, state } = await suite(t);
	state.primary = '';
	const response = await fetch(`${base}/images/${id}/Primary?width=400`, viewer());
	assert.equal(response.status, 200);
	assert.equal(response.headers.get('cache-control'), 'private, no-store');
	assert.equal(response.headers.get('etag'), null, 'no trusted tag means no invented validator');
	assert.deepEqual(Buffer.from(await response.arrayBuffer()), png);

	// A child backdrop tag alone is metadata about a different id and must not be
	// used as this id's version. A different id also keeps this case independent
	// of the short metadata cache.
	state.backdrop = '';
	state.primary = '';
	state.parentId = other;
	const child = await fetch(`${base}/images/${other}/Backdrop?width=1280`, viewer());
	assert.equal(child.status, 200);
	assert.equal(child.headers.get('cache-control'), 'private, no-store');
	assert.equal(child.headers.get('etag'), null);
});

test('errors and failures are never cached and never carry a reusable image ETag', async t => {
	const { base, state } = await suite(t);
	state.imageStatus = 404;
	const missing = await fetch(`${base}/images/${id}/Primary?width=400`, viewer());
	assert.equal(missing.status, 404);
	assert.equal(missing.headers.get('cache-control'), 'no-store');
	assert.doesNotMatch(String(missing.headers.get('etag') || ''), /tb125/, 'the proxy error carries no image validator');

	state.imageStatus = 500;
	const failing = await fetch(`${base}/images/${id}/Primary?width=400`, viewer());
	assert.ok(failing.status >= 400);
	assert.equal(failing.headers.get('cache-control'), 'no-store');
	assert.doesNotMatch(String(failing.headers.get('etag') || ''), /tb125/);

	state.imageStatus = 200;
	state.itemStatus = 500;
	const noItem = await fetch(`${base}/images/${other}/Primary?width=400`, viewer());
	assert.equal(noItem.status, 200, 'a failed metadata read falls back to the unversioned route');
	assert.equal(noItem.headers.get('cache-control'), 'private, no-store');
	assert.equal(noItem.headers.get('etag'), null);

	const bad = await fetch(`${base}/images/not-an-id/Primary?width=400`, viewer());
	assert.equal(bad.status, 404);
	assert.equal(bad.headers.get('cache-control'), 'no-store');
	assert.equal(bad.headers.get('etag'), null);

	const method = await fetch(`${base}/images/${id}/Primary?width=400`, { method: 'POST', ...viewer() });
	assert.equal(method.status, 405);
	assert.equal(method.headers.get('cache-control'), 'no-store');
});

test('a provider body failure on the ETag path is a no-store 502', async t => {
	const gateway = express();
	gateway.use((req, res, next) => {
		res.setHeader('Cache-Control', 'no-store');
		req.jserverViewer = { id: 'email:fixture' };
		next();
	});
	gateway.all('/images/:id/:kind', createLibraryImageHandler({
		upstream: new URL('http://127.0.0.1:1'),
		headers: () => ({}),
		authorize: () => true,
		readTags: async () => ({ primary: 'tag', backdrop: '' }),
		logger: { error: () => {} },
	}));
	const running = await start(gateway);
	t.after(() => { running.server.closeAllConnections(); running.server.close(); });
	const response = await fetch(`${running.base}/images/${id}/Primary?width=400`);
	assert.ok(response.status >= 500);
	assert.equal(response.headers.get('cache-control'), 'no-store');
	assert.doesNotMatch(String(response.headers.get('etag') || ''), /tb125/);
});

test('the metadata cache is bounded, expires and never stores a failure', async t => {
	let clock = 1_000_000;
	const cache = createTagCache({ ttlMs: 1000, maxEntries: 2, now: () => clock });
	const tags = name => ({ primary: name, backdrop: '' });
	cache.set('a', tags('a'));
	clock += 10;
	cache.set('b', tags('b'));
	clock += 10;
	cache.set('c', tags('c'));
	assert.equal(cache.size, 2, 'the cache never exceeds its entry cap');
	assert.equal(cache.get('a'), undefined, 'the oldest entry was evicted');
	assert.deepEqual(cache.get('c'), tags('c'));
	clock += 2000;
	assert.equal(cache.get('c'), undefined, 'expired entries are dropped on read');
	cache.set('d', tags('d'));
	assert.equal(cache.get('d', { fresh: true }), undefined, 'a fresh read rejects a cached value');
	assert.equal(cache.get('d'), undefined, 'and leaves nothing stale behind');
	const before = cache.size;
	cache.set('d', null);
	assert.equal(cache.size, before, 'a failed read is never stored');
});

test('tag helpers normalise ids, kinds, widths and validators', () => {
	assert.equal(clampImageWidth(undefined), 400);
	assert.equal(clampImageWidth('0'), 400);
	assert.equal(clampImageWidth('abc'), 400);
	assert.equal(clampImageWidth('10'), 100);
	assert.equal(clampImageWidth('5000'), 1920);
	assert.equal(clampImageWidth('640'), 640);

	const etag = libraryImageEtag({ id, kind: 'Primary', width: 400, tag: 'tag-v1' });
	assert.equal(etag, libraryImageEtag({ id: id.toUpperCase(), kind: 'Primary', width: 400, tag: 'tag-v1' }));
	assert.notEqual(etag, libraryImageEtag({ id, kind: 'Primary', width: 400, tag: 'tag-v2' }));
	assert.equal(libraryImageEtag({ id, kind: 'Primary', width: 400, tag: 'has space' }), '', 'an implausible tag is not a version');

	assert.equal(ifNoneMatchMatches(etag, etag), true);
	assert.equal(ifNoneMatchMatches(`"nope", ${etag}`, etag), true);
	assert.equal(ifNoneMatchMatches(`W/${etag}`, etag), true);
	assert.equal(ifNoneMatchMatches('*', etag), false);
	assert.equal(ifNoneMatchMatches('', etag), false);
	assert.equal(ifNoneMatchMatches(`"nope"`, etag), false);

	const tags = imageTagsFromItem({ ImageTags: { Primary: 'p' }, BackdropImageTags: ['b'], ParentBackdropItemId: other });
	assert.equal(trustedImageTag(tags, 'Primary', id), 'p');
	assert.equal(trustedImageTag(tags, 'Backdrop', id), 'b');
	const child = imageTagsFromItem({ ImageTags: { Primary: 'p' }, ParentBackdropImageTags: ['parent'], ParentBackdropItemId: other });
	assert.equal(trustedImageTag(child, 'Backdrop', id), '', 'a parent tag for another id is never this id\'s version');
	assert.equal(trustedImageTag(child, 'Backdrop', other), 'parent', 'the parent id resolves its own backdrop');
});
