/* Release 131 regression: a local library episode must not be painted with the
 * streamed duplicate's provider artwork alias.
 *
 * Live reproduction (deployed 0.26.36):
 *   Slow Horses            local 77fee… / VOD 7357   /images/…/Primary 200, /api/web/art/series/7357 404
 *   New Stanford Prison…   local e8551… / VOD 10260  /images/…/Primary 200, /api/web/art/series/10260 404
 *   Apocalypse S1E7        local 90917… / VOD 10333  /images/…/Backdrop 200, /api/web/art/series/10333 404
 *
 * mergeEpisodes() keeps the local episode identity but lets it inherit the
 * streamed row's `Artwork: /api/web/art/series/<vodId>` alias. The provider art
 * route reads the provider detail (no logo/TMDB id) and 404s, so the
 * New-episodes card and the Continue backdrop stayed blank even though the
 * show's Jellyfin image was served at 200.
 *
 * These tests use the real routes and a real merged library build.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const NOW = '2026-11-18T12:00:00Z';
const localId = '1'.repeat(32);
const localEpisodeId = '2'.repeat(32);
const localEpisodeTwoId = '3'.repeat(32);
const mergedVodId = 9401;
const bareVodId = 9402;
const tmdbVodId = 9403;
const localTmdb = 95480;

const localSeries = {
	Id: localId, Name: 'Slow Horses', Type: 'Series', Genres: ['Drama'],
	ProviderIds: { Tmdb: String(localTmdb) }, DateCreated: NOW, ChildCount: 1,
	ImageTags: { Primary: 'series-primary-tag' }, BackdropImageTags: ['series-backdrop-tag'],
	UserData: { Played: false, UnplayedItemCount: 1 }
};
const localEpisode = {
	Id: localEpisodeId, Name: 'Episode one', Type: 'Episode', SeriesId: localId, SeriesName: localSeries.Name,
	ParentIndexNumber: 1, IndexNumber: 1, PremiereDate: '2026-11-01', RunTimeTicks: 2400e7,
	ImageTags: {}, ParentBackdropItemId: localId, ParentBackdropImageTags: ['series-backdrop-tag'],
	UserData: { Played: false }
};
const localEpisodeTwo = {
	Id: localEpisodeTwoId, Name: 'Episode two', Type: 'Episode', SeriesId: localId, SeriesName: localSeries.Name,
	ParentIndexNumber: 1, IndexNumber: 2, PremiereDate: '2026-11-02', RunTimeTicks: 2400e7,
	ImageTags: { Primary: 'episode-two-still' }, ParentBackdropItemId: localId,
	ParentBackdropImageTags: ['series-backdrop-tag'], UserData: { Played: false }
};
const mergedRow = { id: mergedVodId, name: 'Slow Horses', tmdb_id: localTmdb, year: 2022, description: 'Fixture', genre: 'Drama', created_at: NOW };
const bareRow = { id: bareVodId, name: 'No public art show', year: 2026, description: 'Fixture', genre: 'Drama', created_at: NOW };
const tmdbRow = { id: tmdbVodId, name: 'Warm TMDB show', tmdb_id: 550, year: 2026, description: 'Fixture', genre: 'Drama', created_at: NOW };

function catalogueRow(row) {
	return { Id: `dispatch-series-${row.id}`, Name: row.name, Type: 'Series', Source: 'streamed', Provider: 'Dispatcharr',
		Genres: ['Drama'], ...(row.tmdb_id ? { ProviderIds: { Tmdb: String(row.tmdb_id) } } : {}),
		VodIds: [row.id], PremiereDate: '2026-01-01', DateCreated: NOW, Artwork: `/api/web/art/series/${row.id}` };
}

test('a merged local episode keeps the local series poster and backdrop', { timeout: 45000 }, async t => {
	const directory = mkdtempSync(path.join(os.tmpdir(), 'home-artwork-local-131-'));
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
			if (key === localId) return res.end(JSON.stringify(localSeries));
			if (key === localEpisodeId) return res.end(JSON.stringify(localEpisode));
			if (key === localEpisodeTwoId) return res.end(JSON.stringify(localEpisodeTwo));
			res.statusCode = 404; return res.end('{}');
		}
		const episodes = /^\/Shows\/([^/]+)\/Episodes$/.exec(url.pathname);
		if (episodes) {
			const key = decodeURIComponent(episodes[1]);
			return res.end(JSON.stringify({ Items: key === localId ? [localEpisode, localEpisodeTwo] : [] }));
		}
		return res.end(JSON.stringify({ Items: [], TotalRecordCount: 0 }));
	});
	const dispatcharr = await listen((req, res) => {
		const url = new URL(req.url, 'http://127.0.0.1');
		res.setHeader('Content-Type', 'application/json');
		if (url.pathname === '/api/vod/movies/' || url.pathname === '/api/vod/movies') return res.end(JSON.stringify({ results: [], next: null }));
		if (url.pathname === '/api/vod/series/' || url.pathname === '/api/vod/series') {
			return res.end(JSON.stringify({ results: [mergedRow, bareRow, tmdbRow], next: null }));
		}
		const info = /^\/api\/vod\/series\/(\d+)\/provider-info\/$/.exec(url.pathname);
		if (info) return res.end(JSON.stringify({ id: Number(info[1]) }));
		const episodes = /^\/api\/vod\/series\/(\d+)\/episodes\/$/.exec(url.pathname);
		if (episodes) {
			const id = Number(episodes[1]);
			return res.end(JSON.stringify([{
				id: id * 10, name: 'Show ' + id + ' - S01E01 - Episode', series: { id },
				season_number: 1, episode_number: 1, air_date: '2026-11-01', duration_secs: 2400, created_at: NOW
			}, {
				id: id * 10 + 1, name: 'Show ' + id + ' - S01E02 - Episode', series: { id },
				season_number: 1, episode_number: 2, air_date: '2026-11-02', duration_secs: 2400, created_at: NOW
			}]));
		}
		const detail = /^\/api\/vod\/series\/(\d+)\/$/.exec(url.pathname);
		if (detail) {
			// The provider detail deliberately has no logo and no tmdb_id, exactly
			// like the three live titles whose /api/web/art/series/<vodId> is 404.
			const row = [mergedRow, bareRow, tmdbRow].find(entry => entry.id === Number(detail[1]));
			return res.end(JSON.stringify(row ? { id: row.id, name: row.name, description: 'Fixture', genre: 'Drama' } : {}));
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
	writeFileSync(path.join(directory, 'vod-catalogue.json'), JSON.stringify({
		time: Date.now(), items: [catalogueRow(mergedRow), catalogueRow(bareRow), catalogueRow(tmdbRow)]
	}));
	writeFileSync(path.join(directory, 'series-links.json'), JSON.stringify({}));
	// Warm public poster for the third show only: it must keep the TMDB route.
	writeFileSync(path.join(directory, 'vod-metadata.json'), JSON.stringify([[
		'tv/550', { schema: 2, time: Date.now(), retry: Date.now() + 86400000, data: { poster: '/warm-poster.jpg' } }
	]]));
	writeFileSync(path.join(directory, 'activity.json'), JSON.stringify([{
		id: 'local-progress-131', type: 'playback', local: true, itemId: localEpisodeId, seriesId: localId,
		position: 120, duration: 2400, state: 'ended', time: Date.now() - 60000, updated: Date.now() - 60000
	}]));
	const { app } = await import('../server.mjs');
	local.on('request', app);
	const base = `http://127.0.0.1:${local.address().port}`;
	t.after(() => {
		for (const server of servers) { server.closeAllConnections(); server.close(); }
		rmSync(directory, { recursive: true, force: true });
	});

	const episodesFor = async id => {
		const response = await fetch(base + '/api/web/releases/episodes?series=' + encodeURIComponent(id), { headers: { Origin: base } });
		const body = await response.json();
		return { status: response.status, items: body.items || [] };
	};

	const merged = await episodesFor(localId);
	assert.equal(merged.status, 200);
	assert.equal(merged.items.length, 2, 'the merged local episodes are returned');
	const mergedEpisode = merged.items.find(item => item.Id === localEpisodeId);
	assert.ok(mergedEpisode, 'the merged local episode is returned');
	assert.equal(mergedEpisode.SeriesId, localId, 'the parent stays the local canonical series');
	assert.equal(mergedEpisode.Artwork, `/images/${localId}/Primary?width=400`,
		'the show poster replaces the 404 provider alias');
	assert.equal(mergedEpisode.BackdropArtwork, `/images/${localId}/Backdrop?width=1280`,
		'the show backdrop is available for Continue-sized contexts');
	const ownStill = merged.items.find(item => item.Id === localEpisodeTwoId);
	assert.ok(ownStill, 'the second merged local episode is returned');
	assert.equal(ownStill.Artwork, `/images/${localEpisodeTwoId}/Primary?width=400`,
		'an episode with its own local still keeps it instead of the show poster');

	const bare = await episodesFor(`dispatch-series-${bareVodId}`);
	assert.equal(bare.status, 200);
	assert.equal(bare.items[0]?.Artwork, `/api/web/art/series/${bareVodId}`,
		'a streamed show with no local parent keeps the honest provider route');

	const warm = await episodesFor(`dispatch-series-${tmdbVodId}`);
	assert.equal(warm.items[0]?.Artwork, '/api/web/tmdb-art/tv/550/poster',
		'the accepted 130 warm parent poster behaviour is unchanged');

	// Continue paints a backdrop. The same local episode must use the show's
	// backdrop image, not the 404 provider alias.
	const home = await (await fetch(base + '/api/web/home', {
		method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: '{}'
	})).json();
	const continueRow = (home.rows || []).find(row => row.id === 'continue');
	assert.ok(continueRow, 'Continue row exists');
	const card = (continueRow.items || []).find(item => item.Id === localEpisodeId);
	assert.ok(card, 'the exact unfinished local episode is in Continue');
	assert.equal(card.Artwork, `/images/${localId}/Primary?width=400`);
	assert.equal(card.BackdropArtwork, `/images/${localId}/Backdrop?width=1280`,
		'the Continue card has a working backdrop');
	assert.equal(card.UserData.PlaybackPositionTicks, 120e7, 'the exact position is unchanged');
});
