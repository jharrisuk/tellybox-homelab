import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createVodMetadata } from '../vod-metadata.mjs';
import { createHomeArtwork, homeArtworkCandidates, HOME_ARTWORK_LIMIT } from '../home-artwork.mjs';

const item = (id, tmdb, extra = {}) => ({
	Id: id, Name: 'Title ' + id, Type: 'Movie', Source: 'streamed',
	ProviderIds: { Tmdb: String(tmdb) }, Artwork: '/api/web/art/movie/' + tmdb, ...extra,
});

const counts = ({ pending, requested, resolved, failed, visible, remaining, limit }) =>
	({ pending, requested, resolved, failed, visible, remaining, limit });

test('home artwork limit is the agreed bounded sample', () => {
	assert.equal(HOME_ARTWORK_LIMIT, 24);
});

test('candidate priority starts with Recently added, dedupes by Id, and respects artwork origin', () => {
	const newest = item('new-1', 201);
	const forYou = [item('for-you-0', 100), item('for-you-1', 101), item('for-you-2', 102)];
	const duplicate = item('dup-1', 301);
	const localArt = item('local-art', 601, { Artwork: '/images/poster.jpg' });
	const tmdbArt = item('tmdb-art', 701, { Artwork: '/api/web/tmdb-art/movie/701/poster' });
	const noTmdb = item('no-tmdb', 1, { ProviderIds: {} });
	const badTmdb = item('bad-tmdb', 1, { ProviderIds: { Tmdb: 'abc' } });
	const zeroTmdb = item('zero-tmdb', 1, { ProviderIds: { Tmdb: '0' } });
	const fractionTmdb = item('fraction-tmdb', 1, { ProviderIds: { Tmdb: '12.5' } });
	const episode = item('episode-1', 801, { Type: 'Episode' });
	const missingArt = item('missing-art', 901, { Artwork: undefined });
	const feed = {
		rows: [
			{ id: 'for-you', items: [...forYou, duplicate, localArt, tmdbArt, noTmdb, badTmdb, zeroTmdb, fractionTmdb, episode] },
			{ id: 'top', items: [item('top-1', 401)] },
			{ id: 'new', items: [newest, { ...newest, Name: 'Copy of newest' }] },
		],
		featured: [{ ...duplicate }, item('featured-1', 501), localArt, tmdbArt, missingArt],
	};
	const selected = homeArtworkCandidates(feed);
	assert.deepEqual(selected.map(entry => entry.Id),
		['new-1', 'for-you-0', 'for-you-1', 'for-you-2', 'dup-1', 'top-1', 'featured-1', 'missing-art']);
	assert.equal(selected[0], newest, 'the same feed item is returned, not a copy');
	assert.equal(feed.rows[2].items[0], newest, 'selection never mutates the feed');
	assert.ok(!selected.some(entry => [localArt.Id, tmdbArt.Id, noTmdb.Id, badTmdb.Id, zeroTmdb.Id, fractionTmdb.Id, episode.Id]
		.includes(entry.Id)));
	assert.deepEqual(homeArtworkCandidates(feed, { limit: 2 }).map(entry => entry.Id), ['new-1', 'for-you-0']);
	assert.deepEqual(homeArtworkCandidates(feed, { limit: 0 }), []);
});

test('Series provider artwork and an empty Artwork are candidates, and permission is applied', () => {
	const series = { Id: 'series-1', Type: 'Series', Source: 'local', ProviderIds: { Tmdb: '55' }, Artwork: '/api/web/art/series/9' };
	const bare = { Id: 'series-2', Type: 'Series', Source: 'local', ProviderIds: { Tmdb: '56' } };
	const film = item('film-1', 57);
	const feed = { rows: [{ id: 'new', items: [series, bare, film] }], featured: [] };
	assert.deepEqual(homeArtworkCandidates(feed).map(entry => entry.Id), ['series-1', 'series-2', 'film-1']);
	assert.deepEqual(homeArtworkCandidates(feed, { permitted: entry => entry.Type === 'Movie' }).map(entry => entry.Id), ['film-1']);
	assert.deepEqual(homeArtworkCandidates(feed, { permitted: () => { throw Error('blocked'); } }), []);
});

