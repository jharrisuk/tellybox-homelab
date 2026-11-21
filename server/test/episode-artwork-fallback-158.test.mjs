/* Episode artwork fallback for the in-series list.
 *
 * Both clients render an episode row as a still. Jellyfin-backed catalogues
 * frequently have no still for an episode, and the clients then request
 * /images/<episode>/Primary, which 404s into a blank square. The releases rail
 * already fell back to the parent series artwork; the in-series list
 * (/api/items/:id/episodes) did not.
 *
 * The fallback must be evidence-backed only:
 *   - an episode with its own Primary tag keeps it (Artwork stays empty and the
 *     client uses /images/<episode>/Primary);
 *   - an episode without one uses the series poster only when the series itself
 *     has a Primary tag;
 *   - a series with no image evidence produces no invented route.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const NOW = '2026-11-18T12:00:00Z';
const withPoster = '1'.repeat(32);
const noPoster = '2'.repeat(32);
const ownStill = '3'.repeat(32);
const blankOne = '4'.repeat(32);
const blankTwo = '5'.repeat(32);
const plainOne = '6'.repeat(32);

const seriesPoster = {
	Id: withPoster, Name: 'Has a poster', Type: 'Series', Genres: ['Drama'],
	ImageTags: { Primary: 'poster-tag' }, DateCreated: NOW, ChildCount: 2,
	UserData: { Played: false, UnplayedItemCount: 2 }
};
const seriesPlain = {
	Id: noPoster, Name: 'No poster', Type: 'Series', Genres: ['Drama'],
	DateCreated: NOW, ChildCount: 1, UserData: { Played: false, UnplayedItemCount: 1 }
};
const episodeOwnStill = {
	Id: ownStill, Name: 'Own still', Type: 'Episode', SeriesId: withPoster, SeriesName: seriesPoster.Name,
	ParentIndexNumber: 1, IndexNumber: 1, ImageTags: { Primary: 'episode-still' },
	UserData: { Played: false }
};
const episodeBlank = {
	Id: blankOne, Name: 'No still', Type: 'Episode', SeriesId: withPoster, SeriesName: seriesPoster.Name,
	ParentIndexNumber: 1, IndexNumber: 2, UserData: { Played: false }
};
const episodeBlankTwo = {
	Id: blankTwo, Name: 'Also no still', Type: 'Episode', SeriesId: withPoster, SeriesName: seriesPoster.Name,
	ParentIndexNumber: 1, IndexNumber: 3, UserData: { Played: false }
};
const episodePlain = {
	Id: plainOne, Name: 'Plain show episode', Type: 'Episode', SeriesId: noPoster, SeriesName: seriesPlain.Name,
	ParentIndexNumber: 1, IndexNumber: 1, UserData: { Played: false }
};

test('in-series episodes fall back to the series poster only with image evidence', { timeout: 45000 }, async t => {
	const directory = mkdtempSync(path.join(os.tmpdir(), 'episode-artwork-fallback-'));
	const servers = [];
	const listen = handler => new Promise(resolve => {
		const server = http.createServer(handler);
		server.listen(0, '127.0.0.1', () => { servers.push(server); resolve(server); });
	});
	const jellyfin = await listen((req, res) => {
		const url = new URL(req.url, 'http://127.0.0.1');
		res.setHeader('Content-Type', 'application/json');
		const item = /^\/Users\/[^/]+\/Items\/([^/]+)$/.exec(url.pathname);
		if (item) {
			const key = decodeURIComponent(item[1]);
			if (key === withPoster) return res.end(JSON.stringify(seriesPoster));
			if (key === noPoster) return res.end(JSON.stringify(seriesPlain));
			res.statusCode = 404; return res.end('{}');
		}
		const episodes = /^\/Shows\/([^/]+)\/Episodes$/.exec(url.pathname);
		if (episodes) {
			const key = decodeURIComponent(episodes[1]);
			if (key === withPoster) return res.end(JSON.stringify({ Items: [episodeOwnStill, episodeBlank, episodeBlankTwo] }));
			if (key === noPoster) return res.end(JSON.stringify({ Items: [episodePlain] }));
			return res.end(JSON.stringify({ Items: [] }));
		}
		return res.end(JSON.stringify({ Items: [], TotalRecordCount: 0 }));
	});
	const dispatcharr = await listen((req, res) => {
		const url = new URL(req.url, 'http://127.0.0.1');
		res.setHeader('Content-Type', 'application/json');
		if (url.pathname.startsWith('/api/vod/series')) return res.end(JSON.stringify({ results: [], next: null }));
		if (url.pathname.startsWith('/api/vod/movies')) return res.end(JSON.stringify({ results: [], next: null }));
		return res.end(JSON.stringify({ results: [], next: null }));
	});
	const seerr = await listen((req, res) => {
		res.setHeader('Content-Type', 'application/json');
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
		jellyfin: true, library: true, live: false, nonstop: false, vod: false, recordings: false,
		catchup: false, discover: true, comingSoon: false, introdb: false, subtitles: false
	}));
	writeFileSync(path.join(directory, 'vod-catalogue.json'), JSON.stringify({ time: Date.now(), items: [] }));
	writeFileSync(path.join(directory, 'series-links.json'), JSON.stringify({}));
	const { app } = await import('../server.mjs');
	local.on('request', app);
	const base = `http://127.0.0.1:${local.address().port}`;
	t.after(() => {
		for (const server of servers) { server.closeAllConnections(); server.close(); }
		rmSync(directory, { recursive: true, force: true });
	});

	const withPosterResponse = await fetch(base + '/api/items/' + withPoster + '/episodes', { headers: { Origin: base } });
	const withPosterText = await withPosterResponse.clone().text();
	assert.equal(withPosterResponse.status, 200, withPosterText);
	const withPosterBody = await withPosterResponse.json();
	const byId = new Map((withPosterBody.items || []).map(item => [item.Id, item]));
	assert.equal(byId.size, 3, 'all three episodes are returned');
	assert.equal(byId.get(ownStill).Artwork, undefined,
		'an episode with its own still is not overridden by the series poster');
	assert.equal(byId.get(blankOne).Artwork, `/images/${withPoster}/Primary?width=400`,
		'an episode without a still uses the series poster');
	assert.equal(byId.get(blankTwo).Artwork, `/images/${withPoster}/Primary?width=400`,
		'the fallback applies to every episode without a still');
	assert.equal(byId.get(blankOne).SeriesName, seriesPoster.Name, 'episode metadata is preserved');
	assert.equal(byId.get(blankOne).IndexNumber, 2, 'episode numbering is preserved');

	const noPosterResponse = await fetch(base + '/api/items/' + noPoster + '/episodes', { headers: { Origin: base } });
	assert.equal(noPosterResponse.status, 200);
	const noPosterBody = await noPosterResponse.json();
	const plain = (noPosterBody.items || [])[0];
	assert.ok(plain, 'the episode is still returned when the series has no poster');
	assert.equal(plain.Artwork, undefined, 'no image route is invented without evidence');
});
