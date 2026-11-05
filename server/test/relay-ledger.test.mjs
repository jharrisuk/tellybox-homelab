import test from 'node:test';
import assert from 'node:assert/strict';
import { createRelayLedger } from '../relay-media/ledger.mjs';

function fixture({ allowance = 600, unlimited = false } = {}) {
	let now = 1_000_000, charged = 0;
	const extra = [];
	const ledger = createRelayLedger({ clock: () => now, maxGrantSeconds: 45, minGrantSeconds: 1,
		allowanceSeconds: () => unlimited ? null : allowance,
		chargedSeconds: () => charged,
		chargeDifference: (key, seconds) => { extra.push({ key, seconds }); charged += seconds; } });
	return { ledger, advance: seconds => { now += seconds * 1000; }, charge: seconds => { charged += seconds; }, extra, get charged() { return charged; } };
}
test('short grants are capped and never exceed the account pool', () => {
	const f = fixture({ allowance: 100 });
	for (const id of ['lease-0001', 'lease-0002', 'lease-0003']) f.ledger.register(id, 'person:' + 'a'.repeat(32));
	const grants = f.ledger.allocate('person:' + 'a'.repeat(32), ['lease-0001', 'lease-0002', 'lease-0003']);
	assert.deepEqual(grants, { 'lease-0001': 33, 'lease-0002': 33, 'lease-0003': 33 });
	assert.equal(f.ledger.check('person:' + 'a'.repeat(32)).outstandingGrantSeconds, 99);
});
test('near exhaustion makes one-second final grants instead of stranding allowance', () => {
	const f = fixture({ allowance: 2 });
	for (const id of ['lease-0001', 'lease-0002', 'lease-0003']) f.ledger.register(id, 'person:' + 'a'.repeat(32));
	const grants = f.ledger.allocate('person:' + 'a'.repeat(32), ['lease-0001', 'lease-0002', 'lease-0003']);
	assert.deepEqual(grants, { 'lease-0001': 1, 'lease-0002': 1 });
	assert.equal(f.ledger.snapshot('person:' + 'a'.repeat(32)).outstandingGrantSeconds, 2);
});
test('concurrent joins and renewals keep the absolute invariant', async () => {
	const f = fixture({ allowance: 50 });
	const key = 'person:' + 'a'.repeat(32);
	for (let i = 1; i <= 8; i++) f.ledger.register('lease-000' + i, key);
	await Promise.all(Array.from({ length: 20 }, (_, i) => Promise.resolve().then(() => f.ledger.allocate(key, ['lease-000' + (i % 8 + 1)]))));
	const state = f.ledger.check(key);
	assert.ok(state.chargedSeconds + state.outstandingGrantSeconds <= state.allowanceSeconds);
	assert.ok(state.outstandingGrantSeconds <= 50);
});
test('renewal releases unused credit; lost contact charges only the unreconciled part once', () => {
	const f = fixture({ allowance: 100 });
	const key = 'person:' + 'a'.repeat(32), lease = 'lease-0001';
	f.ledger.register(lease, key);
	assert.equal(f.ledger.allocate(key, [lease])[lease], 45);
	f.charge(10);
	// Renewal: 10 consumed, 35 unused released, then a fresh 45 is reserved.
	assert.equal(f.ledger.allocate(key, [lease])[lease], 45);
	assert.equal(f.ledger.snapshot(key).chargedSeconds, 10);
	assert.equal(f.ledger.snapshot(key).outstandingGrantSeconds, 45);
	f.charge(10);
	const result = f.ledger.settle(lease, { lostContact: true });
	assert.equal(result.unusedSeconds, 35);
	assert.equal(result.extraChargeSeconds, 35);
	assert.equal(f.extra.length, 1);
	assert.equal(f.extra[0].seconds, 35, 'consumed time is not charged twice');
	assert.ok(f.charged <= 100);
});
test('unlimited accounts still receive short grants and no allowance ceiling', () => {
	const f = fixture({ unlimited: true });
	f.ledger.register('lease-0001', 'person:' + 'a'.repeat(32));
	const grants = f.ledger.allocate('person:' + 'a'.repeat(32), ['lease-0001']);
	assert.equal(grants['lease-0001'], 45);
	assert.equal(f.ledger.snapshot('person:' + 'a'.repeat(32)).allowanceSeconds, null);
	const settled = f.ledger.settle('lease-0001', { lostContact: true });
	assert.equal(settled.extraChargeSeconds, 0, 'unlimited accounts are not charged for lost contact');
	assert.equal(f.extra.length, 0);
});
