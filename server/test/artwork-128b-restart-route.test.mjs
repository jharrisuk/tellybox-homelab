import test from 'node:test';
import assert from 'node:assert/strict';
import { startArtworkFixture } from './artwork-128-fixture.mjs';

const movies = Array.from({ length: 2 }, (_, index) => ({
	id: 81000 + index, name: 'Continuation Film ' + (index + 1), tmdb_id: 910000 + index,
	year: 2026, genre: 'Drama', created_at: new Date(Date.UTC(2026, 10, 18, 12) - index * 3600000).toISOString()
}));

test('the artwork route without a visible session asks for one bounded restart', async t => {
	const fixture = await startArtworkFixture(t, { movies, metadataMode: 'ok' });
	const response = await fetch(fixture.base + '/api/web/home/artwork', {
		method: 'POST', headers: { 'Content-Type': 'application/json', Origin: fixture.base }, body: '{}'
	});
	assert.equal(response.status, 200);
	const body = await response.json();
	assert.equal(body.restart, true, 'no session yet');
	assert.deepEqual(body.updates, []);
	assert.equal(body.availability.remaining, 0);
});
