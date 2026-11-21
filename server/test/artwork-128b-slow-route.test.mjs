import test from 'node:test';
import assert from 'node:assert/strict';
import { startArtworkFixture } from './artwork-128-fixture.mjs';

const genres = ['Drama', 'Comedy', 'Action'];
const movies = Array.from({ length: 3 }, (_, index) => ({
	id: 81000 + index, name: 'Continuation Film ' + (index + 1), tmdb_id: 910000 + index,
	year: 2026, genre: genres[index], created_at: new Date(Date.UTC(2026, 10, 18, 12) - index * 3600000).toISOString()
}));
const find = (feed, id) => [...(feed.rows || []).flatMap(row => row.items || []), ...(feed.featured || [])].find(item => item.Id === id);
const post = async (base, route) => {
	const started = Date.now();
	const response = await fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: '{}' });
	return { response, ms: Date.now() - started };
};

test('cold Home returns before a 5.2 s lookup and the light route delivers it later', { timeout: 30000 }, async t => {
	const fixture = await startArtworkFixture(t, { movies, metadataMode: 'slow' });
	fixture.calls.setMode('slow', 5200);
	const cold = await post(fixture.base, '/api/web/home');
	assert.equal(cold.response.status, 200, await cold.response.clone().text());
	assert.ok(cold.ms < 1800, 'Home did not block on the slow metadata: ' + cold.ms + 'ms');
	const feed = await cold.response.json();
	assert.ok(feed.rows.length > 0);
	assert.ok(feed.availability.artwork.remaining >= 1, 'the unresolved visible card is reported');
	assert.ok(feed.availability.artwork.pending >= 1, 'the lookup is in flight');
	const id = 'dispatch-movie-81000';
	assert.ok(find(feed, id), 'the card is painted');

	await new Promise(resolve => setTimeout(resolve, 1200));
	const early = await post(fixture.base, '/api/web/home/artwork');
	assert.equal(early.response.status, 200);
	const earlyBody = await early.response.json();
	assert.equal(earlyBody.updates.length, 0, 'no artwork is invented before the lookup lands');
	assert.ok(earlyBody.availability.remaining >= 1);

	await new Promise(resolve => setTimeout(resolve, 4400));
	const late = await post(fixture.base, '/api/web/home/artwork');
	assert.equal(late.response.status, 200);
	const lateBody = await late.response.json();
	assert.equal(lateBody.restart, false);
	assert.ok(lateBody.updates.some(update => update.Id === id && /^\/api\/web\/tmdb-art\/movie\/910000\/poster$/.test(update.Artwork)));
	assert.equal(lateBody.availability.remaining, 0, 'the continuation completed');
});
