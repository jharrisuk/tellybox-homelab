/* Release 133 measurement (not part of the normal suite).
 * Synthetic upstream latency only; no provider or production request.
 * Compares visitor-cold, warm, restart and preloaded-request behaviour for the
 * shared Discover snapshot and the default chart cache.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDiscoverCache, stableQueryKey } from '../discover-cache.mjs';
import { createTrending } from '../trending.mjs';

const directory = mkdtempSync(path.join(tmpdir(), 'tellybox-preload-133-measure-'));
const LATENCY = 30;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const time = async fn => { const started = performance.now(); const value = await fn(); return { value, ms: Math.round(performance.now() - started) }; };
let upstream = 0;
const loader = async () => {
	upstream += 1;
	await sleep(LATENCY);
	return { items: [{ id: upstream, type: 'movie', title: 'Title ' + upstream, poster: '/p.jpg' }] };
};
let clock = 1_800_000_000_000;
const now = () => clock;
const results = {};

// Discover browse/provider snapshot cache: 8 shared first-screen keys.
{
	const file = path.join(directory, 'discover.json');
	const warmers = Array.from({ length: 8 }, (_, index) => ({
		key: stableQueryKey('browse', { type: index % 2 ? 'tv' : 'movie', sort: 'popular', page: index + 1, exclude: 0 }),
		load: loader
	}));
	upstream = 0;
	const coldCache = createDiscoverCache({ file, now, staleMs: 6 * 3600000 });
	const cold = await time(() => coldCache.get(warmers[0].key, loader));
	const warm = await time(() => coldCache.get(warmers[0].key, loader));
	await coldCache.flush();
	const restartCache = createDiscoverCache({ file, now, staleMs: 6 * 3600000 });
	const restart = await time(() => restartCache.get(warmers[0].key, loader));
	const preloadCache = createDiscoverCache({ file: path.join(directory, 'discover-preload.json'), now, staleMs: 6 * 3600000 });
	const beforePreload = upstream;
	preloadCache.start(warmers);
	await preloadCache.whenIdle();
	const preloadCalls = upstream - beforePreload;
	let visitCalls = 0;
	const visit = await time(() => preloadCache.get(warmers[0].key, async () => { visitCalls += 1; return loader(); }));
	results.discover = {
		coldRequestMs: cold.ms, coldUpstream: 1,
		warmRequestMs: warm.ms, warmUpstream: 0,
		restartRequestMs: restart.ms, restartUpstream: 0,
		preloadBackgroundUpstream: preloadCalls, preloadedRequestMs: visit.ms, preloadedRequestUpstream: visitCalls
	};
}

// Default chart cache: four highlights rows.
{
	const keys = ['week-movie', 'week-tv', 'docs-movie', 'docs-tv'];
	let chartCalls = 0, broken = false;
	const call = async route => {
		chartCalls += 1;
		await sleep(LATENCY);
		if (broken) throw Error('offline');
		const type = route.includes('mediaType=tv') ? 'tv' : 'movie';
		return { results: [{ id: chartCalls, mediaType: type, title: 'Chart ' + chartCalls, posterPath: '/p.jpg' }] };
	};
	const make = (file, source = 'source-a') => createTrending({ call, view: (item, type) => ({ id: item.id, type, title: item.title }), cachePath: file, now, sourceKey: () => source });
	const file = path.join(directory, 'trending.json');
	chartCalls = 0;
	const coldService = make(file);
	const cold = await time(() => coldService.trending('week-movie'));
	const warm = await time(() => coldService.trending('week-movie'));
	await coldService.preload(['week-movie', 'week-tv', 'docs-movie', 'docs-tv']);
	const restartService = make(file);
	let restartCalls = 0;
	const restart = await time(() => restartService.trending('week-movie'));
	const preloaded = createTrending({ call: async route => { restartCalls += 1; return call(route); }, view: (item, type) => ({ id: item.id, type, title: item.title }), cachePath: path.join(directory, 'trending-preload.json'), now, sourceKey: () => 'source-b' });
	const background = await preloaded.preload(['week-movie', 'week-tv', 'docs-movie', 'docs-tv']);
	const visitor = await time(() => preloaded.trending('week-movie'));
	let failedCalls = 0;
	broken = true;
	clock += 3600001;
	const failed = await preloaded.preload(['week-movie'], { max: 1 });
	const lastGood = await time(() => preloaded.trending('week-movie'));
	results.trending = {
		coldRequestMs: cold.ms, coldUpstream: 1,
		warmRequestMs: warm.ms, warmUpstream: 0,
		restartRequestMs: restart.ms, restartUpstream: 0,
		preloadBackgroundUpstream: background.ran,
		preloadedRequestMs: visitor.ms, preloadedRequestUpstream: 0,
		failedPreload: failed.failed, lastGoodAfterFailureMs: lastGood.ms,
		lastGoodServed: Boolean(lastGood.value?.items?.length)
	};
}

console.log(JSON.stringify({ latencyMs: LATENCY, results }, null, 2));
rmSync(directory, { recursive: true, force: true });

