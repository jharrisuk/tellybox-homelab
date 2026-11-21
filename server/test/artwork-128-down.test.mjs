import test from 'node:test';
import assert from 'node:assert/strict';
import { IDS, startArtworkFixture } from './artwork-128-fixture.mjs';

const allItems = feed => (feed.rows || []).flatMap(row => row.items || []);
const find = (feed, id) => allItems(feed).find(item => item.Id === id);
const post = async base => {
	const started = Date.now();
	const response = await fetch(base + '/api/web/home', {
		method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: '{}'
	});
	return { response, ms: Date.now() - started };
};

test('TMDB down is bounded, keeps titles, and backs off without a request storm', { timeout: 30000 }, async t => {
	const fixture = await startArtworkFixture(t, { metadataMode: 'down' });
	const cold = await post(fixture.base);
	assert.equal(cold.response.status, 200);
	const feed = await cold.response.json();
	assert.ok(cold.ms < 2500, 'Home did not hang while TMDB was down: ' + cold.ms + 'ms');
	assert.ok(find(feed, 'dispatch-movie-' + IDS.badPoster), 'the title remains available when art fails');
	assert.ok(feed.availability.artwork.pending >= 0);
	assert.ok(Number.isInteger(feed.availability.artwork.requested));

	// The first feed queues the bounded lookups; give the immediate 503s time
	// to settle, then the light route reports the backoff failure.
	await new Promise(resolve => setTimeout(resolve, 400));
	const light = await fetch(fixture.base + '/api/web/home/artwork', {
		method: 'POST', headers: { 'Content-Type': 'application/json', Origin: fixture.base }, body: '{}'
	});
	assert.equal(light.status, 200);
	const lightBody = await light.json();
	assert.equal(lightBody.availability.pending, 0, 'a failed lookup is not left pending');
	assert.ok(lightBody.availability.failed >= 1, 'the failed artwork lookup is reported');

	// The error TTL prevents an immediate retry storm, even if the provider
	// comes back. A later bounded refresh may try again.
	const calls = fixture.calls.seerr;
	const repeat = await post(fixture.base);
	assert.equal(repeat.response.status, 200);
	const repeatFeed = await repeat.response.json();
	assert.equal(fixture.calls.seerr, calls, 'a failed lookup is not retried on the next Home visit');
	assert.ok(repeatFeed.availability.artwork.failed >= 1, 'the backed-off failure is still reported');

	// No fabricated TMDB route is attached to a title whose metadata failed.
	const bad = find(repeatFeed, 'dispatch-movie-' + IDS.badPoster);
	assert.doesNotMatch(bad.Artwork || '', /^\/api\/web\/tmdb-art\//);

	// The image route itself never enqueues metadata, even when the provider
	// logo is missing and the metadata lookup already failed.
	const beforeImage = fixture.calls.seerr;
	const image = await fetch(fixture.base + '/api/web/art/movie/' + IDS.badPoster);
	assert.equal(image.status, 404);
	assert.equal(image.headers.get('cache-control'), 'no-store');
	assert.equal(fixture.calls.seerr, beforeImage, 'the image route does not start a metadata request');
});
