import { createHash, createPrivateKey, createPublicKey, randomBytes, sign, verify } from 'node:crypto';

const fail = (message, status = 401, code = 'RELAY_AUTH') => Object.assign(Error(message), { status, code });

/** Recursively sorted JSON. Both ends must hash and sign exactly the same bytes. */
export function canonicalJson(value) {
	if (value === null || typeof value !== 'object') return JSON.stringify(value);
	if (Array.isArray(value)) return '[' + value.map(item => item === undefined ? 'null' : canonicalJson(item)).join(',') + ']';
	return '{' + Object.keys(value).filter(key => value[key] !== undefined).sort().map(key => JSON.stringify(key) + ':' + canonicalJson(value[key])).join(',') + '}';
}
export function bodyHash(body) {
	return createHash('sha256').update(body === undefined ? '' : canonicalJson(body)).digest('hex');
}
export function publicKeyOf(key) {
	return key.type === 'public' ? key : createPublicKey(key);
}
export function fingerprint(key) {
	const der = publicKeyOf(key).export({ type: 'spki', format: 'der' });
	return createHash('sha256').update(der).digest('hex').slice(0, 32);
}
export function readPrivateKey(pem) {
	const key = createPrivateKey(pem);
	if (key.asymmetricKeyType !== 'ed25519') throw fail('Relay keys must be Ed25519.', 400);
	return key;
}
export function readPublicKey(pem) {
	const key = pem?.type === 'public' ? pem : createPublicKey(pem);
	if (key.asymmetricKeyType !== 'ed25519') throw fail('Relay keys must be Ed25519.', 400);
	return key;
}
export function signText(privateKey, text) {
	return sign(null, Buffer.from(text), privateKey).toString('base64url');
}
export function verifyText(publicKey, text, signature) {
	try {
		return verify(null, Buffer.from(text), publicKey, Buffer.from(String(signature || ''), 'base64url'));
	} catch { return false; }
}
export function controlMessage({ method, path, timestamp, nonce, body }) {
	return [String(method || '').toUpperCase(), String(path || ''), String(timestamp || ''), String(nonce || ''), bodyHash(body)].join('\n');
}
export function signControl(privateKey, request) {
	return signText(privateKey, controlMessage(request));
}
export function verifyControl(publicKey, request) {
	return verifyText(publicKey, controlMessage(request), request.signature);
}
export const CONTROL_HEADERS = ['x-relay-timestamp', 'x-relay-nonce', 'x-relay-signature', 'x-relay-key-id'];
export function controlHeaders(privateKey, { method, path, body, now = Date.now(), nonce }) {
	const timestamp = String(now), value = nonce || randomBytes(18).toString('base64url');
	const signature = signControl(privateKey, { method, path, timestamp, nonce: value, body });
	return { 'x-relay-timestamp': timestamp, 'x-relay-nonce': value, 'x-relay-signature': signature, 'x-relay-key-id': fingerprint(privateKey) };
}
export function createNonceCache({ clock = Date.now, windowMs = 120000, limit = 4096 } = {}) {
	const seen = new Map();
	return function fresh(nonce, at = clock()) {
		for (const [key, expires] of seen) if (expires <= at) seen.delete(key);
		if (!/^[A-Za-z0-9_-]{8,128}$/.test(String(nonce || ''))) return false;
		if (seen.has(nonce)) return false;
		// Never evict an unexpired nonce to make room: accepting a new nonce is
		// preferable to reopening a replay window. The caller retries with a new
		// nonce only after the old one has expired.
		if (seen.size >= limit) return false;
		seen.set(nonce, at + windowMs);
		return true;
	};
}
export function verifyControlRequest(publicKey, { method, path, headers = {}, body, now = Date.now(), skewMs = 60000, nonce }) {
	const timestamp = Number(headers['x-relay-timestamp']), signature = headers['x-relay-signature'];
	if (!Number.isFinite(timestamp) || Math.abs(now - timestamp) > skewMs) return false;
	if (headers['x-relay-key-id'] && headers['x-relay-key-id'] !== fingerprint(publicKey)) return false;
	if (!verifyControl(publicKey, { method, path, timestamp, nonce: headers['x-relay-nonce'], body, signature })) return false;
	return nonce ? nonce(headers['x-relay-nonce'], now) : true;
}

/** Media capability: signed, scoped and idempotent for the session lifetime. */
export function createMediaToken(privateKey, payload) {
	const value = { v: 1, ...payload };
	return 'v1.' + Buffer.from(canonicalJson(value)).toString('base64url') + '.' + signText(privateKey, canonicalJson(value));
}
export function readMediaToken(token) {
	const parts = String(token || '').split('.');
	if (parts.length !== 3 || parts[0] !== 'v1') throw fail('Invalid media capability.', 403, 'RELAY_MEDIA_TOKEN');
	let payload;
	try { payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); }
	catch { throw fail('Invalid media capability.', 403, 'RELAY_MEDIA_TOKEN'); }
	return { payload, signature: parts[2], signed: parts[0] + '.' + parts[1] };
}
export function verifyMediaToken(publicKey, token, expected = {}, now = Date.now()) {
	const { payload, signature, signed } = readMediaToken(token);
	if (!verifyText(publicKey, canonicalJson(payload), signature)) throw fail('Invalid media capability.', 403, 'RELAY_MEDIA_TOKEN');
	if (payload.v !== 1 || !payload.jti || !payload.aud || !payload.leaseId || !payload.itemId || !payload.mode) throw fail('Invalid media capability.', 403, 'RELAY_MEDIA_TOKEN');
	if (!Number.isFinite(payload.exp) || payload.exp * 1000 <= now) throw fail('This media capability has expired.', 410, 'RELAY_MEDIA_EXPIRED');
	for (const key of ['aud', 'leaseId', 'sessionId', 'itemId', 'mode', 'generation']) {
		if (expected[key] !== undefined && payload[key] !== expected[key]) throw fail('This media capability is for another session.', 403, 'RELAY_MEDIA_SCOPE');
	}
	if (!Array.isArray(payload.resources) || !payload.resources.length) throw fail('Invalid media capability.', 403, 'RELAY_MEDIA_TOKEN');
	return payload;
}
export function resourceAllowed(payload, resourceClass) {
	return Array.isArray(payload.resources) && payload.resources.includes(resourceClass);
}
