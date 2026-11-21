import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import { providerLogoUrl, createProviderImageCache } from '../provider-logo.mjs';
import { createDispatcharr } from '../dispatcharr.mjs';
import { channelView } from '../dispatcharr-guide.mjs';
import { png } from './artwork-128-fixture.mjs';

const BROKEN = '11111111-1111-1111-1111-111111111111';
const GOOD = '22222222-2222-2222-2222-222222222222';
const PROVIDER = new Set(['logo.provider.test']);

test('provider artwork is https-only, host-allowlisted, image-like and credential-free', () => {
	assert.equal(providerLogoUrl('https://logo.provider.test/art/one.png', PROVIDER), 'https://logo.provider.test/art/one.png');
	assert.equal(providerLogoUrl('https://logo.provider.test/logo/one', PROVIDER), 'https://logo.provider.test/logo/one');
	assert.equal(providerLogoUrl('https://logo.provider.test/one.png?v=2', PROVIDER), 'https://logo.provider.test/one.png?v=2', 'a harmless version query is allowed');
	assert.equal(providerLogoUrl('https://logo.provider.test/api/image-proxy?url=https%3A%2F%2Fcdn.example%2Fone.png', PROVIDER),
		'https://logo.provider.test/api/image-proxy?url=https%3A%2F%2Fcdn.example%2Fone.png', 'an image proxy path with a non-credential URL is allowed');
	for (const value of [
		'http://logo.provider.test/one.png',
		'https://evil.test/one.png',
		'https://logo.provider.test.example/one.png',
		'https://user:pass@logo.provider.test/one.png',
		'https://logo.provider.test/one.png?token=secret',
		'https://logo.provider.test/one.png?api_key=secret',
		'https://logo.provider.test/api/image-proxy?url=https%3A%2F%2Fuser%3Apass%40host%2Fone.png',
		'https://logo.provider.test/not-an-image',
		'',
	]) assert.equal(providerLogoUrl(value, PROVIDER), '', value);
});

test('provider artwork cache hits, misses, expires and remembers failures', async () => {
	let now = 1000, calls = 0;
	const cache = createProviderImageCache({ clock: () => now, fetcher: async () => {
		calls++;
		return new Response(png, { headers: { 'Content-Type': 'image/png', 'Content-Length': String(png.length) } });
	} });
	const url = 'https://logo.provider.test/one.png';
	const first = await cache.get(url);
	assert.equal(first.type, 'image/png');
	assert.deepEqual(first.body, png, 'the bytes come from the provider response');
	assert.equal(calls, 1);
	const second = await cache.get(url);
	assert.equal(calls, 1, 'the second request is a cache hit');
	assert.deepEqual(second.body, png);
	now += 6 * 3600000 + 1;
	await cache.get(url);
	assert.equal(calls, 2, 'the positive entry expires');

	let failures = 0;
	const failing = createProviderImageCache({ clock: () => now, negativeTtlMs: 1000, fetcher: async () => {
		failures++;
		return new Response('no', { status: 404, headers: { 'Content-Type': 'text/plain' } });
	} });
	assert.equal(await failing.get(url), null);
	assert.equal(await failing.get(url), null);
	assert.equal(failures, 1, 'a failure is negatively cached');
	now += 1001;
	assert.equal(await failing.get(url), null);
	assert.equal(failures, 2, 'the negative entry expires');
});

test('provider artwork rejects redirects, non-image types and oversized bodies', async () => {
	const redirects = [];
	const wrongType = createProviderImageCache({ fetcher: async (_url, init) => {
		redirects.push(init.redirect);
		return new Response('<html>', { headers: { 'Content-Type': 'text/html' } });
	} });
	assert.equal(await wrongType.get('https://logo.provider.test/one.png'), null);
	assert.equal(redirects[0], 'error', 'redirects are never followed');

	const declared = createProviderImageCache({ maxBytes: 10, fetcher: async () => new Response(png, {
		headers: { 'Content-Type': 'image/png', 'Content-Length': String(png.length) },
	}) });
	assert.equal(await declared.get('https://logo.provider.test/one.png'), null, 'a declared size cap is enforced');

	const streamed = createProviderImageCache({ maxBytes: 10, fetcher: async () => new Response(png, {
		headers: { 'Content-Type': 'image/png' },
	}) });
	assert.equal(await streamed.get('https://logo.provider.test/one.png'), null, 'a streamed body cap is enforced');
});

