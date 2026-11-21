// Regression for the HOME-124 bound proof: two simultaneous four-series
// requests reached 8 active upstream calls and both responses left 8 running
// because the per-request race returned the caller while the work continued.
// The shared admission cap plus queue expiry is now the safety boundary.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
	ADMISSION_LIMIT, createCatalogueSnapshot, createHomeEpisodeLookup, homeEpisodeAdmissionState
} from '../home-episodes.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const seriesId = prefix => (prefix + '0'.repeat(32)).slice(0, 32);
const episodeOf = series => ({
	Id: 'episode-' + series.slice(0, 8), Type: 'Episode', SeriesId: series,
	SeriesName: 'Show ' + series.slice(0, 2), ParentIndexNumber: 1, IndexNumber: 1,
	PremiereDate: '2026-10-01T00:00:00Z', RunTimeTicks: 1800e7
});

/** A fake upstream that ignores any abort and resolves after its delay. */
function fakeUpstream({ fastMs = 20, slowMs = 900 } = {}) {
	const calls = [];
	let active = 0, peak = 0;
	return {
		calls,
		stats: () => ({ active, peak }),
		episodes: async id => {
			active++;
			peak = Math.max(peak, active);
			calls.push({ id, start: Date.now() });
			try {
				await sleep(id.startsWith('f') ? fastMs : slowMs);
				return { items: [episodeOf(id)] };
			} finally {
				active--;
			}
		}
	};
}

function createLookup(upstream, timeoutMs) {
	return createHomeEpisodeLookup({
		userId: 'user-1', timeoutMs, concurrency: 4,
		library: { episodes: upstream.episodes },
		jelly: async () => ({ Items: [] })
	});
}

test('two concurrent four-series requests stay inside one shared admission cap', async () => {
	const upstream = fakeUpstream({ fastMs: 20, slowMs: 900 });
	const lookup = createLookup(upstream, 250);
	// 'f...' resolves at 20ms, so each caller keeps one truthful episode even
	// though its other series are still queued or in flight.
	const first = ['fa' + '0'.repeat(30), 'aa' + '0'.repeat(30), 'ab' + '0'.repeat(30), 'ac' + '0'.repeat(30)];
	const second = ['fb' + '0'.repeat(30), 'ba' + '0'.repeat(30), 'bb' + '0'.repeat(30), 'bc' + '0'.repeat(30)];
	const started = Date.now();
	const [a, b] = await Promise.all([lookup(first), lookup(second)]);
	const elapsed = Date.now() - started;
	const deadline = started + 250;

	assert.ok(elapsed >= 220 && elapsed < 900, 'both responses leave near their own deadline, took ' + elapsed + 'ms');
	assert.ok(upstream.stats().peak <= ADMISSION_LIMIT, 'peak upstream concurrency is at most the shared cap, saw ' + upstream.stats().peak);
	assert.ok(upstream.calls.length < 8, 'the queued half is not started, saw ' + upstream.calls.length + ' calls');
	assert.deepEqual(a.map(item => item.Id), [episodeOf(first[0]).Id], 'the finished series keeps its real episode');
	assert.deepEqual(b.map(item => item.Id), [episodeOf(second[0]).Id], 'the second caller also gets useful partial data');
	for (const call of upstream.calls) {
		assert.ok(call.start <= deadline + 60, 'no upstream call starts after the request deadline: ' + call.id);
	}

	assert.ok(upstream.stats().active > 0, 'a noncooperative upstream is still running after the caller has gone');
	assert.ok(upstream.stats().active <= ADMISSION_LIMIT);
	await sleep(950);
	assert.equal(upstream.stats().active, 0, 'every slot is released only when the upstream actually settles');
	assert.deepEqual(homeEpisodeAdmissionState(), { active: 0, queued: 0, limit: ADMISSION_LIMIT });
});

test('a slow single request keeps the series that finished before its deadline', async () => {
	const upstream = fakeUpstream({ fastMs: 20, slowMs: 800 });
	const lookup = createLookup(upstream, 300);
	const ids = ['f1' + '0'.repeat(30), 'f2' + '0'.repeat(30), 's1' + '0'.repeat(30)];
	const started = Date.now();
	const result = await lookup(ids);
	const elapsed = Date.now() - started;

	assert.ok(elapsed >= 280 && elapsed < 800, 'the caller leaves at its deadline, took ' + elapsed + 'ms');
	assert.deepEqual(result.map(item => item.Id).sort(),
		[episodeOf(ids[0]).Id, episodeOf(ids[1]).Id].sort(), 'both completed episodes are kept');
	assert.equal(result.some(item => item.Id === episodeOf(ids[2]).Id), false, 'the unfinished series is not invented');
	assert.equal(upstream.stats().active, 1, 'the slow call is still bounded and in flight');
	await sleep(700);
	assert.equal(upstream.stats().active, 0);
});

test('queued work for an answered request expires and never starts later', async () => {
	const upstream = fakeUpstream({ fastMs: 20, slowMs: 900 });
	const lookup = createLookup(upstream, 200);
	const holders = ['ha' + '0'.repeat(30), 'hb' + '0'.repeat(30), 'hc' + '0'.repeat(30), 'hd' + '0'.repeat(30)];
	const waiting = ['wa' + '0'.repeat(30), 'wb' + '0'.repeat(30), 'wc' + '0'.repeat(30), 'wd' + '0'.repeat(30)];

	const [held, queued] = await Promise.all([lookup(holders), lookup(waiting)]);
	assert.deepEqual(held, [], 'nothing finished yet, so the answer stays truthfully empty');
	assert.deepEqual(queued, []);
	assert.ok(upstream.stats().peak <= ADMISSION_LIMIT);
	assert.equal(upstream.calls.filter(call => waiting.includes(call.id)).length, 0,
		'no queued series of the answered request ever started');

	await sleep(1000);
	assert.equal(upstream.stats().active, 0);
	assert.equal(homeEpisodeAdmissionState().queued, 0);
});

test('the catalogue snapshot is short-lived and single-flight', async () => {
	let clock = 1000, reads = 0;
	const resolvers = [];
	const snapshot = createCatalogueSnapshot({
		read: () => { reads++; return new Promise(resolve => resolvers.push(resolve)); },
		ttlMs: 30, now: () => clock
	});

	const first = snapshot(), second = snapshot();
	assert.equal(reads, 1, 'simultaneous callers share one catalogue read');
	resolvers.shift()(['one']);
	assert.deepEqual(await first, ['one']);
	assert.deepEqual(await second, ['one']);
	assert.deepEqual(await snapshot(), ['one']);
	assert.equal(reads, 1, 'a cached snapshot does not enumerate the catalogue again');

	clock = 1031;
	const stale = snapshot();
	assert.equal(reads, 2, 'the snapshot expires after its short TTL');
	resolvers.shift()(['two']);
	assert.deepEqual(await stale, ['two']);

	let attempts = 0;
	const failing = createCatalogueSnapshot({
		read: async () => {
			attempts++;
			if (attempts === 1) throw new Error('catalogue unavailable');
			return ['recovered'];
		}
	});
	await assert.rejects(failing(), /catalogue unavailable/);
	assert.deepEqual(await failing(), ['recovered'], 'a failed read is not cached');
	assert.equal(attempts, 2);
});
