import test from 'node:test';
import assert from 'node:assert/strict';
import { createHomeContinue, HOME_CONTINUE_LIMIT, MAX_CONTINUE_SERIES } from '../home-continue.mjs';
import { ADMISSION_LIMIT, homeEpisodeAdmissionState } from '../home-episodes.mjs';
import { buildHomeFeed, viewerHomeContext } from '../home-feed.mjs';

const guid = value => value.toString(16).padStart(32, '0');
const seriesId = value => 'dispatch-series-' + value;
const film = (id, name, extra = {}) => ({
	Id: id, Name: name, Type: 'Movie', Source: 'local', Genres: ['Drama'],
	ProviderIds: { Tmdb: String(parseInt(id.slice(-6), 16) + 1) }, RunTimeTicks: 7200e7, Artwork: '/art/' + id, ...extra
});
const series = (id, name, extra = {}) => ({
	Id: id, Name: name, Type: 'Series', Source: 'local', Genres: ['Drama'],
	ProviderIds: { Tmdb: String(parseInt(id.slice(-6), 16) + 1) }, Artwork: '/art/' + id, ...extra
});
const episode = (id, showId, name, season, number, extra = {}) => ({
	Id: id, Name: name, Type: 'Episode', MediaType: 'Video', Source: 'local', SeriesId: showId,
	SeriesName: typeof showId === 'string' && showId.startsWith('dispatch-series-') ? 'Streamed Show' : 'Local Show',
	ParentIndexNumber: season, IndexNumber: number, RunTimeTicks: 2400e7, Genres: ['Drama'],
	PremiereDate: '2026-01-01T00:00:00Z', Artwork: '/art/' + id, ...extra
});
const progress = (itemId, showId, position, updated, extra = {}) => ({
	itemId, seriesId: showId, position, duration: 2400, updated, completed: false, state: 'playing', ...extra
});
const lookupOf = groups => {
	const calls = [];
	const lookup = async (ids, options = {}) => {
		calls.push({ ids: [...ids], deadline: options.deadline });
		return ids.flatMap(id => groups[id] || []);
	};
	return { lookup, calls };
};
// Mirrors the documented POST /api/web/home sequence with the real modules.
async function wiredFeed({ catalogue, history = [], homeHistory = [], clientProgress = {},
	clientWatched = [], clientUpdated = {}, lookup, resolve, allowed = () => true, shared = false, watchedIds = [] }) {
	const context = viewerHomeContext({ items: catalogue, history, shared });
	const result = await createHomeContinue({ lookup, resolve })({
		items: context.items, history, homeHistory, shared, allowed,
		watched: [...watchedIds, ...context.watched],
		clientProgress, clientWatched, clientUpdated, deadline: Date.now() + 2000
	});
	const watched = shared ? [...watchedIds, ...clientWatched, ...context.watched] : [...watchedIds, ...context.watched];
	const feed = buildHomeFeed({
		items: context.items, history, watched,
		progress: shared ? { ...clientProgress, ...result.progress } : context.progress,
		episodeContinue: result.episodes, episodeSeriesIds: result.seriesIds, continueUpdated: result.updates
	});
	return { context, result, feed, row: feed.rows.find(entry => entry.id === 'continue') || { items: [] } };
}

test('local/home browser progress resolves the exact episode when the catalogue has only films and series', async () => {
	const show = guid(0x51), ep = guid(0x5101), filmId = guid(0x5102);
	const catalogue = [series(show, 'Local Detectives'), film(filmId, 'Half Seen Film')];
	const { lookup, calls } = lookupOf({ [show]: [episode(ep, show, 'The Long Night', 2, 3)] });
	const resolved = [];
	const resolve = async id => {
		resolved.push(id);
		return id === ep ? episode(ep, show, 'The Long Night', 2, 3) : null;
	};

	const { result, feed, row } = await wiredFeed({ catalogue, shared: true,
		clientProgress: { [ep]: 137.5, [filmId]: 900 }, resolve, lookup });

	assert.equal(calls.length, 1, 'one bounded series lookup');
	assert.deepEqual(calls[0].ids, [show]);
	assert.deepEqual(resolved, [ep], 'only the non-catalogue progress id is resolved');
	assert.equal(result.availability.status, 'complete');
	assert.equal(result.availability.complete, true);
	assert.equal(result.episodes.length, 1);
	const item = result.episodes[0];
	assert.equal(item.Id, ep, 'the exact episode id is the resume target');
	assert.equal(item.Type, 'Episode');
	assert.equal(item.SeriesId, show);
	assert.equal(item.SeriesName, 'Local Detectives');
	assert.equal(item.ParentIndexNumber, 2);
	assert.equal(item.IndexNumber, 3);
	assert.equal(item.Name, 'The Long Night');
	assert.equal(item.UserData.PlaybackPositionTicks, 1375e6, 'exact browser position, not a rounded minute');
	assert.equal(item.UserData.Played, false);

	const ids = row.items.map(entry => entry.Id);
	assert.ok(ids.includes(ep), 'the exact episode is in Continue watching');
	assert.ok(ids.includes(filmId), 'the partial film keeps its slot');
	assert.ok(!row.items.some(entry => entry.Type === 'Series'), 'no series placeholder');
	assert.equal(row.items.find(entry => entry.Id === ep).UserData.PlaybackPositionTicks, 1375e6);
	assert.ok(feed.rows.every(entry => entry.items.every(value => value.Id !== show || entry.id !== 'continue')));
});

