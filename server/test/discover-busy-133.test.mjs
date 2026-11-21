/* Release 133: busy-aware shared warmers.
 *
 * Discover's existing daily warmers and the chart preload stop before starting
 * new upstream work while playback/download activity is present, and neither
 * forces a fresh entry.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDiscoverCache, stableQueryKey } from '../discover-cache.mjs';
import { createTrending } from '../trending.mjs';

test('Discover warmers defer before any load while busy and resume when idle', async t => {
	const directory = mkdtempSync(path.join(tmpdir(), 'tellybox-discover-busy-'));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	let busy = true, loads = 0;
	const cache = createDiscoverCache({
		file: path.join(directory, 'snapshot.json'), dayMs: 86400000,
		now: () => 1_800_000_000_000, isBusy: () => busy
	});
	cache.start([{ key: stableQueryKey('browse', { type: 'all', sort: 'popular', page: 1, exclude: 0 }),
		load: async () => { loads++; return { items: [] }; } }]);
	await cache.whenIdle();
	assert.equal(loads, 0, 'no upstream load starts during playback');
	assert.equal(cache.status().lastDailyAt !== null, true, 'the attempt is recorded');
	busy = false;
	const result = await cache.warmNow();
	assert.equal(result.deferred, false);
	assert.equal(result.ran, 1);
	assert.equal(loads, 1);
	cache.stop();
});

test('chart preload does not start a row while busy', async t => {
	const directory = mkdtempSync(path.join(tmpdir(), 'tellybox-chart-busy-'));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	let calls = 0, busy = true;
	const service = createTrending({
		call: async route => { calls++; const type = route.includes('mediaType=tv') ? 'tv' : 'movie'; return { results: [{ id: calls, mediaType: type, title: 'T' + calls, posterPath: '/p.jpg' }] }; },
		view: (item, type) => ({ id: item.id, type, title: item.title }),
		cachePath: path.join(directory, 'trending.json'),
		now: () => 1_800_000_000_000,
		sourceKey: () => 'a'
	});
	const deferred = await service.preload(['week-movie', 'week-tv'], { isBusy: () => busy });
	assert.equal(deferred.deferred, true);
	assert.equal(calls, 0);
	busy = false;
	const resumed = await service.preload(['week-movie', 'week-tv'], { isBusy: () => busy });
	assert.equal(resumed.deferred, false);
	assert.equal(resumed.ran, 2);
});
