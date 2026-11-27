import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const context = {};
vm.runInNewContext(readFileSync(new URL('../public/playback-warning.js', import.meta.url), 'utf8'), context);
const Monitor = context.TellyboxBufferingWarning.Monitor;

function update(monitor, now, buffering, extra = {}) {
	return monitor.update({ now, streamKey: 'stream-a', buffering, paused: false, seeking: false, ended: false, ...extra });
}
function bufferingFor(monitor, from, seconds, extra = {}) {
	let result = null;
	for (let second = from; second < from + seconds; second++) result = update(monitor, second * 1000, true, extra);
	return result;
}

test('continuous buffering begins after startup grace and warns at 60 seconds', () => {
	const monitor = new Monitor({ cumulativeMs: 999999 });
	monitor.reset(0, 'stream-a');
	assert.equal(update(monitor, 5000, true).show, false, 'startup grace suppresses early warning');
	assert.equal(bufferingFor(monitor, 16, 59).show, false, '59 seconds after grace is below the threshold');
	assert.equal(update(monitor, 75 * 1000, true).show, false);
	const show = update(monitor, 76 * 1000, true);
	assert.equal(show.show, true);
	assert.equal(show.reason, 'continuous');
});

test('25 seconds cumulative inside a rolling 60-second window warns even with recovery gaps', () => {
	const monitor = new Monitor({ continuousMs: 999999 });
	monitor.reset(0, 'stream-a');
	bufferingFor(monitor, 16, 9);       // 9s
	assert.equal(update(monitor, 26 * 1000, false).show, false);
	bufferingFor(monitor, 31, 9);       // 18s total
	assert.equal(update(monitor, 41 * 1000, false).show, false);
	bufferingFor(monitor, 46, 6);       // 21s total
	assert.equal(update(monitor, 52 * 1000, true).show, false);
	assert.equal(update(monitor, 53 * 1000, true).show, false);
	const show = update(monitor, 55 * 1000, true);
	assert.equal(show.show, true);
	assert.equal(show.reason, 'cumulative');
});

test('pause and seek do not count as genuine buffering', () => {
	const monitor = new Monitor({ continuousMs: 999999, cumulativeMs: 25000 });
	monitor.reset(0, 'stream-a');
	bufferingFor(monitor, 16, 20);
	const paused = update(monitor, 36 * 1000, true, { paused: true });
	assert.equal(paused.show, false);
	const seeking = update(monitor, 37 * 1000, true, { seeking: true });
	assert.equal(seeking.show, false);
	assert.equal(update(monitor, 38 * 1000, true, { paused: false }).show, false);
});

test('stream change and end reset the window', () => {
	const monitor = new Monitor({ continuousMs: 999999, cumulativeMs: 25000 });
	monitor.reset(0, 'stream-a');
	bufferingFor(monitor, 16, 50);
	// 50 seconds of continuous buffering is already above the cumulative
	// threshold; use a fresh monitor with cumulative disabled for this reset check.
	const continuous = new Monitor({ continuousMs: 60000, cumulativeMs: 999999 });
	continuous.reset(0, 'stream-a');
	bufferingFor(continuous, 16, 50);
	assert.equal(update(continuous, 66 * 1000, true).show, false);
	continuous.reset(66 * 1000, 'stream-b');
	assert.equal(bufferingFor(continuous, 67, 10).show, false, 'new stream restarts grace/accumulation');
	assert.equal(update(continuous, 100 * 1000, true, { ended: true }).hide, true);
});

test('dismiss suppresses repeats and recovery clears the warning state', () => {
	const monitor = new Monitor({ continuousMs: 60000, cumulativeMs: 999999 });
	monitor.reset(0, 'stream-a');
	bufferingFor(monitor, 16, 60);
	assert.equal(update(monitor, 76 * 1000, true).show, true);
	monitor.dismiss(76 * 1000);
	for (let second = 77; second < 150; second++) assert.equal(update(monitor, second * 1000, true).show, false);

	const recovery = new Monitor({ continuousMs: 60000, cumulativeMs: 999999 });
	recovery.reset(0, 'stream-a');
	bufferingFor(recovery, 16, 60);
	assert.equal(update(recovery, 76 * 1000, true).show, true);
	for (let second = 77; second < 87; second++) assert.equal(update(recovery, second * 1000, false).show, false);
	assert.equal(update(recovery, 87 * 1000, false).hide, true, 'warning clears after a recovery period');
	bufferingFor(recovery, 88, 60);
	assert.equal(update(recovery, 148 * 1000, true).show, true, 'a later run can warn again');
});

test('initial loading is not buffering until the first frame is presented', () => {
	const monitor = new Monitor({ continuousMs: 60000, cumulativeMs: 25000 });
	monitor.reset(0, 'stream-a');
	for (let second = 1; second <= 80; second++) {
		assert.equal(update(monitor, second * 1000, true, { started: false }).show, false, 'startup at ' + second + 's');
	}
	// The first frame arrives. Only time after that point may accumulate.
	for (let second = 81; second < 106; second++) {
		assert.equal(update(monitor, second * 1000, true, { started: true }).show, false, 'first 25s after start at ' + second + 's');
	}
	const show = update(monitor, 106 * 1000, true, { started: true });
	assert.equal(show.show, true);
	assert.equal(show.reason, 'cumulative');
});test('healthy playback never opens the warning after short buffering', () => {
	const monitor = new Monitor({ continuousMs: 999999, cumulativeMs: 25000 });
	monitor.reset(0, 'stream-a');
	bufferingFor(monitor, 16, 10);
	for (let second = 26; second < 60; second++) {
		assert.equal(update(monitor, second * 1000, false).show, false, 'healthy playback at ' + second + 's');
	}
});

test('web catch-up retry keeps the absolute programme position in milliseconds', () => {
	const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
	assert.match(app, /position: Math\.max\(0, Math\.round\(\(Number\(position\) \|\| 0\) \* 1000\)\)/);
	assert.match(app, /video\.currentTime/);
});

test('web warning excludes picture-in-picture and resets on media error', () => {
	const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
	assert.match(app, /document\.pictureInPictureElement === video/);
	assert.match(app, /buffering: !pip &&/);
	assert.match(app, /addEventListener\('error',[^\n]*playbackWarning\.reset/);
});

test('lower quality always chooses a strictly lower supported rung', () => {
	const next = context.TellyboxBufferingWarning.nextLowerQuality;
	assert.equal(next(80000000), 20000000);
	assert.equal(next(20000000), 8000000);
	assert.equal(next(8000000), 4000000);
	assert.equal(next(4000000), 2000000);
	assert.equal(next(2000000), 0);
	// Auto (0) resolves against the negotiated ceiling. Without one it falls
	// back to 8 Mbps, never to the 80 Mbps top rung.
	assert.equal(next(0), 4000000);
	assert.equal(next(0, null, 8000000), 4000000);
	assert.equal(next(0, null, 20000000), 8000000);
	assert.equal(next(0, null, 2000000), 0);
});

test('web player loads the warning module and keeps focusable actions', () => {
	const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
	const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
	assert.match(html, /playback-warning\.js/);
	assert.match(html, /id="playbackTrouble"[^>]*role="alert"/);
	for (const id of ['troubleRetry', 'troubleLower', 'troubleDismiss', 'troubleBack']) assert.match(html, new RegExp('id="' + id + '"'));
	assert.match(app, /updatePlaybackTrouble/);
	assert.match(app, /setInterval\(updatePlaybackTrouble/);
});
