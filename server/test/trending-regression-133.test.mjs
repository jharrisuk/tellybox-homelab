/* Release 133: adversarial chart-cache regressions.
 *
 * These cases reproduce the independent PRIMARY preliminary review with real
 * modules: global upstream admission (including hung loaders), public-only
 * snapshots, strict legacy-source rejection, bounded startup reads and
 * generation-scoped pending work. They also cover the scheduler forwarding its
 * playback gate into the chart preload and treating a mid-run deferral as a
 * short retry rather than a successful hourly refresh.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createTrending, trendingGroups } from '../trending.mjs';
import { createTrendingPreload } from '../trending-preload.mjs';
import { mediaView } from '../seerr.mjs';

const HOUR = 3600000;
const NOW = 1_800_000_000_000;
const sourceFingerprint = source => createHash('sha256').update('trending-133\u0000' + String(source)).digest('hex').slice(0, 32);
const validKeys = [...new Set(trendingGroups.flatMap(group => group.rows))];

function directory(t, prefix = 'tellybox-trending-regression-') {
	const dir = mkdtempSync(path.join(tmpdir(), prefix));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

function movie(id, title = 'Title ' + id, extra = {}) {
	return { id, mediaType: 'movie', title, posterPath: '/poster-' + id + '.jpg', ...extra };
}

test('distinct chart keys share one global admission bound across preloads', async t => {
	const dir = directory(t);
	let active = 0, peak = 0;
	const service = createTrending({
		call: () => { peak = Math.max(peak, ++active); return new Promise(() => {}); },
		view: (item, type) => ({ id: item.id, type, title: item.title }),
		cachePath: path.join(dir, 'charts.json'),
		now: () => NOW,
		maxActive: 2,
		maxQueue: 8,
		queueWaitMs: 50,
		callTimeoutMs: 40
	});
	// Same shape as the PRIMARY repro: many distinct keys, no visitor.
	for (const key of validKeys) void service.preload([key]);
	await new Promise(resolve => setTimeout(resolve, 25));
	assert.equal(peak, 2, 'at most maxActive underlying calls exist, not one per key');
	const status = service.status();
	assert.equal(status.admission.active, 2, 'occupied slots include the hung physical calls');
	assert.ok(status.admission.queued <= 8, 'the queue itself is bounded');
});

test('an abandoned caller leaves its physical slot quarantined; queued work fails closed', async t => {
	const dir = directory(t);
	let active = 0, peak = 0;
	const service = createTrending({
		call: () => { peak = Math.max(peak, ++active); return new Promise(() => {}); },
		view: (item, type) => ({ id: item.id, type, title: item.title }),
		cachePath: path.join(dir, 'charts.json'),
		now: () => NOW,
		maxActive: 1,
		maxQueue: 2,
		queueWaitMs: 80,
		callTimeoutMs: 30
	});
	await assert.rejects(service.trending('week-movie'), /took too long/i);
	const first = service.status();
	assert.equal(peak, 1);
	assert.equal(first.admission.active, 1, 'the timeout does not free the still-running physical call');
	assert.ok(first.admission.quarantined >= 1, 'the stuck slot is reported as quarantined');

	const queued = await service.preload(['week-tv']);
	assert.equal(queued.ran, 0);
	assert.equal(queued.failed, 1, 'a queued caller times out instead of exceeding the bound');
	assert.equal(peak, 1, 'the queued attempt never opened a second upstream call');
	assert.equal(service.status().admission.active, 1, 'the quarantined slot is still held');
});

test('persisted charts contain public catalogue fields only and hits carry neutral status', async t => {
	const dir = directory(t);
	const file = path.join(dir, 'charts.json');
	const service = createTrending({
		call: async () => ({ results: [{ id: 1, mediaType: 'movie', title: 'Fixture', overview: 'Public overview', mediaInfo: { status: 3, requests: [{ status: 2, is4k: false }], jellyfinMediaId: 'abcdefabcdefabcdefabcdefabcdef12' } }] }),
		view: mediaView,
		cachePath: file,
		now: () => NOW,
		sourceKey: () => 'source-a'
	});
	const live = await service.trending('week-movie');
	assert.equal(live.items[0].status, 3, 'the requesting visitor still sees the live workflow view');
	assert.equal(live.items[0].requestable, false);
	// Writes are intentionally serialized in the background so a visitor never
	// waits on disk; wait for the atomic part+rename to land.
	for (let attempt = 0; attempt < 20; attempt++) {
		try { readFileSync(file); break; } catch { await new Promise(resolve => setTimeout(resolve, 5)); }
	}

	const saved = JSON.parse(readFileSync(file, 'utf8'));
	const item = saved.entries['week-movie'].data.items[0];
	assert.equal(item.id, 1);
	assert.equal(item.title, 'Fixture');
	for (const field of ['status', 'statusLabel', 'requestable', 'watchId', 'seasons', 'mediaInfo', 'requests']) {
		assert.equal(Object.hasOwn(item, field), false, field + ' is not public snapshot data');
	}
	assert.equal(JSON.stringify(saved).includes('abcdefabcdefabcdefabcdefabcdef12'), false, 'no library/private id is persisted');

	const hit = await service.trending('week-movie');
	assert.equal(hit.items[0].status, 6, 'a cache hit has no trustworthy request status');
	assert.equal(hit.items[0].statusLabel, 'Status not checked');
	assert.equal(hit.items[0].requestable, false);
	assert.equal(hit.items[0].watchId, null);

	const enriched = createTrending({
		call: async () => ({ results: [{ id: 1, mediaType: 'movie', title: 'Fixture', mediaInfo: { status: 3 } }] }),
		view: mediaView,
		enrich: async items => items.map(item => ({ ...item, vodAvailable: true, watchId: 'current-library-id' })),
		cachePath: file,
		now: () => NOW,
		sourceKey: () => 'source-a'
	});
	const current = await enriched.trending('week-movie');
	assert.equal(current.items[0].vodAvailable, true, 'availability is recomputed per request');
	assert.equal(current.items[0].watchId, 'current-library-id', 'current per-request library state wins');
});

test('a legacy flat snapshot is never served under a configured source', async t => {
	const dir = directory(t);
	const file = path.join(dir, 'legacy.json');
	writeFileSync(file, JSON.stringify({
		'week-movie': { time: NOW, data: { title: 'legacy', items: [{ id: 99, type: 'movie', title: 'old-source', status: 3 }] } }
	}));
	let calls = 0;
	const service = createTrending({
		call: async () => { calls++; return { results: [movie(1, 'current-source')] }; },
		view: (item, type) => ({ id: item.id, type, title: item.title }),
		cachePath: file,
		now: () => NOW,
		sourceKey: () => 'different-source'
	});
	const chart = await service.trending('week-movie');
	assert.equal(calls, 1, 'the configured source is fetched instead of trusting the unknown file');
	assert.equal(chart.items[0].title, 'current-source');
	assert.equal(chart.items.some(item => item.title === 'old-source'), false);
});

test('a legacy flat snapshot without any source identity is loaded, sanitized and still public', async t => {
	const dir = directory(t);
	const file = path.join(dir, 'legacy.json');
	writeFileSync(file, JSON.stringify({
		'week-movie': { time: NOW, data: { title: 'legacy', items: [{ id: 99, type: 'movie', title: 'legacy-title', status: 5, requestable: true, watchId: 'private-id' }] } }
	}));
	let calls = 0;
	const service = createTrending({
		call: async () => { calls++; return { results: [movie(1)] }; },
		view: (item, type) => ({ id: item.id, type, title: item.title }),
		cachePath: file,
		now: () => NOW
	});
	const chart = await service.trending('week-movie');
	assert.equal(calls, 0, 'no-source legacy last-good is reused');
	assert.equal(chart.items[0].title, 'legacy-title');
	assert.equal(chart.items[0].watchId, null, 'legacy workflow state is not replayed');
	assert.equal(chart.items[0].status, 6);
});

test('startup reads are size-bounded, key-allowlisted and field-sanitized', async t => {
	const dir = directory(t);
	const file = path.join(dir, 'charts.json');
	const body = JSON.stringify({
		version: 2,
		source: sourceFingerprint('source-a'),
		entries: {
			'week-movie': { time: NOW, data: { items: [movie(1, 'kept', { status: 5, watchId: 'private-id' })] } },
			evil: { time: NOW, data: { items: [movie(2, 'unknown-key')] } }
		},
		padding: 'x'.repeat(2048)
	});
	writeFileSync(file, body);
	let calls = 0;
	const service = createTrending({
		call: async () => { calls++; return { results: [movie(3, 'fresh')] }; },
		view: (item, type) => ({ id: item.id, type, title: item.title }),
		cachePath: file,
		now: () => NOW,
		sourceKey: () => 'source-a',
		maxReadBytes: 1024
	});
	await service.preload(['week-movie']);
	assert.equal(calls, 1, 'an oversized snapshot is not parsed or served');
	assert.equal(service.status().entries, 1, 'only the fresh allowed key exists after the bounded refresh');
	const saved = JSON.parse(readFileSync(file, 'utf8'));
	assert.equal(saved.entries.evil, undefined, 'unknown keys are never written back');
	assert.equal(Object.hasOwn(saved.entries['week-movie'].data.items[0], 'watchId'), false);
});

test('an old-generation pending chart cannot block or overwrite the new source', async t => {
	const dir = directory(t);
	const file = path.join(dir, 'charts.json');
	let source = 'source-a', resolveOld;
	const oldCall = () => new Promise(resolve => { resolveOld = resolve; });
	let calls = 0;
	const service = createTrending({
		call: async () => {
			calls++;
			if (source === 'source-a') return oldCall();
			return { results: [movie(1, 'new-source')] };
		},
		view: (item, type) => ({ id: item.id, type, title: item.title }),
		cachePath: file,
		now: () => NOW,
		sourceKey: () => source,
		maxActive: 2
	});
	const old = service.preload(['week-movie']);
	await new Promise(resolve => setTimeout(resolve, 10));
	assert.equal(calls, 1, 'the old generation started one bounded upstream call');

	source = 'source-b';
	const fresh = await service.preload(['week-movie']);
	assert.equal(fresh.ran, 1);
	assert.equal(calls, 2, 'the new generation starts its own fetch instead of joining old pending work');
	const chart = await service.trending('week-movie');
	assert.equal(chart.items[0].title, 'new-source');
	const saved = JSON.parse(readFileSync(file, 'utf8'));
	assert.equal(saved.entries['week-movie'].data.items[0].title, 'new-source');

	// The late old result is discarded, not published over the new generation.
	resolveOld({ results: [movie(2, 'old-source')] });
	const oldResult = await old;
	assert.equal(oldResult.failed, 1, 'the late old generation fails closed');
	assert.equal(JSON.parse(readFileSync(file, 'utf8')).entries['week-movie'].data.items[0].title, 'new-source');
	assert.equal((await service.trending('week-movie')).items[0].title, 'new-source');
});

test('the scheduler forwards its busy gate and retries a mid-run deferral shortly', async () => {
	const timers = [];
	const setTimer = (fn, ms) => { const handle = { fn, ms, cleared: false }; timers.push(handle); return { unref() {}, __handle: handle }; };
	const clearTimer = handle => { handle.__handle.cleared = true; };
	let busy = false, seen = null;
	const scheduler = createTrendingPreload({
		warm: async options => { seen = options; assert.equal(options.isBusy(), busy); return { deferred: true, failed: 0 }; },
		isBusy: () => busy,
		setTimer, clearTimer,
		startDelayMs: 100, intervalMs: 60000, retryMs: 5000, busyMs: 7000
	});
	const last = () => timers[timers.length - 1];
	scheduler.start();
	await last().fn();
	assert.equal(typeof seen?.isBusy, 'function', 'preload receives the same playback gate');
	assert.equal(last().ms, 7000, 'a mid-run deferral retries after a short busy interval, not an hour');
	assert.equal(scheduler.status().runs, 1);
	assert.equal(scheduler.status().deferred, 1);
	assert.equal(scheduler.status().last.deferred, true);
	scheduler.stop();
});

test('preload stops between chart pairs when playback starts mid-run', async t => {
	const dir = directory(t);
	const header = 'country_name\tcountry_iso2\tweek\tcategory\tweekly_rank\tshow_title\tseason_title';
	const rows = ['TV', 'Films'].flatMap(type => Array.from({ length: 10 }, (_, index) => `United Kingdom\tGB\t2026-10-18\t${type}\t${index + 1}\tTitle ${index + 1}\t${type === 'TV' ? 'Season 1' : 'N/A'}`));
	let calls = 0, busy = false;
	const service = createTrending({
		fetcher: async () => new Response([header, ...rows].join('\n')),
		call: async route => {
			calls++;
			if (calls >= 2) busy = true;
			return { results: [{ id: calls, title: 'Title ' + calls, mediaType: 'movie', posterPath: '/poster-' + calls + '.jpg' }] };
		},
		view: (item, type) => ({ id: item.id, type, title: item.title }),
		cachePath: path.join(dir, 'charts.json'),
		now: () => NOW,
		sourceKey: () => 'source-a'
	});
	const result = await service.preload(['netflix-movie'], { isBusy: () => busy });
	assert.equal(result.deferred, true);
	assert.equal(result.ran, 0, 'a partially resolved chart is not recorded as completed');
	assert.equal(calls, 2, 'the second pair is never started');
	assert.equal(service.status().entries, 1, 'only the bounded chart source is cached, not the partial chart');
});
