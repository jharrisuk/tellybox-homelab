import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeCapabilities, sourceVideoSupported, clientVideoSupported, legacyVideoSupported } from '../capabilities.mjs';

test('capability metadata is bounded, filtered and never trusted as access', () => {
	assert.equal(sanitizeCapabilities(null), null);
	assert.equal(sanitizeCapabilities([]), null);
	assert.equal(sanitizeCapabilities({ videoCodecs: [] }), null);
	assert.equal(sanitizeCapabilities({ videoCodecs: ['vp9'] }), null);
	assert.equal(sanitizeCapabilities({ videoCodecs: ['h264'], audioCodecs: ['opus'] }), null);
	const caps = sanitizeCapabilities({
		videoCodecs: ['h264', 'hevc', 'vp9', 'hevc'],
		audioCodecs: ['aac', 'ac3', 'opus'],
		maxWidth: 9999, maxHeight: 1, maxBitrate: 1e12, maxFps: 120, hevcMaxFps: 5,
		hevcMain10: true, hls: true, mpegTs: true, id: 'ignored', token: 'ignored'
	});
	assert.deepEqual(caps.videoCodecs, ['h264', 'hevc']);
	assert.deepEqual(caps.audioCodecs, ['aac', 'ac3']);
	assert.equal(caps.maxWidth, 3840);
	assert.equal(caps.maxHeight, 240);
	assert.equal(caps.maxBitrate, 80000000);
	assert.equal(caps.maxFps, 60);
	assert.equal(caps.hevcMaxFps, 24);
	assert.equal(caps.hevcMain10, true);
	assert.equal(caps.hls, true);
	assert.equal(caps.mpegTs, true);
	assert.equal(Object.hasOwn(caps, 'id'), false);
	assert.equal(Object.hasOwn(caps, 'token'), false);
});

test('client video copy requires codec, pixel format, resolution, known-bitrate ceilings, audio and transport', () => {
	const h264 = sanitizeCapabilities({ videoCodecs: ['h264'], audioCodecs: ['aac'], maxWidth: 1920, maxHeight: 1080, maxBitrate: 8000000, maxFps: 30, hls: true, mpegTs: true });
	assert.equal(clientVideoSupported({ codec: 'h264', pixelFormat: 'yuv420p', width: 1920, height: 1080, bitrate: 4000000, frameRate: '25/1', quality: 8000000, capabilities: h264 }), true);
	assert.equal(clientVideoSupported({ codec: 'h264', pixelFormat: 'yuv420p', width: 1920, height: 1080, bitrate: 4000000, frameRate: '50/1', quality: 8000000, capabilities: h264 }), false);
	assert.equal(clientVideoSupported({ codec: 'h264', pixelFormat: 'yuv420p10le', bitrate: 4000000, quality: 8000000, capabilities: h264 }), false);
	assert.equal(clientVideoSupported({ codec: 'h264', pixelFormat: 'yuv420p', width: 3840, height: 2160, bitrate: 4000000, quality: 8000000, capabilities: h264 }), false);
	assert.equal(clientVideoSupported({ codec: 'h264', pixelFormat: 'yuv420p', bitrate: 9000000, quality: 8000000, capabilities: h264 }), false);
	assert.equal(clientVideoSupported({ codec: 'hevc', pixelFormat: 'yuv420p10le', bitrate: 4000000, quality: 8000000, capabilities: h264 }), false);

	const hevc = sanitizeCapabilities({ videoCodecs: ['hevc'], audioCodecs: ['aac'], maxWidth: 3840, maxHeight: 2160, maxBitrate: 80000000, hevcMain10: true,
		hevcMaxWidth: 3840, hevcMaxHeight: 2160, hevcMaxBitrate: 80000000, hevcMaxFps: 60, hevcMaxLevel: 186,
		hevcProfiles: ['main', 'main10'], hevcPixelFormats: ['yuv420p', 'yuv420p10le'], hls: true, mpegTs: true });
	assert.equal(clientVideoSupported({ codec: 'hevc', profile: 'Main 10', level: 153, pixelFormat: 'yuv420p10le', width: 1920, height: 1080, frameRate: '25/1', bitrate: 4000000, quality: 8000000, capabilities: hevc }), true);
	assert.equal(clientVideoSupported({ codec: 'hevc', profile: 'Main 10', level: 153, pixelFormat: 'yuv422p10le', width: 1920, height: 1080, frameRate: '25/1', bitrate: 4000000, quality: 8000000, capabilities: hevc }), false);
	assert.equal(clientVideoSupported({ codec: 'hevc', profile: 'Main 10', level: 153, pixelFormat: 'yuv444p10le', width: 1920, height: 1080, frameRate: '25/1', bitrate: 4000000, quality: 8000000, capabilities: hevc }), false);
	assert.equal(clientVideoSupported({ codec: 'hevc', profile: 'Main 10', level: 153, pixelFormat: 'yuv420p10le', width: 1920, height: 1080, frameRate: '25/1', bitrate: 0, quality: 8000000, capabilities: hevc }), false, 'unknown bitrate stays closed unless the live path opts in');
	assert.equal(clientVideoSupported({ codec: 'hevc', profile: 'Main 10', level: 153, pixelFormat: 'yuv420p10le', width: 1920, height: 1080, frameRate: '25/1', bitrate: 0, quality: 8000000, capabilities: hevc, allowUnknownBitrate: true }), true, 'the live path can copy unproven bitrate when every decoder contract is proven');
	const noMain10 = sanitizeCapabilities({ ...hevc, hevcMain10: false });
	assert.equal(clientVideoSupported({ codec: 'hevc', profile: 'Main 10', level: 153, pixelFormat: 'yuv420p10le', width: 1920, height: 1080, frameRate: '25/1', bitrate: 4000000, quality: 8000000, capabilities: noMain10 }), false);
	assert.equal(clientVideoSupported({ codec: 'hevc', profile: 'Main', level: 153, pixelFormat: 'yuv420p', width: 1920, height: 1080, frameRate: '25/1', bitrate: 4000000, quality: 8000000, capabilities: noMain10 }), true);

	const noHls = sanitizeCapabilities({ videoCodecs: ['h264'], audioCodecs: ['aac'], hls: false, mpegTs: true });
	assert.equal(clientVideoSupported({ codec: 'h264', pixelFormat: 'yuv420p', bitrate: 1, quality: 8000000, capabilities: noHls }), false);
	const noTs = sanitizeCapabilities({ videoCodecs: ['h264'], audioCodecs: ['aac'], hls: true, mpegTs: false });
	assert.equal(clientVideoSupported({ codec: 'h264', pixelFormat: 'yuv420p', bitrate: 1, quality: 8000000, capabilities: noTs }), false);
});

test('browser and older clients keep the legacy decision when no metadata is sent', () => {
	assert.equal(legacyVideoSupported({ codec: 'h264', pixelFormat: 'yuv420p', bitrate: 4000000, quality: 8000000 }), true);
	assert.equal(legacyVideoSupported({ codec: 'h264', bitrate: 4000000, quality: 8000000 }), true);
	assert.equal(legacyVideoSupported({ codec: 'hevc', bitrate: 4000000, quality: 8000000 }), false);
	assert.equal(legacyVideoSupported({ codec: 'h264', bitrate: 9000000, quality: 8000000 }), false);
	assert.equal(sourceVideoSupported({ codec: 'h264', pixelFormat: 'yuv420p', bitrate: 4000000, quality: 8000000 }), true);
	assert.equal(sourceVideoSupported({ codec: 'hevc', pixelFormat: 'yuv420p10le', bitrate: 4000000, quality: 8000000, capabilities: null }), false);
});
