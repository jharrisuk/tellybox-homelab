/**
 * Idempotent teardown for a local direct (Dispatcharr live) playback session.
 *
 * A direct session can end from three places: the client stops it, ffmpeg
 * exits, or the producer watchdog expires. All three arrive through
 * directPlayer.start's onStopped callback, and the HTTP stop path also asks
 * for teardown directly. Every release below therefore runs at most once per
 * session object, and a missing map or counter is simply skipped.
 */
export function createDirectSessionCleanup({ sessions, sessionLimits, accountLimits, activity, pausedPlayback } = {}) {
	const finalized = new WeakSet();
	const ended = new WeakSet();
	const guard = run => { try { return run(); } catch { return undefined; } };

	/**
	 * Mark the activity record ended once, keeping the last known position.
	 * Safe to call before finalize; finalize will not mark it a second time.
	 */
	function markEnded(session, values = {}) {
		if (!session || typeof session !== 'object' || ended.has(session)) return false;
		ended.add(session);
		const id = session.id;
		if (id === undefined || id === null) return false;
		const raw = Number.isFinite(values.position) ? values.position : Number(session.position);
		const position = Number.isFinite(raw) ? Math.max(0, raw) : 0;
		guard(() => activity?.update?.(id, { ...values, state: 'ended', position }));
		return true;
	}

	/**
	 * Release the screen slot, end account activity, end the activity record,
	 * and remove the session. Returns true only for the call that performed the
	 * teardown; later calls (including after an ffmpeg/watchdog stop) are no-ops.
	 */
	function finalize(session, values = {}) {
		if (!session || typeof session !== 'object' || finalized.has(session)) return false;
		finalized.add(session);
		guard(() => pausedPlayback?.clear?.(session));
		const id = session.id;
		if (id === undefined || id === null) return true;
		// Free the screen before the activity/write work so a stop never holds a
		// reservation while the activity store saves.
		guard(() => sessionLimits?.release?.(id));
		markEnded(session, values);
		guard(() => accountLimits?.end?.(id));
		guard(() => sessions?.delete?.(id));
		return true;
	}

	return {
		finalize,
		markEnded,
		finalized: session => Boolean(session && typeof session === 'object' && finalized.has(session))
	};
}
