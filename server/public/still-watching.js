/* Still-watching monitor shared by every browser player surface.
 *
 * A viewer who leaves healthy playback running for two hours is asked whether
 * they are still watching. The question counts down for sixty seconds and then
 * stops playback. This module has no DOM dependency: the caller supplies a
 * monotonic clock and the current player state on every tick, then decides what
 * to render when the state changes.
 *
 * Contract
 * - Elapsed time is caller-supplied monotonic milliseconds. Never pass
 *   Date.now(): changing the wall clock must not move the accumulator.
 * - Only healthy visible playback accumulates: playing, not buffering, not
 *   seeking and visible. Paused, buffering, seeking, ended, hidden tabs,
 *   background tabs and invisible PiP are excluded through the caller's inputs.
 * - update() never resets by itself. Progress, heartbeat, timeupdate, autoplay
 *   and episode transitions are not user input. Call reset(now) only from a
 *   deliberate interaction (remote key, tap, click, wheel, play/pause button or
 *   seek control).
 * - A fresh prompt is announced once with result.show. Later ticks return
 *   changed=false and show=false, so the caller does not refocus the card or
 *   repeat an announcement every second. Read result.changed or changed().
 * - The prompt countdown advances only during visible, healthy playback while
 *   canPrompt is true. Use canPrompt=false to defer while a buffering warning,
 *   up-next card or another modal owns the screen. Use pausePrompt() and
 *   resumePrompt() when the caller hides or restores the prompt itself.
 * - transition(now) is for automatic episode changes. It preserves elapsed
 *   playing time and never counts the gap between episodes.
 * - stop() and the countdown timeout both end in the terminal STOP state.
 *   result.reason is "timeout" or "stop". result.resumeApplies tells the caller
 *   whether saving a resume point makes sense for this title.
 *
 * Integration (player document)
 * 1. Load this file before app.js: <script src="/still-watching.js"></script>
 * 2. Create one monitor per playback session:
 *      const still = TellyboxStillWatching.create({ resumeApplies: !live });
 *    For live channels, 24-7 streams and nonstop channels pass false. For
 *    films, episodes and catch-up pass true.
 * 3. On every tick (timeupdate, progress, playing/waiting/seeked, visibility
 *    change or a 500 ms interval) call:
 *      still.update(performance.now(), !video.paused && !video.ended,
 *        waiting, video.seeking, visible, canPrompt);
 *    visible must be false for a hidden tab; for PiP pass true only when the
 *    viewer can actually see the PiP window. waiting is true while the player
 *    is stalled or buffering.
 * 4. On a deliberate input call still.reset(performance.now()). Automatic
 *    callbacks must not call reset().
 * 5. On the episode-ended autoplay path call
 *    still.transition(performance.now()) when the next source starts.
 * 6. Render only on result.show. On result.changed to anything else hide the
 *    card. Show result.remainingSeconds. On result.stop close playback through
 *    the existing stop path; save the current position first when
 *    result.resumeApplies is true. This module never opens a stream.
 */
