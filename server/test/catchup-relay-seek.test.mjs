import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { createRelayWorker } from '../../relay/worker/worker.mjs';
import { createWorkerPlayers } from '../../relay/worker/players.mjs';
import { controlHeaders, createMediaToken } from '../relay-media/protocol.mjs';

const ffmpeg = spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0;
const workerId = 'relay-worker-test';
const itemStart = Date.parse('2026-11-05T20:00:00Z');
const item = { Id: 'catchup-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa-1793912400000',
	StartDate: new Date(itemStart).toISOString(), EndDate: new Date(itemStart + 600000).toISOString(), Name: 'Worker seek fixture' };
const channel = { id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' };
const segmentSeconds = 4;

function run(command, args, options = {}) {
	const result = spawnSync(command, args, { maxBuffer: 256 * 1024 * 1024, timeout: 120000, ...options });
	assert.equal(result.status, 0, command + ': ' + (result.error || result.stderr));
	return result.stdout;
}
function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function listen(server) {
	return new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => resolve(server.address().port));
	});
}
function close(server) { return new Promise(resolve => server.close(() => resolve())); }
function pem(key) { return key.publicKey.export({ type: 'spki', format: 'pem' }); }

/**
 * A fixture whose luma encodes the four-second segment index in eight
 * vertical bits. That lets the test prove the returned bytes really are the
 * requested part of the programme, not merely that a TS file decoded.
 */
