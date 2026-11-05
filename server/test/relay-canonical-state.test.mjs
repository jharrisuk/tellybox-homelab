import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { defaultConfig, validateConfig, materialize } from '../homelab/config.mjs';
import { createSetup } from '../homelab/admin.mjs';
import { createRelayMediaService } from '../relay-media/install.mjs';
import { controlHeaders } from '../relay-media/protocol.mjs';

test('materialize, admin enrolment and the media process share one canonical relay state directory', async t => {
	const directory = mkdtempSync(path.join(os.tmpdir(), 'relay-canonical-'));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const config = defaultConfig();
	config.network.publicOrigin = 'https://watch.example.test';
	config.services.dispatcharr = { enabled: true, location: 'relay', key: 'catalogue-key', relayKey: 'worker-key', live: true,
		relayMetadataUrl: 'http://relay.example.test:9191', relayUrl: 'http://host.containers.internal:9191' };
	const checked = validateConfig(config);
	const env = materialize(checked, directory);
	assert.equal(env.RELAY_STATE_DIR, directory);
	assert.equal(env.RELAY_MEDIA_ENABLED, '1');
	assert.deepEqual(JSON.parse(readFileSync(path.join(env.AUTH_DIR, 'relay-media.json'), 'utf8')).workerKey, 'worker-key');
	const setup = createSetup({ directory, apply: async () => {}, allowedHosts: '127.0.0.1' });
	let control;
	const admin = setup.app.listen(0, '127.0.0.1'); await once(admin, 'listening');
	t.after(() => { admin.closeAllConnections?.(); admin.close(); control?.closeAllConnections?.(); control?.close(); });
	const base = 'http://127.0.0.1:' + admin.address().port;
	const token = JSON.parse(readFileSync(path.join(directory, 'bootstrap.json'), 'utf8')).token;
	const login = await fetch(base + '/api/setup/login', { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ bootstrap: token, password: 'test-only-password-1234' }) });
	assert.equal(login.status, 200);
	const cookie = login.headers.get('set-cookie').split(';')[0];
	const request = (route, body) => fetch(base + '/api/setup/' + route, { method: body ? 'POST' : 'GET', headers: { Cookie: cookie, ...(body ? { Origin: base, 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
	const fresh = await (await request('relay-media')).json();
	assert.equal(fresh.configured, false);
	assert.equal(existsSync(path.join(directory, 'relay', 'main-control-key.json')), false, 'a disabled/never-enrolled feature creates no keys');
	const premature = setup.store.get();
	premature.network = checked.network;
	premature.services.dispatcharr = { ...checked.services.dispatcharr };
	assert.equal((await request('config', premature)).status, 409, 'On relay cannot be saved before an approved worker');
	assert.equal((await (await request('relay-media/enrolment', {})).json()).token.length > 20, true);
	assert.equal(existsSync(path.join(directory, 'relay', 'main-control-key.json')), true);
	const service = createRelayMediaService({ directory: env.RELAY_STATE_DIR, enabled: true, publicOrigin: 'https://watch.example.test', clock: () => Date.now(),
		accountLimits: { key: () => 'local:relay', status: () => ({ minutes: 0, seconds: 0, dailyMinutes: 0, dailySeconds: 0 }), viewing: () => ({ remainingSeconds: null }), charge: () => {} } });
	const internal = express(); internal.use(express.json()); service.install(internal);
	control = internal.listen(0, '127.0.0.1'); await once(control, 'listening');
	const worker = generateKeyPairSync('ed25519');
	const status = await (await request('relay-media')).json();
	const enrolToken = (await (await request('relay-media/enrolment', {})).json()).token;
	const enrolled = await fetch('http://127.0.0.1:' + control.address().port + '/internal/worker/enrol', { method: 'POST', headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ token: enrolToken, workerId: 'relay-worker-1', publicKey: worker.publicKey.export({ type: 'spki', format: 'pem' }),
			controlUrl: 'http://127.0.0.1:18087', mediaPrefix: '/relay-media', version: '0.26.8', selfTest: { ok: true, detail: 'fixture' } }) });
	assert.equal(enrolled.status, 201, await enrolled.clone().text());
	const enrolment = await enrolled.json();
	assert.match(enrolment.mainControlPublicKey, /PUBLIC KEY/);
	assert.equal((await (await request('relay-media/approve', { workerId: 'relay-worker-1' })).json()).state, 'approved');
	// Admin and media process now see the same approved worker and keys.
	const approved = await (await request('relay-media')).json();
	assert.equal(approved.approved, true);
	assert.equal(approved.worker.workerId, 'relay-worker-1');
	const deployment = await (await request('relay-media/deployment', { tailscaleIp: '100.100.10.20', mediaPort: 18086, controlPort: 18087,
		mainHeartbeatUrl: 'http://100.100.10.21:8083/internal/worker/heartbeat', upstreamUrl: 'http://host.containers.internal:9192' })).json();
	assert.equal(JSON.stringify(deployment).includes('PRIVATE KEY'), false);
	assert.match(deployment.unit, /podman run/);
	assert.match(deployment.caddyScript, /Caddyfile/);
	const body = { workerId: 'relay-worker-1', workerInstance: 'fixture', version: '0.26.8', bytesOutTotal: 0, leases: [], health: { upstream: true } };
	const heartbeat = await fetch('http://127.0.0.1:' + control.address().port + '/internal/worker/heartbeat', { method: 'POST', headers: { 'Content-Type': 'application/json',
		...controlHeaders(worker.privateKey, { method: 'POST', path: '/internal/worker/heartbeat', body, now: Date.now() }) }, body: JSON.stringify(body) });
	assert.equal(heartbeat.status, 200, await heartbeat.clone().text());
	assert.equal(service.enabled(), true);
	assert.equal(service.manager.status().worker.fresh, true);
	// A relay save is refused until the worker self-test and a fresh report exist.
	const configForSave = setup.store.get();
	configForSave.network = checked.network;
	configForSave.services.dispatcharr = { ...checked.services.dispatcharr };
	const saved = await request('config', configForSave);
	assert.equal(saved.status, 200, await saved.clone().text());
});
