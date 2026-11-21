/* Release 131: the artwork CDN/version rewrite must not apply an episode's own
 * image tag to its parent-series poster.
 *
 * The New-episodes fix points an episode at `/images/<seriesId>/Primary`. The
 * CDN middleware rewrites Jellyfin routes using item.ImageTags.Primary; for a
 * parent id that is the episode's tag, not the series tag. Locally that only
 * changes a cache key, but for a remote viewer with private artwork it would
 * mint a signed parent-series URL carrying a foreign tag. Keep the plain
 * auth-gated origin route for that one case.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { rewriteArtworkResponse } from '../artwork-routing.mjs';

const seriesId = 'a'.repeat(32);
const episodeId = 'b'.repeat(32);
const movieId = 'c'.repeat(32);

const episode = () => ({
	Id: episodeId, Type: 'Episode', SeriesId: seriesId, Source: 'local',
	ImageTags: { Primary: 'episode-still-tag' },
	ParentBackdropItemId: seriesId,
	ParentBackdropImageTags: ['series-backdrop-tag'],
	Artwork: `/images/${seriesId}/Primary?width=400`,
	BackdropArtwork: `/images/${seriesId}/Backdrop?width=1280`
});

const cdn = {
	origin: 'https://cdn.example.test',
	privateEnabled: true,
	jellyfinUrl: ({ id, kind, width, tag }) => ({
		url: 'https://cdn.example.test/tellybox/art/' + id + '/' + kind + '/' + width + '/' + tag + '.jpg'
	})
};

test('a local parent-series poster keeps an unversioned origin route', async () => {
	const body = { rows: [{ id: 'continue', items: [episode()] }] };
	const result = await rewriteArtworkResponse(body, { local: true, versioned: true, resolvers: {} });
	const item = result.rows[0].items[0];
	assert.equal(item.Artwork, `/images/${seriesId}/Primary?width=400`,
		'the episode tag is not used to version the parent series poster');
	assert.match(item.BackdropArtwork, new RegExp(`^/images/${seriesId}/Backdrop\\?width=1280&v=[a-f0-9]{12}$`),
		'the parent backdrop still uses the parent backdrop tag');
	assert.ok(!item.BackdropArtwork.includes('episode-still-tag'));
});

test('a remote caller is not minted a parent-series URL with the episode tag', async () => {
	const body = { rows: [{ id: 'new-episodes', items: [episode()] }] };
	const result = await rewriteArtworkResponse(body, {
		local: false, versioned: true, cdn, authorize: () => true, resolvers: {}
	});
	const item = result.rows[0].items[0];
	assert.equal(item.Artwork, `/images/${seriesId}/Primary?width=400`,
		'the parent poster stays on the auth-gated origin route');
	assert.ok(!String(item.Artwork).includes('cdn.example.test'));
	assert.equal(item.ArtworkLocal, undefined, 'no signed local copy is recorded');
	assert.ok(String(item.BackdropArtwork).includes('series-backdrop-tag'),
		'the parent backdrop tag may still be signed for the parent image');
});

test('normal own-image versioning and signing are unchanged', async () => {
	const movie = {
		Id: movieId, Type: 'Movie', ProviderIds: { Tmdb: '603' },
		ImageTags: { Primary: 'movie-primary-tag' },
		Artwork: `/images/${movieId}/Primary?width=400`
	};
	const local = await rewriteArtworkResponse({ items: [movie] }, { local: true, versioned: true, resolvers: {} });
	assert.match(local.items[0].Artwork, new RegExp(`^/images/${movieId}/Primary\\?width=400&v=[a-f0-9]{12}$`));
	const remote = await rewriteArtworkResponse({ items: [{ ...movie }] }, {
		local: false, versioned: true, cdn, authorize: () => true, resolvers: {}
	});
	assert.ok(String(remote.items[0].Artwork).startsWith('https://cdn.example.test/'),
		'an item image using its own tag is still signed');
});

test('a streamed provider alias is left untouched by the routing layer', async () => {
	const streamed = {
		Id: 'dispatch-episode-1-9', Type: 'Episode', SeriesId: 'dispatch-series-9', Source: 'streamed',
		Artwork: '/api/web/art/series/9'
	};
	const result = await rewriteArtworkResponse({ items: [streamed] }, { local: true, versioned: true, resolvers: {} });
	assert.equal(result.items[0].Artwork, '/api/web/art/series/9');
});