test('local/home episode-only history yields only the exact episode, never a series placeholder', async () => {
	const show = guid(0x52), ep = guid(0x5201);
	const catalogue = [series(show, 'Only Episodes'), film(guid(0x5202), 'Unwatched Film')];
	const now = Date.now();
	const { lookup } = lookupOf({ [show]: [episode(ep, show, 'Solo', 1, 4)] });
	const { result, row } = await wiredFeed({ catalogue, shared: true,
		homeHistory: [progress(ep, show, 300, now)], lookup });

	assert.equal(result.availability.status, 'complete');
	assert.deepEqual(result.episodes.map(item => item.Id), [ep]);
	assert.deepEqual(row.items.map(item => item.Id), [ep]);
	assert.equal(row.items[0].UserData.PlaybackPositionTicks, 300e7);
	assert.ok(row.items.every(item => item.Type === 'Episode'));
});

test('a direct exact Episode item is accepted by home-feed only with its permitted parent', () => {
	const show = guid(0x53), ep = guid(0x5301), filmId = guid(0x5302);
	const direct = episode(ep, show, 'Direct Episode', 1, 2, { UserData: { PlaybackPositionTicks: 240e7, Played: false } });
	const feed = buildHomeFeed({ items: [film(filmId, 'Film', { UserData: { PlaybackPositionTicks: 120e7 } }), series(show, 'Show'), direct] });
	const row = feed.rows.find(entry => entry.id === 'continue');
	assert.deepEqual(row.items.map(item => item.Id), [ep, filmId]);
	assert.equal(row.items[0].Type, 'Episode');
	assert.equal(row.items[0].Name, 'Direct Episode');
	assert.equal(row.items[0].ParentIndexNumber, 1);
	assert.equal(row.items[0].UserData.PlaybackPositionTicks, 240e7);
	assert.equal(row.items[0].SeriesId, show);
	assert.ok(feed.rows.filter(entry => entry.id !== 'continue').every(entry => entry.items.every(item => item.Type !== 'Episode')));
	// An episode whose parent is not in the permitted catalogue is not admitted.
	const orphan = buildHomeFeed({ items: [film(filmId, 'Film'), { ...direct, SeriesId: guid(0xffff) }] });
	assert.ok(!(orphan.rows.find(entry => entry.id === 'continue')?.items || []).some(item => item.Type === 'Episode'));
});

test('latest event wins: a newer rewind beats an older larger position and client timestamps are respected', async () => {
	const show = guid(0x54), ep = guid(0x5401);
	const catalogue = [series(show, 'Rewind Show')];
	const { lookup } = lookupOf({ [show]: [episode(ep, show, 'Rewind', 1, 1)] });
	const helper = createHomeContinue({ lookup });

	const newerClient = await helper({ items: catalogue, shared: true,
		homeHistory: [progress(ep, show, 600, 1000)],
		clientProgress: { [ep]: 60 }, clientUpdated: { [ep]: 2000 },
		deadline: Date.now() + 2000 });
	assert.equal(newerClient.episodes[0].UserData.PlaybackPositionTicks, 600e6,
		'a newer 60s rewind beats the older 600s position');

	const newerServer = await helper({ items: catalogue, shared: true,
		homeHistory: [progress(ep, show, 600, 3000)],
		clientProgress: { [ep]: 60 }, clientUpdated: { [ep]: 2000 },
		deadline: Date.now() + 2000 });
	assert.equal(newerServer.episodes[0].UserData.PlaybackPositionTicks, 6000e6,
		'the older client value cannot win against a newer server event');

	const completed = await helper({ items: catalogue, shared: true,
		homeHistory: [
			progress(ep, show, 300, 1000),
			progress(ep, show, 2400, 3000, { completed: true })
		],
		clientProgress: { [ep]: 60 }, clientUpdated: { [ep]: 2000 },
		deadline: Date.now() + 2000 });
	assert.deepEqual(completed.episodes, [], 'a newer completion removes the older partial progress');
});

