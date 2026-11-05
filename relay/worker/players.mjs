import { createDirectPlayer } from '../../server/dispatcharr-player.mjs';
import { createVodPlayer } from '../../server/vod-player.mjs';
import { createCatchupPlayer } from '../../server/catchup-player.mjs';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const textCodecs = new Set(['subrip', 'srt', 'ass', 'ssa', 'webvtt', 'mov_text', 'text']);
const imageCodecs = new Set(['hdmv_pgs_subtitle', 'dvd_subtitle', 'dvb_subtitle']);
function probeOver(open, signal) {
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
			const child = spawn('ffprobe', ['-v', 'error', '-protocol_whitelist', 'http,tcp', '-show_streams', '-show_format', '-of', 'json', `http://127.0.0.1:${server.address().port}/`], { stdio: ['ignore', 'pipe', 'ignore'] });
			let output = ''; const timer = setTimeout(() => child.kill('SIGKILL'), 15000);
			child.stdout.on('data', chunk => { if (output.length < 500000) output += chunk; });
			child.on('error', () => { clearTimeout(timer); server.close(); reject(fail('Worker could not inspect this title.')); });
			child.on('close', () => { clearTimeout(timer); server.close(); try { resolve(JSON.parse(output)); } catch { reject(fail('Worker could not inspect this title.')); } });
		});
	});
}
function metadata(info, requestedSubtitle = -1, external = null, requestedAudio = -1) {
	const streams = Array.isArray(info.streams) ? info.streams : [];
	const audio = streams.filter(stream => stream.codec_type === 'audio').map((stream, index) => ({ index: stream.index, label: stream.tags?.language || `Audio ${index + 1}`, selected: stream.index === requestedAudio }));
	const subtitles = streams.filter(stream => stream.codec_type === 'subtitle' && (textCodecs.has(stream.codec_name) || imageCodecs.has(stream.codec_name))).map(stream => ({ index: stream.index, label: stream.tags?.title || stream.tags?.language || 'Subtitles', embedded: true, language: stream.tags?.language || 'und', ordinal: 0, ...(imageCodecs.has(stream.codec_name) ? { image: true } : {}) }));
	if (external) subtitles.push({ index: 1000001, label: 'English · OpenSubtitles' });
	const selected = Number.isInteger(requestedSubtitle) ? requestedSubtitle : -1;
	return { duration: Number(info.format?.duration) || 0, audio, subtitles, subtitleIndex: selected, method: 'Transcode' };
}
const fail = (message, status = 502) => Object.assign(Error(message), { status });

/** Reuse the existing media players with a worker-scoped Dispatcharr client. */
export function createWorkerPlayers({ upstream, maxSessions = 3 } = {}) {
	const direct = createDirectPlayer({ origin: upstream.origin, fetcher: (url, options = {}) => upstream.fetcher(url, options), maxSessions });
	const vod = createVodPlayer({
		open: (source, options) => source.type === 'recording' ? upstream.recordingFile(source.id, options) : upstream.stream(source, options),
		close: (token, source) => source.type === 'recording' ? Promise.resolve() : upstream.stopStream(token),
		maxSessions
	});
	const catchup = createCatchupPlayer({ openArchive: (channel, start, duration) => upstream.catchupSession(channel, start, duration), maxSessions });
	async function start(session) {
		const { mode, params = {}, options = {} } = session;
		if (mode === 'live' || mode === 'nonstop') {
			if (!/^[a-f0-9-]{36}$/i.test(params.channelId || '')) throw fail('Invalid channel.', 400);
			return direct.start({ id: params.channelId, nonstop: mode === 'nonstop' }, {
				quality: options.quality, compatibility: Boolean(options.compatibility), audioIndex: options.audioIndex,
				openStream: signal => upstream.liveStream(params.channelId, { signal })
			});
		}
		if (mode === 'catchup') {
			if (!/^[a-f0-9-]{36}$/i.test(params.channelId || '')) throw fail('Invalid channel.', 400);
			return catchup.start({ id: params.channelId }, params.item);
		}
		if (mode === 'recording') {
			if (!Number.isSafeInteger(params.recordingId) || params.recordingId <= 0) throw fail('Invalid recording.', 400);
			return vod.start({ type: 'recording', id: params.recordingId, provider: 'Dispatcharr recording' }, {
				textSubtitles: false, quality: options.quality, audioIndex: options.audioIndex, subtitleIndex: options.subtitleIndex,
				externalSubtitle: options.externalSubtitle, preferEnglishSubtitles: false
			});
		}
		if (mode === 'vod') {
			if (!['movie', 'episode'].includes(params.type) || !/^[a-f0-9-]{36}$/i.test(params.uuid || '')) throw fail('Invalid streamed title.', 400);
			return vod.start({ type: params.type, uuid: params.uuid, account: params.account, streamId: params.streamId, provider: params.provider || 'Dispatcharr' }, {
				textSubtitles: options.textSubtitles === true, quality: options.quality, audioIndex: options.audioIndex,
				subtitleIndex: options.subtitleIndex, externalSubtitle: options.externalSubtitle,
				preferEnglishSubtitles: options.preferEnglishSubtitles === true,
				lookupSubtitles: null
			});
		}
		throw fail('Unsupported relay media mode.', 400);
	}
	async function probe(session) {
		const { mode, params = {}, options = {} } = session;
		try {
			if (mode === 'recording') {
				const info = await probeOver((range, signal) => upstream.recordingFile(params.recordingId, { range, signal }), options.signal);
				return metadata(info, options.subtitleIndex, null, options.audioIndex);
			}
			if (mode === 'vod') {
				const source = { type: params.type, uuid: params.uuid, account: params.account, streamId: params.streamId };
				const info = await probeOver((range, signal) => upstream.stream(source, { range, signal }), options.signal);
				return metadata(info, options.subtitleIndex, session.externalSubtitle ? true : null, options.audioIndex);
			}
		} catch { /* Probe is best effort; playback can still start. */ }
		return metadata({}, options.subtitleIndex, session.externalSubtitle ? true : null, options.audioIndex);
	}
	return { start, probe, close: async () => {} };
}