test('provider artwork opens no more than the configured number of connections', async () => {
	let active = 0, maximum = 0;
	const release = [];
	const cache = createProviderImageCache({ concurrency: 2, fetcher: async () => {
		active++;
		maximum = Math.max(maximum, active);
		await new Promise(resolve => release.push(resolve));
		active--;
		return new Response(png, { headers: { 'Content-Type': 'image/png' } });
	} });
	const pending = Array.from({ length: 8 }, (_, index) => cache.get('https://logo.provider.test/' + index + '.png'));
	for (let done = 0; done < 8; done++) {
		while (!release.length) await new Promise(resolve => setImmediate(resolve));
		release.shift()();
		await new Promise(resolve => setImmediate(resolve));
	}
	await Promise.all(pending);
	assert.equal(maximum, 2, 'a grid of cards is queued behind the concurrency limit');
});

test('the client-visible artwork URL never carries a provider host', () => {
	const base = { id:BROKEN, name:'24/7 Channel', number:'1000', group:'24/7 TV', nonstop:true };
	const withCache = channelView({ ...base, logo:'/api/channels/logos/42/cache/', sourceLogo:'https://logo.provider.test/one.png' });
	assert.equal(withCache.Artwork, '/api/dispatcharr/channels/' + BROKEN + '/image?v=42');
	assert.doesNotMatch(withCache.Artwork, /provider\.test/i);
	const withoutCache = channelView({ ...base, logo:'', sourceLogo:'https://logo.provider.test/one.png' });
	assert.equal(withoutCache.Artwork, '/api/dispatcharr/channels/' + BROKEN + '/image');
	assert.doesNotMatch(withoutCache.Artwork, /provider\.test/i);
	assert.equal(withoutCache.sourceLogo, undefined, 'the provider URL is not copied into the client view');
});

function playlistEntry(name, number, id, logo, origin) {
	return '#EXTINF:-1 tvg-chno="' + number + '"' + (logo ? ' tvg-logo="' + logo + '"' : '') + ' group-title="24/7 TV",24/7 ' + name
		+ '\n' + origin + '/proxy/ts/stream/' + id;
}

test('only a broken cache logo gets a provider fallback, and provider URLs stay out of the snapshot', async t => {
	const directory = mkdtempSync(path.join(tmpdir(), 'tellybox-origin-art-'));
	t.after(() => rmSync(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }));
	const origin = 'http://dispatch.test:9191';
	const file = path.join(directory, 'dispatcharr.json');
	let fallbackCalls = 0;
	const fetcher = async (input, init = {}) => {
		const url = new URL(input);
		if (init.method === 'HEAD') {
			return url.pathname === '/api/channels/logos/42/cache/'
				? new Response(null, { status: 404, headers: { 'Content-Type': 'application/json' } })
				: new Response(null, { status: 200, headers: { 'Content-Type': 'image/png' } });
		}
		if (url.pathname === '/output/m3u' && url.searchParams.get('cachedlogos') === 'false') {
			fallbackCalls++;
			return new Response('#EXTM3U\n'
				+ playlistEntry('Broken', '1000', BROKEN, 'https://logo.provider.test/broken.png', origin) + '\n'
				+ playlistEntry('Good', '1001', GOOD, 'https://logo.provider.test/good.png', origin),
			{ headers: { 'Content-Type': 'audio/x-mpegurl' } });
		}
		if (url.pathname === '/output/m3u') {
			return new Response('#EXTM3U\n'
				+ playlistEntry('Broken', '1000', BROKEN, origin + '/api/channels/logos/42/cache/', origin) + '\n'
				+ playlistEntry('Good', '1001', GOOD, origin + '/api/channels/logos/43/cache/', origin),
			{ headers: { 'Content-Type': 'audio/x-mpegurl' } });
		}
		return new Response('{}', { headers: { 'Content-Type': 'application/json' } });
	};
	const client = createDispatcharr({ file, origin, clock: () => 1000, fetcher });
	const items = await client.channels(true);
	const broken = items.find(item => item.id === BROKEN);
	const good = items.find(item => item.id === GOOD);
	assert.equal(fallbackCalls, 1, 'the origin playlist is read only when a cache logo failed');
	assert.equal(broken.sourceLogo, 'https://logo.provider.test/broken.png');
	assert.equal(good.sourceLogo, undefined, 'a healthy cache logo does not need a fallback');
	assert.equal(client.providerLogo(broken.sourceLogo), broken.sourceLogo);
	assert.equal(client.providerLogo('https://evil.test/broken.png'), '', 'the route re-checks the derived host allowlist');
	const snapshot = readFileSync(file + '.channels-cache.json', 'utf8');
	assert.doesNotMatch(snapshot, /logo\.provider\.test|sourceLogo/, 'provider URLs are kept in memory only');

	let healthyFallbackCalls = 0;
	const healthy = createDispatcharr({ file: path.join(directory, 'healthy.json'), origin, clock: () => 1000, fetcher: async (input, init = {}) => {
		const url = new URL(input);
		if (init.method === 'HEAD') return new Response(null, { status: 200, headers: { 'Content-Type': 'image/png' } });
		if (url.pathname === '/output/m3u' && url.searchParams.get('cachedlogos') === 'false') healthyFallbackCalls++;
		return new Response('#EXTM3U\n'
			+ playlistEntry('Broken', '1000', BROKEN, origin + '/api/channels/logos/42/cache/', origin) + '\n'
			+ playlistEntry('Good', '1001', GOOD, origin + '/api/channels/logos/43/cache/', origin),
		{ headers: { 'Content-Type': 'audio/x-mpegurl' } });
	} });
	await healthy.channels(true);
	assert.equal(healthyFallbackCalls, 0, 'a healthy cache playlist never reads the origin playlist');
});

