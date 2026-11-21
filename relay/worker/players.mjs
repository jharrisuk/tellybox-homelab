import { createDirectPlayer } from '../../server/dispatcharr-player.mjs';
import { createVodPlayer, vodCopyEligible, vodCopyEnabled, vodCopyPlan, vodCopySampleStarts, vodCopySegmentSeconds } from '../../server/vod-player.mjs';
import { englishSubtitle } from '../../server/subtitle-choice.mjs';
import { createCatchupPlayer } from '../../server/catchup-player.mjs';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const textCodecs = new Set(['subrip', 'srt', 'ass', 'ssa', 'webvtt', 'mov_text', 'text']);
const imageCodecs = new Set(['hdmv_pgs_subtitle', 'dvd_subtitle', 'dvb_subtitle']);
function probeTextOver(open, args, signal, timeout = 15000) {
	return new Promise((resolve, reject) => {
		const server = http.createServer(async (req, res) => {
			const controller = new AbortController();
			const abort = () => controller.abort();
			res.on('close', abort); signal?.addEventListener('abort', abort, { once: true });
			try {
				const upstream = await open(req.headers.range, controller.signal);
				if (![200, 206, 416].includes(upstream.status) || !upstream.body) { await upstream.body?.cancel?.(); res.writeHead(502).end(); return; }
				res.statusCode = upstream.status;
				for (const key of ['content-type', 'content-length', 'content-range', 'accept-ranges']) if (upstream.headers.has(key)) res.setHeader(key, upstream.headers.get(key));
				await pipeline(Readable.fromWeb(upstream.body), res, { signal: controller.signal });
			} catch { if (!res.headersSent) res.writeHead(502); res.end(); }
			finally { signal?.removeEventListener('abort', abort); }
		});
		server.listen(0, '127.0.0.1', () => {
			const child = spawn('ffprobe', ['-v', 'error', '-protocol_whitelist', 'http,tcp', ...args, `http://127.0.0.1:${server.address().port}/`], { stdio: ['ignore', 'pipe', 'ignore'] });
			let output = ''; const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
			child.stdout.on('data', chunk => { if (output.length < 500000) output += chunk; });
			child.on('error', () => { clearTimeout(timer); server.close(); reject(Error('Worker could not inspect this title.')); });
			child.on('close', () => { clearTimeout(timer); server.close(); resolve(output); });
		});
	});
}
async function probeOver(open, signal) {
	const text = await probeTextOver(open, ['-show_streams', '-show_format', '-of', 'json'], signal);
	try { return JSON.parse(text); } catch { throw Error('Worker could not inspect this title.'); }
}
// Same whole-title sample contract as the player. The prepare metadata and the
// actual VOD start both use this plan; a failed sample is a null plan (transcode).
async function copyPlanOver(open, signal, duration) {
	const samples = [];
	let firstKeyframe = 0;
	const starts = vodCopySampleStarts(Number(duration) || 0);
	for (const start of starts) {
		const text = await probeTextOver(open, ['-select_streams', 'v:0', '-skip_frame', 'nokey', '-show_entries', 'frame=pts_time',
			'-read_intervals', start > 0 ? `${start}%+12` : '%+12', '-of', 'csv=p=0'], signal, 20000);
		const times = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean).map(line => Number(line.replace(/,$/, '').trim())).filter(Number.isFinite);
		const step = vodCopySegmentSeconds(times);
		if (start === 0) firstKeyframe = Number(times[0]) || 0;
		if (process.env.VOD_DEBUG === '1') console.error(JSON.stringify({ event: 'worker_copy_sample', start, count: times.length, first: times.slice(0, 3), step }));
		samples.push(step);
	}
	return vodCopyPlan(samples, firstKeyframe);
}
/**
 * Build prepare metadata from an ffprobe-shaped inspection result. The method
 * must match what the player will actually do: video copy is only reported
 * when copy is enabled (TELLYBOX_VOD_COPY=0 disables it) and the shared
 * vodCopyEligible decision - codec/profile/level/chroma, client capabilities,
 * quality ceiling, remuxable container and convertible audio - proves the
 * source combination decodable. A requested compatibility retry or any
 * burned-in subtitle (external, image, or a text pick without sidecar
 * captions) always forces a transcode, and a capability claim can never
 * override compatibility. Exported for deterministic plumbing tests.
 */
