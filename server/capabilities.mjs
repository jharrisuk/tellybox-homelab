const VIDEO_CODECS = new Set(['h264', 'hevc']);
const AUDIO_CODECS = new Set(['aac', 'ac3', 'eac3', 'mp3']);
const EIGHT_BIT = new Set(['yuv420p', 'yuvj420p']);
const TEN_BIT_420 = new Set(['yuv420p10le', 'yuv420p10be', 'p010le', 'p010be']);
const DIRECT_CONTAINERS = new Set(['mp4', 'm4v', 'mkv', 'webm', 'ts', 'mov']);
const H264_PROFILES = new Set(['baseline', 'main', 'high']);
const HEVC_PROFILES = new Set(['main', 'main10']);
const DIRECT_PIXEL_FORMATS = new Set(['yuv420p', 'yuv420p10le']);
const CLIENT_KINDS = new Set(['android', 'android-phone', 'android-tv']);
// Audio codecs a native Android decoder may legitimately direct-play inside the
// containers this profile advertises. Unknown or browser-only claims are
// dropped rather than forwarded to Jellyfin.
const NATIVE_AUDIO_CODECS = new Set(['aac', 'mp3', 'ac3', 'eac3', 'flac', 'opus', 'vorbis', 'dts', 'truehd', 'alac',
	'pcm_s16le', 'pcm_s24le', 'pcm_s32le']);

function unique(value, allowed, limit) {
	if (!Array.isArray(value)) return [];
	return [...new Set(value.filter(entry => typeof entry === 'string' && allowed.has(entry)))].slice(0, limit);
}

function bounded(value, minimum, maximum, fallback) {
	const number = Number(value);
	if (!Number.isFinite(number)) return fallback;
	return Math.min(maximum, Math.max(minimum, Math.round(number)));
}

function frameRate(value) {
	if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
	const match = /^(\d+)(?:\/(\d+))?$/.exec(String(value || ''));
	if (!match) return 0;
	const numerator = Number(match[1]), denominator = Number(match[2] || 1);
	return denominator > 0 ? numerator / denominator : 0;
}

/**
 * Sanitize bounded client decode metadata. This is never authentication and
 * never grants access; it only lets the live player avoid an unnecessary
 * transcode when the client has declared a supported combination.
 */
