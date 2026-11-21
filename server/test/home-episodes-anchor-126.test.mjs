import test from 'node:test';
import assert from 'node:assert/strict';
import {
	ANCHOR_AFTER, ANCHOR_BEFORE, MAX_ANCHORS,
	createHomeEpisodeLookup, parseAnchors, selectHomeEpisodeWindow
} from '../home-episodes.mjs';

const show = 'a'.repeat(32);
const other = 'b'.repeat(32);
const failed = 'c'.repeat(32);
const episode = (id, series, season, number, date = '2026-01-01T00:00:00Z') => ({
	Id: id, Type: 'Episode', Name: `Episode ${number}`, SeriesId: series,
	SeriesName: `Show ${series[0]}`, ParentIndexNumber: season, IndexNumber: number,
	PremiereDate: date, RunTimeTicks: 1800e7
});
const seasonOne = (series, count, prefix = series[0]) =>
	Array.from({ length: count }, (_, index) => episode(`${prefix}-e${index + 1}`, series, 1, index + 1));

test('anchors are explicit, bounded series:season:number positions', () => {
	assert.deepEqual(parseAnchors(undefined), { anchors: [] });
	assert.deepEqual(parseAnchors(`${show}:1:5`), { anchors: [{ seriesId: show, season: 1, number: 5 }] });
	assert.deepEqual(parseAnchors(`${show}:0:0,${show}:1:5,${show}:1:5`).anchors, [
		{ seriesId: show, season: 0, number: 0 }, { seriesId: show, season: 1, number: 5 }
	]);
	for (const value of ['nope', `${show}:1`, `${show}:1:x`, `${show}:-1:5`, `http://x:1:5`, `${show}:1:5,`]) {
		assert.ok(parseAnchors(value).error, 'malformed anchors must be rejected: ' + value);
	}
	const many = Array.from({ length: MAX_ANCHORS + 1 }, (_, index) => `${show}:1:${index + 1}`).join(',');
	assert.ok(parseAnchors(many).error, 'the anchor list is bounded');
});

test('an early unfinished episode of a 100-episode show is inside its anchor window', () => {
	const group = { seriesId: show, items: seasonOne(show, 100) };
	const result = selectHomeEpisodeWindow([group], { anchors: [{ seriesId: show, season: 1, number: 5 }] });
	const ids = result.items.map(item => item.Id);
	assert.ok(ids.includes('a-e5'), 'the exact unfinished episode must be present');
	assert.ok(!ids.includes('a-e100'), 'a newer window must not replace the requested anchor');
	assert.deepEqual(result.anchors, [{ seriesId: show, season: 1, number: 5, found: true, hasBefore: true, hasAfter: true }]);
	assert.deepEqual(result.series, [{ seriesId: show, complete: true }]);
});

test('anchored shows are not lost to the global newest-120 cap', () => {
	const groups = Array.from({ length: 8 }, (_, index) => {
		const series = String.fromCharCode(97 + index).repeat(32);
		return { seriesId: series, items: seasonOne(series, 60) };
	});
	const anchors = groups.map(group => ({ seriesId: group.seriesId, season: 1, number: 5 }));
	const result = selectHomeEpisodeWindow(groups, { anchors });
	assert.equal(result.anchors.filter(anchor => anchor.found).length, 8);
	assert.equal(result.series.filter(series => series.complete).length, 8);
	const represented = new Set(result.items.map(item => item.SeriesId));
	assert.equal(represented.size, 8, 'every requested show contributes its anchored window');
});

test('a missing anchor is reported missing without inventing an episode', () => {
	const group = { seriesId: show, items: [episode('a-e1', show, 1, 1)] };
	const result = selectHomeEpisodeWindow([group], { anchors: [{ seriesId: show, season: 1, number: 9 }] });
	assert.deepEqual(result.anchors, [{ seriesId: show, season: 1, number: 9, found: false, hasBefore: true, hasAfter: false }]);
	assert.ok(result.items.every(item => item.Id !== 'a-e9'));
});