export function metadata(info, requestedSubtitle = -1, external = null, requestedAudio = -1, options = {}) {
	const streams = Array.isArray(info.streams) ? info.streams : [];
	const video = streams.find(stream => stream.codec_type === 'video');
	const audio = streams.filter(stream => stream.codec_type === 'audio').map((stream, index) => ({ index: stream.index, label: stream.tags?.language || `Audio ${index + 1}`, selected: stream.index === requestedAudio }));
	const subtitles = streams.filter(stream => stream.codec_type === 'subtitle' && (textCodecs.has(stream.codec_name) || imageCodecs.has(stream.codec_name))).map(stream => ({ index: stream.index, label: stream.tags?.title || stream.tags?.language || 'Subtitles', embedded: true, language: stream.tags?.language || 'und', ordinal: 0, ...(imageCodecs.has(stream.codec_name) ? { image: true } : {}) }));
	if (external) subtitles.push({ index: 1000001, label: 'English · OpenSubtitles' });
	const selected = Number.isInteger(requestedSubtitle) ? requestedSubtitle : -1;
	const selectedTrack = streams.find(stream => stream.index === selected);
	const imageSelected = Boolean(selectedTrack && imageCodecs.has(selectedTrack.codec_name));
	const textSelected = Boolean(selectedTrack && textCodecs.has(selectedTrack.codec_name));
	const hasEnglishTrack = streams.some(stream => stream.codec_type === 'subtitle'
		&& englishSubtitle(stream.tags?.language, stream.tags?.title, stream.tags?.handler_name));
	const hasEnglishText = streams.some(stream => stream.codec_type === 'subtitle' && textCodecs.has(stream.codec_name)
		&& englishSubtitle(stream.tags?.language, stream.tags?.title, stream.tags?.handler_name));
	// Mirror the player's burned-subtitle rule: copy only when nothing is
	// burned in. External and image subtitles always burn; a selected text
	// subtitle burns unless the client asked for native sidecars; the
	// prefer-English auto-selection burns when a track would be picked without
	// a text sidecar (an English image track still burns with textSubtitles).
	const autoSidecar = options.preferEnglishSubtitles === true && options.textSubtitles === true && hasEnglishText;
	const burnsSubtitle = Boolean(external) || imageSelected
		|| (textSelected && options.textSubtitles !== true)
		|| (options.preferEnglishSubtitles === true && !autoSidecar && hasEnglishTrack);
	const chosenAudio = streams.find(stream => stream.codec_type === 'audio' && stream.index === requestedAudio)
		|| streams.find(stream => stream.codec_type === 'audio' && /^en(g)?$/i.test(stream.tags?.language || ''))
		|| streams.find(stream => stream.codec_type === 'audio');
	const planProven = Boolean(options.copyPlan && Number(options.copyPlan.segmentSeconds) > 0)
		&& Number(options.copyPlan.firstKeyframe || 0) <= (String(info.format?.format_name || '').includes('mpegts') ? 1.6 : 0.5);
	const copy = options.compatibility !== true && planProven && !burnsSubtitle && vodCopyEnabled() &&
		vodCopyEligible(video, info.format, { capabilities: options.capabilities, quality: options.quality, audio: chosenAudio, container: info.format?.format_name });
	// Same method split as the player: video copy with untouched AAC stereo
	// audio is a Copy; converting the audio to AAC is a Remux.
	const copyAudio = Boolean(copy && chosenAudio && String(chosenAudio.codec_name).toLowerCase() === 'aac' && (Number(chosenAudio.channels) || 0) <= 2);
	const method = copy ? (chosenAudio ? (copyAudio ? 'Copy' : 'Remux') : 'Copy') : 'Transcode';
	return { duration: Number(info.format?.duration) || 0, audio, subtitles, subtitleIndex: selected,
		method, videoCodec: copy ? (video?.codec_name || '') : 'h264', audioCodec: chosenAudio ? 'aac' : '' };
}
const fail = (message, status = 502) => Object.assign(Error(message), { status });

/** Reuse the existing media players with a worker-scoped Dispatcharr client.
 * `vodPlayer` is a test seam: absent in production, tests inject a recording
 * double so the adapter can be verified without spawning ffmpeg. */
