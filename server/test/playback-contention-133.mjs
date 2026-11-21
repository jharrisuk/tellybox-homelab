/* Release 133 playback contention evidence (not part of the normal suite).
 *
 * Generates a local 720p clip with FFmpeg, transcodes it to HLS twice: once
 * alone, once while the 45k catalogue availability projection is exercised in
 * the same Node process. It reports segment-production gaps and event-loop
 * delay. Synthetic local media only; no provider stream, production host or
 * network content is used.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { createVodLibrary } from '../vod-library.mjs';

const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
const directory = mkdtempSync(path.join(tmpdir(), 'tellybox-contention-133-'));
const input = path.join(directory, 'input.mp4');
const run = (args, options = {}) => new Promise((resolve, reject) => {
	const child = spawn(ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options });
	let out = '', err = '';
	child.stdout.on('data', chunk => { out += chunk; });
	child.stderr.on('data', chunk => { err += chunk; });
	child.on('error', reject);
	child.on('close', code => code === 0 ? resolve({ out, err }) : reject(Error(err.slice(-600) || 'ffmpeg exited ' + code)));
});
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

try {
	await run(['-y', '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=25', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
		'-t', '20', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-c:a', 'aac', '-b:a', '96k', '-pix_fmt', 'yuv420p', input]);

	const output = async label => {
		const dir = path.join(directory, label);
		await import('node:fs/promises').then(fs => fs.mkdir(dir, { recursive: true }));
		const started = performance.now();
		const count = () => { try { return readdirSync(dir).filter(name => name.endsWith('.ts')).length; } catch { return 0; } };
		const segments = [];
		let last = 0;
		const timer = setInterval(() => {
			const value = count();
			while (last < value) { last += 1; segments.push(Number((performance.now() - started).toFixed(1))); }
		}, 25);
		try {
			await run(['-y', '-i', input, '-c:v', 'libx264', '-preset', 'medium', '-c:a', 'aac',
				'-g', '50', '-keyint_min', '50', '-sc_threshold', '0',
				'-f', 'hls', '-hls_time', '2', '-hls_list_size', '0', '-hls_segment_filename', path.join(dir, 'seg%03d.ts'),
				path.join(dir, 'index.m3u8')]);
		} finally { clearInterval(timer); }
		while (last < count()) { last += 1; segments.push(Number((performance.now() - started).toFixed(1))); }
		const gaps = segments.slice(1).map((at, index) => Number((at - segments[index]).toFixed(1)));
		return {
			wallMs: Number((performance.now() - started).toFixed(1)),
			segments: segments.length,
			maxSegmentGapMs: gaps.length ? Math.max(...gaps) : null,
			segmentGapsMs: gaps
		};
	};

	// 45k-library fixture for the background projection.
	const file = path.join(directory, 'catalogue.json');
	const catalogueItems = Array.from({ length: 45000 }, (_, index) => ({
		Id: 'vod-' + index, Name: 'Title ' + index, Type: index % 4 === 0 ? 'Series' : 'Movie',
		Source: 'streamed', Provider: 'Dispatcharr', ProviderIds: { Tmdb: String(100000 + index) },
		Genres: ['Drama'], PremiereDate: '2020-01-01'
	}));
	writeFileSync(file, JSON.stringify({ items: catalogueItems, time: Date.now() }));
	const library = createVodLibrary({
		dispatcharr: { status: () => ({ connected: true }), api: async () => { throw Error('no upstream in this fixture'); } },
		localItems: async () => [], localItem: async () => null, localEpisodes: async () => [],
		file, linksFile: path.join(directory, 'links.json'), metadata: null, clock: () => Date.now(),
		indexFile: path.join(directory, 'index.json')
	});
	await library.all({ refresh: false });
	const response = Array.from({ length: 60 }, (_, index) => ({ id: 100000 + index, type: index % 4 === 0 ? 'tv' : 'movie' }));

	const baseline = await output('baseline');
	const histogram = monitorEventLoopDelay({ resolution: 10 });
	histogram.enable();
	let ticks = 0, maxTick = 0, lastTick = performance.now();
	const ticker = setInterval(() => {
		const now = performance.now();
		maxTick = Math.max(maxTick, now - lastTick);
		lastTick = now;
		ticks += 1;
	}, 10);
	let stop = false, projections = 0;
	const worker = (async () => {
		while (!stop) {
			await library.availability(response);
			projections += 1;
			await new Promise(resolve => setImmediate(resolve));
		}
	})();
	const concurrent = await output('concurrent');
	stop = true;
	await worker;

	// Pre-133 equivalent: rebuild the whole provider map for each projection
	// while the same transcode runs. This shows the work the cached map removes.
	let legacyStop = false, legacyRebuilds = 0;
	const legacyWorker = (async () => {
		while (!legacyStop) {
			const map = new Map();
			for (const item of catalogueItems) {
				const type = item.Type, tmdb = item.ProviderIds?.Tmdb;
				if (tmdb && !map.has(type + ':tmdb:' + tmdb)) map.set(type + ':tmdb:' + tmdb, item);
			}
			legacyRebuilds += 1;
			await new Promise(resolve => setImmediate(resolve));
		}
	})();
	const legacyConcurrent = await output('legacy');
	legacyStop = true;
	await legacyWorker;
	clearInterval(ticker);
	histogram.disable();

	console.log(JSON.stringify({
		input: '20s 1280x720 libx264 test pattern (local FFmpeg)',
		baseline,
		concurrent,
		legacyConcurrent,
		background: { availabilityCalls: projections, legacyMapRebuilds: legacyRebuilds, catalogueItems: 45000 },
		eventLoop: {
			samples: ticks,
			maxTimerGapMs: Number(maxTick.toFixed(1)),
			p99Ms: Number((histogram.percentile(99) / 1e6).toFixed(2)),
			maxDelayMs: Number((histogram.max / 1e6).toFixed(2))
		},
		note: 'Synthetic local transcode. The same file was transcoded alone, then with the cached 45k projection, then with the equivalent per-request provider-map rebuild. Not a production latency claim.'
	}, null, 2));
} catch (error) {
	console.error('PLAYBACK-CONTENTION-133 failed:', error.message);
	process.exitCode = 1;
} finally {
	rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
