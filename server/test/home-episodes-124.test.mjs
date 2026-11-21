import test from 'node:test';
import assert from 'node:assert/strict';
import {
	MAX_EPISODES, MAX_SERIES, PER_SERIES_LIMIT,
	createHomeEpisodeLookup, episodeOrder, parseSeriesIds, selectHomeEpisodes
} from '../home-episodes.mjs';
import { recentTvEpisodes } from '../tv-releases.mjs';

const liked = 'a'.repeat(32);
const other = 'b'.repeat(32);
const foreign = 'c'.repeat(32);
const hexId = value => value.toString(16).padStart(32, '0');
const episode = (id, series, season, number, date, extra = {}) => ({
	Id: id, Type: 'Episode', Name: `${series} S${season}E${number}`, SeriesId: series,
	SeriesName: `Show ${series.slice(0, 4)}`, ParentIndexNumber: season, IndexNumber: number,
	PremiereDate: date, RunTimeTicks: 1800e7, ImageTags: { Primary: 'tag-' + id }, ...extra
});

test('series input is an explicit, bounded id list and never a URL or provider path', () => {
	assert.deepEqual(parseSeriesIds(undefined), { ids: [] });
	assert.deepEqual(parseSeriesIds(''), { ids: [] });
	assert.deepEqual(parseSeriesIds(`${liked},${other}`), { ids: [liked, other] });
	assert.deepEqual(parseSeriesIds(` ${liked} , ${liked} ,dispatch-series-7`), { ids: [liked, 'dispatch-series-7'] });
	for (const value of ['not-an-id', 'http://example.test/show', `https://example.test?a=${liked}`, `${liked},`, `${liked},,${other}`]) {
		assert.ok(parseSeriesIds(value).error, 'malformed input must be rejected: ' + value);
	}
	assert.ok(parseSeriesIds([liked]).error, 'a repeated query value must not be accepted');
	const fifty = Array.from({ length: MAX_SERIES }, (_, index) => hexId(index + 1));
	assert.equal(parseSeriesIds(fifty.join(',')).ids.length, MAX_SERIES);
	assert.ok(parseSeriesIds([...fifty, hexId(MAX_SERIES + 1)].join(',')).error, 'more than 50 ids is rejected');
});

test('real episodes of the requested series only, deduplicated and newest first', () => {
	const items = [
		{ seriesId: liked, items: [
			episode('liked-3', liked, 2, 3, '2026-10-03T00:00:00Z'),
			episode('liked-1', liked, 2, 1, '2026-10-01T00:00:00Z'),
			episode('liked-2', liked, 2, 2, '2026-10-02T00:00:00Z'),
			episode('liked-1', liked, 2, 1, '2026-10-01T00:00:00Z')
		] },
		{ seriesId: other, items: [
			episode('other-2', other, 1, 2, '2026-10-02T00:00:00Z'),
			episode('other-1', other, 1, 1, '2026-10-01T00:00:00Z'),
			episode('foreign-1', foreign, 1, 1, '2026-10-04T00:00:00Z')
		] }
	];
	const result = selectHomeEpisodes(items, { now: Date.parse('2026-11-17T00:00:00Z') });
	assert.deepEqual(result.map(item => item.Id), ['liked-3', 'liked-2', 'other-2', 'liked-1', 'other-1']);
	assert.equal(new Set(result.map(item => item.Id)).size, result.length);
	assert.ok(result.every(item => [liked, other].includes(item.SeriesId)));
	assert.ok(result.every(item => /^Show /.test(item.SeriesName)), 'the real series name is preserved');
	assert.deepEqual(result, selectHomeEpisodes(items, { now: Date.parse('2026-11-17T00:00:00Z') }), 'order is stable');
	assert.deepEqual(selectHomeEpisodes([], { now: Date.now() }), []);
});

test('missing, unaired, future, virtual and undated episodes stay truthful', () => {
	const now = Date.parse('2026-11-17T00:00:00Z');
	const result = selectHomeEpisodes([{ seriesId: liked, items: [
		episode('real', liked, 1, 1, '2026-10-01T00:00:00Z'),
		episode('missing', liked, 1, 2, '2026-10-02T00:00:00Z', { IsMissing: true }),
		episode('unaired', liked, 1, 3, '2026-10-03T00:00:00Z', { IsUnaired: true }),
		episode('future', liked, 1, 4, '2027-01-01T00:00:00Z'),
		episode('virtual', liked, 1, 5, '2026-10-05T00:00:00Z', { IsVirtualItem: true }),
		episode('undated', liked, 1, 6, undefined)
	] }], { now });
	assert.deepEqual(result.map(item => item.Id), ['real', 'undated']);
});

