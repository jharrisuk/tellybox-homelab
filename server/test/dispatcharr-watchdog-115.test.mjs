import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createDirectPlayer } from '../dispatcharr-player.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function fakeChild() {
	const child = new EventEmitter();
	child.stdin = new PassThrough();
	child.stderr = new PassThrough();
	child.exitCode = null;
	child.killed = '';
	child.kill = signal => {
		child.killed = signal;
		child.exitCode = 0;
		queueMicrotask(() => child.emit('close', 0));
	};
	return child;
}

function body(bytes = 600 * 1024) {
	const chunk = new Uint8Array(bytes);
	return { ok: true, body: { getReader() { let done = false; return { read: async () => done ? { done: true } : (done = true, { done: false, value: chunk }) }; } } };
}

function player({ playlist, timeout = 60, child = fakeChild() } = {}) {
	let sequence = 0;
	const instance = createDirectPlayer({
		origin: 'http://127.0.0.1',
		fetcher: async () => body(),
		probeFn: async () => ({ streams: [{ codec_type: 'video', codec_name: 'h264', pix_fmt: 'yuv420p', width: 1920, height: 1080 }, { codec_type: 'audio', index: 1 }], format: { bit_rate: '4000000' } }),
		spawnProcess: () => child,
		readPlaylist: async file => file.endsWith('index.m3u8') ? (typeof playlist === 'function' ? playlist(sequence++) : playlist) : Buffer.from('segment'),
		progressTimeoutMs: timeout,
		watchdogMs: 10
	});
	return { instance, child };
}

test('slow but progressing producer stays alive and stops cleanly', async () => {
	let sequence = 0;
	const { instance, child } = player({ playlist: () => '#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:' + (++sequence) + '\n#EXTINF:2,\nsegment.ts\n', timeout: 250 });
	const started = await instance.start({ id: 'a'.repeat(36) }, { quality: 8000000 });
	for (let i = 0; i < 8; i++) {
		await sleep(20);
		assert.match(String(await started.read('index.m3u8')), /#EXTM3U/);
	}
	await started.stop();
	assert.equal(typeof started.stop, 'function');
	await assert.rejects(() => started.read('segment000000001.ts'), error => error.status === 410);
	assert.equal(child.killed, 'SIGTERM');
});

test('dead producer is stopped and stale reads return 410', async () => {
	const { instance, child } = player({ playlist: '#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:4\n#EXTINF:2,\nsegment.ts\n', timeout: 40 });
	const started = await instance.start({ id: 'b'.repeat(36) }, { quality: 8000000 });
	await sleep(120);
	await assert.rejects(() => started.read('segment000000001.ts'), error => error.status === 410);
	assert.equal(child.killed, 'SIGTERM');
});

test('ffmpeg exit closes the session instead of serving the last playlist', async () => {
	const { instance, child } = player({ playlist: '#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:4\n#EXTINF:2,\nsegment.ts\n', timeout: 500 });
	const started = await instance.start({ id: 'c'.repeat(36) }, { quality: 8000000 });
	child.exitCode = 1;
	child.emit('close', 1);
	await sleep(20);
	await assert.rejects(() => started.read('index.m3u8'), error => error.status === 410);
	await started.stop();
});
