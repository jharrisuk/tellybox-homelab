/** Bounded unexpected-exit restart policy for the media child. */
export const RESTART_DELAYS_MS = [2000, 5000, 15000, 30000, 60000];

export function restartDelay(attempt, delays = RESTART_DELAYS_MS) {
	if (!Number.isInteger(attempt) || attempt < 0 || !Array.isArray(delays) || !delays.length) return null;
	if (attempt >= delays.length) return null;
	return delays[attempt];
}
