/* Release 130 Home latency regression.
 *
 * The deployed 0.26.35 Home route could hold a request for ~5 s: Continue and
 * the playable-series check ran one after the other, each with its own
 * deadline, and every verification round retried the same unresolved series.
 *
 * This fixture reproduces the shape: a few streamed series whose provider
 * episode lookup never answers inside a Home request. The route must
 *
 *  - answer inside one bounded budget instead of stacking Continue + feed,
 *  - ask the provider at most once per request for each slow series,
 *  - keep the playable-only rail (an unproven series is never shown),
 *  - still return the exact unfinished episode in Continue,
 *  - and leave the phase-timing header opt-in.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const NOW = '2026-11-18T12:00:00Z';
const localId = index => ('b' + index.toString(16).padStart(31, '0')).slice(0, 32);
const seriesRow = index => ({
	Id: localId(index), Name: 'Verified series ' + index, Type: 'Series', Genres: ['Drama'],
	ProviderIds: { Tmdb: String(800 + index) }, DateCreated: NOW, ChildCount: 1,
	UserData: { Played: false, UnplayedItemCount: 1 }
});
const episodeRow = series => ({
	Id: ('d' + series.Id.slice(1, 32)), Name: 'Episode 1', Type: 'Episode', SeriesId: series.Id,
	SeriesName: series.Name, ParentIndexNumber: 1, IndexNumber: 1, PremiereDate: '2026-11-01',
	UserData: { Played: false }
});
const localSeries = Array.from({ length: 6 }, (_, index) => seriesRow(index + 1));
const streamedRows = Array.from({ length: 4 }, (_, index) => ({
	id: 6100 + index, name: 'Slow streamed series ' + (index + 1), tmdb_id: 7100 + index,
	year: 2026, description: 'Fixture', genre: 'Drama', created_at: NOW
}));
const streamedCatalogue = streamedRows.map(row => ({
	Id: `dispatch-series-${row.id}`, Name: row.name, Type: 'Series', Source: 'streamed', Provider: 'Dispatcharr',
	Genres: ['Drama'], ProviderIds: { Tmdb: String(row.tmdb_id) }, VodIds: [row.id],
	PremiereDate: '2026-01-01', DateCreated: NOW, Artwork: `/api/web/art/series/${row.id}`
}));

test('a slow provider series cannot stack Continue and feed deadlines or be retried per round', { timeout: 45000 }, async t => {
	const directory = mkdtempSync(path.join(os.tmpdir(), 'home-latency-130-route-'));
	const servers = [];
	const listen = handler => new Promise(resolve => {
		const server = http.createServer(handler);
		server.listen(0, '127.0.0.1', () => { servers.push(server); resolve(server); });
	});
	const episodeCalls = new Map();
	const jellyfin = await listen(async (req, res) => {
		const url = new URL(req.url, 'http://127.0.0.1');
		res.setHeader('Content-Type', 'application/json');
		if (url.pathname === '/Items') return res.end(JSON.stringify({ Items: localSeries, TotalRecordCount: localSeries.length }));
		const item = /^\/Users\/[^/]+\/Items\/([^/]+)$/.exec(url.pathname);
		if (item) {
			const key = decodeURIComponent(item[1]);
			const series = localSeries.find(entry => entry.Id === key);
			if (series) return res.end(JSON.stringify(series));
			const episode = localSeries.map(episodeRow).find(entry => entry.Id === key);
			if (episode) return res.end(JSON.stringify(episode));
			res.statusCode = 404; return res.end('{}');
		}
		const episodes = /^\/Shows\/([^/]+)\/Episodes$/.exec(url.pathname);
		if (episodes) {
			const series = localSeries.find(entry => entry.Id === decodeURIComponent(episodes[1]));
			return res.end(JSON.stringify({ Items: series ? [episodeRow(series)] : [] }));
		}
		return res.end(JSON.stringify({ Items: [], TotalRecordCount: 0 }));
	});
	const dispatcharr = await listen((req, res) => {
		const url = new URL(req.url, 'http://127.0.0.1');
		res.setHeader('Content-Type', 'application/json');
		if (url.pathname === '/api/vod/movies/' || url.pathname === '/api/vod/movies') return res.end(JSON.stringify({ results: [], next: null }));
		if (url.pathname === '/api/vod/series/' || url.pathname === '/api/vod/series') return res.end(JSON.stringify({ results: streamedRows, next: null }));
		const info = /^\/api\/vod\/series\/(\d+)\/provider-info\/$/.exec(url.pathname);
		if (info) return res.end(JSON.stringify({ id: Number(info[1]) }));
		const episodes = /^\/api\/vod\/series\/(\d+)\/episodes\/$/.exec(url.pathname);
		if (episodes) {
			const id = Number(episodes[1]);
			episodeCalls.set(id, (episodeCalls.get(id) || 0) + 1);
			// Never answers inside the Home budget: this is the live shape.
			setTimeout(() => { try { res.end('[]'); } catch {} }, 4000);
			return;
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
		PUBLIC_ORIGIN: 'https://remote.test'
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

	const exact = episodeRow(localSeries[0]);
	const started = performance.now();
	const response = await fetch(base + '/api/web/home', {
		method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base },
		body: JSON.stringify({ progress: { [exact.Id]: 240 } })
	});
	const elapsed = performance.now() - started;
	const text = await response.clone().text();
	assert.equal(response.status, 200, text);
	const feed = await response.json();

	// One bounded Home budget (1.5 s deadline + parsing) instead of Continue's
	// 2 s plus the feed's 3.5 s in series.
	assert.ok(elapsed < 2600, 'Home answers inside its bounded budget, took ' + Math.round(elapsed) + 'ms');

	// Every slow series is attempted once for this request, not once per round.
	const slowIds = streamedRows.map(row => row.id);
	for (const id of slowIds) {
		assert.ok((episodeCalls.get(id) || 0) <= 1,
			'slow series ' + id + ' is asked at most once, saw ' + (episodeCalls.get(id) || 0));
	}

	const visible = new Set([...(feed.rows || []).flatMap(row => row.items || []), ...(feed.featured || [])]
		.map(item => item && item.Id));
	for (const series of streamedCatalogue) {
		assert.equal(visible.has(series.Id), false,
			'an unverified streamed series is never shown: ' + series.Name);
	}
	const proven = localSeries.filter(series => visible.has(series.Id));
	assert.ok(proven.length > 0, 'series whose saved episodes prove them stay visible');

	const continueRow = (feed.rows || []).find(row => row.id === 'continue');
	assert.ok(continueRow, 'Continue still exists');
	const episode = (continueRow.items || []).find(item => item.Id === exact.Id);
	assert.ok(episode, 'the exact unfinished episode is still returned');
	assert.equal(episode.Type, 'Episode');
	assert.equal(episode.UserData.PlaybackPositionTicks, 240e7);

	assert.equal(response.headers.get('x-tellybox-home-timing'), null,
		'phase timings stay opt-in and are not exposed by default');
});
