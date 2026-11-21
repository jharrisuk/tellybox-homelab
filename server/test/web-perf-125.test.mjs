/* Release 125 owner B: web loading/render/request checks.
 *
 * These are static and structural checks plus a small behavioural sandbox for
 * the artwork helpers. They do not need a server or a browser.
 *
 * Covered:
 *  - Home defers the collection fetch/render (no hidden collection page).
 *  - Home still loads its own feed and the liked-series lookup first.
 *  - Local artwork gets 1x/2x candidates at the display width it asks for.
 *  - Supplied Artwork/BackdropArtwork (signed) URLs are never rewritten and
 *    never get a competing srcset.
 *  - Card artwork keeps lazy loading and async decoding.
 *  - index.html references only files that exist; no new stylesheet or inline
 *    script was added.
 *  - The public asset allowlist only names files that exist.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PUBLIC_CDN_ASSETS } from '../public-assets.mjs';

const publicFile = name => fileURLToPath(new URL('../public/' + name, import.meta.url));
const appJs = readFileSync(publicFile('app.js'), 'utf8');
const indexHtml = readFileSync(publicFile('index.html'), 'utf8');

function section(startMarker, endMarker) {
	const start = appJs.indexOf(startMarker);
	assert.notEqual(start, -1, 'missing marker: ' + startMarker);
	const end = appJs.indexOf(endMarker, start);
	assert.notEqual(end, -1, 'missing end marker: ' + endMarker);
	return appJs.slice(start, end);
}

const loadItemsSource = section('async function loadItems(append = false) {', 'let nonstopData = null');
const continueTileSource = section('function homeContinueTile(item) {', 'function homeTile(item) {');

function fakeImage() {
	const attributes = new Map();
	return {
		dataset: {},
		src: '',
		setAttribute(name, value) { attributes.set(name, String(value)); },
		getAttribute(name) { return attributes.has(name) ? attributes.get(name) : null; },
		removeAttribute(name) { attributes.delete(name); },
		attributes,
	};
}

const artworkHelpers = (() => {
	const source = section('function imageUrl(item, backdrop = false, width = 400) {', '// A channel logo leads the identity');
	const factory = new Function('document', 'location', source + '\nreturn { imageUrl, localImageUrl, setArtwork, localArtworkSrcset, localArtworkWidth, localArtworkRoute };');
	return factory({}, { origin: 'http://127.0.0.1' });
})();

test('Home defers the collection fetch: no collection page is requested for the Home view', () => {
	const homeFeeds = loadItemsSource.indexOf('if (isHomeView()) loadHomeFeeds();');
	const guard = loadItemsSource.indexOf('if (isHomeView()) {');
	const generation = loadItemsSource.indexOf('const generation = ++state.generation;');
	const collectionRequest = loadItemsSource.indexOf("'/api/web/items?'");
	assert.notEqual(homeFeeds, -1, 'Home must still start its own feeds');
	assert.notEqual(guard, -1, 'loadItems must defer on the Home view');
	assert.ok(guard > homeFeeds, 'the Home feed starts before the collection deferral');
	assert.ok(generation > guard, 'the deferred return happens before a collection generation is created');
	assert.ok(collectionRequest > generation, 'the collection request is after the deferral');
	assert.match(loadItemsSource.slice(guard, generation), /\$\('#loadMore'\)\.hidden = true;/, 'the hidden pager state is kept consistent');
});

test('Home keeps its liked-series lookup and does not render the hidden collection', () => {
	// Home starts the feed immediately and defers the liked-series lookup until
	// the first rows are on screen; the collection deferral must not sit in front.
	assert.match(appJs, /function loadHomeFeeds\(\)\{if\(homeFeedsStarted\)return;homeFeedsStarted=true;void loadHomeFeed\(\)\.then\(scheduleLikedEpisodes,scheduleLikedEpisodes\);\}/);
	assert.match(appJs, /function scheduleLikedEpisodes\(\) \{/);
	assert.match(appJs, /window\.requestIdleCallback\(run, \{ timeout: 1500 \}\)/);
	assert.equal(loadItemsSource.includes("$('#grid').replaceChildren"), true, 'the collection grid render still exists for collection views');
	const guard = loadItemsSource.indexOf('if (isHomeView()) {');
	const requestParams = loadItemsSource.indexOf('const params = new URLSearchParams');
	assert.ok(guard < requestParams, 'the Home deferral happens before the collection request is prepared');
	// Home rows never reuse the collection grid.
	const renderHomeFeed = section('function renderHomeFeed() {', 'function isHomeView() {');
	assert.doesNotMatch(renderHomeFeed, /#grid/);
});

test('the collection surface is reserved for one screen while a collection view is visible', () => {
	const update = section('function updateHomeSections() {', 'function itemsHasMore(data) {');
	const hide = update.indexOf('collection.hidden = home;');
	const reserve = update.indexOf("collection.style.minHeight = home ? '' : '100vh'");
	assert.notEqual(hide, -1, 'the collection is still hidden on Home');
	assert.notEqual(reserve, -1, 'the collection surface is reserved off Home');
	assert.ok(reserve > hide, 'the reservation is applied when the collection becomes visible');
	assert.doesNotMatch(update, /minHeight = '100vh';/, 'Home never keeps a reserved gap');
});

test('local poster artwork asks for the display width with a 2x candidate', () => {
	const image = fakeImage();
	const item = { Id: 'abc', Name: 'Low Tide', Type: 'Movie', Artwork: '' };
	artworkHelpers.setArtwork(image, item);
	assert.equal(image.src, '/images/abc/Primary?width=400');
	assert.equal(image.getAttribute('srcset'), '/images/abc/Primary?width=400 1x, /images/abc/Primary?width=800 2x');
	assert.equal(image.getAttribute('sizes'), null, 'fixed-size artwork uses x descriptors, not sizes');
	assert.equal(image.dataset.tellyboxLocal, '/images/abc/Primary?width=400');
});

test('Continue artwork asks for 640 with a 1280 2x candidate', () => {
	const image = fakeImage();
	const item = { Id: 'abc', Name: 'Low Tide', Type: 'Movie', Artwork: '' };
	artworkHelpers.setArtwork(image, item, true, 640);
	assert.equal(image.src, '/images/abc/Backdrop?width=640');
	assert.equal(image.getAttribute('srcset'), '/images/abc/Backdrop?width=640 1x, /images/abc/Backdrop?width=1280 2x');
});

test('supplied signed artwork URLs are passed through byte for byte and never given a srcset', () => {
	const signed = 'https://cdn.example.test/tellybox/art/abc?token=xyz&width=1280&exp=123';
	for (const [item, backdrop, width] of [
		[{ Id: 'abc', Name: 'A', Artwork: signed }, false, 400],
		[{ Id: 'abc', Name: 'A', BackdropArtwork: signed }, true, 640],
		[{ Id: 'abc', Name: 'A', Artwork: signed, ArtworkLocal: '/images/abc/Primary?width=400' }, false, 400],
		[{ Id: 'abc', Name: 'A', BackdropArtwork: signed, BackdropArtworkLocal: '/images/abc/Backdrop?width=640' }, true, 640],
	]) {
		const image = fakeImage();
		artworkHelpers.setArtwork(image, item, backdrop, width);
		assert.equal(image.src, signed, 'the supplied URL is the primary source, unchanged');
		assert.equal(image.getAttribute('srcset'), null, 'no srcset competes with the signed URL');
		assert.equal(artworkHelpers.imageUrl(item, backdrop, width), signed);
	}
});

test('a versioned local library URL still gets a 1x and 2x candidate that keep the version', () => {
	const url = '/images/abc/Primary?width=400&v=57243119d5bc';
	assert.equal(artworkHelpers.localArtworkWidth(url), 400);
	assert.equal(artworkHelpers.localArtworkSrcset(url), url + ' 1x, /images/abc/Primary?width=800&v=57243119d5bc 2x');
	// A server-supplied versioned URL is the primary source, unchanged.
	const image = fakeImage();
	artworkHelpers.setArtwork(image, { Id: 'abc', Name: 'A', Artwork: url });
	assert.equal(image.src, url, 'the 1x URL is byte-identical to the server URL');
	const [one, two] = image.getAttribute('srcset').split(', ');
	assert.equal(one, url + ' 1x');
	assert.equal(two, '/images/abc/Primary?width=800&v=57243119d5bc 2x');
});

test('a versioned Backdrop URL doubles its own width and clamps at 1920', () => {
	const backdrop = '/images/abc/Backdrop?width=1280&v=6828ab66026b';
	assert.equal(artworkHelpers.localArtworkSrcset(backdrop), backdrop + ' 1x, /images/abc/Backdrop?width=1920&v=6828ab66026b 2x');
	const image = fakeImage();
	artworkHelpers.setArtwork(image, { Id: 'abc', Name: 'A', BackdropArtwork: backdrop }, true, 640);
	assert.equal(image.src, backdrop, 'Continue keeps the backdrop URL the server supplied');
	assert.match(image.getAttribute('srcset'), /width=1920&v=6828ab66026b 2x$/);
	const atLimit = '/images/abc/Primary?width=1920&v=6828ab66026b';
	assert.equal(artworkHelpers.localArtworkSrcset(atLimit), '', 'already at the maximum width, so there is no 2x candidate');
});

test('an unversioned local URL still gets 1x/2x and extra parameters are preserved', () => {
	assert.equal(
		artworkHelpers.localArtworkSrcset('/images/abc/Primary?width=400'),
		'/images/abc/Primary?width=400 1x, /images/abc/Primary?width=800 2x',
	);
	assert.equal(
		artworkHelpers.localArtworkSrcset('/images/abc/Primary?width=400&v=abc123def456&tag=1'),
		'/images/abc/Primary?width=400&v=abc123def456&tag=1 1x, /images/abc/Primary?width=800&v=abc123def456&tag=1 2x',
	);
});

test('non-library artwork routes are left alone', () => {
	for (const url of [
		'https://elsewhere.test/images/abc/Primary?width=400',
		'//cdn.example.test/images/abc/Primary?width=400',
		'/tellybox/0123456789ab/abc.jpg',
		'/api/web/art/movie/1?sig=abc&width=400',
		'/images/abc/Primary',
		'/images/abc/Poster?width=400',
		'/images/abc/Primary?width=abc',
	]) {
		assert.equal(artworkHelpers.localArtworkSrcset(url), '', 'left alone: ' + url);
		assert.equal(artworkHelpers.localArtworkWidth(url), 0, 'no local width: ' + url);
	}
	const image = fakeImage();
	artworkHelpers.setArtwork(image, { Id: 'abc', Name: 'A', Artwork: '/tellybox/0123456789ab/abc.jpg' }, false, 400);
	assert.equal(image.src, '/tellybox/0123456789ab/abc.jpg');
	assert.equal(image.getAttribute('srcset'), null);
});

test('a non-library fallback route is left alone and the local primary still scales', () => {
	const image = fakeImage();
	const item = { Id: 'abc', Name: 'A', ArtworkLocal: '/api/web/art/movie/1?sig=abc&width=400' };
	artworkHelpers.setArtwork(image, item, false, 400);
	assert.equal(image.src, '/images/abc/Primary?width=400', 'the primary stays the built-in local route');
	assert.equal(image.getAttribute('srcset'), '/images/abc/Primary?width=400 1x, /images/abc/Primary?width=800 2x');
	assert.equal(image.dataset.tellyboxLocal, '/api/web/art/movie/1?sig=abc&width=400', 'the server fallback route is recorded unchanged');
	assert.equal(artworkHelpers.localArtworkSrcset('/api/web/art/movie/1?sig=abc&width=400'), '');
});

test('local artwork widths stay inside the image route bounds', () => {
	assert.equal(artworkHelpers.localArtworkWidth('/images/abc/Primary?width=50'), 50);
	assert.equal(artworkHelpers.localArtworkWidth('/images/abc/Primary?width=400'), 400);
	assert.equal(artworkHelpers.localArtworkWidth('/images/abc/Primary?width=2400'), 2400);
	assert.equal(artworkHelpers.localArtworkWidth('/images/abc/Primary?width=400.6'), 401);
	assert.equal(artworkHelpers.localArtworkSrcset('/images/abc/Primary?width=50'), '/images/abc/Primary?width=50 1x, /images/abc/Primary?width=100 2x');
	assert.equal(artworkHelpers.localArtworkSrcset('/images/abc/Primary?width=1200'), '/images/abc/Primary?width=1200 1x, /images/abc/Primary?width=1920 2x');
});

test('the Continue tile contract is unchanged and keeps the 640 backdrop width', () => {
	assert.match(continueTileSource, /setArtwork\(image, item, true, 640\)/);
	assert.match(continueTileSource, /image\.loading = 'lazy'/);
	assert.match(continueTileSource, /image\.decoding = 'async'/);
	assert.match(continueTileSource, /element\('button', 'continue-card'\)/);
	assert.match(continueTileSource, /continue-progress-fill/);
	assert.doesNotMatch(continueTileSource, /setAttribute\('srcset'|\.srcset\s*=/, 'the Continue markup never assigns artwork-selection srcset');
});

test('card artwork keeps lazy loading and adds async decoding', () => {
	const cardSource = section('function card(item, releaseDate = false, options = {}) {', 'function anotherPick() {');
	assert.match(cardSource, /image\.loading = 'lazy'/);
	assert.match(cardSource, /image\.decoding = 'async'/);
});

// ---------------------------------------------------------------------------
// Shared-browser progress: browser progress belongs to the local viewer only.
// ---------------------------------------------------------------------------

function fakeStorage(entries = []) {
	const map = new Map(entries);
	return {
		get length() { return map.size; },
		key(index) { return [...map.keys()][index] ?? null; },
		getItem(key) { return map.has(key) ? String(map.get(key)) : null; },
		setItem(key, value) { map.set(String(key), String(value)); },
		removeItem(key) { map.delete(key); },
		entries() { return [...map.entries()]; },
	};
}

const progressHelpers = (() => {
	const trust = section('const browserProgress =', 'const coming =');
	const reads = section('function getProgress(id) {', 'function beginViewing() {')
		+ section('function watchedLocally(id) {', 'function episodeFinishedLocally(episode) {')
		+ section('function homeContextPayload() {', 'async function refreshHomeFeedAvailability(');
	const factory = new Function('localStorage', 'window', 'readFavourites',
		trust + reads + '\nreturn { browserProgress, browserProgressTrusted, trustBrowserProgress, getProgress, watchedLocally, homeContextPayload };');
	return { factory };
})();

function progressSandbox(entries) {
	return progressHelpers.factory(fakeStorage(entries), {}, () => ({}));
}

test('browser progress is untrusted until /api/auth/status resolves, then follows local/home', () => {
	const sandbox = progressSandbox([
		['jimbo-progress-movie-1', '1500'],
		['tellybox-watched-movie-2', 'true'],
		['tellybox-series-show-1', 'episode-9'],
	]);
	// No status yet: never use another account's stored position.
	assert.equal(sandbox.browserProgressTrusted(), false);
	assert.equal(sandbox.getProgress('movie-1'), 0);
	assert.equal(sandbox.watchedLocally('movie-2'), false);
	assert.deepEqual(sandbox.homeContextPayload().progress, {});
	assert.deepEqual(sandbox.homeContextPayload().watched, []);

	// Remote authenticated viewer (or approved app device).
	sandbox.trustBrowserProgress({ local: false, home: false, authenticated: true });
	assert.equal(sandbox.browserProgressTrusted(), false);
	assert.equal(sandbox.getProgress('movie-1'), 0);
	assert.deepEqual(sandbox.homeContextPayload().progress, {});

	// Local and at-home viewers keep the browser record exactly as today.
	for (const access of [{ local: true, home: false }, { local: false, home: true }, { local: true, home: true }]) {
		sandbox.trustBrowserProgress(access);
		assert.equal(sandbox.browserProgressTrusted(), true);
		assert.equal(sandbox.getProgress('movie-1'), 1500);
		assert.equal(sandbox.getProgress('movie-2'), 0, 'a locally watched title has no resume point');
		assert.equal(sandbox.watchedLocally('movie-2'), true);
		assert.deepEqual(sandbox.homeContextPayload().progress, { 'movie-1': 1500 });
		assert.deepEqual(sandbox.homeContextPayload().watched, ['movie-2']);
	}

	// A later remote status (account switch in the same browser) turns it off again.
	sandbox.trustBrowserProgress({ local: false, home: false });
	assert.equal(sandbox.getProgress('movie-1'), 0);
	assert.deepEqual(sandbox.homeContextPayload().progress, {});
});

test('the Home payload keeps its shape for remote viewers', () => {
	const sandbox = progressSandbox([['jimbo-progress-movie-1', '1500']]);
	sandbox.trustBrowserProgress({ local: false, home: false });
	const payload = sandbox.homeContextPayload();
	assert.deepEqual(Object.keys(payload).sort(), ['favourites', 'progress', 'taste', 'watched']);
	assert.deepEqual(payload.progress, {});
	assert.deepEqual(payload.watched, []);
	assert.equal(typeof payload.favourites, 'object');
});

test('every local-progress read and write path is behind the trust guard', () => {
	// The trust flag is fed from bootstrap, online revalidation and the explicit
	// same-document Home scope revalidation.
	const statusCalls = appJs.match(/await api\('\/api\/auth\/status'\)|api\('\/api\/auth\/status'\)\.then/g) || [];
	assert.equal(statusCalls.length, 3, 'all auth status call sites exist');
	assert.equal((appJs.match(/trustBrowserProgress\(access\);/g) || []).length, 3, 'all call sites update the trust flag');
	assert.match(section('function trustBrowserProgress(access) {', 'const coming ='), /Boolean\(access\?\.local \|\| access\?\.home\)/);

	const getProgress = section('function getProgress(id) {', 'function beginViewing() {');
	assert.match(getProgress, /typeof browserProgressTrusted !== 'function' \|\| !browserProgressTrusted\(\)/);
	assert.ok(getProgress.indexOf('browserProgressTrusted()') < getProgress.indexOf("localStorage.getItem"), 'the read is guarded before storage');

	const watched = section('function watchedLocally(id) {', 'function episodeFinishedLocally(episode) {');
	assert.match(watched, /if \(!browserProgressTrusted\(\)\) return false;/);
	assert.ok(watched.indexOf('browserProgressTrusted()') < watched.indexOf('localStorage.getItem'));

	const begin = section('function beginViewing() {', 'function saveProgress() {');
	assert.match(begin, /if \(!browserProgressTrusted\(\)\) return;/);
	assert.ok(begin.indexOf('browserProgressTrusted()') < begin.indexOf('localStorage.getItem'));

	const save = section('function saveProgress() {', 'function resetViewingState() {');
	assert.match(save, /if \(!browserProgressTrusted\(\)\) return;/);
	assert.ok(save.indexOf('browserProgressTrusted()') < save.indexOf('localStorage.setItem'), 'the write is guarded before storage');
	assert.match(save, /tellybox-watched-/, 'the write path itself is unchanged for local viewers');

	const context = section('function homeContextPayload() {', 'async function refreshHomeFeedAvailability(');
	assert.match(context, /if \(browserProgressTrusted\(\)\) \{/);
	assert.ok(context.indexOf('browserProgressTrusted()') < context.indexOf("startsWith('jimbo-progress-')"));
	assert.ok(context.indexOf('browserProgressTrusted()') < context.indexOf("startsWith('tellybox-watched-')"));

	const continueButton = section('async function seriesContinue(item, content, episodes) {', "$('#previousChannel').onclick");
	assert.match(continueButton, /const trusted = browserProgressTrusted\(\);/);
	assert.match(continueButton, /const last = trusted \? localStorage\.getItem\('tellybox-series-' \+ item\.Id\) : '';/);
	assert.match(continueButton, /const watched = id => trusted \? localStorage\.getItem\('tellybox-watched-' \+ id\) === 'true' : playedOnServer\(id\);/);
	assert.match(continueButton, /const resumeOf = episode => trusted \? getProgress\(episode\.Id\) : itemProgress\(episode\);/);

	const playback = section('if (!keepSettings) {\n\t\tviewingStarted = false;', '\tif (item.Type === \'Episode\') {');
	assert.match(playback, /browserProgressTrusted\(\)/);
	assert.match(playback, /item\.UserData\?\.Played === true/, 'remote viewers fall back to their own server played state');

	// No unguarded direct reads remain anywhere in the file: every storage read
	// for these keys is inside one of the guarded blocks asserted above. The
	// eight sites are watchedLocally, getProgress (x2), beginViewing,
	// saveProgress, seriesContinue (x2) and startPlayback.
	const directReads = (appJs.match(/localStorage\.getItem\('(?:jimbo-progress-|tellybox-watched-|tellybox-series-)/g) || []).length;
	assert.equal(directReads, 8, 'a new unguarded progress read would change this count - guard it first');
});

test('index.html references only files that exist and adds no new stylesheet, origin or inline script', () => {
	const stylesheets = [...indexHtml.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="\/([^"]+)"/g)].map(match => match[1]);
	assert.ok(stylesheets.includes('style.css'));
	assert.ok(stylesheets.includes('home-124.css'));
	assert.ok(!stylesheets.includes('web-125.css'), 'no release-125 stylesheet was needed');
	for (const name of stylesheets) assert.ok(existsSync(publicFile(name)), 'missing stylesheet ' + name);
	const scripts = [...indexHtml.matchAll(/<script[^>]+src="\/([^"]+)"/g)].map(match => match[1]);
	for (const name of scripts) {
		if (name.startsWith('vendor/')) continue;
		assert.ok(existsSync(publicFile(name)), 'missing script ' + name);
	}
	const inline = [...indexHtml.matchAll(/<script(?![^>]*\bsrc=)[^>]*>/g)];
	assert.equal(inline.length, 1, 'the page keeps exactly the existing single inline Home-pending script');
	assert.doesNotMatch(indexHtml, /https?:\/\//, 'no new external origin in the page shell');
});

test('the public asset allowlist only names files that exist', () => {
	assert.ok(PUBLIC_CDN_ASSETS.includes('home-124.css'));
	assert.ok(!PUBLIC_CDN_ASSETS.includes('web-125.css'), 'no release-125 asset was added');
	for (const name of PUBLIC_CDN_ASSETS) assert.ok(existsSync(publicFile(name)), 'allowlisted asset is missing: ' + name);
});

test('the deferred collection keeps the request itself unchanged for collection views', () => {
	assert.match(loadItemsSource, /new URLSearchParams\(\{ type: state\.type, sort: \$\('#sort'\)\.value, start: append \? state\.items\.length : 0 \}\)/);
	assert.match(loadItemsSource, /const data = await api\(\(unified \? '\/api\/web\/items\?' : '\/api\/items\?'\) \+ params\)/);
	assert.match(loadItemsSource, /pollItemsAvailability/);
	assert.match(loadItemsSource, /updateItemsSummary\(data, append, search\)/);
});
