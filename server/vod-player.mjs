import http from 'node:http';
import {captionMaster,captionManifest,captionSlice} from './vod-captions.mjs';
import {clientVideoSupported} from './capabilities.mjs';
import {randomBytes} from 'node:crypto';
import {spawn} from 'node:child_process';
import {mkdtemp,readFile,readdir,rm,copyFile,writeFile,stat} from 'node:fs/promises';
import {wantsSubtitleLookup} from './playback-profile.mjs';
import {englishSubtitle} from './subtitle-choice.mjs';
import path from 'node:path';
import os from 'node:os';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';

const fail=message=>Object.assign(Error(message),{status:502});
const compatibilityRequired=()=>Object.assign(Error('This title needs compatibility playback.'),{status:409,code:'VOD_COMPATIBILITY_REQUIRED'});
// A terminal encoder failure is not a stall: the child is already dead and
// waiting the full no-progress deadline only delays the client's actionable
// replacement. This code is stable for the app and the relay worker.
const encoderExit=message=>Object.assign(Error(message),{status:502,code:'VOD_ENCODER_EXIT'});
const textCodecs=new Set(['subrip','srt','ass','ssa','webvtt','mov_text','text']);
const imageCodecs=new Set(['hdmv_pgs_subtitle','dvd_subtitle','dvb_subtitle']);
const VOD_PRESETS=new Set(['veryfast','superfast','ultrafast']);

// Stable, user-safe encoder failure categories. Only recognisable terminal
// causes are mapped here; anything else stays `unknown` instead of asserting a
// cause the relay did not observe.
const ENCODER_CATEGORIES=new Set(['input_open','http_status','invalid_data','unsupported_codec','decoder_error','conversion_failed','permission','timeout','encoder_exit','unknown']);
const ENCODER_SUMMARIES={
	input_open:'The provider input could not be opened.',
	http_status:'The provider refused the input with an HTTP error.',
	invalid_data:'The input data was invalid or unreadable.',
	unsupported_codec:'The input uses a codec the relay cannot decode.',
	decoder_error:'The input could not be decoded.',
	conversion_failed:'The relay could not prepare the encoder output.',
	permission:'The relay was not permitted to read the input.',
	timeout:'The provider input timed out.',
	encoder_exit:'The encoder exited before it produced a segment.',
	unknown:'The encoder stopped for an unrecognised reason.'
};
const ENCODER_USER_SUMMARIES={
	input_open:'The provider source could not be opened.',
	http_status:'The provider refused this stream.',
	invalid_data:'The provider source could not be read.',
	unsupported_codec:'This stream uses a format the relay cannot decode.',
	decoder_error:'The provider source could not be decoded.',
	conversion_failed:'The relay could not prepare this stream.',
	permission:'The relay was not allowed to read this stream.',
	timeout:'The provider did not respond in time.',
	encoder_exit:'The relay encoder stopped before playback started.',
	unknown:'The relay could not prepare this stream.'
};

function encoderText(value) {
	const text=Buffer.isBuffer(value)?value.toString('utf8'):String(value??'');
	return text
		// CSI/OSC ANSI sequences, then any remaining C0/C1 control bytes.
		.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g,'')
		.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g,'')
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g,' ')
		.replace(/\r\n?/g,'\n');
}

