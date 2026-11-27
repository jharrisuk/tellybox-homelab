import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDiscoverCache, sanitizeSnapshot, stableQueryKey } from '../discover-cache.mjs';
import { createSeerr } from '../seerr.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const waitFor = async (predicate, timeout = 2000) => {
	const end = Date.now() + timeout;
	while (Date.now() < end) {
		if (predicate()) return;
		await delay(10);
	}
};
const workspace = t => {
	const directory = mkdtempSync(path.join(tmpdir(), 'discover-128b-'));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	return directory;
};
const fakeClock = (start = Date.UTC(2026, 0, 15)) => { const clock = { t: start, now: () => clock.t }; return clock; };
const row = (id, extra = {}) => ({ id, type: 'movie', title: 'Title ' + id, overview: '', poster: '/poster.jpg', date: '2025-01-01', genres: ['Drama'], ratings: [], ...extra });
const page = (...items) => ({ page: 1, pages: 1, items });

test('sanitizer stores only the public allowlist and rejects workflow, player and provider data', () => {
	const result = sanitizeSnapshot({
		page: 1, pages: 2,
		provider: { id: 8, name: 'Netflix', url: 'https://user:pass@private.test', credentials: 'secret' },
		note: 'UK catalogue',
		items: [row(7, {
			mediaInfo: { status: 5, requests: [{ id: 1, requestedBy: { email: 'private@test' } }], jellyfinMediaId: 'a'.repeat(32) },
			requests: [{ status: 2 }], requestId: 9, created: '2026-01-01', requestedSeasons: [1],
			status: 5, statusLabel: 'Available', requestable: true, seasons: [{ number: 1 }],
			watchId: 'a'.repeat(32), vodId: 'vod-1', vodProvider: 'Provider', providerUrl: 'https://user:pass@example.test',
			UserData: { Played: true }, progress: 12, favourites: ['x'], signedUrl: 'https://cdn.test/x.jpg?token=secret',
			reason: 'Because you like drama', score: 9,
			poster: 'https://cdn.test/signed.jpg?token=secret', backdrop: '/backdrop.webp',
			popularity: 42.345, rank: 2, chartTitle: 'Week ending', chartSeason: 'Season 1', chartChannel: 'Channel 4',
			ratings: [
				{ source: 'TMDB', value: 8.24, max: 10, votes: 1200, url: 'https://www.themoviedb.org/movie/7' },
				{ source: 'TMDB', value: 9, max: 10, votes: 2, url: 'https://user:pass@evil.test/x' },
				{ source: 'Private Tracker', value: 9, max: 10, votes: 2 }
			]
		})]
	});
	assert.deepEqual(Object.keys(result.items[0]).sort(), ['backdrop', 'chartChannel', 'chartSeason', 'chartTitle', 'date', 'genres', 'id', 'overview', 'popularity', 'poster', 'rank', 'ratings', 'title', 'type']);
	assert.equal(result.items[0].poster, null);
	assert.equal(result.items[0].backdrop, '/backdrop.webp');
	assert.equal(result.items[0].popularity, 42.3);
	assert.deepEqual(result.provider, { id: 8, name: 'Netflix' });
	assert.equal(result.items[0].ratings.length, 2);
	assert.equal(result.items[0].ratings[0].url, 'https://www.themoviedb.org/movie/7');
	assert.equal(result.items[0].ratings[1].url, undefined);
	const serialized = JSON.stringify(result);
	for (const forbidden of ['mediaInfo', 'requestedBy', 'watchId', 'vodId', 'providerUrl', 'UserData', 'progress', 'favourite', 'token', 'Because', 'requestable', 'statusLabel', 'credentials']) {
		assert.doesNotMatch(serialized, new RegExp(forbidden, 'i'));
	}
	assert.equal(sanitizeSnapshot({ page: 1, pages: 1, items: [] }), null);
});

test('query keys are stable and date-independent', () => {
	const key = stableQueryKey('provider', { id: 8, type: 'all', page: 1, sort: 'release', genre: '', region: 'GB' });
	assert.equal(key, 'provider|id=8|page=1|region=GB|sort=release|type=all');
	assert.doesNotMatch(key, /\d{4}-\d{2}-\d{2}/);
	assert.equal(key, stableQueryKey('provider', { region: 'GB', sort: 'release', page: 1, id: 8, type: 'all', genre: '' }));
});

