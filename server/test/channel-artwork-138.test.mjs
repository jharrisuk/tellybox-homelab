import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { channelView } from '../dispatcharr-guide.mjs';
import { channelLogoUrl, findChannelForArtwork, channelLogoPath } from '../dispatcharr.mjs';
import { png } from './artwork-128-fixture.mjs';

const GOOD = '11111111-1111-1111-1111-111111111111';
const BAD = '22222222-2222-2222-2222-222222222222';
const NO_LOGO = '33333333-3333-3333-3333-333333333333';
const FOREIGN = '44444444-4444-4444-4444-444444444444';
const EPG = '55555555-5555-5555-5555-555555555555';

test('channel artwork advertises the uuid the route can resolve and omits a missing logo', () => {
	const withLogo = { id:GOOD, name:'24/7 Good', number:'1000', group:'24/7 TV', epgId:'900', logo:'/api/channels/logos/42/cache/' };
	assert.equal(channelView(withLogo).Artwork, '/api/dispatcharr/channels/' + GOOD + '/image?v=42');
	for (const logo of ['', undefined, 'https://evil.test/logo.png', '/api/channels/logos/42/other/', '/api/channels/logos/42/cache/?v=1']) {
		assert.equal(channelView({ ...withLogo, logo }).Artwork, undefined, String(logo));
	}
});

test('the logo allowlist accepts only a same-origin Dispatcharr logo-cache path', () => {
	const origin = 'http://dispatcharr.test:9191';
	const channel = { id:GOOD, logo:'/api/channels/logos/42/cache/' };
	assert.equal(channelLogoPath(channel.logo), channel.logo);
	assert.equal(channelLogoUrl(channel, origin).href, origin + channel.logo);
	assert.equal(channelLogoUrl(channel, origin + '/').href, origin + channel.logo, 'a trailing slash in configuration does not widen the origin');
	for (const logo of [
		'', undefined, 'https://evil.test/logo.png', '//evil.test/api/channels/logos/42/cache/',
		'http://other.test:9191/api/channels/logos/42/cache/', '/api/channels/logos/42/other/',
		'/api/channels/logos/42/cache/?token=secret', '/api/channels/logos/abc/cache/',
	]) assert.equal(channelLogoUrl({ ...channel, logo }, origin), null, String(logo));
});

test('artwork identifiers resolve by uuid, catalogue id, numeric epg id and numeric logo id', () => {
	const channels = [
		{ id:GOOD, epgId:'900', logo:'/api/channels/logos/42/cache/' },
		{ id:EPG, epgId:'901', logo:'/api/channels/logos/44/cache/' },
	];
	assert.equal(findChannelForArtwork(channels, GOOD)?.id, GOOD);
	assert.equal(findChannelForArtwork(channels, 'dispatch-live-' + GOOD)?.id, GOOD);
	assert.equal(findChannelForArtwork(channels, '900')?.id, GOOD);
	assert.equal(findChannelForArtwork(channels, '42')?.id, GOOD, 'the numeric logo id still resolves');
	assert.equal(findChannelForArtwork(channels, '901')?.id, EPG);
	assert.equal(findChannelForArtwork(channels, '999'), null);
	assert.equal(findChannelForArtwork(channels, ''), null);
});

