// Bounded retry for terminal session cleanup. A failed stop is retried with
// exponential backoff; after the last attempt the caller releases local slots
// and deletes the session so a cleanup failure cannot hold a screen forever.
export function createPausedEnforcer({ clock = Date.now, stop, onGiveUp = () => {}, maxAttempts = 6, baseDelayMs = 1000, maxDelayMs = 30000 } = {}) {
	const retries = new Map();
	async function attempt(session, attempts) {
		if (!session || session.stopping) return;
		try {
			await stop(session);
			retries.delete(session.id);
		} catch (error) {
			const next = attempts + 1;
			if (next >= maxAttempts) {
				retries.delete(session.id);
				try { await onGiveUp(session, error); } catch {}
				return;
			}
			retries.set(session.id, {
				session,
				attempts: next,
				nextAt: clock() + Math.min(maxDelayMs, baseDelayMs * (2 ** attempts))
			});
		}
	}
	function enforce(session) {
		if (!session?.id || session.stopping || session.terminalStopping) return;
		session.terminalStopping = true;
		void attempt(session, 0);
	}
	function tick() {
		const now = clock();
		for (const [id, entry] of retries) {
			if (now < entry.nextAt) continue;
			retries.delete(id);
			void attempt(entry.session, entry.attempts);
		}
	}
	return { enforce, tick, retries };
}
