import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../public/still-watching.js', import.meta.url), 'utf8');

function load() {
	const context = vm.createContext({});
	vm.runInContext(source, context);
	return context.TellyboxStillWatching;
}

const SW = load();
const HOUR = 60 * 60 * 1000;

function update(monitor, now, value = {}) {
	return monitor.update(
		now,
		value.playing !== false,
		Boolean(value.buffering),
		Boolean(value.seeking),
		value.visible !== false,
		value.canPrompt !== false
	);
}

function prompted(options) {
	const monitor = SW.create(options);
	update(monitor, 0);
	const result = update(monitor, monitor.thresholdMs);
	assert.equal(result.state, SW.PROMPT);
	assert.equal(result.show, true);
	return monitor;
}

test('module loads without a DOM and exposes the two-hour and sixty-second contract', () => {
	assert.equal(SW.THRESHOLD_MS, 7200000);
	assert.equal(SW.PROMPT_SECONDS, 60);
	assert.equal(SW.PROMPT_MS, 60000);
	assert.equal(SW.STATE.WATCHING, 'watching');
	assert.equal(SW.STATE.PROMPT, 'prompt');
	assert.equal(SW.STATE.STOP, 'stop');
	assert.equal(typeof SW.create, 'function');
	const monitor = SW.create();
	assert.equal(monitor.state, SW.WATCHING);
	assert.equal(monitor.elapsedMs, 0);
	assert.equal(monitor.changed(), false);
});

test('exact two hours of healthy playing enters the prompt once', () => {
	const monitor = SW.create();
	update(monitor, 0);
	const before = update(monitor, SW.THRESHOLD_MS - 1);
	assert.equal(before.state, SW.WATCHING);
	assert.equal(before.remainingMs, 1);
	assert.equal(before.show, false);
	const threshold = update(monitor, SW.THRESHOLD_MS);
	assert.equal(threshold.state, SW.PROMPT);
	assert.equal(threshold.changed, true);
	assert.equal(threshold.show, true);
	assert.equal(threshold.previous, SW.WATCHING);
	assert.equal(threshold.elapsedMs, SW.THRESHOLD_MS);
	assert.equal(threshold.promptRemainingMs, SW.PROMPT_MS);
	assert.equal(threshold.remainingSeconds, 60);
	const next = update(monitor, SW.THRESHOLD_MS + 500);
	assert.equal(next.state, SW.PROMPT);
	assert.equal(next.changed, false);
	assert.equal(next.show, false);
	assert.equal(next.promptRemainingMs, 59500);
});

test('deliberate input reset clears the accumulator and ignores the gap before the click', () => {
	const monitor = SW.create();
	update(monitor, 0);
	update(monitor, HOUR);
	assert.equal(monitor.elapsedMs, HOUR);
	const reset = monitor.reset(HOUR + 5000);
	assert.equal(reset.state, SW.WATCHING);
	assert.equal(reset.elapsedMs, 0);
	assert.equal(reset.changed, false);
	const resumed = update(monitor, HOUR + 6000);
	assert.equal(resumed.elapsedMs, 1000);
});

test('paused, buffering and seeking time never accumulates', () => {
	const monitor = SW.create();
	update(monitor, 0);
	update(monitor, HOUR);
	update(monitor, HOUR + 1800000, { playing: false });
	update(monitor, HOUR + 3600000, { buffering: true });
	update(monitor, HOUR + 5400000, { seeking: true });
	assert.equal(monitor.elapsedMs, HOUR);
	assert.equal(monitor.state, SW.WATCHING);
	assert.equal(update(monitor, HOUR + 5400000 + HOUR).state, SW.PROMPT);
});

test('hidden tabs and invisible PiP neither accumulate nor tick the countdown', () => {
	const monitor = SW.create();
	update(monitor, 0);
	update(monitor, HOUR);
	update(monitor, HOUR + 4 * HOUR, { visible: false });
	assert.equal(monitor.elapsedMs, HOUR);
	assert.equal(update(monitor, HOUR + 4 * HOUR + 1).state, SW.WATCHING);
	assert.equal(update(monitor, 2 * HOUR + 4 * HOUR + 1).state, SW.PROMPT);

	const hiddenPrompt = prompted();
	update(hiddenPrompt, SW.THRESHOLD_MS + 1000);
	assert.equal(hiddenPrompt.promptElapsedMs, 1000);
	update(hiddenPrompt, SW.THRESHOLD_MS + 61000, { visible: false });
	assert.equal(hiddenPrompt.promptElapsedMs, 1000);
	update(hiddenPrompt, SW.THRESHOLD_MS + 62000);
	assert.equal(hiddenPrompt.promptElapsedMs, 2000);
	assert.equal(hiddenPrompt.remainingSeconds(), 58);
});

