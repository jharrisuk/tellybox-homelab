import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { createRelayMediaService } from '../relay-media/install.mjs';

test('signed worker heartbeat preserves upstream true, false and unknown without inventing health', t => {
	const directory = mkdtempSync(path.join(os.tmpdir(), 'relay-heartbeat-'));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	let now = 1_000_000;
	const accountLimits = { key: () => 'person:test', status: () => ({}), viewing: () => ({}), charge: () => {} };
	const service = createRelayMediaService({ directory, accountLimits, clock: () => now, publicOrigin: 'https://watch.example.test' });
	const enrolment = service.registry.createEnrolment();
	const workerKeys = generateKeyPairSync('ed25519');
	service.registry.enrol({ token: enrolment.token, workerId: 'relay-worker-1',
		publicKey: workerKeys.publicKey.export({ type: 'spki', format: 'pem' }),
		controlUrl: 'http://100.100.10.20:18087', mediaPrefix: '/relay-media', version: '0.26.9',
		capabilities: ['live', 'vod'], selfTest: { ok: false, detail: 'awaiting worker health' } });
	service.registry.approve('relay-worker-1');
	const heartbeat = health => service.manager.workerHeartbeat({ workerId: 'relay-worker-1', body: { bytesOutTotal: 0, leases: [], health } });
	const selfTest = () => service.registry.status().worker?.selfTest;

	heartbeat({ upstream: true });
	assert.equal(selfTest()?.ok, true);
	assert.match(selfTest()?.detail || '', /reachable/);

	heartbeat({ upstream: false });
	assert.equal(selfTest()?.ok, false);
	assert.match(selfTest()?.detail || '', /unreachable/);

	heartbeat({ upstream: true });
	assert.equal(selfTest()?.ok, true);

	heartbeat({ upstream: 'true' });
	assert.equal(selfTest()?.ok, true, 'a non-boolean cannot flip health to true');

	heartbeat({ upstream: false });
	heartbeat({});
	assert.equal(selfTest()?.ok, false, 'unknown health does not invent a reachable upstream');

	heartbeat({ upstream: true });
	assert.equal(selfTest()?.ok, true);
});
