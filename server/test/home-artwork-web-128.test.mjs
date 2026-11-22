/* Release 128 owner B: Home artwork refresh checks.
 *
 * Static and structural checks over the public frontend, plus a small
 * behavioural sandbox for pendingAvailability and homeArtworkSignature.
 * No server, browser or network is needed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const publicFile = name => fileURLToPath(new URL('../public/' + name, import.meta.url));
const appJs = readFileSync(publicFile('app.js'), 'utf8');
const fallbackJs = readFileSync(publicFile('artwork-fallback.js'), 'utf8');
const indexHtml = readFileSync(publicFile('index.html'), 'utf8');

function section(startMarker, endMarker) {
	const start = appJs.indexOf(startMarker);
	assert.notEqual(start, -1, 'missing marker: ' + startMarker);
	const end = appJs.indexOf(endMarker, start);
	assert.notEqual(end, -1, 'missing end marker: ' + endMarker);
	return appJs.slice(start, end);
}

const cardSource = section('function card(item, releaseDate = false, options = {}) {', 'function anotherPick() {');
const continueTileSource = section('function homeContinueTile(item) {', 'function homeTile(item) {');
const renderSource = section('function renderHomeFeed() {', 'function isHomeView() {');
const refreshSource = section('async function refreshHomeFeedAvailability(', '// ---------------------------------------------------------------------------\n// Viewport stability helpers');
const rehydrateSource = section('function rehydrateHomeArtwork(data) {', '// A single compact skeleton');

test('pendingAvailability counts both item and artwork verification', () => {
	const source = section('function pendingAvailability(data) {', 'let guideData = null;');
	const pendingAvailability = new Function(source + '\nreturn pendingAvailability;')();
	assert.equal(pendingAvailability({ availability: { pending: 2 } }), 2);
	assert.equal(pendingAvailability({ availability: { pending: 2, artwork: { pending: 3 } } }), 5);
	assert.equal(pendingAvailability({ availability: { artwork: { pending: 4 } } }), 4);
	assert.equal(pendingAvailability({ availability: { artwork: { pending: 0 } } }), 0);
	assert.equal(pendingAvailability({}), 0);
	assert.equal(pendingAvailability(null), 0);
	assert.equal(pendingAvailability({ availability: { pending: -1, artwork: { pending: -2 } } }), 0);
	assert.equal(pendingAvailability({ availability: { pending: 'x', artwork: { pending: 'y' } } }), 0);
});

test('homeArtworkSignature tracks row identity and artwork fields only', () => {
	const rowsSource = section('function orderedHomeRows(data) {', '// Swap only the Home card images');
	const artworkSource = section('function homeArtworkSignature(data) {', 'function likedEpisodesSignature() {');
	const feedSource = section('function homeFeedSignature(data) {', '// Artwork can resolve');
	const factory = new Function('homeRowOrder', 'homeRowAllowed', 'newEpisodesRowData',
		rowsSource + artworkSource + feedSource
		+ '\nreturn { homeArtworkSignature, homeFeedSignature };');
	const helpers = factory(
		{ 'continue': 0, 'new-episodes': 1, 'for-you': 2, 'new': 3 },
		new Set(['continue', 'new-episodes', 'for-you', 'new']),
		() => null,
	);
	const data = {
		rows: [
			{ id: 'continue', items: [{ Id: 'ep1', Name: 'Episode', BackdropArtwork: '/images/ep1/Backdrop?width=640' }] },
			{ id: 'new', items: [{ Id: 'm1', Name: 'Film', Artwork: '/api/web/art/movie/m1' }] },
		],
	};
	const before = helpers.homeArtworkSignature(data);
	const feedBefore = helpers.homeFeedSignature(data);
	assert.match(before, /continue=ep1~~\/images\/ep1\/Backdrop\?width=640/);
	assert.match(before, /new=m1~\/api\/web\/art\/movie\/m1~/);
	assert.equal(helpers.homeArtworkSignature(null), '');
	assert.equal(helpers.homeArtworkSignature({}), '');

	data.rows[1].items[0].Artwork = '/api/web/tmdb-art/m1/poster.jpg';
	const after = helpers.homeArtworkSignature(data);
	assert.notEqual(after, before, 'resolved artwork changes the artwork signature');
	assert.equal(helpers.homeFeedSignature(data), feedBefore, 'the row signature is unchanged by artwork alone');
	assert.notEqual(helpers.homeArtworkSignature({ rows: [{ id: 'new', items: [{ Id: 'm2', Name: 'Second' }] }] }), '', 'known rows still contribute');

	data.rows[0].items[0].BackdropArtwork = '/images/ep1/Backdrop?width=640&v=abc';
	assert.notEqual(helpers.homeArtworkSignature(data), after, 'the continue backdrop is covered');
});

test('Home state and every render record the artwork signature', () => {
	assert.match(appJs, /const homeFeedState = \{[^}]*artworkSignature: ''/);
	assert.match(appJs, /homeFeedState\.artworkSignature = homeArtworkSignature\(data\);/);
	assert.match(renderSource, /homeFeedState\.artworkSignature = homeArtworkSignature\(data\);/);
});

test('cards and continue cards expose data-tellybox-item for identity-safe rehydration', () => {
	assert.match(cardSource, /button\.dataset\.tellyboxItem = item\.Id;/);
	assert.match(continueTileSource, /button\.dataset\.tellyboxItem = item\.Id;/);
	assert.match(rehydrateSource, /holder\.dataset\.tellyboxItem/);
	assert.match(rehydrateSource, /querySelectorAll\('\[data-tellybox-item\]'\)/);
});

test('a failed card image is hidden for reuse instead of removed', () => {
	const helper = section('function hideFailedArtwork(image) {', 'function card(item, releaseDate = false, options = {}) {');
	assert.match(helper, /image\.hidden = true;/);
	assert.match(helper, /image\.dataset\.tellyboxFailed = '1';/);
	assert.match(cardSource, /image\.addEventListener\('error', artworkErrorMessage\(image\)\)/);
	assert.doesNotMatch(cardSource, /image\.remove\(\)/, 'the card keeps the element so it can be rehydrated');
	assert.match(continueTileSource, /image\.addEventListener\('error', \(\) => \{/);
	assert.match(continueTileSource, /hideFailedArtwork\(image\)/);
	assert.doesNotMatch(continueTileSource, /image\.remove\(\)/, 'the continue image is hidden, not dropped');
});

test('rehydrateHomeArtwork updates changed images in place and restarts the fallback chain', () => {
	assert.match(rehydrateSource, /if \(!data \|\| !isHomeView\(\)\) return 0;/);
	assert.match(rehydrateSource, /details\.open \|\| player\.open \|\| state\.session \|\| casting\.active/);
	assert.match(rehydrateSource, /const items = new Map\(\);/);
	assert.match(rehydrateSource, /if \(!item\) continue;/, 'unknown ids are skipped, never guessed');
	assert.match(rehydrateSource, /const resume = holder\.classList\.contains\('continue-card'\)/);
	assert.match(rehydrateSource, /const width = resume \? 640 : 400;/);
	assert.match(rehydrateSource, /imageUrl\(item, resume, width\)/);
	assert.match(rehydrateSource, /\(image\.getAttribute\('src'\) \|\| ''\) === source/);
	assert.match(rehydrateSource, /delete image\.dataset\.tellyboxLocal;/);
	assert.match(rehydrateSource, /delete image\.dataset\.tellyboxPoster;/);
	assert.match(rehydrateSource, /delete image\.dataset\.tellyboxFallback;/);
	assert.match(rehydrateSource, /delete image\.dataset\.tellyboxArtworkStage;/);
	assert.match(rehydrateSource, /delete image\.dataset\.tellyboxFailed;/);
	assert.match(rehydrateSource, /image\.hidden = false;/);
	assert.match(rehydrateSource, /setArtwork\(image, item, resume, width\);/);
	assert.match(rehydrateSource, /image\.loading = 'lazy';/);
	assert.match(rehydrateSource, /image\.decoding = 'async';/);
	assert.match(rehydrateSource, /image\.alt = '';/);
	assert.match(rehydrateSource, /if \(resume\) holder\.prepend\(image\);/);
	assert.match(rehydrateSource, /fallback\.after\(image\)/, 'a normal card image sits after the fallback');
	assert.match(rehydrateSource, /return updated;/);
});

test('refresh rehydrates artwork-only changes without rebuilding rows', () => {
	assert.match(refreshSource, /const artworkSignature = homeArtworkSignature\(data\);/);
	assert.match(refreshSource, /if \(artworkSignature !== homeFeedState\.artworkSignature\) \{/);
	assert.match(refreshSource, /rehydrateHomeArtwork\(data\);/);
	assert.ok(refreshSource.indexOf('rehydrateHomeArtwork(data);') < refreshSource.indexOf('applyHomeFeedStatus(data);'), 'the status applies after the in-place update');
	assert.match(refreshSource, /if \(signature === homeFeedState\.signature\) \{/);
	assert.match(refreshSource, /\} else \{\n\t\trenderHomeFeed\(\);\n\t\}/, 'a changed row signature still re-renders');
	assert.match(refreshSource, /if \(!details\.open && !player\.open && !state\.session && !casting\.active && isHomeView\(\)\) homeFeedState\.artworkSignature = artworkSignature;/, 'a deferred pass leaves the signature for later');
});

test('Home keeps the existing two-attempt bound with no new polling loop', () => {
	assert.match(appJs, /const homeAvailabilityRetryLimit = 2;/);
	assert.equal((refreshSource.match(/refreshHomeFeedAvailability\(generation, context, attempt \+ 1\)/g) || []).length, 1, 'one bounded recursive retry');
	assert.match(refreshSource, /if \(attempt > homeAvailabilityRetryLimit\) return;/);
	assert.match(refreshSource, /if \(attempt >= homeAvailabilityRetryLimit\)/);
	assert.doesNotMatch(refreshSource, /setInterval|while \(/);
});

test('a deferred artwork pass is applied in place when the viewer returns Home', () => {
	assert.match(rehydrateSource, /homeFeedState\.artworkDeferred = true;/);
	assert.match(appJs, /function applyDeferredHomeArtwork\(\) \{/);
	assert.match(appJs, /if \(details\.open \|\| player\.open \|\| state\.session \|\| casting\.active\) return 0;/);
	assert.match(appJs, /details\.addEventListener\('close', \(\) => \{\n\tif \(homeFeedState\.deferred\) renderHomeFeed\(\);\n\telse applyDeferredHomeArtwork\(\);/);
	assert.match(appJs, /player\.addEventListener\('close', \(\) => \{\n\tif \(homeFeedState\.deferred\) renderHomeFeed\(\);\n\telse applyDeferredHomeArtwork\(\);/);
	assert.match(appJs, /homeFeedState\.artworkSignature = signature;/);
});

test('artwork-fallback keeps its staged local -> poster -> card order', () => {
	assert.match(fallbackJs, /if \(stage === 'local'\) return \[image\.dataset\.tellyboxPoster\];/);
	assert.match(fallbackJs, /if \(stage === 'poster'\) return \[\];/);
	assert.match(fallbackJs, /return \[image\.dataset\.tellyboxLocal, image\.dataset\.tellyboxPoster\];/);
	assert.ok(fallbackJs.indexOf("dataset.tellyboxLocal, image.dataset.tellyboxPoster") < fallbackJs.indexOf("delete image.dataset.tellyboxFallback"), 'the card handler only runs after both stages');
	assert.match(fallbackJs, /addEventListener\('error'/);
	assert.match(fallbackJs, /\}, true\);/);
	assert.doesNotMatch(fallbackJs, /fetch\(|XMLHttpRequest|Cache-Control/, 'the fallback stays a client-only staged retry');
});

test('the page shell adds no stylesheet, inline script or external origin', () => {
	const stylesheets = [...indexHtml.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="\/([^"?]+)/g)].map(match => match[1]);
	assert.deepEqual(stylesheets, ['style.css', 'home-124.css']);
	for (const name of stylesheets) assert.ok(existsSync(publicFile(name)), 'missing stylesheet ' + name);
	const scripts = [...indexHtml.matchAll(/<script[^>]+src="\/([^"?]+)/g)].map(match => match[1]);
	for (const name of scripts) {
		if (name.startsWith('vendor/')) continue;
		assert.ok(existsSync(publicFile(name)), 'missing script ' + name);
	}
	assert.equal([...indexHtml.matchAll(/<script(?![^>]*\bsrc=)[^>]*>/g)].length, 1, 'the existing single inline Home-pending script stays alone');
	assert.doesNotMatch(indexHtml, /https?:\/\//, 'no external origin in the page shell');
	assert.doesNotMatch(fallbackJs, /https?:\/\//, 'no external origin in the fallback script');
});
