/* Release 109 provider-label route regression.
 * Real server route, real vod-library raw mapping, mocked Dispatcharr catalogue
 * and provider endpoints. No live provider request or stream is opened.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';

const viewerToken = 'e'.repeat(64);
const viewerDevice = '2'.repeat(32);
const digest = value => createHash('sha256').update(value).digest('hex');

test('detail routes show the actual upstream provider for movie and series fixtures', { timeout: 30000 }, async t => {
	const directory = mkdtempSync(path.join(os.tmpdir(), 'source-labels-route-'));
	const servers = [];
	const listen = handler => new Promise((resolve, reject) => {
		const server = http.createServer(handler);
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => { servers.push(server); resolve(server); });
	});
	let providerCalls = 0;
	const dispatcharr = await listen((req, res) => {
		res.setHeader('Content-Type', 'application/json');
		if (req.url.includes('/providers/')) providerCalls++;
		const movie = id => ({
			id, name: id === 1 ? 'Label film' : 'Merged film', year: 2024, uuid: '1'.repeat(36),
			description: 'Fixture', genre: 'Drama', duration_secs: 5400, created_at: '2026-01-01T00:00:00Z'
		});
		if (req.url === '/api/vod/movies/1/') return res.end(JSON.stringify(movie(1)));
		if (req.url === '/api/vod/movies/1/providers/') return res.end(JSON.stringify([
			{ m3u_account: { id: 12, name: 'TorrentDay VOD (Merger)', priority: 5, is_active: true }, stream_id: '101' }
		]));
		if (req.url === '/api/vod/movies/3/') return res.end(JSON.stringify(movie(3)));
		if (req.url === '/api/vod/movies/3/providers/') return res.end(JSON.stringify([
			{ m3u_account: { id: 12, name: 'TorrentDay VOD (Merger)', priority: 5, is_active: true }, stream_id: '103' },
			{ m3u_account: { id: 10, name: 'Digital (Maxiumus)', priority: 20, is_active: true }, stream_id: '303' }
		]));
		if (req.url === '/api/vod/movies/4/') return res.end(JSON.stringify({ ...movie(4), id: 4, name: 'Unknown film' }));
		if (req.url === '/api/vod/movies/4/providers/') return res.end('[]');
		const series = {
			id: 2, name: 'Label series', year: 2024, uuid: '2'.repeat(36), description: 'Fixture', genre: 'Drama',
			created_at: '2026-01-01T00:00:00Z'
		};
		if (req.url === '/api/vod/series/2/') return res.end(JSON.stringify(series));
		if (req.url === '/api/vod/series/2/providers/') return res.end(JSON.stringify([
			{ m3u_account: { id: 10, name: 'Digital (Maxiumus)', priority: 20, is_active: true } }
		]));
		if (req.url === '/api/vod/series/2/episodes/') return res.end(JSON.stringify({ results: [] }));
		res.statusCode = 404;
		res.end('{}');
	});
	const upstream = await listen((req, res) => {
		res.setHeader('Content-Type', 'application/json');
		res.end(JSON.stringify({ Items: [], TotalRecordCount: 0 }));
	});
	const local = await listen();
	const now = Date.now();
	Object.assign(process.env, {
		NODE_ENV: 'test', AUTH_DIR: directory, DATA_DIR: directory,
		JELLYFIN_URL: `http://127.0.0.1:${upstream.address().port}`,
		DISPATCHARR_URL: `http://127.0.0.1:${dispatcharr.address().port}`,
		LOCAL_HOSTS: '127.0.0.1', LOCAL_NETWORKS: '127.0.0.0/8', PUBLIC_ORIGIN: 'https://remote.test'
	});
	writeFileSync(path.join(directory, 'connection.json'), JSON.stringify({ userId: 'test', token: 'fixture-only' }));
	writeFileSync(path.join(directory, 'apps.json'), JSON.stringify({
		[digest(viewerToken)]: { id: viewerDevice, name: 'Label viewer', status: 'approved', role: 'viewer', created: now, approved: now, expires: now + 3600000 }
	}));
	writeFileSync(path.join(directory, 'account-limits.json'), JSON.stringify({ accounts: {} }));
	writeFileSync(path.join(directory, 'remote-controls.json'), JSON.stringify({ enabled: true, vod: true, nonstop: true }));
	writeFileSync(path.join(directory, 'dispatcharr.json'), JSON.stringify({ key: 'fixture-only' }));
	const view = (id, type, name) => ({
		Id: id, Name: name, Type: type, Source: 'streamed', Provider: 'Dispatcharr', Genres: ['Drama'], ProviderIds: {},
		Artwork: `/api/web/art/${type === 'Series' ? 'series' : 'movie'}/${id.split('-').at(-1)}`
	});
	writeFileSync(path.join(directory, 'vod-catalogue.json'), JSON.stringify({ time: now, items: [
		view('dispatch-movie-1', 'Movie', 'Label film'),
		view('dispatch-series-2', 'Series', 'Label series'),
		view('dispatch-movie-3', 'Movie', 'Merged film'),
		view('dispatch-movie-4', 'Movie', 'Unknown film')
	] }));
	(await import('./enabled-fixture.mjs')).enableIntegrations();
	const { app } = await import('../server.mjs');
	local.on('request', app);
	const base = `http://127.0.0.1:${local.address().port}`;
	t.after(() => {
		for (const server of servers) { server.closeAllConnections(); server.close(); }
		rmSync(directory, { recursive: true, force: true });
	});
	const call = route => fetch(base + route, { headers: { Origin: base, Authorization: 'Bearer ' + viewerToken } });

	const movie = await call('/api/web/items/dispatch-movie-1');
	assert.equal(movie.status, 200, await movie.clone().text());
	const movieBody = await movie.json();
	assert.equal(movieBody.Source, 'streamed');
	assert.equal(movieBody.Provider, 'TorrentDay VOD (Merger)');

	const series = await call('/api/web/items/dispatch-series-2');
	assert.equal(series.status, 200, await series.clone().text());
	const seriesBody = await series.json();
	assert.equal(seriesBody.Provider, 'Digital (Maxiumus)');

	const merged = await call('/api/web/items/dispatch-movie-3');
	assert.equal((await merged.json()).Provider, 'Digital (Maxiumus)', 'highest-priority active provider wins');

	const unknown = await call('/api/web/items/dispatch-movie-4');
	assert.equal((await unknown.json()).Provider, 'Dispatcharr', 'missing provider uses the exact Dispatcharr fallback');

	const beforeList = providerCalls;
	const list = await call('/api/web/items?source=streamed');
	assert.equal(list.status, 200);
	const items = (await list.json()).items;
	// A series on the page may need a bounded availability check, but a list
	// must never fan out one provider request per card.
	assert.ok(providerCalls - beforeList <= 24, 'lists perform only bounded availability checks');
	assert.ok(items.every(item => item.Provider === 'Dispatcharr'), 'the list projection preserves the requested fallback');
});