export function createWorkerPlayers({ upstream, maxSessions = 3, paceInput = true, vodPlayer = null } = {}) {
	const direct = createDirectPlayer({ origin: upstream.origin, fetcher: (url, options = {}) => upstream.fetcher(url, options), maxSessions });
	const vod = vodPlayer || createVodPlayer({
		open: (source, options) => source.type === 'recording' ? upstream.recordingFile(source.id, options) : upstream.stream(source, options),
		close: (token, source) => source.type === 'recording' ? Promise.resolve() : upstream.stopStream(token),
		maxSessions
	});
	const catchup = createCatchupPlayer({ openArchive: (channel, start, duration) => upstream.catchupSession(channel, start, duration), maxSessions, paceInput });
	async function start(session) {
		const { mode, params = {}, options = {} } = session;
		if (mode === 'live' || mode === 'nonstop') {
			if (!/^[a-f0-9-]{36}$/i.test(params.channelId || '')) throw fail('Invalid channel.', 400);
			return direct.start({ id: params.channelId, nonstop: mode === 'nonstop' }, {
				quality: options.quality, compatibility: Boolean(options.compatibility), audioIndex: options.audioIndex,
				capabilities: options.capabilities, onStopped: options.onStopped,
				openStream: signal => upstream.liveStream(params.channelId, { signal })
			});
		}
		if (mode === 'catchup') {
			if (!/^[a-f0-9-]{36}$/i.test(params.channelId || '')) throw fail('Invalid channel.', 400);
			return catchup.start({ id: params.channelId }, params.item, options.position, { quality: options.quality });
		}
		if (mode === 'recording') {
			if (!Number.isSafeInteger(params.recordingId) || params.recordingId <= 0) throw fail('Invalid recording.', 400);
			return vod.start({ type: 'recording', id: params.recordingId, provider: 'Dispatcharr recording' }, {
				textSubtitles: false, quality: options.quality, audioIndex: options.audioIndex, subtitleIndex: options.subtitleIndex,
				externalSubtitle: options.externalSubtitle, preferEnglishSubtitles: false,
				capabilities: options.capabilities, compatibility: options.compatibility === true,
				copyPlan: session.copyPlan ?? null
			});
		}
		if (mode === 'vod') {
			if (!['movie', 'episode'].includes(params.type) || !/^[a-f0-9-]{36}$/i.test(params.uuid || '')) throw fail('Invalid streamed title.', 400);
			return vod.start({ type: params.type, uuid: params.uuid, account: params.account, streamId: params.streamId, provider: params.provider || 'Dispatcharr' }, {
				textSubtitles: options.textSubtitles === true, quality: options.quality, audioIndex: options.audioIndex,
				subtitleIndex: options.subtitleIndex, externalSubtitle: options.externalSubtitle,
				preferEnglishSubtitles: options.preferEnglishSubtitles === true,
				capabilities: options.capabilities, compatibility: options.compatibility === true,
				copyPlan: session.copyPlan ?? null,
				lookupSubtitles: null
			});
		}
		throw fail('Unsupported relay media mode.', 400);
	}
	async function probe(session) {
		const { mode, params = {}, options = {} } = session;
		try {
			if (mode === 'recording') {
				const open = (range, signal) => upstream.recordingFile(params.recordingId, { range, signal });
				const info = await probeOver(open, options.signal);
				let copyPlan = null;
				try { copyPlan = await copyPlanOver(open, options.signal, Number(info.format?.duration) || 0); } catch { copyPlan = null; }
				session.copyPlan = copyPlan;
				if(process.env.VOD_DEBUG==='1')console.error(JSON.stringify({event:'worker_copy_plan',mode,duration:Number(info.format?.duration)||0,copyPlan}));
				return metadata(info, options.subtitleIndex, null, options.audioIndex, { ...options, copyPlan });
			}
			if (mode === 'vod') {
				const source = { type: params.type, uuid: params.uuid, account: params.account, streamId: params.streamId };
				const open = (range, signal) => upstream.stream(source, { range, signal });
				const info = await probeOver(open, options.signal);
				let copyPlan = null;
				try { copyPlan = await copyPlanOver(open, options.signal, Number(info.format?.duration) || 0); } catch { copyPlan = null; }
				session.copyPlan = copyPlan;
				if(process.env.VOD_DEBUG==='1')console.error(JSON.stringify({event:'worker_copy_plan',mode,duration:Number(info.format?.duration)||0,copyPlan}));
				return metadata(info, options.subtitleIndex, session.externalSubtitle ? true : null, options.audioIndex, { ...options, copyPlan });
			}
		} catch {
			session.copyPlan = null;
		}
		return metadata({}, options.subtitleIndex, session.externalSubtitle ? true : null, options.audioIndex, { ...options, copyPlan: null });
	}
	return { start, probe, close: async () => {} };
}
