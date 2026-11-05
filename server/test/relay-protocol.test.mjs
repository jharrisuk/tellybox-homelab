import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { createMediaToken, createNonceCache, fingerprint, readMediaToken, readPublicKey, verifyControlRequest, verifyMediaToken, controlHeaders } from '../relay-media/protocol.mjs';

const pair = () => { const k = generateKeyPairSync('ed25519'); return { privateKey: k.privateKey, publicKey: k.publicKey }; };
test('media capability is scoped, expiring and tamper-evident', () => {
	const keys = pair(), now = 1_000_000;
	const token = createMediaToken(keys.privateKey, { aud: 'worker-a', leaseId: 'lease-1234', sessionId: 'session-1', itemId: 'item-1', mode: 'vod', generation: 1, resources: ['hls', 'segment'], exp: now / 1000 + 60, jti: 'jti-1' });
	const payload = verifyMediaToken(keys.publicKey, token, { aud: 'worker-a', leaseId: 'lease-1234', generation: 1 }, now);
	assert.equal(payload.mode, 'vod');
	assert.throws(() => verifyMediaToken(keys.publicKey, token, { aud: 'worker-b' }, now), { code: 'RELAY_MEDIA_SCOPE' });
	assert.throws(() => verifyMediaToken(keys.publicKey, token, { generation: 2 }, now), { code: 'RELAY_MEDIA_SCOPE' });
	assert.throws(() => verifyMediaToken(keys.publicKey, token, {}, now + 120000), { code: 'RELAY_MEDIA_EXPIRED' });
	const { payload: p, signature, signed } = readMediaToken(token);
	assert.equal(Buffer.from(signature, 'base64url').length, 64);
	assert.notEqual(signed, token + 'x');
	assert.throws(() => verifyMediaToken(keys.publicKey, token.slice(0, -2) + 'aa', {}, now), { code: 'RELAY_MEDIA_TOKEN' });
});
test('nonce cache rejects a replay and bounds storage by rejecting new nonces, never evicting fresh ones', () => {
	let now = 1_000_000;
	const cache = createNonceCache({ clock: () => now, windowMs: 1000, limit: 2 });
	assert.equal(cache('nonce-one'), true);
	assert.equal(cache('nonce-two'), true);
	assert.equal(cache('nonce-one'), false, 'replay is always rejected');
	assert.equal(cache('nonce-three'), false, 'a full fresh cache rejects rather than evicting a valid nonce');
	now += 1001;
	assert.equal(cache('nonce-three'), true);
	assert.equal(cache('nonce-one'), true);
});
test('control requests bind method, path, body, timestamp, nonce and key id', () => {
	const keys = pair(), other = pair(), now = 2_000_000, body = { workerId: 'w', leases: [{ leaseId: 'l', seq: 1 }] };
	const headers = controlHeaders(keys.privateKey, { method: 'POST', path: '/internal/worker/heartbeat', body, now });
	assert.equal(headers['x-relay-key-id'], fingerprint(keys.publicKey));
	const nonce = createNonceCache({ clock: () => now });
	assert.equal(verifyControlRequest(keys.publicKey, { method: 'POST', path: '/internal/worker/heartbeat', headers, body, now, nonce }), true);
	assert.equal(verifyControlRequest(keys.publicKey, { method: 'POST', path: '/internal/worker/heartbeat', headers, body, now, nonce }), false, 'replay rejected');
	const nonce2 = createNonceCache({ clock: () => now });
	assert.equal(verifyControlRequest(keys.publicKey, { method: 'POST', path: '/internal/worker/stop', headers, body, now, nonce: nonce2 }), false);
	assert.equal(verifyControlRequest(other.publicKey, { method: 'POST', path: '/internal/worker/heartbeat', headers, body, now, nonce: createNonceCache({ clock: () => now }) }), false);
	assert.equal(verifyControlRequest(keys.publicKey, { method: 'POST', path: '/internal/worker/heartbeat', headers, body, now: now + 120000, nonce: createNonceCache({ clock: () => now + 120000 }) }), false, 'skew rejected');
	assert.equal(readPublicKey(keys.publicKey).asymmetricKeyType, 'ed25519');
});
