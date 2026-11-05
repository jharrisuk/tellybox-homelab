#!/usr/bin/env node
/**
 * One-time worker enrolment. Run on the relay host, not on main.
 * The token is shown once by Installation settings and is never stored here.
 */
import { readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { loadOrCreateKey } from '../../server/relay-media/keys.mjs';

const env = process.env;
const data = env.RELAY_DATA_DIR || '/data';
mkdirSync(data, { recursive: true, mode: 0o700 });
const worker = loadOrCreateKey(env.RELAY_WORKER_KEY_FILE || path.join(data, 'worker-key.json'), 'relay worker');
const main = String(env.RELAY_MAIN_ENROL_URL || '').replace(/\/+$/, '');
const token = env.RELAY_ENROL_TOKEN || (env.RELAY_ENROL_TOKEN_FILE ? readFileSync(env.RELAY_ENROL_TOKEN_FILE, 'utf8').trim() : '');
if (!main || !token) throw Error('Set RELAY_MAIN_ENROL_URL (private main /internal/worker/enrol) and RELAY_ENROL_TOKEN.');
const body = { token, workerId: env.RELAY_WORKER_ID || 'relay-worker', publicKey: worker.publicPem,
	controlUrl: env.RELAY_CONTROL_URL || '', mediaPrefix: '/relay-media', version: env.RELAY_WORKER_VERSION || '0.26.9',
	capabilities: ['live', 'nonstop', 'vod', 'recording', 'catchup', 'range', 'subtitle'],
	selfTest: { ok: env.RELAY_SELF_TEST_OK === '1', detail: env.RELAY_SELF_TEST_DETAIL || 'enrolment; awaiting authenticated worker health' } };
const response = await fetch(main, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(10000) });
const text = await response.text();
if (!response.ok) throw Error('Enrolment failed: ' + (() => { try { return JSON.parse(text).error; } catch { return response.status; } })());
const result = JSON.parse(text);
for (const [name, value] of [['main-control-public.pem', result.mainControlPublicKey], ['main-media-public.pem', result.mainMediaPublicKey]]) {
	if (typeof value !== 'string' || !value.includes('PUBLIC KEY')) throw Error('Main did not return a pinned public key.');
	const file = path.join(data, name);
	writeFileSync(file, value, { mode: 0o600 }); chmodSync(file, 0o600);
}
console.log(JSON.stringify({ workerId: result.worker?.workerId, state: result.worker?.state, fingerprint: worker.fingerprint, next: 'Approve this worker in Installation settings, then start the isolated worker service.' }, null, 2));
