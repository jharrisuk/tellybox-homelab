import test from 'node:test';
import assert from 'node:assert/strict';
import { movieRatings, upcomingMovies, upcomingSeries, createInsights } from '../insights.mjs';

const now = Date.parse('2026-10-18T12:00:00Z');
const movie = (id, extra = {}) => ({ tmdbId: id, title: `Film ${id}`, monitored: true, hasFile: false, status: 'announced', ...extra });

test('coming films distinguish home and cinema release dates and exclude unavailable old films', () => {
	const result = upcomingMovies([
		movie(1, { digitalRelease: '2026-11-01', inCinemas: '2026-10-20', physicalRelease: '2026-11-10' }),
		movie(2, { inCinemas: '2026-10-22' }),
		movie(3, { status: 'inCinemas', inCinemas: '2026-09-01' }),
		movie(4, { status: 'released', digitalRelease: '2020-01-01' }),
		movie(5, { hasFile: true, digitalRelease: '2026-11-01' }),
		movie(6, { monitored: false, inCinemas: '2026-11-01' }),
		movie(7, { inCinemas: '2027-12-01' })
	], now);
	assert.deepEqual(result.map(i => i.id), [1, 2, 3]);
	assert.equal(result[0].dateLabel, 'Cinema release');
	assert.equal(result[1].dateLabel, 'Cinema release');
	assert.equal(result[2].date, null);
	assert.ok(!JSON.stringify(result).includes('monitored'));
});

test('TV groups the next missing monitored episodes and ignores old, downloaded and unmonitored episodes', () => {
	const episode = (number, extra = {}) => ({ seriesId: 7, series: { title: 'A show', monitored: true, tmdbId: 77, apiKey: 'secret' }, title: `Episode ${number}`, seasonNumber: 2, episodeNumber: number, monitored: true, hasFile: false, airDateUtc: `2026-10-${20 + number}T20:00:00Z`, ...extra });
	const result = upcomingSeries([episode(3), episode(1), episode(2), episode(4, { hasFile: true }), episode(5, { monitored: false }), episode(6, { airDateUtc: '2026-10-01' }), episode(7, { seasonNumber: 0 }), episode(8, { series: { monitored: false } })], now);
	assert.equal(result.length, 1);
	assert.equal(result[0].dateLabel, 'Season 2 begins');
	assert.equal(result[0].episode, 'S02 · E01');
	assert.deepEqual(result[0].episodes.map(e => e.number), [1, 2, 3]);
	assert.doesNotMatch(JSON.stringify(result), /secret|apiKey|seriesId/);
});

test('films include a bounded recent window and mark already released titles', () => {
	const result = upcomingMovies([
		movie(11, { digitalRelease: '2026-10-15' }),
		movie(12, { status: 'released', digitalRelease: '2026-09-18' }),
		movie(13, { digitalRelease: '2026-10-22' })
	], now);
	assert.deepEqual(result.map(i => i.id), [11, 13]);
	assert.equal(result[0].released, true);
	assert.equal(result[0].dateLabel, 'Released');
	assert.equal(result[1].released, false);
	assert.equal(result[1].dateLabel, 'Digital release');
	const monthAgo = upcomingMovies([movie(12, { status: 'released', digitalRelease: '2026-09-18' })], now);
	assert.deepEqual(monthAgo, [], 'a film released thirty days ago is outside the window');
});

test('owned films join the recent window and carry their library id when matched', () => {
	const result = upcomingMovies([
		movie(21, { hasFile: true, digitalRelease: '2026-10-13' }),
		movie(22, { hasFile: true, digitalRelease: '2020-01-01' }),
		movie(23, { hasFile: true, digitalRelease: '2026-11-20' })
	], now, new Map([['movie:21', 'library-film-21']]));
	assert.deepEqual(result.map(i => i.id), [21], 'only the owned film released in the window is shown');
	assert.equal(result[0].released, true);
	assert.equal(result[0].dateLabel, 'Released');
	assert.deepEqual(result[0].library, { id: 'library-film-21', type: 'movie' });
	assert.doesNotMatch(JSON.stringify(result), /hasFile/, 'ownership is an input signal, not a leaked field');
});

