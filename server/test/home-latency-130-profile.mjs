/* Isolated Home phase profiler (not part of the normal suite).
 * Real server route, synthetic local/streamed catalogue, bounded local delays.
 * No provider stream, production request or credential.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';

const NOW = '2026-11-18T12:00:00Z';
const localId = index => ('b' + index.toString(16).padStart(31, '0')).slice(0, 32);
const localSeries = Array.from({ length: 10 }, (_, index) => ({
	Id: localId(index + 1), Name: 'Local series ' + (index + 1), Type: 'Series', Genres: ['Drama'],
	ProviderIds: { Tmdb: String(700 + index) }, DateCreated: NOW, ChildCount: 2,
	UserData: { Played: false, UnplayedItemCount: 1 }
}));
const localEpisode = series => ({
	Id: ('d' + series.Id.slice(1, 32)), Name: 'Episode', Type: 'Episode', SeriesId: series.Id,
	SeriesName: series.Name, ParentIndexNumber: 1, IndexNumber: 1, PremiereDate: '2026-11-01',
	UserData: { Played: false }
});
const localEpisodes = localSeries.map(localEpisode);
// The first four stand in for live series whose provider episode lookup never
// returns inside a Home budget (observed live: checked 7 / pending 4).
const slowIds = new Set([5000, 5001, 5002, 5003]);
const streamedRows = Array.from({ length: 24 }, (_, index) => ({
	id: 5000 + index, name: 'Streamed series ' + (index + 1), tmdb_id: 9000 + index,
	year: 2026, description: 'Fixture series', genre: 'Drama', created_at: NOW
}));
const streamedCatalogue = streamedRows.map(row => ({
	Id: `dispatch-series-${row.id}`, Name: row.name, Type: 'Series', Source: 'streamed', Provider: 'Dispatcharr',
	Genres: ['Drama'], ProviderIds: { Tmdb: String(row.tmdb_id) }, VodIds: [row.id],
	PremiereDate: '2026-01-01', DateCreated: NOW, Artwork: `/api/web/art/series/${row.id}`
}));
const activityEvents = [
	...localEpisodes.slice(0, 6).map((episode, index) => ({
		id: 'local-' + index, type: 'playback', local: true, itemId: episode.Id,
		seriesId: episode.SeriesId, position: 120 + index, duration: 3000, state: 'ended',
		time: Date.now() - index * 60000, updated: Date.now() - index * 60000
	})),
	...streamedRows.slice(0, 3).map((row, index) => ({
		id: 'streamed-' + index, type: 'playback', local: true,
		itemId: `dispatch-episode-${row.id * 10}-${row.id}`, seriesId: `dispatch-series-${row.id}`,
		position: 90 + index, duration: 3000, state: 'ended',
		time: Date.now() - 1000000 - index * 60000, updated: Date.now() - 1000000 - index * 60000
	})),
	...streamedRows.slice(4, 7).map((row, index) => ({
		id: 'missing-streamed-' + index, type: 'playback', local: true,
		itemId: `dispatch-episode-${row.id * 10}-${row.id}`, seriesId: `dispatch-series-${row.id}`,
		position: 40 + index, duration: 3000, state: 'ended',
		time: Date.now() - 900000 - index * 60000, updated: Date.now() - 900000 - index * 60000
	}))
];

const directory = mkdtempSync(path.join(tmpdir(), 'tellybox-home-latency-130-'));
const servers = [];
const listen = handler => new Promise(resolve => {
	const server = http.createServer(handler);
	server.listen(0, '127.0.0.1', () => { servers.push(server); resolve(server); });
});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const jellyfin = await listen(async (req, res) => {
	const url = new URL(req.url, 'http://127.0.0.1');
	res.setHeader('Content-Type', 'application/json');
	if (url.pathname === '/Items') return res.end(JSON.stringify({ Items: localSeries, TotalRecordCount: localSeries.length }));
	const item = /^\/Users\/[^/]+\/Items\/([^/]+)$/.exec(url.pathname);
	if (item) {
		const found = localSeries.find(series => series.Id === decodeURIComponent(item[1]));
		if (!found) { res.statusCode = 404; return res.end('{}'); }
		return res.end(JSON.stringify(found));
	}
	const episodes = /^\/Shows\/([^/]+)\/Episodes$/.exec(url.pathname);
	if (episodes) {
		await delay(220);
		const found = localSeries.find(series => series.Id === decodeURIComponent(episodes[1]));
		return res.end(JSON.stringify({ Items: found ? [localEpisode(found)] : [] }));
	}
	return res.end(JSON.stringify({ Items: [], TotalRecordCount: 0 }));
});
const dispatcharr = await listen(async (req, res) => {
	const url = new URL(req.url, 'http://127.0.0.1');
	res.setHeader('Content-Type', 'application/json');
	if (url.pathname === '/api/vod/movies/' || url.pathname === '/api/vod/movies') return res.end(JSON.stringify({ results: [], next: null }));
	if (url.pathname === '/api/vod/series/' || url.pathname === '/api/vod/series') return res.end(JSON.stringify({ results: streamedRows, next: null }));
	const episodes = /^\/api\/vod\/series\/(\d+)\/episodes\/$/.exec(url.pathname);
	if (episodes) {
		const id = Number(episodes[1]);
		await delay(slowIds.has(id) ? 5200 : 260);
		return res.end(JSON.stringify([]));
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
writeFileSync(path.join(directory, 'activity.json'), JSON.stringify(activityEvents));
const { app } = await import('../server.mjs');
local.on('request', app);
const base = `http://127.0.0.1:${local.address().port}`;
const results = [];
try {
	for (let run = 1; run <= 3; run++) {
		const started = performance.now();
		const response = await fetch(base + '/api/web/home', {
			method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: '{}'
		});
		const body = await response.json();
		results.push({ run, status: response.status, elapsedMs: Math.round(performance.now() - started),
			timing: JSON.parse(response.headers.get('x-tellybox-home-timing') || '{}'),
			rows: body.rows?.length, availability: body.availability });
	}
	// Give any in-flight 5.2 s fixture lookup time to settle, then prove the next
	// request reuses the saved result instead of paying the deadline again.
	await delay(6500);
	for (let run = 4; run <= 5; run++) {
		const started = performance.now();
		const response = await fetch(base + '/api/web/home', {
			method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: '{}'
		});
		const body = await response.json();
		results.push({ run, status: response.status, elapsedMs: Math.round(performance.now() - started),
			timing: JSON.parse(response.headers.get('x-tellybox-home-timing') || '{}'),
			rows: body.rows?.length, availability: body.availability });
	}
} finally {
	for (const server of servers) { server.closeAllConnections(); server.close(); }
	rmSync(directory, { recursive: true, force: true });
}
console.log(JSON.stringify(results, null, 2));
