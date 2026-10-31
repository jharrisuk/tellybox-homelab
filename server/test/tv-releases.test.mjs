import test from 'node:test';
import assert from 'node:assert/strict';
import { recentTvEpisodes, episodeReleaseDates } from '../tv-releases.mjs';

test('Bake Off with missing air dates uses the matching calendar episode, not the series premiere or file-added date',()=>{
	const date=new Date('2026-10-28T22:00:00Z');
	const local={Id:'local-6',Type:'Episode',SeriesId:'local-bakeoff',SeriesName:'The Great British Bake Off',ParentIndexNumber:17,IndexNumber:6,DateCreated:'2026-10-28',LocationType:'FileSystem'};
	const vod={...local,Id:'vod-6',SeriesId:'vod-bakeoff',Source:'streamed'};
	const calendar=[{series:'The Great British Bake Off',seriesId:11,season:17,episode:6,date:'2026-10-27T20:00:00Z'}];
	assert.equal(recentTvEpisodes([local,vod],date).length,0);
	const result=recentTvEpisodes(episodeReleaseDates([vod,local],calendar),date,20);
	assert.deepEqual(result.map(i=>i.Id),['local-6']);assert.equal(result[0].PremiereDate,calendar[0].date);assert.equal(result[0].ReleaseSeriesKey,undefined);
	assert.equal(recentTvEpisodes(episodeReleaseDates([vod],calendar),date)[0].Id,'vod-6');
	assert.equal(recentTvEpisodes([{...vod,Type:'Series',PremiereDate:'2010-08-17'}],date).length,0);
});

test('date repair does not guess ambiguous shows, use another episode, overwrite dates or invent dates from imports',()=>{
	const item={Id:'one',Type:'Episode',SeriesId:'show',SeriesName:'A show',ParentIndexNumber:1,IndexNumber:2,DateCreated:'2026-10-18'};
	const match={series:'A show',seriesId:1,season:1,episode:2,date:'2026-10-17'};
	assert.equal(episodeReleaseDates([item],[match,{...match,seriesId:2}])[0].PremiereDate,undefined);
	assert.equal(episodeReleaseDates([item],[{...match,episode:3}])[0].PremiereDate,undefined);
	assert.equal(episodeReleaseDates([{...item,PremiereDate:'2026-10-16'}],[match])[0].PremiereDate,'2026-10-16');
	assert.equal(recentTvEpisodes(episodeReleaseDates([item],[]),new Date('2026-10-18')).length,0);
});

const now = new Date('2026-10-18T12:00:00Z');
const episode = (id, show, date, extra = {}) => ({ Id: id, Type: 'Episode', SeriesId: show, SeriesName: show, PremiereDate: date, LocationType: 'FileSystem', ParentIndexNumber: 2, IndexNumber: 1, ...extra });

test('recent TV uses episode release dates, groups shows and picks the last episode of same-day batches', () => {
	const items = [
		episode('older', 'Returning show', '2026-10-15'),
		episode('latest', 'Returning show', '2026-10-17'),
		episode('batch1', 'New show', '2026-10-18', { IndexNumber: 1 }),
		episode('batch8', 'New show', '2026-10-18', { IndexNumber: 8 })
	];
	assert.deepEqual(recentTvEpisodes(items, now).map(item => item.Id), ['batch8', 'latest']);
});

test('recent TV excludes missing, future, old and undated episodes and caps the shelf at twelve shows', () => {
	const invalid = [
		episode('future', 'a', '2026-10-19'), episode('old', 'b', '2020-01-01'),
		episode('missing', 'c', '2026-10-18', { IsMissing: true }),
		episode('virtual', 'd', '2026-10-18', { LocationType: 'Virtual' }),
		episode('offline', 'e', '2026-10-18', { LocationType: 'Offline' }),
		episode('undated', 'f', null), episode('invalid', 'g', 'invalid'),
		episode('unlinked', null, '2026-10-18')
	];
	assert.deepEqual(recentTvEpisodes(invalid, now), []);
	assert.equal(recentTvEpisodes(Array.from({ length: 20 }, (_, index) => episode(String(index), `Show ${index}`, '2026-10-17')), now).length, 12);
});
