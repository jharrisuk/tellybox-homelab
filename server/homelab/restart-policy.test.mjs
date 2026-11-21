import test from 'node:test';
import assert from 'node:assert/strict';
import { restartDelay, RESTART_DELAYS_MS } from './restart-policy.mjs';

test('unexpected media exits use bounded increasing backoff and then pause', () => {
	assert.deepEqual(RESTART_DELAYS_MS, [2000, 5000, 15000, 30000, 60000]);
	for (let attempt = 0; attempt < RESTART_DELAYS_MS.length; attempt++) {
		assert.equal(restartDelay(attempt), RESTART_DELAYS_MS[attempt]);
	}
	assert.equal(restartDelay(RESTART_DELAYS_MS.length), null, 'no sixth automatic restart');
	assert.equal(restartDelay(-1), null);
	assert.equal(restartDelay(1.5), null);
});
