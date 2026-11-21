/* Release 131 final regression: never invent a backdrop.
 *
 * PRIMARY reproduced a new blank Continue card: an episode with a working
 * poster but no backdrop got a synthesized `/images/<series>/Backdrop` route,
 * which the app selected first; the 404 had no fallback. The same invented
 * fallback existed in episodeParentArtwork.
 *
 * These tests execute the actual shipped functions (server.mjs builder and
 * home-continue episodeView) in a VM, exactly like PRIMARY's repro, plus the
 * app's imageUrl selection.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const serverSource = readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
const continueSource = readFileSync(new URL('../home-continue.mjs', import.meta.url), 'utf8');
const appSource = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

function parentBuilder() {
	const start = serverSource.indexOf('const VOD_SERIES_ARTWORK');
	const end = serverSource.indexOf('async function libraryItems');
	assert.ok(start >= 0 && end > start, 'episodeParentArtwork slice exists');
	const box = {};
	vm.createContext(box);
	vm.runInContext(serverSource.slice(start, end) + ';globalThis.run = episodeParentArtwork;', box);
	return box;
}
function continueBuilder() {
	const fields = continueSource.indexOf('const EPISODE_FIELDS');
	const textAt = continueSource.indexOf('function text(');
	const viewAt = continueSource.indexOf('function episodeView(');
	const keyAt = continueSource.indexOf('function episodeKey(');
	assert.ok(fields >= 0 && textAt > fields && viewAt > textAt && keyAt > viewAt);
	const box = { text: value => typeof value === 'string' ? value : '',
		integer: value => Number.isInteger(value) ? value : null,
		STREAMED_EPISODE: /^dispatch-episode-(\d+)-(\d+)$/i };
	vm.createContext(box);
	vm.runInContext(continueSource.slice(fields, textAt) + continueSource.slice(viewAt, keyAt)
		+ ';globalThis.run = episodeView;', box);
	return box;
}
function imageSelector() {
	const start = appSource.indexOf('function imageUrl(');
	const end = appSource.indexOf('// Local library artwork');
	assert.ok(start >= 0 && end > start);
	const box = {};
	vm.createContext(box);
	vm.runInContext(appSource.slice(start, end) + ';globalThis.image = imageUrl;globalThis.local = localImageUrl;', box);
	return box;
}

const seriesId = 'a'.repeat(32);
const episodeId = 'b'.repeat(32);

test('a local parent without a backdrop keeps the working poster and no backdrop route', () => {
	const box = parentBuilder();
	const index = new Map([[seriesId, { id: seriesId, artwork: '', backdrop: '', local: true, hasPrimary: true, hasBackdrop: false }]]);
	const view = { Artwork: '/api/web/art/series/7', Source: 'local' };
	box.run(view, { Id: episodeId, SeriesId: seriesId, ImageTags: {} }, index);
	assert.equal(view.Artwork, `/images/${seriesId}/Primary?width=400`, 'the real parent poster is selected');
	assert.equal(view.BackdropArtwork, undefined, 'no backdrop is invented when the parent has none');
	const image = imageSelector();
	assert.equal(image.image(view, true), `/images/${seriesId}/Primary?width=400`,
		'the app falls back to the working poster for a backdrop slot');
});

test('a known local backdrop is selected; a streamed TMDB backdrop is preserved', () => {
	const box = parentBuilder();
	const withBackdrop = { Artwork: '/api/web/art/series/7', Source: 'local' };
	box.run(withBackdrop, { Id: episodeId, SeriesId: seriesId, ImageTags: {} },
		new Map([[seriesId, { id: seriesId, artwork: '', backdrop: '', local: true, hasPrimary: true, hasBackdrop: true }]]));
	assert.equal(withBackdrop.BackdropArtwork, `/images/${seriesId}/Backdrop?width=1280`);

	const streamedId = 'dispatch-series-9';
	const streamed = { Artwork: '/api/web/art/series/9', Source: 'streamed' };
	box.run(streamed, { Id: 'dispatch-episode-1-9', SeriesId: streamedId, ImageTags: {} },
		new Map([[streamedId, { id: streamedId, artwork: '/api/web/tmdb-art/tv/9/poster',
			backdrop: '/api/web/tmdb-art/tv/9/backdrop', local: false, hasPrimary: false, hasBackdrop: false }]]));
	assert.equal(streamed.Artwork, '/api/web/tmdb-art/tv/9/poster');
	assert.equal(streamed.BackdropArtwork, '/api/web/tmdb-art/tv/9/backdrop');
});

test('no local Primary evidence does not replace a working provider poster', () => {
	const box = parentBuilder();
	const view = { Artwork: '/api/web/art/series/7', Source: 'local' };
	box.run(view, { Id: episodeId, SeriesId: seriesId, ImageTags: {} },
		new Map([[seriesId, { id: seriesId, artwork: '', backdrop: '', local: true, hasPrimary: false, hasBackdrop: false }]]));
	assert.equal(view.Artwork, '/api/web/art/series/7', 'the provider route is retained when the local show has no image');
	assert.equal(view.BackdropArtwork, undefined);
});

test('Continue: no backdrop payload and no backdrop tag leaves a poster, not a blank card', () => {
	const box = continueBuilder(), image = imageSelector();
	const found = { Id: episodeId, Type: 'Episode', SeriesId: seriesId, Source: 'local',
		ImageTags: {}, Artwork: `/images/${episodeId}/Primary?width=400` };
	const view = box.run(found, { position: 120, canonicalSeriesId: seriesId },
		{ Id: seriesId, Name: 'Show', Artwork: `/images/${seriesId}/Primary?width=400`, hasPrimary: true, hasBackdrop: false });
	assert.equal(view.Id, episodeId, 'the exact episode identity is unchanged');
	assert.equal(view.BackdropArtwork, '', 'no invented backdrop');
	assert.equal(image.image(view, true), `/images/${episodeId}/Primary?width=400`, 'the client uses the working poster');
	assert.equal(image.local(view, true), '', 'no local fallback URL is synthesized');
});

test('Continue: a validated backdrop payload is kept and selected', () => {
	const box = continueBuilder(), image = imageSelector();
	const found = { Id: episodeId, Type: 'Episode', SeriesId: seriesId, Source: 'local', ImageTags: {},
		Artwork: `/images/${episodeId}/Primary?width=400`,
		BackdropArtwork: `/images/${seriesId}/Backdrop?width=1280&v=abc` };
	const view = box.run(found, { position: 120, canonicalSeriesId: seriesId },
		{ Id: seriesId, Name: 'Show', Artwork: `/images/${seriesId}/Primary?width=400`, hasPrimary: true, hasBackdrop: true });
	assert.equal(view.BackdropArtwork, `/images/${seriesId}/Backdrop?width=1280&v=abc`);
	assert.equal(image.image(view, true), `/images/${seriesId}/Backdrop?width=1280&v=abc`);
});

test('Continue: own still wins; parent poster is only used when the parent really has one', () => {
	const box = continueBuilder(), image = imageSelector();
	const own = box.run({ Id: episodeId, Type: 'Episode', SeriesId: seriesId, Source: 'local',
		ImageTags: { Primary: 'still-tag' }, Artwork: '/api/web/art/series/7' },
	{ position: 120, canonicalSeriesId: seriesId },
	{ Id: seriesId, Name: 'Show', hasPrimary: true, hasBackdrop: false });
	assert.equal(own.Artwork, `/images/${episodeId}/Primary?width=400`);
	assert.equal(own.BackdropArtwork, '');
	assert.equal(image.image(own, true), `/images/${episodeId}/Primary?width=400`);

	const noLocal = box.run({ Id: episodeId, Type: 'Episode', SeriesId: seriesId, Source: 'local',
		ImageTags: {}, Artwork: '/api/web/art/series/7' },
	{ position: 120, canonicalSeriesId: seriesId },
	{ Id: seriesId, Name: 'Show', hasPrimary: false, hasBackdrop: false });
	assert.equal(noLocal.Artwork, '/api/web/art/series/7', 'a working provider poster is not replaced');
	assert.equal(image.image(noLocal, true), '/api/web/art/series/7');
});