test('prompt countdown pauses while playback is paused, buffering or seeking', () => {
	const monitor = prompted();
	update(monitor, SW.THRESHOLD_MS + 1000);
	update(monitor, SW.THRESHOLD_MS + 31000, { playing: false });
	update(monitor, SW.THRESHOLD_MS + 61000, { buffering: true });
	update(monitor, SW.THRESHOLD_MS + 91000, { seeking: true });
	assert.equal(monitor.promptElapsedMs, 1000);
	assert.equal(monitor.state, SW.PROMPT);
});

test('automatic episode transitions preserve accumulated playing time', () => {
	const monitor = SW.create();
	update(monitor, 0);
	update(monitor, HOUR);
	const transition = monitor.transition(HOUR);
	assert.equal(transition.changed, false);
	assert.equal(monitor.elapsedMs, HOUR);
	update(monitor, 2 * HOUR);
	assert.equal(monitor.state, SW.PROMPT);
	assert.equal(monitor.elapsedMs, SW.THRESHOLD_MS);
});

test('a transition without a clock sample does not count the gap between episodes', () => {
	const monitor = SW.create();
	update(monitor, 0);
	update(monitor, HOUR);
	monitor.transition();
	update(monitor, 9 * HOUR);
	assert.equal(monitor.elapsedMs, HOUR);
	update(monitor, 10 * HOUR);
	assert.equal(monitor.state, SW.PROMPT);
	assert.equal(monitor.elapsedMs, SW.THRESHOLD_MS);
});

test('a prompt is announced once and heartbeat ticks never repeat it', () => {
	const monitor = prompted();
	let shows = 0;
	for (let second = 1; second <= 10; second++) {
		const result = update(monitor, SW.THRESHOLD_MS + second * 1000);
		if (result.show) shows++;
		assert.equal(result.changed, false);
		assert.equal(result.state, SW.PROMPT);
	}
	assert.equal(shows, 0);
	assert.equal(monitor.promptElapsedMs, 10000);
	assert.equal(monitor.changed(), false);
});

test('the countdown stops playback after exactly sixty seconds', () => {
	const monitor = prompted({ resumeApplies: true });
	const before = update(monitor, SW.THRESHOLD_MS + 59999);
	assert.equal(before.state, SW.PROMPT);
	assert.equal(before.remainingSeconds, 1);
	const ended = update(monitor, SW.THRESHOLD_MS + 60000);
	assert.equal(ended.state, SW.STOP);
	assert.equal(ended.stop, true);
	assert.equal(ended.terminal, true);
	assert.equal(ended.hide, true);
	assert.equal(ended.reason, SW.STOP_TIMEOUT);
	assert.equal(ended.resumeApplies, true);
	const after = update(monitor, SW.THRESHOLD_MS + 120000);
	assert.equal(after.state, SW.STOP);
	assert.equal(after.changed, false);
});

test('a deferred prompt waits at the threshold and starts one full countdown', () => {
	const monitor = SW.create();
	update(monitor, 0);
	const held = update(monitor, SW.THRESHOLD_MS, { canPrompt: false });
	assert.equal(held.state, SW.WATCHING);
	assert.equal(held.deferred, true);
	assert.equal(held.elapsedMs, SW.THRESHOLD_MS);
	assert.equal(held.promptRemainingMs, 0);
	update(monitor, SW.THRESHOLD_MS + 5 * 60000, { canPrompt: false });
	assert.equal(monitor.state, SW.WATCHING);
	assert.equal(monitor.elapsedMs, SW.THRESHOLD_MS);
	const shownAt = SW.THRESHOLD_MS + 5 * 60000 + 500;
	const shown = update(monitor, shownAt);
	assert.equal(shown.state, SW.PROMPT);
	assert.equal(shown.show, true);
	assert.equal(shown.deferred, false);
	assert.equal(shown.promptRemainingMs, SW.PROMPT_MS);
	const nearly = update(monitor, shownAt + 59999);
	assert.equal(nearly.state, SW.PROMPT);
	assert.equal(nearly.promptRemainingMs, 1);
	update(monitor, shownAt + 60000, { canPrompt: false });
	assert.equal(monitor.state, SW.PROMPT);
	assert.equal(SW.PROMPT_MS - monitor.promptElapsedMs, 1);
	update(monitor, shownAt + 60001);
	assert.equal(monitor.state, SW.STOP);
});

