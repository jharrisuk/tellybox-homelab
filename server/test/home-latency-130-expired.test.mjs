/* Release 130 expired-budget route regression.
 *
 * The absolute Home budget starts before the catalogue merge. When the
 * catalogue itself consumes it, the route must return promptly with the
 * saved availability only: no provider episode verification may start, no
 * unproven series may be shown, and Continue membership that does not need a
 * lookup (a partially watched film) must survive.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const NOW = '2026-11-18T12:00:00Z';
const localId = index => ('e' + index.toString(16).padStart(31, '0')).slice(0, 32);
const film = {
	Id: 'f'.repeat(32), Name: 'Half watched film', Type: 'Movie', Genres: ['Drama'],
	ProviderIds: { Tmdb: '4242' }, RunTimeTicks: 7200e7, DateCreated: NOW,
	UserData: { Played: false, PlaybackPositionTicks: 0 }
};
const localSeries = {
	Id: localId(1), Name: 'Local show', Type: 'Series', Genres: ['Drama'],
	ProviderIds: { Tmdb: '5151' }, DateCreated: NOW, ChildCount: 2,
	UserData: { Played: false, UnplayedItemCount: 2 }
};
const streamedRow = { id: 9401, name: 'Streamed show', tmdb_id: 6262, year: 2026, description: 'Fixture', genre: 'Drama', created_at: NOW };
const streamedSeries = {
	Id: `dispatch-series-${streamedRow.id}`, Name: streamedRow.name, Type: 'Series', Source: 'streamed', Provider: 'Dispatcharr',
	Genres: ['Drama'], ProviderIds: { Tmdb: String(streamedRow.tmdb_id) }, VodIds: [streamedRow.id],
	PremiereDate: '2026-01-01', DateCreated: NOW, Artwork: `/api/web/art/series/${streamedRow.id}`
};
const CATALOGUE_DELAY_MS = 2400;

test('an exhausted budget after the catalogue starts no verification and keeps Continue', { timeout: 45000 }, async t => {
	const directory = mkdtempSync(path.join(os.tmpdir(), 'home-latency-130-expired-'));
	const servers = [];
	const listen = handler => new Promise(resolve => {
		const server = http.createServer(handler);
		server.listen(0, '127.0.0.1', () => { servers.push(server); resolve(server); });
	});
	const calls = { showEpisodes: 0, providerEpisodes: 0, providerInfo: 0 };
	const jellyfin = await listen(async (req, res) => {
		const url = new URL(req.url, 'http://127.0.0.1');
		res.setHeader('Content-Type', 'application/json');
		if (url.pathname === '/Items') {
			await new Promise(resolve => setTimeout(resolve, CATALOGUE_DELAY_MS));
			return res.end(JSON.stringify({ Items: [film, localSeries], TotalRecordCount: 2 }));
		}
		const item = /^\/Users\/[^/]+\/Items\/([^/]+)$/.exec(url.pathname);
		if (item) {
			const key = decodeURIComponent(item[1]);
			const found = [film, localSeries].find(entry => entry.Id === key);
			if (!found) { res.statusCode = 404; return res.end('{}'); }
			return res.end(JSON.stringify(found));
		}
		const episodes = /^\/Shows\/([^/]+)\/Episodes$/.exec(url.pathname);
		if (episodes) {
			calls.showEpisodes += 1;
			return res.end(JSON.stringify({ Items: [] }));
		}
		return res.end(JSON.stringify({ Items: [], TotalRecordCount: 0 }));
	});
	const dispatcharr = await listen((req, res) => {
		const url = new URL(req.url, 'http://127.0.0.1');
		res.setHeader('Content-Type', 'application/json');
		if (url.pathname === '/api/vod/movies/' || url.pathname === '/api/vod/movies') return res.end(JSON.stringify({ results: [], next: null }));
		if (url.pathname === '/api/vod/series/' || url.pathname === '/api/vod/series') return res.end(JSON.stringify({ results: [streamedRow], next: null }));
		if (/^\/api\/vod\/series\/\d+\/provider-info\/$/.test(url.pathname)) {
			calls.providerInfo += 1;
			return res.end(JSON.stringify({ id: 9401 }));
		}
		if (/^\/api\/vod\/series\/\d+\/episodes\/$/.test(url.pathname)) {
			calls.providerEpisodes += 1;
			return res.end(JSON.stringify([]));
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
	writeFileSync(path.join(directory, 'vod-catalogue.json'), JSON.stringify({ time: Date.now(), items: [streamedSeries] }));
	writeFileSync(path.join(directory, 'series-links.json'), JSON.stringify({}));
	const { app } = await import('../server.mjs');
	local.on('request', app);
	const base = `http://127.0.0.1:${local.address().port}`;
	t.after(() => {
		for (const server of servers) { server.closeAllConnections(); server.close(); }
		rmSync(directory, { recursive: true, force: true });
	});

	const started = performance.now();
	const response = await fetch(base + '/api/web/home', {
		method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base },
		body: JSON.stringify({ progress: { [film.Id]: 120 } })
	});
	const elapsed = performance.now() - started;
	const text = await response.clone().text();
	assert.equal(response.status, 200, text);
	const feed = await response.json();
	const timing = JSON.parse(response.headers.get('x-tellybox-home-timing') || 'null');
	assert.ok(timing, 'the phase timing header is available for this diagnostic run');
	assert.ok(timing.catalogueMs >= CATALOGUE_DELAY_MS - 100,
		'the catalogue used the budget, saw ' + timing.catalogueMs + 'ms');
	assert.ok(timing.feedMs - timing.catalogueMs < 500,
		'no extra verification window after the catalogue, feed added ' + Math.round(timing.feedMs - timing.catalogueMs) + 'ms');
	assert.ok(timing.totalMs < CATALOGUE_DELAY_MS + 900,
		'the total stays near the catalogue instead of stacking another budget, saw ' + timing.totalMs + 'ms');

	// The slow catalogue is the whole budget. The route returns right after it
	// instead of granting Continue or the feed a fresh window.
	assert.ok(elapsed >= CATALOGUE_DELAY_MS - 100, 'the catalogue really used the budget, took ' + Math.round(elapsed) + 'ms');
	assert.ok(elapsed < CATALOGUE_DELAY_MS + 1200, 'no deadline was restarted after the catalogue, took ' + Math.round(elapsed) + 'ms');

	assert.deepEqual(calls, { showEpisodes: 0, providerEpisodes: 0, providerInfo: 0 },
		'an exhausted budget starts no upstream verification');
	assert.equal(feed.availability.checked, 0, 'no series was checked');

	const visible = new Set([...(feed.rows || []).flatMap(row => row.items || []), ...(feed.featured || [])]
		.map(item => item && item.Id));
	assert.ok(!visible.has(localSeries.Id), 'an unproven local series stays hidden');
	assert.ok(!visible.has(streamedSeries.Id), 'an unproven streamed series stays hidden');
	assert.ok(visible.has(film.Id), 'a film does not need series verification');
	const continueRow = (feed.rows || []).find(row => row.id === 'continue');
	assert.ok(continueRow, 'Continue still exists');
	assert.ok((continueRow.items || []).some(item => item.Id === film.Id),
		'Continue membership is preserved without new verification');
});
