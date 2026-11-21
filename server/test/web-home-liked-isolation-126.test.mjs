/* Release 126: the "New episodes of your shows" rail is per-account.
 *
 * Browser-local series markers (`tellybox-series-*`) and Like/Not for me votes
 * (`tellybox-taste`) belong to whoever last watched in this browser profile.
 * A signed-in remote account must build the rail from its server-synced
 * favourites only; a local or at-home viewer keeps today's behaviour.
 *
 * These checks run the real functions out of public/app.js in a small
 * sandbox with fake storage, so they exercise the gate itself rather than a
 * copy of it. The real Chrome harness remains the end-to-end proof.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const appJs = readFileSync(fileURLToPath(new URL('../public/app.js', import.meta.url)), 'utf8');

function section(startMarker, endMarker) {
	const start = appJs.indexOf(startMarker);
	assert.notEqual(start, -1, 'missing marker: ' + startMarker);
	const end = appJs.indexOf(endMarker, start);
	assert.notEqual(end, -1, 'missing end marker: ' + endMarker);
	return appJs.slice(start, end);
}

const trustSource = section('const browserProgress =', 'const coming =');
const likedSource = section('function likedSeriesIds() {', 'function watchedLocally(id) {');

function fakeStorage(entries = []) {
	const map = new Map(entries);
	const reads = { key: 0, getItem: 0 };
	return {
		reads,
		get length() { return map.size; },
		key(index) { reads.key += 1; return [...map.keys()][index] ?? null; },
		getItem(key) { reads.getItem += 1; return map.has(key) ? String(map.get(key)) : null; },
	};
}

function sandbox(entries, favourites) {
	const factory = new Function('localStorage', 'readFavourites',
		trustSource + likedSource + '\nreturn { browserProgress, browserProgressTrusted, trustBrowserProgress, likedEpisodesState, likedSeriesIds };');
	const storage = fakeStorage(entries);
	const api = factory(storage, () => favourites);
	return { storage, ...api };
}

const favourites = {
	fav: { Id: 'fav', Name: 'Favourite Show', Type: 'Series' },
	dislikedFavourite: { Id: 'dislikedFavourite', Name: 'Disliked Favourite', Type: 'Series' },
	movie: { Id: 'movie', Name: 'A Film', Type: 'Movie' },
};

function seeded(entries) {
	return sandbox(entries, favourites);
}

const localEntries = [
	['tellybox-series-local-show', 'episode-1'],
	['tellybox-series-aliasDisliked', 'episode-2'],
	['tellybox-taste', JSON.stringify({
		votes: {
			likedByVote: { value: 1 },
			dislikedFavourite: { value: -1 },
			aliasDisliked: { value: -1, watchId: 'aliasDisliked' },
		},
	})],
];

test('a remote account builds liked shows from server favourites only', () => {
	const view = seeded(localEntries);
	// No /api/auth/status yet is untrusted, exactly like a remote account. The
	// previous viewer's negative vote is ignored, so the server favourite stays.
	assert.equal(view.browserProgressTrusted(), false);
	assert.deepEqual([...view.likedSeriesIds()].sort(), ['dislikedFavourite', 'fav']);
	assert.equal(view.storage.reads.key, 0, 'browser series keys are never scanned for a remote account');
	assert.equal(view.storage.reads.getItem, 0, 'browser taste votes are never read for a remote account');

	view.trustBrowserProgress({ local: false, home: false, authenticated: true, email: 'remote@example.invalid' });
	assert.deepEqual([...view.likedSeriesIds()].sort(), ['dislikedFavourite', 'fav'], 'a confirmed remote status keeps only server favourites');
});

test('a local or at-home viewer keeps watch markers, votes and dislike filtering', () => {
	const view = seeded(localEntries);
	view.trustBrowserProgress({ local: true, home: false });
	assert.deepEqual([...view.likedSeriesIds()].sort(),
		['fav', 'likedByVote', 'local-show'],
		'local series keys and positive votes add shows; negative votes remove them');
	assert.ok(view.storage.reads.key > 0);
	assert.ok(view.storage.reads.getItem > 0);
});

test('the liked-series rail is dropped and reloaded when trust changes', () => {
	const view = seeded(localEntries);
	view.likedEpisodesState.key = 'previous-account|shows';
	view.likedEpisodesState.items = [{ Id: 'episode-from-previous-account' }];
	view.likedEpisodesState.loaded = true;
	view.likedEpisodesState.loading = true;
	view.likedEpisodesState.failed = false;
	view.likedEpisodesState.generation = 7;

	view.trustBrowserProgress({ local: true, home: false });
	assert.equal(view.likedEpisodesState.generation, 8, 'a newer generation makes a late response stale');
	assert.equal(view.likedEpisodesState.key, '');
	assert.deepEqual(view.likedEpisodesState.items, []);
	assert.equal(view.likedEpisodesState.loaded, false);
	assert.equal(view.likedEpisodesState.loading, false);
	assert.equal(view.likedEpisodesState.failed, false);

	// Repeating the same status must not invalidate the current account again.
	view.trustBrowserProgress({ local: true, home: false });
	assert.equal(view.likedEpisodesState.generation, 8);
});

test('the trust gate precedes every browser-local liked-show read', () => {
	assert.ok(likedSource.includes('if (!browserProgressTrusted()) return liked;'));
	assert.ok(likedSource.indexOf('browserProgressTrusted()') < likedSource.indexOf("startsWith('tellybox-series-')"));
	assert.ok(likedSource.indexOf('browserProgressTrusted()') < likedSource.indexOf("getItem('tellybox-taste')"));
	assert.match(trustSource, /likedEpisodesState\.generation \+= 1;/);
	assert.match(trustSource, /if \(homeFeedsStarted && isHomeView\(\)\) void loadLikedEpisodes\(\)\.catch\(\(\) => \{\}\);/);
});
