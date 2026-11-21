import { sanitizeCapabilities, sanitizeNativeAudio } from './capabilities.mjs';

export const textSubtitle = track => track?.Type === 'Subtitle' && /^(subrip|srt|ass|ssa|webvtt|vtt|mov_text|text)$/i.test(track.Codec || '');

// HEVC DirectPlay is only advertised for a native profile whose sanitized
// client contract proves the decoder. The profile still carries Jellyfin
// per-source conditions (bit depth/profile/level/bitrate/size/frame rate), so a
// capability claim cannot direct-play an unproven source. Browser profiles
// never advertise HEVC even if a client sends it.
const NATIVE_CONTAINERS = ['mp4', 'm4v', 'mkv'];
const BROWSER_CONTAINERS = ['mp4', 'm4v'];

function directContainers(native, caps) {
	const base = native ? NATIVE_CONTAINERS : BROWSER_CONTAINERS;
	if (!caps || !Array.isArray(caps.containers)) return base;
	return base.filter(container => caps.containers.includes(container));
}

function audioDirectPlan(native, nativeAudio, caps) {
	const codecs = [...new Set(['aac', 'mp3', ...(native ? sanitizeNativeAudio(nativeAudio) : [])])];
	if (!caps || !caps.audioChannels || typeof caps.audioChannels !== 'object') return { codecs, profiles: [] };
	const max = Math.min(8, Math.max(1, Number(caps.maxAudioChannels) || 8));
	const retained = codecs.filter(codec => codec === 'aac' || codec === 'mp3'
		|| (Number(caps.audioChannels[codec]) > 0 && Number(caps.audioChannels[codec]) <= max));
	const profiles = [];
	for (const codec of retained) {
		const limit = Math.min(max, Number(caps.audioChannels[codec]) || max);
		if (limit > 0) profiles.push({ Type: 'Audio', Codec: codec, Conditions: [
			{ Condition: 'LessThanEqual', Property: 'AudioChannels', Value: String(limit), IsRequired: false }
		] });
	}
	return { codecs: retained, profiles };
}

function h264DirectPlan(caps) {
	let profiles = 'high|main|baseline|constrained baseline';
	let level = '51';
	let depth = '8';
	const conditions = [];
	if (caps) {
		if (Array.isArray(caps.h264Profiles)) {
			const list = [...caps.h264Profiles];
			if (list.includes('baseline')) list.push('constrained baseline');
			profiles = [...new Set(list)].join('|') || '__unsupported__';
		}
		if (Number(caps.h264MaxLevel) > 0) level = String(Math.min(51, Number(caps.h264MaxLevel)));
		// H.264 direct play in this profile is 8-bit only. If the client did
		// not advertise yuv420p, do not claim H.264 direct play at all.
		if (Array.isArray(caps.h264PixelFormats)) depth = caps.h264PixelFormats.includes('yuv420p') ? '8' : '0';
		if (caps.h264GeometryEvidence === true) {
			// A 720p/30 device must not receive a 1080p source merely because
			// both are level 4.1. Missing source values fail (IsRequired:true).
			conditions.push(
				{ Condition: 'LessThanEqual', Property: 'Width', Value: String(caps.maxWidth), IsRequired: true },
				{ Condition: 'LessThanEqual', Property: 'Height', Value: String(caps.maxHeight), IsRequired: true },
				{ Condition: 'LessThanEqual', Property: 'VideoFramerate', Value: String(caps.maxFps), IsRequired: true }
			);
		}
	}
	return { profiles, level, depth, conditions };
}

