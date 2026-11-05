import express from 'express';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createNonceCache, fingerprint, readPublicKey, verifyControlRequest } from './protocol.mjs';
import { loadOrCreateMainKeys } from './keys.mjs';
import { createWorkerRegistry } from './registry.mjs';
import { createRelayMedia } from './manager.mjs';

const fail = (message, status = 403, code = 'RELAY_INTERNAL') => Object.assign(Error(message), { status, code });
export function normalizePeer(value = '') {
	return String(value).replace(/^::ffff:/, '');
}
export function privateWorkerPeer(address = '') {
	const value = normalizePeer(address);
	if (value === '::1' || value.startsWith('127.') || value.startsWith('10.')) return true;
	const match = /^172\.(\d+)\./.exec(value);
	if (match && Number(match[1]) >= 16 && Number(match[1]) <= 31) return true;
	if (value.startsWith('192.168.')) return true;
	if (/^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(value)) return true;
	return /^f[cd][0-9a-f]{2}:/i.test(value);
}
export function forwardedHeaders(headers = {}) {
	return Object.keys(headers).some(name => name === 'forwarded' || name === 'x-real-ip' || name === 'true-client-ip' || name.startsWith('x-forwarded-') || name.startsWith('cf-'));
}
/** Enrolment is accepted only from loopback, the Tailscale CGNAT range or an exact configured peer. */
export function tailnetPeer(address, configured = '') {
	const value = normalizePeer(address);
	if (configured) return value === normalizePeer(configured);
	return value === '::1' || value.startsWith('127.') || /^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(value) || /^f[cd][0-9a-f]{2}:/i.test(value);
}
function createEnabledService({ directory, accountLimits, publicOrigin = '', clock = Date.now, fetcher = fetch, maxSessions = 3 }) {
	const keys = loadOrCreateMainKeys(directory);
	const registry = createWorkerRegistry(directory, { clock, mainControlKey: keys.control });
	const manager = createRelayMedia({ directory, registry, mainKeys: keys, accountLimits, publicOrigin, clock, fetcher, maxSessions });
	const nonce = createNonceCache({ clock });
	const peerAllowed = (req, expected = '') => tailnetPeer(req.socket?.remoteAddress, expected || process.env.RELAY_WORKER_ALLOWED_IP || '');
	function enrol(req, res) {
		if (!peerAllowed(req)) return res.status(403).json({ error: 'Worker enrolment is private.' });
		try {
			const worker = registry.enrol({ ...(req.body || {}), peer: normalizePeer(req.socket?.remoteAddress) });
			return res.status(201).json({ worker, mainControlPublicKey: keys.control.publicPem, mainMediaPublicKey: keys.media.publicPem,
				mediaPrefix: '/relay-media', heartbeatPath: '/internal/worker/heartbeat', controlKeyId: fingerprint(keys.control.privatePem) });
		} catch (error) { return res.status(error.status || 400).json({ error: error.message, code: error.code }); }
	}
	function heartbeat(req, res) {
		const worker = registry.approved();
		if (!worker || worker.workerId !== req.body?.workerId) return res.status(403).json({ error: 'Worker is not approved.', code: 'RELAY_WORKER_IDENTITY' });
		// Signature first. The pinned key is the authority; source IP only narrows
		// the accepted network path. Forwarded headers are never trusted.
		if (forwardedHeaders(req.headers)) return res.status(403).json({ error: 'Worker control must not use forwarded headers.', code: 'RELAY_WORKER_PEER' });
		const valid = verifyControlRequest(readPublicKey(worker.publicKey), { method: req.method, path: req.path, headers: req.headers, body: req.body, now: clock(), nonce });
		if (!valid) return res.status(401).json({ error: 'Worker control signature failed.', code: 'RELAY_WORKER_AUTH' });
		const source = normalizePeer(req.socket?.remoteAddress), configured = normalizePeer(process.env.RELAY_WORKER_ALLOWED_IP || worker.peer || '');
		const exact = Boolean(configured && source === configured);
		// A rootless Podman bridge can present a private gateway address instead
		// of the registered tailnet address. A valid pinned signature plus a
		// non-public source is accepted; public sources are always rejected.
		if (!exact && !privateWorkerPeer(source)) return res.status(403).json({ error: 'Worker control is private.', code: 'RELAY_WORKER_PEER' });
		try { return res.json(manager.workerHeartbeat({ workerId: worker.workerId, body: req.body })); }
		catch (error) { return res.status(error.status || 500).json({ error: error.message, code: error.code }); }
	}
	function health(req, res) {
		const approved = registry.approved(), expected = process.env.RELAY_WORKER_ALLOWED_IP || approved?.peer || '';
		if (!approved || !expected || normalizePeer(req.socket?.remoteAddress) !== normalizePeer(expected)) return res.status(403).json({ error: 'Worker control is private.' });
		return res.json({ ok: true, ...manager.status(), controlKeyId: keys.control.fingerprint, mediaKeyId: keys.media.fingerprint });
	}
	function install(app) {
		app.post('/internal/worker/enrol', enrol);
		app.post('/internal/worker/heartbeat', heartbeat);
		app.get('/internal/worker/health', health);
	}
	return { install, installRoutes: { enrol, heartbeat, health }, registry, keys, manager,
		status: () => ({ ...registry.status(), media: manager.status(), controlKeyId: keys.control.fingerprint, mediaKeyId: keys.media.fingerprint, publicOrigin }) };
}