test('fresh memory hits are free, stale returns last-good immediately and dedupes one refresh', async t => {
	const directory = workspace(t);
	const clock = fakeClock();
	let calls = 0;
	const cache = createDiscoverCache({ file: path.join(directory, 'snapshot.json'), now: clock.now, staleMs: 1000, maxStaleMs: 10000, schema: 's', sourceKey: 'A' });
	const load = () => { calls++; return Promise.resolve(page(row(1))); };
	const miss = await cache.get('browse|page=1', load);
	assert.equal(miss.cacheState, 'miss'); assert.equal(calls, 1);
	clock.t += 100;
	const fresh = await cache.get('browse|page=1', load);
	assert.equal(fresh.cacheState, 'fresh'); assert.equal(calls, 1);
	clock.t += 1000;
	const stale = await cache.get('browse|page=1', load);
	assert.equal(stale.cacheState, 'stale'); assert.equal(stale.stale, true);
	assert.equal(calls, 1);
	await cache.whenIdle();
	assert.equal(calls, 2);
	clock.t += 1000;
	const concurrent = await Promise.all([cache.get('browse|page=1', load), cache.get('browse|page=1', load), cache.get('browse|page=1', load)]);
	assert.ok(concurrent.every(result => result.cacheState === 'stale' && result.items[0].id === 1));
	await cache.whenIdle();
	assert.equal(calls, 3);
	await cache.flush();
});

test('cold loads are deduped, active/queue are bounded and the key space is capped', async t => {
	const directory = workspace(t);
	const clock = fakeClock();
	const cache = createDiscoverCache({ now: clock.now, staleMs: 1000, maxActive: 1, maxQueue: 1, maxEntries: 2, schema: 's', sourceKey: 'A' });
	let calls = 0;
	const slow = () => { calls++; return delay(10).then(() => page(row(1))); };
	const same = await Promise.all(Array.from({ length: 12 }, () => cache.get('same', slow)));
	assert.equal(calls, 1);
	assert.ok(same.every(result => result.items.length === 1));
	const gates = [];
	const gate = id => () => new Promise(resolve => gates.push(() => resolve(page(row(id)))));
	const first = cache.get('a', gate(1));
	const second = cache.get('b', gate(2));
	await delay(5);
	await assert.rejects(cache.get('c', gate(3)), error => error.status === 503 && error.code === 'discover_busy');
	gates.shift()();
	await first;
	await delay(5);
	gates.shift()();
	await second;
	await cache.whenIdle();
	assert.equal(cache.status().entries, 2);
	assert.equal(cache.status().active, 0);
});

test('failed, empty or malformed refresh never replaces last-good data', async t => {
	const directory = workspace(t);
	const file = path.join(directory, 'snapshot.json');
	const clock = fakeClock();
	const cache = createDiscoverCache({ file, now: clock.now, staleMs: 1000, maxStaleMs: 10000, schema: 's', sourceKey: 'A' });
	await cache.get('k', async () => page(row(1)));
	await cache.flush();
	clock.t += 1000;
	const failed = cache.get('k', async () => { throw Error('upstream down'); });
	void failed;
	await cache.whenIdle();
	assert.equal((await cache.get('k', async () => { throw Error('upstream down'); })).items[0].id, 1);
	await cache.whenIdle();
	await cache.flush();
	assert.equal(JSON.parse(readFileSync(file, 'utf8')).entries.k.payload.items[0].id, 1);
	clock.t += 1000;
	const empty = await cache.get('k', async () => page());
	assert.equal(empty.cacheState, 'stale');
	await cache.whenIdle();
	await cache.flush();
	assert.equal(JSON.parse(readFileSync(file, 'utf8')).entries.k.payload.items[0].id, 1);
	clock.t += 20000;
	const expired = await cache.get('k', async () => { throw Error('still down'); });
	assert.equal(expired.cacheState, 'expired');
	assert.equal(expired.stale, true); assert.equal(expired.degraded, true);
	assert.equal(expired.items[0].id, 1);
});

