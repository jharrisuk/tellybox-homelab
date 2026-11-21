import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createServer } from 'node:http';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createArtworkCdn, normalizeArtworkCdnOrigin, safeArtworkPath, safeTvdbPath } from '../artwork-cdn.mjs';
import { createArtworkOrigin } from '../artwork-origin.mjs';
import { rewriteArtworkResponse, isLocalOrHome } from '../artwork-routing.mjs';
import { PUBLIC_CDN_ASSETS, PUBLIC_CDN_EXTENSIONS, createPublicAssetCdn } from '../public-assets.mjs';

const secret = 'test-artwork-cdn-secret-0123456789abcdef';
const origin = 'https://cdn.example.test';
const jellyfinId = '0123456789abcdef0123456789abcdef';
const channelId = 'fedcba9876543210fedcba9876543210';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');

function cdn(options = {}) {
	let clock = 1_000_000;
	const value = createArtworkCdn({ origin, secret, now: () => clock, bucketMs: 60_000, ttlMs: 600_000, privateArtwork: true, ...options });
	return { value, advance: ms => { clock += ms; }, now: () => clock };
}

function listen(handler) {
	return new Promise(resolve => {
		const server = createServer(handler);
		server.listen(0, '127.0.0.1', () => resolve(server));
	});
}

function route(url) {
	return new URL(url).pathname;
}

test('artwork CDN is optional, private only when configured, and rejects unapproved origins', () => {
	assert.equal(normalizeArtworkCdnOrigin(''), '');
	for (const value of ['http://cdn.example.test', 'https://user:pass@cdn.example.test', 'https://cdn.example.test/path', 'https://cdn.example.test/?q=1']) {
		assert.equal(normalizeArtworkCdnOrigin(value), '', value);
	}
	assert.equal(createArtworkCdn({ origin, secret: 'short' }).enabled, false);
	assert.equal(createArtworkCdn({ origin: '', secret }).enabled, false);
	assert.equal(createArtworkCdn({ origin, secret }).privateEnabled, false);
	assert.equal(createArtworkCdn({ origin, secret, privateArtwork: true }).privateEnabled, true);
	assert.equal(safeArtworkPath('/poster.jpg'), '/poster.jpg');
	assert.equal(safeArtworkPath('/../private.jpg'), '');
	assert.equal(safeArtworkPath('https://evil.test/poster.jpg'), '');
	assert.equal(safeTvdbPath('/banners/a/poster.png'), '/banners/a/poster.png');
	assert.equal(safeTvdbPath('/banners/../../secret.png'), '');
});

test('signed tokens are opaque, stable within a bucket, expire, and reject tampering', () => {
	const state = cdn();
	const signed = state.value.jellyfinUrl({ id: jellyfinId, kind: 'Primary', width: 480, tag: 'tag-v1' });
	assert.ok(signed?.url);
	assert.match(signed.url, /^https:\/\/cdn\.example\.test\/tellybox\/art\/[A-Za-z0-9_.-]+\/[a-f0-9]{12}\/image\.jpg$/);
	assert.ok(!signed.url.includes(jellyfinId), 'item id is encrypted');
	const parts = new URL(signed.url).pathname.split('/');
	const token = parts[3];
	assert.equal(parts.length, 6);
	assert.ok(state.value.verify(token));
	const same = state.value.jellyfinUrl({ id: jellyfinId, kind: 'Primary', width: 480, tag: 'tag-v1' });
	assert.equal(same.url, signed.url, 'same bucket gives the same cacheable URL');
	state.advance(61_000);
	const next = state.value.jellyfinUrl({ id: jellyfinId, kind: 'Primary', width: 480, tag: 'tag-v1' });
	assert.notEqual(next.url, signed.url, 'a new bucket gives a new URL');
	state.advance(600_000);
	assert.equal(state.value.verify(token), null, 'expired token is rejected');
	const tampered = token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A');
	assert.equal(state.value.verify(tampered), null);
});