test('per-series and total limits are bounded and an unnamed relation is skipped', () => {
	const many = Array.from({ length: PER_SERIES_LIMIT + 10 }, (_, index) =>
		episode(`e-${index}`, liked, 1, index + 1, new Date(Date.UTC(2026, 0, 1) + index * 3600000).toISOString()));
	const result = selectHomeEpisodes([{ seriesId: liked, items: many }], { now: Date.parse('2027-01-01T00:00:00Z') });
	assert.equal(result.length, PER_SERIES_LIMIT);
	const two = [
		{ seriesId: liked, items: many },
		{ seriesId: other, items: many.map(item => ({ ...item, Id: 'o-' + item.Id, SeriesId: other })) }
	];
	assert.equal(selectHomeEpisodes(two, { now: Date.parse('2027-01-01T00:00:00Z') }).length, MAX_EPISODES);
	assert.equal(selectHomeEpisodes(two, { now: Date.parse('2027-01-01T00:00:00Z'), limit: 5 }).length, 5);
	const unnamed = selectHomeEpisodes([{ seriesId: liked, items: [{ ...episode('no-name', liked, 1, 1, '2026-10-01'), SeriesName: '' }] }]);
	assert.deepEqual(unnamed, [], 'no series name is invented');
	const fallback = selectHomeEpisodes([{ seriesId: liked, seriesName: 'Known show', items: [{ ...episode('named', liked, 1, 1, '2026-10-01'), SeriesName: undefined }] }]);
	assert.equal(fallback[0].SeriesName, 'Known show');
});

test('premiere order falls back to season, episode and id without instability', () => {
	const same = '2026-10-01T00:00:00Z';
	const rows = [
		episode('a', liked, 2, 1, same),
		episode('b', liked, 1, 9, same),
		episode('c', liked, 2, 2, same)
	];
	assert.deepEqual(rows.slice().sort(episodeOrder).map(item => item.Id), ['c', 'a', 'b']);
	const undated = [episode('x', liked, 1, 1, undefined), episode('y', liked, 1, 2, same)];
	assert.deepEqual(undated.slice().sort(episodeOrder).map(item => item.Id), ['y', 'x']);
});

// The reported local profile: a liked show with real, unwatched episodes that
// is absent from the /api/web/releases/tv shelf. The shelf reads the newest 500
// Jellyfin episodes, keeps one episode per show and then only the newest 20
// shows. A show that last aired eight months ago is crowded out even though its
// episodes are within the one-year window and are real.
test('root cause: the recently released shelf cannot carry every liked show', () => {
	const now = new Date('2026-11-17T12:00:00Z');
	const day = 86400000;
	const shows = Array.from({ length: 30 }, (_, index) => `show-${index}`);
	const recent = [];
	for (let dayOffset = 1; dayOffset <= 300; dayOffset++) {
		for (let slot = 0; slot < 2; slot++) {
			const show = shows[(dayOffset * 2 + slot) % shows.length];
			recent.push(episode(`recent-${dayOffset}-${slot}`, show, 1, dayOffset,
				new Date(now - dayOffset * day).toISOString(), { LocationType: 'FileSystem' }));
		}
	}
	const likedEpisodes = Array.from({ length: 6 }, (_, index) => episode(
		`liked-${index}`, liked, 2, index + 1, new Date(now - (250 + index * 7) * day).toISOString(),
		{ LocationType: 'FileSystem' }));
	const all = [...recent, ...likedEpisodes];
	const top500 = all.slice().sort((a, b) => Date.parse(b.PremiereDate) - Date.parse(a.PremiereDate)).slice(0, 500);
	const shelf = recentTvEpisodes(top500, now, 20);
	assert.equal(shelf.length, 20);
	assert.equal(shelf.some(item => item.SeriesId === liked), false, 'the liked show is crowded out of the shelf');
	assert.equal(top500.some(item => item.SeriesId === liked), false, 'Jellyfin limit 500 already excluded it');

	const endpoint = selectHomeEpisodes([{ seriesId: liked, items: likedEpisodes }], { now: now.valueOf() });
	assert.deepEqual(endpoint.map(item => item.Id), ['liked-0', 'liked-1', 'liked-2', 'liked-3', 'liked-4', 'liked-5']);
	assert.ok(endpoint.every(item => item.SeriesId === liked));
	assert.ok(likedEpisodes.every(item => now - Date.parse(item.PremiereDate) < 366 * day), 'all are inside the release window');
});