test('recent short episode ranks ahead of an old long film without losing the film', async () => {
	const show = guid(0x55), ep = guid(0x5501), filmId = guid(0x5502);
	const now = Date.now();
	const catalogue = [series(show, 'Short Show'), film(filmId, 'Long Old Film')];
	const { lookup } = lookupOf({ [show]: [episode(ep, show, 'Short', 1, 1)] });
	const { result, row, feed } = await wiredFeed({ catalogue, shared: true,
		homeHistory: [
			progress(ep, show, 30, now - 100),
			progress(filmId, undefined, 5400, now - 50000, { duration: 7200 })
		],
		lookup });

	assert.deepEqual(row.items.map(item => item.Id), [ep, filmId],
		'recency of the latest event orders the row, not elapsed seconds');
	assert.equal(row.items[0]._resume, 30);
	assert.equal(row.items[1]._resume, 5400);
	assert.equal(result.availability.resolved, 1);
	assert.equal(feed.rows[0].id, 'continue');
});

test('a streamed merged episode keeps canonical identity and a duplicate local+streamed copy appears once', async () => {
	const show = seriesId(9);
	const localEp = guid(0x5601);
	const streamedEp = 'dispatch-episode-2-9';
	const now = Date.now();
	const catalogue = [series(show, 'Merged Show', { Source: 'streamed', VodIds: [9] })];
	const history = [
		progress(localEp, show, 300, now - 1000),
		progress(streamedEp, show, 100, now)
	];
	const { lookup } = lookupOf({
		[show]: [
			episode(localEp, show, 'Arrival', 2, 9, { SeriesName: 'Stale Name', Artwork: '' }),
			episode(streamedEp, show, 'Arrival', 2, 9, { Source: 'streamed', Provider: 'Dispatcharr',
				Artwork: '/api/web/art/series/9', VodIds: [2] })
		]
	});
	const { result, feed, row } = await wiredFeed({ catalogue, history, lookup });

	assert.equal(result.availability.resolved, 1);
	const item = result.episodes[0];
	assert.equal(result.episodes.length, 1, 'the duplicate local+streamed GUID appears once');
	assert.equal(item.Id, localEp, 'the local copy supplies the exact id and position');
	assert.equal(item.Source, 'local');
	assert.equal(item.UserData.PlaybackPositionTicks, 300e7, 'the local position wins over the streamed copy');
	assert.equal(item.SeriesId, show, 'merged canonical series id');
	assert.equal(item.SeriesName, 'Merged Show', 'merged canonical series name');
	assert.equal(item.ParentIndexNumber, 2);
	assert.equal(item.IndexNumber, 9);
	assert.equal(item.Artwork, '/api/web/art/series/9', 'the streamed child artwork fills the gap');
	assert.equal(row.items.filter(entry => entry.Type === 'Episode').length, 1);
	assert.equal(feed.rows.flatMap(entry => entry.items).filter(entry => entry.Type === 'Episode').length, 1);
});

test('a dispatch alias history parent maps to the merged local catalogue GUID', async () => {
	const canonical = guid(0x57), ep = guid(0x5701);
	const alias = seriesId(42);
	const catalogue = [series(canonical, 'Alias Show', { VodIds: [42] })];
	const { lookup, calls } = lookupOf({ [canonical]: [episode(ep, canonical, 'Merged Child', 3, 1)] });
	const now = Date.now();
	const { result, row } = await wiredFeed({ catalogue, shared: true,
		homeHistory: [progress(ep, alias, 420, now)], lookup });

	assert.deepEqual(calls[0].ids, [canonical], 'the alias is resolved to the catalogue GUID');
	assert.equal(result.episodes[0].SeriesId, canonical);
	assert.equal(result.episodes[0].SeriesName, 'Alias Show');
	assert.equal(result.episodes[0].Id, ep);
	assert.equal(result.episodes[0].UserData.PlaybackPositionTicks, 420e7);
	assert.ok(row.items.some(item => item.Id === ep));
});

