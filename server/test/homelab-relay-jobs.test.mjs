import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import os from 'node:os';
import path from 'node:path';
import { relayManager } from '../homelab/relay-jobs.mjs';

const key = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' });
const connection = () => ({ hostname: 'watch.example.com', sshHost: '203.0.113.10', sshUser: 'ubuntu', homeTailscaleIp: '100.100.10.20', privateKey: key,
	knownHosts: '203.0.113.10 ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFixtureOnlyNotARealServerKey' });
function fixture(t) {
	const dir = mkdtempSync(path.join(os.tmpdir(), 'homelab-relay-test-')); t.after(() => rmSync(dir, { recursive: true, force: true }));
	const calls = [];
	const manager = relayManager(dir, { runner: (command, args, options) => {
		const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough(); child.kill = () => child.emit('close', null);
		calls.push({ command, args, options, child }); return child;
	} });
	return { dir, manager, calls };
}
test('relay settings never return key material; saving and reviewing run no command', t => {
	const f = fixture(t), result = f.manager.save(connection());
	assert.equal(result.connection.credentialsSaved, true); assert.equal(JSON.stringify(result).includes('PRIVATE KEY'), false);
	assert.equal(f.manager.plan().upstream, '100.100.10.20:8083'); assert.equal(f.calls.length, 0);
	assert.match(readFileSync(path.join(f.dir, 'relay/ssh-key'), 'utf8'), /PRIVATE KEY/);
});
test('relay installation requires a successful check and exact hostname confirmation', t => {
	const f = fixture(t); f.manager.save(connection());
	assert.throws(() => f.manager.start('install', 'watch.example.com'), /Check/);
	f.manager.start('check'); assert.throws(() => f.manager.save(connection()), { status: 409 });
	assert.ok(f.calls[0].args.includes('StrictHostKeyChecking=yes')); assert.equal(f.calls[0].options.shell, false);
	f.calls[0].child.emit('close', 1); assert.equal(f.manager.status().checked, false);
	f.manager.start('check'); f.calls[1].child.emit('close', 0);
	assert.throws(() => f.manager.start('install', 'wrong.example.com'), /confirm/);
	f.manager.start('install', 'watch.example.com'); f.calls[2].child.emit('close', 2);
	assert.equal(f.manager.status().job.status, 'approval-needed');
});
test('changing relay host requires a new verified host entry and resets check state', t => {
	const f = fixture(t); f.manager.save(connection()); f.manager.start('check'); f.calls[0].child.emit('close', 0);
	assert.throws(() => f.manager.save({ ...connection(), sshHost: '203.0.113.11', knownHosts: '' }), /verified/);
	f.manager.save({ ...connection(), privateKey: '', knownHosts: '' }); assert.equal(f.manager.status().checked, false);
});
test('relay task output is bounded and strips terminal controls', t => {
	const f = fixture(t); f.manager.save(connection()); f.manager.start('check');
	f.calls[0].child.stdout.write('\u001b'+ 'a'.repeat(70000)); f.calls[0].child.emit('close', 0);
	assert.equal(f.manager.status().job.output.length, 60000); assert.equal(f.manager.status().job.output.includes('\u001b'), false);
});