test('the channel artwork route and channel list use the live Dispatcharr logo health', { timeout: 30000 }, async t => {
	const directory = mkdtempSync(path.join(tmpdir(), 'tellybox-channel-art-'));
	let origin = '';
	const requests = [];
	const dispatcharr = createServer((request, response) => {
		requests.push({ method: request.method, url: request.url });
		const url = new URL(request.url, origin);
		const logo = /^\/api\/channels\/logos\/(\d+)\/cache\/$/.exec(url.pathname);
		if (logo) {
			if (logo[1] === '43') {
				response.writeHead(404, { 'Content-Type': 'application/json' });
				return response.end(JSON.stringify({ detail: 'Remote image not allowed' }));
			}
			response.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': String(png.length) });
			return response.end(png);
		}
		if (url.pathname === '/output/m3u') {
			const entry = (name, number, uuid, epgId, logo) =>
				'#EXTINF:-1 tvg-id="' + epgId + '" tvg-chno="' + number + '"' + (logo ? ' tvg-logo="' + logo + '"' : '') + ' group-title="24/7 TV",24/7 ' + name + '\n' + origin + '/proxy/ts/stream/' + uuid;
			const cache = logoId => origin + '/api/channels/logos/' + logoId + '/cache/';
			const text = ['#EXTM3U',
				entry('Good', '1000', GOOD, '900', cache('42')),
				entry('Bad', '1001', BAD, '', cache('43')),
				entry('Missing', '1002', NO_LOGO, '', ''),
				entry('Foreign', '1003', FOREIGN, '', 'https://evil.test/logo.png'),
				entry('EPG', '1004', EPG, '901', cache('44'))
			].join('\n');
			response.writeHead(200, { 'Content-Type': 'audio/x-mpegurl' });
			return response.end(text);
		}
		response.writeHead(200, { 'Content-Type': 'application/json' });
		return response.end(JSON.stringify({ results: [], next: null }));
	});
	await new Promise(resolve => dispatcharr.listen(0, '127.0.0.1', resolve));
	origin = 'http://127.0.0.1:' + dispatcharr.address().port;
	const local = createServer();
	await new Promise(resolve => local.listen(0, '127.0.0.1', resolve));
	Object.assign(process.env, {
		NODE_ENV: 'test', AUTH_DIR: directory, DATA_DIR: directory, CATALOGUE_CACHE_DIR: directory,
		DISPATCHARR_URL: origin, JELLYFIN_URL: 'http://127.0.0.1:1', PORT: String(local.address().port),
		LOCAL_HOSTS: '127.0.0.1', LOCAL_NETWORKS: '127.0.0.0/8', PUBLIC_ORIGIN: 'https://remote.test'
	});
	writeFileSync(path.join(directory, 'connection.json'), JSON.stringify({ userId: 'fixture', token: 'fixture-only' }));
	writeFileSync(path.join(directory, 'dispatcharr.json'), JSON.stringify({ key: 'fixture-only' }));
	writeFileSync(path.join(directory, 'capabilities.json'), JSON.stringify({
		jellyfin: false, library: false, live: true, nonstop: true, vod: false, recordings: false,
		catchup: false, discover: false, comingSoon: false, introdb: false, subtitles: false,
		managedInstallation: true, canShare: false, canDownload: false
	}));
	const { app } = await import('../server.mjs');
	local.on('request', app);
	const base = 'http://127.0.0.1:' + local.address().port;
	t.after(() => {
		local.closeAllConnections(); local.close();
		dispatcharr.closeAllConnections(); dispatcharr.close();
		try { rmSync(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }); } catch {}
	});

	const listResponse = await fetch(base + '/api/dispatcharr/channels');
	assert.equal(listResponse.status, 200);
	const list = await listResponse.json();
	const byName = new Map(list.items.map(item => [item.Name, item]));
	assert.equal(byName.size, 5);
	assert.equal(byName.get('24/7 Good').Artwork, '/api/dispatcharr/channels/' + GOOD + '/image?v=42');
	assert.equal(byName.get('24/7 EPG').Artwork, '/api/dispatcharr/channels/' + EPG + '/image?v=44');
	assert.equal(byName.get('24/7 Bad').Artwork, undefined, 'an upstream 404 is not advertised');
	assert.equal(byName.get('24/7 Missing').Artwork, undefined, 'a missing logo is not advertised');
	assert.equal(byName.get('24/7 Foreign').Artwork, undefined, 'a foreign logo is not advertised');

	const good = await fetch(base + '/api/dispatcharr/channels/' + GOOD + '/image?v=42');
	assert.equal(good.status, 200);
	assert.equal(good.headers.get('content-type'), 'image/png');
	assert.deepEqual(Buffer.from(await good.arrayBuffer()), png);

	const numericLogo = await fetch(base + '/api/dispatcharr/channels/42/image');
	assert.equal(numericLogo.status, 200, 'the numeric logo id still resolves');
	const numericEpg = await fetch(base + '/api/dispatcharr/channels/901/image');
	assert.equal(numericEpg.status, 200, 'the numeric EPG id still resolves');
	const bad = await fetch(base + '/api/dispatcharr/channels/43/image');
	assert.equal(bad.status, 404);
	const unknown = await fetch(base + '/api/dispatcharr/channels/999999/image');
	assert.equal(unknown.status, 404);
	assert.ok(requests.some(entry => entry.method === 'HEAD' && entry.url === '/api/channels/logos/43/cache/'), 'the playlist refresh probes logo health');
});
