/* Q46 regression (Fix 1, route): a genuinely incomplete Continue answer still
 * blocks the Home memo — the pending fix must not over-cache.
 *
 * The memo gate is `result.pending === 0 && continue.complete !== false &&
 * rows.length`. This fixture makes pending 0 (the unproven streamed series is
 * dropped, exactly as in q46-home-memo-unproven) while Continue is genuinely
 * partial: the browser names an exact episode id that Jellyfin answers 404 for,
 * so home-continue reports 'partial'/'unresolved-progress' with complete:false.
 * The feed memo must NOT be written, the repeat must re-run the pipeline (the
 * uncached Jellyfin single-item read is the sensitive counter), and the
 * dedicated Continue route must not reuse a partial answer either.
 *
 * Additive: home-continue-125.test.mjs proves partial availability at unit
 * level; home-defer-continue-141.test.mjs proves the Continue memo warmth from
 * a COMPLETE feed. No existing route test proves the feed memo refuses a
 * partial Continue answer.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const NOW = '2026-11-18T12:00:00Z';
const localSeriesId = 'a'.repeat(32);
const ghostEpisodeId = 'f'.repeat(32);
const filmIds = ['1'.repeat(32), '2'.repeat(32), '3'.repeat(32)];
const playableVodId = 9001;
const unprovenVodId = 9002;
const unprovenSeriesId = `dispatch-series-${unprovenVodId}`;

const films = filmIds.map((id, index) => ({
	Id: id, Name: `Fixture film ${index + 1}`, Type: 'Movie', Genres: ['Drama'],
	RunTimeTicks: 7200e7, DateCreated: NOW, UserData: { Played: false }
}));
const localSeries = {
	Id: localSeriesId, Name: 'Local show', Type: 'Series', Genres: ['Drama'],
	DateCreated: NOW, ChildCount: 1, UserData: { Played: false, UnplayedItemCount: 1 }
};
const localEpisode = {
	Id: 'e'.repeat(32), Name: 'Aired episode', Type: 'Episode',
	SeriesId: localSeriesId, SeriesName: localSeries.Name,
	ParentIndexNumber: 1, IndexNumber: 1, PremiereDate: '2026-11-01',
	RunTimeTicks: 2400e7, UserData: { Played: false }
};
const streamedRow = id => ({
	id, name: id === unprovenVodId ? 'Unproven streamed show' : 'Playable streamed show',
	year: 2026, description: 'Fixture', genre: 'Drama', created_at: NOW
});
const catalogueRow = id => ({
	Id: `dispatch-series-${id}`, Name: streamedRow(id).name, Type: 'Series', Source: 'streamed',
	Provider: 'Dispatcharr', Genres: ['Drama'], VodIds: [id],
	PremiereDate: '2026-01-01', DateCreated: NOW, Artwork: `/api/web/art/series/${id}`
});

test('a partial Continue answer blocks the Home memo even when pending is 0', { timeout: 60000 }, async t => {
	const directory = mkdtempSync(path.join(os.tmpdir(), 'q46-home-memo-continue-gate-'));
	const servers = [];
	const listen = handler => new Promise(resolve => {
		const server = http.createServer(handler);
		server.listen(0, '127.0.0.1', () => { servers.push(server); resolve(server); });
	});
	const calls = { jellyfinSingle: {}, dispatcharrEpisodes: {} };
	const jellyfin = await listen((req, res) => {
		const url = new URL(req.url, 'http://127.0.0.1');
		res.setHeader('Content-Type', 'application/json');
		if (url.pathname === '/Items') return res.end(JSON.stringify({ Items: [...films, localSeries], TotalRecordCount: films.length + 1 }));
		const item = /^\/Users\/[^/]+\/Items\/([^/]+)$/.exec(url.pathname);
		if (item) {
			const id = decodeURIComponent(item[1]);
			calls.jellyfinSingle[id] = (calls.jellyfinSingle[id] || 0) + 1;
			// The ghost episode is the deliberately unresolved read: a 404 makes
			// Continue partial, never an empty-and-complete answer.
			if (id === ghostEpisodeId) { res.statusCode = 404; return res.end('{}'); }
			const found = [...films, localSeries, localEpisode].find(entry => entry.Id === id);
			if (!found) { res.statusCode = 404; return res.end('{}'); }
			return res.end(JSON.stringify(found));
		}
		const show = /^\/Shows\/([^/]+)\/Episodes$/.exec(url.pathname);
		if (show) {
			const id = decodeURIComponent(show[1]);
			return res.end(JSON.stringify({ Items: id === localSeriesId ? [localEpisode] : [], TotalRecordCount: id === localSeriesId ? 1 : 0 }));
		}
		if (url.pathname.startsWith('/Users/')) return res.end(JSON.stringify({ Items: [], TotalRecordCount: 0 }));
		res.end('{}');
	});
	const dispatcharr = await listen((req, res) => {
		const url = new URL(req.url, 'http://127.0.0.1');
		res.setHeader('Content-Type', 'application/json');
		if (url.pathname === '/api/vod/movies/' || url.pathname === '/api/vod/movies') return res.end(JSON.stringify({ results: [], next: null }));
		if (url.pathname === '/api/vod/series/' || url.pathname === '/api/vod/series') {
			return res.end(JSON.stringify({ results: [streamedRow(playableVodId), streamedRow(unprovenVodId)], next: null }));
		}
		let match = /^\/api\/vod\/series\/(\d+)\/provider-info\/$/.exec(url.pathname);
		if (match) return res.end('{}');
		match = /^\/api\/vod\/series\/(\d+)\/episodes\/$/.exec(url.pathname);
		if (match) {
			const id = Number(match[1]);
			calls.dispatcharrEpisodes[id] = (calls.dispatcharrEpisodes[id] || 0) + 1;
			if (id === unprovenVodId) { res.statusCode = 502; return res.end('{}'); }
			return res.end(JSON.stringify([{
				id: id * 10, name: `Show ${id} - S01E01 - Episode`, series: { id },
				season_number: 1, episode_number: 1, air_date: '2026-11-01', duration_secs: 2400, created_at: NOW
			}]));
		}
		match = /^\/api\/vod\/series\/(\d+)\/$/.exec(url.pathname);
		if (match) return res.end(JSON.stringify(streamedRow(Number(match[1]))));
		res.end(JSON.stringify({ results: [], next: null }));
	});
	const local = await listen();
	Object.assign(process.env, {
		NODE_ENV: 'test', AUTH_DIR: directory, DATA_DIR: directory, CATALOGUE_CACHE_DIR: directory,
		JELLYFIN_URL: `http://127.0.0.1:${jellyfin.address().port}`,
		DISPATCHARR_URL: `http://127.0.0.1:${dispatcharr.address().port}`,
		PORT: String(local.address().port),
		LOCAL_HOSTS: '127.0.0.1', LOCAL_NETWORKS: '127.0.0.0/8',
		PUBLIC_ORIGIN: 'https://remote.test', TELLYBOX_HOME_TIMING: '1'
	});
	writeFileSync(path.join(directory, 'connection.json'), JSON.stringify({ userId: 'test', token: 'fixture-only' }));
	writeFileSync(path.join(directory, 'apps.json'), JSON.stringify({}));
	writeFileSync(path.join(directory, 'account-limits.json'), JSON.stringify({ accounts: {} }));
	writeFileSync(path.join(directory, 'activity.json'), JSON.stringify([]));
	writeFileSync(path.join(directory, 'dispatcharr.json'), JSON.stringify({ key: 'fixture-only' }));
	writeFileSync(path.join(directory, 'vod-catalogue.json'), JSON.stringify({
		time: Date.now(), items: [catalogueRow(playableVodId), catalogueRow(unprovenVodId)]
	}));
	(await import('./enabled-fixture.mjs')).enableIntegrations();
	const { app } = await import('../server.mjs');
	local.on('request', app);
	const base = `http://127.0.0.1:${local.address().port}`;
	t.after(() => {
		for (const server of servers) { server.closeAllConnections(); server.close(); }
		rmSync(directory, { recursive: true, force: true });
	});

	const post = (route, body) => fetch(base + route, {
		method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base },
		body: JSON.stringify(body)
	});
	const timingOf = response => JSON.parse(response.headers.get('x-tellybox-home-timing') || 'null');
	const feedIds = feed => [...(feed.rows || []).flatMap(row => (row.items || []).map(item => item.Id)),
		...(feed.featured || []).map(item => item.Id)];
	const body = { progress: { [ghostEpisodeId]: 240 } };

	// 1. Cold: pending is 0 (unproven series dropped) but Continue is partial.
	const firstResponse = await post('/api/web/home', body);
	assert.equal(firstResponse.status, 200, await firstResponse.clone().text());
	assert.notEqual(timingOf(firstResponse)?.memoHit, true);
	const first = await firstResponse.json();
	assert.equal(first.availability.pending, 0, 'the pending fix holds: the served feed is available-only');
	assert.ok(!feedIds(first).includes(unprovenSeriesId), 'the unproven series stays hidden');
	assert.ok(!feedIds(first).includes(ghostEpisodeId), 'an unresolved id never becomes a card');
	assert.ok(Array.isArray(first.rows) && first.rows.length > 0, 'the other rails are present');
	assert.equal((first.rows || []).some(row => row.id === 'continue'), false, 'no fabricated Continue row');
	assert.equal(first.availability.continue?.complete, false, 'Continue is genuinely incomplete');
	assert.equal(first.availability.continue?.status, 'partial');
	assert.equal(first.availability.continue?.reason, 'unresolved-progress');
	assert.equal(calls.jellyfinSingle[ghostEpisodeId], 1, 'the ghost episode was attempted once');

	// 2. Identical repeat: the memo must NOT have been written; the pipeline
	// re-runs and retries the unresolved lookup instead of freezing it.
	const repeatResponse = await post('/api/web/home', body);
	assert.equal(repeatResponse.status, 200, await repeatResponse.clone().text());
	const repeatTiming = timingOf(repeatResponse);
	assert.notEqual(repeatTiming?.memoHit, true, 'a partial Continue answer never warms the feed memo');
	assert.equal(typeof repeatTiming?.catalogueMs, 'number', 'the repeat re-ran the pipeline');
	const repeat = await repeatResponse.json();
	assert.equal(repeat.availability.pending, 0);
	assert.equal(repeat.availability.continue?.complete, false, 'the repeat is still honestly partial');
	assert.ok(!feedIds(repeat).includes(unprovenSeriesId), 'still no unproven series');
	assert.equal(calls.jellyfinSingle[ghostEpisodeId], 2, 'the unresolved lookup was retried, not cached');

	// 3. The dedicated Continue route also refuses to reuse the partial answer.
	const continueResponse = await post('/api/web/home/continue', body);
	assert.equal(continueResponse.status, 200, await continueResponse.clone().text());
	assert.notEqual(timingOf(continueResponse)?.memoHit, true, 'a partial answer never warms the Continue memo either');
	const continueBody = await continueResponse.json();
	assert.equal(continueBody.availability?.continue?.complete, false);
	assert.deepEqual(continueBody.rows, [], 'no Continue row is invented from the unresolved id');
	assert.equal(calls.jellyfinSingle[ghostEpisodeId], 3, 'the Continue route retried the lookup as well');
});
