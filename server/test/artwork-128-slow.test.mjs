import test from 'node:test';
import assert from 'node:assert/strict';
import { IDS, startArtworkFixture } from './artwork-128-fixture.mjs';

const allItems = feed => (feed.rows || []).flatMap(row => row.items || []);
const find = (feed, id) => allItems(feed).find(item => item.Id === id);

test('slow TMDB never holds Home open and settles after the bounded wait', { timeout: 30000 }, async t => {
	const fixture = await startArtworkFixture(t, { metadataMode: 'slow' });
	fixture.calls.setMode('slow', 1200);
	const started = Date.now();
	const response = await fetch(fixture.base + '/api/web/home', {
		method: 'POST', headers: { 'Content-Type': 'application/json', Origin: fixture.base }, body: '{}'
	});
	const elapsed = Date.now() - started;
	assert.equal(response.status, 200);
	const feed = await response.json();
	assert.ok(elapsed < 2500, 'Home returned before the slow provider: ' + elapsed + 'ms');
	assert.ok((feed.rows || []).length > 0, 'rows stay visible while metadata is slow');
	assert.ok(find(feed, 'dispatch-movie-' + IDS.badPoster), 'the title remains available');
	assert.ok(feed.availability.artwork.pending >= 1, 'slow artwork is reported as pending');
	assert.ok(feed.availability.artwork.requested >= 1, 'slow artwork was requested');

	// Once the slow response lands, a later request reuses it without hanging.
	const until = Date.now() + 8000;
	let warmFeed = null;
	while (Date.now() < until) {
		const warm = await fetch(fixture.base + '/api/web/home', {
			method: 'POST', headers: { 'Content-Type': 'application/json', Origin: fixture.base }, body: '{}'
		});
		assert.equal(warm.status, 200);
		warmFeed = await warm.json();
		if (warmFeed.availability.artwork.pending === 0) break;
		await new Promise(resolve => setTimeout(resolve, 150));
	}
	assert.equal(warmFeed.availability.artwork.pending, 0, 'the slow queue settled');
	const bad = find(warmFeed, 'dispatch-movie-' + IDS.badPoster);
	assert.match(bad.Artwork, /^\/api\/web\/tmdb-art\/movie\/1473148\/poster$/, 'the resolved poster reaches the card');
});
