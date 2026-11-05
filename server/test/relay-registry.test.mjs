import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, readdirSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { createWorkerRegistry } from '../relay-media/registry.mjs';

const keys = () => generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' });
function fixture(t) {
	const dir = mkdtempSync(path.join(os.tmpdir(), 'relay-registry-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
	let now = 1_000_000;
	const registry = createWorkerRegistry(dir, { clock: () => now });
	return { dir, registry, advance: seconds => { now += seconds * 1000; } };
}
const worker = publicKey => ({ token: '', workerId: 'worker-1', publicKey, controlUrl: 'http://100.100.10.20:18087', mediaPrefix: '/relay-media', version: '0.26.8', capabilities: ['live', 'vod'], selfTest: { ok: true, detail: 'mock Dispatcharr accepted' } });
test('enrolment token is one-use, hashed and approval is explicit', t => {
	const f = fixture(t), { token } = f.registry.createEnrolment();
	assert.equal(JSON.stringify(f.registry.status()).includes(token), false);
	assert.equal(readFileSync(path.join(f.dir, 'relay', 'workers.json'), 'utf8').includes(token), false);
	const pending = f.registry.enrol({ ...worker(keys()), token });
	assert.equal(pending.state, 'pending');
	assert.throws(() => f.registry.enrol({ ...worker(keys()), token }), /expired|not valid/);
	assert.equal(f.registry.status().approved, false);
	assert.throws(() => f.registry.touch('worker-1'), /not approved/);
	f.registry.approve('worker-1');
	assert.equal(f.registry.status().approved, true);
	assert.equal(JSON.stringify(f.registry.status()).includes('PRIVATE KEY'), false);
	assert.equal(f.registry.status().worker.fingerprint.length, 32);
});
test('expired, wrong, revoked and duplicate workers are refused', t => {
	const f = fixture(t), first = f.registry.createEnrolment();
	f.advance(601);
	assert.throws(() => f.registry.enrol({ ...worker(keys()), token: first.token }), /expired/);
	const second = f.registry.createEnrolment();
	assert.throws(() => f.registry.enrol({ ...worker(keys()), token: 'wrong-token' }), /not valid/);
	f.registry.enrol({ ...worker(keys()), token: second.token });
	const third = f.registry.createEnrolment();
	assert.throws(() => f.registry.enrol({ ...worker(keys()), token: third.token, workerId: 'worker-2' }), /one relay worker/);
	f.registry.approve('worker-1');
	f.registry.revoke('worker-1');
	assert.equal(f.registry.status().approved, false);
	assert.throws(() => f.registry.approve('worker-1'), /revoked/);
});
test('stale registry instances cannot overwrite approval or resurrection a revoked worker', t => {
	const f = fixture(t), first = f.registry.createEnrolment();
	f.registry.enrol({ ...worker(keys()), token: first.token });
	f.registry.approve('worker-1');
	const stale = createWorkerRegistry(f.dir, { clock: () => 1_000_000 });
	assert.equal(stale.status().approved, true);
	f.registry.revoke('worker-1');
	assert.throws(() => stale.touch('worker-1'), /not approved/);
	assert.equal(stale.status().worker.state, 'revoked');
	const a = f.registry.createEnrolment(), b = stale.createEnrolment();
	assert.throws(() => f.registry.enrol({ ...worker(keys()), token: a.token, workerId: 'worker-2' }), /not valid/);
	assert.ok(b.token);
});
test('registry writes use unique temporary names and leave no lock or partial file', t => {
	const f = fixture(t), { token } = f.registry.createEnrolment();
	f.registry.enrol({ ...worker(keys()), token });
	f.registry.approve('worker-1');
	const names = readdirSync(path.join(f.dir, 'relay'));
	assert.equal(names.some(name => name.endsWith('.tmp') || name.endsWith('.lock')), false);
});
test('registry rejects credential-bearing or non-private control addresses', t => {
	const f = fixture(t), { token } = f.registry.createEnrolment();
	for (const controlUrl of ['http://user:secret@100.100.10.20:18087', 'http://100.100.10.20:18087/path', 'http://100.100.10.20:18087/?x=1', 'http://100.100.10.20']) {
		assert.throws(() => f.registry.enrol({ ...worker(keys()), token, controlUrl }));
	}
});
