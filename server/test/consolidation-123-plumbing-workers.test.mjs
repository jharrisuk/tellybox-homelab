import test from 'node:test';
import assert from 'node:assert/strict';
import { metadata, createWorkerPlayers } from '../../relay/worker/players.mjs';

// Deterministic plumbing tests: no ffmpeg/ffprobe binaries are required. The
// exported metadata helper carries the actual worker method decision, and the
// adapter is driven with an injected vod player double.

const hevcInfo = () => ({
	format: { duration: '600.000000', bit_rate: '6000000', format_name: 'matroska,webm' },
	streams: [
		{ index: 0, codec_type: 'video', codec_name: 'hevc', profile: 'Main', level: 120, pix_fmt: 'yuv420p', width: 1920, height: 1080, r_frame_rate: '25/1', bit_rate: '5800000' },
		{ index: 1, codec_type: 'audio', codec_name: 'aac', channels: 2, tags: { language: 'eng' } },
		{ index: 2, codec_type: 'subtitle', codec_name: 'subrip', tags: { language: 'eng' } }
	]
});
const hevcCaps = () => ({ videoCodecs: ['hevc'], audioCodecs: ['aac'], maxWidth: 1920, maxHeight: 1080, maxBitrate: 8000000, maxFps: 30,
	hevcMaxWidth: 3840, hevcMaxHeight: 2160, hevcMaxBitrate: 80000000, hevcMaxFps: 60, hevcMaxLevel: 120,
	hevcProfiles: ['main'], hevcPixelFormats: ['yuv420p'], hevcMain10: false, hevcEvidence: true, hls: true, mpegTs: true });

test('worker metadata reports the method the player will actually use', () => {
	const copy = metadata(hevcInfo(), -1, null, -1, { capabilities: hevcCaps(), quality: 8000000, copyPlan: { segmentSeconds: 2 } });
	assert.equal(copy.method, 'Copy', 'eligible AAC stereo source copies video and audio');
	assert.equal(copy.videoCodec, 'hevc', 'copy keeps the actual source codec');
	assert.equal(copy.audioCodec, 'aac');
	const convertedAudio = hevcInfo(); convertedAudio.streams[1].codec_name = 'ac3';
	const remux = metadata(convertedAudio, -1, null, -1, { capabilities: hevcCaps(), quality: 8000000, copyPlan: { segmentSeconds: 2 } });
	assert.equal(remux.method, 'Remux', 'video copy plus AAC audio conversion is a remux');
	assert.equal(remux.videoCodec, 'hevc');
	const surround = hevcInfo(); surround.streams[1].channels = 6;
	assert.equal(metadata(surround, -1, null, -1, { capabilities: hevcCaps(), quality: 8000000, copyPlan: { segmentSeconds: 2 } }).method, 'Remux',
		'non-stereo AAC is converted to stereo');
	const silent = hevcInfo(); silent.streams = silent.streams.filter(stream => stream.codec_type !== 'audio');
	assert.equal(metadata(silent, -1, null, -1, { capabilities: hevcCaps(), quality: 8000000, copyPlan: { segmentSeconds: 2 } }).method, 'Copy',
		'copying the video alone is still a Copy');
	assert.equal(metadata(hevcInfo(), -1, null, -1, { capabilities: hevcCaps(), quality: 8000000, copyPlan: null }).method, 'Transcode',
		'no whole-title GOP plan must not be reported as Copy');
	assert.equal(metadata(hevcInfo(), -1, null, -1, { capabilities: hevcCaps(), quality: 8000000 }).method, 'Transcode',
		'missing copy plan is conservative, matching the actual start contract');
});