(function (root, factory) {
	const api = factory();
	if (typeof module === 'object' && module.exports) module.exports = api;
	else root.TellyboxStillWatching = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
	'use strict';

	const THRESHOLD_MS = 2 * 60 * 60 * 1000;
	const PROMPT_SECONDS = 60;
	const PROMPT_MS = PROMPT_SECONDS * 1000;
	const WATCHING = 'watching';
	const PROMPT = 'prompt';
	const STOP = 'stop';
	const STOP_TIMEOUT = 'timeout';
	const STOP_USER = 'stop';

	function positive(value, fallback) {
		const parsed = Number(value);
		return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
	}

	class Monitor {
		constructor(options) {
			const value = options || {};
			this.thresholdMs = positive(value.thresholdMs, THRESHOLD_MS);
			this.promptMs = positive(value.promptMs, PROMPT_MS);
			this.resumeApplies = value.resumeApplies === true;
			this.state = WATCHING;
			this.previous = WATCHING;
			this.elapsedMs = 0;
			this.promptElapsedMs = 0;
			this.lastAt = null;
			this.skipDelta = false;
			this.deferred = false;
			this.promptPaused = false;
			this.reason = '';
			this.changedValue = false;
			this.showValue = false;
			this.hideValue = false;
		}

		/** Establish the next clock baseline without counting the gap. */
		baseline(now) {
			if (typeof now === 'number' && Number.isFinite(now)) {
				this.lastAt = now;
				this.skipDelta = false;
				return;
			}
			this.skipDelta = true;
		}

		/** Monotonic delta, ignoring zero, backwards and first observations. */
		observe(now) {
			const at = typeof now === 'number' && Number.isFinite(now)
				? now
				: (this.lastAt === null ? 0 : this.lastAt);
			if (this.lastAt === null) {
				this.lastAt = at;
				return 0;
			}
			if (this.skipDelta) {
				this.skipDelta = false;
				this.lastAt = at;
				return 0;
			}
			const delta = at > this.lastAt ? at - this.lastAt : 0;
			if (at > this.lastAt) this.lastAt = at;
			return delta;
		}

		result() {
			const promptRemainingMs = this.state === PROMPT ? Math.max(0, this.promptMs - this.promptElapsedMs) : 0;
			const thresholdRemainingMs = this.state === WATCHING ? Math.max(0, this.thresholdMs - this.elapsedMs) : 0;
			return {
				state: this.state,
				previous: this.previous,
				changed: this.changedValue,
				show: this.showValue,
				hide: this.hideValue,
				stop: this.state === STOP,
				terminal: this.state === STOP,
				reason: this.reason,
				deferred: this.deferred,
				promptPaused: this.promptPaused,
				elapsedMs: this.elapsedMs,
				remainingMs: this.state === PROMPT ? promptRemainingMs : thresholdRemainingMs,
				promptRemainingMs,
				remainingSeconds: this.state === PROMPT ? Math.ceil(promptRemainingMs / 1000) : 0,
				resumeApplies: this.resumeApplies,
				saveResume: this.resumeApplies
			};
		}

		finish(was) {
			this.previous = was;
			this.changedValue = this.state !== was;
			this.showValue = this.changedValue && this.state === PROMPT;
			this.hideValue = was === PROMPT && this.state !== PROMPT;
			return this.result();
		}

		quiet(was) {
			this.previous = was;
			this.changedValue = false;
			this.showValue = false;
			this.hideValue = false;
			return this.result();
		}

		/**
		 * Advance the monitor. All flags are supplied by the caller.
		 * updates must not be used as a substitute for deliberate input.
		 */
		update(now, playing, buffering, seeking, visible, canPrompt) {
			const was = this.state;
			if (was === STOP) return this.quiet(was);
			const delta = this.observe(now);
			const shown = visible !== false;
			const healthy = Boolean(playing) && !buffering && !seeking && shown;
			const promptAllowed = canPrompt !== false;
			if (this.state === WATCHING) {
				if (healthy) this.elapsedMs = Math.min(this.thresholdMs, this.elapsedMs + delta);
				if (this.elapsedMs >= this.thresholdMs) {
					if (promptAllowed && shown) {
						this.state = PROMPT;
						this.promptElapsedMs = 0;
						this.deferred = false;
						this.promptPaused = false;
						this.reason = '';
					} else {
						this.deferred = true;
					}
				}
			} else if (this.state === PROMPT) {
				if (healthy && promptAllowed && !this.promptPaused) {
					this.promptElapsedMs = Math.min(this.promptMs, this.promptElapsedMs + delta);
					if (this.promptElapsedMs >= this.promptMs) {
						this.state = STOP;
						this.reason = STOP_TIMEOUT;
					}
				}
			}
			return this.finish(was);
		}

		/** Deliberate input or a new viewing session. Safe from any state. */
		reset(now) {
			const was = this.state;
			this.baseline(now);
			this.state = WATCHING;
			this.elapsedMs = 0;
			this.promptElapsedMs = 0;
			this.deferred = false;
			this.promptPaused = false;
			this.reason = '';
			return this.finish(was);
		}

		/** Viewer chose "Keep watching". Only valid while a prompt is open. */
		keepWatching(now) {
			const was = this.state;
			if (was === STOP) return this.quiet(was);
			this.baseline(now);
			this.state = WATCHING;
			this.elapsedMs = 0;
			this.promptElapsedMs = 0;
			this.deferred = false;
			this.promptPaused = false;
			this.reason = '';
			return this.finish(was);
		}

		/** Viewer chose "Stop", or the player is closing for another reason. */
		stop(now) {
			const was = this.state;
			if (was === STOP) return this.quiet(was);
			this.baseline(now);
			this.state = STOP;
			this.deferred = false;
			this.promptPaused = false;
			this.reason = STOP_USER;
			return this.finish(was);
		}

		/** Automatic episode change. Preserves elapsed time and prompt state. */
		transition(now) {
			if (this.state === STOP) return this.quiet(this.state);
			this.baseline(now);
			return this.finish(this.state);
		}

		/** Caller hides the prompt without answering it (for example a modal). */
		pausePrompt() {
			const was = this.state;
			if (was === STOP) return this.quiet(was);
			if (this.state === PROMPT) this.promptPaused = true;
			return this.finish(was);
		}

		resumePrompt() {
			const was = this.state;
			if (was === STOP) return this.quiet(was);
			if (this.state === PROMPT) this.promptPaused = false;
			return this.finish(was);
		}

		/** Whether this title can save a resume position when it stops. */
		setResumeApplies(value) {
			this.resumeApplies = value === true;
			return this;
		}

		/** True only on the tick that changed the state. */
		changed() {
			return this.changedValue;
		}

		/** Convenience for callers that only need the countdown number. */
		remainingSeconds() {
			if (this.state !== PROMPT) return 0;
			return Math.ceil(Math.max(0, this.promptMs - this.promptElapsedMs) / 1000);
		}
	}

	return {
		THRESHOLD_MS,
		PROMPT_SECONDS,
		PROMPT_MS,
		WATCHING,
		PROMPT,
		STOP,
		STOP_TIMEOUT,
		STOP_USER,
		STATE: { WATCHING, PROMPT, STOP },
		Monitor,
		create: options => new Monitor(options),
		resumeApplies: live => !live
	};
});