// Redact before anything is retained. URLs are removed as a whole first so a
// query string or an account in the authority cannot survive in fragments.
function redactEncoderText(text) {
	return String(text)
		.replace(/\bhttps?:\/\/[^\s"'<>]+/gi,'[url]')
		.replace(/\b(Authorization|Proxy-Authorization|Cookie|Set-Cookie)\s*[:=][^\r\n]*/gi,'$1=[redacted]')
		// Percent-encoded parameter fragments (%74oken=... or token%3D...).
		.replace(/[^\s"'<>]*(?:%[0-9a-f]{2})[^\s"'<>]*(?:=|%3D)[^\s"'<>]*/gi,'[redacted]')
		.replace(/([?&](?:access_?token|token|api_?key|key|username|user|login|account|password|passwd|pwd|auth|authorization|signature|sig|secret|expires|e)=)[^&\s"'<>]+/gi,'$1[redacted]')
		.replace(/(["']?\b(?:access_?token|token|api_?key|username|user|login|account|password|passwd|pwd|auth|authorization|signature|sig|secret|credential|session)\b["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s&,;]+)/gi,'$1[redacted]')
		.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s\/:@]+:[^\s@\/]+@/gi,'$1[redacted]@')
		.replace(/\bBearer\s+[A-Za-z0-9._~+\/=-]{8,}/gi,'Bearer [redacted]')
		.replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,'[redacted]')
		.replace(/\b[0-9a-f]{32,}\b/gi,'[redacted]')
		.replace(/\b[A-Za-z0-9+\/_-]{48,}={0,2}\b/g,'[redacted]')
		// Absolute provider paths (Windows drive or a POSIX path with at least
		// two segments), plus single-segment credential-looking paths.
		.replace(/\b[A-Za-z]:[\\/](?:[^\s"'<>|:*?]+[\\/])*[^\s"'<>|:*?]+/g,'[path]')
		.replace(/(^|[\s"'(=])\/(?:[^\s"'<>|/]+\/)+[^\s"'<>|/]+/g,'$1[path]')
		.replace(/(^|[\s"'(=])\/(?:secret|token|key|password|passwd|auth|private|credentials?)(?=[\s"'<>),.;:]|$)/gi,'$1[path]')
		.replace(/[ \t]+/g,' ')
		.trim();
}

function encoderHttpStatus(lines) {
	const match=/\b(?:http|server\s+returned)\D{0,12}([45]\d{2})\b/i.exec(lines.join('\n'));
	return match?Number(match[1]):0;
}

function encoderCategory(lines,exitCode) {
	const text=lines.join('\n').toLowerCase();
	if(!text)return Number.isInteger(exitCode)&&exitCode!==0?'encoder_exit':'unknown';
	if(/\b(?:http|server\s+returned)\D{0,12}(?:[45]\d{2}|[45]xx)\b|\b[45]\d{2}\s+(?:unauthorized|forbidden|not found|bad gateway|service unavailable|internal server error)\b/i.test(text))return 'http_status';
	if(/permission denied|operation not permitted|access is denied|\beacces\b|\beperm\b/.test(text))return 'permission';
	if(/timed out|timeout|etimedout|operation timed out|connection timed out/.test(text))return 'timeout';
	if(/decoder[^\n]*not found|unknown decoder|no decoder|unsupported (?:video |audio )?codec|codec[^\n]*not found|could not find codec parameters/.test(text))return 'unsupported_codec';
	if(/error while decoding|failed to decode|decode_slice_header|decode error|invalid nal|corrupt decoded|no frame!/.test(text))return 'decoder_error';
	if(/invalid data found when processing input|moov atom not found|malformed|corrupt|invalid .*bitstream/.test(text))return 'invalid_data';
	if(/error opening input|could not open input|failed to open|protocol not found|connection refused|no such file|input\/output error|\benoent\b/.test(text))return 'input_open';
	if(/error initializing output|error while opening encoder|could not open encoder|could not write header|failed to write header|error initializing filter|filter[^\n]*failed|conversion failed|cannot allocate|out of memory|\benomem\b/.test(text))return 'conversion_failed';
	if(Number.isInteger(exitCode)&&exitCode!==0)return 'encoder_exit';
	return 'unknown';
}

/**
 * Retain a bounded, sanitized terminal FFmpeg description. This is diagnostics,
 * never a claim about the production provider: the category only reflects text
 * the local child actually emitted. Raw URLs, credentials and provider paths are
 * removed before the lines are returned or logged.
 */
export function sanitizeEncoderDiagnostics(value,{limitLines=8,limitChars=1200,exitCode}={}) {
	const maxLines=Math.max(1,Math.min(40,Number(limitLines)||8));
	const maxChars=Math.max(64,Math.min(8192,Number(limitChars)||1200));
	const code=Number.isInteger(exitCode)?exitCode:undefined;
	const progress=/^(?:frame|fps|stream_\d+_\d+|bitrate|total_size|out_time_us|out_time_ms|out_time|dup_frames|drop_frames|speed|progress)=/i;
	// Bound the scan before any large regex/split allocation. Only the tail can
	// contain a terminal cause, and the final output is much smaller than this.
	const raw=Buffer.isBuffer(value)?value.toString('utf8'):String(value??'');
	const tail=raw.length>131072?raw.slice(-131072):raw;
	const scan=encoderText(tail);
	const bounded=scan.length>65536?scan.slice(-65536):scan;
	const seen=[];
	for(const raw of bounded.split('\n')) {
		if(raw.length>65536){seen.push('[oversize-line]');if(seen.length>maxLines*8)seen.splice(0,seen.length-maxLines*8);continue;}
		const line=redactEncoderText(raw);
		if(!line||line.length<2||progress.test(line)||/^press \[q\] to stop/i.test(line))continue;
		seen.push(line);
		// Keep the scan window bounded even for many very short lines.
		if(seen.length>maxLines*8)seen.splice(0,seen.length-maxLines*8);
	}
	const lines=[];
	let used=0;
	for(let i=seen.length-1;i>=0&&lines.length<maxLines;i--) {
		let line=seen[i];
		const separator=lines.length?1:0;
		const remaining=maxChars-used-separator;
		if(remaining<16)break;
		if(line.length>remaining) {
			if(lines.length)break;
			line='\u2026'+line.slice(-(remaining-1));
		}
		lines.unshift(line);
		used+=line.length+separator;
	}
	const rawCategory=encoderCategory(seen.length?seen:lines,code);
	const category=ENCODER_CATEGORIES.has(rawCategory)?rawCategory:'unknown';
	const httpStatus=category==='http_status'?encoderHttpStatus(seen.length?seen:lines):0;
	const summary=httpStatus?`${ENCODER_SUMMARIES[category]} (HTTP ${httpStatus})`:ENCODER_SUMMARIES[category];
	const result={
		category,
		code:category==='encoder_exit'?'VOD_ENCODER_EXIT':`VOD_ENCODER_${category.toUpperCase()}`,
		lines,
		summary,
		userSummary:`This stream could not be started by the relay. ${ENCODER_USER_SUMMARIES[category]} Try another quality or source.`
	};
	if(httpStatus)result.httpStatus=httpStatus;
	if(code!==undefined)result.exitCode=code;
	return result;
}

function encoderFailureFrom(stderr,exitCode,signal) {
	const failure=sanitizeEncoderDiagnostics(stderr,{exitCode});
	return {...failure,...(signal?{signal:String(signal)}:{})};
}

/**
 * Bounded complete-line retention for encoder stderr. Raw text is held only as
 * the current incomplete line and never logged or exposed. A complete line is
 * redacted once with its full context, so a URL/token/header split across any
 * chunk boundary is joined before redaction. An overlong line is discarded
 * until its newline rather than retaining a value suffix without its key.
 */
export function createEncoderDiagnosticRetention({limit=4096,maxLine=2*1024*1024}={}) {
	const size=Math.max(256,Math.min(16384,Number(limit)||4096));
	const maxPending=Math.max(4096,Math.min(4*1024*1024,Number(maxLine)||2*1024*1024));
	let pending='',retained='',discarding=false;
	function addLine(line) {
		if(line.length>65536) {
			retained=(retained?retained+'\n':'')+'[oversize-line]';
			if(retained.length>size)retained=retained.slice(-size);
			return;
		}
		const redacted=redactEncoderText(line);
		if(!redacted)return;
		retained=(retained?retained+'\n':'')+redacted;
		if(retained.length>size)retained=retained.slice(-size);
	}
	function push(chunk) {
		let text=Buffer.isBuffer(chunk)?chunk.toString('utf8'):String(chunk??'');
		if(!text)return;
		if(discarding) {
			const newline=text.indexOf('\n');
			if(newline<0)return;
			text=text.slice(newline+1);
			discarding=false;
		}
		pending+=text;
		if(pending.length>maxPending) {
			const lastNewline=pending.lastIndexOf('\n');
			if(lastNewline<0) {
				// No complete line to classify and no safe context boundary: drop
				// the oversized raw line and ignore the rest until a newline.
				pending='';
				discarding=true;
				return;
			}
		}
		const parts=pending.split('\n');
		pending=parts.pop()??'';
		for(const line of parts)addLine(line);
		if(pending.length>maxPending) {
			pending='';
			discarding=true;
		}
	}
	function flush() {
		if(pending&&!discarding)addLine(pending);
		pending='';discarding=false;
		return retained;
	}
	return {
		push,
		flush,
		text:()=>retained,
		clear(){pending='';retained='';discarding=false;}
	};
}

function encoderFailureMessage(failure) {
	return failure?.userSummary||'This stream could not be started by the relay. The provider source could not be opened or decoded. Try another quality or source.';
}

// VOD only. Live/direct keeps TELLYBOX_LIVE_PRESET and catch-up keeps its own
// hardcoded preset. The default stays byte-identical to the pre-115 encoder
// until a deploy explicitly opts in.
export function vodPreset(value=process.env.TELLYBOX_VOD_PRESET){return VOD_PRESETS.has(value)?value:'veryfast';}
// Copy/remux avenue. Enabled unless an operator explicitly kills it with
// TELLYBOX_VOD_COPY=0. A source is copied (video) only when the sanitized
// client capabilities, source profile/chroma/limits, audio shape, container,
// selected subtitle and quality ceiling all prove the combination safe;
// otherwise the player falls closed to the existing libx264 transcode.
export function vodCopyEnabled(value=process.env.TELLYBOX_VOD_COPY){return value!=='0';}
// Containers whose stream can be remuxed into the MPEG-TS HLS segments the
// player already serves. AVI is deliberately absent: its timestamp/bitstream
// behavior is not proven for copy.
const COPY_CONTAINERS=new Set(['matroska','webm','mov','mp4','mpegts']);
// Audio codecs we can pass through (copy) or convert to AAC. Anything unknown
// fails closed to a full transcode instead of guessing.
const COPY_AUDIO_CODECS=new Set(['aac','ac3','eac3','mp3','opus','vorbis','flac','dts','truehd',
	'pcm_s16le','pcm_s24le','pcm_s32le','pcm_s16be','pcm_s24be','pcm_f32le','pcm_f64le']);
function copyContainerSupported(value) {
	for(const part of String(value||'').toLowerCase().split(','))if(COPY_CONTAINERS.has(part.trim()))return true;
	return false;
}
function copyAudioSupported(audio) {
	if(audio===undefined||audio===null)return true;
	const track=Array.isArray(audio)?audio[0]:audio;
	if(!track)return true;
	const codec=String(track.codec_name||track.codec||'').toLowerCase();
	if(!codec||!COPY_AUDIO_CODECS.has(codec))return false;
	const channels=Number(track.channels)||0;
	return channels>=1&&channels<=8;
}
function sourceFrameRate(value) {
	const match=/^(\d+)(?:\/(\d+))?$/.exec(String(value||''));
	if(!match)return 0;
	const denominator=Number(match[2]||1);
	return denominator>0?Number(match[1])/denominator:0;
}
// Profile/level are decode contracts too, not just codec names. Keep the
// accepted set deliberately small: unknown or 10-bit/4:2:2/4:4:4 profiles fail
// closed unless the client explicitly advertised the matching capability.
export function vodCopyProfileSupported(video,capabilities={}) {
	const codec=String(video?.codec_name||'').toLowerCase();
	const profile=String(video?.profile||'').trim().toLowerCase();
	const level=Number(video?.level)||0;
	if(level<=0)return false;
	if(codec==='h264') {
		if(!['constrained baseline','baseline','main','high'].includes(profile))return false;
		if(level>52)return false;
		if(Object.hasOwn(capabilities||{},'h264Profiles')
			&&(!Array.isArray(capabilities.h264Profiles)||capabilities.h264Profiles.length===0||!capabilities.h264Profiles.includes(profile==='constrained baseline'?'baseline':profile)))return false;
		if(Number(capabilities?.h264MaxLevel)>0&&level>Number(capabilities.h264MaxLevel))return false;
		return true;
	}
	if(codec==='hevc') {
		if(level>186)return false;
		if(capabilities?.hevcEvidence!==true)return false;
		if(Object.hasOwn(capabilities,'hevcProfiles')
			&&(!Array.isArray(capabilities.hevcProfiles)||capabilities.hevcProfiles.length===0||!capabilities.hevcProfiles.includes(profile==='main 10'?'main10':'main')))return false;
		// An explicit unknown HEVC level (0) is not proof. Evidence requires a
		// positive level, so a missing source level was already rejected below.
		if(Object.hasOwn(capabilities,'hevcMaxLevel')&&Number(capabilities.hevcMaxLevel)<=0)return false;
		if(Number(capabilities?.hevcMaxLevel)>0&&level>Number(capabilities.hevcMaxLevel))return false;
		if(profile==='main')return true;
		return profile==='main 10'&&capabilities?.hevcMain10===true;
	}
	return false;
}
// Shared copy decision. Requires explicit client capabilities (the web client
// advertises none today, so it fails closed to transcode), the source inside
// the user's quality ceiling and the client's own decode limits, a supported
// profile/level/chroma, a remuxable container and a convertible audio track.
// Exported so the worker metadata probe and the player agree on the method.
export function vodCopyEligible(video,format,{capabilities,quality,audio,container}={}) {
	if(!video||!capabilities||!video.codec_name)return false;
	if(String(video.codec_name).toLowerCase()==='hevc'&&capabilities.hevcEvidence!==true)return false;
	const width=Number(video.width),height=Number(video.height);
	const fps=sourceFrameRate(video.r_frame_rate||video.avg_frame_rate);
	// Absent dimensions/frame rate are not proof of a safe copy; fail closed.
	if(!(width>0)||!(height>0)||!(fps>0))return false;
	const bitrate=Number(format?.bit_rate)||Number(video.bit_rate)||0;
	if(!clientVideoSupported({codec:video.codec_name,pixelFormat:video.pix_fmt,profile:video.profile,level:video.level,width:video.width,height:video.height,
		frameRate:video.r_frame_rate||video.avg_frame_rate,bitrate,quality:Number(quality)||8000000,capabilities}))return false;
	if(!vodCopyProfileSupported(video,capabilities))return false;
	if(!copyContainerSupported(container??format?.format_name))return false;
	return copyAudioSupported(audio);
}
// Derive a copy segment grid from actual source keyframes. A copy HLS segment
// can only start on a keyframe, so the playlist grid must be the proven GOP,
// not an assumed 4 s. Require at least three keyframes and a regular interval;
// irregular/absent timing fails closed to transcode. Exported for tests.
export function vodCopySegmentSeconds(times,{min=1,max=10,tolerance=0.12}={}) {
	const values=(times||[]).map(Number).filter(Number.isFinite).sort((a,b)=>a-b);
	const unique=[];
	for(const value of values)if(!unique.length||value-unique[unique.length-1]>1e-6)unique.push(value);
	if(unique.length<3)return 0;
	const deltas=[];
	for(let i=1;i<unique.length;i++) {
		const delta=unique[i]-unique[i-1];
		if(!(delta>0))return 0;
		// A sub-second keyframe gap is not a proven copy grid; fail closed.
		if(delta<min)return 0;
		if(delta>max)return 0;
		deltas.push(delta);
	}
	if(deltas.length<2)return 0;
	const sorted=[...deltas].sort((a,b)=>a-b),median=sorted[Math.floor(sorted.length/2)];
	if(median<min||median>max)return 0;
	if(sorted[sorted.length-1]-sorted[0]>tolerance)return 0;
	return Math.round(median*1000)/1000;
}
/** Shared whole-title GOP sample points. */
export function vodCopySampleStarts(duration) {
	const starts=[0];
	if(duration>12)starts.push(Math.max(0,duration-12));
	if(duration>36)starts.push(duration/3,2*duration/3);
	const unique=[];
	for(const start of starts) {
		const rounded=Math.round(start*10)/10;
		if(rounded<0||rounded>=duration)continue;
		if(unique.some(value=>Math.abs(value-rounded)<1))continue;
		unique.push(rounded);
	}
	return unique;
}
/** A copy plan is only valid when every whole-title sample proves the same step. */
export function vodCopyPlan(samples,firstKeyframe=0) {
	const proven=Number(samples?.[0])||0;
	if(!(proven>0))return null;
	if(!samples.every(value=>Math.abs(Number(value)-proven)<=0.12))return null;
	return {segmentSeconds:proven,firstKeyframe:Number(firstKeyframe)||0};
}
// Authoritative copy tail plan from an actual tail remux probe. MPEG-TS HLS
// split is video/keyframe-led, so an audio/container tail past the last video
// keyframe rides inside the final real segment instead of creating a new one.
// `segments` are the probe's emitted files in playback order: the duration of
// each, the first file's first video PTS and the final file's real video/audio
// packet end. The plan is rejected - never guessed - when a split is not a
// proven keyframe grid, when the numbering is not continuous, or when the
// emitted tail does not carry the source's real final video/audio packets.
// A genuinely short tail is preserved (0.08 s stays 0.08 s). Exported for
// deterministic tests.
export function vodCopyTailPlan({segments,step,sourceVideoEnd,sourceAudioEnd}={}) {
	const size=Number(step);
	if(!(size>0)||!Array.isArray(segments)||!segments.length)return null;
	const list=segments.map(entry=>{
		const duration=Number(entry?.duration);
		return {duration,...(entry?.firstPts!==undefined?{firstPts:Number(entry.firstPts)}:{})};
	});
	if(list.some(entry=>!(entry.duration>0)||entry.duration>86400))return null;
	// Every segment except the final tail is a normal keyframe split.
	for(let i=0;i<list.length-1;i++)if(Math.abs(list[i].duration-size)>0.25)return null;
	const firstPts=list[0].firstPts;
	if(!Number.isFinite(firstPts))return null;
	const first=Math.round(firstPts/size);
	if(first<0||Math.abs(firstPts-first*size)>Math.max(0.5,size*0.25))return null;
	const lastIndex=first+list.length-1;
	const declaredEnd=lastIndex*size+list[list.length-1].duration;
	// The emitted final segment must carry the real last video (and, when the
	// source has selected audio, audio) packets. A truncated tail is not
	// accepted as a successful finish.
	const videoEnd=Number(segments[segments.length-1]?.videoEnd);
	if(!Number.isFinite(videoEnd)||videoEnd<Number(sourceVideoEnd)-0.75)return null;
	const audioEnd=Number(segments[segments.length-1]?.audioEnd);
	const sourceAudio=Number(sourceAudioEnd);
	if(Number.isFinite(sourceAudio)&&sourceAudio>0&&(!Number.isFinite(audioEnd)||audioEnd<sourceAudio-0.75))return null;
	const durations=Array.from({length:lastIndex+1},()=>size);
	for(let i=0;i<list.length;i++)durations[first+i]=list[i].duration;
	return {total:lastIndex+1,first,lastIndex,tailSeconds:list[list.length-1].duration,end:declaredEnd,durations};
}
// Build a VOD playlist from real per-segment durations (copy mode). Entries
// are contiguous from segment 0; unproduced segments are never listed, so the
// client timeline is honest. Exported for deterministic tests.
export function vodCopyPlaylist(entries,total,durations) {
	const lines=['#EXTM3U','#EXT-X-VERSION:3','#EXT-X-TARGETDURATION:'+Math.max(4,Math.ceil(Math.max(4,...durations))),'#EXT-X-MEDIA-SEQUENCE:0','#EXT-X-PLAYLIST-TYPE:VOD'];
	let last=-1;
	for(const [index,duration] of entries) {
		if(index!==last+1)break;
		lines.push('#EXTINF:'+Number(duration).toFixed(3)+',','segment'+String(index).padStart(9,'0')+'.ts');
		last=index;
	}
	if(last>=0&&last===total-1)lines.push('#EXT-X-ENDLIST');
	return lines.concat('').join('\n');
}
// A retained VOD window is produced at full encoder speed instead of pinning
// the whole input to -readrate 1. A 120 s run is 30 VOD segments.
const encodeWindowSeconds=120;
// Start the next window once the client has less than this lead. A window is
// 30 segments, so the lead stays below roughly 60 segments (240 s).
const prefetchLeadSegments=30;
// Retain enough completed segments for backward seeks without unbounded disk.
const defaultCacheBytes=256*1024*1024;
// Current-encoder overrun detection. A stale segment from an earlier seek must
// not count, so the file must have been written at or after this encoder
// started. Exported for a deterministic unit test.
export function vodOverrunSegment(entries,{windowStart,windowEnd,startedAt}) {
	let overrun=0;
	for(const entry of entries) {
		const index=Number(entry?.index),mtimeMs=Number(entry?.mtimeMs);
		if(!Number.isFinite(index)||!Number.isFinite(mtimeMs))continue;
		if(index<=windowEnd+2||index<windowStart)continue;
		if(mtimeMs>=startedAt&&index>overrun)overrun=index;
	}
	return overrun;
}
// Per-encoder-generation progress. Prune intentionally removes early segments
// of the current window, which must never rewind produced. Only a file written
// strictly after the current encoder started counts, so stale files from an
// earlier seek or generation (including a last old write sharing the restart
// millisecond) cannot raise or hold progress. The caller keeps the result
// monotonic within a generation; encode() resets it at a generation boundary.
// Exported for a deterministic unit test.
export function vodProgressSegment(entries,{windowStart,startedAt}) {
	let highest=windowStart>=0?windowStart-1:-1;
	for(const entry of entries) {
		const index=Number(entry?.index),mtimeMs=Number(entry?.mtimeMs);
		if(!Number.isFinite(index)||!Number.isFinite(mtimeMs))continue;
		if(index<=highest)continue;
		if(mtimeMs>startedAt)highest=index;
	}
	return highest;
}
// Generation-owned producer progress. The scan captures the generation before
// any IO and discards its result when encode() has moved to a new generation
// while the scan was in flight, so an old async scan can never commit against
// the new window with a colliding start millisecond. Exported with an
// injectable io seam for deterministic race tests.
export async function vodRefreshProduced(job,io) {
	if(!job.directory)return;
	if(job.copyMode&&!job.shiftReady)return;
	const gen=job.generation,startedAt=job.encoderStartedAt;
	const shift=job.copyMode?Number(job.fileShift)||0:0;
	try {
		const entries=[];
		for(const name of await io.readdir(job.directory)) {
			const match=/^segment(\d{9})\.ts$/.exec(name);
			if(!match)continue;
			const index=Number(match[1])-shift;
			if(index<0)continue;
			try{
				const mtimeMs=(await io.stat(path.join(job.directory,name))).mtimeMs;
				if(mtimeMs>startedAt)entries.push({index,mtimeMs});
			}catch{}
		}
		if(job.generation!==gen)return;
		let progress=vodProgressSegment(entries,{windowStart:job.windowStart,startedAt});
		// ffmpeg may emit a tiny tail segment just past a copy window boundary
		// (or past EOF). It belongs to the next window, not this one, and must
		// not advance produced past windowEnd or the next window would skip it.
		if(job.copyMode&&job.windowEnd>=0)progress=Math.min(progress,job.windowEnd);
		job.produced=Math.max(job.produced,progress);
	}catch{}
}
// Bounded cache prune with ownership re-validation. The generation and the
// current requested/windowEnd bounds are re-read after every awaited
// filesystem step and before every destructive one, and the pass abandons when
// encode() has advanced to a new generation. Those late checks cannot cancel a
// deletion that was already dispatched, so createVodPlayer additionally runs
// the entire pass under the job IO gate and serializes every encoder
// transition against it: no prune rm can overlap a new generation's writes.
// Exported with an injectable io seam for deterministic race tests.
export async function vodPrune(job,io,cacheBytes) {
	if(job.stopped||job.pruning||!job.directory)return;
	if(job.copyMode&&!job.shiftReady)return;
	job.pruning=true;
	const gen=job.generation;
	const keepBack=8;
	const windowSpan=Math.max(1,Number(job.windowSegments)||30);
	const shift=job.copyMode?Number(job.fileShift)||0:0;
	try {
		const names=(await io.readdir(job.directory)).filter(name=>/^segment\d{9}\.ts$/.test(name));
		const byIndex=new Map();
		for(const name of names) {
			if(job.stopped||job.generation!==gen)return;
			const index=Number(name.slice(7,16))-shift,file=path.join(job.directory,name);
			if(index<0)continue;
			const requested=job.requested>=0?job.requested:0;
			const windowEnd=job.windowEnd>=0?job.windowEnd:requested+windowSpan-1;
			// Drop far-past and stale future windows first. A future window from
			// an earlier seek must not survive just because it is >= windowStart.
			if(index<requested-keepBack||index>windowEnd){try{await io.rm(file,{force:true});}catch{}continue;}
			let size=0;try{size=(await io.stat(file)).size;}catch{continue;}
			if(job.stopped||job.generation!==gen)return;
			byIndex.set(index,{index,file,size});
		}
		// Priority: the requested segment, then the recent tail, then the
		// nearest lookahead. The byte budget is hard except that one requested
		// segment larger than the budget is still kept rather than re-encoded.
		const requested=job.requested>=0?job.requested:0;
		const windowEnd=job.windowEnd>=0?job.windowEnd:requested+windowSpan-1;
		let bytes=0;const keep=new Set();
		const add=entry=>{keep.add(entry.index);bytes+=entry.size;};
		const current=byIndex.get(requested);if(current)add(current);
		for(let index=requested-1;index>=Math.max(0,requested-keepBack);index--) {
			const entry=byIndex.get(index);if(!entry)continue;
			if(bytes+entry.size<=cacheBytes)add(entry);else{if(job.generation!==gen)return;try{await io.rm(entry.file,{force:true});}catch{}}
		}
		for(let index=requested+1;index<=windowEnd;index++) {
			const entry=byIndex.get(index);if(!entry)continue;
			if(bytes+entry.size<=cacheBytes)add(entry);else{if(job.generation!==gen)return;try{await io.rm(entry.file,{force:true});}catch{}}
		}
		// Caption windows follow the same retention policy; text files are
		// small. Every deletion is awaited inside the gate (and therefore
		// inside the player's IO serialization): a stale caption deletion must
		// never escape the pass and remove a reused filename after a later
		// window has rewritten it.
		const keptCaptions=[];
		for(const entry of job.captionFiles) {
			if(job.stopped||job.generation!==gen)return;
			if(entry.endSegment<requested-keepBack||entry.startSegment>windowEnd){
				try{await io.rm(path.join(job.directory,entry.file),{force:true});}catch{}
			}else keptCaptions.push(entry);
		}
		job.captionFiles=keptCaptions;
	}finally{job.pruning=false;}
}
// Copy tail cleanup. The caller must run this inside the job IO gate and pass
// the immutable generation/window/time values captured at child close. Every
// awaited step rechecks the generation so an old callback can never delete a
// file written by a newer encoder generation.
export async function vodCopyTailCleanup(job,io,{generation,windowEnd,startedAt,shift=0}={}) {
	const removed=[];
	if(!job||job.stopped||job.generation!==generation)return removed;
	let names;
	try{names=await io.readdir(job.directory);}catch{return removed;}
	for(const name of names) {
		if(job.stopped||job.generation!==generation)return removed;
		const match=/^segment(\d{9})\.ts$/.exec(name);
		if(!match)continue;
		const content=Number(match[1])-(Number(shift)||0);
		if(content<=windowEnd)continue;
		const file=path.join(job.directory,name);
		let info;
		try{info=await io.stat(file);}catch{continue;}
		if(job.stopped||job.generation!==generation)return removed;
		if(info.mtimeMs<startedAt)continue;
		try{await io.rm(file,{force:true});removed.push(name);}catch{}
	}
	return removed;
}
export async function vodUpstreamFailure(response) {
	// Dispatcharr's error pages can contain private provider URLs. Inspect only
	// a bounded prefix and return our own message; never forward or log the page.
	const reader=response.body?.getReader();let text='';
	try {
		while(reader&&text.length<8192) {
			const chunk=await reader.read();if(chunk.done)break;
			text+=Buffer.from(chunk.value).toString('utf8').slice(0,8192-text.length);
		}
	}catch{}finally{await reader?.cancel().catch(()=>{});}
	return fail(/ConnectTimeout|connect timeout|ReadTimeout|read timed out/i.test(text)
		?'Dispatcharr could not reach this title’s provider. Please try again later.'
		:'Dispatcharr could not supply video for this title. Please check it in Dispatcharr.');
}
export function vodSubtitleTracks(streams=[]){
	let ordinal=0;
	return streams.filter(s=>s.codec_type==='subtitle').map(s=>({...s,ordinal:ordinal++})).filter(s=>textCodecs.has(s.codec_name)||imageCodecs.has(s.codec_name));
}
export function selectVodSubtitle(options,tracks,external){
	if(Number.isInteger(options.subtitleIndex))return options.subtitleIndex===external?.index?external:tracks.find(s=>s.index===options.subtitleIndex)||null;
	if(options.preferEnglishSubtitles!==true)return null;
	const english=tracks.filter(s=>englishSubtitle(s.tags?.language,s.tags?.title,s.tags?.handler_name));
	return (options.textSubtitles===true?english.find(s=>textCodecs.has(s.codec_name)):null)||english[0]||external;
}
export function vodVideoFilter({offset,subtitle,url}) {
	const base=`scale=w='min(1920,iw)':h=-2,format=yuv420p,fps=25,setpts=PTS+${offset}/TB`;
	if(!subtitle)return ['-vf',base];
	if(imageCodecs.has(subtitle.codec_name))return ['-filter_complex',`[0:v:0][0:${subtitle.index}]overlay,${base}[captioned]`];
	const input=subtitle.file?(subtitle.localName||'captions.srt'):url.replaceAll(':','\\:');
	return ['-vf',base+`,subtitles=filename='${input}'${subtitle.file?'':':si='+subtitle.ordinal}:force_style='FontName=DejaVu Sans,FontSize=20,PrimaryColour=&H00FFFFFF,OutlineColour=&H90000000,BorderStyle=1,Outline=1.5,Shadow=0.5,MarginV=18'`];
}
export function vodManifest(duration,segmentSeconds=4,durations) {
	// Copy mode passes real per-segment durations from the authoritative tail
	// plan. Transcode keeps the established duration-derived grid.
	const list=Array.isArray(durations)&&durations.length&&durations.every(value=>Number.isFinite(value)&&value>0&&value<=86400)?durations:null;
	if(!list&&(!Number.isFinite(duration)||duration<=0||duration>86400))throw fail('This title has no usable duration.');
	const step=Number(segmentSeconds)>0?Number(segmentSeconds):4;
	const target=Math.max(1,Math.ceil(list?Math.max(...list):step));
	const lines=['#EXTM3U','#EXT-X-VERSION:3','#EXT-X-TARGETDURATION:'+target,'#EXT-X-MEDIA-SEQUENCE:0','#EXT-X-PLAYLIST-TYPE:VOD'];
	const count=list?list.length:Math.ceil(duration/step);
	for(let n=0;n<count;n++)lines.push('#EXTINF:'+(list?Number(list[n]):Math.min(step,duration-n*step)).toFixed(3)+',','segment'+String(n).padStart(9,'0')+'.ts');
	return lines.concat('#EXT-X-ENDLIST','').join('\n');
}
export function sniffContainer(bytes) {
	if(bytes.subarray(0,4).equals(Buffer.from([0x1a,0x45,0xdf,0xa3])))return 'matroska';
	if(['ftyp','moov','mdat','free','wide'].includes(bytes.toString('ascii',4,8)))return 'mov';
	if(bytes[0]===0x47&&bytes[188]===0x47)return 'mpegts';
	if(bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='AVI ')return 'avi';
	throw fail('This provider supplied a video format that is not supported yet.');
}

// Bounded keyframe probe for copy segmentation. Reads only the first few
// seconds of the source through the existing loopback proxy; a failure or a
// non-regular GOP makes copy ineligible rather than guessing a 4 s grid.
function keyframeTimes(url,container,{seconds=12,timeout=20000,start=0}={}) {
	return new Promise(resolve=>{
		let done=false,output='';
		const interval=start>0?`${start}%+${seconds}`:`%+${seconds}`;
		const child=spawn('ffprobe',['-v','error','-protocol_whitelist','http,tcp','-f',container,
			'-select_streams','v:0','-skip_frame','nokey','-show_entries','frame=pts_time',
			'-read_intervals',interval,'-of','csv=p=0',url],{stdio:['ignore','pipe','ignore']});
		const finish=value=>{if(done)return;done=true;clearTimeout(timer);resolve(value);};
		const timer=setTimeout(()=>{child.kill('SIGKILL');finish([]);},timeout).unref();
		child.stdout.on('data',chunk=>{if(output.length<262144)output+=chunk;});
		child.on('error',()=>finish([]));
		child.on('close',()=>finish(output.split(/\r?\n/).map(line=>line.trim()).filter(Boolean).map(line=>Number(line.replace(/,$/,'').trim())).filter(Number.isFinite)));
	});
}
// Read the first decoded video timestamp of a completed local segment. Copy
// windows over the loopback HTTP proxy can seek one or two GOPs earlier than
// requested; this lets the player map file numbers back to content indices.
function segmentStartTime(file) {
	return new Promise(resolve=>{
		let done=false,output='';
		const child=spawn('ffprobe',['-v','error','-select_streams','v:0','-show_entries','packet=pts_time','-of','csv=p=0',file],{stdio:['ignore','pipe','ignore']});
		const finish=value=>{if(done)return;done=true;clearTimeout(timer);resolve(value);};
		const timer=setTimeout(()=>{child.kill('SIGKILL');finish(NaN);},10000).unref();
		child.stdout.on('data',chunk=>{if(output.length<200000)output+=chunk;});
		child.on('error',()=>finish(NaN));
		child.on('close',()=>{
			const values=output.split(/\r?\n/).map(line=>line.trim()).filter(Boolean).map(line=>Number(line.replace(/,$/,'').trim())).filter(Number.isFinite);
			finish(values.length?Math.min(...values):NaN);
		});
	});
}
// Last real packet timestamp for a stream selection, read from `start` to EOF.
// Used to prove that the emitted tail carries the source's final packets rather
// than ending at an earlier segment boundary.
function packetEnd(url,container,{start=0,selection='v:0',timeout=20000}={}) {
	return new Promise(resolve=>{
		let done=false,output='';
		const child=spawn('ffprobe',['-v','error','-protocol_whitelist','http,tcp','-f',container,
			'-select_streams',selection,'-show_entries','packet=pts_time','-read_intervals',`${start}%`,'-of','csv=p=0',url],{stdio:['ignore','pipe','ignore']});
		const finish=value=>{if(done)return;done=true;clearTimeout(timer);resolve(value);};
		const timer=setTimeout(()=>{child.kill('SIGKILL');finish(NaN);},timeout).unref();
		child.stdout.on('data',chunk=>{if(output.length<262144)output+=chunk;});
		child.on('error',()=>finish(NaN));
		child.on('close',()=>{
			const values=output.split(/\r?\n/).map(line=>line.trim()).filter(Boolean).map(line=>Number(line.replace(/,$/,'').trim())).filter(Number.isFinite);
			finish(values.length?Math.max(...values):NaN);
		});
	});
}
function segmentEndTimes(file) {
	return new Promise(resolve=>{
		let done=false,output='';
		// CSV packets from both streams; stream_index tells video and audio apart.
		const child=spawn('ffprobe',['-v','error','-show_entries','packet=stream_index,pts_time','-of','csv=p=0',file],{stdio:['ignore','pipe','ignore']});
		const finish=value=>{if(done)return;done=true;clearTimeout(timer);resolve(value);};
		const timer=setTimeout(()=>{child.kill('SIGKILL');finish({});},10000).unref();
		child.stdout.on('data',chunk=>{if(output.length<200000)output+=chunk;});
		child.on('error',()=>finish({}));
		child.on('close',()=>{
			let videoEnd=NaN,audioEnd=NaN;
			for(const line of output.split(/\r?\n/)) {
				const match=/^(\d+),(-?[\d.]+),?$/.exec(line.trim());
				if(!match)continue;
				const index=Number(match[1]),value=Number(match[2]);
				if(!Number.isFinite(value))continue;
				if(index===0)videoEnd=Math.max(Number.isFinite(videoEnd)?videoEnd:value,value);
				else audioEnd=Math.max(Number.isFinite(audioEnd)?audioEnd:value,value);
			}
			finish({videoEnd,audioEnd});
		});
	});
}
export function createVodPlayer({open,close=async()=>{},maxSessions=3,cacheBytes=defaultCacheBytes,deps={}}) {
	// Test seam: deterministic race tests inject controlled filesystem barriers.
	const io={readdir,readFile,stat,rm,...deps};
	const jobs=new Map();let serverPromise;
	// Serialize whole prune passes and encoder transitions. A dispatched rm
	// cannot be cancelled by a late generation check, so an encode must not
	// start a new generation (or its ffmpeg) while any prune rm is in flight.
	// prune never calls encode, and encode never waits for its own ffmpeg while
	// holding the lock, so this cannot deadlock.
	function makeIoGate() {
		let gate=Promise.resolve();
		const withIo=work=>{
			const run=gate.then(work,work);
			gate=run.catch(()=>{});
			return run;
		};
		return {withIo};
	}
	async function internalServer() {
		if(serverPromise)return serverPromise;
		serverPromise=new Promise(resolve=>{
			const server=http.createServer(async(req,res)=>{
				const job=jobs.get(req.url?.slice(1));
				if(!job||job.stopped||!['GET','HEAD'].includes(req.method))return res.writeHead(404).end();
				if(req.headers.range&&!/^bytes=\d*-\d*$/.test(req.headers.range))return res.writeHead(416).end();
				const controller=new AbortController();job.controllers.add(controller);res.on('close',()=>controller.abort());
				try {
					const upstream=await open(job.source,{range:req.headers.range,signal:controller.signal,client:'Tellybox-'+job.token.slice(0,12)});
					if(process.env.VOD_DEBUG==='1')console.error(JSON.stringify({range:req.headers.range,status:upstream.status,contentRange:upstream.headers.get('content-range'),length:upstream.headers.get('content-length')}));
					if(![200,206,416].includes(upstream.status)){await upstream.body?.cancel();return res.writeHead(502).end();}
					res.statusCode=upstream.status;
					for(const key of ['content-type','content-length','content-range','accept-ranges'])if(upstream.headers.has(key))res.setHeader(key,upstream.headers.get(key));
					if(req.method==='HEAD'){await upstream.body?.cancel();return res.end();}
					await pipeline(Readable.fromWeb(upstream.body),res,{signal:controller.signal});
				}catch{if(!res.headersSent)res.writeHead(502);res.end();}
				finally{job.controllers.delete(controller);}
			}).listen(0,'127.0.0.1',()=>{server.unref();resolve(server.address().port);});
		});
		return serverPromise;
	}
	async function start(source,options={}) {
		if(jobs.size>=maxSessions)throw Object.assign(Error('All streamed-film playback slots are busy. Please stop another streamed title and try again.'),{status:503});
		const token=randomBytes(24).toString('hex');source={...source,session:token};
		const job={token,source,controllers:new Set(),subtitleChildren:new Set(),stopped:false,child:null,lastRead:Date.now(),start:-1,queue:Promise.resolve(),
			windowStart:-1,windowEnd:-1,produced:-1,requested:-1,encoding:null,prefetching:false,pruning:false,outTimeUs:0,speed:'',encoderStartedAt:0,generation:0,captionFiles:[],fileShift:0,shiftReady:true,shiftReadyPromise:null,startingWindow:null,copyValidated:new Map(),copyFailure:false,
			// Bounded terminal diagnostics for the current encoder generation.
			// Raw stderr is never exposed; complete lines are redacted once.
			stderr:'',stderrRetention:null,exitCode:null,exitSignal:null,exitGeneration:0,lastFailure:null,...makeIoGate()};
		jobs.set(token,job);
		async function killEncoder(){
			const child=job.child;job.child=null;job.start=-1;
			// A child is dead when it exited normally OR died from a signal;
			// only with both exitCode and signalCode null is it still alive.
			if(!child||child.exitCode!==null||child.signalCode!==null)return;
			child.kill('SIGTERM');await Promise.race([new Promise(r=>child.once('close',r)),new Promise(r=>setTimeout(r,1000))]);
			// Wait for the actual death too: the next generation's startedAt is the
			// ownership boundary for segment files, so no old write may land after
			// it. A signal-closed child (exitCode null, signalCode set) is already
			// dead and must not be SIGKILLed or waited on again.
			if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await Promise.race([new Promise(r=>child.once('close',r)),new Promise(r=>setTimeout(r,2000))]);}
		}
		async function stop(){
			if(job.stopped)return;
			job.stopped=true;clearInterval(job.watchdog);clearInterval(job.cleanup);clearInterval(job.monitor);
			for(const c of job.controllers)c.abort();for(const child of job.subtitleChildren)child.kill('SIGKILL');
			await killEncoder();
			// Wait for any queued prune/encode pass to finish before removing
			// the directory, so no gated task runs against a half-deleted
			// directory and Windows can complete the recursive removal.
			await job.withIo(()=>{}).catch(()=>{});
			await close(token,source);jobs.delete(token);
			if(job.directory)await rm(job.directory,{recursive:true,force:true});
		}
		try {
			const port=await internalServer();job.url=`http://127.0.0.1:${port}/${token}`;
			job.watchdog=setInterval(()=>{if(Date.now()-job.lastRead>120000)void stop();},15000).unref();
			const sampleController=new AbortController();job.controllers.add(sampleController);const timeout=setTimeout(()=>sampleController.abort(),20000);
			let container;
			try{const response=await open(source,{range:'bytes=0-4095',signal:sampleController.signal,client:'Tellybox-'+token.slice(0,12)});if(!response.ok)throw await vodUpstreamFailure(response);const reader=response.body.getReader();const first=await reader.read();await reader.cancel();container=sniffContainer(Buffer.from(first.value||[]));}
			finally{clearTimeout(timeout);job.controllers.delete(sampleController);}
			const info=await new Promise((resolve,reject)=>{
				const child=spawn('ffprobe',['-v','error','-protocol_whitelist','http,tcp','-f',container,'-show_streams','-show_format','-of','json',job.url],{stdio:['ignore','pipe','ignore']});
				let output='';const timer=setTimeout(()=>child.kill('SIGKILL'),30000);
				child.stdout.on('data',chunk=>{if(output.length<200000)output+=chunk;});child.on('error',reject);
				child.on('close',()=>{clearTimeout(timer);try{resolve(JSON.parse(output));}catch{reject(fail('This streamed title could not be inspected. Please try again.'));}});
			});
			const duration=Number(info.format?.duration),audio=(info.streams||[]).filter(s=>s.codec_type==='audio');
			const video=(info.streams||[]).find(s=>s.codec_type==='video');
			const chosen=audio.find(s=>s.index===options.audioIndex)||audio.find(s=>/^en(g)?$/i.test(s.tags?.language||''))||audio[0];
			const subtitleTracks=vodSubtitleTracks(info.streams);
			const missingEnglish=!subtitleTracks.some(s=>englishSubtitle(s.tags?.language,s.tags?.title,s.tags?.handler_name));
			const deferred=options.textSubtitles===true&&missingEnglish&&options.lookupSubtitles?{index:1000000,label:'English · OpenSubtitles',lookup:()=>options.lookupSubtitles(duration)}:null;
			const external=options.externalSubtitle||deferred||(missingEnglish&&options.lookupSubtitles&&wantsSubtitleLookup(options)?await options.lookupSubtitles(duration):null);
			const selectedSubtitle=selectVodSubtitle(options,subtitleTracks,external);
			const nativeCaptions=options.textSubtitles===true?subtitleTracks.filter(s=>textCodecs.has(s.codec_name)):[];
			const subtitle=selectedSubtitle?.lookup||nativeCaptions.includes(selectedSubtitle)?null:selectedSubtitle;
			const quality=[2000000,4000000,8000000,20000000,80000000].includes(options.quality)?options.quality:8000000;
			// A decoder compatibility retry always re-encodes. Otherwise copy only
			// when the source and sanitized client capabilities prove it, and only
			// when no subtitle must be burned in (text sidecars are still fine).
			// An absent copyPlan means "self-probe the actual source" (local Jellyfin
			// seek fallback and the direct provider path). A present but unproven
			// plan (null or invalid) fails closed; provider/worker metadata already
			// made that decision and the player must agree with it.
			const explicitPlan=options.copyPlan!==undefined;
			const planProven=!explicitPlan||(options.copyPlan!==null&&Number(options.copyPlan?.segmentSeconds)>0);
			const wantsCopy=options.compatibility!==true&&planProven&&subtitle===null&&vodCopyEnabled()&&
				vodCopyEligible(video,info.format,{capabilities:options.capabilities,quality,audio:chosen,container});
			let copyMode=false,segmentSeconds=4,copyStart=0;
			if(wantsCopy) {
				let plan=options.copyPlan,firstKeyframes=[];
				if(explicitPlan){
					// The worker probe already proved the whole-title step. Use the
					// same plan; only the first keyframe offset is needed for seeks.
					segmentSeconds=Number(plan.segmentSeconds);
					if(plan.firstKeyframe!==undefined)firstKeyframes=[Number(plan.firstKeyframe)||0];
					else firstKeyframes=await keyframeTimes(job.url,container,{start:0});
					copyMode=true;
				}else{
					// Direct/main VOD has no worker plan. Sample the start, thirds and
					// tail and require the same proven step at every point.
					const uniqueStarts=vodCopySampleStarts(duration);
					const samples=[];
					for(const start of uniqueStarts){
						const times=await keyframeTimes(job.url,container,{start});
						if(start===0)firstKeyframes=times;
						samples.push(vodCopySegmentSeconds(times));
					}
					plan=vodCopyPlan(samples);
					if(plan){copyMode=true;segmentSeconds=plan.segmentSeconds;}
					else if(process.env.VOD_DEBUG==='1')console.error(JSON.stringify({event:'vod_copy_ineligible',reason:'gop',starts:uniqueStarts,samples}));
				}
				if(copyMode){
					// Copy can only split on keyframes. The first keyframe time is
					// the alignment base: seeking to n*step alone can land one GOP
					// early when the source starts at a small positive timestamp.
					copyStart=Math.max(0,Math.min(10,Number(firstKeyframes[0])||0));
					// A normal MPEG-TS mux start offset is ~1.4 s; anything much later
					// means a delayed first decodable frame and copy would drop the
					// opening timeline. Fail closed instead.
					if(copyStart>(container==='mpegts'?1.6:0.5)){
						copyMode=false;copyStart=0;
						console.error(JSON.stringify({event:'vod_copy_ineligible',reason:'first-keyframe',copyStart}));
					}
				}
			}
			// Keep AAC stereo audio untouched; any other audio is converted to
			// AAC stereo (Remux). Copying the video alone is still a Copy.
			job.copyAudio=Boolean(copyMode&&chosen&&String(chosen.codec_name).toLowerCase()==='aac'&&(Number(chosen.channels)||0)<=2);
			job.directory=await mkdtemp(path.join(os.tmpdir(),'tellybox-vod-'));
			// One authoritative total/tail plan for the manifest, window bounds
			// and captions. The plan comes from an actual tail remux probe, never
			// from ceil(format.duration/step): extra audio/container milliseconds
			// belong inside the last real video segment. If the probe cannot prove
			// the tail, copy is not safe and this session starts as Transcode
			// before any playlist is returned. Proven truncation fails closed.
			let playEnd=duration;
			let tailPlan=null;
			if(copyMode){
				const audioArgs=chosen?(job.copyAudio?['-c:a','copy']:['-c:a','aac','-ac','2','-b:a','160k']):[];
				try{tailPlan=await copyTailPlan({step:segmentSeconds,copyStart,chosen,audioArgs,declaredDuration:duration});}
				catch(error){if(error.status)throw error;tailPlan=null;}
				if(tailPlan){playEnd=tailPlan.end;}
				else {
					// A pre-playback compatibility decision: no 409/502 is needed
					// because no playlist or media has been handed to the client.
					copyMode=false;copyStart=0;segmentSeconds=4;
					console.error(JSON.stringify({event:'vod_copy_ineligible',reason:'tail'}));
				}
			}
			job.copyMode=copyMode;job.segmentSeconds=segmentSeconds;job.copyStart=copyStart;
			job.windowSegments=Math.max(1,Math.ceil(encodeWindowSeconds/segmentSeconds));
			if(copyMode){
				job.total=tailPlan.total;
				job.segmentDurations=tailPlan.durations;
				job.planEnd=tailPlan.end;job.tailSeconds=tailPlan.tailSeconds;job.lastIndex=tailPlan.lastIndex;
			}else{
				job.total=Math.ceil(duration/segmentSeconds);
				job.segmentDurations=Array.from({length:job.total},(_,i)=>i===job.total-1?Math.max(0.001,duration-i*segmentSeconds):segmentSeconds);
				job.planEnd=duration;
			}
			const method=copyMode?(chosen?(job.copyAudio?'Copy':'Remux'):'Copy'):'Transcode';
			job.method=method;
			const manifest=vodManifest(copyMode?job.planEnd:duration,segmentSeconds,copyMode?job.segmentDurations:null);
			if(copyMode)console.error(JSON.stringify({event:'vod_copy_selected',videoCodec:video?.codec_name||'',profile:video?.profile||'',level:Number(video?.level)||0,segmentSeconds,copyAudio:job.copyAudio,total:job.total,tailSeconds:job.tailSeconds}));
			if(subtitle?.file)await copyFile(subtitle.file,path.join(job.directory,'captions.srt'));
			job.cleanup=setInterval(()=>void prune(),3000).unref();
			// If a worker ffmpeg ignores the absolute -t end, fail safe instead
			// of encoding the rest of the film into the bound.
			job.monitor=setInterval(()=>void guardOverrun(),2000).unref();
			// libass scans its entire input before rendering. Never give it a remote
			// full-length film: extract a short caption window, then render that file.
			const windowedSubtitle=subtitle&&!subtitle.file&&textCodecs.has(subtitle.codec_name);
			const captionSeconds=32,captionWindows=new Map();
			function captionWindow(offset) {
				if(captionWindows.has(offset))return captionWindows.get(offset);
				const pending=(async()=>{
					if(job.stopped)throw fail('Playback expired.');
					const start=Math.max(0,offset-20),length=Math.min(playEnd,offset+captionSeconds+10)-start;
					const localName=`embedded-${offset}.ass`,clip=path.join(job.directory,`caption-window-${offset}.mkv`);
					async function extract(args,capture=false) {
						return new Promise((resolve,reject)=>{
							const child=spawn('ffmpeg',['-v','error',...args],{stdio:['ignore',capture?'pipe':'ignore','ignore']});
							job.subtitleChildren.add(child);const chunks=[];let bytes=0,limited=false;
							const timeout=setTimeout(()=>{limited=true;child.kill('SIGKILL');},20000);
							child.stdout?.on('data',chunk=>{bytes+=chunk.length;if(bytes>2*1024*1024){limited=true;child.kill('SIGKILL');}else chunks.push(chunk);});
							child.on('error',reject);
							child.on('close',code=>{clearTimeout(timeout);job.subtitleChildren.delete(child);if(code!==0||limited||job.stopped)reject(fail('English subtitles could not be prepared. Try subtitles Off to keep watching.'));else resolve(Buffer.concat(chunks));});
						});
					}
					let data;
					try {
						// Include video packets while cutting: subtitle-only demuxing can
						// scan a whole film when captions are sparse or start much later.
						await extract(['-copyts','-ss',String(start),'-protocol_whitelist','http,tcp','-f',container,'-i',job.url,
							'-map','0:v:0','-map',`0:${subtitle.index}`,'-an','-c','copy','-to',String(start+length),'-avoid_negative_ts','disabled','-fs','268435456','-f','matroska',clip]);
						if(job.stopped)throw fail('Playback expired.');
						if((await stat(clip)).size>=268435456)throw fail('This subtitle track is too large to prepare. Try subtitles Off to keep watching.');
						data=await extract(['-copyts','-i',clip,'-map','0:s:0','-c:s','ass','-f','ass','pipe:1'],true);
					}finally{await rm(clip,{force:true});}
					if(job.stopped)throw fail('Playback expired.');
					await writeFile(path.join(job.directory,localName),data);
					return {...subtitle,file:true,localName};
				})();
				captionWindows.set(offset,pending);
				pending.catch(()=>captionWindows.delete(offset));
				return pending;
			}
			async function prune(){if(job.pruning)return;await job.withIo(()=>vodPrune(job,io,cacheBytes));}
			async function guardOverrun() {
				if(job.stopped||job.windowEnd<0||!job.directory)return;
				if(job.copyMode&&!job.shiftReady)return;
				const child=job.child;
				if(!child||child.exitCode!==null)return;
				// Ignore stale files from an earlier seek: only a segment written
				// after this encoder started proves that -t is being ignored.
				const entries=[],shift=job.copyMode?Number(job.fileShift)||0:0;
				try {
					for(const name of await io.readdir(job.directory)) {
						const match=/^segment(\d{9})\.ts$/.exec(name);if(!match)continue;
						const index=Number(match[1])-shift;if(index<0)continue;
						try{const info=await io.stat(path.join(job.directory,name));entries.push({index,mtimeMs:info.mtimeMs});}catch{}
					}
				}catch{}
				const overrun=vodOverrunSegment(entries,{windowStart:job.windowStart,windowEnd:job.windowEnd,startedAt:job.encoderStartedAt});
				if(!overrun)return;
				job.child=null;job.start=-1;
				console.error(JSON.stringify({event:'vod_encoder_overrun',produced:overrun,windowEnd:job.windowEnd}));
				child.kill('SIGTERM');
				setTimeout(()=>{if(child.exitCode===null)child.kill('SIGKILL');},1000).unref();
			}
			// Completed files, not wall-clock time, are the producer truth, and
			// progress is monotonic within one encoder generation. Prune removes
			// early segments on purpose; a missing early file must not rewind
			// produced, and stale files from an earlier seek must not raise it.
			// encode() resets produced at each generation boundary.
			async function refreshProduced(){await vodRefreshProduced(job,io);}
			function runEncode(n) {
				const previous=job.encoding||Promise.resolve();
				const current=previous.then(()=>encode(n));
				const tracked=current.catch(()=>{}).finally(()=>{if(job.encoding===tracked)job.encoding=null;});
				job.encoding=tracked;
				return current;
			}
			// Keep one bounded run ahead when the client approaches its edge. This
			// is demand-driven: a paused or slow client cannot make the worker read
			// the whole provider file.
			async function maybePrefetch() {
				if(job.stopped||job.copyFailure||job.encoding||job.prefetching||job.requested<0)return;
				job.prefetching=true;
				try {
					if(job.copyMode&&job.shiftReadyPromise)await job.shiftReadyPromise.catch(()=>{});
					await refreshProduced();
					if(job.produced<job.windowStart)return;
					if(job.produced-job.requested>=prefetchLeadSegments)return;
					if(job.child&&job.child.exitCode===null)return;
					const next=Math.max(job.windowEnd,job.produced)+1,total=job.total;
					if(!Number.isFinite(next)||next<0||next>=total)return;
					void runEncode(next).catch(()=>{});
				}finally{job.prefetching=false;}
			}
			function runCopyProbe(args,timeout=30000) {
				return new Promise(resolve=>{
					let done=false;
					const retention=createEncoderDiagnosticRetention({limit:4096});
					const child=spawn('ffmpeg',args,{stdio:['ignore','ignore','pipe']});
					const finish=value=>{if(done)return;done=true;clearTimeout(timer);resolve(value);};
					const timer=setTimeout(()=>{child.kill('SIGKILL');finish(-1);},timeout).unref();
					child.stderr.on('data',chunk=>retention.push(chunk));
					child.on('error',()=>finish(-1));
					child.on('close',code=>{
						if(code!==0&&process.env.VOD_DEBUG==='1'){
							const diagnostic=sanitizeEncoderDiagnostics(retention.flush(),{exitCode:code,limitLines:4,limitChars:600});
							console.error(JSON.stringify({event:'vod_copy_probe_error',code,category:diagnostic.category,failureCode:diagnostic.code}));
						}
						finish(code);
					});
				});
			}
			// Copy can only start on a keyframe, and the loopback HTTP proxy may seek
			// one or two GOPs earlier than requested. Probe a short copy run with the
			// same seek and absolute offset, then derive the real content index from
			// its first PTS. One extra short read per new window; no restart or index
			// remapping is needed.
			async function copyStartIndex(n,step) {
				if(!(n>0))return 0;
				const id=randomBytes(4).toString('hex'),playlist=path.join(job.directory,`copy-probe-${id}.m3u8`);
				const firstFile=path.join(job.directory,`copy-probe-${id}000000000.ts`);
				try {
					const probeArgs=['-hide_banner','-loglevel','error','-ss',String(n*step+job.copyStart),
						'-protocol_whitelist','http,tcp','-f',container,'-i',job.url,'-map','0:v:0','-an','-sn','-dn','-c:v','copy',
						'-output_ts_offset',String(n*step),'-muxdelay','0','-muxpreload','0','-t',String(step*3),
						'-f','hls','-hls_time',String(step),'-hls_list_size','0','-start_number','0','-hls_flags','temp_file',
						'-hls_segment_filename',path.join(job.directory,`copy-probe-${id}%09d.ts`),playlist];
					const code=await runCopyProbe(probeArgs);
					if(code!==0)return null;
					const probeSize=(await io.stat(firstFile).catch(()=>null))?.size||0;
					const pts=await segmentStartTime(firstFile);
					if(process.env.VOD_DEBUG==='1')console.error(JSON.stringify({event:'vod_copy_probe',n,step,code,pts,probeSize}));
					if(!Number.isFinite(pts))return null;
					return Math.max(0,Math.min(n,Math.round(pts/step)));
				}catch{return null;}
				finally{
					for(const name of await io.readdir(job.directory).catch(()=>[]))if(name.startsWith(`copy-probe-${id}`))await rm(path.join(job.directory,name),{force:true}).catch(()=>{});
				}
			}
			// Real segment duration, used only when the HLS playlist has not yet
			// listed a just-completed cached file. The playlist path is cheaper and
			// is the primary source of truth.
			function segmentDuration(file) {
				return new Promise(resolve=>{
					let done=false,output='';
					const child=spawn('ffprobe',['-v','error','-show_entries','format=duration','-of','csv=p=0',file],{stdio:['ignore','pipe','ignore']});
					const finish=value=>{if(done)return;done=true;clearTimeout(timer);resolve(value);};
					const timer=setTimeout(()=>{child.kill('SIGKILL');finish(NaN);},10000).unref();
					child.stdout.on('data',chunk=>{if(output.length<1024)output+=chunk;});
					child.on('error',()=>finish(NaN));
					child.on('close',()=>finish(Number(String(output).trim())));
				});
			}
			// Actual tail remux probe. Seeks just before the declared end, copies
			// video (and the selected audio) to EOF with the same arguments as the
			// final playback window, and measures every emitted file. The last real
			// video keyframe boundary and the final file's real duration become the
			// authoritative total/tail. A short genuine tail is preserved; a tail
			// that cannot be proven rejects the copy plan (null), and a provably
			// truncated source fails closed instead of finishing early as success.
			async function copyTailPlan({step,copyStart,chosen,audioArgs,declaredDuration}) {
				if(!(Number(declaredDuration)>0)||Number(declaredDuration)>86400)return null;
				const requested=Math.max(0,Math.round((Math.max(0,Number(declaredDuration)-step*2)-copyStart)/step));
				const scanStart=Math.max(0,requested*step+copyStart);
				const id=randomBytes(4).toString('hex'),prefix=`tail-probe-${id}`;
				const playlist=path.join(job.directory,`${prefix}.m3u8`);
				const pattern=new RegExp(`^${prefix}(\\d{9})\\.ts$`);
				// Bound the end-packet scan so a source that stops early is still
				// measured rather than silently seeing no packets.
				const endScanStart=Math.min(scanStart,Math.max(0,Number(declaredDuration)-60));
				try {
					const [sourceVideoEnd,sourceAudioEnd]=await Promise.all([
						packetEnd(job.url,container,{start:endScanStart,selection:'v:0'}),
						packetEnd(job.url,container,{start:endScanStart,selection:'a'})
					]);
					// A subtitle-only cue or an unselected stream can extend the
					// container duration; that never creates video segments. A large
					// unexplained gap means the final media packets are actually
					// missing and must be surfaced, not served as a successful end.
					const subtitleEnd=(info.streams||[]).filter(s=>s.codec_type==='subtitle')
						.reduce((max,s)=>Math.max(max,Number(s.duration)||0),0);
					const explained=Math.max(sourceVideoEnd||0,sourceAudioEnd||0,subtitleEnd);
					if(declaredDuration-explained>Math.max(1.5,step*0.75)){
						throw Object.assign(Error('This title ended unexpectedly. Please try again.'),{status:502});
					}
					const args=['-hide_banner','-loglevel','error','-ss',String(scanStart),
						'-protocol_whitelist','http,tcp','-f',container,'-i',job.url,
						'-map','0:v:0','-map',chosen?`0:${chosen.index}`:'0:a:0?','-sn','-dn','-c:v','copy',...audioArgs,
						'-output_ts_offset',String(requested*step),'-muxdelay','0','-muxpreload','0',
						'-max_muxing_queue_size','2048','-f','hls','-hls_time',String(step),'-hls_list_size','0',
						'-start_number',String(requested),'-hls_flags','temp_file',
						'-hls_segment_filename',path.join(job.directory,`${prefix}%09d.ts`),playlist];
					const code=await runCopyProbe(args,120000);
					if(code!==0)return null;
					const files=(await io.readdir(job.directory))
						.map(name=>({name,index:Number(pattern.exec(name)?.[1])}))
						.filter(entry=>Number.isFinite(entry.index))
						.sort((a,b)=>a.index-b.index);
					if(!files.length)return null;
					const segments=[];
					for(let i=0;i<files.length;i++){
						const file=path.join(job.directory,files[i].name);
						const segment={duration:await segmentDuration(file)};
						if(i===0)segment.firstPts=await segmentStartTime(file);
						if(i===files.length-1)Object.assign(segment,await segmentEndTimes(file));
						segments.push(segment);
					}
					const plan=vodCopyTailPlan({segments,step,sourceVideoEnd,sourceAudioEnd});
					if(plan&&process.env.VOD_DEBUG==='1')console.error(JSON.stringify({event:'vod_copy_tail',requested,step,count:files.length,first:plan.first,last:plan.lastIndex,total:plan.total,tailSeconds:plan.tailSeconds}));
					if(!plan&&process.env.VOD_DEBUG==='1')console.error(JSON.stringify({event:'vod_copy_tail_rejected',requested,step,segments,sourceVideoEnd,sourceAudioEnd,declaredDuration}));
					return plan;
				}finally{
					for(const name of await io.readdir(job.directory).catch(()=>[]))if(name.startsWith(prefix))await rm(path.join(job.directory,name),{force:true}).catch(()=>{});
				}
			}
			async function copyPlaylistDurations() {
				const map=new Map();
				try {
					const text=await io.readFile(path.join(job.directory,'generated.m3u8'),'utf8');
					let duration=null;
					for(const line of text.split(/\r?\n/)) {
						const info=/^#EXTINF:([\d.]+)/.exec(line);
						if(info){duration=Number(info[1]);continue;}
						const file=/^segment(\d{9})\.ts$/.exec(line);
						if(file&&duration!==null){map.set(Number(file[1]),duration);duration=null;}
					}
				}catch{}
				return map;
			}
			function copyDurationValid(index,duration,step) {
				if(!Number.isFinite(duration))return false;
				// The authoritative plan carries the real emitted duration of every
				// keyframe split, including a genuinely short final tail.
				const expected=Number(job.segmentDurations?.[index]);
				if(Number.isFinite(expected)&&expected>0)return Math.abs(duration-expected)<=0.5;
				// A title-final segment may legitimately be shorter than the grid.
				if(index===job.total-1)return duration<=step+0.5;
				return Math.abs(duration-step)<=0.25;
			}
			async function failCopy(from) {
				if(job.copyFailure)return;
				job.copyFailure=true;job.copyMode=false;job.method='Transcode';job.videoCodec='h264';
				console.error(JSON.stringify({event:'vod_copy_grid_mismatch',from}));
				// Stop the producer. Never switch codecs inside the same HLS
				// session: the request that hit the mismatch gets a 409
				// VOD_COMPATIBILITY_REQUIRED and the client performs the existing
				// one-shot compatibility replacement at its current position. The
				// old session/files are cleaned when the replacement stops it.
				await killEncoder();
			}
			async function validateCopySegment(index,file) {
				if(!job.copyMode)return !job.copyFailure;
				let info;
				try{info=await io.stat(file);}catch{return false;}
				if(job.copyValidated.get(index)===info.mtimeMs)return job.copyMode;
				// The file duration is authoritative. The playlist may still be the
				// previous window's and can advertise 2 s for a just-written 10 s file.
				const duration=await segmentDuration(file);
				if(!copyDurationValid(index,duration,job.segmentSeconds)){await failCopy(index);return false;}
				job.copyValidated.set(index,info.mtimeMs);
				return job.copyMode;
			}
			async function encode(n) {
				// A prefetch and a client request can target the same next window.
				// Never let the second setup kill the first encoder mid-probe.
				if(job.copyMode&&(job.startingWindow===n||(job.child&&job.child.exitCode===null&&job.windowStart>=0&&n>=job.windowStart&&n<=job.windowEnd)))return;
				job.startingWindow=n;
				try {
				await killEncoder();
				// A dispatched prune rm cannot be cancelled by a late generation
				// check, so the whole encoder transition runs under the IO gate:
				// no prune deletion is in flight when the new generation starts,
				// and the gate is held until the new ffmpeg is spawned (the first
				// new segment cannot exist before then). prune never calls encode
				// and this never waits for the new ffmpeg while holding the gate.
				return job.withIo(async()=>{
					job.generation+=1;
					// Keep completed segments for backward seeks and for the next
					// window. Only the old rolling playlist and partial files are
					// removed.
					for(const file of await io.readdir(job.directory))if(/^segment\d+\.ts\.tmp$|^generated\.m3u8(?:\.tmp)?$/.test(file))await io.rm(path.join(job.directory,file),{force:true});
					if(job.stopped)throw fail('Playback expired.');
					const step=job.segmentSeconds;
					let first=n,seekOffset=n*step,tsOffset=n*step,window,windowEnd;
					if(job.copyMode) {
						// Ask the probe where the copy seek really started, then number the
						// first produced file with that content index. The output timestamp
						// offset stays at n*step, so the first file's PTS is a*step and the
						// playlist/numbering/timestamps all agree.
						const probed=await copyStartIndex(n,step);
						if(probed===null){
							// A copy probe that cannot prove the keyframe/time mapping is
							// a compatibility failure, not a reason to switch codecs inside
							// this session.
							job.copyFailure=true;job.copyMode=false;job.method='Transcode';job.videoCodec='h264';
							console.error(JSON.stringify({event:'vod_copy_probe_failed',segment:n}));
							throw compatibilityRequired();
						}else{
							first=probed;
							const span=Math.ceil((windowedSubtitle?captionSeconds:encodeWindowSeconds)/step);
							windowEnd=Math.min(job.total-1,n+span-1);
							const remaining=playEnd-first*step;
							if(!(remaining>0))throw Object.assign(Error('Invalid segment.'),{status:404});
							// The final window must never cut the proven tail: ask for a
							// bounded extra second so ffmpeg reaches EOF and emits the real
							// last segment; EOF (not -t) stops it.
							const finalWindow=windowEnd===job.total-1;
							window=Math.min(remaining+(finalWindow?1:0),(windowEnd-first+1)*step+(finalWindow?1:0));
							seekOffset=n*step+job.copyStart;
							tsOffset=n*step;
						}
					}
					if(!job.copyMode) {
						seekOffset=n*step;
						const remaining=playEnd-seekOffset;
						if(!(remaining>0))throw Object.assign(Error('Invalid segment.'),{status:404});
						// Embedded caption windows are their own bound. Otherwise produce a
						// fixed run at full speed; the lead cap above starts the next run.
						window=Math.min(remaining,windowedSubtitle?captionSeconds:encodeWindowSeconds);
						windowEnd=n+Math.ceil(window/step)-1;
					}
					// Publish the new window ownership and the ownership timestamp
					// before any long await, so prune and progress scans see one
					// consistent generation, and before any new file can exist (the
					// old encoder is already fully dead).
					job.start=n;job.windowStart=first;job.windowEnd=windowEnd;job.produced=first-1;job.encoderStartedAt=Date.now();
					job.fileShift=0;job.shiftReady=true;job.shiftReadyPromise=null;
					if(job.copyMode)for(let index=first;index<=windowEnd;index++)job.copyValidated.delete(index);
					if(job.copyMode&&process.env.VOD_DEBUG==='1')console.error(JSON.stringify({event:'vod_copy_window',requested:n,first,seekOffset,tsOffset,window,windowEnd}));
					const renderSubtitle=windowedSubtitle?await captionWindow(seekOffset):subtitle;
					if(job.stopped)throw fail('Playback expired.');
					let args;
					if(job.copyMode) {
						// Video packets are copied unchanged. Audio is copied only when
						// it is already AAC stereo; otherwise it is converted to AAC
						// stereo (the audio-only conversion half of the remux). The
						// output timestamp offset keeps every window on the title's
						// absolute timeline, so seeks and window boundaries do not
						// rebase PTS to zero.
						const audioArgs=chosen?(job.copyAudio?['-c:a','copy']:['-c:a','aac','-ac','2','-b:a','160k']):[];
						args=['-hide_banner','-loglevel','error','-progress','pipe:2','-nostats','-ss',String(seekOffset),'-protocol_whitelist','http,tcp','-f',container,'-i',job.url,
							'-map','0:v:0','-map',chosen?`0:${chosen.index}`:'0:a:0?','-sn','-dn','-c:v','copy',...audioArgs,
							'-output_ts_offset',String(tsOffset),'-muxdelay','0','-muxpreload','0','-t',String(window),'-max_muxing_queue_size','2048','-f','hls','-hls_time',String(step),'-hls_list_size','0',
							'-start_number',String(first),'-hls_flags','temp_file','-hls_segment_filename','segment%09d.ts','generated.m3u8'];
					}else{
						args=['-hide_banner','-loglevel','error','-progress','pipe:2','-nostats','-ss',String(seekOffset),'-protocol_whitelist','http,tcp','-f',container,'-i',job.url,
							'-map',imageCodecs.has(subtitle?.codec_name)?'[captioned]':'0:v:0','-map',chosen?`0:${chosen.index}`:'0:a:0?','-sn','-dn','-c:v','libx264','-preset',vodPreset(),'-threads','2','-crf','23','-maxrate',String(quality),'-bufsize',String(quality*2),
							...vodVideoFilter({offset:seekOffset,subtitle:renderSubtitle,url:job.url}),'-fps_mode','passthrough','-g',String(step*25),'-keyint_min',String(step*25),'-sc_threshold','0',
							'-c:a','aac','-ac','2','-b:a','160k','-af',`asetpts=PTS+${seekOffset}/TB`,'-t',String(seekOffset+window),'-max_muxing_queue_size','2048','-f','hls','-hls_time',String(step),'-hls_list_size','0',
							'-start_number',String(first),'-hls_flags','temp_file','-hls_segment_filename','segment%09d.ts','generated.m3u8'];
					}
					for(const track of nativeCaptions) {
						// Keep the first window at the compatibility name; later windows are
						// keyed by offset so a later window cannot overwrite earlier cues.
						const captionName=first===0?`captions-${track.index}.vtt`:`captions-${track.index}-${tsOffset}.vtt`;
						const existing=job.captionFiles.find(entry=>entry.track===track.index&&entry.startSegment===first);
						if(existing){existing.endSegment=windowEnd;existing.file=captionName;}
						else job.captionFiles.push({track:track.index,startSegment:first,endSegment:windowEnd,file:captionName});
						// Output options apply to the next output only. Without this -t the
						// WebVTT output would read to the end of the title after the HLS
						// output has stopped at the window boundary.
						// This output has no setpts shift, so -t is a duration relative to
						// the input seek. The HLS output above uses absolute PTS instead.
						args.push('-map',`0:${track.index}`,'-c:s','webvtt','-output_ts_offset',String(tsOffset),'-t',String(window),'-flush_packets','1','-f','webvtt','-y',captionName);
					}
					const child=job.child=spawn('ffmpeg',args,{cwd:job.directory,stdio:['ignore','ignore','pipe']});
					// New generation: old terminal state must never describe this
					// encoder. Only complete lines are redacted and retained.
					job.stderr='';job.stderrRetention=createEncoderDiagnosticRetention();job.exitCode=null;job.exitSignal=null;job.exitGeneration=job.generation;job.lastFailure=null;
					child.__vodGeneration=job.generation;
					child.stderr.on('data',chunk=>{
						// A stale child's late data must never mutate a newer producer.
						if(job.stopped||job.child!==child||child.__vodGeneration!==job.generation)return;
						const text=chunk.toString('utf8');
						job.stderrRetention.push(text);
						for(const line of text.split(/\r?\n/)) {
							const field=/^(out_time_us|speed|progress)=(.*)$/.exec(line);
							if(field) {
								if(field[1]==='out_time_us')job.outTimeUs=Number(field[2])||0;
								else if(field[1]==='speed')job.speed=field[2].trim();
							}
							// Raw stderr is never logged, even under VOD_DEBUG. The
							// bounded failure category below is the diagnostic record.
						}
					});
					child.on('error',()=>{
						if(job.stopped||job.child!==child||child.__vodGeneration!==job.generation)return;
						// A spawn error is a terminal current-generation failure, not a
						// reason for an old child to stop a replacement producer.
						job.stderr=job.stderrRetention.flush();
						job.exitCode=null;job.exitSignal=null;job.exitGeneration=job.generation;
						job.lastFailure={...sanitizeEncoderDiagnostics(job.stderr,{exitCode:1}),code:'VOD_ENCODER_EXIT',
							generation:job.generation,produced:job.produced,requested:job.requested,
							windowStart:job.windowStart,windowEnd:job.windowEnd,at:Date.now()};
						void stop();
					});
					child.on('close',(code,signal)=>{
						if(job.child!==child||child.__vodGeneration!==job.generation)return;
						// Retain the real terminal state for the current generation.
						// Sanitized classification is recorded even without VOD_DEBUG.
						job.stderr=job.stderrRetention.flush();
						job.exitCode=Number.isInteger(code)?code:null;
						job.exitSignal=signal||null;
						job.exitGeneration=job.generation;
						if((job.exitCode!==null&&job.exitCode!==0)||job.exitSignal){
							job.lastFailure={...encoderFailureFrom(job.stderr,job.exitCode,job.exitSignal),
								generation:job.generation,produced:job.produced,requested:job.requested,
								windowStart:job.windowStart,windowEnd:job.windowEnd,at:Date.now()};
						}
						const generation=job.generation,windowEnd=job.windowEnd,startedAt=job.encoderStartedAt,shift=job.fileShift;
						void job.withIo(async()=>{
							if(job.stopped||job.generation!==generation||job.child!==child)return;
							// The whole destructive tail pass is inside the IO gate and
							// carries the captured generation/window/time. encode() also
							// holds the gate while publishing a new generation, so an old
							// callback can never delete the new encoder's tail segment.
							if(job.copyMode)await vodCopyTailCleanup(job,io,{generation,windowEnd,startedAt,shift});
							if(job.stopped||job.generation!==generation)return;
							await refreshProduced();
							if(job.produced>=windowEnd)void maybePrefetch();
						}).catch(()=>{});
					});
				});
				} finally {
					if(job.startingWindow===n)job.startingWindow=null;
				}
			}
			async function chunk(n) {
				if(n<0||n>=job.total)throw Object.assign(Error('Invalid segment.'),{status:404});
				if(job.copyFailure)throw compatibilityRequired();
				job.requested=n;
				if(job.copyMode&&job.shiftReadyPromise)await job.shiftReadyPromise.catch(()=>{});
				const fileFor=index=>path.join(job.directory,'segment'+String(index+(job.copyMode?Number(job.fileShift)||0:0)).padStart(9,'0')+'.ts');
				// A cached segment (including one retained from an earlier window or
				// seek) is valid to serve, but it is not current-encoder progress:
				// produced is owned by the encoder generation via refreshProduced.
				// Copy windows can emit a tiny tail segment at windowEnd+1; it is not
				// a complete boundary segment and must never satisfy a request for the
				// next window, or the client would receive a 0.08 s segment and the
				// real window would never start.
				const available=async()=>{
					if(job.copyFailure)throw compatibilityRequired();
					let bytes;
					try{
						const file=fileFor(n);
						if(job.copyMode&&job.windowStart>=0&&n===job.windowEnd+1){
							const info=await io.stat(file);
							if(info.mtimeMs>=job.encoderStartedAt)return null;
						}
						bytes=await io.readFile(file);
					}catch{return null;}
					if(bytes.length){
						if(job.copyFailure)throw compatibilityRequired();
						if(job.copyMode&&!(await validateCopySegment(n,fileFor(n))))throw compatibilityRequired();
						void maybePrefetch();return bytes;
					}
					return null;
				};
				const first=await available();if(first)return first;
				if(job.copyFailure)throw compatibilityRequired();
				if(job.encoding)await job.encoding;
				const second=await available();if(second)return second;
				if(job.copyFailure)throw compatibilityRequired();
				await refreshProduced();
				const inWindow=n>=job.windowStart&&n<=job.windowEnd;
				const alive=job.child&&job.child.exitCode===null;
				// Restart on actual window bounds, not on a wall-clock estimate of
				// where a 0.9x producer should have reached. A copy failure is not
				// repaired in this session; it is a compatibility replacement.
				if(!inWindow||!alive)await runEncode(n);
				// The wait is bounded by no-progress, not by a fixed total: a slow
				// but progressing producer (below 1x on a busy worker) can
				// legitimately take longer than 45 s to reach a mid-window segment,
				// and an in-flight read is client activity for the no-read
				// watchdog. Stalls only when 45 s pass with no completed segment,
				// capped in total so a near-dead producer cannot hold the read.
				const hardDeadline=Date.now()+240000;
				let deadline=Date.now()+45000,ticks=0;
				// Current-generation terminal state only. A close callback from an
				// older child returns early, and a new spawn resets these fields, so
				// an old error can never fail a newer window.
				const exitState=()=>{
					const child=job.child;
					if(child&&(child.exitCode!==null||child.signalCode!==null))return {code:child.exitCode,signal:child.signalCode};
					if(!child&&job.exitGeneration===job.generation&&(job.exitCode!==null||job.exitSignal))return {code:job.exitCode,signal:job.exitSignal};
					return null;
				};
				while(!job.stopped&&Date.now()<deadline&&Date.now()<hardDeadline) {
					if(job.copyFailure)throw compatibilityRequired();
					const bytes=await available();if(bytes){await refreshProduced();return bytes;}
					const exited=exitState();
					if(exited&&job.produced<n)break;
					job.lastRead=Date.now();
					if(ticks--<=0){
						ticks=8;
						const before=job.produced;
						await refreshProduced();
						if(job.produced>before)deadline=Math.max(deadline,Date.now()+45000);
					}
					await new Promise(r=>setTimeout(r,120));
				}
				// Bounded diagnostics only: no URLs, tokens or provider payloads.
				const exited=exitState();
				if(exited&&job.produced<n){
					// A close event can race the final file rename by one poll; never
					// declare a terminal failure while a real requested segment exists.
					const late=await available();
					if(late){await refreshProduced();return late;}
				}
				const recorded=job.lastFailure&&job.lastFailure.generation===job.generation?job.lastFailure:null;
				const terminal=Boolean(exited&&((exited.code!==null&&exited.code!==0)||exited.signal)&&job.produced<n);
				if(terminal){
					if(job.exitCode===null&&exited.code!==null)job.exitCode=exited.code;
					if(!job.exitSignal&&exited.signal)job.exitSignal=exited.signal;
					job.exitGeneration=job.generation;
					job.stderr=job.stderrRetention?job.stderrRetention.flush():job.stderr;
					const failure=recorded||{...encoderFailureFrom(job.stderr,exited.code??undefined,exited.signal||undefined),
						generation:job.generation,produced:job.produced,requested:job.requested,windowStart:job.windowStart,windowEnd:job.windowEnd,at:Date.now()};
					job.lastFailure=failure;
					console.error(JSON.stringify({event:'vod_producer_stall',segment:n,produced:job.produced,windowStart:job.windowStart,windowEnd:job.windowEnd,speed:job.speed,
						childExit:exited.code??null,childSignal:exited.signal||null,encoding:Boolean(job.encoding),
						failureCategory:failure.category,failureCode:failure.code}));
					throw encoderExit(encoderFailureMessage(failure));
				}
				if(exited&&exited.code===0&&job.produced<n){
					// A clean exit that still did not produce the requested part is not
					// a provider stall and not a crash. Report the missing output
					// honestly instead of reusing the stall message or restarting a
					// dead child forever.
					job.lastFailure={category:'unknown',code:'VOD_SEGMENT_MISSING',summary:'The encoder finished without producing the requested segment.',
						userSummary:'The relay finished without producing this part of the stream. Try again or choose another quality.',
						generation:job.generation,produced:job.produced,requested:job.requested,windowStart:job.windowStart,windowEnd:job.windowEnd,exitCode:0,at:Date.now()};
					console.error(JSON.stringify({event:'vod_producer_missing_segment',segment:n,produced:job.produced,windowStart:job.windowStart,windowEnd:job.windowEnd,
						childExit:0,encoding:Boolean(job.encoding),failureCategory:'unknown',failureCode:'VOD_SEGMENT_MISSING'}));
					throw Object.assign(fail('The relay finished without producing this part of the stream. Try again or choose another quality.'),{status:502,code:'VOD_SEGMENT_MISSING'});
				}
				console.error(JSON.stringify({event:'vod_producer_stall',segment:n,produced:job.produced,windowStart:job.windowStart,windowEnd:job.windowEnd,speed:job.speed,
					childExit:exited?.code??job.child?.exitCode??null,encoding:Boolean(job.encoding),
					failureCategory:recorded?.category,failureCode:recorded?.code}));
				throw Object.assign(fail('The provider stream stalled. Try playing again.'),{code:'VOD_PRODUCER_STALL'});
			}
			return {stop,touch:()=>{job.lastRead=Date.now();},duration:playEnd,get method(){return job.method;},get videoCodec(){return job.copyMode?(video?.codec_name||''):'h264';},get audioCodec(){return chosen?'aac':'';},
				producer:()=>({produced:job.produced,requested:job.requested,windowStart:job.windowStart,windowEnd:job.windowEnd,speed:job.speed,outTimeUs:job.outTimeUs,copy:job.copyMode,segmentSeconds:job.segmentSeconds,total:job.total,planEnd:job.planEnd,tailSeconds:job.tailSeconds??0}),
				// Metadata/worker-safe projection. Never stderr, a URL, a token or a
				// provider path; bounded so heartbeat/session status stays small.
				diagnostics:()=>{
					const failure=job.lastFailure;
					const data={method:job.method||'',copyMode:job.copyMode===true,windowStart:job.windowStart,windowEnd:job.windowEnd,
						produced:job.produced,requested:job.requested,exitCode:job.exitCode??null,...(job.exitSignal?{signal:job.exitSignal}:{}),
						...(failure?{failure:{category:failure.category,code:failure.code,summary:failure.summary,userSummary:failure.userSummary,
							exitCode:failure.exitCode??null,...(failure.signal?{signal:failure.signal}:{})}}:{})};
					let text=JSON.stringify(data);
					if(text.length>2048)text=JSON.stringify({method:data.method,copyMode:data.copyMode,
						...(data.failure?{failure:{category:data.failure.category,code:data.failure.code,summary:String(data.failure.summary||'').slice(0,200)}}:{})});
					return text.slice(0,2048);
				},
				captionSources:deferred?new Map([[deferred.index,{lookup:deferred.lookup}]]):null,subtitleIndex:selectedSubtitle?.index??-1,subtitles:[...subtitleTracks.map(s=>({index:s.index,label:s.tags?.title||s.tags?.language||'Subtitles',...(nativeCaptions.includes(s)?{hls:true,embedded:true,nativeTitle:`tellybox-subtitle-${s.index}`,language:s.tags?.language||'und',ordinal:nativeCaptions.indexOf(s)}:{})})),...(external?[{index:external.index,label:external.label}]:[])],
				audio:audio.map((s,i)=>({index:s.index,label:s.tags?.language||`Audio ${i+1}`,selected:s.index===chosen?.index})),
				read:async file=>{job.lastRead=Date.now();if(job.stopped)throw Object.assign(Error('Playback expired. Please press play again.'),{status:410});if(file==='index.m3u8')return Buffer.from(nativeCaptions.length?captionMaster(nativeCaptions,quality,selectedSubtitle?.index):manifest);
					if(file==='video.m3u8')return Buffer.from(manifest);
					const subtitleList=/^captions-(\d+)\.m3u8$/.exec(file),captionPart=/^caption-(\d+)-(\d+)\.vtt$/.exec(file);
					if(subtitleList||captionPart){
						const track=Number((subtitleList||captionPart)[1]);
						if(!nativeCaptions.some(s=>s.index===track))throw Object.assign(Error('Invalid captions.'),{status:404});
						if(subtitleList)return Buffer.from(captionManifest(playEnd,track,job.segmentSeconds,copyMode?job.segmentDurations:null));
						const n=Number(captionPart[2]);if(n>=job.total)throw Object.assign(Error('Invalid captions.'),{status:404});
						// Caption fetches never start, stop or seek the encoder. Wait for the
						// matching video segment; failures leave video playback independent.
						if(job.copyMode&&job.shiftReadyPromise)await job.shiftReadyPromise.catch(()=>{});
						const deadline=Date.now()+15000;
						while(!job.stopped&&Date.now()<deadline){
							const fileIndex=n+(job.copyMode?Number(job.fileShift)||0:0);
							try{await io.stat(path.join(job.directory,'segment'+String(fileIndex).padStart(9,'0')+'.ts'));break;}catch{}
							await new Promise(r=>setTimeout(r,150));
						}
						let text='',slice='';
						const candidates=job.captionFiles.filter(entry=>entry.track===track&&entry.startSegment<=n&&n<=entry.endSegment).sort((a,b)=>b.startSegment-a.startSegment);
						// A freshly created WebVTT may contain only the header while
						// ffmpeg is still copying the window. Retry until a cue appears,
						// the encoder stops, or the bound expires; a genuinely cue-free
						// segment returns an empty WebVTT after that bound. A caption
						// fetch must never start, stop or seek the video encoder.
						const captionDeadline=Date.now()+4000;
						for(let wait=0;wait<40&&Date.now()<captionDeadline;wait++){
							let found=false;
							for(const entry of candidates){try{text=await io.readFile(path.join(job.directory,entry.file),'utf8');found=true;break;}catch{}}
							if(!found){try{text=await io.readFile(path.join(job.directory,`captions-${track}.vtt`),'utf8');found=true;}catch{}}
							if(found)slice=captionSlice(text,n,job.segmentDurations);
							if(slice.includes('-->'))break;
							if(!job.child||job.child.exitCode!==null)break;
							await new Promise(r=>setTimeout(r,100));
						}
						return Buffer.from(slice||captionSlice(text,n,job.segmentDurations));
					}
					const match=/^segment(\d+)\.ts$/.exec(file);if(!match)throw Object.assign(Error('Invalid stream resource.'),{status:400});
						const result=job.queue.then(()=>chunk(Number(match[1]))).then(bytes=>{
							// Prepare only the next window, after video has started. Its captions
							// are ready before playback crosses the encoder's window boundary.
							const next=(job.start*job.segmentSeconds)+captionSeconds;
							if(windowedSubtitle&&next<playEnd&&!job.stopped)void captionWindow(next).catch(()=>{});
							return bytes;
						});job.queue=result.catch(()=>{});return result;}};
		}catch(error){await stop();throw fail(error.status?error.message:'This streamed title could not be prepared. Please try again.');}
	}
	return {start};
}
