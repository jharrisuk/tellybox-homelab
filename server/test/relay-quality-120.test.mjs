import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { createRelayMediaService } from '../relay-media/install.mjs';
import { createRelayWorker } from '../../relay/worker/worker.mjs';
import { readPublicKey } from '../relay-media/protocol.mjs';

const uuid = 'c'.repeat(36);
const channelId = 'b'.repeat(36);
const item = { StartDate: '2026-11-01T10:00:00.000Z', EndDate: '2026-11-01T11:00:00.000Z' };

test('relay quality contract holds for VOD and catch-up prepare and replacement', async t => {
	const directory = mkdtempSync(path.join(os.tmpdir(), 'relay-quality-'));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const accountKey = 'person:' + 'a'.repeat(32);
	const service = createRelayMediaService({ directory, clock: () => 1_000_000, maxSessions: 20,
		accountLimits: { key: () => accountKey, status: () => ({ minutes: 0, seconds: 0, dailyMinutes: 0, dailySeconds: 0 }), viewing: () => ({ remainingSeconds: null }), charge: () => {} },
		publicOrigin: 'https://watch.example.test' });
	const enrolment = service.registry.createEnrolment();
	const workerKeys = generateKeyPairSync('ed25519');
	const started = [];
	const worker = createRelayWorker({ workerId: 'relay-quality-worker',
		mainControlPublicKey: readPublicKey(service.keys.control.publicPem), mainMediaPublicKey: readPublicKey(service.keys.media.publicPem),
		workerPrivateKey: workerKeys.privateKey,
		players: { probe: async () => ({ duration: 120, audio: [], subtitles: [], subtitleIndex: -1, method: 'Transcode' }),
			start: async session => { started.push(session); return { read: async () => Buffer.from('x'), stop: async () => {}, diagnostics: () => '' }; } },
		upstream: { health: async () => true, recordingFile: async () => new Response('') }, clock: () => 1_000_000, heartbeatEnabled: false, maxSessions: 40 });
	const control = worker.controlServer(), media = worker.mediaServer();
	control.listen(0, '127.0.0.1'); media.listen(0, '127.0.0.1');
	await Promise.all([new Promise(r => control.once('listening', r)), new Promise(r => media.once('listening', r))]);
	worker.start();
	t.after(async () => { await worker.close(); control.closeAllConnections?.(); media.closeAllConnections?.(); control.close(); media.close(); });
	service.registry.enrol({ token: enrolment.token, workerId: 'relay-quality-worker', publicKey: workerKeys.publicKey.export({ type: 'spki', format: 'pem' }),
		controlUrl: 'http://127.0.0.1:' + control.address().port, mediaPrefix: '/relay-media', version: '0.26.13', capabilities: ['vod', 'catchup'] });
	service.approve('relay-quality-worker');
	service.manager.workerHeartbeat({ workerId: 'relay-quality-worker', body: { bytesOutTotal: 0, leases: [] } });

	let n = 0;
	const prepare = (mode, quality) => service.prepare({ session: { id: 'quality-' + (++n) }, viewer: { key: accountKey },
		itemId: mode === 'vod' ? 'dispatch-movie-1' : 'catchup-' + channelId + '-1', mode,
		params: mode === 'vod' ? { type: 'movie', uuid } : { channelId, item }, quality, position: 0, onRelease: () => {} });
	for (const [mode, expected] of [['vod', 8000000], ['catchup', 8000000]]) {
		const absent = await prepare(mode, undefined); assert.equal(absent.quality, expected, mode + ' absent default');
		const zero = await prepare(mode, 0); assert.equal(zero.quality, expected, mode + ' 0 default');
		const invalid = await prepare(mode, 1234); assert.equal(invalid.quality, expected, mode + ' invalid default');
		const low = await prepare(mode, 2000000); assert.equal(low.quality, 2000000, mode + ' 2M');
		const four = await prepare(mode, 4000000); assert.equal(four.quality, 4000000, mode + ' 4M');
		const replaced = await service.replace(four.leaseId, { quality: 0, position: 4 });
		assert.equal(replaced.quality, expected, mode + ' replacement 0 defaults');
		const lower = await service.replace(four.leaseId, { quality: 2000000, position: 8 });
		assert.equal(lower.quality, 2000000, mode + ' replacement 2M');
		const preserved = await service.replace(four.leaseId, { position: 12 });
		assert.equal(preserved.quality, 2000000, mode + ' absent replacement preserves');
	}
	assert.ok(started.length === 0, 'prepare/replace must not start media without a GET');
});
