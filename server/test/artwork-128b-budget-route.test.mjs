import test from 'node:test';
import assert from 'node:assert/strict';
import { startArtworkFixture } from './artwork-128-fixture.mjs';

const genres = ['Drama', 'Comedy', 'Action', 'Thriller', 'Family', 'History'];
const movies = Array.from({ length: 36 }, (_, index) => ({
	id: 81000 + index, name: 'Continuation Film ' + (index + 1), tmdb_id: 910000 + index,
	year: 2026, genre: genres[index % genres.length],
	created_at: new Date(Date.UTC(2026, 10, 18, 12) - index * 3600000).toISOString()
}));
const post = async (base, route) => fetch(base + route, {
	method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: '{}'
});

test('36 unique visible candidates get a second bounded artwork continuation', { timeout: 30000 }, async t => {
	const fixture = await startArtworkFixture(t, { movies, metadataMode: 'ok' });
	const cold = await post(fixture.base, '/api/web/home');
	assert.equal(cold.status, 200, await cold.clone().text());
	const feed = await cold.json();
	const all = [...(feed.rows || []).flatMap(row => row.items || []), ...(feed.featured || [])];
	assert.ok(all.length >= 24, 'the fixture produced a multi-rail Home feed');
	assert.ok(feed.availability.artwork.remaining >= 1, 'unrequested visible cards remain after the per-request budget');
	assert.ok(feed.availability.artwork.resolved >= 1 || feed.availability.artwork.pending >= 1, 'the first budget was actually spent');
	let final = null;
	for (let attempt = 0; attempt < 4; attempt++) {
		const next = await post(fixture.base, '/api/web/home/artwork');
		assert.equal(next.status, 200);
		final = await next.json();
		if (final.availability.remaining === 0) break;
		await new Promise(resolve => setTimeout(resolve, 100));
	}
	assert.ok(final, 'the light route answered');
	assert.equal(final.availability.remaining, 0, 'all visible candidates were attempted');
	assert.ok(new Set(final.updates.map(update => update.Id)).size > 0, 'the remaining cards were delivered by the light route');
	assert.deepEqual(Object.keys(final).sort(), ['availability', 'restart', 'updates']);
});
