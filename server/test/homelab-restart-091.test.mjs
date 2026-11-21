import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApplyController } from '../homelab/apply.mjs';

function fixture(t) {
	const directory = mkdtempSync(path.join(os.tmpdir(), 'tellybox-restart-'));
	mkdirSync(directory, { recursive: true });
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	return directory;
}

test('unexpected-exit recovery restarts the media child once and keeps the applied revision', async t => {
	const directory = fixture(t);
	let starts = 0, stops = 0;
	const runtime = createApplyController({ directory, stop: async () => { stops++; },
		start: async environment => { starts++; return environment; }, ready: async () => {} });
	await runtime.boot();
	assert.equal(starts, 1);
	const stopsBefore = stops;
	await runtime.restart();
	assert.equal(starts, 2, 'recovery starts exactly one child');
	assert.equal(stops - stopsBefore, 1, 'the stale child is stopped first');
	assert.equal(runtime.status().appliedRevision, 0, 'recovery does not rewrite configuration');
	assert.equal(runtime.status().applying, false);
});

test('a failed recovery reports the failure, leaves no applying lock and does not change settings', async t => {
	const directory = fixture(t);
	let starts = 0, fail = false;
	const runtime = createApplyController({ directory, stop: async () => {},
		start: async environment => { starts++; return environment; },
		ready: async () => { if (fail) throw Error('not ready'); } });
	await runtime.boot();
	fail = true;
	await assert.rejects(runtime.restart(), /not ready/);
	assert.equal(starts, 2);
	assert.equal(runtime.status().applying, false);
	assert.equal(runtime.status().appliedRevision, 0);
	assert.equal(runtime.status().lastApplyFailed, false, 'recovery failure is not a settings failure');
});