test('restart rehydrates the durable snapshot and startup catches up overdue entries', async t => {
	const directory = workspace(t);
	const file = path.join(directory, 'snapshot.json');
	const clock = fakeClock();
	const first = createDiscoverCache({ file, now: clock.now, staleMs: 1000, maxStaleMs: 100000, schema: 's', sourceKey: 'A' });
	await first.get('k', async () => page(row(1)));
	await first.flush();
	first.stop();
	clock.t += 500;
	const second = createDiscoverCache({ file, now: clock.now, staleMs: 1000, maxStaleMs: 100000, schema: 's', sourceKey: 'A' });
	let calls = 0;
	const loaded = await second.get('k', async () => { calls++; return page(row(9)); });
	assert.equal(calls, 0);
	assert.equal(loaded.items[0].id, 1);
	assert.equal(loaded.cacheState, 'fresh');
	clock.t += 86400000;
	let warmed = 0;
	second.start([{ key: 'k', load: async () => { warmed++; return page(row(2)); } }]);
	await second.whenIdle();
	assert.equal(warmed, 1);
	assert.equal((await second.get('k', async () => { throw Error('must not load'); })).items[0].id, 2);
	second.stop();
});

test('the daily timer refreshes with no visitor at all and stop() ends it', async t => {
	const directory = workspace(t);
	const clock = fakeClock();
	let calls = 0;
	const cache = createDiscoverCache({ file: path.join(directory, 'snapshot.json'), now: clock.now, dayMs: 60, staleMs: 1000, maxStaleMs: 10000, schema: 's', sourceKey: 'A' });
	cache.start([{ key: 'k', load: async () => { calls++; return page(row(calls)); } }]);
	await cache.whenIdle();
	assert.equal(calls, 1);
	assert.equal(cache.status().scheduled, true);
	clock.t += 61;
	await waitFor(() => calls === 2);
	await cache.whenIdle();
	assert.equal(calls, 2);
	cache.stop();
	assert.equal(cache.status().scheduled, false);
	clock.t += 61;
	await delay(120);
	assert.equal(calls, 2);
});

test('source A results are discarded for source B, including delayed writes', async t => {
	const directory = workspace(t);
	const file = path.join(directory, 'snapshot.json');
	const clock = fakeClock();
	let source = 'A';
	let release;
	const cache = createDiscoverCache({ file, now: clock.now, staleMs: 1000, maxStaleMs: 10000, schema: 's', sourceKey: () => source, maxActive: 2 });
	const pending = cache.get('k', () => new Promise(resolve => { release = () => resolve(page(row(1))); }));
	await delay(5);
	source = 'B';
	const fromB = await cache.get('k', async () => page(row(2)));
	assert.equal(fromB.items[0].id, 2);
	release();
	await assert.rejects(pending, error => error.code === 'discover_source_changed');
	await cache.flush();
	const disk = JSON.parse(readFileSync(file, 'utf8'));
	assert.deepEqual(Object.values(disk.entries).map(entry => entry.payload.items[0].id), [2]);
	const other = path.join(directory, 'other.json');
	const a = createDiscoverCache({ file: other, now: clock.now, staleMs: 1000, schema: 's', sourceKey: 'A' });
	await a.get('k', async () => page(row(1)));
	await a.flush();
	const b = createDiscoverCache({ file: other, now: clock.now, staleMs: 1000, schema: 's', sourceKey: 'B' });
	let called = 0;
	const isolated = await b.get('k', async () => { called++; return page(row(3)); });
	assert.equal(called, 1);
	assert.equal(isolated.items[0].id, 3);
});

test('corrupt, wrong-schema and expired snapshots recover without throwing', async t => {
	const directory = workspace(t);
	const file = path.join(directory, 'snapshot.json');
	const clock = fakeClock();
	writeFileSync(file, '{not json');
	const cache = createDiscoverCache({ file, now: clock.now, staleMs: 1000, maxStaleMs: 2000, schema: 's', sourceKey: 'A' });
	let calls = 0;
	const recovered = await cache.get('k', async () => { calls++; return page(row(1)); });
	assert.equal(calls, 1); assert.equal(recovered.items[0].id, 1);
	await cache.flush();
	assert.equal(JSON.parse(readFileSync(file, 'utf8')).entries.k.payload.items[0].id, 1);
	writeFileSync(file, JSON.stringify({ version: 1, schema: 'old', fingerprint: 'x', entries: { k: { at: clock.now(), payload: page(row(8)) } } }));
	const wrongSchema = createDiscoverCache({ file, now: clock.now, staleMs: 1000, maxStaleMs: 2000, schema: 's', sourceKey: 'A' });
	let again = 0;
	const fresh = await wrongSchema.get('k', async () => { again++; return page(row(2)); });
	assert.equal(again, 1); assert.equal(fresh.items[0].id, 2);
	clock.t += 5000;
	let expiredCalls = 0;
	const expired = await wrongSchema.get('k', async () => { expiredCalls++; return page(row(3)); });
	assert.equal(expiredCalls, 1); assert.equal(expired.items[0].id, 3);
});