test('multiple seasons and duplicate episode numbers keep the right series name and number', async () => {
	const first = guid(0x58), second = guid(0x59);
	const firstS1 = guid(0x5801), firstS2 = guid(0x5802), secondS1 = guid(0x5901);
	const now = Date.now();
	const catalogue = [series(first, 'First Show'), series(second, 'Second Show')];
	const history = [
		progress(firstS1, first, 60, now - 5000),
		progress(firstS2, first, 120, now - 1000),
		progress(secondS1, second, 90, now - 2000)
	];
	const { lookup, calls } = lookupOf({
		[first]: [episode(firstS1, first, 'Pilot', 1, 1), episode(firstS2, first, 'Pilot', 2, 1)],
		[second]: [episode(secondS1, second, 'Pilot', 1, 1)]
	});
	const { result, row } = await wiredFeed({ catalogue, history, lookup });

	assert.equal(calls.length, 1);
	assert.equal(calls[0].ids.length, 2);
	assert.equal(result.episodes.length, 2, 'one recent episode per series');
	const bySeries = new Map(result.episodes.map(item => [item.SeriesId, item]));
	assert.equal(bySeries.get(first).Id, firstS2, 'the newest unfinished season wins inside one series');
	assert.equal(bySeries.get(first).ParentIndexNumber, 2);
	assert.equal(bySeries.get(first).IndexNumber, 1);
	assert.equal(bySeries.get(first).SeriesName, 'First Show');
	assert.equal(bySeries.get(second).SeriesName, 'Second Show');
	assert.equal(bySeries.get(second).ParentIndexNumber, 1);
	assert.deepEqual(row.items.map(item => item.SeriesId).sort(), [first, second].sort(),
		'same episode number in different series does not collide');
	assert.equal(new Set(row.items.map(item => item._key)).size, row.items.length);
});

test('completed, played and ended episodes are excluded and unavailable ones are hidden', async () => {
	const showIds = [0x5a, 0x5b, 0x5c, 0x5d, 0x5e].map(guid);
	const epIds = [0x5a01, 0x5b01, 0x5c01, 0x5d01, 0x5e01].map(guid);
	const [finishedShow, endedShow, playedShow, goneShow, liveShow] = showIds;
	const [finished, ended, played, gone, live] = epIds;
	const now = Date.now();
	const catalogue = [...showIds.map((id, index) => series(id, 'Show ' + index)),
		film(guid(0x5f), 'Partial Film')];
	const history = [
		progress(finished, finishedShow, 2400, now, { completed: true }),
		progress(ended, endedShow, 2400, now, { state: 'ended', duration: 0 }),
		progress(played, playedShow, 200, now),
		progress(gone, goneShow, 90, now - 10),
		progress(live, liveShow, 75, now - 20),
		progress(guid(0x5f), undefined, 600, now - 30)
	];
	const { lookup } = lookupOf({
		[finishedShow]: [episode(finished, finishedShow, 'Finished', 1, 1)],
		[endedShow]: [episode(ended, endedShow, 'Ended', 1, 1)],
		[playedShow]: [episode(played, playedShow, 'Played', 1, 1)],
		[goneShow]: [],
		[liveShow]: [episode(live, liveShow, 'Still Watching', 1, 4)]
	});
	const { result, row } = await wiredFeed({ catalogue, history, lookup, watchedIds: [played] });

	assert.equal(result.availability.status, 'complete');
	assert.equal(result.availability.requested, 2, 'only the two genuinely unfinished candidates were resolved');
	assert.equal(result.availability.missing, 1, 'the unavailable episode is hidden, not invented');
	assert.deepEqual(result.episodes.map(item => item.Id), [live]);
	const ids = row.items.map(item => item.Id);
	assert.ok(ids.includes(live));
	assert.ok(!ids.includes(finished) && !ids.includes(ended) && !ids.includes(played), 'finished playback is excluded');
	assert.ok(!ids.includes(gone) && !ids.includes(goneShow), 'an unavailable episode and its series are hidden');
	assert.ok(ids.includes(guid(0x5f)), 'the unfinished film is untouched');
});

