import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { chooseNext, createEpisodeNext, dateOnly, dateOnlyPhase, nextSchedule } from '../episode-next.mjs';

const flowSource = readFileSync(new URL('../public/episode-flow.js', import.meta.url), 'utf8');
const flowContext = vm.createContext({});
vm.runInContext(flowSource, flowContext);
const flow = flowContext.TellyboxEpisodeFlow;

const current = { Id: 'e2-8', Type: 'Episode', ParentIndexNumber: 2, IndexNumber: 8, SeriesId: 'series-1' };
const nextEpisode = { Id: 'e2-9', Type: 'Episode', ParentIndexNumber: 2, IndexNumber: 9, SeriesId: 'series-1', Name: 'The Next One' };
const now = Date.parse('2026-11-08T12:00:00Z');
const info = (extra = {}) => ({ id: 123, status: 'Returning Series', ...extra });

test('browser date labels are date-only and distinguish scheduled from not yet available', () => {
	const today = new Date(2026, 10, 8);
	assert.equal(flow.dateOnly('2026-11-08T23:30:00Z'), '2026-11-08');
	assert.equal(flow.airDateInfo('2026-11-08', today).phase, 'today');
	assert.equal(flow.airDateInfo('2026-11-09', today).label, 'Tomorrow');
	assert.equal(flow.airDateInfo('2026-11-07', today).phase, 'past');
	assert.equal(flow.airDateInfo('', today).phase, 'unknown');
	const scheduled = flow.nextScheduleCopy({ status: 'scheduled', next: { season: 2, episode: 9, title: 'The Next One', airDate: '2026-11-09' } }, today);
	assert.equal(scheduled.when, 'Airs Tomorrow');
	assert.equal(scheduled.detail, 'Not yet available in Tellybox.');
	assert.equal(scheduled.identity, 'S2 E9 - The Next One');
	const aired = flow.nextScheduleCopy({ status: 'aired-missing', next: { season: 2, episode: 9, title: 'Aired', airDate: '2026-11-07' } }, today);
	assert.ok(aired.when.startsWith('Aired '));
	assert.ok(aired.when.includes('7'));
	assert.equal(aired.detail, 'Not yet available in Tellybox.');
	const undated = flow.nextScheduleCopy({ status: 'scheduled', next: { season: 0, episode: 3, title: 'Special', airDate: '' } }, today);
	assert.equal(undated.when, 'Scheduled; date not announced');
	assert.equal(flow.nextScheduleCopy({ status: 'complete' }, today), null);
});

test('date-only values keep their calendar date and never shift at a timezone boundary', () => {
	assert.equal(dateOnly('2026-11-08'), '2026-11-08');
	assert.equal(dateOnly('2026-11-08T23:30:00Z'), '2026-11-08');
	assert.equal(dateOnly('2026-02-30'), '');
	assert.equal(dateOnly('not-a-date'), '');
	assert.equal(dateOnlyPhase('2026-11-08', now), 'today');
	assert.equal(dateOnlyPhase('2026-11-09', now), 'future');
	assert.equal(dateOnlyPhase('2026-11-07', now), 'past');
	assert.equal(dateOnlyPhase('', now), 'unknown');
	assert.equal(dateOnlyPhase('2026-11-08T23:59:59Z', now), 'today');
});

