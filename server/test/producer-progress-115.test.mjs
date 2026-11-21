import test from 'node:test';
import assert from 'node:assert/strict';
import { createProducerProgress, createDiagnosticsBuffer, sanitizeDiagnosticLine } from '../producer-progress.mjs';

test('slow but progressing playlist never trips the stall watchdog', () => {
	let now = 0;
	const stalls = [];
	const tracker = createProducerProgress({ timeoutMs: 100, now: () => now, onStall: reason => stalls.push(reason) });
	tracker.observe('#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:4\n');
	now = 80;
	assert.equal(tracker.tick(), '');
	tracker.observe('#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:5\n');
	now = 150;
	assert.equal(tracker.tick(), '');
	now = 210;
	assert.equal(tracker.tick(), 'stalled');
	now = 300;
	assert.equal(tracker.tick(), 'stalled');
	assert.deepEqual(stalls, ['stalled'], 'stall callback fires exactly once');
});

test('a growing sequence-zero playlist survives a full window and only freezes when segments stop', () => {
	// The clock is milliseconds, so the watchdog window must be too. A timeout
	// measured in milliseconds (the old 60) would pass the old test because it
	// only ticked at the same instant it observed progress.
	let now = 0;
	const stalls = [];
	const tracker = createProducerProgress({ timeoutMs: 60000, now: () => now, onStall: reason => stalls.push(reason) });
	function growing(second) {
		now = second * 1000;
		const newest = 1 + Math.floor(second / 2);
		const lines = ['#EXTM3U', '#EXT-X-MEDIA-SEQUENCE:0'];
		for (let index = Math.max(1, newest - 29); index <= newest; index++) lines.push('#EXTINF:2.000000,', 'segment' + String(index).padStart(9, '0') + '.ts');
		tracker.observe(lines.join('\n') + '\n');
	}
	for (let second = 0; second <= 90; second += 5) {
		growing(second);
		assert.equal(tracker.tick(), '', 'healthy growing list must not stall at ' + second + ' s');
	}
	// Ticks interleaved inside the window, before the next playlist refresh, are
	// healthy while segments keep arriving across the 90-second boundary.
	now = 90500;
	assert.equal(tracker.tick(), '', 'a tick between growing observations is not a stall');
	for (const second of [95, 120, 150, 180]) {
		growing(second);
		assert.equal(tracker.tick(), '', 'healthy growth at ' + second + ' s must not stall');
	}
	// The last segment arrived at 180 s. Exactly one window later is still
	// tolerated; one millisecond beyond it is a stall.
	now = 240000;
	assert.equal(tracker.tick(), '', 'exactly one full window after the last growth is tolerated');
	now = 240001;
	assert.equal(tracker.tick(), 'stalled', 'a frozen playlist must eventually stall');
	now = 300000;
	assert.equal(tracker.tick(), 'stalled', 'the stall callback fires only once');
	assert.deepEqual(stalls, ['stalled']);
	assert.equal(tracker.sequence, 0);
	assert.ok(tracker.lastSegment > 1);
});

test('unchanged playlist and dead ffmpeg are both detected', () => {
	let now = 0;
	const stalls = [];
	const tracker = createProducerProgress({ timeoutMs: 100, now: () => now, onStall: reason => stalls.push(reason) });
	tracker.observe('#EXT-X-MEDIA-SEQUENCE:9\n');
	now = 50;
	tracker.observe('#EXT-X-MEDIA-SEQUENCE:9\n');
	now = 101;
	assert.equal(tracker.tick(), 'stalled');
	assert.equal(tracker.reason, 'stalled');
	const exited = createProducerProgress({ timeoutMs: 100, now: () => now });
	exited.observe('#EXT-X-MEDIA-SEQUENCE:1\n');
	assert.equal(exited.exit(1), 'exited');
	assert.equal(exited.exitCode, 1);
	assert.equal(exited.tick(), 'exited');
});

test('stopped tracker ignores late progress and does not fire a stall', () => {
	let now = 0;
	const stalls = [];
	const tracker = createProducerProgress({ timeoutMs: 10, now: () => now, onStall: reason => stalls.push(reason) });
	tracker.stop();
	now = 100;
	assert.equal(tracker.tick(), '');
	tracker.observe('#EXT-X-MEDIA-SEQUENCE:2\n');
	assert.deepEqual(stalls, []);
});

test('diagnostics are sanitized, bounded and URL/token free', () => {
	assert.equal(sanitizeDiagnosticLine('error https://private.example/stream?token=secret'), 'error [url]');
	assert.equal(sanitizeDiagnosticLine('key=abc&signature=def'), 'key=[redacted]&signature=[redacted]');
	const buffer = createDiagnosticsBuffer({ limit: 120 });
	for (let i = 0; i < 100; i++) buffer.push('error token=secret https://private.example/' + i);
	const text = buffer.text();
	assert.ok(text.length <= 120);
	assert.equal(text.includes('private.example'), false);
	assert.equal(text.includes('secret'), false);
	buffer.clear();
	assert.equal(buffer.text(), '');
});
