import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, mkdirSync, chmodSync, statSync, openSync, closeSync, unlinkSync } from 'node:fs';
import path from 'node:path';
import { fingerprint, readPublicKey } from './protocol.mjs';

const fail = (message, status = 400, code = 'RELAY_REGISTRY') => Object.assign(Error(message), { status, code });
const equalHash = (value, expected) => {
	const actual = createHash('sha256').update(String(value)).digest();
	const target = Buffer.from(String(expected || ''), 'hex');
	return target.length === actual.length && timingSafeEqual(actual, target);
};
const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function safeControlUrl(value) {
	let url; try { url = new URL(value); } catch { throw fail('Enter a private worker control address.'); }
	if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw fail('Use a worker control origin without credentials, path, query or fragment.');
	if (url.port === '' || !/^\d+$/.test(url.port)) throw fail('The worker control address needs an explicit port.');
	return url.origin;
}
const safeText = (value, max = 200) => typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x1f]/.test(value);

/**
 * One approved worker per installation. The enrolment token is shown once and
 * stored hashed. Approval is explicit. No public admin route exists.
 *
 * Every mutation takes an exclusive sidecar lock, reloads the current file and
 * writes a unique temporary file before rename. A stale enrolment or heartbeat
 * can therefore never overwrite a newer approval or revocation.
 */
