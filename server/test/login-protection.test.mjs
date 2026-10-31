import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createLoginProtection } from '../login-protection.mjs';

test('admin snapshot shows live counters, safe email metadata and block expiry across restarts', t => {
	const directory = mkdtempSync(path.join(tmpdir(),'tellybox-login-status-'));
	t.after(() => rmSync(directory,{recursive:true,force:true}));
	let now=100000000; const clock=()=>now; let guard=createLoginProtection(directory,{clock});
	guard.attempt('192.0.2.1',' Person@example.test ');
	assert.equal(guard.snapshot()[0].state,'recent');
	now+=1000;guard.attempt('192.0.2.1','Person@example.test');
	let entry=guard.snapshot()[0];assert.equal(entry.state,'warning');assert.equal(entry.attempts,2);assert.equal(entry.email,'person@example.test');assert.equal(entry.resetsAt,100300000);
	guard=createLoginProtection(directory,{clock});assert.equal(guard.snapshot()[0].attempts,2);
	guard.attempt('192.0.2.1','<invalid-private-input>');assert.equal(guard.snapshot()[0].email,'');
	assert.throws(()=>guard.attempt('192.0.2.1','person@example.test'),e=>e.code==='LOGIN_IP_BLOCKED');
	entry=guard.snapshot()[0];assert.equal(entry.state,'blocked');assert.equal(entry.blockedUntil,now+86400000);
	now+=300000;assert.equal(guard.snapshot()[0].attempts,0);assert.equal(guard.snapshot()[0].state,'blocked');
	guard.unblock(entry.id);assert.deepEqual(guard.snapshot(),[]);
	guard.attempt('192.0.2.2');now+=300000;assert.deepEqual(guard.snapshot(),[]);
});

test('fourth email submission triggers a persistent 24 hour block, scoped to the source address', t => {
	const directory = mkdtempSync(path.join(tmpdir(),'tellybox-login-guard-'));
	t.after(() => rmSync(directory,{recursive:true,force:true}));
	let now = 100000000; const clock = () => now;
	let guard = createLoginProtection(directory,{clock});
	for (let i=0;i<3;i++) guard.attempt('192.0.2.1');
	assert.throws(() => guard.attempt('192.0.2.1'), e => e.status === 429 && e.retryAfter === 86400);
	guard = createLoginProtection(directory,{clock});
	assert.throws(() => guard.check('::ffff:192.0.2.1'), e => e.status === 429);
	guard.attempt('192.0.2.2');
	now += 86399000;
	assert.throws(() => guard.attempt('192.0.2.1'), e => e.retryAfter === 1);
	now += 1000; guard.attempt('192.0.2.1');
	assert.equal(guard.list().length,0);
});

test('sliding window, IPv6 normalization and explicit unblock do not reset other addresses', t => {
	const directory = mkdtempSync(path.join(tmpdir(),'tellybox-login-window-'));
	t.after(() => rmSync(directory,{recursive:true,force:true}));
	let now = 100000000; const guard = createLoginProtection(directory,{clock:() => now});
	for (let i=0;i<3;i++) guard.attempt('2001:db8::1');
	now += 300000; guard.attempt('2001:0db8:0:0:0:0:0:1');
	guard.attempt('2001:db8::1');guard.attempt('2001:db8::1');
	assert.throws(() => guard.attempt('2001:db8::1'), e => e.status === 429);
	for (let i=0;i<3;i++) guard.attempt('192.0.2.2');
	assert.throws(() => guard.attempt('192.0.2.2'), e => e.status === 429);
	const first = guard.list().find(e => e.ip === '2001:db8::1');
	guard.unblock(first.id);guard.attempt('2001:db8::1');
	assert.throws(() => guard.check('192.0.2.2'), e => e.status === 429);
	assert.throws(() => guard.attempt('untrusted-header'), e => e.status === 400);
});