function nativeHevcProfile(native, caps, quality) {
	if (!native || !caps || !caps.videoCodecs.includes('hevc') || caps.hevcEvidence !== true) return null;
	const maxWidth = Number(caps.hevcMaxWidth), maxHeight = Number(caps.hevcMaxHeight);
	const maxFps = Number(caps.hevcMaxFps);
	const maxBitrate = Math.min(Number(caps.hevcMaxBitrate) || 8000000, Number(quality) || 20000000);
	if (!(maxWidth >= 320) || !(maxHeight >= 240) || !(maxFps >= 24) || !(maxBitrate >= 500000)) return null;
	const maxLevel = Math.min(186, Number(caps.hevcMaxLevel) || 0);
	if (!(maxLevel > 0)) return null;
	const main10 = caps.hevcMain10 === true;
	let profiles = main10 ? ['main', 'main10'] : ['main'];
	if (Array.isArray(caps.hevcProfiles)) {
		profiles = caps.hevcProfiles.filter(profile => profile === 'main' || (profile === 'main10' && main10));
		if (!profiles.length) return null;
	}
	let maxDepth = main10 && profiles.includes('main10') ? 10 : 8;
	if (Array.isArray(caps.hevcPixelFormats)) {
		const eightBit = caps.hevcPixelFormats.includes('yuv420p');
		const tenBit = main10 && caps.hevcPixelFormats.includes('yuv420p10le');
		if (!eightBit && !tenBit) return null;
		profiles = profiles.filter(profile => profile === 'main' ? eightBit : tenBit);
		if (!profiles.length) return null;
		maxDepth = tenBit ? 10 : 8;
	}
	if (!profiles.length) return null;
	return {
		main10, maxWidth, maxHeight, maxFps, maxBitrate, maxLevel, maxDepth,
		profiles: profiles.map(profile => profile === 'main10' ? 'main 10' : 'main')
	};
}

export function deviceProfile(forceTranscode, quality, native = false, nativeAudio = [], capabilities = null) {
	const caps = capabilities ? sanitizeCapabilities(capabilities) : null;
	const audio = audioDirectPlan(native, nativeAudio, caps);
	const containers = directContainers(native, caps);
	const hevc = nativeHevcProfile(native, caps, quality);
	const h264 = h264DirectPlan(caps);
	const directPlay = forceTranscode || !containers.length ? [] : [{ Container: containers.join(','), Type: 'Video', VideoCodec: 'h264', AudioCodec: audio.codecs.join(',') }];
	if (!forceTranscode && hevc && containers.length) directPlay.push({ Container: containers.join(','), Type: 'Video', VideoCodec: 'hevc', AudioCodec: audio.codecs.join(',') });
	const codecProfiles = [{ Type: 'Video', Codec: 'h264', Conditions: [
		{ Condition: 'LessThanEqual', Property: 'VideoBitDepth', Value: h264.depth, IsRequired: false },
		{ Condition: 'LessThanEqual', Property: 'VideoLevel', Value: h264.level, IsRequired: false },
		{ Condition: 'EqualsAny', Property: 'VideoProfile', Value: h264.profiles, IsRequired: false },
		...h264.conditions
	] }];
	if (hevc) codecProfiles.push({ Type: 'Video', Codec: 'hevc', Conditions: [
		{ Condition: 'LessThanEqual', Property: 'VideoBitDepth', Value: String(hevc.maxDepth), IsRequired: true },
		{ Condition: 'LessThanEqual', Property: 'VideoLevel', Value: String(hevc.maxLevel), IsRequired: true },
		{ Condition: 'EqualsAny', Property: 'VideoProfile', Value: hevc.profiles.join('|'), IsRequired: true },
		{ Condition: 'LessThanEqual', Property: 'VideoBitrate', Value: String(hevc.maxBitrate), IsRequired: true },
		{ Condition: 'LessThanEqual', Property: 'Width', Value: String(hevc.maxWidth), IsRequired: true },
		{ Condition: 'LessThanEqual', Property: 'Height', Value: String(hevc.maxHeight), IsRequired: true },
		{ Condition: 'LessThanEqual', Property: 'VideoFramerate', Value: String(hevc.maxFps), IsRequired: true }
	] });
	codecProfiles.push(...audio.profiles);
	return {
		Name: native ? 'Tellybox Android' : 'Tellybox browser', MaxStreamingBitrate: quality, MaxStaticBitrate: quality,
		DirectPlayProfiles: directPlay,
		TranscodingProfiles: [{ Container: 'ts', Type: 'Video', VideoCodec: 'h264', AudioCodec: 'aac', Protocol: 'hls', Context: 'Streaming', MaxAudioChannels: '2', MinSegments: 1, SegmentLength: 4, BreakOnNonKeyFrames: false }],
		CodecProfiles: codecProfiles,
		SubtitleProfiles: ['srt', 'subrip', 'vtt', 'webvtt', 'ass', 'ssa', 'pgssub', 'dvdsub', 'dvbsub'].map(Format => ({ Format, Method: 'Encode' }))
	};
}