export function sanitizeCapabilities(value) {
	if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
	const videoCodecs = unique(value.videoCodecs, VIDEO_CODECS, 2);
	if (!videoCodecs.length) return null;
	const audioCodecs = unique(value.audioCodecs, AUDIO_CODECS, 4);
	if (!audioCodecs.includes('aac')) return null;
	const result = {
		videoCodecs,
		audioCodecs,
		maxWidth: bounded(value.maxWidth, 320, 3840, 1920),
		maxHeight: bounded(value.maxHeight, 240, 2160, 1080),
		maxBitrate: bounded(value.maxBitrate, 500000, 80000000, 8000000),
		maxFps: bounded(value.maxFps, 24, 60, 30),
		hevcMaxWidth: bounded(value.hevcMaxWidth, 320, 3840, 1920),
		hevcMaxHeight: bounded(value.hevcMaxHeight, 240, 2160, 1080),
		hevcMaxBitrate: bounded(value.hevcMaxBitrate, 500000, 80000000, 8000000),
		hevcMaxFps: bounded(value.hevcMaxFps, 24, 60, 30),
		hevcMain10: videoCodecs.includes('hevc') && value.hevcMain10 === true,
		hls: value.hls === true,
		mpegTs: value.mpegTs === true
	};
	// The newer Android payload adds explicit decoder contracts. Only include a
	// field when the client sent it, so legacy payloads keep their exact shape
	// and existing clients do not silently gain a new capability.
	if (Object.hasOwn(value, 'clientKind')) {
		const clientKind = String(value.clientKind || '').toLowerCase();
		if (CLIENT_KINDS.has(clientKind)) result.clientKind = clientKind;
	}
	if (Object.hasOwn(value, 'containers')) result.containers = unique(value.containers, DIRECT_CONTAINERS, 6);
	const h264Profiles = Object.hasOwn(value, 'h264Profiles') ? unique(value.h264Profiles, H264_PROFILES, 3) : null;
	const hevcProfiles = Object.hasOwn(value, 'hevcProfiles') ? unique(value.hevcProfiles, HEVC_PROFILES, 3) : null;
	const h264PixelFormats = Object.hasOwn(value, 'h264PixelFormats') ? unique(value.h264PixelFormats, DIRECT_PIXEL_FORMATS, 2) : null;
	const hevcPixelFormats = Object.hasOwn(value, 'hevcPixelFormats') ? unique(value.hevcPixelFormats, DIRECT_PIXEL_FORMATS, 2) : null;
	if (h264Profiles !== null) result.h264Profiles = h264Profiles;
	if (hevcProfiles !== null) result.hevcProfiles = hevcProfiles;
	if (h264PixelFormats !== null) result.h264PixelFormats = h264PixelFormats;
	if (hevcPixelFormats !== null) result.hevcPixelFormats = hevcPixelFormats;
	if (Object.hasOwn(value, 'h264MaxLevel')) result.h264MaxLevel = bounded(value.h264MaxLevel, 0, 62, 0);
	const hevcMaxLevel = Object.hasOwn(value, 'hevcMaxLevel') ? bounded(value.hevcMaxLevel, 0, 186, 0) : 0;
	if (Object.hasOwn(value, 'hevcMaxLevel')) result.hevcMaxLevel = hevcMaxLevel;
	// Explicit geometry evidence is only claimed when the client actually sent
	// the fields. Sanitizer defaults must never become proof.
	if (Object.hasOwn(value, 'maxWidth') && Object.hasOwn(value, 'maxHeight') && Object.hasOwn(value, 'maxFps')) result.h264GeometryEvidence = true;
	const hevcBounds = ['hevcMaxWidth', 'hevcMaxHeight', 'hevcMaxBitrate', 'hevcMaxFps']
		.every(key => Object.hasOwn(value, key) && Number.isFinite(Number(value[key])) && Number(value[key]) > 0);
	if (videoCodecs.includes('hevc') && hevcBounds && hevcMaxLevel > 0
		&& Array.isArray(hevcProfiles) && hevcProfiles.length > 0
		&& Array.isArray(hevcPixelFormats) && hevcPixelFormats.length > 0
		&& (!result.hevcMain10 || hevcPixelFormats.includes('yuv420p10le'))) result.hevcEvidence = true;
	if (Object.hasOwn(value, 'maxAudioChannels')) {
		const channels = Number(value.maxAudioChannels);
		if (Number.isFinite(channels)) result.maxAudioChannels = Math.min(8, Math.max(1, Math.round(channels)));
	}
	if (Object.hasOwn(value, 'audioChannels') && value.audioChannels && typeof value.audioChannels === 'object' && !Array.isArray(value.audioChannels)) {
		const channels = {};
		for (const [codec, count] of Object.entries(value.audioChannels)) {
			if (!AUDIO_CODECS.has(codec) && !NATIVE_AUDIO_CODECS.has(codec)) continue;
			const number = Number(count);
			if (!Number.isFinite(number) || number < 1 || number > 8) continue;
			channels[codec] = Math.round(number);
		}
		result.audioChannels = channels;
	}
	return result;
}

/**
 * Sanitize bounded native audio decoder claims. AAC/MP3 are always available in
 * this profile; the app's additional native decoders are accepted only from a
 * known direct-play set. This is a planning hint, never an auth or quality
 * override.
 */
export function sanitizeNativeAudio(value) {
	return unique(value, NATIVE_AUDIO_CODECS, 8);
}

/** Preserve the pre-0.26.29 browser/older-app decision when no metadata is sent. */
export function legacyVideoSupported({ codec, pixelFormat, bitrate, quality } = {}) {
	if (codec !== 'h264') return false;
	if (pixelFormat && !EIGHT_BIT.has(pixelFormat)) return false;
	return !(Number(bitrate) > (Number(quality) || 20000000));
}

/** Normalize a codec profile name for the Android capability contract. */
export function normalizeVideoProfile(value) {
	const profile=String(value||'').trim().toLowerCase().replace(/\s+/g,' ');
	if(profile==='constrained baseline')return 'baseline';
	if(profile==='main 10'||profile==='main10')return 'main10';
	return profile;
}

/**
 * Decide whether the source video can be copied without an encoder.
 *
 * A missing source bitrate is not proof that the source breaches the quality
 * ceiling or the decoder's proven bitrate. ffprobe commonly reports no bitrate
 * for live MPEG-TS, and treating that as incompatible sent every such 24/7
 * channel through libx264 even when codec, profile, level, geometry and pixel
 * format were all proven. Unknown bitrate is therefore "not proven too large",
 * while a known bitrate over either bound still fails closed. Every other
 * decoder contract stays mandatory; the app also keeps its one-shot
 * compatibility retry for a genuine decode failure.
 *
 * `blockers` is an optional, bounded diagnostic sink. It carries short tokens
 * such as `hevc-level`, never source URLs, metadata or credentials.
 */
