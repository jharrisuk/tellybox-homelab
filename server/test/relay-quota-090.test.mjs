import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import { once } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { createAccountLimits } from '../account-limits.mjs';
import { createRelayLedger } from '../relay-media/ledger.mjs';
import { createRelayMediaService } from '../relay-media/install.mjs';
import { createRelayWorker } from '../../relay/worker/worker.mjs';
import { readPublicKey } from '../relay-media/protocol.mjs';

const person = 'a'.repeat(32);
const account = 'person:' + person;
const now = Date.UTC(2026, 10, 7, 12, 0, 0);
const ukDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(now));

function limits(t, entry = {}) {
	const directory = mkdtempSync(path.join(os.tmpdir(), 'relay-quota-'));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	writeFileSync(path.join(directory, 'account-limits.json'), JSON.stringify({ accounts: { [account]: { minutes: 0, seconds: 0, downloads: false, dailyMinutes: 0, dailySeconds: 0, maxSessions: 0, day: ukDay, ...entry } } }));
	return createAccountLimits(directory, { clock: () => now });
}

function ledger(available, charged = 0) {
	return createRelayLedger({ clock: () => now, maxGrantSeconds: 45, minGrantSeconds: 1,
		availableSeconds: () => available, chargedSeconds: () => charged });
}

test('the two quota windows are evaluated separately, not mixed with max usage and min allowance', t => {
	const service = limits(t, { minutes: 481, seconds: 12144, dailyMinutes: 200, dailySeconds: 7 });
	const budget = service.relayBudget(account);
	assert.deepEqual(budget.windows.manual, { limitSeconds: 28860, usedSeconds: 12144, remainingSeconds: 16716 });
	assert.deepEqual(budget.windows.daily, { limitSeconds: 12000, usedSeconds: 7, remainingSeconds: 11993 });
	assert.equal(budget.remainingSeconds, 11993);
	assert.equal(budget.seconds, 12144, 'lifetime usage stays monotonic');
	assert.equal(budget.dailySeconds, 7, 'daily usage stays its own window');
	const pool = ledger(budget.remainingSeconds, budget.seconds);
	pool.register('lease-0001', account);
	assert.equal(pool.allocate(account, ['lease-0001'])['lease-0001'], 45);
	assert.equal(pool.check(account).outstandingGrantSeconds, 45);
});

test('total-only, daily-only, both and unlimited accounts resolve the correct remaining pool', t => {
	const totalOnly = limits(t, { minutes: 10, seconds: 0 });
	assert.equal(totalOnly.relayBudget(account).remainingSeconds, 600);
	const dailyOnly = limits(t, { dailyMinutes: 10, dailySeconds: 0 });
	assert.equal(dailyOnly.relayBudget(account).remainingSeconds, 600);
	const both = limits(t, { minutes: 10, seconds: 60, dailyMinutes: 20, dailySeconds: 300 });
	assert.equal(both.relayBudget(account).remainingSeconds, 540, 'the smaller window wins');
	const unlimited = limits(t, {});
	assert.equal(unlimited.relayBudget(account).remainingSeconds, null);
	assert.equal(ledger(null).allocate('x', []).x, undefined);
	const pool = ledger(null);
	pool.register('lease-0001', account);
	assert.equal(pool.allocate(account, ['lease-0001'])['lease-0001'], 45, 'unlimited still gets short grants');
});

test('concurrent reservations share one pool and never overgrant', t => {
	const service = limits(t, { dailyMinutes: 2, dailySeconds: 0 });
	const pool = ledger(service.relayBudget(account).remainingSeconds, service.relayBudget(account).seconds);
	for (let i = 1; i <= 3; i++) pool.register('lease-000' + i, account);
	const grants = pool.allocate(account, ['lease-0001', 'lease-0002', 'lease-0003']);
	assert.deepEqual(grants, { 'lease-0001': 40, 'lease-0002': 40, 'lease-0003': 40 });
	assert.equal(pool.check(account).outstandingGrantSeconds, 120);
});

test('fractional pools do not create a zero-second grant and one second is the minimum', t => {
	const half = ledger(0.5);
	half.register('lease-0001', account);
	assert.deepEqual(half.allocate(account, ['lease-0001']), {});
	const one = ledger(1);
	one.register('lease-0002', account);
	assert.deepEqual(one.allocate(account, ['lease-0002']), { 'lease-0002': 1 });
});

test('midnight resets only the daily window and manual reset cannot make a charge negative', t => {
	let clock = now;
	const directory = mkdtempSync(path.join(os.tmpdir(), 'relay-quota-midnight-'));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	writeFileSync(path.join(directory, 'account-limits.json'), JSON.stringify({ accounts: { [account]: { minutes: 481, seconds: 12144, downloads: false, dailyMinutes: 200, dailySeconds: 11999, maxSessions: 0, day: ukDay } } }));
	const service = createAccountLimits(directory, { clock: () => clock });
	assert.equal(service.relayBudget(account).windows.daily.remainingSeconds, 1);
	assert.equal(service.relayBudget(account).windows.manual.remainingSeconds, 16716);
	clock = Date.UTC(2026, 10, 8, 0, 1, 0);
	assert.equal(service.relayBudget(account).windows.daily.remainingSeconds, 12000);
	assert.equal(service.relayBudget(account).windows.manual.remainingSeconds, 16716, 'manual total is unchanged by midnight');
});

