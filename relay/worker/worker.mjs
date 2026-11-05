import http from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createNonceCache, controlHeaders, resourceAllowed, verifyControlRequest, verifyMediaToken } from '../../server/relay-media/protocol.mjs';

const fail = (message, status = 500, code = 'RELAY_WORKER') => Object.assign(Error(message), { status, code });
const RESOURCE_CLASSES = new Set(['hls', 'segment', 'file', 'subtitle']);
const LIVE_RESOURCE = /^(?:index|video|captions-\d+)\.m3u8$|^segment\d+\.ts$|^caption-\d+-\d+\.vtt$/;
const VOD_RESOURCE = /^(?:index|video|captions-\d+)\.m3u8$|^segment\d+\.ts$|^caption-\d+-\d+\.vtt$/;
const SIMPLE_RESOURCE = /^subtitle\.vtt$|^file$/;

export function resourceClass(resource, mode) {
	if (resource === 'file') return mode === 'recording' ? 'file' : '';
	if (resource === 'subtitle.vtt') return mode === 'vod' ? 'subtitle' : '';
	if (/\.m3u8$/.test(resource)) return 'hls';
	if (/^segment\d+\.ts$/.test(resource)) return 'segment';
	if (/^caption-\d+-\d+\.vtt$/.test(resource)) return 'subtitle';
	return '';
}
function mediaType(resource) {
	if (resource.endsWith('.m3u8')) return 'application/vnd.apple.mpegurl';
	if (resource.endsWith('.vtt')) return 'text/vtt';
	if (resource.endsWith('.ts')) return 'video/mp2t';
	return 'application/octet-stream';
}
function rewritePlaylist(text, token) {
	const base = '/relay-media/v1/s/' + token + '/';
	return text.split('\n').map(line => {
		if (line.startsWith('#')) return line.replace(/URI="([^"\r\n]+)"/g, (_, uri) => 'URI="' + base + uri + '"');
		return line.trim() ? base + line.trim() : line;
	}).join('\n');
}
function readBody(req, limit = 2.5 * 1024 * 1024) {
	return new Promise((resolve, reject) => {
		let size = 0; const chunks = [];
		req.on('data', chunk => { size += chunk.length; if (size > limit) { reject(fail('Request body is too large.', 413)); req.destroy(); } else chunks.push(chunk); });
		req.on('end', () => resolve(Buffer.concat(chunks)));
		req.on('error', reject);
	});
}
function sendJson(res, status, value) {
	if (res.headersSent) return;
	const body = JSON.stringify(value);
	res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
	res.end(body);
}
function safeToken(value) { return typeof value === 'string' && value.length > 20 && value.length < 4096 && /^[A-Za-z0-9_.-]+$/.test(value); }