test('sequential caller timeouts keep one loader and one admission slot', async t => {
	const clock = fakeClock();
	const cache = createDiscoverCache({ now: clock.now, maxActive: 1, maxQueue: 1, loadTimeoutMs: 10, schema: 's', sourceKey: 'A' });
	let calls = 0;
	let signal = null;
	let settle = null;
	const hung = provided => {
		calls++;
		signal = provided;
		return new Promise(resolve => { settle = () => resolve(page(row(1))); });
	};
	const timedOut = error => error.status === 503 && error.code === 'discover_busy' && /too long/.test(error.message);
	for (let attempt = 0; attempt < 4; attempt++) await assert.rejects(cache.get('same', hung), timedOut);
	assert.equal(calls, 1);
	assert.equal(signal.aborted, true);
	assert.deepEqual(
		{ active: cache.status().active, inflight: cache.status().inflight, queued: cache.status().queued, quarantined: cache.status().quarantined },
		{ active: 1, inflight: 1, queued: 0, quarantined: 1 }
	);
	settle();
	await waitFor(() => cache.status().active === 0);
	assert.deepEqual(
		{ active: cache.status().active, inflight: cache.status().inflight, queued: cache.status().queued, quarantined: cache.status().quarantined },
		{ active: 0, inflight: 0, queued: 0, quarantined: 0 }
	);
	let laterCalls = 0;
	const later = await cache.get('same', async () => { laterCalls++; return page(row(2)); });
	assert.equal(laterCalls, 1);
	assert.equal(later.items[0].id, 2);
	cache.stop();
});

test('timeouts on other keys cannot multiply a hung loader past maxActive', async t => {
	const clock = fakeClock();
	const cache = createDiscoverCache({ now: clock.now, maxActive: 1, maxQueue: 1, loadTimeoutMs: 10, queueWaitMs: 1000, schema: 's', sourceKey: 'A' });
	let calls = 0;
	let settle = null;
	const hung = () => {
		calls++;
		return new Promise(resolve => { settle = () => resolve(page(row(1))); });
	};
	await assert.rejects(cache.get('first', hung), error => error.code === 'discover_busy' && /too long/.test(error.message));
	for (const key of ['second', 'third', 'fourth']) {
		await assert.rejects(cache.get(key, hung), error => error.code === 'discover_busy' && /too long/.test(error.message));
	}
	assert.equal(calls, 1);
	assert.deepEqual(
		{ active: cache.status().active, inflight: cache.status().inflight, queued: cache.status().queued, quarantined: cache.status().quarantined },
		{ active: 1, inflight: 1, queued: 0, quarantined: 1 }
	);
	settle();
	await waitFor(() => cache.status().active === 0);
	const recovered = await cache.get('second', async () => page(row(2)));
	assert.equal(recovered.items[0].id, 2);
	cache.stop();
});

test('a cooperative loader receives an abort signal and recovers the slot', async t => {
	const clock = fakeClock();
	const cache = createDiscoverCache({ now: clock.now, maxActive: 1, maxQueue: 0, loadTimeoutMs: 10, schema: 's', sourceKey: 'A' });
	let calls = 0;
	let signal = null;
	const cooperative = provided => {
		calls++;
		signal = provided;
		return new Promise((resolve, reject) => {
			const abort = () => reject(Object.assign(Error('aborted'), { name: 'AbortError' }));
			if (provided.aborted) abort();
			else provided.addEventListener('abort', abort, { once: true });
		});
	};
	await assert.rejects(cache.get('coop', cooperative), error => error.code === 'discover_busy' && /too long/.test(error.message));
	assert.equal(calls, 1);
	assert.equal(signal.aborted, true);
	await waitFor(() => cache.status().active === 0 && cache.status().inflight === 0);
	assert.equal(cache.status().quarantined, 0);
	const recovered = await cache.get('coop', async () => page(row(3)));
	assert.equal(recovered.items[0].id, 3);
	cache.stop();
});

