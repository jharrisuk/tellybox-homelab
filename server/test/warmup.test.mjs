import test from 'node:test';
import assert from 'node:assert/strict';
import { primeStream } from '../warmup.mjs';
test('preparation fetches a master, media playlist and first segment only', async () => {
	const calls = [];
	await primeStream('/master.m3u8', {
		fetchResource: async path => {
			calls.push(path);
			return new Response(path === '/master.m3u8' ? '#EXTM3U\nmedia.m3u8' : path === '/media.m3u8' ? '#EXTM3U\nfirst.ts\nsecond.ts' : 'segment');
		},
		resolve: (base, entry) => new URL(entry, 'http://media' + base).pathname
	});
	assert.deepEqual(calls, ['/master.m3u8', '/media.m3u8', '/first.ts']);
});
test('preparation stops on cancellation and empty playlists', async () => {
	const controller = new AbortController(); controller.abort();
	await assert.rejects(primeStream('/a', { signal: controller.signal, fetchResource: () => assert.fail() }));
	await assert.rejects(primeStream('/a.m3u8', { fetchResource: async () => new Response('#EXTM3U'), resolve: () => assert.fail() }));
});