test('URL builders allow only known providers and identifiers', () => {
	const state = cdn();
	assert.ok(state.value.tmdbUrl({ type: 'movie', id: 123, kind: 'poster', path: '/poster.jpg' })?.url);
	assert.equal(state.value.tmdbUrl({ type: 'movie', id: 123, kind: 'poster', path: 'https://evil.test/x.jpg' }), '');
	assert.equal(state.value.tmdbUrl({ type: 'movie', id: 0, kind: 'poster', path: '/poster.jpg' }), '');
	assert.ok(state.value.tvdbUrl({ path: '/banners/a/poster.jpg' })?.url);
	assert.equal(state.value.tvdbUrl({ path: 'https://evil.test/a.jpg' }), '');
	assert.ok(state.value.channelUrl({ id: channelId, logoId: 44 })?.url);
	assert.equal(state.value.channelUrl({ id: 'not-a-channel', logoId: 44 }), '');
	assert.ok(state.value.vodUrl({ id: 55, kind: 'series', logoId: 66 })?.url);
	assert.equal(state.value.vodUrl({ id: 55, kind: 'private', logoId: 66 }), '');
	assert.equal(cdn({ privateArtwork: false }).value.jellyfinUrl({ id: jellyfinId, kind: 'Primary', width: 400, tag: 'v1' }), '');
});

