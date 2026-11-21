/* Release 117 route regression: normal watch surfaces only return currently
 * playable series; Discover/Search may still show unavailable titles.
 *
 * Real server routes, real home feed and similar ranking, mocked Jellyfin and
 * Dispatcharr metadata. No provider stream, download or production request.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';

const token = '7'.repeat(64);
const deviceId = '8'.repeat(32);
const digest = value => createHash('sha256').update(value).digest('hex');
const localId = index => ('b' + index.toString(16).padStart(31, '0')).slice(0, 32);
const movieId = 'c'.repeat(32);
const NOW = '2026-11-12T12:00:00Z';
const seriesName = (kind, index) => `${kind} series ${index}`;

function localSeries(index, empty) {
	return {
		Id: localId(index), Name: seriesName(empty ? 'Empty local' : 'Playable local', index),
		Type: 'Series', Genres: ['Drama'], ProviderIds: { Tmdb: '7' + index },
		DateCreated: NOW, ChildCount: 2, UserData: { Played: false, UnplayedItemCount: empty ? 0 : 1 }
	};
}
function localEpisode(series, index) {
	return {
		Id: ('d' + index.toString(16).padStart(31, '0')).slice(0, 32), Name: 'Episode ' + index,
		Type: 'Episode', SeriesId: series.Id, SeriesName: series.Name,
		ParentIndexNumber: 1, IndexNumber: 1, PremiereDate: '2026-11-01', UserData: { Played: false }
	};
}
function streamedRow(id, name, fail = false) {
	return { id, name, tmdb_id: 8000 + id, year: 2026, description: 'Fixture', genre: 'Drama', created_at: NOW, fail };
}
function streamedEpisode(id, row) {
	return { id: id * 10, name: 'Streamed episode ' + id, series: { id, name: row.name }, season_number: 1, episode_number: 1, air_date: '2026-11-01' };
}

test('normal Series and Home exclude zero-episode local/streamed series and check replacements; Discover/Search still show them', { timeout: 60000 }, async t => {
	const emptyLocal = Array.from({ length: 10 }, (_, index) => localSeries(index + 1, true));
	const playableLocal = Array.from({ length: 10 }, (_, index) => localSeries(index + 11, false));
	const localFilm = { Id: movieId, Name: 'Local film', Type: 'Movie', Genres: ['Drama'], RunTimeTicks: 7200e7, DateCreated: NOW, ProviderIds: { Tmdb: '999' }, UserData: { Played: false } };
	const localShows = new Map();
	for (const series of emptyLocal) localShows.set(series.Id, []);
	for (const [index, series] of playableLocal.entries()) localShows.set(series.Id, [localEpisode(series, index + 1)]);
	const localCatalogue = [...emptyLocal, ...playableLocal, localFilm];

	const streamedRows = [];
	const streamedEpisodes = new Map();
	const failIds = new Set([1009, 1019]);
	for (let index = 1; index <= 20; index++) {
		const empty = index <= 10;
		const row = streamedRow(1000 + index, seriesName(empty ? 'Empty streamed' : 'Playable streamed', index));
		streamedRows.push(row);
		streamedEpisodes.set(row.id, failIds.has(row.id) ? null : empty ? [] : [streamedEpisode(row.id, row)]);
	}
	const streamedMovies = [];

	const directory = mkdtempSync(path.join(os.tmpdir(), 'playable-117-route-'));
	const servers = [];
	const listen = handler => new Promise((resolve, reject) => {
		const server = http.createServer(handler);
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => { servers.push(server); resolve(server); });
	});
	const calls = { providerEpisodes: 0, providerInfo: 0, localEpisodes: 0 };
	const upstream = await listen((req, res) => {
		const url = new URL(req.url, 'http://127.0.0.1');
		res.setHeader('Content-Type', 'application/json');
		if (url.pathname === '/Items') return res.end(JSON.stringify({ Items: localCatalogue, TotalRecordCount: localCatalogue.length }));
		const itemMatch = url.pathname.match(/^\/Users\/[^/]+\/Items\/([^/]+)$/);
		if (itemMatch) {
			const item = localCatalogue.find(value => value.Id === decodeURIComponent(itemMatch[1]));
			if (!item) { res.statusCode = 404; return res.end('{}'); }
			return res.end(JSON.stringify(item));
		}
		const showMatch = url.pathname.match(/^\/Shows\/([^/]+)\/Episodes$/);
		if (showMatch) {
			calls.localEpisodes++;
			return res.end(JSON.stringify({ Items: localShows.get(decodeURIComponent(showMatch[1])) || [] }));
		}
		if (url.pathname.startsWith('/Users/')) return res.end(JSON.stringify({ Items: [], TotalRecordCount: 0 }));
		res.end('{}');
	});
	const dispatcharr = await listen((req, res) => {
		const url = new URL(req.url, 'http://127.0.0.1');
		res.setHeader('Content-Type', 'application/json');
		if (url.pathname === '/api/vod/movies/' || url.pathname === '/api/vod/movies') return res.end(JSON.stringify({ results: streamedMovies, next: null }));
		if (url.pathname === '/api/vod/series/' || url.pathname === '/api/vod/series') return res.end(JSON.stringify({ results: streamedRows, next: null }));
		if (url.pathname === '/api/vod/movies/?page_size=1') return res.end(JSON.stringify({ results: [], next: null }));
		let match = url.pathname.match(/^\/api\/vod\/series\/(\d+)\/provider-info\/$/);
		if (match) { calls.providerInfo++; return res.end('{}'); }
		match = url.pathname.match(/^\/api\/vod\/series\/(\d+)\/episodes\/$/);
		if (match) {
			calls.providerEpisodes++;
			const id = Number(match[1]);
			const episodes = streamedEpisodes.get(id);
			if (episodes === null) { res.statusCode = 502; return res.end('{}'); }
			return res.end(JSON.stringify(episodes || []));
		}
		match = url.pathname.match(/^\/api\/vod\/series\/(\d+)\/$/);
		if (match) {
			const row = streamedRows.find(value => value.id === Number(match[1]));
			if (!row) { res.statusCode = 404; return res.end('{}'); }
			return res.end(JSON.stringify(row));
		}
		res.end(JSON.stringify({ results: [], next: null }));
	});
	const local = await listen();
	Object.assign(process.env, {
		NODE_ENV: 'test', AUTH_DIR: directory, DATA_DIR: directory,
		JELLYFIN_URL: `http://127.0.0.1:${upstream.address().port}`,
		DISPATCHARR_URL: `http://127.0.0.1:${dispatcharr.address().port}`,
		LOCAL_HOSTS: '127.0.0.1', LOCAL_NETWORKS: '127.0.0.0/8', PUBLIC_ORIGIN: 'https://remote.test'
	});
	writeFileSync(path.join(directory, 'connection.json'), JSON.stringify({ userId: 'test', token: 'fixture-only' }));
	writeFileSync(path.join(directory, 'apps.json'), JSON.stringify({
		[digest(token)]: { id: deviceId, name: 'Playable route fixture', status: 'approved', role: 'viewer', created: Date.now(), approved: Date.now(), expires: Date.now() + 3600000 }
	}));
	writeFileSync(path.join(directory, 'account-limits.json'), JSON.stringify({ accounts: {} }));
	writeFileSync(path.join(directory, 'remote-controls.json'), JSON.stringify({ enabled: true, vod: true, nonstop: true }));
	writeFileSync(path.join(directory, 'dispatcharr.json'), JSON.stringify({ key: 'fixture-only' }));
	const streamedCatalogue = streamedRows.map(row => ({
		Id: `dispatch-series-${row.id}`, Name: row.name, Type: 'Series', Source: 'streamed', Provider: 'Dispatcharr',
		Genres: ['Drama'], ProviderIds: { Tmdb: String(row.tmdb_id) }, VodIds: [row.id], PremiereDate: '2026-01-01', DateCreated: NOW, Artwork: `/api/web/art/series/${row.id}`
	}));
	writeFileSync(path.join(directory, 'vod-catalogue.json'), JSON.stringify({ time: Date.now(), items: streamedCatalogue }));
	(await import('./enabled-fixture.mjs')).enableIntegrations();
	const { app } = await import('../server.mjs');
	local.on('request', app);
	const base = `http://127.0.0.1:${local.address().port}`;
	t.after(() => {
		for (const server of servers) { server.closeAllConnections(); server.close(); }
		rmSync(directory, { recursive: true, force: true });
	});
	const call = (route, options = {}) => fetch(base + route, {
		...options,
		headers: { Origin: base, Authorization: 'Bearer ' + token, ...(options.body ? { 'Content-Type': 'application/json' } : {}) }
	});
	const emptyLocalIds = new Set(emptyLocal.map(item => item.Id));
	const emptyStreamedIds = new Set(Array.from({ length: 10 }, (_, index) => `dispatch-series-${1001 + index}`));
	const playableIds = new Set([...playableLocal.map(item => item.Id), ...Array.from({ length: 10 }, (_, index) => `dispatch-series-${1011 + index}`)]);

	// Normal Series: no zero-episode title, playable titles retained.
	const series = await call('/api/web/items?type=tvshows&start=0');
	assert.equal(series.status, 200, await series.clone().text());
	const seriesBody = await series.json();
	assert.ok(seriesBody.availability && Number.isFinite(seriesBody.availability.checked), 'availability diagnostics are present');
	assert.ok(seriesBody.items.length > 0, 'playable Series remain');
	assert.ok(seriesBody.items.every(item => !emptyLocalIds.has(item.Id) && !emptyStreamedIds.has(item.Id)), 'no zero-episode Series in normal browse');
	assert.ok(seriesBody.items.every(item => item.Type !== 'Series' || playableIds.has(item.Id)), 'only verified playable series are returned');

	// Home: empty series absent from every rail and featured; replacement
	// candidates are checked, so the feed is not just the first empty slice.
	const home = await call('/api/web/home', { method: 'POST', body: '{}' });
	assert.equal(home.status, 200, await home.clone().text());
	const feed = await home.json();
	const homeItems = [...(feed.rows || []).flatMap(row => row.items || []), ...(feed.featured || [])];
	const homeIds = new Set(homeItems.map(item => item.Id));
	assert.ok(homeItems.some(item => item.Type === 'Movie'), 'films remain');
	assert.ok(homeItems.some(item => item.Type === 'Series'), 'playable replacement series remain in Home');
	assert.ok([...homeIds].every(id => !emptyLocalIds.has(id) && !emptyStreamedIds.has(id)), 'no confirmed-empty or failed series in Home');
	assert.ok(![...homeIds].some(id => id === 'dispatch-series-1009' || id === 'dispatch-series-1019'), 'failing provider series are not trusted');
	assert.ok(feed.availability && feed.availability.checked <= 36, 'Home checks are bounded');

	// Similar: ranked candidates are checked, empty/failed series are removed.
	const similar = await call('/api/web/similar', { method: 'POST', body: JSON.stringify({ id: movieId, limit: 12 }) });
	assert.equal(similar.status, 200, await similar.clone().text());
	const similarBody = await similar.json();
	assert.ok(similarBody.items.some(item => item.Type === 'Series'), 'a playable similar series is returned');
	assert.ok(similarBody.items.every(item => !emptyLocalIds.has(item.Id) && !emptyStreamedIds.has(item.Id)), 'similar never returns an empty/failed series');

	// The default Search "available" scope reuses the playable normal list, so
	// it must not offer a known-empty local or streamed title either.
	const search = await call('/api/search?q=' + encodeURIComponent('Empty'));
	assert.equal(search.status, 200, await search.clone().text());
	const searchBody = await search.json();
	assert.ok((searchBody.items || []).every(item => !emptyLocalIds.has(item.Id) && !emptyStreamedIds.has(item.Id)), 'available Search keeps playable-only items');

	// Discover/Search exceptions are covered by the real browser regression and
	// the vod-library searchMatches/availability unit tests.

	// Bounded provider work: 40 series fixture must never be scanned wholesale.
	assert.ok(calls.providerEpisodes <= 40, `provider episode calls stay bounded, saw ${calls.providerEpisodes}`);
	assert.ok(calls.providerEpisodes + calls.providerInfo < 200, 'no 45k-style request storm');
	console.log('playable117-route', JSON.stringify({ series: seriesBody.items.length, homeRows: feed.rows.length, homeChecked: feed.availability.checked, similar: similarBody.items.length, calls }));
});