test('known future, today, aired-missing and undated next episodes are distinguished', () => {
	const future = nextSchedule(current, [], info({ next_episode_to_air: { season_number: 2, episode_number: 9, name: 'The Next One', air_date: '2026-11-15' } }), { now, expectedTmdb: '123' });
	assert.equal(future.status, 'scheduled');
	assert.deepEqual(future.next, { season: 2, episode: 9, title: 'The Next One', airDate: '2026-11-15', phase: 'future' });
	assert.match(future.message, /not available in Tellybox/i);
	const today = nextSchedule(current, [], info({ next_episode_to_air: { season_number: 2, episode_number: 9, name: 'Today', air_date: '2026-11-08' } }), { now, expectedTmdb: '123' });
	assert.equal(today.next.phase, 'today');
	const aired = nextSchedule(current, [], info({ next_episode_to_air: { season_number: 2, episode_number: 9, name: 'Aired', air_date: '2026-11-01' } }), { now, expectedTmdb: '123' });
	assert.equal(aired.status, 'aired-missing');
	assert.match(aired.message, /aired but is not available/i);
	const undated = nextSchedule(current, [], info({ next_episode_to_air: { season_number: 2, episode_number: 9, name: 'TBA' } }), { now, expectedTmdb: '123' });
	assert.equal(undated.status, 'scheduled');
	assert.equal(undated.next.airDate, '');
	assert.equal(undated.next.phase, 'unknown');
});

test('unknown, ended, cancelled, wrong identity and incomplete data stay honest', () => {
	assert.equal(nextSchedule(current, [], null, { now, expectedTmdb: '123' }).status, 'unknown');
	assert.equal(nextSchedule(current, [], info(), { now, expectedTmdb: '999' }).status, 'unknown');
	assert.equal(nextSchedule(current, [], info({ status: 'Ended' }), { now, expectedTmdb: '123' }).status, 'complete');
	assert.equal(nextSchedule(current, [], info({ status: 'Canceled' }), { now, expectedTmdb: '123' }).status, 'complete');
	assert.equal(nextSchedule(current, [], info(), { now, expectedTmdb: '123' }).status, 'caught-up');
	assert.equal(nextSchedule(current, [], info(), { now, expectedTmdb: '123', incomplete: true }).status, 'unknown');
});

test('specials and earlier/past metadata are not mistaken for the next episode', () => {
	const specialCurrent = { ...current, ParentIndexNumber: 0, IndexNumber: 2 };
	const special = nextSchedule(specialCurrent, [], info({ next_episode_to_air: { season_number: 0, episode_number: 3, name: 'Special', air_date: '2026-11-15' } }), { now, expectedTmdb: '123' });
	assert.equal(special.status, 'scheduled');
	assert.equal(special.next.season, 0);
	const same = nextSchedule(current, [], info({ next_episode_to_air: { season_number: 2, episode_number: 8, name: 'Current', air_date: '2026-11-15' } }), { now, expectedTmdb: '123' });
	assert.equal(same.status, 'caught-up');
	assert.equal(chooseNext(current, [nextEpisode]).item.Id, nextEpisode.Id);
});

test('the finished response renders a provisional screen and performs the schedule lookup separately', async () => {
	let metadataCalls = 0;
	const library = {
		item: async id => id === 'series-1' ? { Id: 'series-1', Name: 'Example', ProviderIds: { Tmdb: '123' }, Genres: ['Drama'] } : current,
		episodes: async () => ({ items: [] }),
		list: async () => ({ items: [] }),
	};
	const metadata = async () => { metadataCalls++; return info({ next_episode_to_air: { season_number: 2, episode_number: 9, name: 'The Next One', air_date: '2026-11-15' } }); };
	const next = createEpisodeNext({ library, metadata, clock: () => now });
	const provisional = await next(current.Id, 'series-1');
	assert.equal(provisional.item, null);
	assert.equal(provisional.schedulePending, true);
	assert.match(provisional.scheduleUrl, /schedule/);
	assert.equal(typeof next.schedule, 'function');
	const schedule = await next.schedule(current.Id, 'series-1');
	assert.equal(schedule.status, 'scheduled');
	assert.equal(schedule.next.episode, 9);
	assert.equal(schedule.seriesId, 'series-1');
	assert.ok(metadataCalls >= 1);
	const immediate = await createEpisodeNext({ library, metadata: async () => { throw Error('must not be called'); }, clock: () => now })(current.Id, 'series-1');
	assert.equal(immediate.item, null);
});