test('root cause: the shelf keeps one episode per show, so a watched newest episode hides the rest', () => {
	const now = new Date('2026-11-17T12:00:00Z');
	const likedEpisodes = Array.from({ length: 6 }, (_, index) => episode(
		`liked-${index}`, liked, 2, index + 1, new Date(now - (30 + index * 7) * 86400000).toISOString(),
		{ LocationType: 'FileSystem' }));
	const shelf = recentTvEpisodes(likedEpisodes, now, 20);
	assert.deepEqual(shelf.map(item => item.Id), ['liked-0'], 'the shelf only ever carries the newest episode of a show');
	const endpoint = selectHomeEpisodes([{ seriesId: liked, items: likedEpisodes }], { now: now.valueOf() });
	assert.equal(endpoint.length, 6, 'the client can filter one finished episode and still see the other five');
});

test('root cause: a real episode older than one year is absent from the shelf but not invented by the endpoint', () => {
	const now = new Date('2026-11-17T12:00:00Z');
	const old = episode('old', liked, 1, 1, '2025-01-01T00:00:00Z', { LocationType: 'FileSystem' });
	assert.deepEqual(recentTvEpisodes([old], now, 20), []);
	assert.deepEqual(selectHomeEpisodes([{ seriesId: liked, items: [old] }], { now: now.valueOf() }).map(item => item.Id), ['old']);
});

test('lookup asks one bounded ParentId episode query per local series and never scans the library', async () => {
	const routes = [];
	const items = {
		[liked]: [episode('l-1', liked, 1, 1, '2026-10-01')],
		[other]: [episode('o-1', other, 1, 1, '2026-10-02')]
	};
	const lookup = createHomeEpisodeLookup({
		userId: 'user-1', timeoutMs: 1000,
		jelly: async route => {
			routes.push(route);
			const params = new URL(route, 'http://fixture').searchParams;
			return { Items: items[params.get('ParentId')] || [] };
		},
		library: { episodes: async () => ({ items: [] }) }
	});
	const result = await lookup([liked, other, liked]);
	assert.deepEqual(result.map(item => item.Id), ['o-1', 'l-1']);
	assert.equal(routes.length, 2, 'duplicate ids cost one lookup');
	for (const route of routes) {
		const params = new URL(route, 'http://fixture').searchParams;
		assert.equal(params.get('IncludeItemTypes'), 'Episode');
		assert.equal(params.get('Recursive'), 'true');
		assert.equal(params.get('IsMissing'), 'false');
		assert.equal(params.get('IsUnaired'), 'false');
		assert.equal(params.get('Limit'), String(PER_SERIES_LIMIT));
		assert.ok(params.get('ParentId'), 'every query is scoped to one requested series');
	}
});

test('lookup merges the streamed catalogue by id and survives one failed source', async () => {
	const lookup = createHomeEpisodeLookup({
		userId: 'user-1', timeoutMs: 500,
		jelly: async route => {
			if (route.includes(encodeURIComponent(liked))) throw new Error('Jellyfin is unavailable');
			return { Items: [episode('shared', other, 1, 1, '2026-10-01')] };
		},
		library: { episodes: async id => ({ items: [
			episode('streamed-1', id, 1, 2, '2026-10-02', { Source: 'streamed' }),
			episode('shared', id, 1, 1, '2026-10-01', { Source: 'streamed' })
		] }) }
	});
	const result = await lookup([liked, 'dispatch-series-9']);
	assert.deepEqual(result.map(item => item.Id), ['streamed-1', 'shared']);
	assert.equal(new Set(result.map(item => item.Id)).size, 2);
	assert.equal(result[0].Source, 'streamed');
});

test('a streamed alias keeps the canonical real series id from the library', async () => {
	const canonical = 'e'.repeat(32);
	const lookup = createHomeEpisodeLookup({
		userId: 'user-1', timeoutMs: 500,
		jelly: async () => ({ Items: [] }),
		library: { episodes: async () => ({ items: [
			episode('alias-1', canonical, 1, 1, '2026-10-01', { Source: 'streamed' })
		] }) }
	});
	const result = await lookup(['dispatch-series-9']);
	assert.equal(result.length, 1);
	assert.equal(result[0].SeriesId, canonical, 'the real merged series id is preserved');
	assert.equal(result[0].SeriesName, 'Show eeee');
});

test('lookup stops at its deadline instead of holding Home open', async () => {
	const lookup = createHomeEpisodeLookup({
		userId: 'user-1', timeoutMs: 60, concurrency: 2,
		jelly: () => new Promise(() => {}),
		library: { episodes: () => new Promise(() => {}) }
	});
	const started = Date.now();
	const result = await lookup([liked, other, 'dispatch-series-9']);
	assert.deepEqual(result, []);
	assert.ok(Date.now() - started < 1500, 'the lookup must not wait for the full upstream timeout');
});
