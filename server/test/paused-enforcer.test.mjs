import test from 'node:test';
import assert from 'node:assert/strict';
import { createPausedEnforcer } from '../paused-enforcer.mjs';

const session = (id = 's1') => ({ id, owner: 'owner', position: 42 });

test('cleanup retries with bounded backoff until stop succeeds', async () => {
	let now = 0, attempts = 0;
	const enforcer = createPausedEnforcer({
		clock: () => now,
		stop: async () => { attempts++; if (attempts < 3) throw new Error('upstream busy'); },
		maxAttempts: 5, baseDelayMs: 100, maxDelayMs: 1000
	});
	const s = session();
	enforcer.enforce(s);
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(attempts, 1);
	assert.equal(enforcer.retries.size, 1);
	now = 99; enforcer.tick();
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(attempts, 1, 'retry is not due before its backoff');
	now = 100; enforcer.tick();
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(attempts, 2);
	now = 300; enforcer.tick();
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(attempts, 3);
	assert.equal(enforcer.retries.size, 0);
	assert.equal(s.terminalStopping, true);
});

test('cleanup fails closed after the bounded attempts and runs the give-up release', async () => {
	let now = 0, attempts = 0, gaveUp = 0;
	const enforcer = createPausedEnforcer({
		clock: () => now,
		stop: async () => { attempts++; throw new Error('still busy'); },
		onGiveUp: async () => { gaveUp++; },
		maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 10
	});
	enforcer.enforce(session());
	await new Promise(resolve => setImmediate(resolve));
	for (let i = 0; i < 2; i++) {
		now += 10;
		enforcer.tick();
		await new Promise(resolve => setImmediate(resolve));
	}
	assert.equal(attempts, 3);
	assert.equal(gaveUp, 1);
	assert.equal(enforcer.retries.size, 0, 'a failed cleanup must not retry forever');
});

test('enforce is idempotent for an already terminal session', async () => {
	let attempts = 0;
	const enforcer = createPausedEnforcer({ stop: async () => { attempts++; } });
	const s = session();
	enforcer.enforce(s);
	enforcer.enforce(s);
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(attempts, 1);
});
