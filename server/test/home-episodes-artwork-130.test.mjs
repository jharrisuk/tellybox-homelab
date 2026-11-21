/* Release 130 New-episodes artwork regression.
 *
 * The New-episodes rail is synthesised in the browser from
 * /api/web/releases/episodes, so its cards never reach the Home artwork
 * warmer. Live evidence on 0.26.35: the episodes endpoint returned
 * `/api/web/art/series/<vodId>`, which answered 404 for every series in the
 * rail, while the same series' Home card used a warm
 * `/api/web/tmdb-art/tv/<tmdb>/poster` that answered 200 image/jpeg.
 *
 * The endpoint must therefore point each episode at its parent series'
 * already-known artwork, without requesting metadata, inventing a path, or
 * relaxing any visibility rule.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const NOW = '2026-11-18T12:00:00Z';
const localId = 'a'.repeat(32);
const localSeries = {
	Id: localId, Name: 'Local show', Type: 'Series', Genres: ['Drama'],
	ProviderIds: { Tmdb: '1111' }, DateCreated: NOW, ChildCount: 1,
	// A real local parent with a Jellyfin Primary image tag.
	ImageTags: { Primary: 'local-series-primary' },
	UserData: { Played: false, UnplayedItemCount: 1 }
};
const localEpisode = {
	Id: 'b'.repeat(32), Name: 'Local episode', Type: 'Episode', SeriesId: localId, SeriesName: localSeries.Name,
	ParentIndexNumber: 1, IndexNumber: 1, PremiereDate: '2026-11-01', UserData: { Played: false }
};
const warmRow = { id: 7301, name: 'Warm poster show', tmdb_id: 278573, year: 2026, description: 'Fixture', genre: 'Drama', created_at: NOW };
const bareRow = { id: 7302, name: 'No public poster show', year: 2026, description: 'Fixture', genre: 'Drama', created_at: NOW };
const coldRow = { id: 7303, name: 'Cold poster show', tmdb_id: 550, year: 2026, description: 'Fixture', genre: 'Drama', created_at: NOW };
const warmSeries = {
	Id: `dispatch-series-${warmRow.id}`, Name: warmRow.name, Type: 'Series', Source: 'streamed', Provider: 'Dispatcharr',
	Genres: ['Drama'], ProviderIds: { Tmdb: String(warmRow.tmdb_id) }, VodIds: [warmRow.id],
	PremiereDate: '2026-01-01', DateCreated: NOW, Artwork: `/api/web/art/series/${warmRow.id}`
};
const bareSeries = {
	Id: `dispatch-series-${bareRow.id}`, Name: bareRow.name, Type: 'Series', Source: 'streamed', Provider: 'Dispatcharr',
	Genres: ['Drama'], VodIds: [bareRow.id], PremiereDate: '2026-01-01', DateCreated: NOW,
	Artwork: `/api/web/art/series/${bareRow.id}`
};
const coldSeries = {
	Id: `dispatch-series-${coldRow.id}`, Name: coldRow.name, Type: 'Series', Source: 'streamed', Provider: 'Dispatcharr',
	Genres: ['Drama'], ProviderIds: { Tmdb: String(coldRow.tmdb_id) }, VodIds: [coldRow.id],
	PremiereDate: '2026-01-01', DateCreated: NOW, Artwork: `/api/web/art/series/${coldRow.id}`
};

test('new-episode cards use the parent series artwork that Home already proved', { timeout: 45000 }, async t => {
	const directory = mkdtempSync(path.join(os.tmpdir(), 'home-episodes-artwork-130-'));
	const servers = [];
	const listen = handler => new Promise(resolve => {
		const server = http.createServer(handler);
		server.listen(0, '127.0.0.1', () => { servers.push(server); resolve(server); });
	});
	const jellyfin = await listen((req, res) => {
		const url = new URL(req.url, 'http://127.0.0.1');
		res.setHeader('Content-Type', 'application/json');
		if (url.pathname === '/Items') return res.end(JSON.stringify({ Items: [localSeries], TotalRecordCount: 1 }));
		const item = /^\/Users\/[^/]+\/Items\/([^/]+)$/.exec(url.pathname);
		if (item) {
			const key = decodeURIComponent(item[1]);
			if (key === localSeries.Id) return res.end(JSON.stringify(localSeries));
			if (key === localEpisode.Id) return res.end(JSON.stringify(localEpisode));
			res.statusCode = 404; return res.end('{}');
		}
		const episodes = /^\/Shows\/([^/]+)\/Episodes$/.exec(url.pathname);
		if (episodes) {
			const key = decodeURIComponent(episodes[1]);
			return res.end(JSON.stringify({ Items: key === localId ? [localEpisode] : [] }));
		}
		return res.end(JSON.stringify({ Items: [], TotalRecordCount: 0 }));
	});
	const dispatcharr = await listen((req, res) => {
		const url = new URL(req.url, 'http://127.0.0.1');
		res.setHeader('Content-Type', 'application/json');
		if (url.pathname === '/api/vod/movies/' || url.pathname === '/api/vod/movies') return res.end(JSON.stringify({ results: [], next: null }));
		if (url.pathname === '/api/vod/series/' || url.pathname === '/api/vod/series') return res.end(JSON.stringify({ results: [warmRow, bareRow, coldRow], next: null }));
		const info = /^\/api\/vod\/series\/(\d+)\/provider-info\/$/.exec(url.pathname);
		if (info) return res.end(JSON.stringify({ id: Number(info[1]) }));
		const episodes = /^\/api\/vod\/series\/(\d+)\/episodes\/$/.exec(url.pathname);
		if (episodes) {
			const id = Number(episodes[1]);
			return res.end(JSON.stringify([{
				id: id * 10, name: 'Show ' + id + ' - S01E01 - Episode',
				series: { id }, season_number: 1, episode_number: 1,
				air_date: '2026-01-02', duration_secs: 2400, created_at: NOW
			}]));
		}
		const detail = /^\/api\/vod\/series\/(\d+)\/$/.exec(url.pathname);
		if (detail) {
			const row = [warmRow, bareRow, coldRow].find(entry => entry.id === Number(detail[1]));
			return res.end(JSON.stringify(row || {}));
		}
		return res.end(JSON.stringify({ results: [], next: null }));
	});
	const seerr = await listen((req, res) => {
		const url = new URL(req.url, 'http://127.0.0.1');
		res.setHeader('Content-Type', 'application/json');
		const match = /^\/api\/v1\/tv\/(\d+)$/.exec(url.pathname);
		if (match) {
			const id = Number(match[1]);
			return res.end(JSON.stringify({
				id, overview: 'Fixture metadata.', firstAirDate: '2026-01-01', posterPath: '/cold-poster.jpg',
				voteAverage: 7, voteCount: 20, genres: [{ name: 'Drama' }]
			}));
		}
		return res.end(JSON.stringify({ results: [] }));
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
	writeFileSync(path.join(directory, 'seerr.json'), JSON.stringify({ url: `http://127.0.0.1:${seerr.address().port}`, key: 'fixture-key' }));
	writeFileSync(path.join(directory, 'capabilities.json'), JSON.stringify({
		jellyfin: true, library: true, live: false, nonstop: false, vod: true, recordings: false,
		catchup: false, discover: true, comingSoon: false, introdb: false, subtitles: false
	}));
	writeFileSync(path.join(directory, 'vod-catalogue.json'), JSON.stringify({ time: Date.now(), items: [warmSeries, bareSeries, coldSeries] }));
	writeFileSync(path.join(directory, 'series-links.json'), JSON.stringify({}));
	// The same warm entry the Home artwork warmer writes: only the validated
	// public TMDB filename, never a provider URL or credential.
	writeFileSync(path.join(directory, 'vod-metadata.json'), JSON.stringify([[
		`tv/${warmRow.tmdb_id}`,
		{ schema: 2, time: Date.now(), retry: Date.now() + 86400000, data: { poster: '/warm-poster.jpg', backdrop: '/warm-backdrop.jpg' } }
	]]));
	const { app } = await import('../server.mjs');
	local.on('request', app);
	const base = `http://127.0.0.1:${local.address().port}`;
	t.after(() => {
		for (const server of servers) { server.closeAllConnections(); server.close(); }
		rmSync(directory, { recursive: true, force: true });
	});

	const query = [localId, warmSeries.Id, bareSeries.Id, coldSeries.Id].join(',');
	const response = await fetch(base + '/api/web/releases/episodes?series=' + encodeURIComponent(query),
		{ headers: { Origin: base } });
	const text = await response.clone().text();
	assert.equal(response.status, 200, text);
	const body = await response.json();
	const bySeries = new Map();
	for (const item of body.items || []) {
		if (!bySeries.has(item.SeriesId)) bySeries.set(item.SeriesId, item);
	}

	const localCopy = bySeries.get(localId);
	assert.ok(localCopy, 'the local episode is returned');
	assert.equal(localCopy.Artwork, `/images/${localId}/Primary?width=400`,
		'a local episode without its own still uses the local series image route');

	const warmCopy = bySeries.get(warmSeries.Id);
	assert.ok(warmCopy, 'the streamed episode is returned');
	assert.equal(warmCopy.Artwork, `/api/web/tmdb-art/tv/${warmRow.tmdb_id}/poster`,
		'the warm public poster of the parent series is reused');

	const bareCopy = bySeries.get(bareSeries.Id);
	assert.ok(bareCopy, 'the series without any public poster is still returned');
	assert.equal(bareCopy.Artwork, `/api/web/art/series/${bareRow.id}`,
		'without parent artwork the existing provider route is kept, not invented');

	// A show that is not yet in the metadata cache is warmed through the same
	// bounded service Home uses, inside the endpoint's own 200 ms artwork slice.
	const coldCopy = bySeries.get(coldSeries.Id);
	assert.ok(coldCopy, 'the not-yet-warmed series episode is returned');
	assert.equal(coldCopy.Artwork, `/api/web/tmdb-art/tv/${coldRow.tmdb_id}/poster`,
		'a missing parent poster is warmed and applied in the same answer');

	assert.equal(warmCopy.Id, `dispatch-episode-${warmRow.id * 10}-${warmRow.id}`,
		'the episode identity and playback target are untouched');
	assert.equal(warmCopy.Type, 'Episode');
	assert.equal(warmCopy.SeriesId, warmSeries.Id, 'the parent series relationship is unchanged');
});
