import test from 'node:test';
import assert from 'node:assert/strict';
import { createHomeNetwork } from '../home-network.mjs';

test('home address refresh expires, follows changes and fails closed', async () => {
	let clock = 1000;
	let answer = '8.8.8.8';
	const revoked = [];
	const home = createHomeNetwork('https://relay.example.test/relay-client-ip', {
		now: () => clock,
		fetcher: async () => { if (answer === 'error') throw new Error('offline'); return new Response(answer); },
		onChange: value => revoked.push(value)
	});
	assert.equal(home.matches(answer), false);
	await home.refresh();
	assert.equal(home.matches(answer), true);
	assert.equal(home.matches('8.8.4.4'), false);
	clock += 120001;
	assert.equal(home.matches(answer), false);
	answer = '8.8.4.4';
	await home.refresh();
	assert.equal(home.matches('8.8.8.8'), false);
	assert.equal(home.matches(answer), true);
	assert.deepEqual(revoked, ['8.8.8.8']);
	answer = 'error';
	await home.refresh();
	assert.equal(home.matches('8.8.4.4'), false);
	assert.deepEqual(revoked, ['8.8.8.8', '8.8.4.4']);
	for (answer of ['10.50.0.10', '127.0.0.1', '100.64.1.1', '8.8.8.8, 8.8.4.4', '<html>failure</html>']) {
		await home.refresh();
		assert.equal(home.status().active, false);
	}
	assert.throws(() => createHomeNetwork('http://relay.example.test/relay-client-ip'));
});
