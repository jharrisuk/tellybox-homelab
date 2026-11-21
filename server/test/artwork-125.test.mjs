import test from 'node:test';
import assert from 'node:assert/strict';
import { createArtworkCdn } from '../artwork-cdn.mjs';
import { rewriteArtworkResponse } from '../artwork-routing.mjs';

const secret = 'test-artwork-cdn-secret-0123456789abcdef';
const origin = 'https://cdn.example.test';
const id = '0123456789abcdef0123456789abcdef';
const parentId = 'fedcba9876543210fedcba9876543210';
const VERSION = /^\/images\/[a-f0-9-]+\/(?:Primary|Backdrop)\?width=\d+&v=[a-f0-9]{12}$/;

function cdn(options = {}) {
	let clock = 1_000_000;
	const value = createArtworkCdn({
		origin, secret, now: () => clock, bucketMs: 60_000, ttlMs: 600_000, privateArtwork: true, ...options,
	});
	return { value, advance: ms => { clock += ms; }, now: () => clock };
}

test('the private mint memo reuses a live URL without ever extending its expiry', () => {
	const state = cdn();
	const first = state.value.jellyfinUrl({ id, kind: 'Primary', width: 400, tag: 'tag-v1', scope: 'email:a' });
	const expires = state.value.decode(new URL(first.url).pathname.split('/')[3]).e;
	assert.equal(expires, state.now() + 300_000, 'the private TTL is unchanged at five minutes');

	state.advance(1000);
	const reused = state.value.jellyfinUrl({ id, kind: 'Primary', width: 400, tag: 'tag-v1', scope: 'email:a' });
	assert.equal(reused.url, first.url, 'a live entry is reused instead of re-minted');
	assert.equal(reused.expires, first.expires);
	assert.equal(state.value.decode(new URL(reused.url).pathname.split('/')[3]).e, expires, 'reuse cannot extend the ticket');

	// Inside the minimum remaining window the entry is not reused: a fresh mint
	// gives the browser the full remaining lifetime instead of a dying URL.
	state.advance(first.expires - state.now() - 4000);
	const renewed = state.value.jellyfinUrl({ id, kind: 'Primary', width: 400, tag: 'tag-v1', scope: 'email:a' });
	assert.notEqual(renewed.url, first.url);
	assert.equal(renewed.expires, state.now() + 300_000);
	const stats = state.value.mintStats();
	assert.equal(stats.hits, 1);
	assert.equal(stats.misses, 2);
	assert.equal(stats.expired, 1, 'the unusable entry was cleaned up');
});

test('a changed version, width or kind is a different memo entry', () => {
	const state = cdn();
	const base = { id, kind: 'Primary', width: 400, tag: 'tag-v1', scope: 'email:a' };
	const one = state.value.jellyfinUrl(base);
	const tag = state.value.jellyfinUrl({ ...base, tag: 'tag-v2' });
	const width = state.value.jellyfinUrl({ ...base, width: 800 });
	const kind = state.value.jellyfinUrl({ ...base, kind: 'Backdrop', tag: 'backdrop-v1' });
	assert.notEqual(tag.url, one.url);
	assert.notEqual(width.url, one.url);
	assert.notEqual(kind.url, one.url);
	assert.equal(state.value.mintStats().entries, 4);
});

test('the mint memo is bounded and evicts the oldest entry', () => {
	const state = cdn({ mintMemoMaxEntries: 2 });
	const mint = tag => state.value.jellyfinUrl({ id, kind: 'Primary', width: 400, tag, scope: 'email:a' });
	const first = mint('tag-v1');
	state.advance(1);
	mint('tag-v2');
	state.advance(1);
	mint('tag-v3');
	const stats = state.value.mintStats();
	assert.equal(stats.entries, 2, 'the hard entry cap is respected');
	assert.equal(stats.maxEntries, 2);
	assert.equal(stats.evictions, 1);
	state.advance(1);
	const reMinted = mint('tag-v1');
	assert.notEqual(reMinted.url, first.url, 'an evicted entry is minted fresh, not resurrected');
	assert.equal(state.value.mintStats().hits, 0);
});

