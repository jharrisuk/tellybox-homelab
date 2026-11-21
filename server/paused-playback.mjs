export const PAUSED_TIMEOUT = 'PAUSED_TIMEOUT';

export function terminalStopFor(stops, id, owner) {
	const stop = stops.get(id);
	if (!stop || typeof owner !== 'string' || stop.owner !== owner) return null;
	return stop;
}

export function isPausableSession(session) {
	if (!session) return false;
	if (session.download === true) return false;
	if (session.nonstop === true || session.live === true) return false;
	if (session.relayMode === 'live' || session.relayMode === 'nonstop') return false;
	if (String(session.itemId || '').startsWith('dispatch-live-')) return false;
	return true;
}

// Tracks continuous user pause time. Buffering and seeking are not user pause,
// so they clear the timer; the next paused heartbeat starts a fresh interval.
// The clock is monotonic by default and injectable for deterministic tests.
export function createPausedPlayback({ clock = () => performance.now(), minutes = () => 10 } = {}) {
	function clear(session) {
		if (!session) return;
		session.paused = false;
		session.pausedSince = null;
	}
	function observe(session, value = {}) {
		if (!isPausableSession(session)) { clear(session); return false; }
		const userPaused = value.paused === true && value.buffering !== true && value.seeking !== true;
		if (!userPaused) { clear(session); return false; }
		if (!session.paused || session.pausedSince == null) {
			session.paused = true;
			session.pausedSince = clock();
		}
		return true;
	}
	function expired(sessions) {
		const limit = Number(minutes());
		if (!Number.isFinite(limit) || limit <= 0) return [];
		const now = clock();
		const result = [];
		for (const session of sessions.values()) {
			if (!isPausableSession(session) || !session.paused || session.pausedSince == null) continue;
			if (now - session.pausedSince >= limit * 60000) result.push(session);
		}
		return result;
	}
	function state(session) {
		return { paused: Boolean(session?.paused), pausedSince: session?.pausedSince ?? null };
	}
	return { observe, clear, expired, state };
}
