import test from 'node:test';
import assert from 'node:assert/strict';
import { createInsights, upcomingSeries, attachLibrary } from '../insights.mjs';
import { resolveComingMatches } from '../coming-library.mjs';

const now = Date.parse('2026-10-18T12:00:00Z');
const show = { title: 'Scheduled show', monitored: true, tmdbId: 501 };
const episode = (number, airDateUtc, seasonNumber = 3, extra = {}) => ({
	seriesId: 9, series: show, title: `Episode ${number}`, seasonNumber, episodeNumber: number,
	monitored: true, hasFile: false, airDateUtc, ...extra
});

test('a TV coming-soon item exposes the season and episode the card represents', () => {
	const [item] = upcomingSeries([
		episode(2, '2026-10-10T20:00:00Z'),
		episode(4, '2026-10-26T20:00:00Z')
	], now);
	assert.equal(item.seasonNumber, 3);
	assert.equal(item.episodeNumber, 4, 'the identity follows the chosen next episode, not the first in the history');
	assert.equal(item.episode, 'S03 · E04');
	assert.deepEqual(item.episodes.map(e => e.number), [2, 4], 'the existing history is unchanged');
});

const tvItem = { type: 'tv', id: 501, title: 'Scheduled show', seasonNumber: 3, episodeNumber: 4 };
const availability = async items => items.map(item => item.type === 'tv' ? { ...item, watchId: 'series-1' } : item);

test('a resolvable scheduled episode links to that exact episode, not the series', async () => {
	let lookedUp = null;
	const index = await resolveComingMatches([tvItem], {
		availability,
		episodes: async id => {
			lookedUp = id;
			return [
				{ Id: 'episode-1', ParentIndexNumber: 3, IndexNumber: 1 },
				{ Id: 'episode-4', ParentIndexNumber: 3, IndexNumber: 4 }
			];
		}
	});
	assert.equal(lookedUp, 'series-1', 'the lookup uses the matched local series id');
	assert.deepEqual(index.get('tv:501'), { id: 'episode-4', type: 'episode' });
	const [attached] = attachLibrary([tvItem], index);
	assert.deepEqual(attached.library, { id: 'episode-4', type: 'episode' });
	assert.notEqual(attached.library.id, 'series-1');
});

test('an episode the series does not contain gets no library link', async () => {
	const index = await resolveComingMatches([tvItem], {
		availability,
		episodes: async () => [
			{ Id: 'episode-1', ParentIndexNumber: 3, IndexNumber: 1 },
			{ Id: 'episode-5', ParentIndexNumber: 3, IndexNumber: 5 }
		]
	});
	assert.equal(index.get('tv:501'), undefined);
	assert.equal(attachLibrary([tvItem], index)[0].library, undefined);
});

test('a failed episode lookup gets no library link and keeps the page working', async () => {
	const index = await resolveComingMatches([tvItem], {
		availability,
		episodes: async () => { throw new Error('Jellyfin is unavailable'); }
	});
	assert.equal(index.get('tv:501'), undefined);
	assert.equal(attachLibrary([tvItem], index)[0].library, undefined);
});

test('an unmatched TV item gets no library link and no episode lookup', async () => {
	let lookups = 0;
	const index = await resolveComingMatches([tvItem], {
		availability: async items => items,
		episodes: async () => { lookups++; return []; }
	});
	assert.equal(index.size, 0);
	assert.equal(lookups, 0, 'nothing is resolved without a verified local series');
	assert.equal(attachLibrary([tvItem], index)[0].library, undefined);
});

test('a TV match without the scheduled identity gets no library link', async () => {
	let lookups = 0;
	const index = await resolveComingMatches([{ type: 'tv', id: 501, title: 'Legacy item' }], {
		availability,
		episodes: async () => { lookups++; return []; }
	});
	assert.equal(index.get('tv:501'), undefined);
	assert.equal(lookups, 0);
});

test('createInsights returns the resolved episode as the TV library link', async () => {
	const insights = createInsights({
		clock: () => now,
		config: () => ({ sonarr: { url: 'http://sonarr.test', key: 'secret' } }),
		fetcher: async () => Response.json([
			{ seriesId: 9, series: show, title: 'Episode 4', seasonNumber: 3, episodeNumber: 4,
				monitored: true, hasFile: false, airDateUtc: '2026-10-26T20:00:00Z' }
		]),
		library: items => resolveComingMatches(items, {
			availability,
			episodes: async () => [{ Id: 'episode-4', ParentIndexNumber: 3, IndexNumber: 4 }]
		})
	});
	const schedule = await insights.upcoming();
	assert.equal(schedule.tv[0].seasonNumber, 3);
	assert.equal(schedule.tv[0].episodeNumber, 4);
	assert.deepEqual(schedule.tv[0].library, { id: 'episode-4', type: 'episode' });
	assert.doesNotMatch(JSON.stringify(schedule), /secret|http:\/\//);
});
