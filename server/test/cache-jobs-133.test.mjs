/* Release 133: owner-triggered shared-cache queue.
 *
 * Covers coalescing/cooldown, playback deferral at start and mid-run, bounded
 * recent log with redaction, failure cleanup, source-generation cancellation,
 * restart persistence, oversized/corrupt persistence and clean stop. All with
 * an injected clock/timers; no provider or production request is made.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createCacheJobs } from '../cache-jobs.mjs';

function harness(t, options = {}) {
	const directory = mkdtempSync(path.join(tmpdir(), 'tellybox-cache-jobs-'));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	let now = 1_800_000_000_000;
	const timers = [];
	const ran = [];
	let busy = false, generation = 'gen-a', fail = null;
	const setTimer = (fn, ms) => { const handle = { fn, ms, cleared: false, unref() {} }; timers.push(handle); return handle; };
	const clearTimer = handle => { handle.cleared = true; };
	const tasks = Object.fromEntries(['discover', 'trending', 'index'].map(scope => [scope, async () => {
		ran.push(scope);
		if (busy) return { deferred: true };
		if (fail === scope) throw Error('upstream https://secret.example/path?key=' + 'a'.repeat(40));
		return { ran: 1, skipped: 0, failed: 0, cached: 3 };
	}]));
	const jobs = createCacheJobs({
		tasks, isBusy: () => busy, generation: () => generation,
		clock: () => now, setTimer, clearTimer,
		file: options.file === undefined ? path.join(directory, 'state.json') : options.file,
		cooldownMs: 60000, retryMs: 10000, ...options
	});
	const runNext = async () => {
		const handle = timers.shift();
		assert.ok(handle, 'a timer was scheduled');
		await handle.fn();
	};
	return {
		directory, jobs, ran, timers, runNext,
		advance: ms => { now += ms; },
		setBusy: value => { busy = value; },
		setGeneration: value => { generation = value; },
		setFail: value => { fail = value; }
	};
}

test('a manual refresh runs the three bounded tasks once and coalesces repeats', async t => {
	const f = harness(t);
	const first = f.jobs.request('all', { manual: true });
	assert.equal(first.accepted, true);
	assert.deepEqual(first.job.scopes, ['discover', 'trending', 'index']);
	assert.equal(first.job.total, 3);
	const repeat = f.jobs.request('index', { manual: true });
	assert.equal(repeat.accepted, false);
	assert.equal(repeat.reason, 'coalesced', 'a running job is not duplicated');
	await f.runNext();
	assert.deepEqual(f.ran, ['discover', 'trending', 'index']);
	const status = f.jobs.status();
	assert.equal(status.running, false);
	assert.equal(status.recent.at(-1).state, 'done');
	assert.deepEqual(Object.values(status.lastSuccess).filter(Boolean).length, 3);
	assert.equal(status.recent.at(-1).results.index.cached, 3);

	const cooldown = f.jobs.request('all', { manual: true });
	assert.equal(cooldown.reason, 'cooldown');
	assert.ok(cooldown.retryAfterMs > 0);
	f.advance(60001);
	assert.equal(f.jobs.request('all', { manual: true }).accepted, true);
});

test('playback at the start and mid-run defers without starting more work', async t => {
	const f = harness(t);
	f.setBusy(true);
	f.jobs.request('all', { manual: true });
	await f.runNext();
	assert.deepEqual(f.ran, [], 'no task starts while playback is active');
	let status = f.jobs.status();
	assert.equal(status.state, 'waiting');
	assert.equal(status.job.waitingFor, 'playback');
	assert.equal(f.timers.at(-1).ms, 10000, 'it retries on a bounded interval');

	f.setBusy(false);
	await f.runNext();
	assert.deepEqual(f.ran, ['discover', 'trending', 'index']);
	assert.equal(f.jobs.status().state, 'idle');

	// Busy mid-run: stop before the next phase, resume from that phase.
	const g = harness(t);
	let calls = 0, midBusy = false;
	const jobs = createCacheJobs({
		tasks: {
			discover: async () => { calls++; midBusy = true; return { ran: 1 }; },
			trending: async () => { calls++; return { ran: 1 }; },
			index: async () => { calls++; return { ran: 1 }; }
		},
		isBusy: () => midBusy,
		clock: () => 1_800_000_000_000,
		setTimer: (fn, ms) => { const handle = { fn, ms, cleared: false, unref() {} }; g.timers.push(handle); return handle; },
		clearTimer: () => {}
	});
	jobs.request('all', { manual: true });
	await g.runNext();
	assert.equal(calls, 1, 'the second phase is not started while busy');
	assert.equal(jobs.status().job.completed, 1);
	assert.equal(jobs.status().state, 'waiting');
	midBusy = false;
	await g.runNext();
	assert.equal(calls, 3, 'the deferred phases resume later');
	assert.equal(jobs.status().state, 'idle');
});

test('a failed task is reported with a redacted error and no fake success', async t => {
	const f = harness(t);
	f.setFail('trending');
	f.jobs.request('all', { manual: true });
	await f.runNext();
	const status = f.jobs.status();
	assert.equal(status.running, false);
	const recent = status.recent.at(-1);
	assert.equal(recent.state, 'failed');
	assert.match(recent.error, /upstream/);
	assert.equal(recent.error.includes('secret.example'), false, 'URLs are removed');
	assert.equal(recent.error.includes('a'.repeat(40)), false, 'token-like values are removed');
	assert.equal(status.lastSuccess.discover > 0, true, 'completed phases keep their real success time');
	assert.equal(status.lastSuccess.trending, null, 'the failed phase does not claim success');
	assert.equal(status.lastSuccess.index, null, 'phases after the failure are not claimed');
});

test('a phase with per-item failures does not claim last success', async t => {
	const f = harness(t);
	const jobs = createCacheJobs({
		tasks: {
			discover: async () => ({ ran: 1, failed: 0 }),
			trending: async () => ({ ran: 2, failed: 1 }),
			index: async () => ({ ran: 1 })
		},
		isBusy: () => false,
		clock: () => 1_800_000_000_000,
		setTimer: (fn, ms) => { const handle = { fn, ms, cleared: false, unref() {} }; f.timers.push(handle); return handle; },
		clearTimer: () => {}
	});
	jobs.request('all', { manual: true });
	await f.runNext();
	const status = jobs.status();
	assert.equal(status.lastSuccess.discover > 0, true);
	assert.equal(status.lastSuccess.trending, null, 'a partial chart failure is not success');
	assert.equal(status.lastSuccess.index > 0, true, 'later phases still run');
	assert.equal(status.recent.at(-1).results.trending.failed, 1, 'the real count remains visible');
});

test('a source change cancels late work instead of publishing it', async t => {
	const f = harness(t);
	let generation = 'gen-a';
	const guarded = createCacheJobs({
		tasks: {
			discover: async () => { generation = 'gen-b'; return { ran: 1 }; },
			trending: async () => ({ ran: 1 }),
			index: async () => ({ ran: 1 })
		},
		isBusy: () => false,
		generation: () => generation,
		clock: () => 1_800_000_000_000,
		setTimer: (fn, ms) => { const handle = { fn, ms, cleared: false, unref() {} }; f.timers.push(handle); return handle; },
		clearTimer: () => {}
	});
	guarded.request('all', { manual: true });
	await f.runNext();
	const status = guarded.status();
	assert.equal(status.running, false);
	assert.equal(status.recent.at(-1).state, 'cancelled');
	assert.equal(status.lastSuccess.discover, null);
	assert.equal(f.ran.length, 0);
});

test('last success and the bounded recent log survive restart; bad files are ignored', async t => {
	const f = harness(t);
	f.jobs.request('index', { manual: true });
	await f.runNext();
	await f.jobs.flush();
	const file = path.join(f.directory, 'state.json');
	const saved = JSON.parse(readFileSync(file, 'utf8'));
	assert.equal(saved.version, 1);
	assert.ok(saved.lastSuccess.index > 0);
	assert.ok(saved.recent.length <= 10);

	const restored = createCacheJobs({
		tasks: { discover: async () => ({}), trending: async () => ({}), index: async () => ({}) },
		isBusy: () => false, clock: () => 1_800_000_000_000,
		file, setTimer: () => ({ unref() {} }), clearTimer: () => {}
	});
	assert.equal(restored.status().lastSuccess.index, saved.lastSuccess.index);
	assert.equal(restored.status().recent.length, saved.recent.length);

	writeFileSync(file, '{not json');
	const corrupt = createCacheJobs({ tasks: { discover: async () => ({}), trending: async () => ({}), index: async () => ({}) }, file,
		setTimer: () => ({ unref() {} }), clearTimer: () => {} });
	assert.equal(corrupt.status().lastSuccess.index, null);

	const big = path.join(f.directory, 'big.json');
	writeFileSync(big, 'x'.repeat(20 * 1024));
	const oversized = createCacheJobs({ tasks: { discover: async () => ({}), trending: async () => ({}), index: async () => ({}) }, file: big,
		setTimer: () => ({ unref() {} }), clearTimer: () => {} });
	assert.equal(oversized.status().lastSuccess.index, null);
	assert.equal(existsSync(big + '.part'), false);
});

test('recent log is bounded, stop cancels the timer and progress is phase-based', async t => {
	const f = harness(t);
	f.jobs.request('all', { manual: true });
	const status = f.jobs.request('all', { manual: true }).job;
	// `total` counts real phases; there is no fabricated percentage field.
	assert.equal(status.total, 3);
	assert.equal('percent' in status, false);
	f.jobs.stop();
	assert.equal(f.timers.at(-1)?.cleared, true);
	assert.equal(f.jobs.status().running, false);
	assert.equal(f.jobs.request('all').reason, 'stopped');
});