test('anchored lookup keeps successful shows and marks a failed show incomplete', async () => {
	const lookup = createHomeEpisodeLookup({
		userId: 'user-1', timeoutMs: 400, concurrency: 2,
		jelly: async () => ({ Items: [] }),
		library: {
			episodes: async id => {
				if (id === failed) throw new Error('upstream failed');
				return { items: seasonOne(id, 100) };
			}
		}
	});
	const result = await lookup([show, failed], {
		anchors: [{ seriesId: show, season: 1, number: 5 }, { seriesId: failed, season: 1, number: 5 }]
	});
	assert.equal(result.items.filter(item => item.SeriesId === show && item.IndexNumber === 5).length, 1);
	assert.equal(result.series.find(series => series.seriesId === show).complete, true);
	assert.equal(result.series.find(series => series.seriesId === failed).complete, false);
	assert.equal(result.anchors.find(anchor => anchor.seriesId === failed).found, false);
});

test('the web lookup result is unchanged when no anchors are supplied', async () => {
	const lookup = createHomeEpisodeLookup({
		userId: 'user-1', timeoutMs: 400, concurrency: 1,
		jelly: async () => ({ Items: [] }),
		library: { episodes: async () => ({ items: seasonOne(show, 100) }) }
	});
	const result = await lookup([show]);
	assert.ok(Array.isArray(result));
	assert.ok(!result.some(item => item.Id === 'a-e5'), 'without an anchor the newest-60 window is preserved');
	assert.equal(result[0].Id, 'a-e100');
});

test('the anchor window remains finite around the position', () => {
	const group = { seriesId: show, items: seasonOne(show, 100) };
	const result = selectHomeEpisodeWindow([group], { anchors: [{ seriesId: show, season: 1, number: 50 }] });
	assert.ok(result.items.length <= ANCHOR_BEFORE + ANCHOR_AFTER + 1);
	assert.ok(result.items.some(item => item.Id === 'a-e50'));
});

test('all exact anchor targets survive the global display cap', () => {
	const groups = Array.from({ length: 8 }, (_, index) => {
		const series = String.fromCharCode(97 + index).repeat(32);
		return { seriesId: series, items: seasonOne(series, 60) };
	});
	const anchors = groups.map(group => ({ seriesId: group.seriesId, season: 1, number: 30 }));
	const result = selectHomeEpisodeWindow(groups, { anchors });
	assert.equal(result.anchors.filter(anchor => anchor.found).length, 8);
	for (const group of groups) {
		const target = result.items.find(item => item.SeriesId === group.seriesId && item.IndexNumber === 30);
		assert.ok(target, 'the exact E30 target must never be dropped by the cap: ' + group.seriesId);
		const successor = result.items.find(item => item.SeriesId === group.seriesId && item.IndexNumber === 31);
		assert.ok(successor, 'the authoritative immediate E31 successor must survive too: ' + group.seriesId);
		assert.equal(result.anchors.find(anchor => anchor.seriesId === group.seriesId).found, true);
	}
	assert.equal(result.series.filter(series => series.complete).length, 8);
});

test('a partial provider group is never reported complete', () => {
	const group = {
		seriesId: show, complete: false, notice: 'Provider failed',
		items: [episode('a-e1', show, 1, 1), episode('a-e2', show, 1, 2)]
	};
	const result = selectHomeEpisodeWindow([group], { anchors: [{ seriesId: show, season: 1, number: 30 }] });
	assert.equal(result.series[0].complete, false);
	assert.equal(result.anchors[0].found, false);
});

test('a capped parent read stays unknown instead of claiming a 501+ show complete', () => {
	const group = { seriesId: show, scope: 'parent', truncated: true, items: seasonOne(show, 400) };
	const result = selectHomeEpisodeWindow([group], { anchors: [{ seriesId: show, season: 1, number: 5 }] });
	assert.equal(result.series[0].complete, false);
	assert.equal(result.series[0].truncated, true);
	assert.equal(result.anchors[0].found, true, 'the fetched exact target is still truthfully proven');
});