function buildFixture(file) {
	const expression = "geq=lum='20+200*mod(floor(floor(T/4)/pow(2,floor(X*8/W))),2)':cb=128:cr=128,format=yuv420p";
	run('ffmpeg', ['-v', 'error', '-y',
		'-f', 'lavfi', '-i', 'color=c=black:s=160x90:r=25',
		'-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo',
		'-vf', expression, '-c:v', 'libx264', '-preset', 'ultrafast', '-threads', '2',
		'-g', '25', '-keyint_min', '25', '-sc_threshold', '0', '-c:a', 'aac', '-b:a', '64k',
		'-t', '600', '-f', 'mpegts', file]);
}
function segmentIndex(bytes, directory, serial) {
	const bufferFile = path.join(directory, 'segment-' + serial + '.ts');
	writeFileSync(bufferFile, bytes);
	const probe = JSON.parse(run('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,width,height,start_time',
		'-of', 'json', bufferFile]));
	const video = probe.streams.find(stream => stream.codec_type === 'video');
	const audio = probe.streams.find(stream => stream.codec_type === 'audio');
	assert.ok(video, 'The replaced segment must contain decodable video');
	assert.ok(audio, 'The replaced segment must contain decodable audio');
	const width = Number(video.width), height = Number(video.height);
	const raw = run('ffmpeg', ['-v', 'error', '-i', bufferFile, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'gray', '-']);
	let index = 0;
	for (let bit = 0; bit < 8; bit++) {
		const x = Math.floor(width * (bit + 0.5) / 8), y = Math.floor(height / 2);
		if (raw[y * width + x] > 120) index |= 1 << bit;
	}
	return { index, videoStart: Number(video.start_time), audioStart: Number(audio.start_time) };
}
test('relay catch-up replacement decodes the requested forward and backward position', { skip: !ffmpeg, timeout: 240000 }, async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), 'tellybox-relay-seek-test-'));
	const heartbeat = http.createServer((req, res) => {
		let body = '';
		req.on('data', chunk => { body += chunk; });
		req.on('end', () => {
			let leases = [];
			try { leases = JSON.parse(body).leases || []; } catch {}
			res.writeHead(200, { 'content-type': 'application/json' });
			res.end(JSON.stringify({ instructions: leases.map(lease => ({ leaseId: lease.leaseId, action: 'renew', grantSeconds: 45 })) }));
		});
	});
	let mediaServer, controlServer, worker;
	try {
		const source = path.join(directory, 'fixture.ts');
		buildFixture(source);
		const slices = new Map();
		const upstream = {
			origin: 'http://127.0.0.1:9', health: async () => true,
			catchupSession: async (channelId, start, minutes) => {
				assert.equal(channelId, channel.id);
				const base = (Date.parse(start) - itemStart) / 1000;
				assert.equal(base % 60, 0, 'The provider is opened at the containing minute boundary');
				if (!slices.has(base)) {
					// A real Dispatcharr catch-up stream carries an absolute PTS
					// (observed around 51060s), not a zero-based one. Keep that
					// property so the worker's timestamp normalisation is tested.
					slices.set(base, run('ffmpeg', ['-v', 'error', '-ss', String(base), '-i', source,
						'-t', String(Math.max(8, minutes * 60)), '-c', 'copy', '-output_ts_offset', '50000',
						'-f', 'mpegts', 'pipe:1']));
				}
				return { open: async () => new Response(slices.get(base)), stop: async () => {} };
			}
		};
		const players = createWorkerPlayers({ upstream, maxSessions: 3, paceInput: false });
		const mainControl = generateKeyPairSync('ed25519');
		const mainMedia = generateKeyPairSync('ed25519');
		const workerKeys = generateKeyPairSync('ed25519');
		const heartbeatPort = await listen(heartbeat);
		worker = createRelayWorker({
			workerId, version: 'test', instance: 'relay-seek-test',
			mainControlPublicKey: pem(mainControl), mainMediaPublicKey: pem(mainMedia), workerPrivateKey: workerKeys.privateKey,
			dataDirectory: directory, players, upstream, heartbeatMs: 500, freshnessMs: 15000,
			mainHeartbeatUrl: 'http://127.0.0.1:' + heartbeatPort + '/heartbeat', mainHeartbeatKeyId: 'main-test',
			maxSessions: 3, maxFfmpegJobs: 3
		});
		worker.start();
		mediaServer = worker.mediaServer();
		controlServer = worker.controlServer();
		const mediaPort = await listen(mediaServer), controlPort = await listen(controlServer);
		for (let attempt = 0; attempt < 50 && !worker.status().mainFresh; attempt++) await sleep(100);
		assert.equal(worker.status().mainFresh, true, 'The worker must accept valid heartbeats before playback');

		const sessionId = 'session-' + randomUUID();
		const leaseId = randomUUID();
		let generation = 0, current = null, serial = 0;
		const token = gen => createMediaToken(mainMedia.privateKey, {
			aud: workerId, leaseId, sessionId, itemId: item.Id, mode: 'catchup', generation: gen,
			resources: ['hls', 'segment', 'file', 'subtitle'], iat: Math.floor(Date.now() / 1000),
			exp: Math.floor(Date.now() / 1000) + 600, jti: randomUUID()
		});
		const prepareBody = (position, gen) => ({
			workerId, leaseId, workerSessionId: '', accountKeyHash: 'a'.repeat(32), itemId: item.Id, mode: 'catchup',
			modeParameters: { channelId: channel.id, item }, quality: 8000000, position, capability: token(gen),
			generation: gen, grantSeconds: 2, hardEndsAt: Date.now() + 600000, duration: 0, audio: [], subtitles: [],
			needsMetadata: false, allowedResourceClasses: ['hls', 'segment', 'file', 'subtitle']
		});
		const media = async (url, suffix) => {
			const response = await fetch('http://127.0.0.1:' + mediaPort + url.replace(/index\.m3u8$/, suffix));
			return { status: response.status, body: Buffer.from(await response.arrayBuffer()) };
		};
		const playlist = async url => (await media(url, 'index.m3u8')).body.toString();
		async function expectSegment(position, label) {
			const segment = Math.floor(position / segmentSeconds);
			const response = await media(current.url, 'segment' + String(segment).padStart(9, '0') + '.ts');
			assert.equal(response.status, 200, label + ': segment ' + segment + ' must be available');
			const decoded = segmentIndex(response.body, directory, serial++);
			// The provider starts at the containing minute and its first frame can
			// be up to one keyframe before the exact segment boundary. The
			// requested position must still decode in this segment or the one
			// immediately before it.
			assert.ok(Math.abs(decoded.index - segment) <= 1,
				label + ': returned bytes must be the requested programme section (' + decoded.index + ' vs ' + segment + ')');
			assert.ok(Math.abs(decoded.audioStart - decoded.videoStart) < 0.5,
				label + ': audible and visible timelines must stay together (' + decoded.audioStart + ' vs ' + decoded.videoStart + ')');
		}
		async function replace(position) {
			const previousToken = current.url;
			const previousWorkerSessionId = current.workerSessionId;
			const gen = ++generation;
			const body = { ...prepareBody(position * 1000, gen), previousWorkerSessionId };
			const headers = { 'content-type': 'application/json', ...controlHeaders(mainControl.privateKey, {
				method: 'POST', path: '/internal/worker/replace', body, now: Date.now()
			}) };
			const response = await fetch('http://127.0.0.1:' + controlPort + '/internal/worker/replace',
				{ method: 'POST', headers, body: JSON.stringify(body) });
			const result = await response.json();
			assert.equal(response.status, 200, JSON.stringify(result));
			current = { url: result.sessionUrl, workerSessionId: result.workerSessionId, generation: gen };
			return { result, previousToken };
		}

		// Initial resume at a nonzero position.
		generation = 1;
		const prepared = await worker.prepare(prepareBody(400000, generation));
		current = { url: prepared.sessionUrl, workerSessionId: prepared.workerSessionId, generation };
		assert.equal(prepared.position, 400000);
		assert.match(await playlist(current.url), /#EXT-X-START:TIME-OFFSET=400,PRECISE=YES/);
		// The lease grant is two seconds; the heartbeat loop must renew it before
		// media is requested or the worker correctly returns 410.
		await sleep(3000);
		await expectSegment(400, 'initial resume');

		// Same-lease replacement backwards, then forwards, then repeated.
		const backward = await replace(40);
		assert.equal(backward.result.position, 40000);
		const stale = await media(backward.previousToken, 'index.m3u8');
		assert.equal(stale.status, 410, 'The superseded generation must not serve media');
		await expectSegment(40, 'backward replacement');
		await replace(400);
		await expectSegment(400, 'forward replacement');
		await replace(240);
		await expectSegment(240, 'repeated replacement one');
		await replace(40);
		await expectSegment(40, 'repeated replacement two');
		await replace(480);
		await expectSegment(480, 'repeated replacement three');

		// A segment outside the current encode section must be re-encoded, not
		// served from the previous section's cache.
		await expectSegment(100, 'stale segment request');
		await expectSegment(20, 'stale segment request back');
		await expectSegment(480, 'stale segment request forward');

		// The old generation stays dead after the new session has started.
		assert.equal((await media(backward.previousToken, 'index.m3u8')).status, 410);

		// A signed stop ends the lease and media is no longer served.
		const stopBody = { workerId, leaseId, sessionId, workerSessionId: current.workerSessionId, reason: 'test_done' };
		const stopHeaders = { 'content-type': 'application/json', ...controlHeaders(mainControl.privateKey, {
			method: 'POST', path: '/internal/worker/stop', body: stopBody, now: Date.now()
		}) };
		const stopped = await fetch('http://127.0.0.1:' + controlPort + '/internal/worker/stop',
			{ method: 'POST', headers: stopHeaders, body: JSON.stringify(stopBody) });
		assert.equal(stopped.status, 200);
		assert.equal((await media(current.url, 'index.m3u8')).status, 410);
	} finally {
		await worker?.close().catch(() => {});
		for (const server of [mediaServer, controlServer, heartbeat]) if (server?.listening) await close(server);
		await rm(directory, { recursive: true, force: true });
	}
});
