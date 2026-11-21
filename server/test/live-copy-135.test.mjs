import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { sanitizeCapabilities, clientVideoSupported } from '../capabilities.mjs';
import { encodingArgs, createDirectPlayer } from '../dispatcharr-player.mjs';

// The shape a 0.26.26 build-80 Android TV sends: every HEVC contract is
// explicit, so the server can derive hevcEvidence without the app claiming it.
function build80(overrides = {}) {
	return sanitizeCapabilities({
		videoCodecs: ['h264', 'hevc'], audioCodecs: ['aac', 'ac3', 'eac3'],
		maxWidth: 3840, maxHeight: 2160, maxBitrate: 80000000, maxFps: 60,
		hevcMaxWidth: 3840, hevcMaxHeight: 2160, hevcMaxBitrate: 80000000, hevcMaxFps: 60,
		hevcMain10: true, hevcMaxLevel: 153, hevcProfiles: ['main', 'main10'],
		hevcPixelFormats: ['yuv420p', 'yuv420p10le'], hls: true, mpegTs: true,
		containers: ['mp4', 'm4v', 'mkv', 'webm', 'ts', 'mov'], clientKind: 'android-tv',
		...overrides
	});
}

function fakeChild() {
	const child = new EventEmitter();
	child.stdin = new PassThrough();
	child.stderr = new PassThrough();
	child.exitCode = null;
	child.kill = () => { child.exitCode = 0; queueMicrotask(() => child.emit('close', 0)); };
	return child;
}

function body(bytes = 600 * 1024) {
	const chunk = new Uint8Array(bytes);
	return { ok: true, body: { getReader() { let done = false; return { read: async () => done ? { done: true } : (done = true, { done: false, value: chunk }) }; } } };
}

function directPlayer(probe, calls) {
	const child = fakeChild();
	const instance = createDirectPlayer({
		origin: 'http://127.0.0.1',
		fetcher: async () => body(),
		probeFn: async () => probe,
		spawnProcess: (command, args) => { calls.push({ command, args }); return child; },
		readPlaylist: async file => file.endsWith('index.m3u8') ? '#EXTM3U\n#EXTINF:2,\nsegment000000001.ts\n' : Buffer.from('segment'),
		progressTimeoutMs: 5000,
		watchdogMs: 10000
	});
	return { instance, child };
}

test('a proven HEVC channel with unknown source bitrate is copied, not encoded', () => {
	const caps = build80();
	assert.equal(caps.hevcEvidence, true);
	const options = { codec: 'hevc', profile: 'Main 10', level: 123, pixelFormat: 'yuv420p10le',
		width: 3840, height: 2160, frameRate: '25/1', bitrate: 0, quality: 20000000, capabilities: caps };
	const blockers = [];
	assert.equal(clientVideoSupported(options), false, 'callers that do not opt in stay fail-closed');
	assert.equal(clientVideoSupported({ ...options, allowUnknownBitrate: true, blockers }), true, 'unknown bitrate must not force an encoder on the live path');
	assert.deepEqual(blockers, []);

	const encoding = encodingArgs({ ...options });
	assert.equal(encoding.convert, false);
	assert.equal(encoding.args[encoding.args.indexOf('-c:v') + 1], 'copy');
	assert.equal(encoding.args.includes('libx264'), false);
});

test('unknown bitrate never bypasses a missing decoder contract', () => {
	const caps = build80();
	const base = { codec: 'hevc', profile: 'Main 10', level: 123, pixelFormat: 'yuv420p10le',
		width: 3840, height: 2160, frameRate: '25/1', bitrate: 0, quality: 20000000, capabilities: caps };
	const check = (overrides, token) => {
		const blockers = [];
		assert.equal(clientVideoSupported({ ...base, ...overrides, allowUnknownBitrate: true, blockers }), false);
		assert.equal(blockers[0], token);
	};
	check({ level: 0 }, 'hevc-level');
	check({ profile: 'Main' }, 'hevc-profile-bitdepth');
	check({ pixelFormat: 'yuv422p10le' }, 'hevc-bitdepth');
	check({ width: 0, height: 0 }, 'hevc-geometry');
	check({ codec: 'av1' }, 'codec');
	check({ capabilities: build80({ hevcProfiles: [] }) }, 'hevc-evidence');
	check({ capabilities: build80({ hevcMain10: false, hevcProfiles: ['main'] }) }, 'hevc-main10');
});

