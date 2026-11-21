import test from 'node:test';
import assert from 'node:assert/strict';
import { buildHomeFeed, diverseHome, homeItemKey, homeVisibleItems, seriesResumeTarget, viewerHomeContext } from '../home-feed.mjs';

const item = (id, name, type, genres, extra = {}) => ({
	Id: id, Name: name, Type: type, Source: 'local', Genres: genres, Artwork: '/art/' + id,
	ProviderIds: { Tmdb: String(id.match(/\d+/)?.[0] || 1) }, UserData: {}, ...extra,
});

const items = [
	item('local-film-1', 'Deep Water', 'Movie', ['Documentary'], { ProviderIds: { Tmdb: '101' }, DateCreated: '2026-11-01T00:00:00Z', Ratings: [{ source: 'Viewer score', value: 8, max: 10, votes: 500 }] }),
	item('local-film-2', 'Night Beat', 'Movie', ['Crime'], { ProviderIds: { Tmdb: '102' }, Ratings: [{ source: 'Viewer score', value: 7, max: 10, votes: 300 }] }),
	item('local-series-1', 'Wild Places', 'Series', ['Documentary'], { ProviderIds: { Tmdb: '103' }, DateCreated: '2026-10-20T00:00:00Z' }),
	item('local-series-2', 'City Desk', 'Series', ['Drama'], { ProviderIds: { Tmdb: '104' } }),
	item('streamed-film-1', 'Deep Water', 'Movie', ['Documentary'], { Source: 'streamed', Provider: 'Dispatcharr', ProviderIds: { Tmdb: '101' } }),
	item('local-film-3', 'Unwatched Comedy', 'Movie', ['Comedy'], { ProviderIds: { Tmdb: '105' } }),
	item('local-film-4', 'Continue Me', 'Movie', ['Drama'], { ProviderIds: { Tmdb: '106' }, UserData: { PlaybackPositionTicks: 900e7, Played: false } }),
];

test('ranks and diversifies playable local and streamed items without duplicates', () => {
	const feed = buildHomeFeed({ items, taste: { genres: [{ name: 'Documentary', weight: 8 }, { name: 'Crime', weight: -4 }], exclude: [] }, favourites: ['local-series-1'], watched: ['local-film-3'] });
	assert.equal(feed.personalized, true);
	const forYou = feed.rows.find(row => row.id === 'for-you');
	assert.equal(forYou.items.filter(entry => entry.Name === 'Deep Water').length, 1, 'the local and streamed copy of one title must not both appear in a row');
	assert.ok(feed.rows.every(row => new Set(row.items.map(entry => entry._key)).size === row.items.length));
	assert.ok(feed.rows.find(row => row.id === 'continue').items.some(entry => entry.Name === 'Continue Me'));
	assert.ok(feed.rows.every(row => row.items.every(entry => entry.Name !== 'Unwatched Comedy')), 'watched titles are excluded');
	assert.ok(feed.rows.every(row => row.items.every(entry => entry.Name !== 'Night Beat')), 'a disliked genre is excluded');
	const top = feed.rows.find(row => row.id === 'for-you');
	assert.ok(top && top.items.length > 0);
	assert.ok(top.items.some(entry => entry.Name === 'Deep Water'));
	assert.ok(feed.featured.length <= 5 && feed.featured.every(entry => entry.Artwork || entry.Source === 'local'));
});

test('diversifies a row without repeating an episode or title', () => {
	const pool = [item('a1', 'A', 'Series', ['Drama']), item('a2', 'B', 'Series', ['Drama']), item('a3', 'C', 'Series', ['Drama']), item('a4', 'D', 'Movie', ['Comedy']), item('a5', 'E', 'Movie', ['Comedy']), item('a6', 'F', 'Movie', ['Comedy'])];
	const result = diverseHome(pool, 6);
	assert.equal(new Set(result.map(entry => entry._key)).size, result.length);
	assert.ok(result.filter(entry => entry._genres[0] === 'Drama').length <= 3);
	assert.ok(result.filter(entry => entry._genres[0] === 'Comedy').length <= 3);
});

