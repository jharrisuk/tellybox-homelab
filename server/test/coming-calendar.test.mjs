import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const context = { window: {}, Date };
vm.runInNewContext(readFileSync(new URL('../public/coming-calendar.js', import.meta.url), 'utf8'), context);
const calendar = context.window.jserverCalendar;

test('calendar covers seven local dates across a clock change, including month rollover', () => {
	const days = calendar.days({ tv: [], movies: [] }, new Date(2026, 2, 28, 12));
	assert.deepEqual(Array.from(days, day => day.key), ['2026-03-28', '2026-03-29', '2026-03-30', '2026-03-31', '2026-04-01', '2026-04-02', '2026-04-03']);
});

test('calendar includes each episode, preserves film release dates and excludes dates outside the week', () => {
	const episodeDate = new Date(2026, 9, 19, 1).toISOString();
	const schedule = {
		tv: [{ type: 'tv', title: 'Example show', episodes: [
			{ season: 2, number: 1, title: 'First', date: episodeDate },
			{ season: 2, number: 2, title: 'Second', date: new Date(2026, 9, 20, 1).toISOString() },
			{ season: 2, number: 3, title: 'Later', date: new Date(2026, 9, 25, 1).toISOString() }
		] }],
		movies: [
			{ type: 'movie', title: 'Film', date: '2026-10-19T23:30:00Z' },
			{ type: 'movie', title: 'Unknown', date: null },
			{ type: 'movie', title: 'Invalid', date: 'invalid' }
		]
	};
	const days = calendar.days(schedule, new Date(2026, 9, 18, 12));
	assert.equal(days[1].items.length, 2);
	assert.equal(days[1].items.find(item => item.type === 'tv').episode, 'S2 · E1');
	assert.equal(days[2].items[0].episodeTitle, 'Second');
	assert.equal(days.reduce((count, day) => count + day.items.length, 0), 3);
	assert.equal(schedule.tv[0].episode, undefined);
});

test('calendar can add the recent past and marks released days without changing the default week', () => {
	const schedule = {
		tv: [{ type: 'tv', title: 'Just aired', episodes: [
			{ season: 1, number: 4, title: 'Aired', date: new Date(2026, 9, 15, 1).toISOString() }
		] }],
		movies: [{ type: 'movie', title: 'Released film', date: '2026-10-14T00:00:00Z' }]
	};
	const days = calendar.days(schedule, new Date(2026, 9, 18, 12), { past: 14 });
	assert.equal(days.length, 21, 'fourteen recent days plus the next seven');
	assert.equal(days[0].key, '2026-10-04');
	assert.equal(days[0].past, true);
	assert.equal(days[13].past, true);
	assert.equal(days[14].today, true, 'today is not mistaken for the first rendered day');
	assert.equal(days[14].past, false);
	assert.equal(days[20].key, '2026-10-24');
	const aired = days.find(day => day.key === '2026-10-15');
	assert.equal(aired.items.length, 1);
	assert.equal(aired.items[0].title, 'Just aired');
	const releasedFilm = days.find(day => day.key === '2026-10-14');
	assert.equal(releasedFilm.items[0].title, 'Released film');
	assert.equal(calendar.days({ tv: [], movies: [] }, new Date(2026, 9, 18, 12)).length, 7, 'the default stays a single week');
});

test('only the episode the card represents keeps the library link', () => {
	const first = new Date(2026, 9, 19, 1).toISOString();
	const second = new Date(2026, 9, 20, 1).toISOString();
	const schedule = {
		tv: [{ type: 'tv', title: 'Example show', seasonNumber: 2, episodeNumber: 2,
			library: { id: 'episode-2', type: 'episode' }, episodes: [
				{ season: 2, number: 1, title: 'First', date: first },
				{ season: 2, number: 2, title: 'Second', date: second }
			] }],
		movies: []
	};
	const days = calendar.days(schedule, new Date(2026, 9, 18, 12));
	const aired = days[1].items.find(item => item.episodeTitle === 'First');
	const chosen = days[2].items.find(item => item.episodeTitle === 'Second');
	assert.equal(aired.library, undefined, 'an earlier episode must not inherit the card link');
	assert.deepEqual(chosen.library, { id: 'episode-2', type: 'episode' });
});