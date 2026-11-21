import test from 'node:test';
import assert from 'node:assert/strict';
import { createHomePlayability } from '../home-playability.mjs';

const episode = (date = '') => ({ Id: 'e-' + Math.random(), Type: 'Episode', PremiereDate: date });

test('confirmed empty and future-only series are unavailable; failures are not', async () => {
	const checks = createHomePlayability({
		episodes: async id => {
			if (id === 'empty') return { items: [], notice: '' };
			if (id === 'future') return { items: [episode('2999-01-01')], notice: '' };
			if (id === 'failed') return { items: [], notice: 'Some episodes could not be loaded.' };
			if (id === 'throw') throw new Error('provider down');
			return { items: [episode('2020-01-01')], notice: '' };
		},
		timeoutMs: 200,
		overallMs: 1000
	});
	const unavailable = await checks.assess(['empty', 'future', 'failed', 'throw', 'available']);
	assert.deepEqual([...unavailable].sort(), ['empty', 'future']);
});

test('fair selection checks the priority new row and cached empties outside the budget', async () => {
	const calls = [];
	const checks = createHomePlayability({
		episodes: async id => {
			calls.push(id);
			if (id.startsWith('new-')) return { items: [], notice: '' };
			return { items: [episode('2020-01-01')], notice: '' };
		},
		limit: 12,
		overallMs: 1000,
		timeoutMs: 200
	});
	const earlier = Array.from({ length: 20 }, (_, index) => 'old-' + index);
	const news = ['new-1', 'new-2', 'new-3'];
	const first = await checks.assess([earlier, news], { priority: news });
	assert.deepEqual([...first].sort(), news.sort(), 'all three reported new-row series are checked and excluded');
	assert.ok(calls.includes('new-1') && calls.includes('new-2') && calls.includes('new-3'));

	// A confirmed empty result is reused even when it falls outside a later
	// request's sampling budget.
	const second = await checks.assess([['old-1', 'new-1']], { priority: [] });
	assert.ok(second.has('new-1'), 'known empty cache still filters an out-of-budget id');
});

test('cache is bounded, stores no episode payloads, and unknown results honour the short TTL', async () => {
	let calls = 0;
	const checks = createHomePlayability({
		episodes: async () => { calls++; return { items: [], notice: 'Some episodes could not be loaded.' }; },
		maxCache: 2,
		timeoutMs: 200,
		overallMs: 500
	});
	const unavailable = await checks.assess(['a', 'b', 'c']);
	assert.equal(unavailable.size, 0, 'a notice is unknown, not unavailable');
	assert.ok(checks.cache.size <= 2, 'cache is bounded');
	for (const entry of checks.cache.values()) assert.deepEqual(Object.keys(entry).sort(), ['state', 'until']);
	assert.ok([...checks.cache.values()].every(entry => entry.state === 'unknown'));
	await checks.assess(['c']);
	assert.equal(calls, 3, 'a fresh unknown cache entry suppresses a repeat provider call');
});

test('global provider concurrency is capped across overlapping requests', async () => {
	let active = 0, peak = 0;
	const checks = createHomePlayability({
		episodes: async () => {
			active++; peak = Math.max(peak, active);
			await new Promise(resolve => setTimeout(resolve, 20));
			active--;
			return { items: [], notice: '' };
		},
		concurrency: 2,
		limit: 8,
		timeoutMs: 500,
		overallMs: 1000
	});
	await Promise.all([
		checks.assess(['a', 'b', 'c', 'd']),
		checks.assess(['e', 'f', 'g', 'h'])
	]);
	assert.ok(peak <= 2, 'aggregate active provider calls do not exceed the cap');
});

test('a timed-out provider is not treated as unavailable', async () => {
	const checks = createHomePlayability({
		episodes: async () => new Promise(() => {}),
		timeoutMs: 10,
		overallMs: 30,
		limit: 1
	});
	const unavailable = await checks.assess(['slow']);
	assert.equal(unavailable.size, 0);
});

test('many disjoint requests admit no more than the global cap and do not build a queue', async () => {
	let started = 0, active = 0, peak = 0;
	const checks = createHomePlayability({
		episodes: async () => {
			started++; active++; peak = Math.max(peak, active);
			return new Promise(() => {});
		},
		concurrency: 2,
		limit: 12,
		maxPending: 8,
		timeoutMs: 20,
		overallMs: 40
	});
	const requests = Array.from({ length: 20 }, (_, index) =>
		checks.assess(Array.from({ length: 12 }, (_, item) => 'item-' + index + '-' + item)));
	await Promise.all(requests);
	assert.ok(peak <= 2, 'only the global cap starts provider calls');
	assert.ok(started <= 2, 'no queued provider calls start after the deadline');
	assert.ok(checks.stats().pending <= 8, 'pending map remains bounded');
});

