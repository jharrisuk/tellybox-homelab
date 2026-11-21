import test from 'node:test';
import assert from 'node:assert/strict';
import { primeStream, warmupEnabled } from '../warmup.mjs';

const playlist = body => new Response(body, { headers: { 'content-type': 'application/vnd.apple.mpegurl' } });

test('warm-up is enabled by default and is disabled only by an explicit opt-out', () => {
	assert.equal(warmupEnabled({}), true);
	assert.equal(warmupEnabled({ TELLYBOX_WARMUP: '' }), true);
	for (const value of ['1', 'on', 'yes', 'true', 'enable']) assert.equal(warmupEnabled({ TELLYBOX_WARMUP: value }), true, value);
	for (const value of ['0', 'off', 'false', 'FALSE', ' no ', 'disabled', 'none']) assert.equal(warmupEnabled({ TELLYBOX_WARMUP: value }), false, value);
});

test('TELLYBOX_WARMUP=0 skips preparation without an upstream fetch', async () => {
	const previous = process.env.TELLYBOX_WARMUP;
	process.env.TELLYBOX_WARMUP = '0';
	try {
		let fetches = 0;
		const primed = await primeStream('/master.m3u8', {
			fetchResource: async () => { fetches++; return playlist('#EXTM3U\nmedia.m3u8'); },
			resolve: () => assert.fail('a disabled warm-up must not resolve a playlist')
		});
		assert.equal(primed, false);
		assert.equal(fetches, 0);
	} finally {
		if (previous === undefined) delete process.env.TELLYBOX_WARMUP;
		else process.env.TELLYBOX_WARMUP = previous;
	}
});

test('an explicit enabled flag wins over the process configuration', async () => {
	const previous = process.env.TELLYBOX_WARMUP;
	process.env.TELLYBOX_WARMUP = '0';
	try {
		const calls = [];
		const primed = await primeStream('/master.m3u8', {
			enabled: true,
			fetchResource: async path => {
				calls.push(path);
				return path === '/master.m3u8' ? playlist('#EXTM3U\nmedia.m3u8')
					: path === '/media.m3u8' ? playlist('#EXTM3U\nfirst.ts') : new Response('segment');
			},
			resolve: (base, entry) => new URL(entry, 'http://media' + base).pathname
		});
		assert.equal(primed, true);
		assert.deepEqual(calls, ['/master.m3u8', '/media.m3u8', '/first.ts']);
	} finally {
		if (previous === undefined) delete process.env.TELLYBOX_WARMUP;
		else process.env.TELLYBOX_WARMUP = previous;
	}
});

test('the warmed segment connection is released before playback takes over', async () => {
	const steps = [];
	const segment = new ReadableStream({
		start(controller) { steps.push('open'); controller.enqueue(new Uint8Array([1, 2, 3])); },
		cancel() { steps.push('cancel'); }
	});
	const primed = await primeStream('/master.m3u8', {
		enabled: true,
		fetchResource: async path => path === '/master.m3u8' ? playlist('#EXTM3U\nmedia.m3u8')
			: path === '/media.m3u8' ? playlist('#EXTM3U\nfirst.ts')
			: new Response(segment, { headers: { 'content-type': 'video/mp2t' } }),
		resolve: (base, entry) => new URL(entry, 'http://media' + base).pathname
	});
	assert.equal(primed, true);
	assert.deepEqual(steps, ['open', 'cancel']);
});

test('an unavailable upstream response is released and rejected', async () => {
	let cancelled = false;
	const body = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1])); }, cancel() { cancelled = true; } });
	await assert.rejects(primeStream('/media.m3u8', {
		enabled: true,
		fetchResource: async () => new Response(body, { status: 503 }),
		resolve: () => assert.fail()
	}), /Preparation unavailable/);
	assert.equal(cancelled, true);
});

test('cancellation between playlist levels stops the next fetch', async () => {
	const controller = new AbortController();
	let fetches = 0;
	await assert.rejects(primeStream('/master.m3u8', {
		enabled: true,
		signal: controller.signal,
		fetchResource: async () => {
			fetches++;
			controller.abort();
			return playlist('#EXTM3U\nmedia.m3u8');
		},
		resolve: () => '/media.m3u8'
	}));
	assert.equal(fetches, 1);
});

test('a playlist chain is bounded', async () => {
	await assert.rejects(primeStream('/level.m3u8', {
		enabled: true,
		fetchResource: async path => playlist('#EXTM3U\n' + path),
		resolve: (base, entry) => entry
	}), /Too many playlist levels/);
});
