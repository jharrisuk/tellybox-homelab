import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createDirectPlayer } from '../dispatcharr-player.mjs';
import { createDirectSessionCleanup } from '../direct-session.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function fakeChild() {
	const child = new EventEmitter();
	child.stdin = new PassThrough();
	child.stderr = new PassThrough();
	child.exitCode = null;
	child.killed = '';
	child.kill = signal => {
		child.killed = signal;
		child.exitCode = 0;
		queueMicrotask(() => child.emit('close', 0));
	};
	return child;
}

function body(bytes = 600 * 1024) {
	const chunk = new Uint8Array(bytes);
	return { ok: true, body: { getReader() { let done = false; return { read: async () => done ? { done: true } : (done = true, { done: false, value: chunk }) }; } } };
}

function player({ playlist, timeout, child = fakeChild() } = {}) {
	const instance = createDirectPlayer({
		origin: 'http://127.0.0.1',
		fetcher: async () => body(),
		probeFn: async () => ({ streams: [{ codec_type: 'video', codec_name: 'h264', pix_fmt: 'yuv420p', width: 1920, height: 1080 }, { codec_type: 'audio', index: 1 }], format: { bit_rate: '4000000' } }),
		spawnProcess: () => child,
		readPlaylist: async file => file.endsWith('index.m3u8') ? playlist : Buffer.from('segment'),
		progressTimeoutMs: timeout,
		watchdogMs: 10
	});
	return { instance, child };
}

function harness(id) {
	const session = { id, live: true, position: 12 };
	const sessions = new Map([[id, session]]);
	const counts = { release: 0, end: 0, delete: 0, update: 0, clear: 0 };
	const updates = [];
	const cleanup = createDirectSessionCleanup({
		sessions,
		sessionLimits: { release: () => { counts.release++; } },
		accountLimits: { end: () => { counts.end++; } },
		activity: { update: (sessionId, values) => { counts.update++; updates.push({ id: sessionId, values }); } },
		pausedPlayback: { clear: () => { counts.clear++; } }
	});
	const deleteSession = sessions.delete.bind(sessions);
	sessions.delete = key => { counts.delete++; return deleteSession(key); };
	return { session, sessions, cleanup, counts, updates };
}

// The watchdog fires stop(), and a frozen sequence-zero playlist must tear the
// local direct session down through onStopped exactly once.
test('watchdog expiry runs onStopped once and releases the direct session once', async () => {
	const { session, sessions, cleanup, counts, updates } = harness('d'.repeat(36));
	let stoppedCount = 0;
	const { instance, child } = player({ playlist: '#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:2,\nsegment000000001.ts\n', timeout: 200 });
	const started = await instance.start({ id: 'e'.repeat(36) }, { quality: 8000000, onStopped: () => { stoppedCount++; cleanup.finalize(session); } });

	for (let waited = 0; waited < 2000 && stoppedCount === 0; waited += 10) await sleep(10);
	assert.equal(stoppedCount, 1, 'watchdog expiry calls onStopped once');
	await sleep(20);

	assert.equal(child.killed, 'SIGTERM');
	assert.deepEqual(counts, { release: 1, end: 1, delete: 1, update: 1, clear: 1 }, 'each teardown step runs once');
	assert.equal(sessions.has(session.id), false);
	assert.deepEqual(updates, [{ id: session.id, values: { state: 'ended', position: 12 } }]);
	assert.equal(cleanup.finalized(session), true);

	// A late client stop must not run any of the teardown twice.
	await started.stop();
	await started.stop();
	assert.equal(stoppedCount, 1, 'stop after a watchdog expiry is a no-op');
	assert.deepEqual(counts, { release: 1, end: 1, delete: 1, update: 1, clear: 1 });
});

test('client stop called twice notifies onStopped and cleans up once', async () => {
	const { session, sessions, cleanup, counts } = harness('f'.repeat(36));
	let stoppedCount = 0;
	const { instance, child } = player({ playlist: '#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:0\n#EXTINF:2,\nsegment000000001.ts\n', timeout: 5000 });
	const started = await instance.start({ id: 'a'.repeat(36) }, { quality: 8000000, onStopped: () => { stoppedCount++; cleanup.finalize(session); } });

	await started.stop();
	await started.stop();

	assert.equal(stoppedCount, 1, 'the player stop callback fires exactly once');
	assert.deepEqual(counts, { release: 1, end: 1, delete: 1, update: 1, clear: 1 }, 'each teardown step runs once');
	assert.equal(sessions.has(session.id), false);
	assert.equal(child.killed, 'SIGTERM');
});

test('finalize and markEnded are idempotent and tolerate missing dependencies', () => {
	const session = { id: 'session-a', position: 42 };
	const calls = { release: [], end: [], delete: [], update: [] };
	const cleanup = createDirectSessionCleanup({
		sessions: { delete: id => calls.delete.push(id) },
		sessionLimits: { release: id => calls.release.push(id) },
		accountLimits: { end: id => calls.end.push(id) },
		activity: { update: (id, values) => calls.update.push({ id, values }) }
	});

	assert.equal(cleanup.finalized(session), false);
	assert.equal(cleanup.finalize(session), true);
	assert.equal(cleanup.finalized(session), true);
	assert.equal(cleanup.finalize(session), false, 'a second finalize is a no-op');
	assert.equal(cleanup.markEnded(session), false, 'finalize already marked it ended');
	assert.deepEqual(calls.release, ['session-a']);
	assert.deepEqual(calls.end, ['session-a']);
	assert.deepEqual(calls.delete, ['session-a']);
	assert.equal(calls.update.length, 1);
	assert.deepEqual(calls.update[0], { id: 'session-a', values: { state: 'ended', position: 42 } });

	// markEnded may run first (for example on a client heartbeat stop) without
	// causing finalize to write a second ended record.
	const early = { id: 'session-b', position: 7 };
	assert.equal(cleanup.markEnded(early), true);
	assert.equal(cleanup.markEnded(early, { position: 9 }), false);
	assert.equal(cleanup.finalize(early, { position: 9 }), true);
	assert.deepEqual(calls.update.filter(entry => entry.id === 'session-b').map(entry => entry.values), [{ state: 'ended', position: 7 }]);
	assert.deepEqual(calls.release, ['session-a', 'session-b']);

	// Missing maps, counters and activity are all optional.
	const bare = createDirectSessionCleanup();
	assert.equal(bare.finalize({ id: 'session-c' }), true);
	assert.equal(bare.finalize(null), false);
	assert.equal(bare.finalize({}), true);
	assert.equal(bare.markEnded({}), false);
	assert.equal(bare.finalized(undefined), false);

	// A failing dependency must not stop the remaining teardown.
	const failing = createDirectSessionCleanup({
		sessions: { delete: id => calls.delete.push(id) },
		sessionLimits: { release: () => { throw new Error('release failed'); } },
		accountLimits: { end: id => calls.end.push(id) },
		activity: { update: () => { throw new Error('update failed'); } }
	});
	assert.equal(failing.finalize({ id: 'session-d' }), true);
	assert.equal(calls.delete.includes('session-d'), true);
	assert.equal(calls.end.includes('session-d'), true);
});
