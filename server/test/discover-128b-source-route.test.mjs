import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { startArtworkFixture } from './artwork-128-fixture.mjs';

const get = async (base, route) => {
	const response = await fetch(base + route);
	return { response, body: await response.json() };
};

test('changing the Seerr source cannot serve the previous source inside the old snapshot', { timeout: 30000 }, async t => {
	const fixture = await startArtworkFixture(t, { movies: [], metadataMode: 'ok' });
	const first = await get(fixture.base, '/api/discover');
	assert.equal(first.response.status, 200);
	const before = fixture.calls.discover;
	// The fixture ignores the key; the changed non-secret source fingerprint is
	// enough to prove the old snapshot is not replayed.
	const file = path.join(fixture.directory, 'seerr.json');
	const config = JSON.parse(readFileSync(file, 'utf8'));
	writeFileSync(file, JSON.stringify({ ...config, key: config.key + '-rotated' }));
	const afterChange = await get(fixture.base, '/api/discover');
	assert.equal(afterChange.response.status, 200);
	assert.ok(fixture.calls.discover > before, 'a source change is not served from the old snapshot');
});