export function createWorkerRegistry(directory, { clock = Date.now, mainControlKey } = {}) {
	const file = path.join(directory, 'relay', 'workers.json'), lockFile = file + '.lock';
	mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	let state;
	try { state = JSON.parse(readFileSync(file, 'utf8')); }
	catch (error) { if (error.code !== 'ENOENT') throw Error('Relay worker registry could not be read; refusing to reset it.'); state = { version: 1, enrolment: null, workers: {} }; }
	if (state.version !== 1 || typeof state.workers !== 'object') throw Error('Unsupported relay worker registry.');
	let loadedAt = (() => { try { return statSync(file).mtimeMs; } catch { return 0; } })();
	function reload(force = false) {
		try {
			const mtime = statSync(file).mtimeMs;
			if (!force && mtime === loadedAt) return;
			const next = JSON.parse(readFileSync(file, 'utf8'));
			if (next?.version === 1 && typeof next.workers === 'object') { state = next; loadedAt = mtime; }
		} catch {}
	}
	function withLock(fn) {
		for (let attempt = 0; attempt < 400; attempt++) {
			try {
				const fd = openSync(lockFile, 'wx', 0o600);
				try {
					reload(true);
					const result = fn();
					const temp = file + '.' + process.pid + '.' + randomBytes(6).toString('hex') + '.tmp';
					writeFileSync(temp, JSON.stringify(state, null, '\t') + '\n', { mode: 0o600 }); chmodSync(temp, 0o600);
					renameSync(temp, file);
					loadedAt = statSync(file).mtimeMs;
					return result;
				} finally { closeSync(fd); try { unlinkSync(lockFile); } catch {} }
			} catch (error) {
				if (error.code !== 'EEXIST' || error.path !== lockFile) throw error;
				try { if (clock() - statSync(lockFile).mtimeMs > 15000) unlinkSync(lockFile); } catch {}
				sleep(5);
			}
		}
		throw fail('The relay worker registry is busy. Try again.', 409, 'RELAY_REGISTRY_BUSY');
	}
	const approved = () => { reload(); return Object.values(state.workers).find(worker => worker.state === 'approved') || null; };
	function createEnrolment(lifetimeSeconds = 600) {
		return withLock(() => {
			const token = randomBytes(32).toString('base64url');
			state.enrolment = { hash: createHash('sha256').update(token).digest('hex'), expires: clock() + Math.max(60, Math.min(3600, Number(lifetimeSeconds) || 600)) * 1000, usedAt: 0 };
			return { token, expires: state.enrolment.expires };
		});
	}
	function enrol(input = {}) {
		return withLock(() => {
			const enrolment = state.enrolment;
			if (!enrolment || enrolment.usedAt || enrolment.expires <= clock()) throw fail('This worker enrolment has expired. Create a new one.', 401, 'RELAY_ENROLMENT');
			if (typeof input.token !== 'string' || !equalHash(input.token, enrolment.hash)) throw fail('The worker enrolment token is not valid.', 401, 'RELAY_ENROLMENT');
			if (!safeText(input.workerId, 80) || !/^[A-Za-z0-9._:-]+$/.test(input.workerId)) throw fail('Choose a worker ID with letters, numbers, dot, colon, dash or underscore.');
			if (Object.values(state.workers).some(worker => worker.workerId !== input.workerId && worker.state !== 'revoked')) throw fail('Only one relay worker can be registered. Revoke the existing worker first.', 409);
			let key; try { key = readPublicKey(input.publicKey); } catch { throw fail('Send the worker Ed25519 public key.'); }
			const peer = String(input.peer || '').replace(/^::ffff:/, '');
			const worker = {
				workerId: input.workerId, state: 'pending', publicKey: key.export({ type: 'spki', format: 'pem' }), fingerprint: fingerprint(key),
				controlUrl: safeControlUrl(input.controlUrl), peer,
				mediaPrefix: '/relay-media', version: safeText(input.version, 80) ? input.version : 'unknown',
				capabilities: Array.isArray(input.capabilities) ? input.capabilities.filter(value => safeText(value, 40)).slice(0, 24) : [],
				selfTest: input.selfTest && typeof input.selfTest === 'object' ? { ok: input.selfTest.ok === true, at: clock(), detail: safeText(input.selfTest.detail, 160) ? input.selfTest.detail : '' } : null,
				registeredAt: clock(), approvedAt: 0, lastSeen: 0, lastHeartbeat: null, bytesOutTotal: 0
			};
			state.enrolment.usedAt = clock();
			state.workers[worker.workerId] = worker;
			return publicView(worker);
		});
	}
	function approve(workerId) {
		return withLock(() => {
			const worker = state.workers[workerId];
			if (!worker) throw fail('Unknown relay worker.', 404);
			if (worker.state === 'approved') return publicView(worker);
			if (worker.state === 'revoked') throw fail('This worker was revoked. Register it again with a new enrolment.', 409);
			if (approved()) throw fail('Only one relay worker can be approved.', 409);
			worker.state = 'approved'; worker.approvedAt = clock();
			return publicView(worker);
		});
	}
	function revoke(workerId) {
		return withLock(() => {
			const worker = state.workers[workerId];
			if (!worker) throw fail('Unknown relay worker.', 404);
			worker.state = 'revoked'; worker.revokedAt = clock();
			return publicView(worker);
		});
	}
	function rotate(workerId) {
		return withLock(() => {
			const worker = state.workers[workerId];
			if (!worker) throw fail('Unknown relay worker.', 404);
			worker.state = 'pending'; worker.approvedAt = 0; worker.lastSeen = 0;
			return publicView(worker);
		});
	}
	function touch(workerId, values = {}) {
		return withLock(() => {
			const worker = state.workers[workerId];
			if (!worker || worker.state !== 'approved') throw fail('Relay worker is not approved.', 403);
			worker.lastSeen = clock();
			if (Number.isFinite(values.bytesOutTotal)) worker.bytesOutTotal = values.bytesOutTotal;
			if (values.health && typeof values.health === 'object') {
				worker.lastHeartbeat = values;
				if (values.health.upstream === true) worker.selfTest = { ok: true, at: clock(), detail: 'authenticated worker heartbeat reported Dispatcharr reachable' };
				else if (values.health.upstream === false) worker.selfTest = { ok: false, at: clock(), detail: 'authenticated worker heartbeat reported Dispatcharr unreachable' };
			}
			return publicView(worker);
		});
	}
	function publicView(worker) {
		if (!worker) return null;
		return { workerId: worker.workerId, state: worker.state, fingerprint: worker.fingerprint, version: worker.version, capabilities: worker.capabilities,
			controlUrl: worker.controlUrl, mediaPrefix: worker.mediaPrefix, selfTest: worker.selfTest, registeredAt: worker.registeredAt, approvedAt: worker.approvedAt,
			lastSeen: worker.lastSeen, stale: worker.lastSeen ? clock() - worker.lastSeen > 30000 : true, bytesOutTotal: worker.bytesOutTotal };
	}
	function status() {
		reload();
		const worker = Object.values(state.workers)[0] || null;
		const enrolment = state.enrolment && !state.enrolment.usedAt && state.enrolment.expires > clock() ? { pending: true, expires: state.enrolment.expires } : null;
		return { worker: publicView(worker), enrolment, approved: Boolean(approved()) };
	}
	function approvedWorker() {
		const worker = approved();
		if (!worker) return null;
		return { ...publicView(worker), publicKey: worker.publicKey, peer: worker.peer, controlKeyId: mainControlKey ? fingerprint(mainControlKey?.privatePem || mainControlKey) : '' };
	}
	return { createEnrolment, enrol, approve, revoke, rotate, touch, status, approved: approvedWorker, publicView };
}