test('cold start still returns useful rows and never claims personalization', () => {
	const feed = buildHomeFeed({ items: items.filter(entry => entry.Name !== 'Continue Me') });
	assert.equal(feed.personalized, false);
	assert.equal(feed.coldStart, true);
	assert.ok(feed.rows.length >= 3);
	assert.ok(feed.featured.length > 0);
	assert.ok(feed.rows.every(row => new Set(row.items.map(entry => entry._key)).size === row.items.length));
});

test('account context is isolated and does not read another profile state', () => {
	const first = buildHomeFeed({ items, taste: { genres: [{ name: 'Documentary', weight: 5 }], exclude: [] } });
	const second = buildHomeFeed({ items, taste: { genres: [{ name: 'Comedy', weight: 5 }], exclude: [] }, watched: ['local-series-1'], favourites: ['local-film-3'] });
	assert.ok(first.rows.find(row => row.id === 'for-you').items.some(entry => entry.Name === 'Deep Water'));
	assert.ok(second.rows.every(row => row.items.every(entry => entry.Name !== 'Wild Places')));
	const ids = second.rows.flatMap(row => row.items.map(entry => entry.Id));
	assert.ok(ids.includes('local-film-3'));
	assert.notDeepEqual(first.featured.map(entry => entry.Id), second.featured.map(entry => entry.Id));
});

test('catalogue policy filters are applied to remote home rows and skipped only for shared home', () => {
	const items = [{ Id: 'allowed', Type: 'Movie' }, { Id: 'blocked', Type: 'Movie' }];
	assert.deepEqual(homeVisibleItems(items, { allowed: item => item.Id === 'allowed' }).map(item => item.Id), ['allowed']);
	assert.deepEqual(homeVisibleItems(items, { shared: true, allowed: () => false }).map(item => item.Id), ['allowed', 'blocked']);
});

test('shared Jellyfin progress is only used for a local/home view, never a remote caller', () => {
	const shared = viewerHomeContext({ items: [{ Id: 'a', Type: 'Movie', UserData: { Played: true, PlaybackPositionTicks: 999e7 } }], shared: true });
	assert.equal(shared.items[0].UserData.Played, true);
	assert.equal(shared.items[0].UserData.PlaybackPositionTicks, 999e7);
	const remote = viewerHomeContext({
		items: [{ Id: 'a', Type: 'Movie', UserData: { Played: true, PlaybackPositionTicks: 999e7 } }, { Id: 'b', Type: 'Movie', UserData: { PlaybackPositionTicks: 777e7 } }],
		history: [{ itemId: 'a', position: 120, updated: 5 }],
	});
	assert.equal(remote.items[0].UserData.Played, false);
	assert.equal(remote.items[0].UserData.PlaybackPositionTicks, 120e7);
	assert.equal(remote.items[1].UserData, undefined);
	assert.deepEqual(remote.watched, [], 'partial progress is not a confirmed completion');
	assert.equal(remote.progress.a, 120);
});