test('remote accounts use only their own history and ignore client progress and watched', async () => {
	const mine = guid(0x61), theirs = guid(0x62);
	const myEp = guid(0x6101), theirEp = guid(0x6201);
	const now = Date.now();
	const catalogue = [series(mine, 'Mine'), series(theirs, 'Theirs')];
	const ownHistory = [progress(myEp, mine, 45, now)];
	const theirHistory = [progress(theirEp, theirs, 600, now)];
	const { lookup, calls } = lookupOf({
		[mine]: [episode(myEp, mine, 'My Episode', 1, 1)],
		[theirs]: [episode(theirEp, theirs, 'Their Episode', 1, 1)]
	});
	const helper = createHomeContinue({ lookup });

	const a = await helper({ items: catalogue, history: ownHistory, deadline: Date.now() + 2000 });
	const b = await helper({ items: catalogue, history: theirHistory, deadline: Date.now() + 2000 });
	assert.deepEqual(a.episodes.map(item => item.Id), [myEp]);
	assert.deepEqual(b.episodes.map(item => item.Id), [theirEp]);
	assert.ok(!b.episodes.some(item => item.Id === myEp), 'account B never sees account A progress');
	assert.ok(!a.episodes.some(item => item.Id === theirEp));

	// Client-supplied data must not seed a remote Continue row.
	const ignored = await helper({ items: catalogue, history: ownHistory,
		clientProgress: { [theirEp]: 9999 }, clientWatched: [myEp], deadline: Date.now() + 2000 });
	assert.deepEqual(ignored.episodes.map(item => item.Id), [myEp], 'remote ignores client progress and client watched');
	assert.deepEqual(calls.at(-1).ids, [mine]);

	// Shared/local history is not used for a remote caller.
	const noHome = await helper({ items: catalogue, history: [],
		homeHistory: [progress(theirEp, theirs, 600, now)], clientProgress: { [theirEp]: 600 },
		deadline: Date.now() + 2000 });
	assert.equal(noHome.availability.status, 'empty');
	assert.deepEqual(noHome.episodes, []);
});

test('parent-disallowed, child-disallowed and guessed forbidden ids cannot hydrate', async () => {
	const visible = guid(0x63), hidden = guid(0x64);
	const visibleEp = guid(0x6301), hiddenEp = guid(0x6401);
	const now = Date.now();
	const catalogue = [series(visible, 'Visible')];
	const lookup = async ids => ids.flatMap(id => id === visible ? [episode(visibleEp, visible, 'Visible Episode', 1, 1)] : []);
	const helper = createHomeContinue({ lookup });

	// A hidden parent is skipped before the lookup.
	const parentDenied = await helper({ items: catalogue,
		history: [progress(hiddenEp, hidden, 120, now)], deadline: Date.now() + 2000 });
	assert.deepEqual(parentDenied.episodes, []);
	assert.equal(parentDenied.availability.queried, 0);
	assert.deepEqual(parentDenied.seriesIds, []);

	// A permitted parent with a denied child is dropped after the lookup.
	const childDenied = await helper({ items: catalogue, history: [progress(visibleEp, visible, 120, now)],
		allowed: item => item.Type !== 'Episode', deadline: Date.now() + 2000 });
	assert.deepEqual(childDenied.episodes, []);
	assert.equal(childDenied.availability.denied, 1);
	assert.deepEqual(childDenied.seriesIds, [visible]);

	// A guessed client progress id whose resolved parent is not permitted
	// never becomes a lookup series or an episode.
	const forbiddenCalls = [];
	const forbidden = await createHomeContinue({
		lookup: async ids => { forbiddenCalls.push([...ids]); return []; },
		resolve: async id => id === hiddenEp ? episode(hiddenEp, hidden, 'Hidden', 1, 1) : null
	})({ items: catalogue, shared: true, clientProgress: { [hiddenEp]: 120 }, deadline: Date.now() + 2000 });
	assert.deepEqual(forbidden.episodes, []);
	assert.deepEqual(forbidden.seriesIds, []);
	assert.deepEqual(forbiddenCalls.at(-1), undefined, 'no lookup ran for the forbidden parent');
});

