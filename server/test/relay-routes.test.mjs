import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { createWorkerRegistry } from '../relay-media/registry.mjs';

const channel = 'a'.repeat(36);
test('relay session never falls through to home media for share or cast; cast returns the relay address', async t => {
	const directory = mkdtempSync(path.join(os.tmpdir(), 'relay-routes-'));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const channelId = 'dispatch-live-' + channel;
	const upstream = express();
	upstream.get('/output/m3u', (req, res) => res.type('text/plain').send(`#EXTM3U\n#EXTINF:-1 tvg-id="x" group-title="TV",Test channel\nhttp://${req.headers.host}/proxy/ts/stream/${channel}\n`));
	upstream.get('/api/vod/movies/', (req, res) => res.json({ results: [] }));
	const dispatcharr = upstream.listen(0, '127.0.0.1'); await once(dispatcharr, 'listening');
	const dispatcharrUrl = 'http://127.0.0.1:' + dispatcharr.address().port;
	const prepared = [];
	const workerControl = express(); workerControl.use(express.json());
	workerControl.post('/internal/worker/prepare', (req, res) => { prepared.push(req.body); res.json({ workerSessionId: 'worker-session', sessionUrl: '/relay-media/v1/s/v1.fake.signature/index.m3u8', duration: 0, audio: [], subtitles: [] }); });
	workerControl.post('/internal/worker/replace', (req, res) => res.json({ workerSessionId: 'worker-session-2', sessionUrl: '/relay-media/v1/s/v1.fake.signature/index.m3u8' }));
	workerControl.post('/internal/worker/stop', (req, res) => res.json({ stopped: true }));
	const control = workerControl.listen(0, '127.0.0.1'); await once(control, 'listening');
	const registry = createWorkerRegistry(directory);
	const enrolment = registry.createEnrolment();
	const keys = generateKeyPairSync('ed25519');
	registry.enrol({ token: enrolment.token, workerId: 'worker-1', publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }),
		controlUrl: 'http://127.0.0.1:' + control.address().port, mediaPrefix: '/relay-media', version: '0.26.8' });
	registry.approve('worker-1'); registry.touch('worker-1', {});
	writeFileSync(path.join(directory, 'capabilities.json'), JSON.stringify({ library: false, live: true, nonstop: true, vod: true, recordings: true, catchup: true, discover: false, relayMedia: true }));
	Object.assign(process.env, { NODE_ENV: 'test', DATA_DIR: directory, AUTH_DIR: directory, DISPATCHARR_URL: dispatcharrUrl,
		PUBLIC_ORIGIN: 'https://watch.example.test', LOCAL_HOSTS: '127.0.0.1', LOCAL_NETWORKS: '127.0.0.0/8', LOCAL_PLAYBACK_ORIGIN: 'http://127.0.0.1:8082' });
	const front = express(); const server = front.listen(0, '127.0.0.1'); await once(server, 'listening');
	process.env.PORT = String(server.address().port);
	t.after(() => { server.closeAllConnections?.(); server.close(); control.closeAllConnections?.(); control.close(); dispatcharr.closeAllConnections?.(); dispatcharr.close(); });
	front.use((await import('../server.mjs')).app);
	const base = 'http://127.0.0.1:' + server.address().port;
	const page = await fetch(base + '/');
	const csp = page.headers.get('content-security-policy') || '';
	assert.match(csp, /media-src .*https:\/\/watch\.example\.test/);
	assert.match(csp, /connect-src .*https:\/\/watch\.example\.test/);
	assert.ok(!csp.includes('*'), 'CSP must not contain a wildcard');
	const post = (route, body) => fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify(body) });
	const capabilities = { videoCodecs: ['hevc'], audioCodecs: ['aac'], maxWidth: 3840, maxHeight: 2160, maxBitrate: 80000000, maxFps: 30, hevcMaxWidth: 1920, hevcMaxHeight: 1080, hevcMaxBitrate: 8000000, hevcMaxFps: 30, hevcMain10: true, hls: true, mpegTs: true };
	const play = await post('/api/play', { id: channelId, relayMedia: true, quality: 8000000, position: 30, capabilities });
	assert.equal(play.status, 200, await play.clone().text());
	const data = await play.json();
	assert.equal(data.mediaRoute, 'relay');
	assert.match(data.url, /\/relay-media\/v1\/s\//);
	assert.equal(prepared.length, 1);
	assert.deepEqual(prepared[0].capabilities, { ...capabilities, h264GeometryEvidence: true });
	const mainStream = await fetch(base + '/stream/' + data.session + '/index.m3u8');
	assert.equal(mainStream.status, 410, 'a relay session never serves main media bytes');
	const cast = await post('/api/sessions/' + data.session + '/cast', {});
	assert.equal(cast.status, 200);
	const castData = await cast.json();
	assert.equal(castData.relay, true);
	assert.equal(castData.url, data.url);
	assert.equal(castData.url.includes('/cast-stream/'), false);
	const share = await post('/api/shares', { id: channelId, hours: 24 });
	assert.equal(share.status, 201, await share.clone().text());
	const shareData = await share.json();
	const shared = await fetch(shareData.url.replace('https://watch.example.test', base) + '/play', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ id: channelId, relayMedia: true, quality: 8000000 }) });
	assert.equal(shared.status, 200);
	const sharedData = await shared.json();
	assert.equal(sharedData.mediaRoute, 'relay');
	assert.equal(sharedData.url.includes('/stream/'), false);
	assert.equal(prepared.length, 2);
	const oldClient = await post('/api/play', { id: channelId, quality: 8000000 });
	assert.equal(oldClient.status, 409);
	assert.equal((await oldClient.json()).code, 'RELAY_CLIENT_UNSUPPORTED');
	// Actual /api/play replacement contract: the effective ceiling is normalized
	// per mode and echoed, so an Auto client does not lose it on retry/seek.
	for (const [quality, expected] of [[0, 20000000], [1234, 20000000], [8000000, 8000000], [4000000, 4000000], [2000000, 2000000]]) {
		const response = await post('/api/play', { id: channelId, relayMedia: true, quality, replaceSession: data.session, position: 31 });
		assert.equal(response.status, 200, await response.clone().text());
		const body = await response.json();
		assert.equal(body.quality, expected, 'replacement quality for ' + quality);
		assert.equal(body.replaced, true);
	}
	const preserved = await post('/api/play', { id: channelId, relayMedia: true, replaceSession: data.session, position: 32 });
	assert.equal((await preserved.json()).quality, 2000000, 'absent replacement preserves the current ceiling');
});