test('series include episodes aired in the recent window and flag them as released', () => {
	const series = { title: 'Recent show', monitored: true, tmdbId: 61, apiKey: 'secret' };
	const episode = (seriesId, tmdbId, title, airDateUtc, extra = {}) => ({ seriesId, series: { ...series, tmdbId, title }, title, seasonNumber: 1, episodeNumber: 2, monitored: true, hasFile: false, airDateUtc, ...extra });
	const result = upcomingSeries([
		episode(1, 61, 'Aired recently', '2026-10-13T20:00:00Z', { hasFile: true }),
		episode(2, 62, 'Aired a month ago', '2026-09-18T20:00:00Z'),
		episode(3, 63, 'Airs later', '2026-10-23T20:00:00Z'),
		episode(4, 64, 'Aired before the return', '2026-10-14T20:00:00Z'),
		episode(4, 64, 'Returns', '2026-10-23T20:00:00Z', { episodeNumber: 7 })
	], now, new Map([['tv:61', 'library-series-61']]));
	assert.deepEqual(result.map(i => i.id), [61, 64, 63]);
	const byId = new Map(result.map(i => [i.id, i]));
	const aired = byId.get(61);
	assert.equal(aired.released, true);
	assert.equal(aired.dateLabel, 'Aired');
	assert.deepEqual(aired.library, { id: 'library-series-61', type: 'series' });
	const running = byId.get(64);
	assert.equal(running.released, false, 'a running show stays in the forward list');
	assert.equal(running.dateLabel, 'Next episode airs');
	assert.deepEqual(running.episodes.map(e => e.title), ['Aired before the return', 'Returns'], 'aired episodes remain visible to the calendar');
	assert.equal(byId.get(63).released, false);
	assert.equal(byId.get(63).dateLabel, 'Next episode airs');
});

test('a running series keeps its next episode when the recent window is full', () => {
	const series = { title: 'Daily show', monitored: true, tmdbId: 71 };
	const episodes = [];
	for (let date = 12; date <= 17; date++) {
		episodes.push({ seriesId: 9, series, title: `Old ${date}`, seasonNumber: 1, episodeNumber: date, monitored: true, hasFile: true, airDateUtc: `2026-10-${String(date).padStart(2, '0')}T20:00:00Z` });
	}
	episodes.push({ seriesId: 9, series, title: 'The next one', seasonNumber: 1, episodeNumber: 11, monitored: true, hasFile: false, airDateUtc: '2026-10-23T20:00:00Z' });
	const [item] = upcomingSeries(episodes, now);
	assert.equal(item.released, false);
	assert.equal(item.dateLabel, 'Next episode airs');
	assert.deepEqual(item.episodes.map(e => e.title), ['Old 16', 'Old 17', 'The next one'], 'the next episode is never crowded out');
});

