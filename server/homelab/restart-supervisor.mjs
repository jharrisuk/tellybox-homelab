import { restartDelay, RESTART_DELAYS_MS } from './restart-policy.mjs';

/**
 * Bounded supervisor for unexpected media-process exits.
 *
 * - A pending restart owns the single timer, so exits cannot duplicate children.
 * - Deliberate apply/shutdown paths cancel or dispose before stopping the child.
 * - After the delay list is exhausted automatic recovery pauses; setup remains.
 * - A child that stays up for `settleMs` resets the attempt budget.
 */
export function createRestartSupervisor({
	restart, status = () => ({}), delays = RESTART_DELAYS_MS, settleMs = 60000,
	timers = { setTimeout, clearTimeout }, log = console
} = {}) {
	if (typeof restart !== 'function') throw Error('Restart supervisor needs a restart function.');
	let attempts = 0, timer = null, restarting = false, disposed = false, settleTimer = null, wanted = false;
	function clearSettle() {
		if (settleTimer) { timers.clearTimeout(settleTimer); settleTimer = null; }
	}
	function cancel() {
		// A deliberate stop ends continuous health, so the current child can no
		// longer earn a stability reset.
		clearSettle();
		if (timer) { timers.clearTimeout(timer); timer = null; }
	}
	function dispose() {
		disposed = true;
		wanted = false;
		cancel();
	}
	/** A deliberate start resets the budget unless this start is itself a recovery. */
	function startup() {
		cancel();
		wanted = false;
		if (!restarting) attempts = 0;
	}
	function schedule() {
		// Any new unexpected-exit path invalidates the previous child's stability
		// timer. Only a child that stays up continuously for settleMs may reset
		// the attempt budget; an old timer must not fire across a later failure.
		clearSettle();
		if (disposed || timer || status().applying) return false;
		if (restarting) { wanted = true; return false; }
		const delay = restartDelay(attempts, delays);
		if (delay === null) {
			log.error('Media process stopped repeatedly; automatic recovery is paused. Use installation settings to apply and inspect the cause.');
			return false;
		}
		const attempt = ++attempts;
		log.error('Media process stopped unexpectedly. Restart attempt ' + attempt + ' in ' + Math.round(delay / 1000) + ' seconds.');
		timer = timers.setTimeout(async () => {
			timer = null;
			if (disposed) return;
			restarting = true;
			let failed = false;
			try {
				await restart();
				// Ready can resolve and the child can still exit before the
				// restart call returns. Treat that as a failed recovery.
				if (status().running === false) throw Error('Media process exited after restart.');
				log.log('Media process restarted after an unexpected exit.');
				clearSettle();
				settleTimer = timers.setTimeout(() => { attempts = 0; settleTimer = null; }, settleMs);
				settleTimer.unref?.();
			} catch (error) {
				failed = true;
				log.error('Media process restart failed: ' + (error?.message || 'unknown error'));
			} finally {
				restarting = false;
				if (failed || wanted) {
					wanted = false;
					if (!disposed) schedule();
				}
			}
		}, delay);
		timer.unref?.();
		return true;
	}
	return { schedule, cancel, dispose, startup,
		state: () => ({ attempts, pending: Boolean(timer), restarting, disposed, wanted, settlePending: Boolean(settleTimer) }) };
}