// Jellyfin's transcoding URL is the only bounded evidence for why a local file
// is not DirectPlay. Report its explicit TranscodeReasons labels. Only call a
// video stream "copied" when Jellyfin explicitly allowed video stream copy, the
// target codec equals the source codec, and no video reason was reported.
// Otherwise keep the generic reason and never label a transcode as DirectPlay.
export function jellyfinTranscodeReason(source, transcodeUrl, { forceTranscode = false, burnSubtitles = false } = {}) {
	if (burnSubtitles) return 'Subtitles included in the picture';
	if (forceTranscode) return 'Compatible playback requested by this app';
	if (!transcodeUrl) return 'Jellyfin requested transcoding (reason not provided)';
	let params;
	try { params = new URL(transcodeUrl, 'http://jellyfin.invalid').searchParams; }
	catch { return 'Jellyfin requested transcoding (reason not provided)'; }
	const labels = {
		AudioCodecNotSupported: 'audio codec not supported', AudioBitrateNotSupported: 'audio bitrate not supported',
		AudioChannelsNotSupported: 'audio channel count not supported', AudioProfileNotSupported: 'audio profile not supported',
		AudioSampleRateNotSupported: 'audio sample rate not supported', ContainerNotSupported: 'container not supported',
		VideoCodecNotSupported: 'video codec not supported', VideoBitrateNotSupported: 'video bitrate not supported',
		VideoLevelNotSupported: 'video level not supported', VideoProfileNotSupported: 'video profile not supported',
		VideoResolutionNotSupported: 'video resolution not supported', VideoBitDepthNotSupported: 'video bit depth not supported',
		VideoFramerateNotSupported: 'video frame rate not supported', SubtitleCodecNotSupported: 'subtitle codec not supported',
		DefaultAudioStreamNotSupported: 'default audio stream not supported'
	};
	const reasons = String(params.get('TranscodeReasons') || '').split(',').map(value => value.trim()).filter(Boolean);
	if (!reasons.length) return 'Jellyfin requested transcoding (reason not provided)';
	const videoReasons = reasons.filter(reason => /^Video/.test(reason));
	const sourceCodec = String((source.MediaStreams || []).find(track => track.Type === 'Video')?.Codec || '').toLowerCase();
	const targetCodec = String(params.get('VideoCodec') || '').toLowerCase();
	const videoCopied = params.get('AllowVideoStreamCopy') === 'true' && !videoReasons.length && Boolean(sourceCodec) && targetCodec === sourceCodec;
	return 'Jellyfin: ' + reasons.map(reason => labels[reason] || reason).join(', ') + (videoCopied ? ' (video copied, audio/container converted)' : '');
}

// Safe, bounded explanation for provider/relay/catch-up/recording prepare
// responses. Method is already the real worker/player decision; never claim
// DirectPlay for a transcode and never include a URL, token or provider payload.
export function relayConversionReason(method, { recording = false, catchup = false } = {}) {
	const value = String(method || '').toLowerCase();
	if (value === 'directplay') return 'Original file supported';
	if (value === 'relay' || !value) return 'Relay playback prepared for this device';
	if (recording) {
		if (value === 'copy') return 'Recording copied without re-encoding';
		if (value === 'remux') return 'Recording video copied; audio converted to AAC stereo';
		return 'Recording converted for this device';
	}
	if (catchup) {
		if (value === 'copy') return 'Catch-up stream copied without re-encoding';
		if (value === 'remux') return 'Catch-up video copied; audio converted to AAC stereo';
		return 'Catch-up source converted for this device';
	}
	if (value === 'copy') return 'Provider stream copied without re-encoding';
	if (value === 'remux') return 'Provider video copied; audio converted to AAC stereo';
	return 'Provider source converted for this device';
}

export function wantsSubtitleLookup(request) {
	return request.subtitleIndex === 1000000 || (!Number.isInteger(request.subtitleIndex) && request.preferEnglishSubtitles === true);
}

export function srtToVtt(text) {
	return 'WEBVTT\n\n' + text.replace(/\r/g, '').replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
}
