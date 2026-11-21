import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { createWorkerRegistry } from '../relay-media/registry.mjs';

test('VOD relay initial and replacement requests echo the effective quality rung', async t => {
	const directory = mkdtempSync(path.join(os.tmpdir(), 'relay-vod-quality-'));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const uuid = 'c'.repeat(36);
	const movie = { id: 1, name: 'Quality Film', uuid, type: 'movie' };
	const upstream = express();
	upstream.get('/api/vod/movies/1/', (req, res) => res.json(movie));
	upstream.get('/api/vod/movies/', (req, res) => res.json({ results: [movie] }));
	upstream.get('/api/vod/movies/1/provider-info/', (req, res) => res.json({}));
	const dispatcharr = upstream.listen(0, '127.0.0.1'); await once(dispatcharr, 'listening');
	const dispatcharrUrl = 'http://127.0.0.1:' + dispatcharr.address().port;
	const prepared = [];
	const workerControl = express(); workerControl.use(express.json());
	workerControl.post('/internal/worker/prepare', (req, res) => {
		prepared.push(req.body);
		res.json({ workerSessionId: 'vod-session', sessionUrl: '/relay-media/v1/s/v1.fake/index.m3u8', duration: 120, audio: [], subtitles: [], quality: req.body.quality });
	});
	workerControl.post('/internal/worker/replace', (req, res) => res.json({ workerSessionId: 'vod-session-2', sessionUrl: '/relay-media/v1/s/v1.fake/index.m3u8', duration: 120, audio: [], subtitles: [], quality: req.body.quality }));
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
	const initial = await post('/api/play', { id: 'dispatch-movie-1', relayMedia: true, quality: 0, position: 0 });
	assert.equal(initial.status, 200, await initial.clone().text());
	const first = await initial.json();
	assert.equal(first.quality, 8000000, 'VOD 0 uses the 8 Mbps default');
	assert.equal(prepared.at(-1).quality, 8000000);
	for (const [quality, expected] of [[1234, 8000000], [2000000, 2000000], [4000000, 4000000], [0, 8000000], [2000000, 2000000]]) {
		const response = await post('/api/play', { id: 'dispatch-movie-1', relayMedia: true, quality, replaceSession: first.session, position: 10 });
		assert.equal(response.status, 200, await response.clone().text());
		assert.equal((await response.json()).quality, expected, 'VOD replacement quality for ' + quality);
	}
	const preserved = await post('/api/play', { id: 'dispatch-movie-1', relayMedia: true, replaceSession: first.session, position: 20 });
	assert.equal((await preserved.json()).quality, 2000000, 'VOD absent replacement preserves the current ceiling');
});
