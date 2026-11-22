/* A merged local episode in the series detail list must not keep the streamed
 * duplicate's `/api/web/art/series/<vodId>` alias. That route 404s when the
 * provider row has no logo or TMDB id (Succession VOD 10020), leaving the
 * episode thumbnail blank even though Jellyfin has the still.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mergeEpisodes } from '../vod-library.mjs';

const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

const seriesId = 'a'.repeat(32);
const stillId = 'b'.repeat(32);
const bareId = 'c'.repeat(32);
const series = {
	Id: seriesId, Name: 'Succession', Type: 'Series', Source: 'local',
	ImageTags: { Primary: 'series-primary' }, BackdropImageTags: ['series-backdrop'],
	Artwork: '/images/' + seriesId + '/Primary?width=400'
};
const localStill = {
	Id: stillId, Name: 'The Summer Palace', Type: 'Episode', Source: 'local',
	SeriesId: seriesId, ParentIndexNumber: 2, IndexNumber: 1,
	PremiereDate: '2019-08-11', ImageTags: { Primary: 'episode-still' }
};
const localBare = {
	Id: bareId, Name: 'Vaulter', Type: 'Episode', Source: 'local',
	SeriesId: seriesId, ParentIndexNumber: 2, IndexNumber: 2,
	PremiereDate: '2019-08-18', ImageTags: {}
};
const remote = {
	Id: 'dispatch-series-10020-ep-10', Name: 'The Summer Palace', Type: 'Episode', Source: 'streamed',
	ParentIndexNumber: 2, IndexNumber: 1, Artwork: '/api/web/art/series/10020'
};

test('a merged local episode keeps its own still instead of the broken provider alias', () => {
	const merged = mergeEpisodes([localStill, localBare], [remote], series);
	const still = merged.find(item => item.Id === stillId);
	assert.ok(still, 'the local episode is the merged row');
	assert.equal(still.Artwork, '/images/' + stillId + '/Primary?width=400');
	assert.equal(still.BackdropArtwork, '/images/' + seriesId + '/Backdrop?width=1280');
});

test('a local episode with no still falls back to the local series poster', () => {
	const merged = mergeEpisodes([localStill, localBare], [], series);
	const bare = merged.find(item => item.Id === bareId);
	assert.equal(bare.Artwork, '/images/' + seriesId + '/Primary?width=400',
		'a missing still uses the series poster, never a provider alias');
});

test('a streamed-only series keeps the provider artwork route', () => {
	const streamed = { ...series, Source: 'streamed', Artwork: '/api/web/art/series/10020' };
	const merged = mergeEpisodes([], [remote], streamed);
	assert.equal(merged[0].Artwork, '/api/web/art/series/10020');
});

test('the web episode list prefers a still, then the series backdrop', () => {
	assert.match(app, /function setEpisodeStill\(image, item, width = 360\)/);
	assert.match(app, /setEpisodeStill\(thumbnail, item, 360\)/);
	assert.match(app, /BackdropArtworkLocal \|\| item\.BackdropArtwork/);
	assert.match(app, /image\.src !== current/);
});
