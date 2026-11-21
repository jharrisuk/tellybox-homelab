/* Release 130 Home warm-cache regression.
 *
 * After the first bounded request proves the playable series, the next Home
 * request must reuse the saved availability instead of asking the provider
 * again, and must show exactly the same rows. Phase timing stays opt-in.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const NOW = '2026-11-18T12:00:00Z';
const localId = index => ('c' + index.toString(16).padStart(31, '0')).slice(0, 32);
const seriesRow = index => ({
	Id: localId(index), Name: 'Warm series ' + index, Type: 'Series', Genres: ['Drama'],
	ProviderIds: { Tmdb: String(900 + index) }, DateCreated: NOW, ChildCount: 1,
	UserData: { Played: false, UnplayedItemCount: 1 }
});
const episodeRow = series => ({
	Id: ('e' + series.Id.slice(1, 32)), Name: 'Episode', Type: 'Episode', SeriesId: series.Id,
	SeriesName: series.Name, ParentIndexNumber: 1, IndexNumber: 1, PremiereDate: '2026-11-01',
	UserData: { Played: false }
});
const localSeries = Array.from({ length: 6 }, (_, index) => seriesRow(index + 1));
const streamedRows = Array.from({ length: 8 }, (_, index) => ({
	id: 6200 + index, name: 'Warm streamed series ' + (index + 1), tmdb_id: 7200 + index,
	year: 2026, description: 'Fixture', genre: 'Drama', created_at: NOW
}));
const streamedCatalogue = streamedRows.map(row => ({
	Id: `dispatch-series-${row.id}`, Name: row.name, Type: 'Series', Source: 'streamed', Provider: 'Dispatcharr',
	Genres: ['Drama'], ProviderIds: { Tmdb: String(row.tmdb_id) }, VodIds: [row.id],
	PremiereDate: '2026-01-01', DateCreated: NOW, Artwork: `/api/web/art/series/${row.id}`
}));

test('a second Home request reuses saved availability and returns identical rows', { timeout: 45000 }, async t => {
	const directory = mkdtempSync(path.join(os.tmpdir(), 'home-latency-130-warm-'));
	const servers = [];
	const listen = handler => new Promise(resolve => {
		const server = http.createServer(handler);
		server.listen(0, '127.0.0.1', () => { servers.push(server); resolve(server); });
	});
	let providerEpisodeCalls = 0;
	const jellyfin = await listen((req, res) => {
		const url = new URL(req.url, 'http://127.0.0.1');
		res.setHeader('Content-Type', 'application/json');
		if (url.pathname === '/Items') return res.end(JSON.stringify({ Items: localSeries, TotalRecordCount: localSeries.length }));
		const item = /^\/Users\/[^/]+\/Items\/([^/]+)$/.exec(url.pathname);
		if (item) {
			const series = localSeries.find(entry => entry.Id === decodeURIComponent(item[1]));
			if (!series) { res.statusCode = 404; return res.end('{}'); }
			return res.end(JSON.stringify(series));
		}
		const episodes = /^\/Shows\/([^/]+)\/Episodes$/.exec(url.pathname);
		if (episodes) {
			const series = localSeries.find(entry => entry.Id === decodeURIComponent(episodes[1]));
			return res.end(JSON.stringify({ Items: series ? [episodeRow(series)] : [] }));
		}
		return res.end(JSON.stringify({ Items: [], TotalRecordCount: 0 }));
	});
	const dispatcharr = await listen(async (req, res) => {
		const url = new URL(req.url, 'http://127.0.0.1');
		res.setHeader('Content-Type', 'application/json');
		if (url.pathname === '/api/vod/movies/' || url.pathname === '/api/vod/movies') return res.end(JSON.stringify({ results: [], next: null }));
		if (url.pathname === '/api/vod/series/' || url.pathname === '/api/vod/series') return res.end(JSON.stringify({ results: streamedRows, next: null }));
		const info = /^\/api\/vod\/series\/(\d+)\/provider-info\/$/.exec(url.pathname);
		if (info) return res.end(JSON.stringify({ id: Number(info[1]) }));
		const episodes = /^\/api\/vod\/series\/(\d+)\/episodes\/$/.exec(url.pathname);
		if (episodes) {
			providerEpisodeCalls++;
			await new Promise(resolve => setTimeout(resolve, 120));
			const id = Number(episodes[1]);
			return res.end(JSON.stringify([{
				id: id * 10, name: 'Warm series ' + id + ' - S01E01 - Episode',
				series: { id }, season_number: 1, episode_number: 1,
				air_date: '2026-01-02', duration_secs: 2400, created_at: NOW
			}]));
		}
		const detail = /^\/api\/vod\/series\/(\d+)\/$/.exec(url.pathname);
		if (detail) {
			const row = streamedRows.find(entry => entry.id === Number(detail[1]));
			return res.end(JSON.stringify(row || {}));
		}
		return res.end(JSON.stringify({ results: [], next: null }));
	});
	const local = await listen();
	Object.assign(process.env, {
		NODE_ENV: 'test', AUTH_DIR: directory, DATA_DIR: directory, CATALOGUE_CACHE_DIR: directory,
		JELLYFIN_URL: `http://127.0.0.1:${jellyfin.address().port}`,
		DISPATCHARR_URL: `http://127.0.0.1:${dispatcharr.address().port}`,
		PORT: String(local.address().port), LOCAL_HOSTS: '127.0.0.1', LOCAL_NETWORKS: '127.0.0.0/8',
		PUBLIC_ORIGIN: 'https://remote.test', TELLYBOX_HOME_TIMING: '1'
	});
	writeFileSync(path.join(directory, 'connection.json'), JSON.stringify({ userId: 'fixture', token: 'fixture-only' }));
	writeFileSync(path.join(directory, 'apps.json'), JSON.stringify({}));
	writeFileSync(path.join(directory, 'account-limits.json'), JSON.stringify({ accounts: {} }));
	writeFileSync(path.join(directory, 'dispatcharr.json'), JSON.stringify({ key: 'fixture-only' }));
	writeFileSync(path.join(directory, 'capabilities.json'), JSON.stringify({
		jellyfin: true, library: true, live: false, nonstop: false, vod: true, recordings: false,
		catchup: false, discover: false, comingSoon: false, introdb: false, subtitles: false
	}));
	writeFileSync(path.join(directory, 'vod-catalogue.json'), JSON.stringify({ time: Date.now(), items: streamedCatalogue }));
	writeFileSync(path.join(directory, 'series-links.json'), JSON.stringify({}));
	const { app } = await import('../server.mjs');
	local.on('request', app);
	const base = `http://127.0.0.1:${local.address().port}`;
	t.after(() => {
		for (const server of servers) { server.closeAllConnections(); server.close(); }
		rmSync(directory, { recursive: true, force: true });
	});

	const call = async () => {
		const started = performance.now();
		const response = await fetch(base + '/api/web/home', {
			method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: '{}'
		});
		const elapsed = performance.now() - started;
		const text = await response.clone().text();
		assert.equal(response.status, 200, text);
		const timing = JSON.parse(response.headers.get('x-tellybox-home-timing') || 'null');
		return { feed: await response.json(), timing, elapsed };
	};
	const ids = feed => (feed.rows || []).map(row => [row.id, (row.items || []).map(item => item.Id)]);

	const cold = await call();
	assert.ok(cold.timing, 'opt-in phase timing is present when TELLYBOX_HOME_TIMING=1');
	for (const field of ['catalogueMs', 'continueMs', 'feedMs', 'artworkMs', 'totalMs']) {
		assert.equal(typeof cold.timing[field], 'number', 'timing includes ' + field);
	}
	assert.ok(Array.isArray(cold.timing.verifyRounds), 'timing includes verification rounds');
	assert.equal(typeof cold.timing.feedBuild.checked, 'number');

	const coldVisible = new Set([...(cold.feed.rows || []).flatMap(row => row.items || []), ...(cold.feed.featured || [])]
		.map(item => item && item.Id));
	const shownLocal = localSeries.filter(series => coldVisible.has(series.Id)).length;
	const shownStreamed = streamedCatalogue.filter(series => coldVisible.has(series.Id)).length;
	assert.ok(shownLocal > 0, 'the first request proves and shows local series');
	assert.ok(shownStreamed > 0, 'the first request proves and shows streamed series');
	for (const id of coldVisible) {
		assert.ok([...localSeries, ...streamedCatalogue].some(series => series.Id === id),
			'only proven catalogue series are shown: ' + id);
	}
	const callsAfterCold = providerEpisodeCalls;

	const warm = await call();
	assert.ok(warm.elapsed < 800, 'the warm request reuses saved availability, took ' + Math.round(warm.elapsed) + 'ms');
	assert.equal(warm.feed.availability.checked, 0, 'the warm request checks no series again');
	assert.equal(providerEpisodeCalls, callsAfterCold, 'the warm request makes no provider episode call');
	assert.deepEqual(ids(warm.feed), ids(cold.feed), 'the warm request returns the same rows and items');
});
