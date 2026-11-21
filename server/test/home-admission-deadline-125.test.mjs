import test from 'node:test';
import assert from 'node:assert/strict';
import { runHomeUpstream, homeEpisodeAdmissionState } from '../home-episodes.mjs';

test('an immediately admitted lookup does not start after an event-loop delay expires its deadline', async () => {
	let started = false;
	const deadline = Date.now() + 10;
	const pending = runHomeUpstream(() => { started = true; return 'late'; }, deadline);
	while (Date.now() <= deadline + 10) { /* simulate a busy event loop before the thunk runs */ }
	assert.deepEqual(await pending, { admitted: false });
	assert.equal(started, false);
	assert.equal(homeEpisodeAdmissionState().active, 0);
	assert.deepEqual(await runHomeUpstream(() => 'fresh', Date.now() + 1000), { value: 'fresh' });
	assert.equal(homeEpisodeAdmissionState().active, 0);
});