test('a timed-out late result is discarded and stale last-good survives', async t => {
	const directory = workspace(t);
	const file = path.join(directory, 'snapshot.json');
	const clock = fakeClock();
	const cache = createDiscoverCache({ file, now: clock.now, staleMs: 1000, maxStaleMs: 10000, maxActive: 1, maxQueue: 1, loadTimeoutMs: 10, schema: 's', sourceKey: 'A' });
	await cache.get('k', async () => page(row(1)));
	await cache.flush();
	clock.t += 1000;
	let settle = null;
	void cache.get('k', () => new Promise(resolve => { settle = () => resolve(page(row(9))); }));
	await waitFor(() => cache.status().quarantined === 1);
	settle();
	await waitFor(() => cache.status().active === 0);
	await cache.flush();
	const disk = JSON.parse(readFileSync(file, 'utf8'));
	assert.equal(disk.entries.k.payload.items[0].id, 1);
	const stale = await cache.get('k', async () => page(row(2)));
	assert.equal(stale.cacheState, 'stale');
	assert.equal(stale.items[0].id, 1);
	cache.stop();
});

test('a timed-out loader cannot commit into a later source generation', async t => {
	const directory = workspace(t);
	const file = path.join(directory, 'snapshot.json');
	const clock = fakeClock();
	let source = 'A';
	const cache = createDiscoverCache({ file, now: clock.now, staleMs: 60000, maxStaleMs: 100000, maxActive: 1, maxQueue: 1, loadTimeoutMs: 10, schema: 's', sourceKey: () => source });
	let settle = null;
	await assert.rejects(cache.get('k', () => new Promise(resolve => { settle = () => resolve(page(row(1))); })), error => error.code === 'discover_busy');
	assert.equal(cache.status().quarantined, 1);
	source = 'B';
	settle();
	await waitFor(() => cache.status().active === 0);
	await cache.get('other', async () => page(row(2)));
	await cache.flush();
	assert.deepEqual(Object.keys(JSON.parse(readFileSync(file, 'utf8')).entries), ['other']);
	cache.stop();
});

test('a timed-out key still consumes maxActive and maxQueue', async t => {
	const clock = fakeClock();
	const cache = createDiscoverCache({ now: clock.now, maxActive: 1, maxQueue: 1, loadTimeoutMs: 30, queueWaitMs: 2000, schema: 's', sourceKey: 'A' });
	let hungCalls = 0;
	let settleHung = null;
	const hung = () => {
		hungCalls++;
		return new Promise(resolve => { settleHung = () => resolve(page(row(1))); });
	};
	await assert.rejects(cache.get('hung', hung), error => error.code === 'discover_busy' && /too long/.test(error.message));
	let settleQueued = null;
	const queued = cache.get('queued', () => new Promise(resolve => { settleQueued = () => resolve(page(row(2))); }));
	await delay(5);
	assert.equal(cache.status().active, 1);
	assert.equal(cache.status().queued, 1);
	assert.equal(cache.status().quarantined, 1);
	await assert.rejects(cache.get('extra', async () => page(row(3))), error => error.status === 503 && error.code === 'discover_busy');
	assert.equal(hungCalls, 1);
	settleHung();
	await waitFor(() => typeof settleQueued === 'function');
	settleQueued();
	const result = await queued;
	assert.equal(result.items[0].id, 2);
	await cache.whenIdle();
	assert.equal(cache.status().active, 0);
	cache.stop();
});

function seerrFixture(cache) {
	const paths = [];
	const stats = { enrichCalls: 0 };
	const service = createSeerr({
		config: () => ({ url: 'http://seerr.test', key: 'synthetic' }),
		discoverCache: cache,
		enrich: async items => { stats.enrichCalls++; return items.map(item => ({ ...item, availabilityRecomputed: true })); },
		fetcher: async url => {
			paths.push(url.pathname + url.search);
			const tv = url.pathname.endsWith('/tv');
			return Response.json({
				page: 1, totalPages: 1,
				results: [{ id: tv ? 2 : 1, mediaType: tv ? 'tv' : 'movie', title: tv ? 'Show' : 'Film', posterPath: '/poster.jpg', releaseDate: '2025-01-01',
					mediaInfo: { status: 5, jellyfinMediaId: 'a'.repeat(32) }, requests: [{ status: 2, requestedBy: { email: 'private@test' } }] }]
			});
		}
	});
	return { service, paths, stats };
}