test('worker metadata fails closed to Transcode when copy is disabled or capabilities are unusable', () => {
	const previous = process.env.TELLYBOX_VOD_COPY;
	try {
		process.env.TELLYBOX_VOD_COPY = '0';
		assert.equal(metadata(hevcInfo(), -1, null, -1, { capabilities: hevcCaps(), quality: 8000000, copyPlan: { segmentSeconds: 2 } }).method, 'Transcode',
			'TELLYBOX_VOD_COPY=0 disables copy and must never be fabricated');
	} finally {
		if (previous === undefined) delete process.env.TELLYBOX_VOD_COPY; else process.env.TELLYBOX_VOD_COPY = previous;
	}
	assert.equal(metadata(hevcInfo(), -1, null, -1, { capabilities: undefined, quality: 8000000, copyPlan: { segmentSeconds: 2 } }).method, 'Transcode',
		'absent capabilities keep the legacy transcode path');
	assert.equal(metadata(hevcInfo(), -1, null, -1, { capabilities: null, quality: 8000000, copyPlan: { segmentSeconds: 2 } }).method, 'Transcode',
		'invalid (null) capabilities fail closed');
	assert.equal(metadata(hevcInfo(), -1, null, -1, { capabilities: undefined, quality: 8000000, copyPlan: { segmentSeconds: 2 } }).videoCodec, 'h264',
		'transcode reports the h264 output codec');
});

test('unsupported profile, level or container fails closed to Transcode', () => {
	const baseline = hevcInfo();
	const levelZero = hevcInfo(); levelZero.streams[0].level = 0;
	assert.equal(metadata(levelZero, -1, null, -1, { capabilities: hevcCaps(), quality: 8000000, copyPlan: { segmentSeconds: 2 } }).method, 'Transcode');
	const main10WithoutClaim = hevcInfo(); main10WithoutClaim.streams[0].profile = 'Main 10';
	assert.equal(metadata(main10WithoutClaim, -1, null, -1, { capabilities: hevcCaps(), quality: 8000000, copyPlan: { segmentSeconds: 2 } }).method, 'Transcode');
	const unsupportedContainer = hevcInfo(); unsupportedContainer.format.format_name = 'avi';
	assert.equal(metadata(unsupportedContainer, -1, null, -1, { capabilities: hevcCaps(), quality: 8000000, copyPlan: { segmentSeconds: 2 } }).method, 'Transcode');
	assert.equal(metadata(baseline, -1, null, -1, { capabilities: hevcCaps(), quality: 8000000, copyPlan: { segmentSeconds: 2 } }).method, 'Copy');
});

test('a compatibility retry always forces Transcode over a copy-eligible claim', () => {
	const compat = metadata(hevcInfo(), -1, null, -1, { capabilities: hevcCaps(), quality: 8000000, copyPlan: { segmentSeconds: 2 }, compatibility: true });
	assert.equal(compat.method, 'Transcode', 'capability metadata can never override compatibility');
	assert.equal(compat.videoCodec, 'h264');
});

test('the requested quality ceiling blocks copying a source above it', () => {
	const over = metadata(hevcInfo(), -1, null, -1, { capabilities: hevcCaps(), quality: 4000000 });
	assert.equal(over.method, 'Transcode', 'a 6 Mbps source must not be copied at a 4 Mbps ceiling');
});

