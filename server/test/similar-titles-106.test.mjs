/* Release 106 staged checks for the "Similar titles" details section.
 *
 * These are synthetic fixtures only. The tests use the public module API, do
 * not start a server, do not touch provider metadata and do not read production
 * data. No title used here is hardcoded into the implementation.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
	buildSimilarTitles,
	rankSimilarCandidates,
	similarLimit,
	similarView,
	SIMILAR_DEFAULT_LIMIT,
	SIMILAR_MAX_LIMIT,
	SIMILAR_MIN_LIMIT
} from '../similar-titles.mjs';
import { homeVisibleItems } from '../home-feed.mjs';

const GENRES = ['Documentary', 'Crime', 'Comedy', 'Drama', 'Action', 'Adventure', 'Science Fiction', 'Fantasy', 'Family', 'Animation', 'History', 'Mystery', 'Thriller', 'Horror', 'Romance', 'Music'];

let sequence = 0;
function makeItem(overrides = {}) {
	sequence += 1;
	const index = sequence;
	const id = overrides.Id || `41000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
	return {
		Id: id,
		Name: `Fixture title ${index}`,
		Type: 'Movie',
		Source: 'local',
		Genres: ['Drama'],
		ProductionYear: 2000 + (index % 24),
		ProviderIds: { Tmdb: String(500000 + index) },
		Artwork: '/art/' + id,
		...overrides
	};
}

function ids(items) {
	return items.map(item => item.Id);
}

test('seed genres drive relevance and a different seed changes the result', () => {
	const seedDocumentary = makeItem({ Name: 'Quiet reef', Genres: ['Documentary'] });
	const documentaryOne = makeItem({ Name: 'Wild coast', Genres: ['Documentary'] });
	const documentaryTwo = makeItem({ Name: 'Ocean deep', Genres: ['Documentary'] });
	const horror = makeItem({ Name: 'Dark house', Genres: ['Horror'] });
	const comedy = makeItem({ Name: 'Loud weekend', Genres: ['Comedy'] });
	const pool = [seedDocumentary, documentaryOne, documentaryTwo, horror, comedy];
	const documentaries = buildSimilarTitles({ seed: seedDocumentary, items: pool });
	assert.deepEqual(new Set(ids(documentaries)), new Set([documentaryOne.Id, documentaryTwo.Id]));
	assert.ok(documentaries.every(item => item.reason === 'More like this'), 'no caller signal means the neutral reason');

	const seedHorror = makeItem({ Name: 'Creaking door', Genres: ['Horror'] });
	const sequelHorror = makeItem({ Name: 'Creaking attic', Genres: ['Horror'] });
	const horrorResults = buildSimilarTitles({ seed: seedHorror, items: [seedHorror, sequelHorror, documentaryOne, comedy] });
	assert.deepEqual(ids(horrorResults), [sequelHorror.Id], 'a horror seed must not inherit documentary matches');
});

test('trusted Overview tokens and keywords provide a theme match without genre overlap', () => {
	const seed = makeItem({
		Name: 'Harbour mystery',
		Genres: [],
		Overview: 'A detective investigates a missing sailor in a foggy harbour town'
	});
	const themed = makeItem({
		Name: 'Coastal case',
		Genres: ['Comedy'],
		Overview: 'A detective investigates a missing musician in a foggy harbour town'
	});
	const keyworded = makeItem({ Name: 'Noir sketch', Genres: ['Animation'], Keywords: ['noir', 'harbour'] });
	const unrelated = makeItem({ Name: 'Baking day', Genres: ['Drama'], Overview: 'A cheerful baking contest in a sunny city' });
	const results = buildSimilarTitles({ seed, items: [seed, themed, keyworded, unrelated] });
	const found = new Set(ids(results));
	assert.ok(found.has(themed.Id), 'shared Overview tokens should match');
	assert.ok(found.has(keyworded.Id), 'shared trusted keywords should match');
	assert.ok(!found.has(unrelated.Id), 'an unrelated Overview must not match');
});

test('permission filtering uses the same home visible-items contract', () => {
	const seed = makeItem({ Genres: ['Drama'] });
	const allowed = makeItem({ Genres: ['Drama'] });
	const restricted = makeItem({ Genres: ['Drama'] });
	const all = [seed, allowed, restricted];
	const permitted = homeVisibleItems(all, { shared: false, allowed: item => item.Id !== restricted.Id });
	const results = buildSimilarTitles({ seed, items: permitted });
	assert.deepEqual(ids(results), [allowed.Id]);
	assert.ok(!ids(results).includes(restricted.Id), 'a filtered title cannot be returned');
	assert.equal(homeVisibleItems(all, { shared: true, allowed: () => false }).length, all.length);
});

test('the seed, its episode/series identity and duplicate catalogue copies are excluded', () => {
	const seed = makeItem({ Name: 'Seed film', Genres: ['Drama'], ProviderIds: { Tmdb: '600001' } });
	const duplicateOne = makeItem({ Name: 'Same title', Genres: ['Drama'], ProviderIds: { Tmdb: '600002' } });
	const duplicateTwo = makeItem({ Name: 'Same title (copy)', Genres: ['Drama'], ProviderIds: { Tmdb: '600002' } });
	const other = makeItem({ Name: 'Another drama', Genres: ['Drama'], ProviderIds: { Tmdb: '600003' } });
	const films = buildSimilarTitles({ seed, items: [seed, duplicateOne, duplicateTwo, other] });
	assert.ok(!ids(films).includes(seed.Id), 'the seed is never returned');
	assert.equal(films.filter(item => item.Name.startsWith('Same title')).length, 1, 'duplicate identities collapse');
	assert.equal(new Set(ids(films)).size, films.length);

	const seriesSeed = makeItem({ Id: 'dispatch-series-77', Name: 'Seed show', Type: 'Series', Genres: ['Drama'], ProviderIds: { Tmdb: '610001' } });
	const similarSeries = makeItem({ Id: 'dispatch-series-78', Name: 'Similar show', Type: 'Series', Genres: ['Drama'], ProviderIds: { Tmdb: '610002' } });
	const episodeSeed = { Id: 'dispatch-episode-900-77', Name: 'Seed episode', Type: 'Episode', SeriesId: 'dispatch-series-77', Genres: [] };
	const seriesResults = buildSimilarTitles({ seed: episodeSeed, items: [seriesSeed, similarSeries] });
	assert.deepEqual(ids(seriesResults), [similarSeries.Id], 'an episode excludes its own series identity');
	assert.ok(!ids(seriesResults).includes(episodeSeed.Id));
});

test('explicit dislikes and strongly negative genres are excluded', () => {
	const seed = makeItem({ Genres: ['Drama'] });
	const dislikedById = makeItem({ Name: 'Disliked by id', Genres: ['Drama'] });
	const dislikedByProvider = makeItem({ Name: 'Disliked by provider', Genres: ['Drama'], ProviderIds: { Tmdb: '620001' } });
	const hatedGenre = makeItem({ Name: 'Hated genre', Genres: ['Horror'] });
	const allowed = makeItem({ Name: 'Allowed drama', Genres: ['Drama'] });
	const results = buildSimilarTitles({
		seed,
		items: [dislikedById, dislikedByProvider, hatedGenre, allowed],
		taste: {
			genres: [{ name: 'Horror', weight: -5 }, { name: 'Drama', weight: 1 }],
			exclude: [dislikedById.Id, 'tmdb:movie:' + dislikedByProvider.ProviderIds.Tmdb]
		}
	});
	assert.deepEqual(ids(results), [allowed.Id]);
});

test('the positive reason appears only when the caller signal overlaps, never from the seed itself', () => {
	const seed = makeItem({ Name: 'The seed', Genres: ['Drama'] });
	const candidate = makeItem({ Name: 'A drama', Genres: ['Drama'] });
	const other = makeItem({ Name: 'Another drama', Genres: ['Drama'] });

	const neutral = buildSimilarTitles({ seed, items: [seed, candidate, other], favourites: [seed.Id] });
	assert.equal(neutral.find(item => item.Id === candidate.Id)?.reason, 'More like this', 'a favourite seed is not evidence the viewer likes it');

	const positiveTaste = buildSimilarTitles({
		seed, items: [seed, candidate, other],
		taste: { genres: [{ name: 'Drama', weight: 4 }], exclude: [] }
	});
	assert.equal(positiveTaste.find(item => item.Id === candidate.Id)?.reason, 'Because you like drama');

	const unrelatedTaste = buildSimilarTitles({
		seed, items: [seed, candidate, other],
		taste: { genres: [{ name: 'Comedy', weight: 5 }], exclude: [] }
	});
	assert.equal(unrelatedTaste.find(item => item.Id === candidate.Id)?.reason, 'More like this', 'a non-overlapping taste must stay neutral');

	const historySignal = buildSimilarTitles({
		seed, items: [seed, candidate, other],
		history: [{ itemId: 'elsewhere', genres: ['Drama'], updated: 1 }]
	});
	assert.equal(historySignal.find(item => item.Id === candidate.Id)?.reason, 'Because you like drama');

	const seedHistory = buildSimilarTitles({
		seed, items: [seed, candidate, other],
		history: [{ itemId: seed.Id, genres: ['Drama'], updated: 2 }]
	});
	assert.equal(seedHistory.find(item => item.Id === candidate.Id)?.reason, 'More like this', 'history for the seed alone is not a caller preference');

	const favouriteSignal = buildSimilarTitles({ seed, items: [seed, candidate, other], favourites: [other.Id] });
	assert.equal(favouriteSignal.find(item => item.Id === candidate.Id)?.reason, 'Because you like drama');
});

test('responses expose only safe display fields and never UserData or Overview', () => {
	const seed = makeItem({ Genres: ['Drama'] });
	const candidate = makeItem({
		Name: 'Sensitive fixture',
		Genres: ['Drama'],
		Overview: 'This overview must not leave the server',
		UserData: { Played: true, PlaybackPositionTicks: 123456 },
		ProviderIds: { Tmdb: '630001', Private: 'do-not-leak' },
		_score: 99,
		secret: 'do-not-leak'
	});
	const [view] = buildSimilarTitles({ seed, items: [seed, candidate] });
	assert.ok(view);
	for (const forbidden of ['UserData', 'Overview', 'ProviderIds', 'score', '_score', 'secret', 'seed']) {
		assert.equal(forbidden in view, false, forbidden + ' must not be returned');
	}
	const serialized = JSON.stringify(view);
	for (const secret of ['Played', 'PlaybackPositionTicks', 'This overview', 'do-not-leak']) {
		assert.ok(!serialized.includes(secret), secret + ' leaked from the similar view');
	}
	assert.deepEqual(Object.keys(view).sort(), ['Artwork', 'Genres', 'Id', 'Name', 'ProductionYear', 'Provider', 'Ratings', 'Source', 'Type', 'reason']
		.filter(key => view[key] !== undefined).sort());
	assert.equal(similarView({ ...candidate }, 'unknown reason').reason, 'More like this');
});

test('confirmed-empty series are filtered while unknown availability and films remain', () => {
	const seed = makeItem({ Genres: ['Drama'] });
	const series = makeItem({ Name: 'Maybe empty show', Type: 'Series', Genres: ['Drama'] });
	const film = makeItem({ Name: 'Always a film', Type: 'Movie', Genres: ['Drama'] });
	const all = [seed, series, film];
	const withoutEvidence = buildSimilarTitles({ seed, items: all });
	assert.equal(withoutEvidence.length, 2, 'unknown availability must not hide a series');
	const knownEmpty = buildSimilarTitles({ seed, items: all, unavailable: new Set([series.Id]) });
	assert.deepEqual(ids(knownEmpty), [film.Id], 'only the confirmed empty series is removed');
});

test('limits are bounded to 4-12 and empty catalogues fail safe', () => {
	assert.equal(similarLimit(undefined), SIMILAR_DEFAULT_LIMIT);
	assert.equal(similarLimit('8'), 8);
	assert.equal(similarLimit(1), SIMILAR_MIN_LIMIT);
	assert.equal(similarLimit(99), SIMILAR_MAX_LIMIT);
	assert.equal(similarLimit('not-a-number'), SIMILAR_DEFAULT_LIMIT);

	const seed = makeItem({ Genres: ['Drama'] });
	assert.deepEqual(buildSimilarTitles({ seed, items: [] }), []);
	const noMetadata = makeItem({ Genres: [] });
	assert.deepEqual(buildSimilarTitles({ seed: noMetadata, items: [makeItem({ Genres: ['Drama'] })] }), []);
	assert.ok(Array.isArray(rankSimilarCandidates({ seed, items: [makeItem({ Genres: ['Drama'] })] })), 'ranking is synchronous and needs no provider calls');
});

test('a 45k catalogue stays bounded and returns at most the limit', { timeout: 30000 }, () => {
	const seed = makeItem({ Name: 'Large seed', Genres: ['Documentary'] });
	const items = [seed];
	for (let index = 0; index < 45000; index += 1) {
		items.push({
			Id: `42000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
			Name: 'Large title ' + index,
			Type: index % 4 === 0 ? 'Series' : 'Movie',
			Source: index % 3 === 0 ? 'local' : 'streamed',
			Genres: [GENRES[index % GENRES.length], GENRES[(index * 7) % GENRES.length]].filter((value, position, list) => list.indexOf(value) === position),
			ProductionYear: 1960 + (index % 66),
			ProviderIds: { Tmdb: String(900000 + index) },
			Ratings: [{ source: 'Viewer score', value: 5 + (index % 50) / 10, max: 10, votes: 50 + (index % 500) }],
			UserData: index % 17 === 0 ? { Played: true } : {}
		});
	}
	const started = performance.now();
	const results = buildSimilarTitles({ seed, items, limit: 12 });
	const elapsed = performance.now() - started;
	assert.ok(elapsed < 5000, `45k catalogue took ${elapsed.toFixed(0)}ms`);
	assert.equal(results.length, 12);
	assert.ok(results.every(item => item.Type === 'Movie' || item.Type === 'Series'));
	assert.ok(results.every(item => (item.Genres || []).includes('Documentary')), 'only seed-relevant titles are returned');
	assert.ok(!ids(results).includes(seed.Id));
	assert.ok(JSON.stringify(results).length < 32 * 1024, 'the response stays small');
});