function fakeMetadata(states, outcomes) {
	const calls = [];
	return {
		calls,
		state: entry => states.get(entry.Id) || 'none',
		async enrich(items, options) {
			calls.push({ ids: items.map(entry => entry.Id), waitMs: options?.waitMs });
			await new Promise(resolve => setImmediate(resolve));
			return items.map(entry => {
				const outcome = outcomes.get(entry.Id) || 'failed';
				if (outcome === 'cached') {
					states.set(entry.Id, 'cached');
					return { ...entry, Artwork: '/api/web/tmdb-art/movie/' + entry.ProviderIds.Tmdb + '/poster' };
				}
				states.set(entry.Id, outcome);
				return entry;
			});
		},
	};
}

test('enrich selects only missing cards once, merges resolved copies, and reports plain counts', async () => {
	const resolvedItem = item('a-resolved', 11);
	const failedItem = item('b-failed', 12);
	const cachedItem = item('c-cached', 13, { Artwork: undefined });
	const settledFailure = item('d-failed', 14);
	const pendingItem = item('e-pending', 15);
	const states = new Map([['a-resolved', 'missing'], ['b-failed', 'missing'], ['c-cached', 'cached'],
		['d-failed', 'failed'], ['e-pending', 'pending']]);
	const outcomes = new Map([['a-resolved', 'cached'], ['b-failed', 'failed']]);
	const metadata = fakeMetadata(states, outcomes);
	const original = resolvedItem;
	const feed = {
		rows: [{ id: 'new', items: [resolvedItem, failedItem] },
			{ id: 'continue', items: [cachedItem, settledFailure] },
			{ id: 'top', items: [pendingItem] }],
		featured: [resolvedItem],
	};
	const warm = createHomeArtwork({ metadata, waitMs: 5000 });
	const result = await warm.enrich(feed);
	assert.deepEqual(result, counts({ pending: 1, requested: 2, resolved: 2, failed: 2, visible: 5, remaining: 1, limit: 24 }));
	assert.deepEqual(metadata.calls, [{ ids: ['a-resolved', 'b-failed'], waitMs: 1500 }],
		'one call, only the missing cards, with a bounded wait');
	assert.equal(original.Artwork, '/api/web/art/movie/11', 'the selected feed object is not mutated');
	assert.notEqual(feed.rows[0].items[0], original, 'a resolved copy replaces the feed entry');
	assert.equal(feed.rows[0].items[0].Artwork, '/api/web/tmdb-art/movie/11/poster');
	assert.equal(feed.featured[0].Artwork, '/api/web/tmdb-art/movie/11/poster', 'featured is merged by Id');
	assert.equal(feed.rows[0].items[1], failedItem, 'a failed item stays as it was');
	const again = await warm.enrich(feed);
	assert.equal(metadata.calls.length, 1, 'cached/failed/pending cards are never requeued');
	// The resolved card now carries a TMDB artwork route, so it is no longer a
	// candidate at all; only the earlier cached card remains as resolved.
	assert.deepEqual(again, counts({ pending: 1, requested: 0, resolved: 1, failed: 2, visible: 4, remaining: 1, limit: 24 }));
	// The availability payload is counts only: no ids, titles, tokens or URLs.
	assert.deepEqual(Object.keys(result), ['pending', 'requested', 'resolved', 'failed', 'visible', 'remaining', 'limit']);
	for (const value of Object.values(result)) assert.equal(typeof value, 'number');
	assert.ok(!JSON.stringify(result).includes('a-resolved'));
	assert.ok(!/https?:|\//.test(JSON.stringify(result)));
});

test('a large rendered feed still spends only the bounded visible sample', async () => {
	const rows = Array.from({ length: 12 }, (_, row) => ({
		id: row === 0 ? 'new' : 'for-you',
		items: Array.from({ length: 50 }, (_, index) => item('r' + row + '-i' + index, 1000 + row * 50 + index)),
	}));
	const feed = { rows, featured: [] };
	const selected = homeArtworkCandidates(feed);
	assert.equal(selected.length, HOME_ARTWORK_LIMIT, '600 rendered cards select only 24');
	assert.ok(selected.every(entry => entry.Id.startsWith('r0-')), 'Recently added is served before the larger rows');

	const calls = [];
	const metadata = {
		state: () => 'missing',
		async enrich(items) { calls.push(items.length); await new Promise(resolve => setImmediate(resolve)); return items; },
	};
	const result = await createHomeArtwork({ metadata }).enrich(feed);
	assert.equal(result.requested, HOME_ARTWORK_LIMIT, 'one request spends at most the bounded sample');
	assert.equal(result.visible, HOME_ARTWORK_LIMIT * 4, 'the scan is capped independently of the catalogue size');
	assert.deepEqual(calls, [HOME_ARTWORK_LIMIT], 'no provider work beyond the selected cards');
});

test('a rejected enrichment or an empty feed returns counts without throwing', async () => {
	const broken = { state: () => 'missing', enrich: async () => { throw Error('upstream down'); } };
	const feed = { rows: [{ id: 'new', items: [item('f-1', 21)] }], featured: [] };
	const result = await createHomeArtwork({ metadata: broken }).enrich(feed);
	assert.deepEqual(result, counts({ pending: 0, requested: 1, resolved: 0, failed: 0, visible: 1, remaining: 1, limit: 24 }));
	const called = { state: () => 'none', enrich: async () => { throw Error('must not enrich'); } };
	const empty = await createHomeArtwork({ metadata: called }).enrich({ rows: [], featured: [] });
	assert.deepEqual(empty, counts({ pending: 0, requested: 0, resolved: 0, failed: 0, visible: 0, remaining: 0, limit: 24 }));
});

test('real metadata warms once, merges artwork, settles failures, and a reloaded file is warm', async t => {
	const directory = await mkdtemp(path.join(tmpdir(), 'tellybox-home-artwork-'));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const file = path.join(directory, 'vod-metadata.json');
	const data = {
		title: 'Metadata title', overview: 'A proper description', releaseDate: '2026-09-12',
		voteAverage: 8.34, voteCount: 901, runtime: 95, genres: [{ name: 'Documentary' }],
		posterPath: '/poster.jpg', backdropPath: '/backdrop.jpg',
	};
	const lookups = new Map();
	let release;
	const gate = new Promise(resolve => { release = resolve; });
	const service = createVodMetadata({ file, lookup: async (type, id) => {
		lookups.set(id, (lookups.get(id) || 0) + 1);
		if (id === 77) throw Error('offline');
		await gate;
		return { ...data, id };
	} });
	const streamed = { Id: 'streamed-55', Name: 'Provider title', Type: 'Movie', Source: 'streamed',
		ProviderIds: { Tmdb: '55' }, Artwork: '/api/web/art/movie/20' };
	assert.equal(service.state(streamed), 'missing');
	const running = service.enrich([streamed], { waitMs: 150 });
	let pending = false;
	for (let attempt = 0; attempt < 40 && !pending; attempt++) {
		await new Promise(resolve => setTimeout(resolve, 5));
		pending = service.state(streamed) === 'pending';
	}
	assert.equal(pending, true, 'an in-flight lookup is pending');
	release();
	const [enriched] = await running;
	assert.equal(service.state(streamed), 'cached');
	assert.equal(enriched.Artwork, '/api/web/tmdb-art/movie/55/poster');
	assert.equal(await service.artwork('movie', 55, 'poster'), '/poster.jpg');
	await service.enrich([streamed]);
	assert.equal(lookups.get(55), 1, 'warm metadata is not requested twice');
	const broken = { ...streamed, Id: 'streamed-77', ProviderIds: { Tmdb: '77' }, Artwork: '/api/web/art/movie/21' };
	await service.enrich([broken], { waitMs: 20 });
	assert.equal(service.state(broken), 'failed');
	assert.equal(lookups.get(77), 1);
	await service.enrich([broken], { waitMs: 20 });
	assert.equal(lookups.get(77), 1, 'a settled error is not re-requested immediately');
	await new Promise(resolve => setTimeout(resolve, 1200));
	assert.match(await readFile(file, 'utf8'), /movie\/55/);
	let reloads = 0;
	const reloaded = createVodMetadata({ file, lookup: async () => { reloads += 1; throw Error('warm reload must not call the provider'); } });
	const [warm] = await reloaded.enrich([streamed], { waitMs: 10 });
	assert.equal(reloads, 0, 'persisted metadata is reused');
	assert.equal(reloaded.state(streamed), 'cached');
	assert.equal(warm.Artwork, '/api/web/tmdb-art/movie/55/poster');
	assert.equal(await reloaded.artwork('movie', 55, 'poster'), '/poster.jpg');
});

// Three rails of twelve unique cards each, as on a real Home feed. Ids and TMDB
// ids are unique across rows so dedupe cannot hide unrequested work.
function rails(perRow) {
	const ids = ['new', 'for-you', 'continue', 'favourites', 'genre'];
	return {
		rows: ids.slice(0, perRow.length).map((id, index) => ({
			id,
			items: Array.from({ length: perRow[index] }, (_, offset) => item(
				`r${index}-${offset}`,
				5000 + index * 100 + offset,
			)),
		})),
		featured: [],
	};
}

test('36 unique visible cards resolve across two bounded calls and leave no remaining work', async () => {
	const lookups = [];
	const service = createVodMetadata({ lookup: async (type, id) => {
		lookups.push(`${type}/${id}`);
		return { id, posterPath: `/p${id}.jpg`, backdropPath: `/b${id}.jpg` };
	} });
	const feed = rails([12, 12, 12]);
	const warm = createHomeArtwork({ metadata: service });
	const first = await warm.enrich(feed);
	assert.deepEqual(first, counts({ pending: 0, requested: 24, resolved: 24, failed: 0, visible: 36, remaining: 12, limit: 24 }));
	assert.equal(lookups.length, 24, 'the first call requests only the bounded sample');
	const second = await warm.enrich(feed);
	assert.deepEqual(second, counts({ pending: 0, requested: 12, resolved: 12, failed: 0, visible: 12, remaining: 0, limit: 24 }));
	assert.equal(lookups.length, 36, 'the missing twelve are requested exactly once');
	for (const row of feed.rows) {
		for (const entry of row.items) {
			assert.equal(entry.Artwork, `/api/web/tmdb-art/movie/${entry.ProviderIds.Tmdb}/poster`,
				'all 36 visible cards end up on TMDB artwork');
		}
	}
	const third = await warm.enrich(feed);
	assert.deepEqual(third, counts({ pending: 0, requested: 0, resolved: 0, failed: 0, visible: 0, remaining: 0, limit: 24 }));
	assert.equal(lookups.length, 36);
});

test('a lookup pending on one call delivers cached artwork on the next without a new request', async () => {
	let release;
	const gate = new Promise(resolve => { release = resolve; });
	let lookups = 0;
	const service = createVodMetadata({ lookup: async (type, id) => {
		lookups += 1;
		await gate;
		return { id, posterPath: `/p${id}.jpg` };
	} });
	const slow = item('slow-1', 4242);
	const feed = { rows: [{ id: 'new', items: [slow] }], featured: [] };
	const warm = createHomeArtwork({ metadata: service });
	const first = await warm.enrich(feed, { waitMs: 0 });
	assert.deepEqual(first, counts({ pending: 1, requested: 1, resolved: 0, failed: 0, visible: 1, remaining: 1, limit: 24 }));
	assert.equal(feed.rows[0].items[0].Artwork, '/api/web/art/movie/4242', 'the provider route stays while the lookup runs');
	release();
	for (let attempt = 0; attempt < 100 && service.state(slow) !== 'cached'; attempt++) {
		await new Promise(resolve => setTimeout(resolve, 5));
	}
	assert.equal(service.state(slow), 'cached');
	// The card now carries TMDB artwork, so it is no longer a candidate at all.
	const second = await warm.enrich(feed, { waitMs: 0 });
	assert.deepEqual(second, counts({ pending: 0, requested: 0, resolved: 1, failed: 0, visible: 1, remaining: 0, limit: 24 }));
	assert.equal(lookups, 1, 'the settled lookup is never requested again');
	assert.equal(feed.rows[0].items[0].Artwork, '/api/web/tmdb-art/movie/4242/poster',
		'the late metadata reaches the already-rendered card without a second lookup');
});

test('a failed lookup is not remaining and is not requested again immediately', async () => {
	let lookups = 0;
	const service = createVodMetadata({ lookup: async () => {
		lookups += 1;
		throw Error('offline');
	} });
	const dead = item('dead-1', 7777);
	const feed = { rows: [{ id: 'new', items: [dead] }], featured: [] };
	const warm = createHomeArtwork({ metadata: service });
	const first = await warm.enrich(feed);
	assert.deepEqual(first, counts({ pending: 0, requested: 1, resolved: 0, failed: 1, visible: 1, remaining: 0, limit: 24 }));
	assert.equal(feed.rows[0].items[0], dead, 'a settled failure keeps the provider route');
	const second = await warm.enrich(feed);
	assert.deepEqual(second, counts({ pending: 0, requested: 0, resolved: 0, failed: 1, visible: 1, remaining: 0, limit: 24 }));
	assert.equal(lookups, 1, 'the 5 minute error backoff is honoured');
});

test('queue pressure bounds every call while the visible window drains', async () => {
	let lookups = 0;
	const service = createVodMetadata({ lookup: async (type, id) => {
		lookups += 1;
		return { id, posterPath: `/p${id}.jpg` };
	} });
	const feed = rails([26, 26, 26, 26, 26]);
	const warm = createHomeArtwork({ metadata: service });
	const results = [];
	for (let call = 0; call < 8; call++) {
		const result = await warm.enrich(feed);
		results.push(result);
		if (!result.remaining) break;
	}
	assert.equal(results[0].visible, HOME_ARTWORK_LIMIT * 4, 'the scan is capped independently of 130 rendered cards');
	assert.deepEqual(results.map(result => result.requested), [24, 24, 24, 24, 24, 10]);
	assert.ok(results.every(result => result.requested <= HOME_ARTWORK_LIMIT));
	assert.ok(results.every(result => result.visible <= HOME_ARTWORK_LIMIT * 4));
	assert.equal(results.at(-1).remaining, 0);
	assert.equal(lookups, 130, 'no card is requested twice and no work escapes the bound');
	for (const row of feed.rows) {
		for (const entry of row.items) assert.match(entry.Artwork, /^\/api\/web\/tmdb-art\//);
	}
});

test('a per call waitMs override is clamped and never changes the instance default', async () => {
	const waits = [];
	const metadata = {
		state: () => 'missing',
		async enrich(items, options) { waits.push(options?.waitMs); return items; },
	};
	const warm = createHomeArtwork({ metadata });
	const feedFor = tmdb => ({ rows: [{ id: 'new', items: [item('wait-' + tmdb, tmdb)] }], featured: [] });
	await warm.enrich(feedFor(1));
	await warm.enrich(feedFor(2), { waitMs: 0 });
	await warm.enrich(feedFor(3), { waitMs: 99999 });
	await warm.enrich(feedFor(4), { waitMs: -20 });
	await warm.enrich(feedFor(5), { waitMs: 'not-a-number' });
	await warm.enrich(feedFor(6));
	assert.deepEqual(waits, [150, 0, 1500, 0, 150, 150]);
});