test('partially watched films resume, finished films are excluded, and episodes stay separate', () => {
	const items = [
		item('film-partial', 'Partial Film', 'Movie', ['Drama']),
		item('film-finished', 'Finished Film', 'Movie', ['Drama']),
		item('series-one', 'Long Series', 'Series', ['Drama']),
	];
	const history = [
		{ itemId: 'film-partial', seriesId: null, position: 120, duration: 7200, completed: false, updated: 30 },
		{ itemId: 'film-finished', seriesId: null, position: 7150, duration: 7200, completed: true, updated: 40 },
		{ itemId: 'episode-old', seriesId: 'series-one', position: 600, duration: 3000, completed: false, updated: 10 },
		{ itemId: 'episode-latest', seriesId: 'series-one', position: 240, duration: 3000, completed: false, updated: 20 },
		{ itemId: 'episode-finished', seriesId: 'series-one', position: 2980, duration: 3000, completed: true, updated: 50 },
	];
	const context = viewerHomeContext({ items, history });
	const byId = new Map(context.items.map(entry => [entry.Id, entry]));
	assert.equal(byId.get('film-partial').UserData.PlaybackPositionTicks, 120e7);
	assert.equal(byId.get('film-partial').UserData.Played, false);
	assert.equal(byId.get('film-finished').UserData.Played, true);
	assert.deepEqual(context.watched.sort(), ['episode-finished', 'film-finished']);
	assert.equal(context.watched.includes('series-one'), false);
	assert.equal(context.progress['film-partial'], 120);
	assert.equal(context.progress['film-finished'], undefined);
	assert.equal(byId.get('series-one').UserData.PlaybackPositionTicks, 240e7, 'the latest in-progress episode sets the label');
	assert.equal(byId.get('series-one').UserData.Played, false, 'a series is never marked watched from episode history');
	assert.equal(byId.get('series-one')._resumeItemId, 'episode-latest');
	assert.equal(context.progress['series-one'], undefined, 'no episode position is copied onto the series id');
	const feed = buildHomeFeed({ items: context.items, history, watched: context.watched, progress: context.progress });
	const continueRow = feed.rows.find(row => row.id === 'continue');
	assert.deepEqual(continueRow.items.map(entry => entry.Id).sort(), ['film-partial', 'series-one']);
	assert.ok(feed.rows.every(row => row.items.every(entry => entry.Id !== 'film-finished')), 'the finished film is excluded everywhere');
	const series = feed.rows.flatMap(row => row.items).find(entry => entry.Id === 'series-one');
	assert.ok(series, 'the series remains a recommendation');
	assert.equal(series._played, false);
});

test('a newer rewind beats an older later position and completed episodes are skipped', () => {
	const history = [
		{ itemId: 'episode-a', seriesId: 'series', position: 900, completed: false, updated: 10 },
		{ itemId: 'episode-a', seriesId: 'series', position: 60, completed: false, updated: 30 },
		{ itemId: 'episode-b', seriesId: 'series', position: 1800, completed: true, updated: 40 },
	];
	assert.deepEqual(seriesResumeTarget(history, 'series'), { itemId: 'episode-a', position: 60, updated: 30 });
	assert.equal(seriesResumeTarget(history, 'other'), null);
});

test('dislikes exclude a title from Continue watching and history adds taste without finishing a series', () => {
	const disliked = 'f'.repeat(32);
	const items = [
		item('film-like', 'Liked Doc', 'Movie', ['Documentary']),
		item(disliked, 'Disliked Drama', 'Movie', ['Drama']),
	];
	const feed = buildHomeFeed({
		items,
		taste: { genres: [], exclude: [disliked] },
		progress: { [disliked]: 900 },
		history: [{ itemId: 'series-history', genres: ['Documentary'], completed: false, position: 60, updated: 5 }],
	});
	const ids = feed.rows.flatMap(row => row.items.map(entry => entry.Id));
	assert.ok(ids.includes('film-like'));
	assert.ok(!ids.includes(disliked), 'a dislike is excluded from Continue too');
	const forYou = feed.rows.find(row => row.id === 'for-you');
	assert.ok(forYou, 'history genres produce a preference row');
	assert.match(forYou.title, /documentary/i);
});

test('home identity key prefers provider ids and falls back without title guessing', () => {
	assert.equal(homeItemKey({ Type: 'Movie', Name: 'A', ProviderIds: { Tmdb: '9' } }), 'Movie:tmdb:9');
	assert.equal(homeItemKey({ Type: 'Series', Name: 'A', ProviderIds: { Imdb: 'tt123' } }), 'Series:imdb:tt123');
	assert.equal(homeItemKey({ Type: 'Movie', Name: ' A ', ProductionYear: 2020 }), 'Movie:name:a:2020');
});
