import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { createWorkerRegistry } from '../relay-media/registry.mjs';

// Actual /api/play request bodies through the real prepareVod and replacement
// routes, with a scripted worker control peer that plays the worker's part:
// copy when the forwarded capabilities are usable and no compatibility retry
// is requested, otherwise transcode.
const sanitized = { videoCodecs: ['h264', 'hevc'], audioCodecs: ['aac'], maxWidth: 1920, maxHeight: 1080, maxBitrate: 20000000, maxFps: 30,
	hevcMaxWidth: 1920, hevcMaxHeight: 1080, hevcMaxBitrate: 8000000, hevcMaxFps: 30, hevcMain10: false, hls: true, mpegTs: true };

test('initial and replacement VOD requests sanitize, forward and preserve capabilities; compatibility forces transcode', async t => {
	const directory = mkdtempSync(path.join(os.tmpdir(), 'consolidation-123-route-'));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const uuid = 'c'.repeat(36);
	const movie = { id: 1, name: 'Capability Film', uuid, type: 'movie' };
	const upstream = express();
	upstream.get('/api/vod/movies/1/', (req, res) => res.json(movie));
	upstream.get('/api/vod/movies/', (req, res) => res.json({ results: [movie] }));
	upstream.get('/api/vod/movies/1/provider-info/', (req, res) => res.json({}));
	const dispatcharr = upstream.listen(0, '127.0.0.1'); await once(dispatcharr, 'listening');
	const dispatcharrUrl = 'http://127.0.0.1:' + dispatcharr.address().port;
	const prepared = [], replaced = [];
	const workerControl = express(); workerControl.use(express.json());
	const workerView = body => {
		const compatibility = body.modeParameters?.compatibility === true;
		const copy = Boolean(body.capabilities) && !compatibility;
		return { workerSessionId: 'vod-session', sessionUrl: '/relay-media/v1/s/v1.fake/index.m3u8', duration: 120, audio: [], subtitles: [],
			subtitleIndex: -1, method: copy ? 'Copy' : 'Transcode', videoCodec: copy ? 'hevc' : 'h264', audioCodec: 'aac',
			position: body.position, quality: body.quality };
	};
	workerControl.post('/internal/worker/prepare', (req, res) => { prepared.push(req.body); res.json(workerView(req.body)); });
	workerControl.post('/internal/worker/replace', (req, res) => { replaced.push(req.body); res.json(workerView(req.body)); });
	workerControl.post('/internal/worker/stop', (req, res) => res.json({ stopped: true }));
	const control = workerControl.listen(0, '127.0.0.1'); await once(control, 'listening');
	const registry = createWorkerRegistry(directory);
	const enrolment = registry.createEnrolment();
	const keys = generateKeyPairSync('ed25519');
	registry.enrol({ token: enrolment.token, workerId: 'worker-vod', publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }),
		controlUrl: 'http://127.0.0.1:' + control.address().port, mediaPrefix: '/relay-media', version: '0.26.13', capabilities: ['vod'] });
	registry.approve('worker-vod'); registry.touch('worker-vod', {});
	writeFileSync(path.join(directory, 'capabilities.json'), JSON.stringify({ library: false, vod: true, relayMedia: true }));
	writeFileSync(path.join(directory, 'dispatcharr.json'), JSON.stringify({ key: 'test-key' }));
	Object.assign(process.env, { NODE_ENV: 'test', DATA_DIR: directory, AUTH_DIR: directory, DISPATCHARR_URL: dispatcharrUrl,
		PUBLIC_ORIGIN: 'https://watch.example.test', LOCAL_HOSTS: '127.0.0.1', LOCAL_NETWORKS: '127.0.0.0/8', LOCAL_PLAYBACK_ORIGIN: 'http://127.0.0.1:8082' });
	const front = express(); const server = front.listen(0, '127.0.0.1'); await once(server, 'listening');
	process.env.PORT = String(server.address().port);
	t.after(() => { server.closeAllConnections?.(); server.close(); control.closeAllConnections?.(); control.close(); dispatcharr.closeAllConnections?.(); dispatcharr.close(); });
	front.use((await import('../server.mjs')).app);
	const base = 'http://127.0.0.1:' + server.address().port;
	const post = (route, body) => fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify(body) });
	const id = 'dispatch-movie-1';

	// Initial: a valid payload is sanitized (junk fields and unlisted codecs
	// dropped, defaults filled) and forwarded to the worker lease.
	const initial = await post('/api/play', { id, relayMedia: true, quality: 20000000, position: 0,
		capabilities: { videoCodecs: ['h264', 'hevc', 'vp9'], audioCodecs: ['aac'], maxWidth: 1920, maxHeight: 1080, maxBitrate: 20000000,
			hls: true, mpegTs: true, junk: 'dropped' } });
	assert.equal(initial.status, 200, await initial.clone().text());
	const first = await initial.json();
	assert.equal(first.quality, 20000000);
	assert.equal(first.method, 'Copy', 'initial VOD reports the worker copy method');
	assert.equal(first.videoCodec, 'hevc');
	assert.equal(first.audioCodec, 'aac');
	assert.equal(first.conversionReason, 'Provider stream copied without re-encoding');
	assert.doesNotMatch(first.conversionReason, /https?:|token|capability/i);
	assert.equal(prepared.length, 1);
	assert.deepEqual(prepared[0].capabilities, sanitized, 'the worker lease receives the sanitized capabilities');
	assert.equal(prepared[0].modeParameters.compatibility, false);

	// Initial invalid capabilities fail closed: the worker sees null and transcodes.
	const invalid = await post('/api/play', { id, relayMedia: true, capabilities: { videoCodecs: ['vp9'], audioCodecs: ['aac'] } });
	assert.equal(invalid.status, 200, await invalid.clone().text());
	assert.equal((await invalid.json()).method, 'Transcode');
	assert.equal(prepared.at(-1).capabilities, null, 'invalid capabilities become null, not raw client bytes');

	// Initial absent capabilities keep the legacy transcode path.
	const absent = await post('/api/play', { id, relayMedia: true });
	assert.equal(absent.status, 200, await absent.clone().text());
	assert.equal((await absent.json()).method, 'Transcode');
	assert.equal(prepared.at(-1).capabilities, undefined);

	// Compatibility retry: same owner/session, position preserved, quality
	// ceiling preserved, capabilities retained on the lease, and the worker
	// modeParameters flip to compatibility so it must transcode.
	const compat = await post('/api/play', { id, relayMedia: true, replaceSession: first.session, compatibility: true, position: 123 });
	assert.equal(compat.status, 200, await compat.clone().text());
	const compatBody = await compat.json();
	assert.equal(compatBody.session, first.session, 'the same session is replaced, not recreated');
	assert.equal(compatBody.method, 'Transcode', 'the replacement response reflects the forced transcode');
	assert.equal(compatBody.videoCodec, 'h264');
	assert.equal(compatBody.conversionReason, 'Provider source converted for this device');
	assert.equal(compatBody.position, 123, 'the decoder fallback position is preserved');
	assert.equal(compatBody.quality, 20000000, 'the quality ceiling is preserved across the replacement');
	assert.equal(replaced.length, 1);
	assert.equal(replaced[0].modeParameters.compatibility, true, 'the worker receives the compatibility retry');
	assert.deepEqual(replaced[0].capabilities, sanitized, 'the old session retains its capabilities through replacement');
	assert.equal(replaced[0].position, 123);
	assert.equal(replaced[0].quality, 20000000);

	// A later replacement without compatibility must not drop the forced
	// transcode, and an explicit new capability claim must not override it.
	const again = await post('/api/play', { id, relayMedia: true, replaceSession: first.session, position: 200,
		capabilities: { videoCodecs: ['hevc'], audioCodecs: ['aac'], hls: true, mpegTs: true } });
	assert.equal(again.status, 200, await again.clone().text());
	const againBody = await again.json();
	assert.equal(againBody.session, first.session);
	assert.equal(againBody.method, 'Transcode', 'a capability claim cannot override compatibility:true');
	assert.equal(againBody.position, 200);
	assert.equal(againBody.quality, 20000000);
	assert.equal(againBody.conversionReason, 'Provider source converted for this device');
	assert.equal(replaced.at(-1).modeParameters.compatibility, true, 'compatibility persists on the lease until explicitly changed');
	assert.deepEqual(replaced.at(-1).capabilities, { videoCodecs: ['hevc'], audioCodecs: ['aac'], maxWidth: 1920, maxHeight: 1080,
		maxBitrate: 8000000, maxFps: 30, hevcMaxWidth: 1920, hevcMaxHeight: 1080, hevcMaxBitrate: 8000000, hevcMaxFps: 30,
		hevcMain10: false, hls: true, mpegTs: true }, 'a replacement may refresh the capabilities');
	assert.equal(prepared.length, 3, 'no new session was created for any replacement');
	assert.equal(replaced[0].workerId, prepared[0].workerId, 'the same approved worker serves the replacement');

	// A replacement without a position must keep the current position.
	const keepPosition = await post('/api/play', { id, relayMedia: true, replaceSession: first.session });
	assert.equal(keepPosition.status, 200, await keepPosition.clone().text());
	const keepPositionBody = await keepPosition.json();
	assert.equal(keepPositionBody.position, 200, 'an absent replacement position preserves the lease position');
	assert.equal(keepPositionBody.conversionReason, 'Provider source converted for this device');
	assert.equal(replaced.at(-1).position, 200, 'the worker receives the preserved position');
});