test('an upstream failure or timeout is partial or failed, never an empty success', async () => {
	const show = guid(0x65), ep = guid(0x6501);
	const catalogue = [series(show, 'Failing Show')];
	const history = [progress(ep, show, 120, Date.now())];
	const call = (lookup, deadline = Date.now() + 2000) => createHomeContinue({ lookup })({
		items: catalogue, history, deadline
	});

	const failed = await call(async () => { throw new Error('upstream down'); });
	assert.equal(failed.availability.status, 'failed');
	assert.equal(failed.availability.reason, 'lookup-error');
	assert.equal(failed.availability.complete, false);
	assert.deepEqual(failed.episodes, []);
	assert.deepEqual(failed.seriesIds, [show], 'the series card is not used as a fallback');

	const slow = await call(() => new Promise(() => {}), Date.now() + 25);
	assert.equal(slow.availability.status, 'partial');
	assert.equal(slow.availability.reason, 'timeout');
	assert.equal(slow.availability.complete, false);
	assert.deepEqual(slow.episodes, []);

	const expired = await call(async () => { throw new Error('must not be called'); }, Date.now() - 1);
	assert.equal(expired.availability.status, 'partial');
	assert.equal(expired.availability.reason, 'deadline');
	assert.equal(expired.availability.complete, false);

	const empty = await createHomeContinue({ lookup: async () => [] })({
		items: catalogue, history: [], deadline: Date.now() + 2000
	});
	assert.equal(empty.availability.status, 'empty');
	assert.equal(empty.availability.complete, true);
});

test('bounded work: many series use one lookup and finish inside the deadline', async () => {
	const now = Date.now();
	const shows = Array.from({ length: 30 }, (_, index) => guid(0x8000 + index));
	const catalogue = shows.map((id, index) => series(id, 'Show ' + index));
	const history = shows.map((id, index) => progress(guid(0x9000 + index), id, 60 + index, now - index * 1000));
	const groups = Object.fromEntries(shows.map((id, index) => [id, [episode(guid(0x9000 + index), id, 'Episode', 1, 1)]]));
	const { lookup, calls } = lookupOf(groups);
	const resolveCalls = [];
	const started = Date.now();
	const result = await createHomeContinue({ lookup, resolve: async id => { resolveCalls.push(id); return null; } })({
		items: catalogue, history, deadline: Date.now() + 2000
	});
	const elapsed = Date.now() - started;

	assert.equal(calls.length, 1, 'one lookup call for the whole row');
	assert.equal(calls[0].ids.length, MAX_CONTINUE_SERIES, 'a bounded series set');
	assert.deepEqual(calls[0].ids, shows.slice(0, MAX_CONTINUE_SERIES), 'newest unfinished progress first');
	assert.equal(result.availability.queried, MAX_CONTINUE_SERIES);
	assert.equal(result.availability.omitted, shows.length - MAX_CONTINUE_SERIES);
	assert.equal(result.availability.resolved, HOME_CONTINUE_LIMIT);
	assert.equal(result.episodes.length, HOME_CONTINUE_LIMIT);
	assert.equal(result.episodes[0].Id, guid(0x9000));
	assert.deepEqual(resolveCalls, [], 'no per-id resolution for known history parents');
	assert.ok(elapsed < 1000, 'bounded work finishes well inside the deadline');

	const feed = buildHomeFeed({ items: catalogue, history, episodeContinue: result.episodes,
		episodeSeriesIds: result.seriesIds, continueUpdated: result.updates });
	assert.equal(feed.rows.find(row => row.id === 'continue').items.length, HOME_CONTINUE_LIMIT);
});

test('a remote client watched id cannot remove a Continue film; server completion still can', () => {
	const filmId = guid(0xb1);
	const items = [film(filmId, 'Partial Film')];
	const clientOnly = buildHomeFeed({ items, progress: { [filmId]: 600 }, watched: [filmId], continueWatched: [] });
	assert.ok((clientOnly.rows.find(row => row.id === 'continue')?.items || []).some(item => item.Id === filmId),
		'a client-supplied watched id is ignored for Continue');
	const serverComplete = buildHomeFeed({ items, progress: { [filmId]: 600 }, watched: [filmId], continueWatched: [filmId] });
	assert.ok(!(serverComplete.rows.find(row => row.id === 'continue')?.items || []).some(item => item.Id === filmId),
		'a server-derived completion still removes it');
});

