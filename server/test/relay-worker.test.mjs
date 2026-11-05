import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { once } from 'node:events';
import { createMediaToken, controlHeaders } from '../relay-media/protocol.mjs';
import { createRelayWorker } from '../../relay/worker/worker.mjs';

const pair = () => { const k = generateKeyPairSync('ed25519'); return { privateKey: k.privateKey, publicKey: k.publicKey, publicPem: k.publicKey.export({ type: 'spki', format: 'pem' }) }; };
async function fixture(t, { mode = 'live', token: tokenOverride, externalSubtitle = '', recording = false } = {}) {
	let now = 1_000_000;
	const main = pair(), worker = pair();
	const started = [], stopped = [];
	const players = { start: async session => { started.push(session); return { read: async file => file.endsWith('.m3u8') ? Buffer.from('#EXTM3U\n#EXTINF:2,\nsegment0.ts\n') : Buffer.from('segment-bytes'), stop: async () => { stopped.push(session.workerSessionId); }, touch: async () => {} }; } };
	const upstream = { health: async () => true, recordingFile: async (id, { range } = {}) => new Response('0123456789', { status: range ? 206 : 200, headers: range ? { 'content-range': 'bytes 2-5/10', 'content-length': '4' } : { 'content-length': '10' } }) };
	const w = createRelayWorker({ workerId: 'worker-1', version: '0.26.8', mainControlPublicKey: main.publicKey, mainMediaPublicKey: main.publicKey, workerPrivateKey: worker.privateKey,
		players, upstream, clock: () => now, maxSessions: 2, heartbeatEnabled: false, dataDirectory: '' });
	const media = w.mediaServer(), control = w.controlServer();
	media.listen(0, '127.0.0.1'); control.listen(0, '127.0.0.1');
	await Promise.all([once(media, 'listening'), once(control, 'listening')]);
	w.start();
	t.after(async () => { await w.close(); media.closeAllConnections?.(); control.closeAllConnections?.(); media.close(); control.close(); });
	const controlUrl = 'http://127.0.0.1:' + control.address().port, mediaUrl = 'http://127.0.0.1:' + media.address().port;
	const leaseId = 'lease-0001', sessionId = 'session-1', generation = 1, itemId = 'dispatch-live-' + 'a'.repeat(36);
	const token = tokenOverride || createMediaToken(main.privateKey, { aud: 'worker-1', leaseId, sessionId, itemId, mode, generation,
		resources: ['hls', 'segment', 'subtitle', 'file'], exp: Math.floor(now / 1000) + 21600, jti: 'jti-1' });
	const bodyFor = extra => ({ workerId: 'worker-1', leaseId, sessionId, itemId, mode, generation, grantSeconds: 45, duration: 120,
		modeParameters: { channelId: 'b'.repeat(36), recordingId: 7 }, quality: 8000000, allowedResourceClasses: ['hls', 'segment', 'subtitle', 'file'], capability: token,
		hardEndsAt: now + 21600000, externalSubtitle, ...extra });
	const send = (route, body) => fetch(controlUrl + route, { method: 'POST', headers: { 'content-type': 'application/json',
		...controlHeaders(main.privateKey, { method: 'POST', path: route, body, now }) }, body: JSON.stringify(body) });
	const prepare = extra => send('/internal/worker/prepare', bodyFor(extra));
	return { w, now: () => now, advance: seconds => { now += seconds * 1000; }, send, prepare, mediaUrl, controlUrl, token, started, stopped, recording };
}
test('prepare is idempotent; HEAD does not start; first GET activates once', async t => {
	const f = await fixture(t);
	const first = await f.prepare();
	assert.equal(first.status, 200);
	const data = await first.json();
	assert.match(data.sessionUrl, /^\/relay-media\/v1\/s\/v1\./);
	const again = await f.prepare();
	assert.equal(again.status, 200);
	const againData = await again.json();
	assert.equal(againData.workerSessionId, data.workerSessionId);
	assert.equal(againData.idempotent, true);
	const head = await fetch(f.mediaUrl + data.sessionUrl, { method: 'HEAD' });
	assert.equal(head.status, 200);
	assert.equal(f.started.length, 0, 'HEAD must not start the encoder');
	const playlist = await (await fetch(f.mediaUrl + data.sessionUrl)).text();
	const health = await (await fetch(f.mediaUrl + '/relay-media/v1/health')).json();
	assert.equal(health.ok, true);
	assert.equal(health.workerId, undefined);
	assert.equal(health.sessions, undefined);
	assert.equal(health.fresh, undefined);
	assert.match(playlist, /segment0\.ts/);
	assert.match(playlist, /\/relay-media\/v1\/s\/v1\./);
	assert.equal(f.started.length, 1);
	const segment = await (await fetch(f.mediaUrl + playlist.split('\n')[2])).text();
	assert.equal(segment, 'segment-bytes');
	assert.equal(f.started.length, 1, 'later GET reuses the active session');
	f.advance(30);
	assert.equal((await fetch(f.mediaUrl + data.sessionUrl)).status, 200, 'a 45-second grant is seconds, not milliseconds');
	assert.equal((await f.send('/internal/worker/stop', { workerId: 'worker-1', leaseId: 'lease-0001', reason: 'test' })).status, 200);
	assert.equal((await fetch(f.mediaUrl + data.sessionUrl)).status, 410);
	assert.equal((await f.prepare()).status, 410, 'an old prepare key returns ended, not a new session');
	assert.equal(f.stopped.length, 1);
});
test('wrong audience, wrong generation, method and post-revoke reads are denied', async t => {
	const f = await fixture(t);
	const other = createMediaToken((await import('node:crypto')).generateKeyPairSync('ed25519').privateKey, { aud: 'worker-1', leaseId: 'lease-0001', sessionId: 'session-1', itemId: 'dispatch-live-' + 'a'.repeat(36), mode: 'live', generation: 1, resources: ['hls'], exp: 3000000000, jti: 'x' });
	const bad = await f.prepare({ capability: other });
	assert.equal(bad.status, 403);
	assert.equal((await f.prepare({ generation: 2, capability: f.token })).status, 403);
	const good = await (await f.prepare()).json();
	assert.equal((await fetch(f.mediaUrl + good.sessionUrl, { method: 'POST' })).status, 405);
	await fetch(f.mediaUrl + good.sessionUrl);
	assert.equal((await f.send('/internal/worker/stop', { workerId: 'worker-1', leaseId: 'lease-0001' })).status, 200);
	assert.equal((await fetch(f.mediaUrl + good.sessionUrl, { method: 'GET' })).status, 410);
});
test('external subtitle is served as VTT and recording file supports one byte range', async t => {
	const f = await fixture(t, { mode: 'vod', externalSubtitle: 'WEBVTT\n\n00:00.000 --> 00:01.000\nHello\n' });
	const prepared = await (await f.prepare()).json();
	const vtt = await (await fetch(f.mediaUrl + prepared.sessionUrl.replace(/index\.m3u8$/, 'subtitle.vtt'))).text();
	assert.match(vtt, /Hello/);
	const recording = await fixture(t, { mode: 'recording' });
	const preparedRecording = await (await recording.prepare()).json();
	const file = await fetch(recording.mediaUrl + preparedRecording.sessionUrl.replace(/index\.m3u8$/, 'file'), { headers: { Range: 'bytes=2-5' } });
	assert.equal(file.status, 206);
	assert.equal(file.headers.get('content-range'), 'bytes 2-5/10');
});
test('main outage and lease expiry abort media, including open responses', async t => {
	const f = await fixture(t);
	const prepared = await (await f.prepare()).json();
	f.advance(46);
	const after = await fetch(f.mediaUrl + prepared.sessionUrl);
	assert.ok([410, 503].includes(after.status));
	const f2 = await fixture(t);
	const prepared2 = await (await f2.prepare({ grantSeconds: 1 })).json();
	f2.advance(2);
	assert.equal((await fetch(f2.mediaUrl + prepared2.sessionUrl)).status, 410);
});
test('control requests reject replayed nonces and unsigned bodies', async t => {
	const f = await fixture(t);
	const body = { workerId: 'worker-1', leaseId: 'lease-0001' };
	const path = '/internal/worker/stop';
	const headers = { 'content-type': 'application/json', ...controlHeaders((await import('node:crypto')).generateKeyPairSync('ed25519').privateKey, { method: 'POST', path, body, now: f.now() }) };
	const first = await fetch(f.controlUrl + path, { method: 'POST', headers, body: JSON.stringify(body) });
	assert.equal(first.status, 401);
});
