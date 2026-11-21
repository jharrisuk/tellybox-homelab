import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { createWorkerRegistry } from '../relay-media/registry.mjs';

function xmltvTime(date) {
	const p = n => String(n).padStart(2, '0');
	return `${date.getUTCFullYear()}${p(date.getUTCMonth()+1)}${p(date.getUTCDate())}${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())} +0000`;
}

test('catch-up relay initial and replacement requests echo the effective quality rung', async t => {
	const directory = mkdtempSync(path.join(os.tmpdir(), 'relay-catchup-quality-'));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const uuid = '7b884ef9-dd6d-4202-848d-cfd7f5cc52c3';
	const start = new Date(Date.now() - 3600000), end = new Date(Date.now() - 600000);
	const xml = `<?xml version="1.0"?><tv><channel id="c4"><display-name>Channel 4</display-name></channel><programme start="${xmltvTime(start)}" stop="${xmltvTime(end)}" channel="c4"><title>Quality Programme</title><desc>Fixture</desc></programme></tv>`;
	const upstream = express();
	upstream.get('/output/m3u', (req, res) => res.type('text/plain').send(`#EXTM3U\n#EXTINF:-1 tvg-id="c4" group-title="Entertainment",CHANNEL 4\nhttp://${req.headers.host}/proxy/ts/stream/${uuid}\n`));
	upstream.get('/output/epg', (req, res) => res.type('application/xml').send(xml));
	upstream.get('/api/channels/channels/', (req, res) => res.json({ results: [{ uuid, name: 'CHANNEL 4', is_catchup: true, catchup_days: 7, is_nonstop: false }] }));
	const dispatcharr = upstream.listen(0, '127.0.0.1'); await once(dispatcharr, 'listening');
	const dispatcharrUrl = 'http://127.0.0.1:' + dispatcharr.address().port;
	const prepared = [];
	const workerControl = express(); workerControl.use(express.json());
	workerControl.post('/internal/worker/prepare', (req, res) => { prepared.push(req.body); res.json({ workerSessionId: 'catchup-session', sessionUrl: '/relay-media/v1/s/v1.fake/index.m3u8', duration: 3000, audio: [], subtitles: [], quality: req.body.quality }); });
	workerControl.post('/internal/worker/replace', (req, res) => res.json({ workerSessionId: 'catchup-session-2', sessionUrl: '/relay-media/v1/s/v1.fake/index.m3u8', duration: 3000, audio: [], subtitles: [], quality: req.body.quality }));
	workerControl.post('/internal/worker/stop', (req, res) => res.json({ stopped: true }));
	const control = workerControl.listen(0, '127.0.0.1'); await once(control, 'listening');
	const registry = createWorkerRegistry(directory);
	const enrolment = registry.createEnrolment();
	const keys = generateKeyPairSync('ed25519');
	registry.enrol({ token: enrolment.token, workerId: 'worker-catchup', publicKey: keys.publicKey.export({ type: 'spki', format: 'pem' }),
		controlUrl: 'http://127.0.0.1:' + control.address().port, mediaPrefix: '/relay-media', version: '0.26.13', capabilities: ['catchup'] });
	registry.approve('worker-catchup'); registry.touch('worker-catchup', {});
	writeFileSync(path.join(directory, 'capabilities.json'), JSON.stringify({ library: false, live: true, recordings: true, catchup: true, relayMedia: true }));
	writeFileSync(path.join(directory, 'dispatcharr.json'), JSON.stringify({ key: 'test-key' }));
	Object.assign(process.env, { NODE_ENV: 'test', DATA_DIR: directory, AUTH_DIR: directory, DISPATCHARR_URL: dispatcharrUrl,
		PUBLIC_ORIGIN: 'https://watch.example.test', LOCAL_HOSTS: '127.0.0.1', LOCAL_NETWORKS: '127.0.0.0/8', LOCAL_PLAYBACK_ORIGIN: 'http://127.0.0.1:8082' });
	const front = express(); const server = front.listen(0, '127.0.0.1'); await once(server, 'listening');
	process.env.PORT = String(server.address().port);
	t.after(() => { server.closeAllConnections?.(); server.close(); control.closeAllConnections?.(); control.close(); dispatcharr.closeAllConnections?.(); dispatcharr.close(); });
	front.use((await import('../server.mjs')).app);
	const base = 'http://127.0.0.1:' + server.address().port;
	const post = (route, body) => fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify(body) });
	const itemId = `catchup-${uuid}-${Math.floor(start.getTime() / 1000) * 1000}`;
	const initial = await post('/api/play', { id: itemId, relayMedia: true, quality: 0, position: 0 });
	assert.equal(initial.status, 200, await initial.clone().text());
	const first = await initial.json();
	assert.equal(first.quality, 8000000, 'catch-up 0 uses the 8 Mbps default');
	for (const [quality, expected] of [[1234, 8000000], [2000000, 2000000], [4000000, 4000000], [0, 8000000], [2000000, 2000000]]) {
		const response = await post('/api/play', { id: itemId, relayMedia: true, quality, replaceSession: first.session, position: 10 });
		assert.equal(response.status, 200, await response.clone().text());
		assert.equal((await response.json()).quality, expected, 'catch-up replacement quality for ' + quality);
	}
	const preserved = await post('/api/play', { id: itemId, relayMedia: true, replaceSession: first.session, position: 20 });
	assert.equal((await preserved.json()).quality, 2000000, 'catch-up absent replacement preserves the current ceiling');
});
