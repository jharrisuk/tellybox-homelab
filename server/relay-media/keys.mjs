import { generateKeyPairSync, createPublicKey, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { fingerprint, readPrivateKey } from './protocol.mjs';

function readAndValidate(file, label) {
	const saved = JSON.parse(readFileSync(file, 'utf8'));
	if (typeof saved.privateKey !== 'string' || !saved.privateKey.includes('PRIVATE KEY') || typeof saved.publicKey !== 'string') throw Error(label + ' key file is invalid; refusing to replace it.');
	const privateKey = readPrivateKey(saved.privateKey);
	const derived = createPublicKey(privateKey).export({ type: 'spki', format: 'pem' });
	if (derived.replace(/\s+/g, '') !== saved.publicKey.replace(/\s+/g, '')) throw Error(label + ' key pair does not match; refusing to replace it.');
	return { file, privateKey, privatePem: saved.privateKey, publicPem: saved.publicKey, fingerprint: fingerprint(saved.publicKey), created: saved.created || 0 };
}

/** Runtime-only Ed25519 identity. Never writes into the repository or logs. */
export function loadOrCreateKey(file, label = 'relay') {
	mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	if (existsSync(file)) return readAndValidate(file, label);
	const pair = generateKeyPairSync('ed25519');
	const privatePem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' });
	const publicPem = pair.publicKey.export({ type: 'spki', format: 'pem' });
	const saved = { privateKey: privatePem, publicKey: publicPem, created: Date.now(), id: randomBytes(8).toString('hex') };
	try {
		// Exclusive create. If another process won the race, load its complete file
		// instead of overwriting it. No shared temporary filename is used.
		writeFileSync(file, JSON.stringify(saved), { mode: 0o600, flag: 'wx' });
		chmodSync(file, 0o600);
		return { file, privateKey: pair.privateKey, privatePem, publicPem, fingerprint: fingerprint(publicPem), created: saved.created };
	} catch (error) {
		if (error.code !== 'EEXIST') throw error;
		return readAndValidate(file, label);
	}
}
export function loadOrCreateMainKeys(directory) {
	const control = loadOrCreateKey(path.join(directory, 'relay', 'main-control-key.json'), 'main control');
	const media = loadOrCreateKey(path.join(directory, 'relay', 'main-media-key.json'), 'main media');
	return { control, media };
}
