import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { startArtworkFixture } from './artwork-128-fixture.mjs';

const movies = Array.from({ length: 2 }, (_, index) => ({
	id: 81000 + index, name: 'Source Session Film ' + (index + 1), tmdb_id: 910000 + index,
	year: 2026, genre: 'Drama', created_at: new Date(Date.UTC(2026, 10, 18, 12) - index * 3600000).toISOString()
}));
const post = async (base, route) => fetch(base + route, {
	method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: '{}'
});

test('an in-process source/config change invalidates the Home artwork session', { timeout: 30000 }, async t => {
	const fixture = await startArtworkFixture(t, { movies, metadataMode: 'slow' });
	fixture.calls.setMode('slow', 5200);
	const home = await post(fixture.base, '/api/web/home');
	assert.equal(home.status, 200);
	const feed = await home.json();
	assert.ok(feed.availability.artwork.remaining >= 1, 'a session exists for unresolved cards');

	const before = await (await post(fixture.base, '/api/web/home/artwork')).json();
	assert.equal(before.restart, false, 'the same source can use its session');

	// Rotating the local Dispatcharr config is a source/config generation change.
	const file = path.join(fixture.directory, 'dispatcharr.json');
	const config = JSON.parse(readFileSync(file, 'utf8'));
	writeFileSync(file, JSON.stringify({ ...config, key: config.key + '-rotated' }));

	const after = await (await post(fixture.base, '/api/web/home/artwork')).json();
	assert.equal(after.restart, true, 'the old source session is not reused');
	assert.deepEqual(after.updates, []);
	assert.equal(after.availability.remaining, 0);
});
