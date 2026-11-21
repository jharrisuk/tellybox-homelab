/**
 * Clock-driven preload scheduler with playback-aware deferral.
 *
 * The task callback is the existing bounded warmer; this module only decides
 * when it may run. It never overlaps a run, defers while `isBusy()` reports live
 * playback, retries after a failure and stops cleanly. Timers are injectable so
 * tests can drive the clock without waiting; production passes the real timer
 * functions.
 */
export function createTrendingPreload({
	warm,
	isBusy = () => false,
	clock = Date.now,
	setTimer = setTimeout,
	clearTimer = clearTimeout,
	startDelayMs = 5000,
	intervalMs = 3600000,
	retryMs = 10 * 60000,
	busyMs = 10 * 60000
} = {}) {
	if (typeof warm !== 'function') throw new TypeError('A warm function is required.');
	let timer = null, running = false, stopped = false, last = null, runs = 0, deferred = 0;
	const positive = (value, fallback) => Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : fallback;
	// A throwing check is conservatively busy; the same callback is forwarded to
	// the warm task so it can also stop between rows/pairs mid-run.
	const busyCheck = () => { try { return Boolean(isBusy()); } catch { return true; } };

	const schedule = delay => {
		if (stopped || timer || running) return;
		timer = setTimer(async () => {
			timer = null;
			if (stopped) return;
			if (running) { schedule(1000); return; }
			if (busyCheck()) { deferred += 1; schedule(busyMs); return; }
			running = true;
			let failed = 0, deferredByWarm = false;
			try {
				const result = await warm({ isBusy: busyCheck });
				failed = Math.max(0, Number(result?.failed) || 0);
				deferredByWarm = Boolean(result?.deferred);
			} catch {
				failed = 1;
			} finally {
				running = false;
				runs += 1;
				if (deferredByWarm) deferred += 1;
				last = { at: clock(), failed, deferred: deferredByWarm };
			}
			// Playback starting after the pre-run check must not be recorded as a
			// completed hourly refresh: retry shortly once the screen goes idle.
			schedule(deferredByWarm ? busyMs : failed ? retryMs : intervalMs);
		}, Math.max(1, positive(delay, startDelayMs)));
		timer?.unref?.();
	};

	return {
		start(delay = startDelayMs) { schedule(delay); },
		stop() {
			stopped = true;
			if (timer) { clearTimer(timer); timer = null; }
		},
		status() { return { scheduled: Boolean(timer), running, stopped, runs, deferred, last }; }
	};
}
