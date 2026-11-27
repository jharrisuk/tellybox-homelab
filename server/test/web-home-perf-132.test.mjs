/* Release 132: Home fetches its feed once with favourites, and hls.js is only
 * requested when playback starts. Static contract plus a behavioural sandbox
 * around the real loadHomeFeed body.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const appJs = readFileSync(fileURLToPath(new URL('../public/app.js', import.meta.url)), 'utf8');
const indexHtml = readFileSync(fileURLToPath(new URL('../public/index.html', import.meta.url)), 'utf8');

function section(startMarker, endMarker) {
	const start = appJs.indexOf(startMarker);
	assert.notEqual(start, -1, 'missing marker: ' + startMarker);
	const end = appJs.indexOf(endMarker, start);
	assert.notEqual(end, -1, 'missing end marker: ' + endMarker);
	return appJs.slice(start, end);
}

const loadHomeFeedSource = section('async function loadHomeFeed(force = false, { internal = false } = {}) {', '// Continue watching uses a dedicated landscape resume card.');
const loadHomeFeedsSource = section('let sharedFavourites=null', 'async function init() {');
const startPlaybackSource = section('async function startPlayback(item, position = 0, keepSettings = false, options = {}) {', 'video.addEventListener(');
const hlsSource = section('let hlsScriptPromise = null;', 'function playbackCapabilities() {');

function singleFeedSandbox() {
	const calls = [];
	const state = { favourites: null };
	const homeFeedState = {
		data: null, fetchedAt: 0, context: '', loading: false, generation: 0,
		deferred: false, artworkDeferred: false, signature: '', artworkSignature: '',
		settled: false, failed: false, queued: false, queuedInternal: false,
		authReady: true, scope: 'scope', artworkRestartBudget: 1, favouritesSettled: false
	};
	const env = {
		homeFeedState,
		serverFavouritesRequired: true,
		sharedFavourites: null,
		homeFavouritesRequest: Promise.resolve().then(() => {
			state.favourites = ['favourite-show'];
			return { own: { items: [{ Id: 'favourite-show' }] } };
		}),
		isHomeView: () => true,
		homeContextPayload: () => ({ taste: null, favourites: state.favourites ? ['favourite-show'] : [], watched: [], progress: {} }),
		$: () => ({ textContent: '' }),
		api: async (path, payload) => {
			calls.push({ path, payload });
			return { rows: [{ id: 'for-you', items: [{ Id: 'one', Name: 'One' }] }], featured: [], availability: { pending: 0, artwork: { pending: 0, remaining: 0 } } };
		},
		stopHomeArtworkContinuation: () => {},
		renderHomeFeed: () => {},
		hideBootOverlay: () => {},
		bootOverlayError: () => {},
		writeHomeCache: () => {},
		feedAvailabilityPending: () => 0,
		startHomeArtworkContinuation: () => {},
		updateHomeSections: () => {},
		renderHomeFeedError: () => {},
		homeArtworkRestartBudget: 0
	};
	const factory = new Function(...Object.keys(env), loadHomeFeedSource + '\nreturn { loadHomeFeed };');
	return { helpers: factory(...Object.values(env)), homeFeedState, calls, state };
}

test('the first Home request already carries the viewer favourites and is sent once', async () => {
	const sandbox = singleFeedSandbox();
	await sandbox.helpers.loadHomeFeed();
	assert.equal(sandbox.calls.length, 1, 'one feed request, not one without favourites plus a second');
	assert.equal(sandbox.calls[0].path, '/api/web/home');
	assert.deepEqual(sandbox.calls[0].payload.favourites, ['favourite-show']);
	assert.equal(sandbox.homeFeedState.favouritesSettled, true);
});

test('a feed that genuinely started before favourites only rebuilds once', () => {
	assert.match(loadHomeFeedSource, /if \(serverFavouritesRequired && !sharedFavourites && homeFavouritesRequest\) \{/);
	assert.match(loadHomeFeedSource, /if \(favourites\) sharedFavourites = favourites\.own;/);
	assert.equal((appJs.match(/void loadHomeFeed\(true\);/g) || []).length >= 2, true, 'explicit refreshes still exist');
	const init = section('async function init() {', 'void init();');
	assert.equal((init.match(/void loadHomeFeed\(true\);/g) || []).length, 1, 'init has only the conditional reconcile');
	assert.match(init, /if \(feedStartedWithoutFavourites && favourites\) void loadHomeFeed\(true\);/);
});

test('hls.js is not part of the Home page and is loaded once on first play', () => {
	assert.doesNotMatch(indexHtml, /vendor\/hls\.min\.js/, 'Home no longer preloads the 529 KB player bundle');
	assert.match(hlsSource, /script\.src = '\/vendor\/hls\.min\.js';/);
	assert.match(hlsSource, /if \(hlsScriptPromise\) return hlsScriptPromise;/);
	assert.match(startPlaybackSource, /const hlsReady = nativeHlsPreferred\(\) \? Promise\.resolve\(false\) : loadHlsScript\(\)\.catch\(\(\) => false\);/);
	assert.match(startPlaybackSource, /await hlsReady;/);
	// The loader itself has the only script element for this bundle.
	assert.equal((appJs.match(/vendor\/hls\.min\.js/g) || []).length, 1);
});

test('Cast and release lookups are off the initial Home path', () => {
	const setupCast = section('function setupCast() {', 'async function castToTv() {');
	assert.doesNotMatch(setupCast, /api\('\/api\/auth\/tunnel'\)/, 'the Cast tunnel is not fetched at setup');
	assert.match(appJs, /function loadCastSecureLink\(\) \{/);
	assert.match(appJs, /if \(freshOpen\) \{ player\.showModal\(\); loadCastSecureLink\(\); \}/);
	assert.match(loadHomeFeedsSource, /void loadHomeFeed\(\)\.then\(scheduleLikedEpisodes,scheduleLikedEpisodes\);/);
	assert.match(loadHomeFeedsSource, /window\.requestIdleCallback\(run, \{ timeout: 1500 \}\)/);
});
