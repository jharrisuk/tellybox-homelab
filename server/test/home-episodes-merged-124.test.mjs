// Regression for the HOME-124 merged-GUID proof: a canonical local series GUID
// only ran a Jellyfin ParentId query, so the VOD-only episode that the streamed
// alias returned was missing from the canonical answer. Both ids now read the
// merged library list, keeping real identity and local priority.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHomeEpisodeLookup, homeEpisodeAdmissionState } from '../home-episodes.mjs';
import { mergeEpisodes } from '../vod-library.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Exact ids from outputs/HOME-124-MERGED-GUID-PROOF.json.
const canonical = 'a'.repeat(32);
const alias = 'dispatch-series-9';
const localEpisodeId = 'b'.repeat(32);
const vodOnlyEpisodeId = 'dispatch-episode-2-9';

const series = { Id: canonical, Name: 'Dispatch', Type: 'Series', Source: 'local', VodIds: [9] };
const localEpisode = (overrides = {}) => ({
	Id: localEpisodeId, Name: 'Dispatch S2E8', Type: 'Episode',
	ParentIndexNumber: 2, IndexNumber: 8, PremiereDate: '2026-10-01T00:00:00Z',
	RunTimeTicks: 1800e7, ImageTags: { Primary: 'local-tag' }, UserData: { Played: true }, ...overrides
});
const vodEpisode = (overrides = {}) => ({
	Id: vodOnlyEpisodeId, Name: 'Dispatch S2E9', Type: 'Episode', Source: 'streamed',
	Artwork: '/api/web/art/series/9', ParentIndexNumber: 2, IndexNumber: 9,
	PremiereDate: '2026-10-02T00:00:00Z', RunTimeTicks: 1800e7, VodIds: [9], ...overrides
});

function fixtureLibrary(items) {
	const calls = [];
	return { calls, episodes: async id => { calls.push(id); return { items }; } };
}

test('the proof canonical GUID returns the merged local and VOD-only episodes', async () => {
	const merged = mergeEpisodes([localEpisode()], [vodEpisode()], series);
	const library = fixtureLibrary(merged);
	const jellyRoutes = [];
	const lookup = createHomeEpisodeLookup({
		userId: 'user-1', timeoutMs: 1000, library,
		jelly: async route => { jellyRoutes.push(route); return { Items: [] }; }
	});

	const viaLocal = await lookup([canonical]);
	assert.deepEqual(viaLocal.map(item => item.Id), [vodOnlyEpisodeId, localEpisodeId],
		'the canonical lookup returns both episodes, newest first');
	assert.equal(jellyRoutes.length, 0, 'no scoped Jellyfin fallback is needed for an indexed local series');
	assert.equal(library.calls.length, 1, 'one library read for the canonical id');

	for (const item of viaLocal) {
		assert.equal(item.SeriesId, canonical, 'the real canonical series id is preserved');
		assert.equal(item.SeriesName, 'Dispatch', 'the real series name is preserved');
	}
	const local = viaLocal.find(item => item.Id === localEpisodeId);
	const vodOnly = viaLocal.find(item => item.Id === vodOnlyEpisodeId);
	assert.equal(local.Source, 'local', 'local source identity survives the merge');
	assert.equal(vodOnly.Source, 'streamed', 'the VOD-only episode keeps its streamed identity');
	assert.equal(vodOnly.Artwork, '/api/web/art/series/9');
	assert.deepEqual(local.UserData, { Played: true }, 'the local service-account state is not invented away here (the route strips it)');

	// The streamed alias keeps returning the same merged list.
	const viaAlias = await lookup([alias]);
	assert.deepEqual(viaAlias.map(item => item.Id), viaLocal.map(item => item.Id));
	assert.deepEqual(library.calls, [canonical, alias], 'each requested id costs exactly one library read');
});

test('a local copy wins a shared episode number without losing the VOD-only episode', async () => {
	const localCopy = localEpisode({ Id: 'c'.repeat(32), Name: 'Dispatch S2E9', IndexNumber: 9, PremiereDate: '2026-10-03T00:00:00Z' });
	const merged = mergeEpisodes([localEpisode(), localCopy], [vodEpisode()], series);
	const sameNumber = merged.filter(item => item.ParentIndexNumber === 2 && item.IndexNumber === 9);
	assert.equal(sameNumber.length, 1, 'the merged list holds one episode per season/episode');
	assert.equal(sameNumber[0].Id, localCopy.Id, 'the local copy has priority');
	assert.equal(sameNumber[0].Source, 'local');

	const library = fixtureLibrary(merged);
	const lookup = createHomeEpisodeLookup({ userId: 'user-1', timeoutMs: 1000, library, jelly: async () => ({ Items: [] }) });
	const result = await lookup([canonical]);
	assert.deepEqual(result.map(item => item.Id), [localCopy.Id, localEpisodeId]);
	assert.equal(result.some(item => item.Id === vodOnlyEpisodeId), false, 'the merged duplicate is replaced by the local copy, not duplicated');
});

