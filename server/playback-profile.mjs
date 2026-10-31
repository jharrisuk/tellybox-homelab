export const textSubtitle = track => track?.Type === 'Subtitle' && /^(subrip|srt|ass|ssa|webvtt|vtt|mov_text|text)$/i.test(track.Codec || '');

export function deviceProfile(forceTranscode, quality, native = false, nativeAudio = []) {
	const audio=['aac','mp3',...(native&&Array.isArray(nativeAudio)?nativeAudio.filter(codec=>['ac3','eac3'].includes(codec)):[])].join(',');
	return {
		Name: native ? 'Tellybox Android' : 'Tellybox browser', MaxStreamingBitrate: quality, MaxStaticBitrate: quality,
		DirectPlayProfiles: forceTranscode ? [] : [{ Container: native ? 'mp4,m4v,mkv' : 'mp4,m4v', Type: 'Video', VideoCodec: 'h264', AudioCodec: audio }],
		TranscodingProfiles: [{ Container: 'ts', Type: 'Video', VideoCodec: 'h264', AudioCodec: 'aac', Protocol: 'hls', Context: 'Streaming', MaxAudioChannels: '2', MinSegments: 1, SegmentLength: 4, BreakOnNonKeyFrames: false }],
		CodecProfiles: [{ Type: 'Video', Codec: 'h264', Conditions: [
			{ Condition: 'LessThanEqual', Property: 'VideoBitDepth', Value: '8', IsRequired: false },
			{ Condition: 'LessThanEqual', Property: 'VideoLevel', Value: '51', IsRequired: false },
			{ Condition: 'EqualsAny', Property: 'VideoProfile', Value: 'high|main|baseline|constrained baseline', IsRequired: false }
		] }],
		SubtitleProfiles: ['srt', 'subrip', 'vtt', 'webvtt', 'ass', 'ssa', 'pgssub', 'dvdsub', 'dvbsub'].map(Format => ({ Format, Method: 'Encode' }))
	};
}

export function wantsSubtitleLookup(request) {
	return request.subtitleIndex === 1000000 || (!Number.isInteger(request.subtitleIndex) && request.preferEnglishSubtitles === true);
}

export function srtToVtt(text) {
	return 'WEBVTT\n\n' + text.replace(/\r/g, '').replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
}