test('local/remote JSON routing keeps local viewing local and signs public and private remote artwork', async () => {
	const state = cdn();
	const item = {
		Id: jellyfinId, Type: 'Movie', ImageTags: { Primary: 'primary-tag' },
		BackdropImageTags: ['backdrop-tag'],
	};
	const local = await rewriteArtworkResponse(item, { cdn: state.value, local: true, resolvers: {} });
	assert.equal(local.Artwork, `/images/${jellyfinId}/Primary?width=400`);
	assert.equal(local.BackdropArtwork, `/images/${jellyfinId}/Backdrop?width=1280`);
	const remote = await rewriteArtworkResponse(item, { cdn: state.value, local: false, authorize: () => true, resolvers: {} });
	assert.match(remote.Artwork, /^https:\/\/cdn\.example\.test\/tellybox\/art\//);
	assert.match(remote.ArtworkLocal, /^\/tellybox\/art\//);
	assert.match(remote.BackdropArtwork, /^https:\/\/cdn\.example\.test\/tellybox\/art\//);
	assert.ok(!remote.Artwork.includes(jellyfinId));
	const discovery = { type: 'movie', id: 603, poster: '/poster.jpg' };
	const remembered = [];
	const localDiscovery = await rewriteArtworkResponse(discovery, { cdn: state.value, local: true,
		resolvers: { tmdbRemember: (...args) => { remembered.push(args); return true; } } });
	assert.equal(localDiscovery.Artwork, '/api/web/tmdb-art/movie/603/poster');
	assert.deepEqual(remembered, [['movie', '603', 'poster', '/poster.jpg']], 'the local route must remember the provided TMDB path');
	const remoteDiscovery = await rewriteArtworkResponse(discovery, { cdn: state.value, local: false, authorize: () => true, resolvers: {} });
	assert.match(remoteDiscovery.Artwork, /^https:\/\/cdn\.example\.test\/tellybox\/art\//);
	const remoteExistingRoute = await rewriteArtworkResponse({ ...discovery, Artwork: '/api/web/tmdb-art/movie/603/poster' },
		{ cdn: state.value, local: false, authorize: () => true, resolvers: {} });
	assert.match(remoteExistingRoute.Artwork, /^https:\/\/cdn\.example\.test\/tellybox\/art\//,
		'an existing local TMDB route can be signed from the item poster path without a cache lookup');
	const vod = { Type: 'Movie', Artwork: '/api/web/art/movie/77?v=88' };
	const remoteVod = await rewriteArtworkResponse(vod, { cdn: state.value, local: false, authorize: () => true, resolvers: {} });
	assert.match(remoteVod.Artwork, /^https:\/\/cdn\.example\.test\/tellybox\/art\//);
	assert.match(remoteVod.ArtworkLocal, /^\/tellybox\/art\//);
	const withoutVersion = await rewriteArtworkResponse({ Artwork: '/api/web/art/movie/77' }, {
		cdn: state.value, local: false, authorize: () => true, resolvers: { vodLogo: async () => '' },
	});
	assert.equal(withoutVersion.Artwork, '/api/web/art/movie/77', 'unknown version stays on the private origin route');
	const channel = await rewriteArtworkResponse({ Id: 'dispatch-live-1', Type: 'TvChannel', Artwork: `/api/dispatcharr/channels/${channelId}/image?v=9` }, {
		cdn: state.value, local: false, authorize: () => true, resolvers: {},
	});
	assert.match(channel.Artwork, /^https:\/\/cdn\.example\.test\/tellybox\/art\//);
});

test('private tickets are short-lived while public metadata keeps the longer bucket window', () => {
	const state = cdn({ privateTtlMs: 120_000 });
	const privateUrl = state.value.jellyfinUrl({ id: jellyfinId, kind: 'Primary', width: 400, tag: 'v1' });
	const privateToken = new URL(privateUrl.url).pathname.split('/')[3];
	const privatePayload = state.value.decode(privateToken);
	assert.equal(privatePayload.e - state.now(), 120_000, 'the private ticket has an exact short lifetime');
	assert.ok(state.value.verify(privateToken));
	state.advance(120_001);
	assert.equal(state.value.verify(privateToken), null, 'the private ticket expires exactly at its bound');
	const publicUrl = state.value.tmdbUrl({ type: 'movie', id: 603, kind: 'poster', path: '/poster.jpg' });
	const publicPayload = state.value.decode(new URL(publicUrl.url).pathname.split('/')[3]);
	assert.ok(publicPayload.e - state.now() > 120_000, 'public metadata still uses the larger cache window');
});

test('minting requires explicit caller authorization; an image tag is only a version', async () => {
	const state = cdn();
	const item = { Id: jellyfinId, Type: 'Movie', ImageTags: { Primary: 'primary-tag' }, BackdropImageTags: ['backdrop-tag'] };
	const denied = await rewriteArtworkResponse(item, { cdn: state.value, local: false, authorize: () => false, resolvers: {} });
	assert.equal(denied.Artwork, `/images/${jellyfinId}/Primary?width=400`, 'a denied caller stays on the auth-gated origin route');
	assert.equal(denied.ArtworkLocal, undefined);
	assert.equal(denied.BackdropArtwork, `/images/${jellyfinId}/Backdrop?width=1280`);
	const deniedDiscovery = await rewriteArtworkResponse({ type: 'movie', id: 603, poster: '/poster.jpg' }, {
		cdn: state.value, local: false, authorize: () => false, resolvers: {},
	});
	assert.equal(deniedDiscovery.Artwork, undefined, 'a denied caller gets no public-art token either');
	const seen = [];
	const discovery = await rewriteArtworkResponse({ type: 'movie', id: 603, poster: '/poster.jpg' }, {
		cdn: state.value, local: false, authorize: item => { seen.push(item.id); return item.id === 603; }, resolvers: {},
	});
	assert.deepEqual(seen, [603], 'authorization receives the discovery item id');
	assert.match(discovery.Artwork, /^https:\/\/cdn\.example\.test\/tellybox\/art\//);
	const allowed = await rewriteArtworkResponse(item, { cdn: state.value, local: false, authorize: () => true, resolvers: {} });
	assert.match(allowed.Artwork, /^https:\/\/cdn\.example\.test\/tellybox\/art\//);
});

test('response rewriting never mutates a cached feed object', async () => {
	const state = cdn();
	const original = { items: [{ type: 'movie', id: 1, poster: '/poster.jpg' }] };
	const remote = await rewriteArtworkResponse(original, { cdn: state.value, local: false, authorize: () => true, resolvers: {} });
	assert.equal(original.items[0].Artwork, undefined);
	assert.match(remote.items[0].Artwork, /^https:\/\/cdn\.example\.test/);
});

test('local detection trusts only the established request flags', () => {
	assert.equal(isLocalOrHome({ jserverLocal: true, headers: { 'x-forwarded-for': '203.0.113.9' } }), true);
	assert.equal(isLocalOrHome({ jserverLocal: false, jserverViewer: { home: true }, headers: { 'cf-connecting-ip': '8.8.8.8' } }), true);
	assert.equal(isLocalOrHome({ jserverLocal: false, jserverViewer: { home: false }, headers: { 'x-forwarded-for': '192.168.0.10', 'cf-connecting-ip': '192.168.0.10' } }), false);
	assert.equal(isLocalOrHome({ jserverLocal: false, headers: { 'x-real-ip': '127.0.0.1' } }), false);
});

test('static public asset list covers every non-JavaScript static file', () => {
	const directory = fileURLToPath(new URL('../public', import.meta.url));
	const missing = [];
	for (const name of readdirSync(directory)) {
		const file = path.join(directory, name);
		if (!statSync(file).isFile()) continue;
		const extension = path.extname(name).toLowerCase();
		if (!PUBLIC_CDN_EXTENSIONS.includes(extension)) continue;
		if (!PUBLIC_CDN_ASSETS.includes(name)) missing.push(name);
	}
	assert.deepEqual(missing, [], 'new non-JavaScript static files must be added to the CDN package list');
	assert.ok(!PUBLIC_CDN_ASSETS.some(name => name.endsWith('.js')), 'JavaScript stays on the origin');
	assert.ok(!PUBLIC_CDN_ASSETS.some(name => name.endsWith('.html')), 'HTML is never a static CDN asset');
});

test('static HTML rewrite is remote-only and leaves JavaScript local', () => {
	const directory = mkdtempSync(path.join(tmpdir(), 'tellybox-cdn-local-'));
	try {
		for (const name of PUBLIC_CDN_ASSETS) {
			const source = fileURLToPath(new URL('../public/' + name, import.meta.url));
			copyFileSync(source, path.join(directory, name));
		}
		const html = '<html><head><link rel="stylesheet" href="/style.css"><script src="/app.js" defer></script></head><body><img src="/tellybox-logo.png"></body></html>';
		const assets = createPublicAssetCdn({ directory, origin });
		assert.equal(assets.rewrite(html, { local: true }), html);
		const remote = assets.rewrite(html);
		assert.match(remote, /cdn\.example\.test\/tellybox\//);
		assert.match(remote, /src="\/app\.js"/);
		assert.match(remote, /<script src="\/asset-fallback\.js"><\/script>/);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test('origin route serves a bounded private response only for a valid signed provider and 404/no-store otherwise', async t => {
	const requests = [];
	const upstream = await listen((req, res) => {
		requests.push(req.url);
		if (req.url.startsWith('/Items/' + jellyfinId + '/Images/Primary')) {
			res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': png.length });
			res.end(png);
			return;
		}
		res.writeHead(404, { 'Content-Type': 'text/plain' });
		res.end('no');
	});
	t.after(() => upstream.close());
	const state = cdn();
	const app = express();
	let handler;
	handler = createArtworkOrigin({
		cdn: state.value,
		upstream: new URL(`http://127.0.0.1:${upstream.address().port}`),
		headers: () => ({ Authorization: 'Bearer test-only' }),
		dispatcharr: { origin: 'http://127.0.0.1:1', channels: async () => [] },
		vodLibrary: { raw: async () => null },
		now: state.now,
	});
	app.get('/tellybox/art/:token/:hash/:name', handler);
	const server = app.listen(0, '127.0.0.1');
	await new Promise(resolve => server.once('listening', resolve));
	t.after(() => { server.closeAllConnections(); server.close(); });
	const base = `http://127.0.0.1:${server.address().port}`;
	const signed = state.value.jellyfinUrl({ id: jellyfinId, kind: 'Primary', width: 480, tag: 'primary-tag' });
	const response = await fetch(base + signed.path);
	assert.equal(response.status, 200);
	assert.match(response.headers.get('cache-control'), /^private, max-age=\d+, must-revalidate$/);
	const maxAge = Number(/max-age=(\d+)/.exec(response.headers.get('cache-control'))[1]);
	assert.ok(maxAge > 0 && maxAge <= 300, 'the origin response is bounded by the private ticket');
	assert.match(response.headers.get('content-type'), /^image\/png/);
	assert.deepEqual(Buffer.from(await response.arrayBuffer()), png);
	assert.ok(requests[0].includes('/Items/' + jellyfinId + '/Images/Primary'));
	assert.ok(requests[0].includes('maxWidth=480'));
	assert.ok(requests[0].includes('tag=primary-tag'));

	const head = await fetch(base + signed.path, { method: 'HEAD' });
	assert.equal(head.status, 200);
	assert.match(head.headers.get('cache-control'), /^private, max-age=\d+, must-revalidate$/);
	assert.equal(await head.text(), '', 'HEAD has no image body');

	const tampered = signed.path.slice(0, -1) + (signed.path.endsWith('A') ? 'B' : 'A');
	const denied = await fetch(base + tampered);
	assert.equal(denied.status, 404);
	assert.equal(denied.headers.get('cache-control'), 'no-store');

	const wrongName = signed.path.replace('/image.jpg', '/private.js');
	const nameDenied = await fetch(base + wrongName);
	assert.equal(nameDenied.status, 404);
	assert.equal(nameDenied.headers.get('cache-control'), 'no-store');

	state.advance(700_000);
	const expired = await fetch(base + signed.path);
	assert.equal(expired.status, 404);
	assert.equal(expired.headers.get('cache-control'), 'no-store');
});

test('origin handler rejects a non-image upstream body without cache', async t => {
	const upstream = await listen((req, res) => {
		if (req.url.includes('tag=redirect')) {
			res.writeHead(302, { Location: '/final.png' });
			res.end();
		} else if (req.url.includes('tag=large')) {
			res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': '20000000' });
			res.end();
		} else if (req.url.includes('tag=html')) {
			res.writeHead(200, { 'Content-Type': 'text/html' });
			res.end('<html>not an image</html>');
		} else {
			res.writeHead(200, { 'Content-Type': 'image/png' });
			res.end(png);
		}
	});
	t.after(() => upstream.close());
	const state = cdn();
	const app = express();
	app.get('/tellybox/art/:token/:hash/:name', createArtworkOrigin({
		cdn: state.value,
		upstream: new URL(`http://127.0.0.1:${upstream.address().port}`),
		headers: () => ({}),
		dispatcharr: { origin: 'http://127.0.0.1:1', channels: async () => [] },
		vodLibrary: { raw: async () => null },
	}));
	const server = app.listen(0, '127.0.0.1');
	await new Promise(resolve => server.once('listening', resolve));
	t.after(() => { server.closeAllConnections(); server.close(); });
	const base = `http://127.0.0.1:${server.address().port}`;
	for (const [tag, status] of [['html', 404], ['redirect', 502], ['large', 413]]) {
		const signed = state.value.jellyfinUrl({ id: jellyfinId, kind: 'Primary', width: 400, tag });
		const response = await fetch(base + signed.path);
		assert.equal(response.status, status, tag);
		assert.equal(response.headers.get('cache-control'), 'no-store', tag);
	}
});

test('origin handler resolves each allowlisted provider and never accepts an arbitrary URL', async t => {
	const calls = [];
	const proxyImage = async (res, options) => {
		calls.push(options);
		res.setHeader('Cache-Control', options.cache);
		res.setHeader('Content-Type', 'image/png');
		res.end(png);
	};
	const state = cdn();
	const app = express();
	app.get('/tellybox/art/:token/:hash/:name', createArtworkOrigin({
		cdn: state.value,
		upstream: new URL('http://jellyfin.example.test'),
		headers: () => ({ 'X-Emby-Token': 'fixture' }),
		dispatcharr: { origin: 'http://dispatcharr.example.test', channels: async () => [{ id: channelId, logo: '/api/channels/logos/44/cache/' }] },
		vodLibrary: { raw: async id => id === 'dispatch-series-55' ? { data: { logo: { id: 66 } } } : null },
		proxyImage,
		now: state.now,
	}));
	const server = app.listen(0, '127.0.0.1');
	await new Promise(resolve => server.once('listening', resolve));
	t.after(() => { server.closeAllConnections(); server.close(); });
	const base = `http://127.0.0.1:${server.address().port}`;
	const cases = [
		[state.value.tmdbUrl({ type: 'movie', id: 603, kind: 'poster', path: '/poster.jpg' }), 'https://image.tmdb.org/t/p/w500/poster.jpg'],
		[state.value.tmdbUrl({ type: 'tv', id: 1399, kind: 'backdrop', path: '/backdrop.jpg' }), 'https://image.tmdb.org/t/p/w1280/backdrop.jpg'],
		[state.value.tvdbUrl({ path: '/banners/a/poster.png' }), 'https://artworks.thetvdb.com/banners/a/poster.png'],
		[state.value.channelUrl({ id: channelId, logoId: 44 }), 'http://dispatcharr.example.test/api/channels/logos/44/cache/'],
		[state.value.vodUrl({ id: 55, kind: 'series', logoId: 66 }), 'http://dispatcharr.example.test/api/vod/vodlogos/66/cache/'],
	];
	for (const [signed, expected] of cases) {
		calls.length = 0;
		const response = await fetch(base + signed.path);
		assert.equal(response.status, 200, expected);
		assert.match(response.headers.get('cache-control'), /^private, max-age=\d+, must-revalidate$/);
		assert.equal(calls[0].url.toString(), expected);
		assert.match(calls[0].cache, /^private, max-age=\d+, must-revalidate$/);
	}
	// A stale channel logo version still serves that channel's current logo,
	// because a valid ticket for an existing channel must not empty the grid.
	calls.length = 0;
	const stale = state.value.channelUrl({ id: channelId, logoId: 45 });
	const repaired = await fetch(base + stale.path);
	assert.equal(repaired.status, 200);
	assert.equal(calls[0].url.toString(), 'http://dispatcharr.example.test/api/channels/logos/44/cache/');
	// An unknown channel is still refused.
	calls.length = 0;
	const unknownChannel = state.value.channelUrl({ id: '11111111-2222-3333-4444-555555555555', logoId: 44 });
	const absent = await fetch(base + unknownChannel.path);
	assert.equal(absent.status, 404);
	assert.equal(absent.headers.get('cache-control'), 'no-store');
	assert.equal(calls.length, 0);
	assert.equal(state.value.tmdbUrl({ type: 'movie', id: 603, kind: 'poster', path: 'https://evil.test/poster.jpg' }), '');
});