test('a library miss falls back to one scoped ParentId query without duplicates', async () => {
	const routes = [];
	const lookup = createHomeEpisodeLookup({
		userId: 'user-1', timeoutMs: 1000,
		library: { episodes: async () => { throw new Error('not indexed'); } },
		jelly: async route => {
			routes.push(route);
			return { Items: [
				{ ...localEpisode({ Name: 'Pilot' }), SeriesName: 'Dispatch' },
				{ ...localEpisode({ Name: 'Pilot' }), SeriesName: 'Dispatch' }
			] };
		}
	});
	const result = await lookup([canonical]);
	assert.deepEqual(result.map(item => item.Id), [localEpisodeId]);
	assert.equal(routes.length, 1, 'exactly one scoped fallback query');
	const params = new URL(routes[0], 'http://fixture').searchParams;
	assert.equal(params.get('ParentId'), canonical);
	assert.equal(params.get('IncludeItemTypes'), 'Episode');
	assert.equal(params.get('Recursive'), 'true');

	// A library that answers with an empty list is also a miss, and the scoped
	// query keeps the answer truthful rather than inventing an episode.
	const emptyRoutes = [];
	const emptyLookup = createHomeEpisodeLookup({
		userId: 'user-1', timeoutMs: 1000,
		library: { episodes: async () => ({ items: [] }) },
		jelly: async route => { emptyRoutes.push(route); return { Items: [] }; }
	});
	assert.deepEqual(await emptyLookup([canonical]), []);
	assert.equal(emptyRoutes.length, 1);
});

test('one failing library series does not lose the other merged series', async () => {	const otherCanonical = 'd'.repeat(32);
	const merged = mergeEpisodes([localEpisode()], [vodEpisode()], series);
	const lookup = createHomeEpisodeLookup({
		userId: 'user-1', timeoutMs: 1000,
		library: {
			episodes: async id => {
				if (id === otherCanonical) throw new Error('unavailable');
				return { items: merged };
			}
		},
		jelly: async route => {
			const params = new URL(route, 'http://fixture').searchParams;
			if (params.get('ParentId') === otherCanonical) throw new Error('Jellyfin is unavailable');
			return { Items: [] };
		}
	});
	const result = await lookup([otherCanonical, canonical]);
	assert.deepEqual(result.map(item => item.Id), [vodOnlyEpisodeId, localEpisodeId],
		'the healthy merged series is still returned');
});

// LATE-FALLBACK-PROOF: the caller returned at 264ms but the library missed at
// 609ms and a new Jellyfin fallback started afterwards. A miss after the
// deadline must stay an empty group, and the slot stays tied to the library
// call until it actually settles.
test('a library miss that settles after the deadline starts no fallback', async () => {
	const routes = [];
	const lookup = createHomeEpisodeLookup({
		userId: 'user-1', timeoutMs: 250,
		library: { episodes: async () => { await sleep(600); return { items: [] }; } },
		jelly: async route => { routes.push(route); return { Items: [] }; }
	});
	const started = Date.now();
	const result = await lookup([canonical]);
	const elapsed = Date.now() - started;

	assert.deepEqual(result, [], 'an unfinished library miss is not a fabricated episode');
	assert.ok(elapsed < 550, 'the caller leaves at its own deadline, took ' + elapsed + 'ms');
	assert.equal(homeEpisodeAdmissionState().active, 1, 'the slot is still held by the late library read');

	await sleep(450);
	assert.equal(routes.length, 0, 'no Jellyfin fallback starts after the request deadline');
	assert.equal(homeEpisodeAdmissionState().active, 0, 'the slot is released when the late read settles');

	// A library miss that still has time left may fall back, proving the check
	// is a deadline bound rather than a blanket removal.
	const inTime = [];
	const quickLookup = createHomeEpisodeLookup({
		userId: 'user-1', timeoutMs: 1000,
		library: { episodes: async () => ({ items: [] }) },
		jelly: async route => { inTime.push(route); return { Items: [] }; }
	});
	assert.deepEqual(await quickLookup([canonical]), []);
	assert.equal(inTime.length, 1);
});
