import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { createRelayMediaService } from '../relay-media/install.mjs';
import { createRelayWorker } from '../../relay/worker/worker.mjs';

test('main prepares a scoped relay lease; worker serves bytes; main never carries media', async t => {
	const directory = mkdtempSync(path.join(os.tmpdir(), 'relay-main-worker-'));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	let now = 1_000_000;
	const charged = [];
	const accountKey = 'person:' + 'a'.repeat(32);
	const accountLimits = { key: () => accountKey, status: () => ({ minutes: 0, seconds: 0, dailyMinutes: 0, dailySeconds: 0 }),
		viewing: () => ({ remainingSeconds: null }), charge: (key, seconds) => charged.push({ key, seconds }) };
	const service = createRelayMediaService({ directory, accountLimits, clock: () => now, publicOrigin: 'https://watch.example.test' });
	const enrolment = service.registry.createEnrolment();
	const workerKeys = generateKeyPairSync('ed25519');
	let started = 0, stopped = 0;
	const worker = createRelayWorker({ workerId: 'relay-worker-1', mainControlPublicKey: (await import('../relay-media/protocol.mjs')).readPublicKey(service.keys.control.publicPem),
		mainMediaPublicKey: (await import('../relay-media/protocol.mjs')).readPublicKey(service.keys.media.publicPem),
		workerPrivateKey: workerKeys.privateKey, players: { probe: async () => ({ duration: 1234, audio: [{ index: 1, label: 'English', selected: true }], subtitles: [{ index: 2, label: 'English', embedded: true, language: 'eng', ordinal: 0 }], subtitleIndex: 2, method: 'Transcode' }),
			start: async () => { started++; return { read: async file => file.endsWith('.m3u8') ? Buffer.from('#EXTM3U\n#EXTINF:2,\nsegment0.ts\n') : Buffer.from('relay-segment-bytes'), stop: async () => { stopped++; } }; } },
		upstream: { health: async () => true, recordingFile: async () => new Response('') }, clock: () => now, heartbeatEnabled: false, maxSessions: 3 });
	const control = worker.controlServer(), media = worker.mediaServer();
	control.listen(0, '127.0.0.1'); media.listen(0, '127.0.0.1');
	await Promise.all([once(control, 'listening'), once(media, 'listening')]);
	worker.start();
	t.after(async () => { await worker.close(); control.closeAllConnections?.(); media.closeAllConnections?.(); control.close(); media.close(); });
	service.registry.enrol({ token: enrolment.token, workerId: 'relay-worker-1', publicKey: workerKeys.publicKey.export({ type: 'spki', format: 'pem' }),
		controlUrl: 'http://127.0.0.1:' + control.address().port, mediaPrefix: '/relay-media', version: '0.26.8', capabilities: ['live', 'vod'] });
	service.approve('relay-worker-1');
	service.manager.workerHeartbeat({ workerId: 'relay-worker-1', body: { bytesOutTotal: 0, leases: [] } });
	assert.equal(service.enabled(), true);
	const prepared = await service.prepare({ session: { id: 'session-1' }, viewer: { key: accountKey }, itemId: 'dispatch-live-' + 'a'.repeat(36),
		mode: 'live', params: { channelId: 'b'.repeat(36) }, quality: 8000000, local: false, onRelease: () => {} });
	assert.equal(prepared.mediaRoute, 'relay');
	assert.equal(prepared.routeSource, 'lease');
	assert.match(prepared.url, /^\/relay-media\/v1\/s\/v1\./);
	assert.equal(charged.length, 0, 'relay playback does not directly add account minutes');
	const head = await fetch('http://127.0.0.1:' + media.address().port + prepared.url, { method: 'HEAD' });
	assert.equal(head.status, 200);
	assert.equal(started, 0);
	const playlist = await (await fetch('http://127.0.0.1:' + media.address().port + prepared.url)).text();
	assert.match(playlist, /segment0\.ts/);
	const segment = await (await fetch('http://127.0.0.1:' + media.address().port + playlist.split('\n')[2])).text();
	assert.equal(segment, 'relay-segment-bytes');
	assert.equal(started, 1);
	assert.ok(service.manager.status().egress.bytesOutTotal >= 0);
	const shared = await service.prepare({ session: { id: 'share-1' }, viewer: {}, share: true, itemId: 'dispatch-live-' + 'd'.repeat(36),
		mode: 'live', params: { channelId: 'e'.repeat(36) }, quality: 8000000, onRelease: () => {} });
	assert.match(shared.url, /relay-media/);
	const vod = await service.prepare({ session: { id: 'session-2' }, viewer: { key: accountKey }, itemId: 'dispatch-movie-1', mode: 'vod',
		params: { type: 'movie', uuid: 'c'.repeat(36) }, quality: 8000000, position: 42, onRelease: () => {} });
	assert.equal(vod.duration, 1234);
	assert.deepEqual(vod.audio, [{ index: 1, label: 'English', selected: true }]);
	assert.equal(vod.subtitles[0].index, 2);
	assert.equal(vod.subtitleIndex, 2);
	assert.equal(vod.position, 42);
	const replaced = await service.replace(vod.leaseId, { audioIndex: 1, subtitleIndex: 2, position: 99 });
	assert.equal(replaced.duration, 1234);
	assert.equal(replaced.subtitles[0].index, 2);
	assert.equal(replaced.subtitleIndex, 2);
	assert.equal(replaced.position, 99);
	assert.equal(replaced.audio[0].index, 1);
	// Client heartbeat timeout revokes without a second account slot.
	now += 31000;
	service.tick();
	await service.manager._settled();
	await new Promise(resolve => setTimeout(resolve, 20));
	assert.ok(stopped >= 1);
	assert.equal(service.manager.status().sessions, 0);
});
