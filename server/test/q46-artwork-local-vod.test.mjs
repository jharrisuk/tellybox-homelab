/* Q46 regression (Fix 2): local VOD artwork must never resolve a provider logo.
 *
 * Before the fix, `await resolvers.vodLogo(...)` ran before the `local` check in
 * artwork-routing.mjs rewriteRoute, adding serial Dispatcharr round-trips to
 * every local Home response. After the fix, local returns the same-origin route
 * before any resolver await; remote still resolves and signs.
 *
 * Additive to the existing artwork tests, not a duplicate:
 *  - artwork-routing-131.test.mjs already proves a local VOD route is unchanged,
 *    but passes `resolvers: {}`, so it cannot detect a resolver call (it passes
 *    on the pre-fix code too). These tests COUNT resolver calls and prove the
 *    local path never even awaits one (a never-resolving resolver must not hang).
 *  - artwork-cdn-094.test.mjs already proves remote ?v= signing and the
 *    empty-resolver fallback for movies, but not call counts/args, not the
 *    signed token payload, and not authorization gating for VOD routes.
 * Signing uses the real createArtworkCdn with a fixed clock, as in the 094 test.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { rewriteArtworkResponse } from '../artwork-routing.mjs';
import { createArtworkCdn } from '../artwork-cdn.mjs';

const origin = 'https://cdn.example.test';
const secret = 'test-artwork-cdn-secret-0123456789abcdef';
const cdn = () => createArtworkCdn({
	origin, secret, now: () => 1_000_000, bucketMs: 60_000, ttlMs: 600_000, privateArtwork: true
});

function countingResolvers(logo = '88') {
	const calls = { vodLogo: [], tmdbPath: [], tmdbRemember: [], channelLogo: [] };
	return {
		calls,
		resolvers: {
			vodLogo: (...args) => { calls.vodLogo.push(args); return Promise.resolve(logo); },
			tmdbPath: (...args) => { calls.tmdbPath.push(args); return Promise.resolve(''); },
			tmdbRemember: (...args) => { calls.tmdbRemember.push(args); return Promise.resolve(false); },
			channelLogo: (...args) => { calls.channelLogo.push(args); return Promise.resolve(''); }
		}
	};
}

const tokenOf = url => new URL(url).pathname.split('/')[3];
const totalCalls = calls => Object.values(calls).reduce((sum, list) => sum + list.length, 0);

test('a local VOD artwork rewrite leaves every route unchanged and calls the resolver ZERO times', async () => {
	const { calls, resolvers } = countingResolvers();
	const body = {
		rows: [
			{ id: 'series', items: [
				{ Id: 'dispatch-series-9', Type: 'Series', Source: 'streamed',
					Artwork: '/api/web/art/series/9', BackdropArtwork: '/api/web/art/series/9?v=44' },
				{ Id: 'dispatch-movie-77', Type: 'Movie', Source: 'streamed',
					Artwork: '/api/web/art/movie/77?width=400' }
			] },
			{ id: 'continue', items: [
				{ Id: 'dispatch-episode-9-1', Type: 'Episode', Source: 'streamed',
					Artwork: '/api/web/art/episode/123?v=5' }
			] }
		],
		featured: [{ Id: 'dispatch-series-9', Type: 'Series', Source: 'streamed', Artwork: '/api/web/art/series/9?v=44' }]
	};
	const original = structuredClone(body);
	const result = await rewriteArtworkResponse(body, {
		local: true, versioned: true, cdn: cdn(), authorize: () => true, resolvers
	});
	assert.deepEqual(result, original, 'every local VOD route is byte-identical, with or without a version query');
	assert.equal(totalCalls(calls), 0, 'no resolver of any kind is called for a local viewer');
	assert.equal(calls.vodLogo.length, 0, 'the provider logo lookup never runs locally');
	for (const item of [...result.rows.flatMap(row => row.items), ...result.featured]) {
		assert.equal(item.ArtworkLocal, undefined, 'local never records a signed copy');
		assert.equal(item.BackdropArtworkLocal, undefined);
		assert.ok(!String(item.Artwork).includes('cdn.example.test'), 'local never mints a CDN URL');
	}
	assert.deepEqual(body, original, 'the cached feed object is not mutated');
});

test('a local VOD rewrite completes before any resolver await (never-resolving resolver)', { timeout: 5000 }, async () => {
	// If the local check ran after `await resolvers.vodLogo(...)`, this rewrite
	// would hang forever. It must return the unchanged route without awaiting.
	const resolvers = { vodLogo: () => new Promise(() => {}) };
	const body = { items: [{ Id: 'dispatch-series-9', Type: 'Series', Source: 'streamed', Artwork: '/api/web/art/series/9' }] };
	const result = await rewriteArtworkResponse(body, { local: true, versioned: true, cdn: cdn(), authorize: () => true, resolvers });
	assert.equal(result.items[0].Artwork, '/api/web/art/series/9');
});

test('a remote VOD route with a version query signs without calling the resolver', async () => {
	const state = cdn();
	const { calls, resolvers } = countingResolvers();
	for (const kind of ['movie', 'series', 'episode']) {
		const body = { items: [{ Id: `dispatch-${kind}-77`, Type: 'Series', Source: 'streamed', Artwork: `/api/web/art/${kind}/77?v=88` }] };
		const result = await rewriteArtworkResponse(body, { local: false, cdn: state, authorize: () => true, resolvers });
		const item = result.items[0];
		assert.ok(String(item.Artwork).startsWith(origin + '/tellybox/art/'), `${kind} is signed from the query version`);
		const payload = state.verify(tokenOf(item.Artwork));
		assert.ok(payload, 'the minted token is valid');
		assert.equal(payload.p, 'dispatcharr-vod');
		assert.equal(payload.i, '77');
		assert.equal(payload.k, kind);
		assert.equal(payload.t, '88', 'the query version is the signed logo id');
		assert.equal(item.ArtworkLocal, new URL(item.Artwork).pathname, 'the same-origin relative copy is recorded');
	}
	assert.equal(calls.vodLogo.length, 0, 'a version query never needs the resolver');
	assert.equal(totalCalls(calls), 0);
});

test('a remote VOD route without a version calls the resolver once with the expected args and signs when authorized', async () => {
	const state = cdn();
	const { calls, resolvers } = countingResolvers('88');
	const movie = await rewriteArtworkResponse(
		{ items: [{ Id: 'dispatch-movie-77', Type: 'Movie', Source: 'streamed', Artwork: '/api/web/art/movie/77' }] },
		{ local: false, cdn: state, authorize: () => true, resolvers });
	assert.deepEqual(calls.vodLogo, [['movie', '77']], 'exactly one resolver call with (kind, id)');
	assert.ok(String(movie.items[0].Artwork).startsWith(origin + '/tellybox/art/'));
	assert.equal(state.verify(tokenOf(movie.items[0].Artwork)).t, '88', 'the resolved logo id is the signed version');
	const series = await rewriteArtworkResponse(
		{ items: [{ Id: 'dispatch-series-9', Type: 'Series', Source: 'streamed', Artwork: '/api/web/art/series/9' }] },
		{ local: false, cdn: state, authorize: () => true, resolvers });
	assert.deepEqual(calls.vodLogo, [['movie', '77'], ['series', '9']], 'the second item costs exactly one more call');
	assert.equal(state.verify(tokenOf(series.items[0].Artwork)).t, '88');
	// An empty resolver answer keeps the private origin route: no version, no mint.
	const empty = countingResolvers('');
	const unknown = await rewriteArtworkResponse(
		{ items: [{ Id: 'dispatch-movie-77', Type: 'Movie', Source: 'streamed', Artwork: '/api/web/art/movie/77' }] },
		{ local: false, cdn: state, authorize: () => true, resolvers: empty.resolvers });
	assert.equal(unknown.items[0].Artwork, '/api/web/art/movie/77');
	assert.equal(unknown.items[0].ArtworkLocal, undefined);
	assert.deepEqual(empty.calls.vodLogo, [['movie', '77']]);
});

test('authorization still gates VOD minting', async () => {
	const state = cdn();
	const item = () => ({ Id: 'dispatch-series-77', Type: 'Series', Source: 'streamed', Artwork: '/api/web/art/series/77?v=88' });
	// Denied: the version is present but no token may be minted.
	const denied = countingResolvers();
	const deniedResult = await rewriteArtworkResponse({ items: [item()] },
		{ local: false, cdn: state, authorize: () => false, resolvers: denied.resolvers });
	assert.equal(deniedResult.items[0].Artwork, '/api/web/art/series/77?v=88', 'a denied caller stays on the auth-gated origin route');
	assert.equal(deniedResult.items[0].ArtworkLocal, undefined);
	assert.equal(totalCalls(denied.calls), 0, 'a denied caller with a version needs no resolver work');
	// Missing authorize: the version may be discovered, but never minted.
	const noAuth = countingResolvers('88');
	const unauthenticated = await rewriteArtworkResponse(
		{ items: [{ Id: 'dispatch-series-77', Type: 'Series', Source: 'streamed', Artwork: '/api/web/art/series/77' }] },
		{ local: false, cdn: state, resolvers: noAuth.resolvers });
	assert.equal(unauthenticated.items[0].Artwork, '/api/web/art/series/77');
	assert.equal(unauthenticated.items[0].ArtworkLocal, undefined);
	assert.deepEqual(noAuth.calls.vodLogo, [['series', '77']], 'version discovery is not minting');
	// Only a strict `true` authorizes: truthy lookalikes must not mint.
	for (const value of [1, 'yes', {}]) {
		const result = await rewriteArtworkResponse({ items: [item()] },
			{ local: false, cdn: state, authorize: () => value, resolvers: {} });
		assert.equal(result.items[0].Artwork, '/api/web/art/series/77?v=88', `authorize returning ${JSON.stringify(value)} must not mint`);
		assert.equal(result.items[0].ArtworkLocal, undefined);
	}
	// A throwing authorization fails closed: no rewritten response, no mint.
	await assert.rejects(rewriteArtworkResponse({ items: [item()] },
		{ local: false, cdn: state, authorize: () => { throw new Error('permission backend down'); }, resolvers: {} }),
		'authorization errors propagate so the route falls back to the original body');
});

test('authorization receives the item being rewritten (Q46 finding: redundant calls)', async () => {
	// Q46 finding (minor, pre-existing, non-safety): authorize is invoked once
	// per walked object INCLUDING the root container (artwork-routing.mjs:148
	// via walk) and twice per artwork item (rewriteItem:148 + rewriteRoute:71).
	// The initial Q46 expectation of exactly one call per item failed 3 !== 1.
	// Minting is still gated by the item's own strict-true check in rewriteRoute,
	// so this is redundancy, not an authorization hole. The contract asserted
	// here is that the item itself is presented to authorization before minting.
	const state = cdn();
	const seen = [];
	const body = { items: [{ Id: 'dispatch-series-77', Type: 'Series', Source: 'streamed', Artwork: '/api/web/art/series/77?v=88' }] };
	const allowed = await rewriteArtworkResponse(body,
		{ local: false, cdn: state, authorize: entry => { seen.push(entry); return true; }, resolvers: {} });
	const itemChecks = seen.filter(entry => entry?.Id === 'dispatch-series-77');
	assert.ok(itemChecks.length >= 1, 'the item being minted is presented to authorization');
	assert.ok(String(allowed.items[0].Artwork).startsWith(origin + '/tellybox/art/'));
	// Denying ONLY the item (container still allowed) must still block the mint.
	const itemDenied = await rewriteArtworkResponse(body,
		{ local: false, cdn: state, authorize: entry => entry?.Id !== 'dispatch-series-77', resolvers: {} });
	assert.equal(itemDenied.items[0].Artwork, '/api/web/art/series/77?v=88', 'the item-level decision gates minting');
	assert.equal(itemDenied.items[0].ArtworkLocal, undefined);
});

test('local never mints even when authorized, and remote without a usable CDN keeps the origin route', async () => {
	const state = cdn();
	const body = () => ({ items: [{ Id: 'dispatch-series-77', Type: 'Series', Source: 'streamed', Artwork: '/api/web/art/series/77?v=88' }] });
	const { calls, resolvers } = countingResolvers();
	const local = await rewriteArtworkResponse(body(), { local: true, versioned: true, cdn: state, authorize: () => true, resolvers });
	assert.equal(local.items[0].Artwork, '/api/web/art/series/77?v=88', 'an authorized local viewer still keeps the same-origin route');
	assert.equal(local.items[0].ArtworkLocal, undefined);
	assert.equal(totalCalls(calls), 0);
	const disabled = createArtworkCdn({ origin: '', secret });
	const noCdn = await rewriteArtworkResponse(body(), { local: false, cdn: disabled, authorize: () => true, resolvers: {} });
	assert.equal(noCdn.items[0].Artwork, '/api/web/art/series/77?v=88', 'a disabled CDN mints nothing');
	const absent = await rewriteArtworkResponse(body(), { local: false, authorize: () => true, resolvers: {} });
	assert.equal(absent.items[0].Artwork, '/api/web/art/series/77?v=88', 'no CDN object mints nothing');
});
