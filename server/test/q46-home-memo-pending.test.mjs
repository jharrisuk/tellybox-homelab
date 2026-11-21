/* Q46 regression (Fix 1, unit): the Home memo gate counts `pending` from the
 * SERVED feed, not the pre-filter feed.
 *
 * Before the fix, `pending` was computed from the feed held before the final
 * available-only filter, so one series that could not be proven kept
 * pending > 0 and the /api/web/home memo was never written: every warm request
 * re-ran the whole pipeline. After the fix the final build drops every series
 * that is not proven 'available' and pending counts only what is served.
 *
 * The real buildPlayableHomeFeed AND the real feedSeriesIds are extracted from
 * server.mjs into a VM, the same technique as home-playable-deadline-130.test.mjs
 * (which supplies its own rows-only feedSeriesIds; this file guards the shipped
 * one, including featured). Each scenario also proves the pre-filter feed really
 * held an unproven candidate, i.e. the pre-fix count would have been > 0.
 *
 * Additive: the 130 test proves deadline fail-closed behaviour and that unproven
 * series stay hidden; it never asserts the returned `pending` value, which is
 * what the memo gate reads.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { performance } from 'node:perf_hooks';

const source = readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
const start = source.indexOf('async function buildPlayableHomeFeed(');
const end = source.indexOf('function feedSeriesIds(');
assert.ok(start >= 0 && end > start, 'the playable Home builder is present in server.mjs');
const builderBody = source.slice(start, end);
const idsEnd = source.indexOf('\n}', end);
assert.ok(idsEnd > end, 'feedSeriesIds is present in server.mjs');
const idsBody = source.slice(end, idsEnd + 2);

const items = [
	{ Id: 'series-proven', Type: 'Series', Name: 'Proven show' },
	{ Id: 'series-unproven', Type: 'Series', Name: 'Unproven show' },
	{ Id: 'series-replacement', Type: 'Series', Name: 'Replacement show' },
	{ Id: 'film-one', Type: 'Movie', Name: 'A film' },
	{ Id: 'episode-exact', Type: 'Episode', Name: 'Exact episode', SeriesId: 'series-proven' }
];

function harness({ cached = new Map(), verify = null } = {}) {
	const verifyCalls = [];
	const builds = [];
	const box = {
		Map, Set, Date, performance,
		vodLibrary: {
			cachedStates: ids => new Map([...ids].filter(id => cached.has(id)).map(id => [id, cached.get(id)])),
			verifySeries: async (ids, options) => {
				verifyCalls.push({ ids: [...ids], deadlineMs: options.deadlineMs, limit: options.limit });
				return verify ? verify(ids, options)
					: { states: new Map(ids.map(id => [id, 'unknown'])), checked: 0, pending: ids.length, limit: options.limit };
			}
		}
	};
	vm.createContext(box);
	vm.runInContext(builderBody + '\n' + idsBody + '\nglobalThis.run = buildPlayableHomeFeed; globalThis.seriesIds = feedSeriesIds;', box);
	const build = list => {
		const feed = {
			rows: [{ id: 'for-you', items: [...list] }],
			featured: list.filter(item => item.Type === 'Series')
		};
		builds.push(feed);
		return feed;
	};
	return {
		verifyCalls, builds,
		seriesIds: feed => box.seriesIds(feed),
		run: options => box.run({ items, build, ...options })
	};
}

const allItemIds = feed => [
	...(feed.rows || []).flatMap(row => (row.items || []).map(item => item.Id)),
	...(feed.featured || []).map(item => item.Id)
];

test('an unproven candidate dropped by the final filter reports pending 0 (no verification window)', async () => {
	const h = harness({
		cached: new Map([['series-proven', 'available'], ['series-unproven', 'unknown'], ['series-replacement', 'available']])
	});
	const result = await h.run({ deadlineMs: 0 });
	assert.deepEqual(h.verifyCalls, [], 'an exhausted budget starts no verification');
	// The pre-filter feed really held the unproven candidate: the pre-fix count
	// (pending from that feed) would have been 1 and blocked the memo forever.
	const preFilter = h.builds[h.builds.length - 2];
	assert.ok(h.seriesIds(preFilter).includes('series-unproven'), 'the unproven series was a selected candidate');
	const oldStylePending = h.seriesIds(preFilter).filter(id => result.states.get(id) !== 'available').length;
	assert.equal(oldStylePending, 1, 'the pre-fix pending count would have blocked the memo');
	// The shipped post-filter count is what the memo gate reads.
	assert.equal(result.pending, 0, 'the served feed has no unproven series, so pending is 0');
	const served = allItemIds(result.feed);
	assert.ok(!served.includes('series-unproven'), 'no unproven series in rows or featured');
	assert.ok(served.includes('series-proven') && served.includes('series-replacement'), 'proven series survive');
	assert.ok(served.includes('film-one') && served.includes('episode-exact'), 'non-series items are untouched');
	assert.equal(result.states.get('series-unproven'), 'unknown', 'the series was dropped, not proven');
	assert.ok(!(result.feed.featured || []).some(item => item.Id === 'series-unproven'), 'featured is filtered too');
});

test('a verification round that cannot prove a series still ends with pending 0', async () => {
	const h = harness({
		cached: new Map([['series-proven', 'available']]),
		verify: ids => ({
			states: new Map(ids.map(id => [id, id === 'series-unproven' ? 'unknown' : 'available'])),
			checked: ids.length,
			pending: ids.filter(id => id === 'series-unproven').length,
			limit: 24
		})
	});
	const timing = { verifyRounds: [] };
	const result = await h.run({ deadlineMs: 3500, timing });
	assert.equal(h.verifyCalls.length, 1, 'one bounded verification round runs');
	assert.deepEqual([...h.verifyCalls[0].ids].sort(), ['series-replacement', 'series-unproven']);
	assert.equal(result.pending, 0, 'the unproven series is dropped and pending counts the served feed');
	assert.equal(result.checked, 2);
	assert.equal(timing.feedBuild.pending, 0, 'the timing diagnostics agree with the gate value');
	const served = allItemIds(result.feed);
	assert.ok(!served.includes('series-unproven'), 'the unproven series never reaches the feed');
	assert.ok(served.includes('series-replacement'), 'the checked replacement is kept');
	assert.ok(served.includes('series-proven'), 'the already-proven series is kept');
	assert.ok(h.seriesIds(h.builds[0]).includes('series-unproven'), 'the initial build really selected it');
});

test('a provider outage (checked 0) keeps proven rows and still reports pending 0', async () => {
	const h = harness({ cached: new Map([['series-proven', 'available']]) });
	// Default verify stub: every id stays unknown, checked 0.
	const result = await h.run({ deadlineMs: 3500 });
	assert.equal(h.verifyCalls.length, 1);
	assert.equal(result.checked, 0);
	assert.equal(result.pending, 0, 'nothing unproven is served, so the memo gate may pass');
	const served = allItemIds(result.feed);
	assert.ok(served.includes('series-proven'), 'the proven series survives the outage');
	assert.ok(served.includes('film-one') && served.includes('episode-exact'), 'the feed is not emptied');
	assert.ok(!served.includes('series-unproven') && !served.includes('series-replacement'), 'unproven series stay hidden');
});

test('the route final pass with an exhausted budget counts pending post-filter', async () => {
	// Mirrors /api/web/home pass 2: inherited states/attempted, budget spent by
	// pass 1, Continue took the remaining time. The pass-2 initial build selects
	// a fresh unknown candidate; no round may run; the final filter must drop it
	// and pending must be 0 so the memo can be written.
	const h = harness({ cached: new Map([['series-proven', 'available']]) });
	const result = await h.run({
		deadlineMs: 0, budget: 0, pass: 2, checked: 1,
		states: new Map([['series-proven', 'available'], ['series-unproven', 'unknown']]),
		attempted: new Set(['series-unproven'])
	});
	assert.deepEqual(h.verifyCalls, [], 'the final pass starts no verification on an exhausted budget');
	const preFilter = h.builds[h.builds.length - 2];
	const oldStylePending = h.seriesIds(preFilter).filter(id => result.states.get(id) !== 'available').length;
	assert.ok(oldStylePending >= 1, 'the pre-fix count would have blocked the memo again');
	assert.equal(result.pending, 0, 'the served feed is available-only');
	assert.equal(result.checked, 1, 'the inherited checked count is preserved');
	const served = allItemIds(result.feed);
	assert.ok(served.includes('series-proven') && served.includes('episode-exact'), 'Continue and proven rows survive');
	assert.ok(!served.includes('series-unproven') && !served.includes('series-replacement'), 'no unproven series is served');
});
