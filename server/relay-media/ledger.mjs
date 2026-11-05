const fail = (message, code = 'RELAY_BUDGET') => Object.assign(Error(message), { status: 429, code });

/**
 * One atomic per-account pool. This is a reservation ledger around the existing
 * account charge, never a second minute counter.
 *
 * Invariant while any grant is outstanding:
 *   chargedSeconds + outstandingGrantSeconds <= allowanceSeconds
 *
 * Unlimited accounts still receive short grants. Grant duration is not an
 * entitlement; the worker hard-stops at the granted seconds.
 */
export function createRelayLedger({ clock = Date.now, chargedSeconds = () => 0, allowanceSeconds = () => null, maxGrantSeconds = 45, minGrantSeconds = 1, chargeDifference = () => {}, onChange = () => {} } = {}) {
	if (!Number.isInteger(maxGrantSeconds) || maxGrantSeconds < 1 || maxGrantSeconds > 300) throw fail('Invalid relay grant window.', 'RELAY_CONFIG');
	if (!Number.isInteger(minGrantSeconds) || minGrantSeconds < 1 || minGrantSeconds > maxGrantSeconds) throw fail('Invalid relay minimum grant.', 'RELAY_CONFIG');
	const leases = new Map();
	const byAccount = new Map();
	const accounts = () => {
		const ids = new Set([...leases.values()].map(lease => lease.accountKey));
		return ids;
	};
	function accountState(accountKey) {
		if (!byAccount.has(accountKey)) byAccount.set(accountKey, { accountKey, grants: new Map(), released: 0, charged: 0 });
		return byAccount.get(accountKey);
	}
	function outstanding(accountKey) {
		let seconds = 0;
		for (const lease of leases.values()) if (lease.accountKey === accountKey && lease.grantSeconds > 0) seconds += lease.grantSeconds;
		return seconds;
	}
	function allowance(accountKey) {
		const value = allowanceSeconds(accountKey);
		return value === null || value === undefined ? null : Math.max(0, Number(value));
	}
	function finiteAvailable(accountKey) {
		const total = allowance(accountKey);
		if (total === null) return null;
		return Math.max(0, total - Number(chargedSeconds(accountKey) || 0) - outstanding(accountKey));
	}
	function register(leaseId, accountKey, { unlimited = false } = {}) {
		if (!/^[A-Za-z0-9_-]{8,128}$/.test(String(leaseId || ''))) throw fail('Invalid relay lease.', 'RELAY_LEASE');
		if (!accountKey) throw fail('Relay playback needs a linked account.', 'RELAY_ACCOUNT');
		const prior = leases.get(leaseId);
		if (prior && prior.accountKey !== accountKey) throw fail('Relay lease cannot move between accounts.', 'RELAY_LEASE');
		const lease = prior || { leaseId, accountKey, unlimited: Boolean(unlimited), grantSeconds: 0, grantAt: 0, baselineCharge: 0, generation: 0, released: false };
		lease.unlimited = Boolean(unlimited);
		leases.set(leaseId, lease);
		accountState(accountKey);
		onChange(snapshot(accountKey));
		return lease;
	}
	function expire(leaseId) {
		const lease = leases.get(leaseId);
		if (!lease || lease.released || lease.grantSeconds <= 0) return null;
		const result = settle(leaseId, { lostContact: false, reason: 'expired' });
		return result;
	}
	/** Release unused reservation. Existing account charge already covers consumed time. */
	function settle(leaseId, { lostContact = false, acknowledged = false, reason = '' } = {}) {
		const lease = leases.get(leaseId);
		if (!lease || lease.released) return { leaseId, released: false, grantSeconds: 0, consumedSeconds: 0, extraChargeSeconds: 0 };
		if (lease.grantSeconds <= 0) { lease.released = true; leases.delete(leaseId); return { leaseId, released: true, grantSeconds: 0, consumedSeconds: 0, extraChargeSeconds: 0 }; }
		const current = Number(chargedSeconds(lease.accountKey) || 0);
		const consumed = Math.max(0, Math.min(lease.grantSeconds, current - lease.baselineCharge));
		const unused = Math.max(0, lease.grantSeconds - consumed);
		// Lost contact: the worker may have streamed until the lease expired and the
		// existing charge may not have caught up. Add only the unreconciled part once.
		const extra = lostContact ? unused : 0;
		const releasedSeconds = lease.grantSeconds;
		lease.grantSeconds = 0; lease.released = true;
		const chargedExtra = extra > 0 && !lease.unlimited && allowance(lease.accountKey) !== null ? extra : 0;
		if (chargedExtra > 0) chargeDifference(lease.accountKey, chargedExtra);
		const state = accountState(lease.accountKey);
		state.released += releasedSeconds;
		leases.delete(leaseId);
		onChange(snapshot(lease.accountKey));
		return { leaseId, released: true, reason, acknowledged, lostContact, grantSeconds: releasedSeconds, consumedSeconds: consumed, unusedSeconds: unused, extraChargeSeconds: chargedExtra };
	}
	function allocate(accountKey, leaseIds, { now = clock() } = {}) {
		const ids = [...new Set(leaseIds)].filter(id => leases.has(id) && !leases.get(id).released);
		if (!ids.length) return {};
		// A renewal settles the previous window first. This is a reservation
		// release, not a second charge; the account charge already exists.
		for (const id of ids) {
			const lease = leases.get(id);
			if (lease.grantSeconds > 0) {
				const result = settle(id, { acknowledged: true, reason: 'renewal' });
				const fresh = register(id, accountKey, { unlimited: lease.unlimited });
				fresh.generation = result.released ? fresh.generation : fresh.generation;
			}
		}
		const active = ids.map(id => leases.get(id)).filter(Boolean);
		const unlimited = active.some(lease => lease.unlimited);
		const available = unlimited ? null : finiteAvailable(accountKey);
		const grants = {};
		if (!active.length) return grants;
		const total = available === null ? active.length * maxGrantSeconds : Math.floor(available);
		if (total < minGrantSeconds) return grants;
		const share = Math.max(minGrantSeconds, Math.floor(total / active.length));
		let remaining = total;
		for (const lease of active) {
			const wanted = Math.min(maxGrantSeconds, share);
			const grant = Math.min(wanted, remaining);
			if (grant < minGrantSeconds) continue;
			lease.grantSeconds = grant;
			lease.grantAt = now;
			lease.baselineCharge = Number(chargedSeconds(accountKey) || 0);
			lease.generation += 1;
			lease.released = false;
			grants[lease.leaseId] = grant;
			remaining -= grant;
		}
		onChange(snapshot(accountKey));
		return grants;
	}
	function snapshot(accountKey) {
		const total = allowance(accountKey);
		return { accountKey, allowanceSeconds: total, chargedSeconds: Number(chargedSeconds(accountKey) || 0), outstandingGrantSeconds: outstanding(accountKey),
			availableSeconds: total === null ? null : finiteAvailable(accountKey), leases: [...leases.values()].filter(lease => lease.accountKey === accountKey).map(lease => ({ ...lease })) };
	}
	function check(accountKey) {
		const state = snapshot(accountKey);
		if (state.allowanceSeconds !== null && state.chargedSeconds + state.outstandingGrantSeconds > state.allowanceSeconds) throw fail('Relay budget invariant failed.', 'RELAY_BUDGET_INVARIANT');
		return state;
	}
	return { register, allocate, settle, expire, snapshot, check, outstanding, accounts };
}
