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
	assert.deepEqual(result.map(i => i.id), [2, 1, 3]);
	assert.equal(result[0].dateLabel, 'Cinema release');
	assert.equal(result[1].dateLabel, 'Digital release');
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
