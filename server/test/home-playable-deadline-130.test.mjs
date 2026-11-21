/* Release 130 deadline boundary regression.
 *
 * PRIMARY extracted the real buildPlayableHomeFeed into a VM and found that an
 * exhausted budget did not fail closed:
 *   deadlineMs = 0    -> started verifySeries with 1500 ms
 *   deadlineMs = -1   -> started verifySeries with 250 ms
 *   deadlineMs = 1    -> started verifySeries with 250 ms
 *
 * The function is extracted the same way here so this test guards the actual
 * shipped source, not a copy. An explicit deadline is remaining time: 0 or a
 * negative value must start no upstream verification at all, while the
 * network-free saved availability still decides final membership.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { performance } from 'node:perf_hooks';

const file = new URL('../server.mjs', import.meta.url);
const source = readFileSync(file, 'utf8');
const start = source.indexOf('async function buildPlayableHomeFeed(');
const end = source.indexOf('function feedSeriesIds(');
assert.ok(start >= 0 && end > start, 'the playable Home builder is present in server.mjs');
const body = source.slice(start, end);

function harness({ cached = new Map(), verify = null, episode = null } = {}) {
	const calls = [];
	const box = {
		Map, Set, Date, performance,
		vodLibrary: {
			cachedStates: ids => new Map([...ids].filter(id => cached.has(id)).map(id => [id, cached.get(id)])),
			verifySeries: async (ids, options) => {
				calls.push({ ids: [...ids], deadlineMs: options.deadlineMs, limit: options.limit });
				return verify ? verify(ids, options) : { states: new Map(ids.map(id => [id, 'unknown'])), checked: 0, pending: ids.length, limit: options.limit };
			}
		},
		feedSeriesIds: feed => feed.rows.flatMap(row => (row.items || []).filter(item => item.Type === 'Series').map(item => item.Id))
	};
	vm.createContext(box);
	vm.runInContext(body + ';globalThis.run = buildPlayableHomeFeed;', box);
	const items = [
		{ Id: 'series-available', Type: 'Series', Name: 'Proven show' },
		{ Id: 'series-unknown', Type: 'Series', Name: 'Unproven show' },
		{ Id: 'episode-exact', Type: 'Episode', Name: 'Exact episode', SeriesId: 'series-available' }
	];
	const build = list => ({
		rows: [{ id: 'continue', items: [...list, ...(episode ? [episode] : [])] }],
		featured: []
	});
	return { calls, run: options => box.run({ items, build, ...options }) };
}

const ids = feed => feed.rows.flatMap(row => (row.items || []).map(item => item.Id));

test('an exhausted budget starts no verification but keeps proven membership', async () => {
	for (const deadlineMs of [0, -1, -100]) {
		const h = harness({ cached: new Map([['series-available', 'available'], ['series-unknown', 'unknown']]) });
		const result = await h.run({ deadlineMs });
		assert.deepEqual(h.calls, [], 'deadline ' + deadlineMs + ' must not start verification');
		const visible = ids(result.feed);
		assert.ok(visible.includes('series-available'), 'a proven series survives an exhausted budget');
		assert.ok(!visible.includes('series-unknown'), 'an unproven series stays hidden');
		assert.equal(result.checked, 0);
	}
});

test('a window too small to finish does not start a provider read', async () => {
	const h = harness();
	const result = await h.run({ deadlineMs: 1 });
	assert.deepEqual(h.calls, [], '1 ms left must not start verification');
	const visible = ids(result.feed);
	assert.ok(!visible.includes('series-available') && !visible.includes('series-unknown'), 'no unproven series is shown');
	assert.ok(visible.includes('episode-exact'), 'the exact episode item is not dropped');
});

test('a small positive budget is used as-is, never replaced by the default', async () => {
	const h = harness();
	await h.run({ deadlineMs: 400 });
	assert.equal(h.calls.length, 1, 'one bounded round runs');
	const budget = h.calls[0].deadlineMs;
	assert.ok(budget > 0 && budget <= 400, 'verification got the remaining budget, saw ' + budget);
	assert.ok(budget < 1500, 'the 1500 ms round cap cannot replace a smaller request budget');
});

test('the final pass with an expired budget preserves Continue and proven rows', async () => {
	const continueEpisode = { Id: 'episode-exact', Type: 'Episode', Name: 'Exact episode', SeriesId: 'series-available' };
	const first = harness({ cached: new Map([['series-available', 'available']]), episode: continueEpisode });
	const pass1 = await first.run({ deadlineMs: 0, pass: 1 });
	const second = harness({ cached: new Map([['series-available', 'available']]), episode: continueEpisode });
	const pass2 = await second.run({
		deadlineMs: 0, pass: 2,
		states: pass1.states, attempted: pass1.attempted, checked: pass1.checked, budget: 0
	});
	assert.deepEqual(second.calls, [], 'the final pass starts no verification on an expired budget');
	const visible = ids(pass2.feed);
	assert.ok(visible.includes('series-available'), 'the proven series is still present');
	assert.ok(visible.includes('episode-exact'), 'the exact Continue episode is still present');
	assert.ok(visible.includes('episode-exact'), 'the final build was not emptied');
});

test('a missing deadline keeps the documented default cap', async () => {
	const h = harness();
	await h.run({});
	assert.equal(h.calls.length, 1);
	assert.ok(h.calls[0].deadlineMs <= 1500 && h.calls[0].deadlineMs > 0, 'default rounds stay bounded');
});

test('the shipped source no longer revives an exhausted deadline', () => {
	assert.equal(/Math\.max\(250/.test(body), false, 'no 250 ms revival');
	assert.equal(/Number\(deadlineMs\)\s*\|\|\s*3500/.test(body), false, '0 is not treated as missing');
	assert.equal(/const minWindowMs = 50/.test(body), true, 'the minimum window is self-contained in the extracted function');
});