test('per-window lost contact charges the unreconciled grant once', () => {
	let charged = 0;
	const extra = [];
	const pool = createRelayLedger({ clock: () => now, maxGrantSeconds: 45, minGrantSeconds: 1,
		availableSeconds: () => Math.max(0, 1000 - charged), chargedSeconds: () => charged,
		chargeDifference: (key, seconds) => { extra.push(seconds); charged += seconds; } });
	pool.register('lease-0001', account);
	assert.equal(pool.allocate(account, ['lease-0001'])['lease-0001'], 45);
	charged += 10;
	const settlement = pool.settle('lease-0001', { lostContact: true });
	assert.equal(settlement.consumedSeconds, 10);
	assert.equal(settlement.unusedSeconds, 35);
	assert.equal(settlement.extraChargeSeconds, 35);
	assert.equal(extra.length, 1);
	assert.equal(charged, 45);
});
test('a manual reset while a reservation is active cannot produce a negative or double charge', () => {
	let charged = 120;
	const extra = [];
	const pool = createRelayLedger({ clock: () => now, maxGrantSeconds: 45, minGrantSeconds: 1,
		availableSeconds: () => Math.max(0, 600 - charged), chargedSeconds: () => charged,
		chargeDifference: (key, seconds) => { extra.push(seconds); charged += seconds; } });
	pool.register('lease-0001', account);
	assert.equal(pool.allocate(account, ['lease-0001'])['lease-0001'], 45);
	charged = 0; // owner resets the account while the lease is active
	const settlement = pool.settle('lease-0001', { acknowledged: true, reason: 'manual_reset' });
	assert.equal(settlement.consumedSeconds, 0);
	assert.equal(settlement.extraChargeSeconds, 0);
	assert.equal(extra.length, 0);
	assert.ok(settlement.unusedSeconds >= 0);
});
test('actual manager prepare and heartbeat renewal keep the corrected pool', async t => {
	const directory = mkdtempSync(path.join(os.tmpdir(), 'relay-quota-manager-'));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	let clock = now;
	writeFileSync(path.join(directory, 'account-limits.json'), JSON.stringify({ accounts: { [account]: { minutes: 481, seconds: 12144, downloads: false, dailyMinutes: 200, dailySeconds: 7, maxSessions: 0, day: ukDay } } }));
	const accountLimits = createAccountLimits(directory, { clock: () => clock });
	const service = createRelayMediaService({ directory, accountLimits, clock: () => clock, publicOrigin: 'https://watch.example.test' });
	const enrolment = service.registry.createEnrolment();
	const workerKeys = generateKeyPairSync('ed25519');
	const worker = createRelayWorker({ workerId: 'relay-worker-1', mainControlPublicKey: readPublicKey(service.keys.control.publicPem),
		mainMediaPublicKey: readPublicKey(service.keys.media.publicPem), workerPrivateKey: workerKeys.privateKey,
		players: { probe: async () => ({ duration: 60, audio: [], subtitles: [], subtitleIndex: -1, method: 'Transcode' }),
			start: async () => ({ read: async () => Buffer.from('#EXTM3U\n'), stop: async () => {} }) },
		upstream: { health: async () => true, recordingFile: async () => new Response('') }, clock: () => clock, heartbeatEnabled: false, maxSessions: 3 });
	const control = worker.controlServer(), media = worker.mediaServer();
	control.listen(0, '127.0.0.1'); media.listen(0, '127.0.0.1');
	await Promise.all([once(control, 'listening'), once(media, 'listening')]);
	worker.start();
	t.after(async () => { await worker.close(); control.closeAllConnections?.(); media.closeAllConnections?.(); control.close(); media.close(); });
	service.registry.enrol({ token: enrolment.token, workerId: 'relay-worker-1', publicKey: workerKeys.publicKey.export({ type: 'spki', format: 'pem' }),
		controlUrl: 'http://127.0.0.1:' + control.address().port, mediaPrefix: '/relay-media', version: '0.26.10', capabilities: ['live', 'vod'] });
	service.approve('relay-worker-1');
	service.manager.workerHeartbeat({ workerId: 'relay-worker-1', body: { bytesOutTotal: 0, leases: [] } });
	const viewer = { personId: person };
	const first = await service.prepare({ session: { id: 'quota-1' }, viewer, itemId: 'dispatch-live-' + 'a'.repeat(36), mode: 'live', params: { channelId: 'b'.repeat(36) }, quality: 8000000, onRelease: () => {} });
	const second = await service.prepare({ session: { id: 'quota-2' }, viewer, itemId: 'dispatch-live-' + 'c'.repeat(36), mode: 'live', params: { channelId: 'd'.repeat(36) }, quality: 8000000, onRelease: () => {} });
	assert.equal(first.grantSeconds, 45);
	assert.equal(second.grantSeconds, 45);
	const state = service.manager.ledger.check(account);
	assert.equal(state.remainingBeforeOutstandingSeconds, 11993);
	assert.equal(state.outstandingGrantSeconds, 90);
	assert.ok(state.availableSeconds >= 0);
	clock += 31000;
	service.manager.clientHeartbeat(first.leaseId);
	const heartbeat = service.manager.workerHeartbeat({ workerId: 'relay-worker-1', body: { bytesOutTotal: 0, leases: [{ leaseId: first.leaseId, seq: 1, bytesOutTotal: 0 }] } });
	const renew = heartbeat.instructions.find(item => item.leaseId === first.leaseId);
	assert.equal(renew.action, 'renew');
	assert.equal(renew.grantSeconds, 45);
	assert.ok(service.manager.ledger.check(account).outstandingGrantSeconds <= 11993);
	await service.manager.stop(first.leaseId);
	await service.manager.stop(second.leaseId);
});