test('a known bitrate over the quality or decoder ceiling still fails closed', () => {
	const caps = build80();
	const base = { codec: 'hevc', profile: 'Main 10', level: 123, pixelFormat: 'yuv420p10le',
		width: 1920, height: 1080, frameRate: '25/1', capabilities: caps };
	const quality = [];
	assert.equal(clientVideoSupported({ ...base, bitrate: 9000000, quality: 8000000, blockers: quality }), false);
	assert.deepEqual(quality, ['bitrate-quality']);
	const decoder = [];
	const smallerDecoder = build80({ hevcMaxBitrate: 40000000 });
	assert.equal(clientVideoSupported({ ...base, capabilities: smallerDecoder, bitrate: 50000000, quality: 80000000, blockers: decoder }), false);
	assert.deepEqual(decoder, ['bitrate-decoder']);
	assert.equal(clientVideoSupported({ ...base, bitrate: 9000000, quality: 8000000 }), false, 'a known oversize source still converts');
});

test('compatibility retry and genuinely unsupported sources still report an encoder', () => {
	const caps = build80();
	const forced = [];
	const retry = encodingArgs({ codec: 'hevc', profile: 'Main 10', level: 123, pixelFormat: 'yuv420p10le',
		width: 1920, height: 1080, frameRate: '25/1', bitrate: 0, quality: 20000000, capabilities: caps,
		compatibility: true, blockers: forced });
	assert.equal(retry.convert, true);
	assert.equal(retry.args[retry.args.indexOf('-c:v') + 1], 'libx264');
	assert.deepEqual(forced, ['compatibility']);

	const unsupported = [];
	const converted = encodingArgs({ codec: 'hevc', profile: 'Main 10', level: 0, pixelFormat: 'yuv420p10le',
		width: 1920, height: 1080, frameRate: '25/1', bitrate: 0, quality: 20000000, capabilities: caps, blockers: unsupported });
	assert.equal(converted.convert, true);
	assert.deepEqual(unsupported, ['hevc-level']);
});

test('the real direct player spawns ffmpeg with -c:v copy for a 24/7 HEVC fixture', async t => {
	const calls = [];
	const { instance } = directPlayer({
		streams: [
			{ codec_type: 'video', codec_name: 'hevc', pix_fmt: 'yuv420p10le', profile: 'Main 10', level: 123, width: 3840, height: 2160, r_frame_rate: '25/1' },
			{ codec_type: 'audio', index: 1, codec_name: 'aac', tags: { language: 'eng' } }
		],
		format: {}
	}, calls);
	const started = await instance.start({ id: 'a'.repeat(36), nonstop: true }, {
		quality: 20000000, capabilities: build80()
	});
	t.after(() => started.stop());
	assert.equal(calls.length, 1);
	assert.equal(calls[0].command, 'ffmpeg');
	assert.equal(started.method, 'Remux');
	assert.equal(started.videoCodec, 'hevc');
	assert.deepEqual(started.copyBlockers, []);
	assert.equal(calls[0].args[calls[0].args.indexOf('-c:v') + 1], 'copy');
	assert.equal(calls[0].args.includes('libx264'), false);
});

test('the real direct player keeps an encoder for a missing HEVC level', async t => {
	const calls = [];
	const { instance } = directPlayer({
		streams: [
			{ codec_type: 'video', codec_name: 'hevc', pix_fmt: 'yuv420p10le', profile: 'Main 10', level: 0, width: 1920, height: 1080, r_frame_rate: '25/1' },
			{ codec_type: 'audio', index: 1, codec_name: 'aac' }
		],
		format: {}
	}, calls);
	const started = await instance.start({ id: 'b'.repeat(36), nonstop: true }, {
		quality: 20000000, capabilities: build80()
	});
	t.after(() => started.stop());
	assert.equal(started.method, 'Transcode');
	assert.deepEqual(started.copyBlockers, ['hevc-level']);
	assert.equal(calls[0].args[calls[0].args.indexOf('-c:v') + 1], 'libx264');
});