test('pausePrompt and resumePrompt hold and restore the countdown', () => {
	const monitor = prompted();
	update(monitor, SW.THRESHOLD_MS + 10000);
	monitor.pausePrompt();
	update(monitor, SW.THRESHOLD_MS + 310000);
	assert.equal(monitor.state, SW.PROMPT);
	assert.equal(monitor.promptElapsedMs, 10000);
	monitor.resumePrompt();
	update(monitor, SW.THRESHOLD_MS + 359000);
	assert.equal(monitor.state, SW.PROMPT);
	assert.equal(monitor.promptElapsedMs, 59000);
	update(monitor, SW.THRESHOLD_MS + 360000);
	assert.equal(monitor.state, SW.STOP);
	assert.equal(monitor.reason, SW.STOP_TIMEOUT);
});

test('keep watching clears the accumulator and the prompt', () => {
	const monitor = prompted();
	const result = monitor.keepWatching(SW.THRESHOLD_MS + 1000);
	assert.equal(result.state, SW.WATCHING);
	assert.equal(result.hide, true);
	assert.equal(result.elapsedMs, 0);
	update(monitor, SW.THRESHOLD_MS + 1000 + HOUR);
	assert.equal(monitor.elapsedMs, HOUR);
	assert.equal(monitor.state, SW.WATCHING);
});

test('stop reports resume applicability for on-demand and live titles', () => {
	const onDemand = prompted({ resumeApplies: true });
	const stopped = onDemand.stop(SW.THRESHOLD_MS + 1000);
	assert.equal(stopped.state, SW.STOP);
	assert.equal(stopped.reason, SW.STOP_USER);
	assert.equal(stopped.resumeApplies, true);
	assert.equal(stopped.saveResume, true);

	const live = prompted({ resumeApplies: false });
	const timedOut = update(live, SW.THRESHOLD_MS + 60000);
	assert.equal(timedOut.reason, SW.STOP_TIMEOUT);
	assert.equal(timedOut.resumeApplies, false);

	const early = SW.create();
	update(early, 0);
	const earlyStop = early.stop(1000);
	assert.equal(earlyStop.state, SW.STOP);
	assert.equal(earlyStop.reason, SW.STOP_USER);
	assert.equal(SW.resumeApplies(true), false);
	assert.equal(SW.resumeApplies(false), true);
});

test('reset after a terminal stop clears prompt and countdown state', () => {
	const monitor = prompted({ resumeApplies: true });
	monitor.pausePrompt();
	const stopped = monitor.stop(SW.THRESHOLD_MS + 1000);
	assert.equal(stopped.state, SW.STOP);
	assert.equal(stopped.resumeApplies, true);
	const resetAt = SW.THRESHOLD_MS + 61000;
	const reset = monitor.reset(resetAt);
	assert.equal(reset.state, SW.WATCHING);
	assert.equal(reset.elapsedMs, 0);
	assert.equal(reset.promptRemainingMs, 0);
	assert.equal(reset.promptPaused, false);
	assert.equal(reset.deferred, false);
	assert.equal(reset.resumeApplies, true);
	update(monitor, resetAt + SW.THRESHOLD_MS);
	assert.equal(monitor.state, SW.PROMPT);
	assert.equal(monitor.changed(), true);
});

test('the object-style resumeApplies assignment used by app.js is honoured', () => {
	const monitor = SW.create({ resumeApplies: true });
	monitor.resumeApplies = false;
	update(monitor, 0);
	const result = update(monitor, SW.THRESHOLD_MS);
	assert.equal(result.state, SW.PROMPT);
	assert.equal(result.resumeApplies, false);
	assert.equal(result.saveResume, false);
});

test('a backwards clock sample never adds time or breaks the threshold', () => {
	const monitor = SW.create();
	update(monitor, 10000);
	update(monitor, 5000);
	assert.equal(monitor.elapsedMs, 0);
	update(monitor, 10000 + HOUR);
	assert.equal(monitor.elapsedMs, HOUR);
	update(monitor, 10000 + 2 * HOUR);
	assert.equal(monitor.state, SW.PROMPT);
});