export function createRelayWorker({
	workerId, version = '0.26.9', instance = randomUUID(), mainControlPublicKey, mainMediaPublicKey, workerPrivateKey,
	mainHeartbeatUrl = '', mainHeartbeatKeyId = '', dataDirectory = '', players, upstream, fetcher = fetch, clock = Date.now, logger = console,
	maxSessions = 3, maxFfmpegJobs = 3, heartbeatMs = 10000, freshnessMs = 15000, outageMs = 45000, preparedTtlMs = 30000,
	maxBitrate = 20000000, heartbeatEnabled = true
} = {}) {
	if (!workerId) throw Error('Worker ID is required.');
	if (!mainControlPublicKey || !mainMediaPublicKey) throw Error('Pinned main public keys are required.');
	const nonce = createNonceCache({ clock });
	const sessions = new Map(), byLease = new Map(), idempotency = new Map(), activeResponses = new Set();
	let lastMainOk = clock(), lastHeartbeatAt = 0, heartbeatTimer = null, watchdogTimer = null, upstreamHealthy = true, upstreamChecked = 0, stopped = false;
	let bytesOutTotal = 0, resourcesServed = 0;
	const effectivePlayers = players || { start: () => { throw Error('Worker players are not configured.'); } };
	const instanceId = instance;
	function isMainFresh() { return clock() - lastMainOk <= freshnessMs; }
	function mainCut() { return clock() - lastMainOk > outageMs; }
	function leaseActive(leaseId) { return byLease.get(leaseId) || null; }
	function sessionView(session) {
		return { sessionId: session.sessionId, workerSessionId: session.workerSessionId, leaseId: session.leaseId, generation: session.generation,
			itemId: session.itemId, mode: session.mode, state: session.state, createdAt: session.createdAt, activatedAt: session.activatedAt,
			leaseUntil: session.leaseUntil, hardEndsAt: session.hardEndsAt, bytesOutTotal: session.bytesOutTotal, resourcesServed: session.resourcesServed,
			activeResponses: session.controllers.size };
	}
	async function stopSession(session, reason = 'stopped') {
		if (!session || session.state === 'stopped') return { stopped: true, already: true };
		session.state = 'stopped'; session.stoppedAt = clock();
		if (byLease.get(session.leaseId) === session) byLease.delete(session.leaseId);
		sessions.delete(session.workerSessionId);
		for (const controller of session.controllers) { try { controller.abort(); } catch {} }
		session.controllers.clear();
		try { await session.startPromise; } catch {}
		try { await session.player?.stop?.(); } catch {}
		if (session.directory) await rm(session.directory, { recursive: true, force: true }).catch(() => {});
		idempotency.set(session.leaseId + ':' + session.generation, { state: 'stopped', at: clock() });
		return { stopped: true };
	}
	async function stopAll(reason) {
		await Promise.allSettled([...sessions.values()].map(session => stopSession(session, reason)));
	}
	function sweep() {
		const now = clock();
		for (const [key, value] of idempotency) if (now - value.at > 10 * 60 * 1000) idempotency.delete(key);
		for (const session of [...sessions.values()]) {
			if (session.state === 'prepared' && now - session.createdAt > preparedTtlMs) { void stopSession(session, 'prepare_expired'); continue; }
			if (session.leaseUntil && now > session.leaseUntil) { void stopSession(session, 'lease_expired'); continue; }
			if (mainCut()) { void stopSession(session, 'main_outage'); }
		}
	}
	async function authenticate(req, body) {
		const ok = verifyControlRequest(mainControlPublicKey, { method: req.method, path: req.url, headers: req.headers, body, now: clock(), nonce });
		if (!ok) throw fail('Worker control authentication failed.', 401, 'RELAY_WORKER_AUTH');
	}
	function sessionFor(body, payload) {
		return byLease.get(body.leaseId) || null;
	}
	async function prepare(body, { replacement = false } = {}) {
		if (stopped) throw fail('Worker is stopping.', 503);
		if (!upstreamHealthy) throw fail('The worker cannot reach Dispatcharr.', 503, 'RELAY_UPSTREAM');
		const payload = verifyMediaToken(mainMediaPublicKey, body.capability, { aud: workerId, leaseId: body.leaseId, sessionId: body.sessionId, itemId: body.itemId, mode: body.mode, generation: body.generation }, clock());
		if (payload.generation !== body.generation) throw fail('Capability generation mismatch.', 403, 'RELAY_MEDIA_SCOPE');
		const idempotencyKey = String(body.leaseId) + ':' + String(body.generation);
		const prior = idempotency.get(idempotencyKey);
		if (prior?.state === 'stopped') throw fail('This relay session has ended.', 410, 'RELAY_SESSION_ENDED');
		if (prior?.state === 'prepared') {
			const existing = byLease.get(body.leaseId);
			if (existing && existing.generation === body.generation && existing.state !== 'stopped') return { ...prior.response, idempotent: true };
			throw fail('This relay session has ended.', 410, 'RELAY_SESSION_ENDED');
		}
		if (!isMainFresh()) throw fail('Main control is stale; the worker is refusing new playback.', 503, 'RELAY_CONTROL_STALE');
		if (sessions.size >= maxSessions + (replacement ? 1 : 0)) throw fail('All relay media slots are busy.', 429, 'RELAY_CAPACITY');
		const session = {
			workerSessionId: randomUUID(), sessionId: payload.sessionId, leaseId: body.leaseId, generation: body.generation, itemId: body.itemId, mode: body.mode,
			params: body.modeParameters || {}, options: { quality: body.quality, audioIndex: body.audioIndex, subtitleIndex: body.subtitleIndex,
				compatibility: Boolean(body.modeParameters?.compatibility), textSubtitles: Boolean(body.modeParameters?.textSubtitles),
				preferEnglishSubtitles: Boolean(body.modeParameters?.preferEnglishSubtitles), externalSubtitle: null, position: Number(body.position) || 0 },
			capability: body.capability, payload, externalSubtitle: typeof body.externalSubtitle === 'string' ? body.externalSubtitle.slice(0, 2 * 1024 * 1024) : '',
			createdAt: clock(), activatedAt: 0, leaseUntil: 0, hardEndsAt: Math.min(Number(body.hardEndsAt) || Infinity, clock() + Number(payload.exp) * 1000),
			state: 'prepared', controllers: new Set(), player: null, startPromise: null, bytesOutTotal: 0, resourcesServed: 0, lastResourceAt: 0, lastErrorCode: '',
			previousWorkerSessionId: replacement ? body.previousWorkerSessionId || '' : '', directory: ''
		};
		// The capability expiry is the absolute session limit. The short control
		// lease arrives with the heartbeat and may be much shorter.
		session.leaseUntil = clock() + Math.max(1, Math.min(300, Number(body.grantSeconds) || 45)) * 1000;
		let meta = { duration: Number(body.duration) || 0, audio: Array.isArray(body.audio) ? body.audio : [], subtitles: Array.isArray(body.subtitles) ? body.subtitles : [], subtitleIndex: body.subtitleIndex ?? -1, method: 'HLS' };
		if (body.needsMetadata === true && ['vod', 'recording'].includes(session.mode) && typeof effectivePlayers.probe === 'function') {
			try { meta = { ...meta, ...await effectivePlayers.probe(session) }; } catch { /* best effort */ }
			if (session.externalSubtitle) {
				const english = meta.subtitles.some(track => track.index === 1000001 || /^en(g)?$/i.test(track.language || '') || /english/i.test(track.label || ''));
				if (english && Number.isInteger(meta.subtitleIndex) && meta.subtitleIndex >= 0) session.options.subtitleIndex = meta.subtitleIndex;
			}
		}
		const response = { workerSessionId: session.workerSessionId, sessionUrl: '/relay-media/v1/s/' + body.capability + '/index.m3u8',
			method: meta.method || 'HLS', duration: meta.duration || 0, audio: meta.audio || [], subtitles: meta.subtitles || [],
			subtitleIndex: meta.subtitleIndex ?? -1, position: Number(body.position) || 0, activate: 'first-get', workerId };
		sessions.set(session.workerSessionId, session);
		byLease.set(session.leaseId, session);
		idempotency.set(idempotencyKey, { state: 'prepared', at: clock(), response });
		return { ...response, idempotent: false };
	}
	async function ensureStarted(session, signal) {
		if (session.state === 'stopped') throw fail('This relay session has ended.', 410, 'RELAY_SESSION_ENDED');
		if (session.player) return session.player;
		if (session.startPromise) return session.startPromise;
		session.startPromise = (async () => {
			session.state = 'starting';
			if (session.externalSubtitle) {
				const directory = path.join(dataDirectory || os.tmpdir(), 'relay-media-' + session.workerSessionId);
				await mkdir(directory, { recursive: true, mode: 0o700 });
				session.directory = directory;
				const file = path.join(directory, 'external.vtt');
				await writeFile(file, session.externalSubtitle, { mode: 0o600 });
				session.options.externalSubtitle = { file, localName: 'external.vtt', index: 1000001, label: 'English · OpenSubtitles' };
				if (session.options.subtitleIndex === undefined || session.options.subtitleIndex === null) session.options.subtitleIndex = 1000001;
			}
			const player = await effectivePlayers.start(session);
			session.player = player;
			session.state = 'active';
			session.activatedAt = clock();
			if (session.previousWorkerSessionId) {
				const previous = sessions.get(session.previousWorkerSessionId);
				if (previous && previous !== session) void stopSession(previous, 'replaced');
			}
			return player;
		})().catch(error => {
			session.startPromise = null; session.state = 'prepared'; session.lastErrorCode = error.code || 'RELAY_PLAYER';
			throw error.status ? error : fail('This relay media could not start.', 502, 'RELAY_PLAYER');
		});
		return session.startPromise;
	}
	function route(pathname) {
		const prefix = '/relay-media/v1/s/';
		if (!pathname.startsWith(prefix)) return null;
		const rest = pathname.slice(prefix.length).split('/');
		if (rest.length !== 2) return null;
		const [token, resource] = rest;
		if (!safeToken(token) || !resource || resource.includes('..') || resource.includes('%') || resource.includes('\\')) return null;
		return { token, resource };
	}
	async function serveFile(req, res, session, signal) {
		if (session.mode !== 'recording') throw fail('This resource is not available.', 404, 'RELAY_RESOURCE');
		const range = req.headers.range || '';
		if (range && (!/^bytes=\d*-\d*$/.test(range) || range.includes(','))) throw fail('Only one byte range is supported.', 416, 'RELAY_RANGE');
		const response = await upstream.recordingFile(session.params.recordingId, { range, signal });
		res.statusCode = response.status;
		if (!response.ok && response.status !== 206) { await response.body?.cancel(); throw fail('The recording file is unavailable.', 502, 'RELAY_UPSTREAM'); }
		for (const key of ['content-type', 'content-length', 'content-range', 'accept-ranges']) if (response.headers.has(key)) res.setHeader(key, response.headers.get(key));
		return response;
	}
	async function media(req, res, url) {
		res.setHeader('Cache-Control', 'no-store');
		res.setHeader('Referrer-Policy', 'no-referrer');
		res.setHeader('X-Content-Type-Options', 'nosniff');
		if (!['GET', 'HEAD'].includes(req.method)) return sendJson(res, 405, { error: 'Only GET and HEAD are allowed.', code: 'RELAY_METHOD' });
		if (url.search) return sendJson(res, 400, { error: 'This media address is invalid.', code: 'RELAY_URL' });
		if (url.pathname === '/relay-media/v1/health') {
			if (req.method !== 'GET') return sendJson(res, 405, { error: 'Only GET is allowed.' });
			return sendJson(res, 200, { ok: upstreamHealthy && isMainFresh(), version, capabilities: ['live', 'nonstop', 'vod', 'recording', 'catchup', 'range', 'subtitle'] });
		}
		const target = route(url.pathname);
		if (!target) return sendJson(res, 404, { error: 'Not found.' });
		let payload;
		try { payload = verifyMediaToken(mainMediaPublicKey, target.token, { aud: workerId }, clock()); }
		catch (error) { return sendJson(res, error.status || 403, { error: error.message, code: error.code || 'RELAY_MEDIA_TOKEN' }); }
		const session = byLease.get(payload.leaseId);
		if (!session || session.generation !== payload.generation || session.state === 'stopped') return sendJson(res, 410, { error: 'This relay session has ended.', code: 'RELAY_SESSION_ENDED' });
		if (session.itemId !== payload.itemId || session.sessionId !== payload.sessionId) return sendJson(res, 403, { error: 'This media capability is for another session.', code: 'RELAY_MEDIA_SCOPE' });
		if (session.leaseUntil && clock() > session.leaseUntil) { void stopSession(session, 'lease_expired'); return sendJson(res, 410, { error: 'The relay control lease expired.', code: 'RELAY_LEASE_EXPIRED' }); }
		if (mainCut()) { void stopSession(session, 'main_outage'); return sendJson(res, 503, { error: 'Main control was lost. Playback has stopped.', code: 'RELAY_CONTROL_LOST' }); }
		const allowed = session.mode === 'vod' ? (VOD_RESOURCE.test(target.resource) || target.resource === 'subtitle.vtt') : session.mode === 'recording' ? (VOD_RESOURCE.test(target.resource) || SIMPLE_RESOURCE.test(target.resource)) : LIVE_RESOURCE.test(target.resource);
		if (!allowed) return sendJson(res, 404, { error: 'This media resource is not available.', code: 'RELAY_RESOURCE' });
		const cls = resourceClass(target.resource, session.mode);
		if (!cls || !RESOURCE_CLASSES.has(cls) || !resourceAllowed(payload, cls)) return sendJson(res, 403, { error: 'This resource class is not allowed.', code: 'RELAY_RESOURCE_CLASS' });
		if (req.method === 'HEAD') {
			const isPlaylist = target.resource.endsWith('.m3u8');
			res.writeHead(200, { 'content-type': mediaType(target.resource), ...(isPlaylist ? {} : { 'accept-ranges': 'none' }) });
			return res.end();
		}
		const controller = new AbortController();
		session.controllers.add(controller); activeResponses.add(controller);
		res.on('close', () => { controller.abort(); session.controllers.delete(controller); activeResponses.delete(controller); });
		try {
			if (target.resource === 'subtitle.vtt') {
				const text = session.externalSubtitle || '';
				if (!text.trimStart().startsWith('WEBVTT')) { res.writeHead(404, { 'content-type': 'text/vtt' }); return res.end(); }
				bytesOutTotal += Buffer.byteLength(text); session.bytesOutTotal += Buffer.byteLength(text); session.resourcesServed++; resourcesServed++;
				res.writeHead(200, { 'content-type': 'text/vtt', 'content-length': Buffer.byteLength(text) });
				return res.end(text);
			}
			if (target.resource === 'file') {
				const upstreamResponse = await serveFile(req, res, session, controller.signal);
				if (!upstreamResponse.body) return res.end();
				await pipeline(Readable.fromWeb(upstreamResponse.body), async function* (source) { for await (const chunk of source) { bytesOutTotal += chunk.length; session.bytesOutTotal += chunk.length; session.lastResourceAt = clock(); yield chunk; } }, res, { signal: controller.signal });
				return;
			}
			const player = await ensureStarted(session, controller.signal);
			const body = await player.read(target.resource);
			if (target.resource.endsWith('.m3u8')) {
				const text = rewritePlaylist(body.toString(), target.token);
				bytesOutTotal += Buffer.byteLength(text); session.bytesOutTotal += Buffer.byteLength(text); session.resourcesServed++; resourcesServed++;
				session.lastResourceAt = clock();
				res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl', 'content-length': Buffer.byteLength(text) });
				return res.end(text);
			}
			bytesOutTotal += body.length; session.bytesOutTotal += body.length; session.resourcesServed++; resourcesServed++; session.lastResourceAt = clock();
			res.writeHead(200, { 'content-type': mediaType(target.resource), 'content-length': body.length });
			return res.end(body);
		} catch (error) {
			if (!res.headersSent) sendJson(res, error.status || 502, { error: error.status ? error.message : 'Relay media was interrupted.', code: error.code || 'RELAY_MEDIA' });
			else res.destroy();
		} finally { session.controllers.delete(controller); activeResponses.delete(controller); }
	}
	async function control(req, res, url) {
		let body;
		try {
			const text = (await readBody(req)).toString('utf8');
			body = text ? JSON.parse(text) : {};
			await authenticate(req, body);
		} catch (error) { return sendJson(res, error.status || 400, { error: error.message, code: error.code || 'RELAY_CONTROL' }); }
		if (url.pathname === '/internal/worker/prepare') {
			try { return sendJson(res, 200, await prepare(body)); } catch (error) { return sendJson(res, error.status || 500, { error: error.message, code: error.code || 'RELAY_PREPARE' }); }
		}
		if (url.pathname === '/internal/worker/activate') {
			const session = byLease.get(body.leaseId);
			if (!session || session.generation !== body.generation) return sendJson(res, 410, { error: 'This relay session has ended.', code: 'RELAY_SESSION_ENDED' });
			session.state = session.player ? 'active' : session.state;
			return sendJson(res, 200, { activated: true, activatedAt: session.activatedAt || 0, workerId });
		}
		if (url.pathname === '/internal/worker/replace') {
			const prior = byLease.get(body.leaseId);
			if (!prior) return sendJson(res, 410, { error: 'This relay session has ended.', code: 'RELAY_SESSION_ENDED' });
			try {
				const result = await prepare({ ...body, generation: body.generation, previousWorkerSessionId: body.previousWorkerSessionId }, { replacement: true });
				// Keep the old generation until the new first GET succeeds.
				result.replaced = prior.workerSessionId;
				return sendJson(res, 200, result);
			} catch (error) { return sendJson(res, error.status || 500, { error: error.message, code: error.code || 'RELAY_REPLACE' }); }
		}
		if (url.pathname === '/internal/worker/stop') {
			const session = byLease.get(body.leaseId);
			if (!session) return sendJson(res, 200, { stopped: true, already: true, workerId });
			await stopSession(session, body.reason || 'stopped');
			return sendJson(res, 200, { stopped: true, workerId });
		}
		return sendJson(res, 404, { error: 'Not found.' });
	}
	function mediaServer() {
		return http.createServer((req, res) => {
			const url = new URL(req.url, 'http://worker.invalid');
			if (!url.pathname.startsWith('/relay-media/')) return sendJson(res, 404, { error: 'Not found.' });
			media(req, res, url).catch(error => { if (!res.headersSent) sendJson(res, error.status || 500, { error: error.message, code: error.code || 'RELAY_MEDIA' }); else res.destroy(); });
		});
	}
	function controlServer() {
		return http.createServer((req, res) => {
			const url = new URL(req.url, 'http://worker.invalid');
			if (!url.pathname.startsWith('/internal/worker/')) return sendJson(res, 404, { error: 'Not found.' });
			control(req, res, url).catch(error => sendJson(res, error.status || 500, { error: error.message, code: error.code || 'RELAY_CONTROL' }));
		});
	}
	async function heartbeat() {
		if (!mainHeartbeatUrl || stopped) return { skipped: true };
		const leases = [...sessions.values()].filter(session => session.state !== 'stopped').map(session => ({
			leaseId: session.leaseId, generation: session.generation, seq: session.resourcesServed, bytesOutTotal: session.bytesOutTotal,
			resourcesServed: session.resourcesServed, activeResponses: session.controllers.size, lastResourceAt: session.lastResourceAt,
			resourceState: session.state, lastErrorCode: session.lastErrorCode
		}));
		const body = { workerId, workerInstance: instanceId, version, capabilities: ['live', 'nonstop', 'vod', 'recording', 'catchup'],
			health: { upstream: upstreamChecked ? upstreamHealthy : false, mainFresh: isMainFresh(), sessions: sessions.size, maxSessions },
			capacity: { sessions: sessions.size, maxSessions, ffmpegJobs: sessions.size, maxFfmpegJobs }, resources: { bytesOutTotal, resourcesServed },
			bytesOutTotal, leases };
		const path = new URL(mainHeartbeatUrl).pathname;
		const headers = { 'content-type': 'application/json', ...controlHeaders(workerPrivateKey, { method: 'POST', path, body, now: clock() }), ...(mainHeartbeatKeyId ? { 'x-relay-worker-id': workerId } : {}) };
		let response;
		try { response = await fetcher(mainHeartbeatUrl, { method: 'POST', headers, body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(5000) }); }
		catch { lastHeartbeatAt = clock(); return { ok: false }; }
		lastHeartbeatAt = clock();
		if (!response.ok) { await response.body?.cancel().catch(() => {}); return { ok: false, status: response.status }; }
		const data = await response.json().catch(() => ({}));
		lastMainOk = clock();
		for (const instruction of Array.isArray(data.instructions) ? data.instructions : []) {
			const session = byLease.get(instruction.leaseId);
			if (!session) continue;
			if (instruction.action === 'stop') { await stopSession(session, instruction.reason || 'main_stop'); continue; }
			if (instruction.action === 'renew' && Number.isFinite(instruction.grantSeconds)) {
				session.leaseUntil = Math.min(session.hardEndsAt || Infinity, clock() + Math.max(1, Math.min(300, instruction.grantSeconds)) * 1000);
			}
		}
		return { ok: true, instructions: data.instructions || [] };
	}
	async function upstreamCheck() {
		if (clock() - upstreamChecked < 30000) return;
		upstreamChecked = clock();
		try { await upstream.health(); upstreamHealthy = true; } catch { upstreamHealthy = false; }
	}
	function start() {
		upstreamCheck().catch(() => {});
		watchdogTimer = setInterval(() => {
			sweep();
			upstreamCheck().catch(() => {});
			if (mainCut() && activeResponses.size) for (const controller of activeResponses) { try { controller.abort(); } catch {} }
		}, 1000);
		watchdogTimer.unref?.();
		if (heartbeatEnabled && mainHeartbeatUrl) {
			setTimeout(() => { void heartbeat(); }, 50).unref?.();
			heartbeatTimer = setInterval(() => { void heartbeat(); }, heartbeatMs);
			heartbeatTimer.unref?.();
		}
	}
	async function close() {
		stopped = true;
		clearInterval(heartbeatTimer); clearInterval(watchdogTimer);
		await stopAll('worker_shutdown');
	}
	return { mediaServer, controlServer, heartbeat, start, close, status: () => ({ workerId, version, instance: instanceId, sessions: [...sessions.values()].map(sessionView), bytesOutTotal, resourcesServed, upstreamHealthy, mainFresh: isMainFresh(), lastMainOk }),
		prepare, _sessions: sessions, _byLease: byLease, _stopAll: stopAll };
}