test('generic browse and provider rails share the public cache and reapply current overlays', async t => {
	const directory = workspace(t);
	const clock = fakeClock();
	let source = 'A';
	const cache = createDiscoverCache({ file: path.join(directory, 'snapshot.json'), now: clock.now, staleMs: 5000, maxStaleMs: 10000, schema: 's', sourceKey: () => source });
	const { service, paths, stats } = seerrFixture(cache);
	const first = await service.browse('', 1, 'movie', 'popular');
	assert.equal(first.cacheState, 'miss');
	assert.equal(first.items[0].statusLabel, 'Available');
	assert.equal(first.items[0].watchId, 'a'.repeat(32));
	const second = await service.browse('', 1, 'movie', 'popular');
	assert.equal(second.cacheState, 'fresh');
	assert.equal(paths.length, 1);
	assert.equal(second.items[0].statusLabel, 'Not in your library');
	assert.equal(second.items[0].watchId, null);
	assert.equal(second.items[0].availabilityRecomputed, true);
	assert.ok(stats.enrichCalls >= 2);
	const rail = await service.provider(8);
	const railAgain = await service.provider(8);
	assert.equal(paths.length, 3);
	assert.equal(railAgain.cacheState, 'fresh');
	assert.equal(railAgain.provider.name, 'Netflix');
	assert.equal(railAgain.items[0].statusLabel, 'Not in your library');
	assert.equal(railAgain.items[0].requestable, false);
	source = 'B';
	const switched = await service.provider(8);
	assert.equal(switched.cacheState, 'miss');
	assert.equal(paths.length, 5);
	await cache.flush();
	const disk = readFileSync(path.join(directory, 'snapshot.json'), 'utf8');
	assert.doesNotMatch(disk, /seerr\.test|synthetic|private@test|mediaInfo|requests|requestedBy|watchId|jellyfinMediaId/);
});

test('documentary category browsing shares the same sanitized public cache', async t => {
	const directory = workspace(t);
	const clock = fakeClock();
	const cache = createDiscoverCache({ file: path.join(directory, 'snapshot.json'), now: clock.now, staleMs: 5000, maxStaleMs: 10000, schema: 's', sourceKey: 'A' });
	const { service, paths } = seerrFixture(cache);
	const first = await service.category('Documentary', 'movie');
	const second = await service.category('Documentary', 'movie');
	assert.equal(first.cacheState, 'miss');
	assert.equal(second.cacheState, 'fresh');
	assert.equal(paths.length, 1);
	assert.equal(second.items[0].statusLabel, 'Not in your library');
	assert.equal(second.items[0].watchId, null);
	await cache.flush();
	assert.doesNotMatch(readFileSync(path.join(directory, 'snapshot.json'), 'utf8'), /mediaInfo|jellyfinMediaId|requestedBy/);
});

test('the landing warm set is finite: browse, provider and new-release shelves only', async t => {
	const directory = workspace(t);
	const clock = fakeClock();
	const cache = createDiscoverCache({ file: path.join(directory, 'snapshot.json'), now: clock.now, staleMs: 60000, maxStaleMs: 100000, schema: 's', sourceKey: 'A' });
	const { service, paths } = seerrFixture(cache);
	service.startDiscoverCache();
	await cache.whenIdle();
	assert.equal(paths.length, 29);
	const providerIds = new Set(paths.filter(route => route.includes('watchProviders=')).map(route => new URL('http://x' + route).searchParams.get('watchProviders')));
	for (const id of ['8', '9', '337', '350', '531', '38|41|103|333|39']) assert.ok(providerIds.has(id), 'warm set includes provider ' + id);
	assert.ok(paths.every(route => !route.includes('genre=')));
	for (const route of paths.filter(value => value.startsWith('/discover/'))) {
		assert.equal(new URL('http://x' + route).searchParams.get('page'), '1');
	}
	const before = paths.length;
	const rail = await service.provider(8);
	assert.equal(paths.length, before);
	assert.equal(rail.cacheState, 'fresh');
	cache.stop();
});

test('no cache passed keeps the historical uncached behavior', async t => {
	const { service, paths } = seerrFixture(null);
	const first = await service.browse('', 1, 'movie', 'popular');
	const second = await service.browse('', 1, 'movie', 'popular');
	assert.equal(paths.length, 2);
	assert.equal(first.items[0].statusLabel, 'Available');
	assert.equal(second.items[0].statusLabel, 'Available');
	assert.equal(second.cacheState, undefined);
	assert.equal(service.startDiscoverCache(), null);
});