test('createInsights merges library matches from the injected catalogue lookup', async () => {
	let libraryCalls = 0;
	const insights = createInsights({
		clock: () => now,
		config: () => ({ radarr: { url: 'http://radarr.test', key: 'secret' }, sonarr: { url: 'http://sonarr.test', key: 'other' } }),
		fetcher: async url => url.hostname === 'radarr.test'
			? Response.json([movie(1, { digitalRelease: '2026-10-15' })])
			: Response.json([{ seriesId: 2, series: { title: 'Show', monitored: true, tmdbId: 2 }, title: 'Episode', seasonNumber: 1, episodeNumber: 1, monitored: true, hasFile: false, airDateUtc: '2026-10-13T20:00:00Z' }]),
		library: async items => { libraryCalls++; return new Map(items.map(i => [`${i.type}:${i.id}`, 'jelly-' + i.id])); }
	});
	const schedule = await insights.upcoming();
	assert.equal(libraryCalls, 1);
	assert.deepEqual(schedule.movies[0].library, { id: 'jelly-1', type: 'movie' });
	assert.deepEqual(schedule.tv[0].library, { id: 'jelly-2', type: 'series' });
	assert.doesNotMatch(JSON.stringify(schedule), /secret|http:\/\//);
});

test('createInsights keeps the schedule when the library lookup fails', async () => {
	const insights = createInsights({
		clock: () => now,
		config: () => ({ radarr: { url: 'http://radarr.test', key: 'secret' } }),
		fetcher: async () => Response.json([movie(1, { digitalRelease: '2026-10-15' })]),
		library: async () => { throw new Error('catalogue offline'); }
	});
	const schedule = await insights.upcoming();
	assert.equal(schedule.movies.length, 1);
	assert.equal(schedule.movies[0].library, undefined);
});

test('ratings retain named sources and scales while rejecting missing, invalid and out-of-range values', () => {
	const ratings = movieRatings({ tmdbId: 1, imdbId: 'tt123', ratings: { imdb: { value: 7.3, votes: 1234 }, tmdb: { value: 0 }, rottenTomatoes: { value: 73 }, trakt: { value: 14 } } });
	assert.deepEqual(ratings.map(r => [r.source, r.value, r.max]), [['IMDb', 7.3, 10], ['Rotten Tomatoes', 73, 100]]);
	assert.equal(ratings[0].url, 'https://www.imdb.com/title/tt123/');
	assert.equal(ratings[0].votes, 1234);
	assert.deepEqual(movieRatings({}), []);
	const items = upcomingMovies([movie(1, { images: [{ coverType: 'poster', remoteUrl: 'https://evil.test/private?key=secret' }] })], now);
	assert.equal(items[0].poster, null);
});

test('calendar cache coalesces reads, tolerates one failed service and preserves discovery ratings', async () => {
	let time = now, calls = 0;
	const insights = createInsights({ clock: () => time, config: () => ({ radarr: { url: 'http://radarr.test', key: 'secret' }, sonarr: { url: 'http://sonarr.test', key: 'other-secret' } }), fetcher: async (url, options) => {
		calls++; assert.equal(options.redirect, 'error'); assert.equal(options.method, undefined);
		if (url.hostname === 'sonarr.test') return new Response('internal-secret', { status: 503 });
		return Response.json([movie(1, { ratings: { imdb: { value: 8.2 } } })]);
	} });
	const [one, two] = await Promise.all([insights.upcoming(), insights.upcoming()]);
	assert.equal(calls, 2); assert.deepEqual(one, two);
	assert.deepEqual(one.unavailable, ['tv']); assert.equal(one.movies.length, 1);
	assert.doesNotMatch(JSON.stringify(one), /secret|http:\/\//);
	const enriched = await insights.enrich([{ id: 1, type: 'movie' }, { id: 2, type: 'movie', ratings: [{ source: 'TMDB', value: 7.5 }] }]);
	assert.equal(enriched[0].ratings[0].source, 'IMDb'); assert.equal(enriched[1].ratings[0].source, 'TMDB');
	assert.equal(calls, 2);
	time += 31000; await insights.upcoming(); assert.equal(calls, 3);
});

test('recent episode calendar exposes only matching fields and caches the lookup',async()=>{
	let calls=0;
	const insights=createInsights({clock:()=>now,config:()=>({sonarr:{url:'http://sonarr.test',key:'private'}}),fetcher:async url=>{
		calls++;assert.equal(url.searchParams.get('includeSeries'),'true');assert.equal(url.searchParams.get('unmonitored'),'true');
		return Response.json([{seriesId:11,series:{title:'Bake Off',path:'/private/files',apiKey:'private'},seasonNumber:17,episodeNumber:6,airDateUtc:'2026-10-27T20:00:00Z',episodeFile:{path:'/private/file'}}]);
	}});
	assert.deepEqual(await insights.recentEpisodeDates(),[{series:'Bake Off',seriesId:11,season:17,episode:6,date:'2026-10-27T20:00:00Z'}]);
	await insights.recentEpisodeDates();assert.equal(calls,1);
});