test('browser progress keeps the scoped home event time, and a browser-only id still uses now', async () => {
	const show = guid(0xb2), ep = guid(0xb201), doneShow = guid(0xb3), doneEp = guid(0xb301);
	const oldFilm = guid(0xb4), clientFilm = guid(0xb5);
	const now = Date.now();
	const catalogue = [series(show, 'Recent Show'), series(doneShow, 'Finished Show'),
		film(oldFilm, 'Old Long Film'), film(clientFilm, 'Browser Only Film')];
	const homeHistory = [
		progress(oldFilm, undefined, 5400, now - 2 * 3600000, { duration: 7200 }),
		progress(ep, show, 30, now),
		progress(doneEp, doneShow, 2400, now - 100, { completed: true })
	];
	const { lookup } = lookupOf({
		[show]: [episode(ep, show, 'Recent Short', 1, 2)],
		[doneShow]: [episode(doneEp, doneShow, 'Finished', 1, 1)]
	});
	const { result, row } = await wiredFeed({ catalogue, shared: true, homeHistory, lookup,
		clientProgress: { [oldFilm]: 5400, [ep]: 30, [doneEp]: 120, [clientFilm]: 100 } });

	const ids = row.items.map(item => item.Id);
	assert.ok(ids.indexOf(ep) >= 0 && ids.indexOf(ep) < ids.indexOf(oldFilm),
		'the episode with the newer server event ranks ahead of the old long film');
	assert.equal(row.items.find(item => item.Id === ep).UserData.PlaybackPositionTicks, 30e7,
		'the episode keeps its exact browser position');
	assert.equal(row.items.find(item => item.Id === oldFilm)._resume, 5400,
		'the old film keeps its larger position but not the top slot');
	assert.ok(ids.includes(clientFilm), 'a browser-only id with no server event is not dropped');
	assert.ok(ids.indexOf(clientFilm) >= 0);
	assert.ok(!ids.includes(doneEp), 'a completed episode is still excluded');
	assert.equal(result.availability.status, 'complete');
});

function tick(ms = 20) {
	return new Promise(resolve => setTimeout(resolve, ms));
}

function hangingResolver() {
	const calls = [], pending = [];
	const resolve = id => new Promise(done => { calls.push(id); pending.push({ id, done }); });
	const release = () => {
		for (const entry of pending.splice(0)) entry.done(null);
	};
	return {
		calls, pending, resolve, release,
		get active() { return homeEpisodeAdmissionState().active; },
		get queued() { return homeEpisodeAdmissionState().queued; }
	};
}

test('the resolver shares one process-wide admission cap and never starts late work', async () => {
	const show = guid(0xd1);
	const items = [series(show, 'Resolver Show')];
	const hung = hangingResolver();
	const lookupCalls = [];
	const lookup = async ids => { lookupCalls.push([...ids]); return []; };
	const helper = createHomeContinue({ lookup, resolve: hung.resolve });
	const now = Date.now();
	const requests = Array.from({ length: 20 }, (_, index) => helper({
		items, shared: true, clientProgress: { [guid(0xd000 + index)]: 30 },
		deadline: now + 120
	}));

	await tick(30);
	assert.ok(hung.calls.length <= ADMISSION_LIMIT, `peak resolver calls ${hung.calls.length} <= ${ADMISSION_LIMIT}`);
	assert.ok(hung.calls.length > 0, 'some resolver work was admitted');
	assert.ok(hung.active <= ADMISSION_LIMIT, 'active stays at the cap');
	assert.ok(hung.queued <= 64, 'the queue stays bounded');

	const results = await Promise.all(requests);
	assert.ok(results.every(result => result.availability.status === 'partial'), 'every timed-out request is partial');
	assert.equal(lookupCalls.length, 0, 'no series lookup ran without a resolved parent');
	const started = hung.calls.length;

	await tick(60);
	assert.equal(hung.calls.length, started, 'no resolver work starts after callers returned');
	hung.release();
	await tick(60);
	assert.equal(hung.calls.length, started, 'expired queued work is never started on drain');
	assert.equal(homeEpisodeAdmissionState().active, 0, 'slots recover after settled work');

	// Recovery: the advisory gate accepts new work after the hung calls settle.
	const freshShow = guid(0xd2), freshEp = guid(0xd201);
	const fresh = createHomeContinue({
		lookup: async ids => ids.flatMap(id => id === freshShow ? [episode(freshEp, freshShow, 'Fresh', 1, 1)] : []),
		resolve: async id => id === freshEp ? episode(freshEp, freshShow, 'Fresh', 1, 1) : null
	});
	const recovered = await fresh({ items: [series(freshShow, 'Fresh Show')], shared: true,
		clientProgress: { [freshEp]: 30 }, deadline: Date.now() + 1000 });
	assert.deepEqual(recovered.episodes.map(item => item.Id), [freshEp]);
	assert.equal(recovered.availability.status, 'complete');
	assert.equal(homeEpisodeAdmissionState().active, 0);
});

