import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');

test('candidate discovery artwork routes return 200 for trusted fixture items', async t => {
	const directory = mkdtempSync(path.join(tmpdir(), 'tellybox-artwork-route-'));
	const servers = [];
	const listen = async handler => {
		const server = http.createServer(handler);
		await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
		servers.push(server);
		return server;
	};
	t.after(() => { for (const server of servers) { server.closeAllConnections(); server.close(); } rmSync(directory, { recursive: true, force: true }); });
	const rows = Array.from({ length: 20 }, (_, index) => ({
		id: 687100 + index, mediaType: 'movie', title: 'Fixture film ' + index,
		posterPath: '/fixture-' + index + '.jpg', releaseDate: '2026-01-01', voteAverage: 7, voteCount: 100,
	}));
	const seerr = await listen((req, res) => {
		const url = new URL(req.url, 'http://seerr');
		if (url.pathname === '/api/v1/discover/movies') {
			res.setHeader('content-type', 'application/json');
			return res.end(JSON.stringify({ page: 1, totalPages: 1, results: rows }));
		}
		if (/^\/api\/v1\/movie\/\d+$/.test(url.pathname)) {
			const id = Number(url.pathname.split('/').pop());
			const row = rows.find(entry => entry.id === id);
			res.setHeader('content-type', 'application/json');
			return res.end(JSON.stringify(row ? { ...row, id } : {}));
		}
		res.writeHead(404, { 'content-type': 'application/json' });
		res.end('{}');
	});
	const local = await listen();
	Object.assign(process.env, {
		NODE_ENV: 'test', PORT: String(local.address().port),
		DATA_DIR: directory, AUTH_DIR: directory, CATALOGUE_CACHE_DIR: directory,
		JELLYFIN_URL: 'http://127.0.0.1:1',
		LOCAL_HOSTS: '127.0.0.1,localhost', LOCAL_NETWORKS: '127.0.0.0/8',
		PUBLIC_ORIGIN: 'https://watch.example.test',
		PUBLIC_ARTWORK_CDN_ORIGIN: 'https://cdn.example.test',
		PUBLIC_ARTWORK_CDN_SECRET: 'test-artwork-cdn-secret-0123456789abcdef',
		PUBLIC_ARTWORK_CDN_PRIVATE: '1',
	});
	writeFileSync(path.join(directory, 'connection.json'), JSON.stringify({ userId: 'a'.repeat(32), token: 'synthetic-upstream-token' }));
	writeFileSync(path.join(directory, 'capabilities.json'), JSON.stringify({ library: false, jellyfin: false, live: false, nonstop: false, vod: false, recordings: false, catchup: false, discover: true, comingSoon: false, introdb: false, subtitles: false, managedInstallation: true, canShare: true, canDownload: true }));
	writeFileSync(path.join(directory, 'seerr.json'), JSON.stringify({ url: 'http://127.0.0.1:' + seerr.address().port, key: 'fixture-key' }));
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async (input, init) => {
		if (String(input).startsWith('https://image.tmdb.org/')) {
			return new Response(png, { headers: { 'content-type': 'image/png', 'content-length': String(png.length) } });
		}
		return originalFetch(input, init);
	};
	t.after(() => { globalThis.fetch = originalFetch; });
	const { app } = await import('../server.mjs');
	local.on('request', app);
	const base = 'http://127.0.0.1:' + local.address().port;
	const page = await (await fetch(base + '/api/discover?type=movie&page=1')).json();
	assert.equal(page.items.length, 20);
	const routes = [];
	for (const item of page.items) {
		assert.equal(item.poster, '/fixture-' + (item.id - 687100) + '.jpg');
		assert.match(item.Artwork, /^\/api\/web\/tmdb-art\/movie\/6871\d{2}\/poster$/);
		const image = await fetch(base + item.Artwork);
		assert.equal(image.status, 200, item.Artwork);
		assert.equal(image.headers.get('content-type'), 'image/png');
		const body = Buffer.from(await image.arrayBuffer());
		assert.deepEqual(body, png);
		routes.push({ id: item.id, artwork: item.Artwork, status: image.status,
			contentType: image.headers.get('content-type'), bytes: body.length });
	}
	console.log('ARTWORK_ROUTE_EVIDENCE ' + JSON.stringify({ count: routes.length, routes }));
});
