import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createPausedTimeout, DEFAULT_PAUSED_TIMEOUT_MINUTES, MAX_PAUSED_TIMEOUT_MINUTES } from '../paused-timeout.mjs';

test('paused-stream timeout defaults to 10 minutes and persists explicit values', t => {
	const directory = mkdtempSync(path.join(tmpdir(), 'tellybox-paused-timeout-'));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const store = createPausedTimeout(directory);
	assert.deepEqual(store.status(), { minutes: DEFAULT_PAUSED_TIMEOUT_MINUTES });
	assert.deepEqual(store.set({ minutes: 0 }), { minutes: 0 });
	assert.deepEqual(createPausedTimeout(directory).status(), { minutes: 0 });
	assert.deepEqual(store.set({ minutes: 30 }), { minutes: 30 });
	assert.deepEqual(JSON.parse(readFileSync(path.join(directory, 'paused-timeout.json'), 'utf8')), { minutes: 30 });
	assert.deepEqual(createPausedTimeout(directory).status(), { minutes: 30 });
});

test('paused-stream timeout rejects invalid values and keeps the previous setting', t => {
	const directory = mkdtempSync(path.join(tmpdir(), 'tellybox-paused-timeout-bad-'));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const store = createPausedTimeout(directory);
	store.set({ minutes: 25 });
	for (const value of [-1, MAX_PAUSED_TIMEOUT_MINUTES + 1, 1.5, '10', null, undefined]) {
		assert.throws(() => store.set(value == null ? value : { minutes: value }), /whole number|Enter a paused/);
	}
	assert.deepEqual(store.set({ minutes: 5, extra: true }), { minutes: 5 });
	store.set({ minutes: 25 });
	assert.deepEqual(store.status(), { minutes: 25 });
});

test('a malformed persisted paused-stream timeout falls back to 10 minutes', t => {
	const directory = mkdtempSync(path.join(tmpdir(), 'tellybox-paused-timeout-malformed-'));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	writeFileSync(path.join(directory, 'paused-timeout.json'), JSON.stringify({ minutes: 'forever' }));
	assert.deepEqual(createPausedTimeout(directory).status(), { minutes: 10 });
	writeFileSync(path.join(directory, 'paused-timeout.json'), '{');
	assert.deepEqual(createPausedTimeout(directory).status(), { minutes: 10 });
});
