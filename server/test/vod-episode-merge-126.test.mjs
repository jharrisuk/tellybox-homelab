// HOME-126: a local episode may only replace its streamed duplicate when the
// local row is actually playable. A missing/unaired/future local row must not
// evict the streamed copy that can be played, and a different local episode
// number must never hide a streamed episode.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeEpisodes } from '../vod-library.mjs';

const NOW = Date.parse('2026-11-17T12:00:00Z');
const SERIES = { Id: 'series-canonical', Name: 'Canonical Show' };

const localEpisode = (overrides = {}) => ({
	Id: 'local-e5', Name: 'Local S02E05', Type: 'Episode', Source: 'local',
	ParentIndexNumber: 2, IndexNumber: 5, PremiereDate: '2026-11-10T00:00:00Z',
	RunTimeTicks: 1800e7, Artwork: '/local/art/e5', VodIds: [55], ...overrides
});
const streamedEpisode = (overrides = {}) => ({
	Id: 'dispatch-episode-905-9', Name: 'Show S02E05', Type: 'Episode', Source: 'streamed',
	Provider: 'Example VOD', ParentIndexNumber: 2, IndexNumber: 5,
	PremiereDate: '2026-11-10T00:00:00Z', RunTimeTicks: 1700e7,
	Artwork: '/api/web/art/series/9', VodIds: [9], ...overrides
});
const merge = (local, remote) => mergeEpisodes(local, remote, SERIES, NOW);
const pad = value => String(value).padStart(2, '0');
// Build a date-only value from the same local calendar the merge uses, so the
// test is deterministic in any machine timezone.
const dayOffset = days => {
	const base = new Date(NOW);
	const day = new Date(base.getFullYear(), base.getMonth(), base.getDate() + days);
	return `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`;
};

test('a playable local duplicate wins and unions both VodIds', () => {
	const rows = merge([localEpisode()], [streamedEpisode()]);
	assert.equal(rows.length, 1, 'one row per season and episode');
	const [row] = rows;
	assert.equal(row.Id, 'local-e5', 'local playback identity wins when it is playable');
	assert.equal(row.Source, 'local');
	assert.equal(row.Name, 'Local S02E05', 'local-first metadata is preserved');
	assert.equal(row.Artwork, '/local/art/e5');
	assert.deepEqual(row.VodIds, [55, 9], 'local and streamed aliases survive the merge');
	assert.equal(row.SeriesId, SERIES.Id);
	assert.equal(row.SeriesName, SERIES.Name);
});

test('a missing local duplicate does not evict the playable streamed row', () => {
	const [row] = merge([localEpisode({ IsMissing: true })], [streamedEpisode()]);
	assert.equal(row.Id, 'dispatch-episode-905-9');
	assert.equal(row.Source, 'streamed');
	assert.equal(row.Artwork, '/api/web/art/series/9');
	assert.deepEqual(row.VodIds, [9, 55], 'the local alias still survives history matching');
});

test('future, date-only future, unaired and virtual local rows keep the streamed fallback', () => {
	const cases = [
		{ label: 'timestamp future', overrides: { PremiereDate: '2027-01-01T00:00:00Z' } },
		{ label: 'date-only future', overrides: { PremiereDate: dayOffset(1) } },
		{ label: 'unaired', overrides: { IsUnaired: true } },
		{ label: 'virtual', overrides: { IsVirtualItem: true } }
	];
	for (const { label, overrides } of cases) {
		const [row] = merge([localEpisode(overrides)], [streamedEpisode()]);
		assert.equal(row.Id, 'dispatch-episode-905-9', label);
		assert.equal(row.Source, 'streamed', label);
		assert.deepEqual(row.VodIds, [9, 55], label);
	}
});

test('date-only today and an unknown premiere date are not treated as future', () => {
	const [today] = merge([localEpisode({ PremiereDate: dayOffset(0) })], [streamedEpisode()]);
	assert.equal(today.Id, 'local-e5', 'a date-only release today is already playable');
	const [unknown] = merge([localEpisode({ PremiereDate: undefined })], [streamedEpisode()]);
	assert.equal(unknown.Id, 'local-e5', 'a missing premiere date is unknown, not future');
	const [unparseable] = merge([localEpisode({ PremiereDate: 'not-a-date' })], [streamedEpisode()]);
	assert.equal(unparseable.Id, 'local-e5', 'an unparseable premiere date is not proof of a future release');
});

test('a local E1-only copy does not hide a different streamed episode', () => {
	const rows = merge(
		[localEpisode({ Id: 'local-e1', IndexNumber: 1, PremiereDate: '2026-11-01T00:00:00Z' })],
		[streamedEpisode()]
	);
	assert.deepEqual(rows.map(row => row.Id), ['local-e1', 'dispatch-episode-905-9']);
	assert.deepEqual(rows.map(row => row.IndexNumber), [1, 5]);
});

test('duplicate streamed rows collapse deterministically', () => {
	const first = streamedEpisode({ Id: 'dispatch-episode-1-9', Name: 'First provider', VodIds: [1] });
	const second = streamedEpisode({ Id: 'dispatch-episode-2-9', Name: 'Second provider', VodIds: [2] });
	const [tie] = merge([], [first, second]);
	assert.equal(tie.Id, 'dispatch-episode-1-9', 'a playable tie keeps the first provider-priority row');
	assert.deepEqual(tie.VodIds, [1, 2]);

	const missingFirst = streamedEpisode({ Id: 'dispatch-episode-3-9', IsMissing: true, VodIds: [3] });
	const [fallback] = merge([], [missingFirst, second]);
	assert.equal(fallback.Id, 'dispatch-episode-2-9', 'a later playable duplicate replaces an unavailable one');
	assert.deepEqual(fallback.VodIds, [2, 3]);
});

test('the streamed fallback keeps remote identity and useful local metadata', () => {
	const local = localEpisode({
		IsMissing: true, Name: 'Local fallback name', Artwork: '/local/art/fallback', RunTimeTicks: 1900e7
	});
	const remote = streamedEpisode({ Name: undefined, Artwork: undefined, RunTimeTicks: undefined });
	const [row] = merge([local], [remote]);
	assert.equal(row.Id, remote.Id, 'a non-playable local row never supplies the playback id');
	assert.equal(row.Source, 'streamed');
	assert.equal(row.Name, 'Local fallback name');
	assert.equal(row.Artwork, '/local/art/fallback');
	assert.equal(row.RunTimeTicks, 1900e7);
});

test('missing names do not throw and still sort by season, episode and id', () => {
	const [fallback] = merge([localEpisode({ Name: undefined })], [streamedEpisode()]);
	assert.equal(fallback.Name, 'Show S02E05', 'a usable name comes from the other row');

	const rows = merge([
		localEpisode({ Id: 'local-e5', Name: undefined, IndexNumber: 5 }),
		localEpisode({ Id: 'local-e4', Name: undefined, IndexNumber: 4 })
	], []);
	assert.deepEqual(rows.map(row => row.IndexNumber), [4, 5]);
	assert.deepEqual(rows.map(row => row.Id), ['local-e4', 'local-e5']);

	const [nameless] = merge([localEpisode({ Id: 'local-nameless', Name: undefined })], [streamedEpisode({ Name: undefined })]);
	assert.equal(nameless.Id, 'local-nameless');
	assert.equal(nameless.Name, undefined);
	assert.doesNotThrow(() => mergeEpisodes([{ Id: 'broken', Type: 'Episode', ParentIndexNumber: 1 }], [], SERIES, NOW),
		'a malformed row without a name or episode number is still returned');
});
