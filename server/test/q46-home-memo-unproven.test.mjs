/* Q46 regression (Fix 1, route): one permanently unknown series must not block
 * the Home memo.
 *
 * Before the fix, `pending` was counted from the pre-filter feed, so the single
 * streamed series whose provider episodes endpoint fails (502 -> 'unknown',
 * then failure backoff) kept pending > 0 and /api/web/home never wrote its memo:
 * every warm request re-ran catalogue + Continue + verification.
 *
 * Fixture: real server.mjs app, loopback Jellyfin/Dispatcharr mocks (the
 * playable-117-route / home-feed-memo-132 pattern). The viewer is local/shared
 * and sends browser progress for one exact local episode, so Continue resolves
 * it through vodLibrary.item -> the UNCACHED Jellyfin single-item read. That
 * read is the sensitive counter: it repeats on every pipeline re-run and is
 * skipped on a memo hit. A deliberate context-miss control request proves the
 * counter really moves when the pipeline re-runs, so the zero delta on the warm
 * identical request is the memo's doing, not upstream caching.
 *
 * Additive: home-feed-memo-132 proves viewer isolation/warm hits with a
 * movies-only fixture (no unproven series); home-playable-deadline-130 proves
 * hiding unproven series in the extracted builder but never the route memo.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const NOW = '2026-11-18T12:00:00Z';
const localSeriesId = 'a'.repeat(32);
const localEpisodeId = 'e'.repeat(32);
const filmIds = ['1'.repeat(32), '2'.repeat(32), '3'.repeat(32)];
const playableVodId = 9001;
const unprovenVodId = 9002;
const unprovenSeriesId = `dispatch-series-${unprovenVodId}`;
const playableSeriesId = `dispatch-series-${playableVodId}`;

const films = filmIds.map((id, index) => ({
	Id: id, Name: `Fixture film ${index + 1}`, Type: 'Movie', Genres: ['Drama'],
	RunTimeTicks: 7200e7, DateCreated: NOW, UserData: { Played: false }
}));
const localSeries = {
	Id: localSeriesId, Name: 'Local continue show', Type: 'Series', Genres: ['Drama'],
	DateCreated: NOW, ChildCount: 1, UserData: { Played: false, UnplayedItemCount: 1 }
};
const localEpisode = {
	Id: localEpisodeId, Name: 'Exact unfinished episode', Type: 'Episode',
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

test('an unproven series is dropped, pending is 0, and the next identical Home request is a memo hit', { timeout: 60000 }, async t => {
	const directory = mkdtempSync(path.join(os.tmpdir(), 'q46-home-memo-unproven-'));
	const servers = [];
	const listen = handler => new Promise(resolve => {
		const server = http.createServer(handler);
		server.listen(0, '127.0.0.1', () => { servers.push(server); resolve(server); });
	});
	const calls = {
		jellyfinCatalogue: 0, jellyfinParentQuery: 0, jellyfinSingle: {}, jellyfinShowEpisodes: {},
		dispatcharrCatalogue: 0, dispatcharrDetail: {}, dispatcharrProviderInfo: {}, dispatcharrEpisodes: {}
	};
	const bump = (map, key) => { map[key] = (map[key] || 0) + 1; };
	const jellyfin = await listen((req, res) => {
		const url = new URL(req.url, 'http://127.0.0.1');
		res.setHeader('Content-Type', 'application/json');
		if (url.pathname === '/Items') {
			if (url.searchParams.has('ParentId')) calls.jellyfinParentQuery++;
			else calls.jellyfinCatalogue++;
			return res.end(JSON.stringify({ Items: [...films, localSeries], TotalRecordCount: films.length + 1 }));
		}
		const item = /^\/Users\/[^/]+\/Items\/([^/]+)$/.exec(url.pathname);
		if (item) {
			const id = decodeURIComponent(item[1]);
			bump(calls.jellyfinSingle, id);
			const found = [...films, localSeries, localEpisode].find(entry => entry.Id === id);
			if (!found) { res.statusCode = 404; return res.end('{}'); }
			return res.end(JSON.stringify(found));
		}
		const show = /^\/Shows\/([^/]+)\/Episodes$/.exec(url.pathname);
		if (show) {
			const id = decodeURIComponent(show[1]);
			bump(calls.jellyfinShowEpisodes, id);
			return res.end(JSON.stringify({ Items: id === localSeriesId ? [localEpisode] : [], TotalRecordCount: id === localSeriesId ? 1 : 0 }));
		}
		if (url.pathname.startsWith('/Users/')) return res.end(JSON.stringify({ Items: [], TotalRecordCount: 0 }));
		res.end('{}');
	});
	const dispatcharr = await listen((req, res) => {
		const url = new URL(req.url, 'http://127.0.0.1');
		res.setHeader('Content-Type', 'application/json');
		if (url.pathname === '/api/vod/movies/' || url.pathname === '/api/vod/movies') {
			calls.dispatcharrCatalogue++;
			return res.end(JSON.stringify({ results: [], next: null }));
		}
		if (url.pathname === '/api/vod/series/' || url.pathname === '/api/vod/series') {
			calls.dispatcharrCatalogue++;
			return res.end(JSON.stringify({ results: [streamedRow(playableVodId), streamedRow(unprovenVodId)], next: null }));
		}
		let match = /^\/api\/vod\/series\/(\d+)\/provider-info\/$/.exec(url.pathname);
		if (match) { bump(calls.dispatcharrProviderInfo, match[1]); return res.end('{}'); }
		match = /^\/api\/vod\/series\/(\d+)\/episodes\/$/.exec(url.pathname);
		if (match) {
			const id = Number(match[1]);
			bump(calls.dispatcharrEpisodes, id);
			if (id === unprovenVodId) { res.statusCode = 502; return res.end('{}'); }
			return res.end(JSON.stringify([{
				id: id * 10, name: `Show ${id} - S01E01 - Episode`, series: { id },
				season_number: 1, episode_number: 1, air_date: '2026-11-01', duration_secs: 2400, created_at: NOW
			}]));
		}
		match = /^\/api\/vod\/series\/(\d+)\/$/.exec(url.pathname);
		if (match) {
			const id = Number(match[1]);
			bump(calls.dispatcharrDetail, id);
			return res.end(JSON.stringify(streamedRow(id)));
		}
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
	// Q46 finding (pre-existing startup race, reported separately): the route
	// computes homeFeedMemoKey from vodLibrary.status() BEFORE awaiting
	// vodLibrary.all(), which is where the async catalogue disk-restore
	// ('restored', vod-library.mjs) is awaited. A first request that arrives
	// before the restore settles writes its memo under indexed=0/lastRefresh=0,
	// orphaning the entry: request 2 rebuilds, request 3 hits. Let the restore
	// settle so this test measures the pending fix, not that race.
	await new Promise(resolve => setTimeout(resolve, 250));
	const base = `http://127.0.0.1:${local.address().port}`;
	t.after(() => {
		for (const server of servers) { server.closeAllConnections(); server.close(); }
		rmSync(directory, { recursive: true, force: true });
	});

	const home = body => fetch(base + '/api/web/home', {
		method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base },
		body: JSON.stringify(body)
	});
	const timingOf = response => JSON.parse(response.headers.get('x-tellybox-home-timing') || 'null');
	const feedIds = feed => [...(feed.rows || []).flatMap(row => (row.items || []).map(item => item.Id)),
		...(feed.featured || []).map(item => item.Id)];
	const rowShape = feed => (feed.rows || []).map(row => [row.id, (row.items || []).map(item => item.Id)]);
	const snapshot = () => JSON.parse(JSON.stringify(calls));
	const body = { progress: { [localEpisodeId]: 240 } };

	// 1. Cold build: the unproven series is attempted, dropped, and pending is 0.
	const coldResponse = await home(body);
	assert.equal(coldResponse.status, 200, await coldResponse.clone().text());
	assert.equal(coldResponse.headers.get('cache-control'), 'no-store');
	const coldTiming = timingOf(coldResponse);
	assert.notEqual(coldTiming?.memoHit, true, 'the first build is not a memo hit');
	assert.equal(typeof coldTiming?.catalogueMs, 'number', 'the cold request ran the catalogue stage');
	assert.equal(coldTiming?.feedBuild?.pending, 0, 'the timing diagnostics report the post-filter pending');
	const cold = await coldResponse.json();
	assert.equal(cold.availability.pending, 0, 'the served feed reports pending 0 despite the unknown candidate');
	assert.ok(cold.availability.checked > 0, 'the cold build really verified series');
	assert.ok(Array.isArray(cold.rows) && cold.rows.length > 0, 'the feed has rows');
	assert.ok(!feedIds(cold).includes(unprovenSeriesId), 'the unproven series appears in no rail or featured');
	assert.ok(feedIds(cold).includes(playableSeriesId), 'the proven streamed series is kept');
	assert.equal(cold.availability.continue?.complete, true, 'Continue resolved completely');
	const continueRow = (cold.rows || []).find(row => row.id === 'continue');
	assert.ok(continueRow && continueRow.items.some(item => item.Id === localEpisodeId), 'the exact episode is in Continue');
	assert.ok(calls.jellyfinCatalogue >= 1, 'the cold request read the catalogue');
	assert.ok((calls.dispatcharrEpisodes[unprovenVodId] || 0) >= 1, 'the unproven series was attempted against the provider');
	assert.equal(calls.jellyfinSingle[localEpisodeId], 1, 'Continue resolved the exact episode once (the sensitive counter)');
	assert.ok((calls.jellyfinShowEpisodes[localSeriesId] || 0) >= 1, 'the local series episodes were read');

	// 2. Warm identical request: memo hit, zero upstream calls of any kind.
	const beforeWarm = snapshot();
	const warmResponse = await home(body);
	assert.equal(warmResponse.status, 200, await warmResponse.clone().text());
	assert.equal(warmResponse.headers.get('cache-control'), 'no-store');
	const warmTiming = timingOf(warmResponse);
	assert.equal(warmTiming?.memoHit, true, 'the memo was written despite the permanently unknown series');
	assert.equal(warmTiming?.totalMs, 0);
	assert.ok(!('catalogueMs' in (warmTiming || {})), 'the memo hit skipped the catalogue stage');
	assert.ok(!('feedBuild' in (warmTiming || {})), 'the memo hit skipped feed build/verification');
	assert.deepEqual(calls, beforeWarm, 'a memo hit re-runs no catalogue, Continue or verification call');
	const warm = await warmResponse.json();
	assert.deepEqual(rowShape(warm), rowShape(cold), 'the memo hit returns the same rows and items');
	assert.ok(!feedIds(warm).includes(unprovenSeriesId), 'the cached feed still hides the unproven series');
	assert.equal(warm.availability.pending, 0);
	assert.equal(warm.availability.checked, 0, 'a memo hit reports no fresh series checks');
	assert.equal(warm.availability.continue?.complete, true, 'the cached Continue answer stays complete');

	// 3. Control: a different body context misses the memo and re-runs the
	// pipeline. The uncached Continue single-item read must move by exactly one,
	// proving the counter detects re-runs (so step 2's zero delta is the memo).
	const beforeMiss = snapshot();
	const missResponse = await home({ ...body, taste: { genres: [{ name: 'Comedy', weight: 4 }], exclude: [] } });
	assert.equal(missResponse.status, 200, await missResponse.clone().text());
	assert.notEqual(timingOf(missResponse)?.memoHit, true, 'a different context is a different memo entry');
	await missResponse.json();
	assert.equal(calls.jellyfinSingle[localEpisodeId], beforeMiss.jellyfinSingle[localEpisodeId] + 1,
		'a pipeline re-run repeats the uncached Continue resolution');
	assert.deepEqual(calls.dispatcharrEpisodes, beforeMiss.dispatcharrEpisodes, 'failure backoff still bounds provider retries');
	assert.equal(calls.jellyfinCatalogue, beforeMiss.jellyfinCatalogue, 'the short-lived catalogue cache is unrelated to the memo');

	// 4. The original entry is untouched: the identical request is a hit again.
	const beforeRepeat = snapshot();
	const repeatResponse = await home(body);
	assert.equal(repeatResponse.status, 200);
	assert.equal(timingOf(repeatResponse)?.memoHit, true, 'the original memo entry survives the control miss');
	await repeatResponse.json();
	assert.deepEqual(calls, beforeRepeat, 'the second hit also re-runs nothing');
});