test('the resolver slot is held until the real upstream settles, past the caller deadline', async () => {
	const show = guid(0xd3);
	const hung = hangingResolver();
	const helper = createHomeContinue({ lookup: async () => [], resolve: hung.resolve });
	const request = helper({ items: [series(show, 'Held Show')], shared: true,
		clientProgress: { [guid(0xd301)]: 30 }, deadline: Date.now() + 30 });

	const result = await request;
	assert.equal(result.availability.status, 'partial');
	assert.equal(hung.calls.length, 1);
	assert.equal(homeEpisodeAdmissionState().active, 1, 'the slot is still held after the caller returned');
	await tick(60);
	assert.equal(homeEpisodeAdmissionState().active, 1, 'the slot is not released by the caller deadline');
	hung.release();
	await tick(30);
	assert.equal(homeEpisodeAdmissionState().active, 0, 'the slot is released only when the upstream settles');
});

test('fast resolver work waits for a slot and still completes while hung work occupies the cap', async () => {
	const show = guid(0xd4), fastShow = guid(0xd5), fastEp = guid(0xd501);
	const items = [series(show, 'Hung Show'), series(fastShow, 'Fast Show')];
	const hung = hangingResolver();
	const hungHelper = createHomeContinue({ lookup: async () => [], resolve: hung.resolve });
	const ids = [guid(0xd401), guid(0xd402), guid(0xd403), guid(0xd404)];
	const requests = ids.map(id => hungHelper({ items, shared: true, clientProgress: { [id]: 30 },
		deadline: Date.now() + 3000 }));

	await tick(30);
	assert.equal(hung.calls.length, ADMISSION_LIMIT, 'the cap is full of hung work');
	const fastCalls = [];
	const fast = createHomeContinue({
		lookup: async seriesIds => { fastCalls.push([...seriesIds]); return seriesIds.map(id => episode(fastEp, fastShow, 'Fast', 1, 1)); },
		resolve: async id => { fastCalls.push(['resolve', id]); return id === fastEp ? episode(fastEp, fastShow, 'Fast', 1, 1) : null; }
	});
	const fastRequest = fast({ items, shared: true, clientProgress: { [fastEp]: 30 }, deadline: Date.now() + 2000 });
	await tick(30);
	assert.equal(fastCalls.length, 0, 'the fast resolver does not start before admission');

	hung.release();
	const fastResult = await fastRequest;
	assert.deepEqual(fastResult.episodes.map(item => item.Id), [fastEp], 'a freed slot lets fast work complete');
	assert.equal(fastResult.availability.status, 'complete');
	await Promise.all(requests);
	await tick(30);
	assert.equal(homeEpisodeAdmissionState().active, 0, 'all slots recover after release');
});

test('Continue keeps the Home 124 row layout and orders local evidence by recency', async () => {
	const now = Date.now();
	const showA = guid(0xa1), showB = guid(0xa2);
	const filmNew = guid(0xa3), filmOld = guid(0xa4);
	const epA = guid(0xa101), epB = guid(0xa201);
	const catalogue = [
		series(showA, 'Show A'), series(showB, 'Show B'),
		film(filmNew, 'New Film'), film(filmOld, 'Old Film'), film(guid(0xa5), 'Browse Film')
	];
	const homeHistory = [
		progress(filmNew, undefined, 500, now - 100),
		progress(epA, showA, 80, now - 200),
		progress(epB, showB, 90, now - 300),
		progress(filmOld, undefined, 5400, now - 50000, { duration: 7200 })
	];
	const { lookup } = lookupOf({
		[showA]: [episode(epA, showA, 'A Episode', 1, 1)],
		[showB]: [episode(epB, showB, 'B Episode', 1, 1)]
	});
	const base = buildHomeFeed({ items: catalogue });
	const { result, feed, row } = await wiredFeed({ catalogue, shared: true, homeHistory, lookup });

	assert.deepEqual(feed.rows.slice(1).map(entry => entry.id), base.rows.map(entry => entry.id),
		'the Home 124 row order is unchanged after Continue');
	assert.equal(feed.rows[0].id, 'continue');
	assert.deepEqual(row.items.map(item => item.Id), [filmNew, epA, epB, filmOld],
		'recency of the latest unfinished event, not elapsed seconds');
	assert.equal(row.items.filter(item => item.Type === 'Episode').length, 2);
	assert.ok(row.items.every(item => item.Type !== 'Series'), 'series cards are represented by their exact episodes');
	assert.equal(result.availability.resolved, 2);
});
