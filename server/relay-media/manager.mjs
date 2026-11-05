import { createHash, randomUUID } from 'node:crypto';
import { createMediaToken } from './protocol.mjs';
import { createRelayLedger } from './ledger.mjs';
import { createRelayControlClient } from './control-client.mjs';

const fail = (message, status = 409, code = 'RELAY_MEDIA') => Object.assign(Error(message), { status, code });
const RESOURCES = ['hls', 'segment', 'file', 'subtitle'];
const MODES = new Set(['live', 'nonstop', 'vod', 'recording', 'catchup']);

/**
 * Main-side relay media authority. The worker executes; main owns accounts,
 * grants, revocation tombstone, route provenance and client heartbeat rules.
 */
export function createRelayMedia({ directory, registry, mainKeys, accountLimits, publicOrigin = '', clock = Date.now, fetcher = fetch,
	maxSessions = 3, maxGrantSeconds = 45, clientHeartbeatTimeoutMs = 30000, tombstoneMs = 90000, freshnessMs = 15000,
	maxSessionSeconds = 6 * 60 * 60 } = {}) {
	const leases = new Map();
	const egress = { bytesOutTotal: 0, sessions: new Map(), updated: 0 };
	const ledger = createRelayLedger({ clock,
		chargedSeconds: accountKey => { const status = accountLimits?.status?.(accountKey); return Math.max(Number(status?.seconds || 0), Number(status?.dailySeconds || 0)); },
		allowanceSeconds: accountKey => {
			const status = accountLimits?.status?.(accountKey);
			if (!status) return null;
			const manual = status.minutes ? status.minutes * 60 : null;
			const daily = status.dailyMinutes ? status.dailyMinutes * 60 : null;
			const values = [manual, daily].filter(value => value !== null);
			return values.length ? Math.min(...values) : null;
		},
		chargeDifference: (accountKey, seconds) => accountLimits?.charge?.(accountKey, seconds),
		maxGrantSeconds });
	function worker() {
		const approved = registry?.approved?.();
		return approved || null;
	}
	function workerFresh(approved = worker()) {
		return Boolean(approved && approved.lastSeen && clock() - approved.lastSeen <= freshnessMs);
	}
	function enabled() { return Boolean(worker()); }
	function unavailable() {
		const approved = worker();
		if (!approved) throw fail('Relay playback is not available. Register and approve the relay worker in Installation settings. Main media was not used.', 409, 'RELAY_WORKER_UNAVAILABLE');
		if (!workerFresh(approved)) throw fail('The relay worker has not reported for 15 seconds. Relay playback is unavailable; main media was not used.', 409, 'RELAY_WORKER_STALE');
		if (leases.size >= maxSessions) throw fail('All relay playback slots are busy. Stop another stream and try again.', 429, 'RELAY_CAPACITY');
		return approved;
	}
	function accountFor(viewer, { share = false, sessionId = '' } = {}) {
		if (share) return { accountKey: 'share:' + String(sessionId || 'relay'), unlimited: true };
		const accountKey = accountLimits?.key?.(viewer) || (viewer?.local || viewer?.home ? 'local:relay' : '');
		if (!accountKey) throw fail('Relay playback needs a linked viewer account.', 403, 'RELAY_ACCOUNT');
		const remaining = accountLimits?.viewing?.(viewer)?.remainingSeconds;
		return { accountKey, unlimited: remaining === null || remaining === undefined || accountKey === 'local:relay' };
	}
	function publicPath(sessionUrl) {
		const path = String(sessionUrl || '');
		if (!path.startsWith('/relay-media/v1/s/')) throw fail('The worker returned an invalid media path.', 502, 'RELAY_WORKER_PROTOCOL');
		return path;
	}
	function playbackUrl(sessionUrl, { local = false } = {}) {
		const path = publicPath(sessionUrl);
		if (!local) return path;
		if (!publicOrigin.startsWith('https://')) throw fail('Relay playback from the local site needs the public HTTPS address. It was not silently switched to main media.', 409, 'RELAY_PUBLIC_ORIGIN');
		return new URL(path, publicOrigin).href;
	}
	function acquireGrant(lease) {
		const grants = ledger.allocate(lease.accountKey, [lease.leaseId], { now: clock() });
		const seconds = grants[lease.leaseId] || 0;
		lease.grantSeconds = seconds;
		lease.grantEndsAt = seconds ? clock() + seconds * 1000 : 0;
		lease.leaseExpiresAt = lease.grantEndsAt;
		return seconds;
	}
	function requestBody(lease, approved, extra = {}) {
		return {
			workerId: approved.workerId, leaseId: lease.leaseId, workerSessionId: lease.workerSessionId || '',
			accountKeyHash: createHash('sha256').update(lease.accountKey).digest('hex').slice(0, 32),
			itemId: lease.itemId, mode: lease.mode, modeParameters: lease.params,
			quality: lease.quality, audioIndex: lease.audioIndex, subtitleIndex: lease.subtitleIndex, position: lease.position,
			externalSubtitle: lease.externalSubtitle, maxSessionSeconds: lease.maxSessionSeconds, maxBytes: lease.maxBytes,
			hardEndsAt: lease.hardEndsAt, allowedResourceClasses: RESOURCES,
			capability: lease.capability, generation: lease.generation, grantSeconds: lease.grantSeconds || 0,
			duration: lease.duration || 0, audio: lease.audio || [], subtitles: lease.subtitles || [], needsMetadata: true,
			...extra
		};
	}
	async function prepare({ session, viewer, itemId, mode, params = {}, quality = 8000000, audioIndex, subtitleIndex, position = 0, textSubtitles = false,
		externalSubtitle = null, maxBytes = 0, local = false, share = false, onRelease } = {}) {
		const approved = unavailable();
		if (!MODES.has(mode)) throw fail('Unsupported relay media mode.', 400, 'RELAY_MODE');
		const { accountKey, unlimited } = accountFor(viewer, { share, sessionId: session?.id });
		const leaseId = randomUUID(), generation = 1;
		const now = clock();
		const lease = { leaseId, sessionId: session?.id || randomUUID(), accountKey, unlimited, viewer, itemId: String(itemId), mode, params,
			quality, audioIndex, subtitleIndex, textSubtitles, externalSubtitle, maxBytes, position: Math.max(0, Number(position) || 0),
			maxSessionSeconds: Math.max(1, Math.min(12 * 60 * 60, Number(maxSessionSeconds) || 6 * 60 * 60)),
			hardEndsAt: now + Math.max(1, Math.min(12 * 60 * 60, Number(maxSessionSeconds) || 6 * 60 * 60)) * 1000,
			generation, createdAt: now, clientHeartbeat: now, grantSeconds: 0, grantEndsAt: 0, revoked: false, tombstoneUntil: 0,
			workerSessionId: '', sessionUrl: '', capability: '', onRelease, stopped: false };
		ledger.register(leaseId, accountKey, { unlimited });
		const seconds = acquireGrant(lease);
		if (!seconds) { ledger.settle(leaseId, { acknowledged: true, reason: 'no_budget' }); throw fail('This account has no viewing allowance left for relay playback.', 429, 'RELAY_BUDGET'); }
		lease.capability = createMediaToken(mainKeys.media.privateKey, {
			aud: approved.workerId, leaseId, sessionId: lease.sessionId, itemId: lease.itemId, mode, generation,
			resources: RESOURCES, iat: Math.floor(now / 1000), exp: Math.floor(now / 1000) + lease.maxSessionSeconds, jti: randomUUID()
		});
		const control = createRelayControlClient({ worker: approved, mainKey: mainKeys.control, fetcher, clock });
		try {
			const result = await control.prepare(requestBody(lease, approved), `${leaseId}:${generation}`);
			lease.workerSessionId = result.workerSessionId || '';
			lease.sessionUrl = publicPath(result.sessionUrl);
			lease.duration = Number(result.duration) || 0;
			lease.method = result.method || '';
			lease.audio = result.audio || [];
			lease.subtitles = result.subtitles || [];
			if (Number.isInteger(result.subtitleIndex)) lease.subtitleIndex = result.subtitleIndex;
			lease.position = Number(result.position) || lease.position;
			leases.set(leaseId, lease);
			return { ...result, url: playbackUrl(lease.sessionUrl, { local }), mediaRoute: 'relay', routeSource: 'lease', workerId: approved.workerId, leaseId, generation,
				duration: lease.duration, audio: lease.audio, subtitles: lease.subtitles, subtitleIndex: lease.subtitleIndex, position: lease.position, grantSeconds: seconds };
		} catch (error) {
			ledger.settle(leaseId, { acknowledged: true, reason: 'prepare_failed' });
			try { await control.stop({ workerId: approved.workerId, leaseId, sessionId: lease.sessionId, workerSessionId: lease.workerSessionId, reason: 'prepare_failed' }, `${leaseId}:${generation}:prepare_failed`); } catch {}
			throw error;
		}
	}
	async function replace(leaseId, changes = {}) {
		const lease = leases.get(leaseId);
		if (!lease || lease.stopped || lease.revoked) throw fail('This relay session has ended.', 410, 'RELAY_SESSION_ENDED');
		const approved = worker();
		if (!approved) throw fail('The relay worker is unavailable.', 503, 'RELAY_WORKER_UNAVAILABLE');
		lease.generation += 1;
		Object.assign(lease, { quality: changes.quality ?? lease.quality, audioIndex: changes.audioIndex ?? lease.audioIndex,
			subtitleIndex: changes.subtitleIndex ?? lease.subtitleIndex, externalSubtitle: changes.externalSubtitle ?? lease.externalSubtitle,
			position: changes.position === undefined ? lease.position : Math.max(0, Number(changes.position) || 0) });
		lease.capability = createMediaToken(mainKeys.media.privateKey, {
			aud: approved.workerId, leaseId, sessionId: lease.sessionId, itemId: lease.itemId, mode: lease.mode, generation: lease.generation,
			resources: RESOURCES, iat: Math.floor(clock() / 1000), exp: Math.floor(clock() / 1000) + lease.maxSessionSeconds, jti: randomUUID()
		});
		const control = createRelayControlClient({ worker: approved, mainKey: mainKeys.control, fetcher, clock });
		try {
			const result = await control.replace(requestBody(lease, approved, { previousWorkerSessionId: lease.workerSessionId }), `${leaseId}:${lease.generation}`);
			lease.workerSessionId = result.workerSessionId || lease.workerSessionId;
			lease.sessionUrl = publicPath(result.sessionUrl || lease.sessionUrl);
			lease.duration = Number(result.duration) || lease.duration;
			lease.method = result.method || lease.method;
			lease.audio = result.audio || lease.audio;
			lease.subtitles = result.subtitles || lease.subtitles;
			if (Number.isInteger(result.subtitleIndex)) lease.subtitleIndex = result.subtitleIndex;
			lease.position = Number(result.position) || lease.position;
			return { ...result, url: playbackUrl(lease.sessionUrl), mediaRoute: 'relay', routeSource: 'lease', workerId: approved.workerId, leaseId, generation: lease.generation,
				duration: lease.duration, audio: lease.audio, subtitles: lease.subtitles, subtitleIndex: lease.subtitleIndex, position: lease.position, method: lease.method };
		} catch (error) {
			lease.generation -= 1;
			throw error;
		}
	}
	function clientHeartbeat(leaseId) {
		const lease = leases.get(leaseId);
		if (!lease || lease.revoked || lease.stopped) return false;
		lease.clientHeartbeat = clock();
		return true;
	}
	async function stop(leaseId, { acknowledged = true, reason = 'client_stop' } = {}) {
		const lease = leases.get(leaseId);
		if (!lease) return { stopped: true, already: true };
		if (lease.stopped) return { stopped: true, already: true };
		lease.stopped = true;
		const approved = worker();
		let ack = false;
		if (approved) {
			try {
				const control = createRelayControlClient({ worker: approved, mainKey: mainKeys.control, fetcher, clock });
				await control.stop({ workerId: approved.workerId, leaseId, sessionId: lease.sessionId, workerSessionId: lease.workerSessionId, reason }, `${leaseId}:${lease.generation}:stop`);
				ack = true;
			} catch { ack = false; }
		}
		const settlement = ledger.settle(leaseId, { acknowledged, reason });
		leases.delete(leaseId);
		try { await lease.onRelease?.(lease.sessionId, { ack, reason, settlement }); } catch {}
		return { stopped: true, acknowledged: ack, settlement };
	}
	async function revoke(leaseId, reason = 'revoked') {
		const lease = leases.get(leaseId);
		if (!lease || lease.stopped) return { stopped: true, already: true };
		lease.revoked = true;
		lease.tombstoneUntil = lease.tombstoneUntil || clock() + tombstoneMs;
		const approved = worker();
		let ack = false;
		if (approved) {
			try {
				const control = createRelayControlClient({ worker: approved, mainKey: mainKeys.control, fetcher, clock });
				await control.stop({ workerId: approved.workerId, leaseId, sessionId: lease.sessionId, workerSessionId: lease.workerSessionId, reason: 'revoked' }, `${leaseId}:${lease.generation}:revoke`);
				ack = true;
			} catch { ack = false; }
		}
		// Lost contact: charge only the unreconciled outstanding part once.
		const settlement = ledger.settle(leaseId, { lostContact: !ack, reason });
		lease.stopped = true;
		if (ack) {
			leases.delete(leaseId);
			try { await lease.onRelease?.(lease.sessionId, { ack: true, reason, settlement }); } catch {}
		}
		return { revoked: true, acknowledged: ack, tombstoneUntil: lease.tombstoneUntil, settlement };
	}
	function tombstoneTick() {
		for (const lease of leases.values()) {
			if (!lease.stopped || !lease.tombstoneUntil) continue;
			if (clock() >= lease.tombstoneUntil) {
				leases.delete(lease.leaseId);
				try { lease.onRelease?.(lease.sessionId, { ack: false, reason: 'tombstone_expired' }); } catch {}
			}
		}
	}
	function tick() {
		tombstoneTick();
		for (const lease of [...leases.values()]) {
			if (lease.stopped || lease.revoked) continue;
			if (clock() - lease.clientHeartbeat > clientHeartbeatTimeoutMs) { void revoke(lease.leaseId, 'client_heartbeat_timeout'); continue; }
			const remaining = lease.grantEndsAt - clock();
			if (remaining <= Math.min(10000, maxGrantSeconds * 1000 / 2)) acquireGrant(lease);
			if (!lease.grantEndsAt || clock() >= lease.grantEndsAt && lease.grantSeconds === 0) { void revoke(lease.leaseId, 'budget_exhausted'); }
		}
	}
	const pending = new Set();
	function track(promise) { pending.add(promise); promise.finally(() => pending.delete(promise)); return promise; }
	function workerHeartbeat({ workerId, body = {} } = {}) {
		const approved = worker();
		if (!approved || approved.workerId !== workerId) throw fail('Relay worker is not approved.', 403, 'RELAY_WORKER_IDENTITY');
		const reported = body.health && typeof body.health === 'object' ? body.health : {};
		const health = { capacity: body.capacity, resources: body.resources, version: body.version, at: clock() };
		// Only an explicit signed boolean may change self-test health. Strings,
		// missing fields and other truthy values are ignored.
		if (reported.upstream === true || reported.upstream === false) health.upstream = reported.upstream;
		registry.touch(workerId, { bytesOutTotal: Number(body.bytesOutTotal) || 0, health });
		egress.bytesOutTotal = Number(body.bytesOutTotal) || egress.bytesOutTotal;
		egress.updated = clock();
		const instructions = [];
		for (const item of Array.isArray(body.leases) ? body.leases.slice(0, maxSessions) : []) {
			const lease = leases.get(item.leaseId);
			if (!lease || lease.stopped || lease.revoked) { instructions.push({ leaseId: item.leaseId, action: 'stop' }); continue; }
			lease.lastWorkerSeq = Number(item.seq) || lease.lastWorkerSeq || 0;
			lease.bytesOutTotal = Number(item.bytesOutTotal) || 0;
			egress.sessions.set(lease.leaseId, lease.bytesOutTotal);
			if (clock() - lease.clientHeartbeat > clientHeartbeatTimeoutMs) {
				instructions.push({ leaseId: lease.leaseId, action: 'stop', reason: 'client_heartbeat_timeout' });
				void revoke(lease.leaseId, 'client_heartbeat_timeout');
				continue;
			}
			if (lease.grantEndsAt - clock() < 15000) acquireGrant(lease);
			if (!lease.grantSeconds) { instructions.push({ leaseId: lease.leaseId, action: 'stop', reason: 'budget_exhausted' }); void revoke(lease.leaseId, 'budget_exhausted'); continue; }
			instructions.push({ leaseId: lease.leaseId, action: 'renew', grantSeconds: lease.grantSeconds, remainingSeconds: Math.max(0, Math.ceil((lease.grantEndsAt - clock()) / 1000)), hardEndsAt: lease.hardEndsAt });
		}
		return { serverTime: clock(), instructions, maxSessionSeconds };
	}
	function status() {
		const approved = worker();
		return { enabled: enabled(), worker: approved ? { workerId: approved.workerId, fingerprint: approved.fingerprint, lastSeen: approved.lastSeen, fresh: workerFresh(approved) } : null,
			sessions: [...leases.values()].filter(lease => !lease.stopped).length, egress: { bytesOutTotal: egress.bytesOutTotal, updated: egress.updated },
			resourceClasses: RESOURCES, maxSessions, maxGrantSeconds };
	}
	return { prepare, replace, stop, revoke, clientHeartbeat, tick, workerHeartbeat, status, enabled, playbackUrl, ledger, leases, egress,
		_track: track, _settled: () => Promise.allSettled([...pending]) };
}
