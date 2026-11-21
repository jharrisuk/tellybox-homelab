/* Release 133: clock-driven shared chart preload.
 *
 * The default Discover charts are a separate cache from the browse/provider
 * snapshots. These tests cover no-visit warm, TTL skip, restart persistence,
 * offline last-good, source invalidation, bounded/concurrent preload and the
 * playback-aware scheduler, all with a fake clock and real createTrending.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createTrending } from '../trending.mjs';
import { createTrendingPreload } from '../trending-preload.mjs';

const HOUR = 3600000;
function fixture(t) {
	const directory = mkdtempSync(path.join(tmpdir(), 'tellybox-trending-preload-'));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	let calls = 0, broken = false;
	const service = {
		calls: () => calls,
		break() { broken = true; },
		async call(route) {
			calls += 1;
			if (broken) throw Error('charts offline');
			const type = route.includes('mediaType=tv') ? 'tv' : 'movie';
			return { results: [{ id: calls, mediaType: type, title: 'Title ' + calls, posterPath: '/poster-' + calls + '.jpg' }] };
		}
	};
	let now = 1_800_000_000_000, source = 'https://seerr.example\u0000key-a', enrichCalls = 0;
	const make = () => createTrending({
		call: service.call,
		view: (item, type) => ({ id: item.id, type, title: item.title }),
		enrich: async items => { enrichCalls += 1; return items; },
		cachePath: path.join(directory, 'trending-cache.json'),
		now: () => now,
		sourceKey: () => source
	});
	return {
		directory, service, make,
		enrichCalls: () => enrichCalls,
		advance(ms) { now += ms; },
		setSource(value) { source = value; },
		get now() { return now; }
	};
}

test('no-visit preload warms default rows, respects the hourly TTL and survives restart', async t => {
	const f = fixture(t);
	const service = f.make();
	const first = await service.preload(['week-movie', 'week-tv']);
	assert.deepEqual({ ran: first.ran, skipped: first.skipped, failed: first.failed }, { ran: 2, skipped: 0, failed: 0 });
	assert.equal(f.service.calls(), 2);

	const again = await service.preload(['week-movie', 'week-tv']);
	assert.equal(again.ran, 0);
	assert.equal(again.skipped, 2);
	assert.equal(f.service.calls(), 2, 'a preload inside the TTL performs no upstream calls');
	assert.equal(f.enrichCalls(), 0, 'preload caches public chart data without per-request enrichment');

	// A fresh process reads the same file and does not call upstream.
	const restarted = f.make();
	const afterRestart = await restarted.preload(['week-movie', 'week-tv']);
	assert.equal(afterRestart.skipped, 2);
	assert.equal(f.service.calls(), 2, 'restart persistence avoids a cold visitor fetch');
	const chart = await restarted.trending('week-movie');
	assert.ok(Array.isArray(chart.items) && chart.items.length, 'the persisted chart is served');
	assert.equal(f.service.calls(), 2, 'serving the persisted chart does not call upstream');

	f.advance(HOUR + 1);
	const refreshed = await service.preload(['week-movie', 'week-tv']);
	assert.equal(refreshed.ran, 2, 'the clock refreshes rows after the TTL');
	assert.equal(f.service.calls(), 4);
});

test('long provider failure keeps the last good chart; preload is bounded and coalesced', async t => {
	const f = fixture(t);
	const service = f.make();
	await service.preload(['week-movie']);
	assert.equal(f.service.calls(), 1);
	f.service.break();
	f.advance(HOUR + 1);
	const failed = await service.preload(['week-movie']);
	assert.equal(failed.failed, 1);
	const stale = await service.trending('week-movie');
	assert.equal(stale.stale, true, 'a failed refresh is clearly marked stale');
	assert.ok(stale.items.length, 'last-good public chart data is retained');
	assert.equal(f.service.calls(), 2);

	const fresh = fixture(t).make();
	const bounded = await fresh.preload(['week-movie', 'week-tv', 'docs-movie', 'apple-popular-tv'], { max: 2 });
	assert.equal(bounded.keys, 2, 'the preload key list is bounded');
});

test('concurrent preloads share one upstream fetch per key', async t => {
	const f = fixture(t);
	const service = f.make();
	const [a, b] = await Promise.all([
		service.preload(['week-movie', 'week-tv']),
		service.preload(['week-movie', 'week-tv'])
	]);
	assert.equal(f.service.calls(), 2, 'duplicate preload calls coalesce');
	assert.equal(a.failed + b.failed, 0);
});

test('a source change invalidates the shared chart snapshot', async t => {
	const f = fixture(t);
	const service = f.make();
	await service.preload(['week-movie']);
	assert.equal(f.service.calls(), 1);
	f.setSource('https://seerr.example\u0000rotated-key');
	const after = await service.preload(['week-movie']);
	assert.equal(after.ran, 1, 'the new source generation is fetched');
	assert.equal(f.service.calls(), 2);
	const stored = JSON.parse(readFileSync(path.join(f.directory, 'trending-cache.json'), 'utf8'));
	assert.equal(stored.version, 2);
	assert.equal(typeof stored.source, 'string');
	assert.equal(JSON.stringify(stored).includes('rotated-key'), false, 'only a fingerprint is persisted');
});

test('the scheduler defers during playback, recovers, retries failures and stops', async () => {
	const timers = [];
	const setTimer = (fn, ms) => { const handle = { fn, ms, cleared: false }; timers.push(handle); return { unref() {}, __handle: handle }; };
	const clearTimer = handle => { handle.__handle.cleared = true; };
	let busy = true, result = { failed: 0 }, runs = 0;
	const scheduler = createTrendingPreload({
		warm: async () => { runs += 1; return result; },
		isBusy: () => busy,
		setTimer, clearTimer,
		startDelayMs: 100, intervalMs: 60000, retryMs: 5000, busyMs: 7000
	});
	const last = () => timers[timers.length - 1];
	scheduler.start();
	assert.equal(timers.length, 1);
	assert.equal(last().ms, 100);
	await last().fn();
	assert.equal(runs, 0, 'no preload while playback is active');
	assert.equal(scheduler.status().deferred, 1);
	assert.equal(last().ms, 7000, 'busy playback defers by a short bounded interval');

	busy = false;
	await last().fn();
	assert.equal(runs, 1);
	assert.equal(last().ms, 60000, 'a successful run schedules the hourly refresh');

	result = { failed: 1 };
	await last().fn();
	assert.equal(last().ms, 5000, 'a failed run retries sooner');
	scheduler.stop();
	assert.equal(last().cleared, true);
});

test('persistence is atomic and bounded by the configured size', async t => {
	const directory = mkdtempSync(path.join(tmpdir(), 'tellybox-trending-size-'));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const file = path.join(directory, 'trending.json');
	const service = createTrending({
		call: async () => ({ results: Array.from({ length: 10 }, (_, index) => ({ id: index + 1, mediaType: 'movie', title: String(index) + 'x'.repeat(4000), posterPath: '/p.jpg' })) }),
		view: (item, type) => ({ id: item.id, type, title: item.title }),
		cachePath: file,
		now: () => 1_800_000_000_000,
		maxBytes: 1024
	});
	await service.preload(['week-movie']);
	assert.equal(existsSync(file), false, 'an oversized snapshot is not written');
	assert.equal(existsSync(file + '.part'), false, 'no partial file is left behind');
});

