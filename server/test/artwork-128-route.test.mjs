import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createVodMetadata } from '../vod-metadata.mjs';
import { IDS, png, startArtworkFixture } from './artwork-128-fixture.mjs';

const BAD = 'dispatch-movie-' + IDS.badPoster;
const GOOD = 'dispatch-movie-' + IDS.providerPoster;
const NONE = 'dispatch-movie-' + IDS.noPoster;

const allItems = feed => [
	...(Array.isArray(feed?.rows) ? feed.rows.flatMap(row => Array.isArray(row.items) ? row.items : []) : []),
	...(Array.isArray(feed?.featured) ? feed.featured : []),
];
const findItem = (feed, id) => allItems(feed).find(item => item.Id === id);
const home = async (base, body = {}) => {
	const started = Date.now();
	const response = await fetch(base + '/api/web/home', {
		method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify(body)
	});
	return { response, ms: Date.now() - started };
};
const settle = async (base, timeoutMs = 6000) => {
	const until = Date.now() + timeoutMs;
	let feed = null;
	while (Date.now() < until) {
		feed = await (await home(base)).response.json();
		if (feed?.availability?.artwork?.pending === 0) return feed;
		await new Promise(resolve => setTimeout(resolve, 100));
	}
	return feed;
};

test('cold Home warms displayed provider-missing artwork without a detail visit', { timeout: 45000 }, async t => {
	const fixture = await startArtworkFixture(t);
	const cold = await home(fixture.base);
	assert.equal(cold.response.status, 200, await cold.response.clone().text());
	const feed = await cold.response.json();
	assert.ok(Array.isArray(feed.rows) && feed.rows.length > 0, 'Home returned rows');
	const recent = feed.rows.find(row => row.id === 'new');
	assert.ok(recent && recent.items.length > 0, 'Recently added row is present');
	assert.equal(recent.items[0].Id, BAD, 'the newest fixture is first in Recently added');
	assert.ok(feed.availability?.artwork, 'artwork availability is reported');
	assert.ok(Number.isInteger(feed.availability.artwork.requested), 'request count is numeric');
	assert.ok(Number.isInteger(feed.availability.artwork.pending), 'pending count is numeric');
	assert.ok(Object.values(feed.availability.artwork).every(value => typeof value === 'number'), 'availability carries counts only');

	const bad = findItem(feed, BAD);
	assert.ok(bad, 'the provider-missing title is displayed');
	assert.equal(bad.Name, 'Gentle Monster');
	// The first response may still be pending, but the metadata lookup must have
	// been started for the displayed card without a detail request.
	await new Promise(resolve => setTimeout(resolve, 200));
	assert.ok(fixture.calls.seerr >= 1, 'displayed metadata enrichment was requested');
	assert.ok(fixture.calls.seerrIds.includes(1473148), 'the missing-provider title was warmed');

	// The normal Home refresh must attach the TMDB route to the same card and
	// keep the title available once the bounded queue settles.
	const warmFeed = await settle(fixture.base);
	assert.ok(warmFeed, 'the bounded refresh returned a feed');
	const warmBad = findItem(warmFeed, BAD);
	assert.ok(warmBad, 'the title stays in Home');
	assert.match(warmBad.Artwork || '', /^\/api\/web\/tmdb-art\/movie\/1473148\/poster$/, 'the card now uses the available TMDB poster');
	assert.equal(warmFeed.availability.artwork.pending, 0, 'the visible artwork queue settled');
	assert.equal(warmFeed.availability.artwork.failed, 0, 'no visible artwork lookup failed');

	// Repeating the request is warm: no new metadata details.
	const before = fixture.calls.seerr;
	const repeat = await home(fixture.base);
	assert.equal(repeat.response.status, 200);
	const repeatFeed = await repeat.response.json();
	assert.equal(fixture.calls.seerr, before, 'warm repeat makes no redundant metadata request');
	assert.equal(repeatFeed.availability.artwork.requested, 0, 'warm repeat queues nothing');
	assert.match(findItem(repeatFeed, BAD).Artwork, /^\/api\/web\/tmdb-art\/movie\/1473148\/poster$/);

	// The card's original provider route now resolves through the cached public
	// TMDB poster instead of staying a permanent 404.
	const fallback = await fetch(fixture.base + '/api/web/art/movie/' + IDS.badPoster + '?v=76912');
	assert.equal(fallback.status, 200, 'provider URL falls back to available TMDB art');
	assert.equal(fallback.headers.get('content-type'), 'image/png');
	assert.equal(fallback.headers.get('cache-control'), 'private, max-age=86400');
	assert.deepEqual(Buffer.from(await fallback.arrayBuffer()), png);

	const tmdb = await fetch(fixture.base + '/api/web/tmdb-art/movie/1473148/poster');
	assert.equal(tmdb.status, 200);
	assert.equal(tmdb.headers.get('cache-control'), 'private, max-age=86400');
	assert.equal(tmdb.headers.get('content-type'), 'image/png');

	// Existing good provider artwork keeps its own origin route and private cache.
	const provider = await fetch(fixture.base + '/api/web/art/movie/' + IDS.providerPoster + '?v=9001');
	assert.equal(provider.status, 200);
	assert.equal(provider.headers.get('cache-control'), 'private, max-age=1800');

	// A title with no TMDB poster is never fabricated; it keeps its title and
	// intentional provider fallback.
	const none = findItem(warmFeed, NONE);
	assert.ok(none && none.Name === 'No Poster Film', 'the no-poster title remains available');
	assert.doesNotMatch(none.Artwork || '', /^\/api\/web\/tmdb-art\//, 'no fabricated TMDB route');
	const missing = await fetch(fixture.base + '/api/web/art/movie/' + IDS.noPoster);
	assert.equal(missing.status, 404);
	assert.equal(missing.headers.get('cache-control'), 'no-store', 'a missing image is not cached as a permanent placeholder');

	// A provider that still advertises a logo id but whose image is gone must not
	// leave a permanent placeholder when TMDB has the poster. The feed card moves
	// to the TMDB route even though the old provider URL itself still 404s.
	const stale = findItem(warmFeed, 'dispatch-movie-' + IDS.staleLogo);
	assert.ok(stale && stale.Name === 'Stale Logo Film', 'the stale-logo title remains available');
	assert.match(stale.Artwork || '', /^\/api\/web\/tmdb-art\/movie\/700005\/poster$/, 'the stale provider logo is replaced by available TMDB art');

	// Every visible metadata identity was requested at most once.
	const counts = new Map();
	for (const id of fixture.calls.seerrIds) counts.set(id, (counts.get(id) || 0) + 1);
	assert.ok([...counts.values()].every(value => value === 1), 'duplicate displayed items are deduplicated');

	// Cold and warm responses are bounded; the timer is evidence, not a speed claim.
	assert.ok(cold.ms < 8000, 'cold Home did not hang on metadata: ' + cold.ms + 'ms');
	assert.ok(repeat.ms < 5000, 'warm Home did not wait on settled metadata: ' + repeat.ms + 'ms');

	// The metadata success cache is persisted for a later restart. A fresh
	// metadata service reading the same file resolves the poster without lookup.
	const file = path.join(fixture.directory, 'vod-metadata.json');
	for (let attempt = 0; attempt < 30 && !existsSync(file); attempt++) await new Promise(resolve => setTimeout(resolve, 100));
	assert.ok(existsSync(file), 'metadata was saved for restart reuse');
	const persisted = JSON.parse(readFileSync(file, 'utf8'));
	assert.ok(persisted.some(([key, value]) => key === 'movie/1473148' && value?.data?.poster === '/poster-1473148.jpg'));
	let lookups = 0;
	const reloaded = createVodMetadata({ lookup: async () => { lookups += 1; return metadataFor1473148(); }, file });
	const movie = { Type: 'Movie', Source: 'streamed', ProviderIds: { Tmdb: '1473148' } };
	await reloaded.cached([movie]);
	assert.equal(reloaded.state(movie), 'cached');
	assert.equal(await reloaded.artwork('movie', 1473148, 'poster'), '/poster-1473148.jpg');
	assert.equal(lookups, 0, 'restart reuse does not call the provider');
});

function metadataFor1473148() {
	return { id: 1473148, title: 'Gentle Monster', posterPath: '/poster-1473148.jpg', releaseDate: '2026-01-01', voteAverage: 7, voteCount: 100, genres: [{ name: 'Drama' }] };
}
