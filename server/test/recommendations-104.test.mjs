/* Release 104 black-box contract checks for personalised Home recommendations.
 *
 * These tests only use the public buildHomeFeed response and the existing
 * exported helpers. They do not read implementation internals, start a
 * server, use a network or touch production data. Every title below is a
 * synthetic fixture.
 *
 * The release adds a stable per-viewer seed and a six-hour recommendation
 * window. A viewer seed is derived from that viewer's own context, so two
 * viewers with different taste, favourites or history must not share a
 * selection and the seed must never be part of the response.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHomeFeed, diverseHome, homeItemKey, homeVisibleItems, seriesResumeTarget, viewerHomeContext } from '../home-feed.mjs';

const HOUR = 60 * 60 * 1000;
const WINDOW = 6 * HOUR;
// 15:17:23 UTC is safely inside a six-hour block for the time zones used by
// this project. One second later must not cross a window boundary.
const WINDOW_START = Date.UTC(2026, 10, 8, 15, 17, 23);
const GENRES = ['Documentary', 'Crime', 'Comedy', 'Drama', 'Action', 'Adventure', 'Science Fiction', 'Fantasy', 'Family', 'Animation', 'History', 'Mystery', 'Thriller', 'Horror', 'Romance', 'Music'];

let sequence = 0;

function makeItem(overrides = {}) {
	sequence += 1;
	const index = sequence;
	const id = `20000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
	return {
		Id: id,
		Name: `Fixture title ${index}`,
		Type: 'Movie',
		Source: 'local',
		Genres: [GENRES[index % GENRES.length]],
		ProductionYear: 2000 + (index % 24),
		DateCreated: new Date(Date.UTC(2019, index % 12, (index % 27) + 1)).toISOString(),
		PremiereDate: new Date(Date.UTC(2000 + (index % 24), index % 12, (index % 27) + 1)).toISOString(),
		ProviderIds: { Tmdb: String(700000 + index) },
		Ratings: [{ source: 'Viewer score', value: 7, max: 10, votes: 1000 }],
		Artwork: '/art/' + id,
		UserData: {},
		...overrides
	};
}

function rating(value, votes = 1000) {
	return [{ source: 'Viewer score', value, max: 10, votes }];
}

function rotationCatalogue() {
	const items = [];
	for (let index = 0; index < 12; index += 1) {
		items.push(makeItem({
			Name: 'Top title ' + String(index + 1).padStart(2, '0'),
			Type: index % 2 ? 'Series' : 'Movie',
			Genres: [GENRES[index]],
			Ratings: rating(9.5),
			DateCreated: new Date(Date.UTC(2024, 0, index + 1)).toISOString()
		}));
	}
	for (let index = 0; index < 288; index += 1) {
		items.push(makeItem({
			Name: 'Catalogue title ' + String(index + 1).padStart(3, '0'),
			Type: index % 3 ? 'Movie' : 'Series',
			Genres: [GENRES[index % GENRES.length]],
			Ratings: rating(9),
			DateCreated: new Date(Date.UTC(2023, index % 12, (index % 27) + 1)).toISOString()
		}));
	}
	return items;
}

const ROTATION = rotationCatalogue();
const GLOBAL_TOP_12 = ROTATION.slice(0, 12).map(item => item.Id);

function row(feed, id) {
	return (feed.rows || []).find(entry => entry.id === id);
}

function ids(rowValue) {
	return (rowValue?.items || []).map(item => item.Id);
}

function forYouIds(feed) {
	return ids(row(feed, 'for-you'));
}

function emittedIds(feed) {
	return [...(feed.rows || []).flatMap(entry => entry.items || []), ...(feed.featured || [])].map(item => item.Id);
}

function assertUniqueRails(feed) {
	for (const entry of feed.rows || []) {
		const keys = (entry.items || []).map(item => homeItemKey(item));
		assert.equal(new Set(keys).size, keys.length, 'row ' + entry.id + ' repeats an item');
	}
	const featured = (feed.featured || []).map(item => homeItemKey(item));
	assert.equal(new Set(featured).size, featured.length, 'featured repeats an item');
}

function assertResponseShape(feed, now) {
	assert.deepEqual(Object.keys(feed).sort(), ['coldStart', 'featured', 'generatedAt', 'personalized', 'rows'].sort());
	assert.equal(feed.generatedAt, new Date(now).toISOString());
	assert.ok(Array.isArray(feed.rows) && feed.rows.length <= 12, 'rows stay bounded');
	assert.ok(Array.isArray(feed.featured) && feed.featured.length <= 5, 'featured stays bounded');
	for (const entry of feed.rows) {
		assert.deepEqual(Object.keys(entry).sort(), ['id', 'items', 'note', 'title'].sort());
		assert.ok(Array.isArray(entry.items) && entry.items.length <= 12, 'row ' + entry.id + ' stays bounded');
	}
}

function assertNoSeed(feed) {
	const keys = new Set();
	const walk = value => {
		if (Array.isArray(value)) { value.forEach(walk); return; }
		if (!value || typeof value !== 'object') return;
		for (const [key, next] of Object.entries(value)) { keys.add(key); walk(next); }
	};
	walk(feed);
	assert.deepEqual([...keys].filter(key => /seed/i.test(key)), [], 'no response field may expose a recommendation seed');
	const serialized = JSON.stringify(feed);
	assert.ok(!/"(?:seed|viewerSeed|seedKey|recommendationSeed)"\s*:/i.test(serialized), 'the response body must not contain a seed field');
}

// Two equally valid viewers with different, explicitly supplied contexts.
// Their seeds come from their own taste, favourites and history, so the
// response must not contain the derived seed or either viewer marker.
const VIEWER_A_CONTEXT = {
	taste: { genres: [{ name: 'Documentary', weight: 4 }, { name: 'Drama', weight: 2 }], exclude: [] },
	favourites: [ROTATION[12].Id, ROTATION[13].Id],
	history: [{ itemId: 'history-viewer-a', genres: ['Documentary'], position: 60, completed: false, updated: 10 }]
};
const VIEWER_B_CONTEXT = {
	taste: { genres: [{ name: 'Comedy', weight: 4 }, { name: 'Action', weight: 2 }], exclude: [] },
	favourites: [ROTATION[24].Id, ROTATION[25].Id],
	history: [{ itemId: 'history-viewer-b', genres: ['Comedy'], position: 60, completed: false, updated: 10 }]
};

test('same window is stable and the next six-hour window changes the for-you picks', () => {
	const base = { items: ROTATION, now: WINDOW_START };
	const first = buildHomeFeed(base);
	const repeat = buildHomeFeed({ ...base });
	assert.deepEqual(first, repeat, 'the same now value must produce identical rows and items');
	assertResponseShape(first, WINDOW_START);
	assertUniqueRails(first);

	const within = buildHomeFeed({ ...base, now: WINDOW_START + 1000 });
	assert.notEqual(within.generatedAt, first.generatedAt, 'generatedAt must still reflect the request time');
	assert.deepEqual(first.rows, within.rows, 'picks must stay stable within one six-hour window');
	assert.deepEqual(first.featured, within.featured, 'featured picks must stay stable within one six-hour window');

	const next = buildHomeFeed({ ...base, now: WINDOW_START + WINDOW });
	assertResponseShape(next, WINDOW_START + WINDOW);
	assertUniqueRails(next);
	const before = forYouIds(first);
	const after = forYouIds(next);
	assert.equal(before.length, 12, 'a full catalogue should fill the for-you rail');
	assert.equal(after.length, 12, 'a full catalogue should fill the for-you rail');
	assert.notDeepEqual(after, before, 'the next window must change the for-you selection, not only its order');
	const shared = before.filter(id => after.includes(id)).length;
	const changed = before.filter(id => !after.includes(id)).length;
	const union = new Set([...before, ...after]).size;
	assert.ok(changed >= 3, `meaningful overlap reduction expected, only ${changed} of 12 picks changed`);
	assert.ok(shared <= 9, `the next window reused ${shared} of 12 picks`);
	assert.ok(shared / union <= 0.6, `the next window overlap is too high (Jaccard ${(shared / union).toFixed(2)})`);

	assert.deepEqual(ids(row(first, 'top')), GLOBAL_TOP_12, 'top stays the top-rated titles');
	const windows = [];
	for (let index = 0; index < 8; index += 1) {
		const feed = buildHomeFeed({ ...base, now: WINDOW_START + index * WINDOW });
		windows.push(feed);
		assert.deepEqual(ids(row(feed, 'top')), GLOBAL_TOP_12, 'top stays top-rated in every window');
	}
	const picked = new Set(windows.flatMap(feed => forYouIds(feed)));
	assert.ok(picked.size > 12, 'personalised picks must explore beyond one fixed twelve-title set');
	assert.ok([...picked].some(id => !GLOBAL_TOP_12.includes(id)), 'some picks must come from outside the global top twelve');
});

test('different viewers get different same-window picks and no seed reaches the client', () => {
	const base = { items: ROTATION, now: WINDOW_START };
	const first = buildHomeFeed({ ...base, ...VIEWER_A_CONTEXT });
	const firstAgain = buildHomeFeed({ ...base, ...VIEWER_A_CONTEXT });
	const second = buildHomeFeed({ ...base, ...VIEWER_B_CONTEXT });
	assert.deepEqual(firstAgain, first, 'one viewer in one window must get a stable selection');
	assertResponseShape(first, WINDOW_START);
	assertResponseShape(second, WINDOW_START);
	assertUniqueRails(first);
	assertUniqueRails(second);
	assert.equal(first.personalized, true);
	assert.equal(second.personalized, true);
	const before = forYouIds(first);
	const after = forYouIds(second);
	assert.equal(before.length, 12);
	assert.equal(after.length, 12);
	assert.notDeepEqual(after, before, 'two viewers in the same window must not receive the same for-you selection');
	assert.ok(before.filter(id => !after.includes(id)).length >= 1, 'viewer contexts must change at least one pick');
	assertNoSeed(first);
	assertNoSeed(second);
});

test('dislikes, completions and negative genre votes are excluded everywhere', () => {
	const disliked = makeItem({ Name: 'Disliked film', Genres: ['Drama'] });
	const dislikedByProvider = makeItem({ Name: 'Disliked by provider', Genres: ['Comedy'], ProviderIds: { Tmdb: '888001' } });
	const completed = makeItem({ Name: 'Completed film', Genres: ['Action'] });
	const hatedGenre = makeItem({ Name: 'Horror film', Genres: ['Horror'] });
	const liked = makeItem({ Name: 'Liked film', Genres: ['Documentary'] });
	const support = Array.from({ length: 20 }, (_, index) => makeItem({ Name: 'Support title ' + index, Genres: [GENRES[index % GENRES.length]] }));
	const feed = buildHomeFeed({
		items: [disliked, dislikedByProvider, completed, hatedGenre, liked, ...support],
		taste: {
			genres: [{ name: 'Horror', weight: -4 }],
			exclude: [disliked.Id, 'tmdb:movie:' + dislikedByProvider.ProviderIds.Tmdb]
		},
		favourites: [disliked.Id, completed.Id],
		watched: [completed.Id],
		progress: { [disliked.Id]: 700 }
	});
	assertResponseShape(feed, Date.parse(feed.generatedAt));
	assertUniqueRails(feed);
	const emitted = new Set(emittedIds(feed));
	assert.ok(emitted.has(liked.Id), 'an allowed title should still be recommended');
	for (const hidden of [disliked.Id, dislikedByProvider.Id, completed.Id, hatedGenre.Id]) {
		assert.ok(!emitted.has(hidden), 'excluded title ' + hidden + ' leaked into a row or the featured list');
	}
	assert.ok(!ids(row(feed, 'continue')).includes(disliked.Id), 'a dislike must not reappear in Continue watching');
});

test('caller-filtered permissions are respected and favourites cannot reintroduce a hidden title', () => {
	const all = Array.from({ length: 24 }, (_, index) => makeItem({ Name: 'Permission title ' + index, Genres: [GENRES[index % GENRES.length]] }));
	const restricted = all[3];
	const permitted = homeVisibleItems(all, { shared: false, allowed: item => item.Id !== restricted.Id });
	assert.ok(!permitted.some(item => item.Id === restricted.Id));
	assert.equal(homeVisibleItems(all, { shared: true, allowed: () => false }).length, all.length, 'shared home keeps the existing upstream-filter contract');
	const context = viewerHomeContext({ items: permitted, history: [], shared: false });
	const feed = buildHomeFeed({ items: context.items, favourites: [restricted.Id], watched: [], progress: {} });
	assertResponseShape(feed, Date.parse(feed.generatedAt));
	const visibleIds = new Set(permitted.map(item => item.Id));
	const emitted = new Set(emittedIds(feed));
	assert.ok([...emitted].every(id => visibleIds.has(id)), 'the recommendation builder must not invent or restore a filtered title');
	assert.ok(!emitted.has(restricted.Id), 'a favourite cannot bypass the caller permission filter');
});

test('favourites and continue watching are preserved and kept out of recommendation rails', () => {
	const favourites = Array.from({ length: 8 }, (_, index) => makeItem({ Name: 'Favourite title ' + index, Genres: [GENRES[index % GENRES.length]] }));
	const continueItems = Array.from({ length: 6 }, (_, index) => makeItem({
		Name: 'Continue title ' + index,
		Genres: [GENRES[(index + 4) % GENRES.length]],
		UserData: { PlaybackPositionTicks: (120 + index * 120) * 1e7, Played: false }
	}));
	const others = Array.from({ length: 60 }, (_, index) => makeItem({ Name: 'Other title ' + index, Genres: [GENRES[(index + 8) % GENRES.length]] }));
	const feed = buildHomeFeed({
		items: [...favourites, ...continueItems, ...others],
		favourites: favourites.map(item => item.Id),
		watched: [],
		progress: {}
	});
	assertResponseShape(feed, Date.parse(feed.generatedAt));
	assertUniqueRails(feed);
	const continueRow = row(feed, 'continue');
	const favouriteRow = row(feed, 'favourites');
	assert.ok(continueRow, 'Continue watching must remain');
	assert.ok(favouriteRow, 'Your favourites must remain');
	assert.deepEqual(ids(continueRow), [...continueItems].sort((a, b) => Number(b.UserData.PlaybackPositionTicks) - Number(a.UserData.PlaybackPositionTicks)).map(item => item.Id));
	assert.deepEqual(new Set(ids(favouriteRow)), new Set(favourites.map(item => item.Id)));
	const reserved = new Set([...ids(continueRow), ...ids(favouriteRow)]);
	for (const id of ['for-you', 'films', 'series', 'new', 'top']) {
		const picked = ids(row(feed, id));
		assert.ok(picked.every(itemId => !reserved.has(itemId)), 'recommendation rail ' + id + ' repeated a Continue or favourites title');
	}
	const personalised = [];
	for (const id of ['for-you', 'films', 'series', 'genre']) personalised.push(...ids(row(feed, id)));
	assert.equal(new Set(personalised).size, personalised.length, 'personalised rails should not repeat a title when the pool is large enough');
});

test('recent stays chronological and top stays top-rated', () => {
	const recentItems = Array.from({ length: 40 }, (_, index) => makeItem({
		Name: 'Recent title ' + String(index).padStart(2, '0'),
		DateCreated: new Date(Date.UTC(2020, 0, 1) + index * 86400000).toISOString(),
		Ratings: rating(7)
	}));
	const recentFeed = buildHomeFeed({ items: recentItems, watched: [], progress: {} });
	const recentRow = row(recentFeed, 'new');
	assert.ok(recentRow, 'Recently added must remain');
	const recentDates = recentRow.items.map(item => Date.parse(item.DateCreated));
	assert.deepEqual(recentDates, [...recentDates].sort((a, b) => b - a), 'Recently added must stay newest first');
	const expectedRecent = [...recentItems]
		.sort((a, b) => Date.parse(b.DateCreated) - Date.parse(a.DateCreated) || a.Name.localeCompare(b.Name))
		.slice(0, 12)
		.map(item => item.Id);
	assert.deepEqual(ids(recentRow), expectedRecent);

	const ratedItems = Array.from({ length: 40 }, (_, index) => makeItem({
		Name: 'Rated title ' + String(index).padStart(2, '0'),
		Ratings: rating(9.9 - index / 10)
	}));
	const ratedFeed = buildHomeFeed({ items: ratedItems, watched: [], progress: {} });
	const topRow = row(ratedFeed, 'top');
	assert.ok(topRow, 'Top rated must remain');
	const expectedTop = [...ratedItems]
		.sort((a, b) => Number(b.Ratings[0].value) - Number(a.Ratings[0].value) || a.Name.localeCompare(b.Name))
		.slice(0, 12)
		.map(item => item.Id);
	assert.deepEqual(ids(topRow), expectedTop, 'Top rated must stay ordered by rating, not by window or seed');
});

test('cold start and small catalogues stay safe and duplicate-free', () => {
	const cold = buildHomeFeed({ items: ROTATION });
	assertResponseShape(cold, Date.parse(cold.generatedAt));
	assert.equal(cold.personalized, false);
	assert.equal(cold.coldStart, true);
	assert.ok(cold.rows.length >= 3, 'cold start still returns useful rows');
	assert.ok(cold.featured.length > 0, 'cold start still returns featured titles');
	assert.equal(row(cold, 'for-you')?.title, 'Picked for you');
	assertUniqueRails(cold);

	for (const count of [0, 1, 2, 3, 5]) {
		const items = ROTATION.slice(0, count);
		const feed = buildHomeFeed({ items });
		assertResponseShape(feed, Date.parse(feed.generatedAt));
		assertUniqueRails(feed);
		assert.ok(feed.featured.length <= 5);
		const known = new Set(items.map(item => item.Id));
		assert.ok(emittedIds(feed).every(id => known.has(id)), 'small catalogue must not invent titles');
	}
});

test('a 45k catalogue stays bounded in time and response size', { timeout: 30000 }, () => {
	const items = [];
	for (let index = 0; index < 45000; index += 1) {
		items.push({
			Id: `30000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
			Name: 'Large title ' + index,
			Type: index % 4 === 0 ? 'Series' : 'Movie',
			Source: index % 3 === 0 ? 'local' : 'streamed',
			Genres: [GENRES[index % GENRES.length], GENRES[(index * 7) % GENRES.length]].filter((value, position, list) => list.indexOf(value) === position),
			ProductionYear: 1960 + (index % 66),
			DateCreated: new Date(Date.UTC(1960 + (index % 66), index % 12, (index % 27) + 1)).toISOString(),
			ProviderIds: { Tmdb: String(900000 + index) },
			Ratings: rating(5 + (index % 50) / 10, 50 + (index % 500)),
			CommunityRating: 5 + (index % 50) / 10,
			Artwork: '/art/' + index,
			UserData: index % 17 === 0 ? { Played: true } : {}
		});
	}
	const favouriteIds = Array.from({ length: 40 }, (_, index) => items[(index * 4 + 1) % items.length].Id);
	const watched = Array.from({ length: 200 }, (_, index) => items[(index * 9 + 2) % items.length].Id);
	const progress = Object.fromEntries(Array.from({ length: 100 }, (_, index) => [items[(index * 13 + 3) % items.length].Id, 600 + index]));
	const history = Array.from({ length: 500 }, (_, index) => ({
		itemId: items[index % items.length].Id,
		genres: [GENRES[index % GENRES.length]],
		position: 100,
		completed: false,
		updated: index
	}));
	const taste = {
		genres: GENRES.map((name, index) => ({ name, weight: index % 5 - 2 })),
		exclude: Array.from({ length: 50 }, (_, index) => items[(index * 7 + 5) % items.length].Id)
	};
	const options = { items, taste, favourites: favouriteIds, watched, progress, history, now: WINDOW_START };
	const started = performance.now();
	const feed = buildHomeFeed(options);
	const elapsed = performance.now() - started;
	assert.ok(elapsed < 5000, `45k catalogue took ${elapsed.toFixed(0)}ms`);
	assertResponseShape(feed, WINDOW_START);
	assertUniqueRails(feed);
	const bytes = JSON.stringify(feed).length;
	assert.ok(bytes < 2 * 1024 * 1024, `response grew to ${bytes} bytes`);
	const warmStarted = performance.now();
	for (let index = 0; index < 2; index += 1) buildHomeFeed(options);
	const warmAverage = (performance.now() - warmStarted) / 2;
	assert.ok(warmAverage < 5000, `warm 45k catalogue averaged ${warmAverage.toFixed(0)}ms`);
});

test('legacy home-feed helpers and response contract remain compatible', () => {
	assert.equal(homeItemKey({ Type: 'Movie', Name: 'A', ProviderIds: { Tmdb: '9' } }), 'Movie:tmdb:9');
	assert.equal(homeItemKey({ Type: 'Series', Name: 'A', ProviderIds: { Imdb: 'tt123' } }), 'Series:imdb:tt123');
	const pool = [makeItem({ Genres: ['Drama'] }), makeItem({ Genres: ['Drama'] }), makeItem({ Genres: ['Comedy'] })];
	const diverse = diverseHome(pool, 3);
	assert.equal(new Set(diverse.map(item => homeItemKey(item))).size, diverse.length);
	assert.deepEqual(seriesResumeTarget([
		{ itemId: 'episode-a', seriesId: 'series', position: 900, completed: false, updated: 10 },
		{ itemId: 'episode-a', seriesId: 'series', position: 60, completed: false, updated: 30 }
	], 'series'), { itemId: 'episode-a', position: 60, updated: 30 });
	const remote = viewerHomeContext({
		items: [{ Id: 'a', Type: 'Movie', UserData: { Played: true, PlaybackPositionTicks: 999e7 } }],
		history: [{ itemId: 'a', position: 120, updated: 5 }],
		shared: false
	});
	assert.equal(remote.items[0].UserData.Played, false);
	assert.equal(remote.items[0].UserData.PlaybackPositionTicks, 120e7);
	assert.deepEqual(remote.watched, []);
	assert.equal(remote.progress.a, 120);
});