export function clientVideoSupported({ codec, pixelFormat, profile, level, width, height, bitrate, frameRate: sourceFrameRate, quality, capabilities, allowUnknownBitrate = false, blockers } = {}) {
	const reject = reason => { if (Array.isArray(blockers)) blockers.push(reason); return false; };
	if (!capabilities || !capabilities.hls || !capabilities.mpegTs) return reject('capabilities');
	if (!capabilities.videoCodecs.includes(codec)) return reject('codec');
	if (!capabilities.audioCodecs.includes('aac')) return reject('audio');
	const maxWidth = codec === 'hevc' ? capabilities.hevcMaxWidth : capabilities.maxWidth;
	const maxHeight = codec === 'hevc' ? capabilities.hevcMaxHeight : capabilities.maxHeight;
	const maxBitrate = codec === 'hevc' ? capabilities.hevcMaxBitrate : capabilities.maxBitrate;
	const maxFps = codec === 'hevc' ? capabilities.hevcMaxFps : capabilities.maxFps;
	if ((Number(width) || 0) > maxWidth || (Number(height) || 0) > maxHeight) return reject('resolution');
	const fps = frameRate(sourceFrameRate);
	if (fps > 0 && fps > maxFps) return reject('framerate');
	const sourceBitrate = Number(bitrate) || 0;
	const qualityLimit = Number(quality) || 20000000;
	if (!(sourceBitrate > 0) && !allowUnknownBitrate) return reject('bitrate-unknown');
	if (sourceBitrate > qualityLimit) return reject('bitrate-quality');
	if (sourceBitrate > 0 && sourceBitrate > maxBitrate) return reject('bitrate-decoder');
	const normalized=normalizeVideoProfile(profile);
	const sourceLevel=Number(level)||0;
	if(codec==='h264') {
		if(Object.hasOwn(capabilities,'h264Profiles')
			&&(!Array.isArray(capabilities.h264Profiles)||capabilities.h264Profiles.length===0||!normalized||!capabilities.h264Profiles.includes(normalized)))return reject('h264-profile');
		if(Object.hasOwn(capabilities,'h264MaxLevel')&&Number(capabilities.h264MaxLevel)>0) {
			if(!(sourceLevel>0)||sourceLevel>Number(capabilities.h264MaxLevel))return reject('h264-level');
		}
		if(Object.hasOwn(capabilities,'h264PixelFormats')
			&&(!Array.isArray(capabilities.h264PixelFormats)||capabilities.h264PixelFormats.length===0||!capabilities.h264PixelFormats.includes(pixelFormat)))return reject('h264-pixel');
		if(capabilities.h264GeometryEvidence===true&&(!(Number(width)>0)||!(Number(height)>0)||!(fps>0)))return reject('h264-geometry');
		return EIGHT_BIT.has(pixelFormat) || reject('h264-bitdepth');
	}
	if (!pixelFormat) return reject('pixel');
	if (capabilities.hevcEvidence !== true) return reject('hevc-evidence');
	if (TEN_BIT_420.has(pixelFormat) && !capabilities.hevcMain10) return reject('hevc-main10');
	if (!TEN_BIT_420.has(pixelFormat) && !EIGHT_BIT.has(pixelFormat)) return reject('hevc-bitdepth');
	if (!(Number(width)>0)||!(Number(height)>0)||!(fps>0)) return reject('hevc-geometry');
	if(Object.hasOwn(capabilities,'hevcProfiles')
		&&(!Array.isArray(capabilities.hevcProfiles)||capabilities.hevcProfiles.length===0||!normalized||!capabilities.hevcProfiles.includes(normalized)))return reject('hevc-profile');
	// Explicit evidence guarantees a positive bounded level; a missing source
	// level is not proof.
	if(!(sourceLevel>0)||sourceLevel>Number(capabilities.hevcMaxLevel))return reject('hevc-level');
	if(Object.hasOwn(capabilities,'hevcPixelFormats')
		&&(!Array.isArray(capabilities.hevcPixelFormats)||capabilities.hevcPixelFormats.length===0||!capabilities.hevcPixelFormats.includes(pixelFormat)))return reject('hevc-pixel');
	if(TEN_BIT_420.has(pixelFormat)&&normalized!=='main10')return reject('hevc-profile-bitdepth');
	return true;
}

export function sourceVideoSupported(options = {}) {
	return options.capabilities === undefined
		? legacyVideoSupported(options)
		: clientVideoSupported(options);
}