export function createRelayMediaService(options) {
	const { directory, enabled = true } = options;
	const keyFile = path.join(directory, 'relay', 'main-control-key.json');
	let impl = null;
	// Never create keys just because the optional feature is off. An explicit
	// administrator enrolment creates them; a media-process restart then adopts
	// the existing files lazily.
	const canBuild = () => enabled || existsSync(keyFile);
	const build = () => { if (!impl && canBuild()) impl = createEnabledService(options); return impl; };
	const need = () => { const value = build(); if (!value) throw fail('Relay media is disabled in installation settings.', 409, 'RELAY_DISABLED'); return value; };
	const service = {
		install(app) {
			app.post('/internal/worker/enrol', (req, res) => {
				const value = build();
				if (!value) return res.status(409).json({ error: 'Relay media is disabled. Create an enrolment in Installation settings first.', code: 'RELAY_DISABLED' });
				return value.installRoutes.enrol(req, res);
			});
			app.post('/internal/worker/heartbeat', (req, res) => {
				const value = build();
				if (!value) return res.status(409).json({ error: 'Relay media is disabled.', code: 'RELAY_DISABLED' });
				return value.installRoutes.heartbeat(req, res);
			});
			app.get('/internal/worker/health', (req, res) => {
				const value = build();
				if (!value) return res.status(409).json({ error: 'Relay media is disabled.', code: 'RELAY_DISABLED' });
				return value.installRoutes.health(req, res);
			});
		},
		status: () => build()?.status() || { enabled: false, approved: false, worker: null },
		prepare: (...args) => need().manager.prepare(...args),
		replace: (...args) => need().manager.replace(...args),
		stop: (...args) => need().manager.stop(...args),
		revoke: (...args) => need().manager.revoke(...args),
		clientHeartbeat: (...args) => build()?.manager.clientHeartbeat(...args) || false,
		tick: () => build()?.manager.tick(),
		enabled: () => Boolean(build()?.manager.enabled()),
		createEnrolment: (...args) => need().registry.createEnrolment(...args),
		approve: (...args) => need().registry.approve(...args),
		revokeWorker: (...args) => need().registry.revoke(...args),
		rotateWorker: (...args) => need().registry.rotate(...args)
	};
	Object.defineProperties(service, {
		registry: { get: () => build()?.registry || null },
		keys: { get: () => build()?.keys || null },
		manager: { get: () => build()?.manager || { status: () => ({ enabled: false, sessions: 0 }), tick() {} } },
		leases: { get: () => build()?.manager.leases || new Map() },
		ledger: { get: () => build()?.manager.ledger || null }
	});
	return service;
}