test('the artwork route serves provider bytes through Tellybox when the cache refuses a logo', { timeout: 30000 }, async t => {
	const directory = mkdtempSync(path.join(tmpdir(), 'tellybox-origin-route-'));
	t.after(() => rmSync(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }));
	let origin = '', providerFetches = 0, providerRedirect = '';
	const dispatcharr = createServer((request, response) => {
		const url = new URL(request.url, origin);
		if (request.method === 'HEAD' && /^\/api\/channels\/logos\/\d+\/cache\/$/.test(url.pathname)) {
			response.writeHead(404, { 'Content-Type': 'application/json' });
			return response.end(JSON.stringify({ detail: 'Remote image not allowed' }));
		}
		if (url.pathname === '/output/m3u' && url.searchParams.get('cachedlogos') === 'false') {
			response.writeHead(200, { 'Content-Type': 'audio/x-mpegurl' });
			return response.end('#EXTM3U\n' + playlistEntry('Broken', '1000', BROKEN, 'https://logo.provider.test/one.png', origin));
		}
		if (url.pathname === '/output/m3u') {
			response.writeHead(200, { 'Content-Type': 'audio/x-mpegurl' });
			return response.end('#EXTM3U\n' + playlistEntry('Broken', '1000', BROKEN, origin + '/api/channels/logos/42/cache/', origin));
		}
		response.writeHead(200, { 'Content-Type': 'application/json' });
		return response.end('{}');
	});
	await new Promise(resolve => dispatcharr.listen(0, '127.0.0.1', resolve));
	origin = 'http://127.0.0.1:' + dispatcharr.address().port;
	const local = createServer();
	await new Promise(resolve => local.listen(0, '127.0.0.1', resolve));
	const realFetch = globalThis.fetch;
	globalThis.fetch = async (input, init) => {
		const url = new URL(String(input));
		if (url.hostname === 'logo.provider.test') {
			providerFetches++;
			providerRedirect = init?.redirect || '';
			return new Response(png, { headers: { 'Content-Type': 'image/png', 'Content-Length': String(png.length) } });
		}
		return realFetch(input, init);
	};
	t.after(() => { globalThis.fetch = realFetch; });
	Object.assign(process.env, {
		NODE_ENV: 'test', AUTH_DIR: directory, DATA_DIR: directory, CATALOGUE_CACHE_DIR: directory,
		DISPATCHARR_URL: origin, JELLYFIN_URL: 'http://127.0.0.1:1', PORT: String(local.address().port),
		LOCAL_HOSTS: '127.0.0.1', LOCAL_NETWORKS: '127.0.0.0/8', PUBLIC_ORIGIN: 'https://remote.test'
	});
	writeFileSync(path.join(directory, 'connection.json'), JSON.stringify({ userId: 'fixture', token: 'fixture-only' }));
	writeFileSync(path.join(directory, 'dispatcharr.json'), JSON.stringify({}));
	writeFileSync(path.join(directory, 'capabilities.json'), JSON.stringify({
		jellyfin: false, library: false, live: true, nonstop: true, vod: false, recordings: false,
		catchup: false, discover: false, comingSoon: false, introdb: false, subtitles: false,
		managedInstallation: true, canShare: false, canDownload: false,
	}));
	const { app } = await import('../server.mjs');
	local.on('request', app);
	const base = 'http://127.0.0.1:' + local.address().port;
	t.after(() => {
		local.closeAllConnections(); local.close();
		dispatcharr.closeAllConnections(); dispatcharr.close();
	});

	const listResponse = await fetch(base + '/api/dispatcharr/channels');
	assert.equal(listResponse.status, 200);
	const list = await listResponse.json();
	const item = list.items.find(entry => entry.Name === '24/7 Broken');
	assert.equal(item.Artwork, '/api/dispatcharr/channels/' + BROKEN + '/image?v=42');
	assert.doesNotMatch(item.Artwork, /provider\.test/i);

	const image = await fetch(base + item.Artwork);
	assert.equal(image.status, 200);
	assert.equal(image.headers.get('content-type'), 'image/png');
	assert.deepEqual(Buffer.from(await image.arrayBuffer()), png);
	assert.ok(providerFetches >= 1);
	assert.equal(providerRedirect, 'error', 'the provider fetch never follows a redirect');
});