test('two authorization scopes never share one memo entry', () => {
	const state = cdn();
	const a = state.value.jellyfinUrl({ id, kind: 'Primary', width: 400, tag: 'tag-v1', scope: 'email:a' });
	state.advance(1000);
	const b = state.value.jellyfinUrl({ id, kind: 'Primary', width: 400, tag: 'tag-v1', scope: 'email:b' });
	assert.equal(state.value.mintStats().entries, 2, 'each scope keeps its own entry');
	assert.equal(state.value.mintStats().misses, 2);

	// A near-expiry entry from one scope is not handed to another scope.
	state.advance(a.expires - state.now() - 4000);
	const before = state.value.mintStats();
	const later = state.value.jellyfinUrl({ id, kind: 'Primary', width: 400, tag: 'tag-v1', scope: 'email:c' });
	assert.equal(state.value.mintStats().hits, before.hits, 'no cross-scope hit');
	assert.notEqual(later.url, a.url);
	assert.equal(later.expires, state.now() + 300_000, 'the new scope gets a full-lifetime ticket');
});

test('the memo fails closed: no scope means a fresh mint and no shared entry', () => {
	const state = cdn();
	const first = state.value.jellyfinUrl({ id, kind: 'Primary', width: 400, tag: 'tag-v1' });
	state.advance(1000);
	const second = state.value.jellyfinUrl({ id, kind: 'Primary', width: 400, tag: 'tag-v1' });
	assert.notEqual(second.url, first.url, 'without an authorization scope nothing is reused');
	assert.equal(state.value.mintStats().entries, 0);

	state.value.clearMints();
	const scoped = { id, kind: 'Primary', width: 400, tag: 'tag-v1', scope: 'app:fixture' };
	state.value.jellyfinUrl(scoped);
	state.value.jellyfinUrl(scoped);
	assert.equal(state.value.mintStats().entries, 1);
	assert.equal(state.value.mintStats().hits, 1);
});

test('an unauthorized caller mints nothing and stores nothing', async () => {
	const state = cdn();
	const item = { Id: id, Type: 'Movie', ImageTags: { Primary: 'tag-v1' }, BackdropImageTags: ['backdrop-v1'] };
	const denied = await rewriteArtworkResponse(item, {
		cdn: state.value, local: false, authorize: () => false, scope: 'email:a', versioned: true, resolvers: {},
	});
	assert.match(denied.Artwork, VERSION);
	assert.equal(state.value.mintStats().entries, 0, 'a denied caller never populates the memo');
});

test('the signed routing path reuses the memo only when the caller names its scope, and keeps TTLs', async () => {
	const state = cdn();
	const item = { Id: id, Type: 'Movie', ImageTags: { Primary: 'tag-v1' }, BackdropImageTags: ['backdrop-v1'] };
	const once = await rewriteArtworkResponse(item, { cdn: state.value, local: false, authorize: () => true, scope: 'email:a', resolvers: {} });
	state.advance(1000);
	const twice = await rewriteArtworkResponse(item, { cdn: state.value, local: false, authorize: () => true, scope: 'email:a', resolvers: {} });
	assert.equal(twice.Artwork, once.Artwork, 'the same scope reuses the live signed URL');
	assert.notEqual(twice.BackdropArtwork, undefined);
	assert.equal(state.value.mintStats().hits, 2);
	assert.ok(state.value.verify(new URL(once.Artwork).pathname.split('/')[3]));

	state.advance(1000);
	const unscoped = await rewriteArtworkResponse(item, { cdn: state.value, local: false, authorize: () => true, resolvers: {} });
	assert.notEqual(unscoped.Artwork, once.Artwork, 'without a scope every response re-mints');

	assert.equal(state.value.privateTtlMs, 300_000);
	assert.equal(cdn({ privateTtlMs: 1000 }).value.privateTtlMs, 30_000, 'the 30 second floor is unchanged');
	assert.equal(cdn({ privateTtlMs: 60 * 60 * 1000 }).value.privateTtlMs, 15 * 60 * 1000, 'the 15 minute cap is unchanged');
});

test('public metadata artwork keeps its bucket window and is outside the private memo', () => {
	const state = cdn();
	const first = state.value.tmdbUrl({ type: 'movie', id: 603, kind: 'poster', path: '/poster.jpg' });
	state.advance(1000);
	const same = state.value.tmdbUrl({ type: 'movie', id: 603, kind: 'poster', path: '/poster.jpg' });
	assert.equal(same.url, first.url, 'public metadata stays stable inside one bucket');
	const payload = state.value.decode(new URL(first.url).pathname.split('/')[3]);
	assert.ok(payload.e - state.now() > 120_000);
	assert.equal(state.value.mintStats().entries, 0, 'the public path never touches the private memo');
});