test('burned subtitles force Transcode; native text sidecars do not', () => {
	const sidecar = metadata(hevcInfo(), 2, null, -1, { capabilities: hevcCaps(), quality: 8000000, copyPlan: { segmentSeconds: 2 }, textSubtitles: true });
	assert.equal(sidecar.method, 'Copy', 'a selected text subtitle with sidecar captions keeps copy');
	const burnedText = metadata(hevcInfo(), 2, null, -1, { capabilities: hevcCaps(), quality: 8000000, copyPlan: { segmentSeconds: 2 }, textSubtitles: false });
	assert.equal(burnedText.method, 'Transcode', 'a selected text subtitle without sidecars burns in');
	const autoEnglish = metadata(hevcInfo(), -1, null, -1, { capabilities: hevcCaps(), quality: 8000000, copyPlan: { segmentSeconds: 2 }, preferEnglishSubtitles: true });
	assert.equal(autoEnglish.method, 'Transcode', 'prefer-English auto-selection burns the English track');
	const autoEnglishSidecar = metadata(hevcInfo(), -1, null, -1, { capabilities: hevcCaps(), quality: 8000000, copyPlan: { segmentSeconds: 2 }, preferEnglishSubtitles: true, textSubtitles: true });
	assert.equal(autoEnglishSidecar.method, 'Copy', 'prefer-English with sidecar captions keeps copy');
	const imageEnglish = hevcInfo(); imageEnglish.streams[2].codec_name = 'hdmv_pgs_subtitle';
	const autoImageSidecar = metadata(imageEnglish, -1, null, -1, { capabilities: hevcCaps(), quality: 8000000, copyPlan: { segmentSeconds: 2 }, preferEnglishSubtitles: true, textSubtitles: true });
	assert.equal(autoImageSidecar.method, 'Transcode', 'an English image track still burns even when sidecars were requested');
	const noEnglish = hevcInfo(); noEnglish.streams[2].tags.language = 'fre';
	const autoNoEnglish = metadata(noEnglish, -1, null, -1, { capabilities: hevcCaps(), quality: 8000000, copyPlan: { segmentSeconds: 2 }, preferEnglishSubtitles: true });
	assert.equal(autoNoEnglish.method, 'Copy', 'no English track means no burn-in to force');
	const imageSub = hevcInfo(); imageSub.streams[2].codec_name = 'hdmv_pgs_subtitle';
	assert.equal(metadata(imageSub, 2, null, -1, { capabilities: hevcCaps(), quality: 8000000, copyPlan: { segmentSeconds: 2 } }).method, 'Transcode');
	const external = metadata(hevcInfo(), -1, true, -1, { capabilities: hevcCaps(), quality: 8000000, copyPlan: { segmentSeconds: 2 } });
	assert.equal(external.method, 'Transcode', 'a burned external subtitle keeps the transcode path');
});

test('worker VOD and recording adapters pass capabilities and compatibility into vod.start', async () => {
	const starts = [];
	const vodPlayer = { start: async (source, options) => { starts.push({ source, options }); return { stop: async () => {}, read: async () => Buffer.from(''), duration: 100, method: 'Transcode' }; } };
	const upstream = { origin: 'http://dispatcharr.test', fetcher: async () => new Response(''), liveStream: async () => new Response(''),
		recordingFile: async () => new Response(''), stream: async () => new Response(''), stopStream: async () => {}, catchupSession: async () => ({}) };
	const players = createWorkerPlayers({ upstream, vodPlayer });
	const capabilities = hevcCaps();
	await players.start({ mode: 'vod', params: { type: 'movie', uuid: 'c'.repeat(36) },
		options: { capabilities, compatibility: true, quality: 8000000, copyPlan: { segmentSeconds: 2 }, textSubtitles: true, preferEnglishSubtitles: true } });
	assert.equal(starts.length, 1);
	assert.deepEqual(starts[0].options.capabilities, capabilities);
	assert.equal(starts[0].options.compatibility, true);
	await players.start({ mode: 'recording', params: { recordingId: 7 }, options: { capabilities, compatibility: false, quality: 8000000, copyPlan: { segmentSeconds: 2 } } });
	assert.equal(starts.length, 2);
	assert.deepEqual(starts[1].options.capabilities, capabilities, 'recordings forward the same capabilities');
	assert.equal(starts[1].options.compatibility, false);
});

test('worker VOD adapter rejects malformed streamed titles before starting', async () => {
	const vodPlayer = { start: async () => { throw new Error('must not start'); } };
	const upstream = { origin: 'http://dispatcharr.test', fetcher: async () => new Response(''), liveStream: async () => new Response(''),
		recordingFile: async () => new Response(''), stream: async () => new Response(''), stopStream: async () => {}, catchupSession: async () => ({}) };
	const players = createWorkerPlayers({ upstream, vodPlayer });
	await assert.rejects(() => players.start({ mode: 'vod', params: { type: 'movie', uuid: 'not-a-uuid' }, options: {} }), /Invalid streamed title/);
});
