import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const itemId = 'a'.repeat(32);

test('local viewing stays on the origin and remote viewing gets signed CDN artwork', async t => {
	const directory = mkdtempSync(path.join(tmpdir(), 'tellybox-artwork-cdn-'));
	const servers = [];
	const listen = async handler => {
		const server = http.createServer(handler);
		await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
		servers.push(server);
		return server;
	};
	t.after(() => { for (const server of servers) { server.closeAllConnections(); server.close(); } rmSync(directory, { recursive: true, force: true }); });
	const item = {
		Id: itemId, Name: 'Synthetic film', Type: 'Movie', ImageTags: { Primary: 'primary-v1' },
		BackdropImageTags: ['backdrop-v1'], ProviderIds: { Tmdb: '603' }, DateCreated: '2026-01-01T00:00:00Z',
		UserData: { Played: false, PlaybackPositionTicks: 0 },
	};
	const imageRequests = [];
	const upstream = await listen((req, res) => {
		const url = new URL(req.url, 'http://upstream');
		if (url.pathname === '/Items' || url.pathname === '/Users/' + 'a'.repeat(32) + '/Items') {
			return res.end(JSON.stringify({ Items: [item], TotalRecordCount: 1 }));
		}
		if (url.pathname.startsWith('/Items/' + itemId + '/Images/')) {
			imageRequests.push({ path: url.pathname, tag: url.searchParams.get('tag'), auth: req.headers.authorization || req.headers['x-emby-token'] || '' });
			res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': png.length });
			return res.end(png);
		}
		if (url.pathname.startsWith('/Users/')) return res.end(JSON.stringify(item));
		res.writeHead(404, { 'Content-Type': 'text/plain' });
		res.end('not found');
	});
	const local = await listen();
	const remote = await listen();
	Object.assign(process.env, {
		NODE_ENV: 'test', PORT: String(local.address().port),
		JELLYFIN_URL: 'http://127.0.0.1:' + upstream.address().port,
		DATA_DIR: directory, AUTH_DIR: directory,
		PUBLIC_ORIGIN: 'https://watch.example.test',
		PUBLIC_ASSET_CDN_ORIGIN: 'https://cdn.example.test',
		PUBLIC_ARTWORK_CDN_SECRET: 'test-artwork-cdn-secret-0123456789abcdef',
		PUBLIC_ARTWORK_CDN_PRIVATE: '1',
		LOCAL_HOSTS: '127.0.0.1,localhost', LOCAL_NETWORKS: '127.0.0.0/8',
	});
	writeFileSync(path.join(directory, 'connection.json'), JSON.stringify({ userId: 'a'.repeat(32), token: 'synthetic-upstream-token' }));
	(await import('./enabled-fixture.mjs')).enableIntegrations();
	const { app } = await import('../server.mjs');
	local.on('request', app); remote.on('request', app);
	const base = side => 'http://127.0.0.1:' + (side === 'local' ? local : remote).address().port;
	const call = (side, route, { body, headers = {}, method } = {}) => fetch(base(side) + route, {
		method: method || (body ? 'POST' : 'GET'), redirect: 'manual',
		headers: { Origin: base(side), ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
		body: body ? JSON.stringify(body) : undefined,
	});
	const password = 'synthetic-artwork-password';
	assert.equal((await call('local', '/api/auth/password', { body: { password } })).status, 200);
	const login = await call('remote', '/api/auth/login', { body: { password } });
	assert.equal(login.status, 200);
	const cookie = login.headers.get('set-cookie').split(';')[0];

	const localPage = await (await call('local', '/')).text();
	assert.ok(localPage.includes('href="/style.css"'), 'local page keeps the local stylesheet');
	assert.ok(localPage.includes('src="/app.js"'), 'local page keeps local JavaScript');
	assert.ok(!localPage.includes('cdn.example.test'), 'local page has no CDN dependency');

	const remotePage = await (await call('remote', '/', { headers: { Cookie: cookie } })).text();
	assert.ok(remotePage.includes('href="/style.css"'), 'an unverified CDN asset stays on the origin');
	assert.ok(!remotePage.includes('cdn.example.test/tellybox/'), 'no unverified CDN asset URL is advertised');
	assert.ok(!remotePage.includes('data-tellybox-local'));
	assert.match(remotePage, /src="\/app\.js"/, 'JavaScript stays local and ordered');
	const remoteHeaders = await call('remote', '/', { headers: { Cookie: cookie } });
	const csp = remoteHeaders.headers.get('content-security-policy');
	assert.match(csp, /img-src[^;]*https:\/\/cdn\.example\.test/);
	assert.match(csp, /style-src[^;]*https:\/\/cdn\.example\.test/);
	assert.ok(!/script-src[^;]*cdn\.example\.test/.test(csp), 'JavaScript CDN is not allowed');

	const localItems = await (await call('local', '/api/web/items')).json();
	const localMovie = localItems.items.find(entry => entry.Id === itemId);
	assert.match(localMovie.Artwork, new RegExp(`^/images/${itemId}/Primary\\?width=400&v=[a-f0-9]{12}$`));
	assert.equal(localMovie.ArtworkLocal, undefined);

	const remoteItems = await (await call('remote', '/api/web/items', { headers: { Cookie: cookie } })).json();
	const remoteMovie = remoteItems.items.find(entry => entry.Id === itemId);
	assert.match(remoteMovie.Artwork, /^https:\/\/cdn\.example\.test\/tellybox\/art\//);
	assert.match(remoteMovie.ArtworkLocal, /^\/tellybox\/art\//);
	assert.ok(!remoteMovie.Artwork.includes(itemId), 'the token does not expose the library id');
	assert.match(remoteMovie.BackdropArtwork, /^https:\/\/cdn\.example\.test\/tellybox\/art\//);

	const signedPath = new URL(remoteMovie.Artwork).pathname;
	const image = await fetch(base('remote') + signedPath);
	assert.equal(image.status, 200);
	const cacheControl = image.headers.get('cache-control');
	assert.match(cacheControl, /^private, max-age=\d+, must-revalidate$/);
	assert.ok(!/public/i.test(cacheControl), 'a direct signed response is never public');
	const maxAge = Number(/max-age=(\d+)/.exec(cacheControl)[1]);
	assert.ok(maxAge > 0 && maxAge <= 300, 'the origin response cannot outlive the short private ticket');
	assert.equal(image.headers.get('access-control-allow-origin'), '*');
	assert.deepEqual(Buffer.from(await image.arrayBuffer()), png);
	assert.equal(imageRequests.at(-1).tag, 'primary-v1');
	assert.ok(imageRequests.at(-1).auth, 'the origin attaches the private provider credential');

	const head = await fetch(base('remote') + signedPath, { method: 'HEAD' });
	assert.equal(head.status, 200);
	assert.match(head.headers.get('cache-control'), /^private, max-age=\d+, must-revalidate$/);
	assert.equal(await head.text(), '', 'HEAD never returns an image body');

	// The caller must be authorized for the item, not just possess a trusted tag.
	const paused = await call('local', '/api/remote-controls', { body: { enabled: false, vod: true, nonstop: true } });
	assert.equal(paused.status, 200);
	const blockedItems = await (await call('remote', '/api/web/items', { headers: { Cookie: cookie } })).json();
	const blockedMovie = blockedItems.items.find(entry => entry.Id === itemId);
	assert.match(blockedMovie.Artwork, new RegExp(`^/images/${itemId}/Primary\\?width=400&v=[a-f0-9]{12}$`), 'a paused remote viewer gets no new private token');
	assert.equal(blockedMovie.ArtworkLocal, undefined);
	assert.match(blockedMovie.BackdropArtwork, new RegExp(`^/images/${itemId}/Backdrop\\?width=1280&v=[a-f0-9]{12}$`));
	const resumed = await call('local', '/api/remote-controls', { body: { enabled: true, vod: true, nonstop: true } });
	assert.equal(resumed.status, 200);

	const tampered = await fetch(base('remote') + signedPath.replace('/image.jpg', '/private.js'));
	assert.equal(tampered.status, 404);
	assert.equal(tampered.headers.get('cache-control'), 'no-store');

	const spoofed = await (await call('remote', '/api/web/items', { headers: { Cookie: cookie, 'X-Forwarded-For': '127.0.0.1', 'CF-Connecting-IP': '127.0.0.1' } })).json();
	const spoofedMovie = spoofed.items.find(entry => entry.Id === itemId);
	assert.match(spoofedMovie.Artwork, /^https:\/\/cdn\.example\.test\//, 'forwarded headers cannot make a remote request local');

	const capabilities = await (await call('remote', '/api/capabilities', { headers: { Cookie: cookie } })).json();
	assert.equal(capabilities.assetCdnOrigin, 'https://cdn.example.test');
});
