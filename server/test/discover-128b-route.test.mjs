import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { startArtworkFixture } from './artwork-128-fixture.mjs';

const get = async (base, route) => {
	const started = Date.now();
	const response = await fetch(base + route);
	return { response, ms: Date.now() - started, body: await response.json() };
};

test('Discover default browse and provider rail are fast on a warm public snapshot', { timeout: 30000 }, async t => {
	const fixture = await startArtworkFixture(t, { movies: [], metadataMode: 'ok' });
	const cold = await get(fixture.base, '/api/discover');
	assert.equal(cold.response.status, 200, JSON.stringify(cold.body));
	assert.ok(Array.isArray(cold.body.items) && cold.body.items.length > 0);
	assert.ok(cold.body.items.every(item => !('watchId' in item) || item.watchId === null));
	const warm = await get(fixture.base, '/api/discover');
	assert.equal(warm.response.status, 200);
	assert.deepEqual(warm.body.items.map(item => item.id), cold.body.items.map(item => item.id));
	assert.ok(warm.ms <= cold.ms + 250, 'warm Discover is not slower than the cold miss: ' + cold.ms + 'ms / ' + warm.ms + 'ms');

	const providerCold = await get(fixture.base, '/api/discover/provider/8');
	assert.equal(providerCold.response.status, 200, JSON.stringify(providerCold.body));
	assert.ok(providerCold.body.items.length > 0);
	const providerWarm = await get(fixture.base, '/api/discover/provider/8');
	assert.equal(providerWarm.response.status, 200);
	assert.deepEqual(providerWarm.body.items.map(item => item.id), providerCold.body.items.map(item => item.id));
	assert.ok(providerWarm.ms <= providerCold.ms + 250, 'warm provider is not slower: ' + providerCold.ms + 'ms / ' + providerWarm.ms + 'ms');

	// The durable snapshot is sanitized public metadata only.
	const file = path.join(fixture.directory, 'discover-public-cache.json');
	let raw = '';
	for (let attempt = 0; attempt < 40; attempt++) {
		if (existsSync(file)) {
			raw = readFileSync(file, 'utf8');
			try { if (Object.keys(JSON.parse(raw).entries).length >= 2) break; } catch {}
		}
		await new Promise(resolve => setTimeout(resolve, 100));
	}
	assert.ok(raw, 'the public snapshot was written');
	for (const forbidden of ['mediaInfo', 'jellyfinMediaId', 'watchId', 'vodId', 'requests', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'Bearer', 'api_key']) {
		assert.equal(raw.includes(forbidden), false, 'snapshot must not contain ' + forbidden);
	}
	const saved = JSON.parse(raw);
	assert.ok(Object.keys(saved.entries).length >= 2, 'default browse and provider entries are present');
	assert.ok(Object.values(saved.entries).every(entry => entry.payload.items.every(item => typeof item.title === 'string' && !('status' in item) && !('statusLabel' in item))));
});
