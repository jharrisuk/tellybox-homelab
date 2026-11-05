#!/usr/bin/env node
import { readFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { loadOrCreateKey } from '../../server/relay-media/keys.mjs';
import { readPublicKey } from '../../server/relay-media/protocol.mjs';
import { createWorkerUpstream } from './upstream.mjs';
import { createWorkerPlayers } from './players.mjs';
import { createRelayWorker } from './worker.mjs';

const env = process.env;
const dataDirectory = env.RELAY_DATA_DIR || '/data';
mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });
const workerKeyFile = env.RELAY_WORKER_KEY_FILE || path.join(dataDirectory, 'worker-key.json');
const workerKey = loadOrCreateKey(workerKeyFile, 'relay worker');
const mainControlPem = env.RELAY_MAIN_CONTROL_KEY || (env.RELAY_MAIN_CONTROL_KEY_FILE ? readFileSync(env.RELAY_MAIN_CONTROL_KEY_FILE, 'utf8') : '');
const mainMediaPem = env.RELAY_MAIN_MEDIA_KEY || (env.RELAY_MAIN_MEDIA_KEY_FILE ? readFileSync(env.RELAY_MAIN_MEDIA_KEY_FILE, 'utf8') : '');
if (!mainControlPem || !mainMediaPem) throw Error('Pinned main control and media public keys are required. Enrol the worker first.');
const dispatcharrKey = env.DISPATCHARR_KEY || (env.DISPATCHARR_KEY_FILE ? readFileSync(env.DISPATCHARR_KEY_FILE, 'utf8').trim() : '');
const upstream = createWorkerUpstream({ origin: env.DISPATCHARR_URL || 'http://127.0.0.1:9191', key: dispatcharrKey });
const players = createWorkerPlayers({ upstream, maxSessions: Number(env.MAX_RELAY_SESSIONS || 3) });
const worker = createRelayWorker({
	workerId: env.RELAY_WORKER_ID || 'relay-worker',
	version: env.RELAY_WORKER_VERSION || '0.26.9',
	mainControlPublicKey: readPublicKey(mainControlPem), mainMediaPublicKey: readPublicKey(mainMediaPem), workerPrivateKey: workerKey.privateKey,
	mainHeartbeatUrl: env.RELAY_MAIN_HEARTBEAT_URL || '', dataDirectory, players, upstream,
	maxSessions: Number(env.MAX_RELAY_SESSIONS || 3), maxFfmpegJobs: Number(env.MAX_FFMPEG_JOBS || 3),
	heartbeatMs: Number(env.RELAY_HEARTBEAT_MS || 10000), freshnessMs: Number(env.RELAY_FRESHNESS_MS || 15000), outageMs: Number(env.RELAY_OUTAGE_MS || 45000)
});
const media = worker.mediaServer();
const control = worker.controlServer();
const mediaPort = Number(env.RELAY_MEDIA_PORT || 18086), controlPort = Number(env.RELAY_CONTROL_PORT || 18087);
media.listen(mediaPort, env.RELAY_MEDIA_BIND || '127.0.0.1', () => console.log('Relay worker media on loopback port ' + mediaPort + '.'));
control.listen(controlPort, env.RELAY_CONTROL_BIND || '127.0.0.1', () => console.log('Relay worker private control on port ' + controlPort + '.'));
worker.start();
console.log('Relay worker ' + (env.RELAY_WORKER_ID || 'relay-worker') + ' public key fingerprint ' + workerKey.fingerprint + '.');
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => { await worker.close(); media.close(); control.close(); process.exit(0); });