test('local library URLs carry a short content version when the caller opts in', async () => {
	const state = cdn();
	const item = { Id: id, Type: 'Movie', ImageTags: { Primary: 'primary-tag-v1' }, BackdropImageTags: ['backdrop-tag-v1'] };
	const versioned = await rewriteArtworkResponse(item, { cdn: state.value, local: true, versioned: true, resolvers: {} });
	assert.match(versioned.Artwork, VERSION);
	assert.ok(versioned.Artwork.startsWith(`/images/${id}/Primary?width=400&v=`));
	assert.match(versioned.BackdropArtwork, VERSION);
	assert.ok(versioned.BackdropArtwork.startsWith(`/images/${id}/Backdrop?width=1280&v=`));

	const again = await rewriteArtworkResponse(item, { cdn: state.value, local: true, versioned: true, resolvers: {} });
	assert.equal(again.Artwork, versioned.Artwork, 'an unchanged tag keeps the same URL');
	const changed = await rewriteArtworkResponse(
		{ ...item, ImageTags: { Primary: 'primary-tag-v2' } },
		{ cdn: state.value, local: true, versioned: true, resolvers: {} },
	);
	assert.notEqual(changed.Artwork, versioned.Artwork, 'a changed tag changes the URL version');

	// Existing shape (and width clamping) is preserved when the caller does not
	// opt in, which is what older callers and their tests rely on.
	const plain = await rewriteArtworkResponse(item, { cdn: state.value, local: true, resolvers: {} });
	assert.equal(plain.Artwork, `/images/${id}/Primary?width=400`);
	const wide = await rewriteArtworkResponse(
		{ ...item, Artwork: `/images/${id}/Primary?width=5000` },
		{ cdn: state.value, local: true, versioned: true, resolvers: {} },
	);
	assert.match(wide.Artwork, new RegExp(`^/images/${id}/Primary\\?width=1920&v=[a-f0-9]{12}$`));

	// No trusted tag means no invented version.
	const untagged = await rewriteArtworkResponse(
		{ Artwork: `/images/${id}/Primary?width=400` },
		{ cdn: state.value, local: true, versioned: true, resolvers: {} },
	);
	assert.equal(untagged.Artwork, `/images/${id}/Primary?width=400`);
});

test('parent backdrops are versioned from the parent item\'s own tag', async () => {
	const state = cdn();
	const episode = {
		Id: id, Type: 'Episode', ImageTags: { Primary: 'episode-primary' },
		ParentBackdropImageTags: ['parent-backdrop-v1'], ParentBackdropItemId: parentId,
	};
	const local = await rewriteArtworkResponse(episode, { cdn: state.value, local: true, versioned: true, resolvers: {} });
	assert.match(local.BackdropArtwork, VERSION);
	assert.ok(local.BackdropArtwork.startsWith(`/images/${parentId}/Backdrop?width=1280&v=`), 'the parent id, not the child id, is the image source');

	// The same route keeps its version when it is rewritten again.
	const routed = await rewriteArtworkResponse(
		{ ...episode, BackdropArtwork: `/images/${parentId}/Backdrop?width=1280` },
		{ cdn: state.value, local: true, versioned: true, resolvers: {} },
	);
	assert.equal(routed.BackdropArtwork, local.BackdropArtwork);
});

test('signed URLs keep their shape: a content version never leaks into a token URL', async () => {
	const state = cdn();
	const item = { Id: id, Type: 'Movie', ImageTags: { Primary: 'tag-v1' }, BackdropImageTags: ['backdrop-v1'] };
	const remote = await rewriteArtworkResponse(item, {
		cdn: state.value, local: false, authorize: () => true, versioned: true, scope: 'email:a', resolvers: {},
	});
	assert.match(remote.Artwork, /^https:\/\/cdn\.example\.test\/tellybox\/art\/[A-Za-z0-9_.-]+\/[a-f0-9]{12}\/image\.jpg$/);
	assert.ok(!remote.Artwork.includes('&v='), 'the signed URL is untouched by the browser cache version');
	assert.match(remote.ArtworkLocal, /^\/tellybox\/art\//);
});
