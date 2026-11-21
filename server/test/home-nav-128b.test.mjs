/* Release 128 owner B: Home artwork continuation + same-document navigation.
 *
 * Static/structural checks over the public frontend plus small behavioural
 * sandboxes for the new pure/async helpers. No server, browser or network.
 *
 * Covered:
 *  - artwork pending is split from full-feed availability polling;
 *  - the bounded /api/web/home/artwork continuation (delays, budget, stops,
 *    restart, in-place updates, 5.2 s late metadata);
 *  - warm-return rendering, cold skeleton, stale-context safety;
 *  - auth-before-Home startup ordering and the early skeleton;
 *  - same-document Home/brand navigation, history and player coexistence.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const appFile = fileURLToPath(new URL('../public/app.js', import.meta.url));
const appJs = readFileSync(appFile, 'utf8');

function section(startMarker, endMarker) {
	const start = appJs.indexOf(startMarker);
	assert.notEqual(start, -1, 'missing marker: ' + startMarker);
	const end = appJs.indexOf(endMarker, start);
	assert.notEqual(end, -1, 'missing end marker: ' + endMarker);
	return appJs.slice(start, end);
}

const initSource = section('async function init() {', 'void init();');
const loadHomeFeedSource = section('async function loadHomeFeed(force = false, { internal = false } = {}) {', '// Continue watching uses a dedicated landscape resume card.');
const refreshSource = section('async function refreshHomeFeedAvailability(', '// ---------------------------------------------------------------------------\n// Viewport stability helpers');
const artworkSource = section('// Bounded artwork continuation (light route)', '// A single compact skeleton');
const showHomeViewSource = section('function showHomeView({ scroll = false } = {}) {', 'function navigateHome(');
const navigateHomeSource = section('function navigateHome(', '// A same-document view entry');
const popStateSource = section('function onHomePopState() {', '// The server verifies streamed series before returning a normal watch list.');
const resetSource = section('function resetHomeViewControls() {', '// Render the current Home state');

// ---------------------------------------------------------------------------
// A. Artwork polling split from full-feed availability polling
// ---------------------------------------------------------------------------

test('feed availability and artwork continuation are counted separately', () => {
	const source = section('function feedAvailabilityPending(data) {', '// The shared quiet notice');
	const feedAvailabilityPending = new Function(source + '\nreturn feedAvailabilityPending;')();
	assert.equal(feedAvailabilityPending({ availability: { pending: 2 } }), 2);
	assert.equal(feedAvailabilityPending({ availability: { pending: 2, artwork: { pending: 5, remaining: 9 } } }), 2, 'artwork never joins the row count');
	assert.equal(feedAvailabilityPending({ availability: { artwork: { pending: 4 } } }), 0, 'artwork-only pending does not request the feed');
	assert.equal(feedAvailabilityPending({}), 0);
	assert.equal(feedAvailabilityPending(null), 0);
	assert.equal(feedAvailabilityPending({ availability: { pending: -1, artwork: { pending: 3 } } }), 0);

	// The shared notice still reports artwork, which is why pendingAvailability
	// keeps its 128 contract; only request decisions use the split count.
	const pendingSource = section('function pendingAvailability(data) {', 'let guideData = null;');
	const pendingAvailability = new Function(pendingSource + '\nreturn pendingAvailability;')();
	assert.equal(pendingAvailability({ availability: { artwork: { pending: 3 } } }), 3);
});

test('only row availability starts a full Home re-POST', () => {
	assert.match(loadHomeFeedSource, /if \(feedAvailabilityPending\(data\) > 0\) void refreshHomeFeedAvailability\(generation, context, 1\)/);
	assert.doesNotMatch(loadHomeFeedSource, /if \(pendingAvailability\(data\) > 0\) void refreshHomeFeedAvailability/);
	assert.match(refreshSource, /if \(feedAvailabilityPending\(data\) > 0\) \{/);
	assert.doesNotMatch(refreshSource, /if \(pendingAvailability\(data\) > 0\) \{/);
	assert.match(refreshSource, /startHomeArtworkContinuation\(false\)/, 'row refreshes continue an existing artwork budget');
	// The existing bounded full-feed retry itself is untouched.
	assert.match(appJs, /const homeAvailabilityRetryLimit = 2;/);
	assert.equal((refreshSource.match(/refreshHomeFeedAvailability\(generation, context, attempt \+ 1\)/g) || []).length, 1);
});

test('the light artwork route is POSTed with an empty body and read for its contract', () => {
	assert.match(artworkSource, /async function refreshHomeArtwork\(generation\) \{/);
	assert.match(artworkSource, /api\('\/api\/web\/home\/artwork', \{\}\)/);
	assert.match(artworkSource, /result\.restart/);
	assert.match(artworkSource, /result\.updates/);
	assert.match(artworkSource, /result\.availability/);
	assert.match(artworkSource, /remaining/);
	assert.match(artworkSource, /pending/);
	// Never a full feed request for an artwork check.
	assert.doesNotMatch(artworkSource, /api\('\/api\/web\/home'/);
});

test('artwork continuation uses the bounded 1200/2000/2800/5000 schedule', () => {
	assert.match(appJs, /const homeArtworkPollDelays = \[1200, 2000, 2800, 5000\];/);
	assert.match(appJs, /const homeArtworkPollLimit = 5;/);
	assert.match(artworkSource, /for \(let attempt = 0; attempt < homeArtworkPollLimit; attempt \+= 1\)/);
	assert.match(artworkSource, /homeArtworkPollDelays\[Math\.min\(attempt, homeArtworkPollDelays\.length - 1\)\]/);
	assert.doesNotMatch(artworkSource, /setInterval|while \(/, 'bounded by the attempt budget, not an endless loop');
});

test('artwork updates are applied by Id in place and never rebuild rows', () => {
	assert.match(artworkSource, /const byId = new Map\(\);/);
	assert.match(artworkSource, /typeof update\.Id === 'string'/);
	assert.match(artworkSource, /for \(const row of Array\.isArray\(data\.rows\) \? data\.rows : \[\]\)/);
	assert.match(artworkSource, /if \(Array\.isArray\(data\.featured\)\) items\.push\(\.\.\.data\.featured\)/);
	assert.match(artworkSource, /rehydrateHomeArtwork\(data\);/);
	assert.doesNotMatch(artworkSource, /renderHomeFeed\(\)|replaceChildren/);
});

// ---------------------------------------------------------------------------
// Behavioural sandbox for the bounded continuation
// ---------------------------------------------------------------------------

function artworkSandbox(options = {}) {
	const timers = [];
	const calls = [];
	const rehydrated = [];
	const statuses = [];
	const loads = [];
	let apiQueue = options.responses ? [...options.responses] : [];
	const homeFeedState = {
		data: options.data || null,
		generation: 1,
		context: 'ctx',
		scope: 'scope',
		artworkSignature: '',
		artworkRestartBudget: 1,
	};
	const env = {
		homeArtworkPollDelays: [1200, 2000, 2800, 5000],
		homeArtworkPollLimit: 5,
		homeArtworkPoll: { token: 0 },
		homeFeedState,
		api: async (path, body) => {
			calls.push({ path, body });
			assert.equal(path, '/api/web/home/artwork');
			assert.deepEqual(body, {});
			const next = apiQueue.length ? apiQueue.shift() : (options.response || { availability: { pending: 0, remaining: 0 } });
			if (next instanceof Error) throw next;
			return next;
		},
		setTimeout: (resolve, ms) => { timers.push({ resolve, ms }); return timers.length; },
		isHomeView: () => (options.home === undefined ? true : options.home()),
		player: { open: false },
		state: { session: false },
		casting: { active: false },
		details: { open: false },
		rehydrateHomeArtwork: data => { rehydrated.push(data); },
		homeArtworkSignature: data => JSON.stringify(data.rows || []) + JSON.stringify(data.featured || []),
		applyHomeFeedStatus: data => { statuses.push(data); },
		loadHomeFeed: force => { loads.push(force); },
	};
	const factory = new Function(...Object.keys(env),
		artworkSource + '\nreturn { artworkContinuationPending, startHomeArtworkContinuation, stopHomeArtworkContinuation, continueHomeArtwork, applyHomeArtwork };');
	const helpers = factory(...Object.values(env));
	async function settle(count = 10) { for (let index = 0; index < count; index += 1) await Promise.resolve(); }
	async function step() {
		const next = timers.shift();
		assert.ok(next, 'expected another scheduled artwork check');
		next.resolve();
		await settle();
		return next.ms;
	}
	return { helpers, homeFeedState, timers, calls, rehydrated, statuses, loads, step, settle, setResponses: list => { apiQueue = [...list]; } };
}

function feedWith(item) {
	return {
		rows: [{ id: 'new', items: [item] }],
		featured: [],
		availability: { pending: 0, artwork: { pending: 0, remaining: 1, visible: 1 } },
	};
}

test('a 5.2 s metadata lookup lands on a later bounded check without a details click', async () => {
	const data = feedWith({ Id: 'm1', Name: 'Film', Artwork: '/images/m1/Primary?width=400' });
	const sandbox = artworkSandbox({
		data,
		responses: [
			{ updates: [], availability: { pending: 1, remaining: 1, visible: 1 } },
			{ updates: [], availability: { pending: 1, remaining: 1, visible: 1 } },
			{ updates: [{ Id: 'm1', Artwork: '/api/web/tmdb-art/m1/poster.jpg' }], availability: { pending: 0, remaining: 0, visible: 1 } },
		],
	});
	const token = sandbox.helpers.startHomeArtworkContinuation();
	assert.notEqual(token, 0);
	assert.equal(sandbox.helpers.artworkContinuationPending(data), true);

	const first = await sandbox.step();
	const second = await sandbox.step();
	const third = await sandbox.step();
	assert.deepEqual([first, second, third], [1200, 2000, 2800]);
	assert.ok(first + second + third >= 5200, 'the late lookup resolves by the third bounded check');
	assert.equal(sandbox.calls.length, 3);
	assert.equal(sandbox.loads.length, 0, 'artwork never triggers a full Home POST');
	assert.equal(sandbox.rehydrated.length, 1, 'the existing card is rehydrated in place');
	assert.equal(sandbox.homeFeedState.data.rows[0].items[0].Artwork, '/api/web/tmdb-art/m1/poster.jpg');
	assert.equal(sandbox.homeFeedState.data.availability.artwork.remaining, 0);
	assert.equal(sandbox.timers.length, 0, 'the loop stops when remaining reaches zero');
});

test('the continuation budget is five checks and failures do not storm', async () => {
	const sandbox = artworkSandbox({
		data: feedWith({ Id: 'm1', Name: 'Film' }),
		responses: [new Error('offline'), new Error('offline'), new Error('offline'), new Error('offline'), new Error('offline'), new Error('offline')],
	});
	sandbox.helpers.startHomeArtworkContinuation();
	const delays = [];
	for (let index = 0; index < 5; index += 1) delays.push(await sandbox.step());
	assert.deepEqual(delays, [1200, 2000, 2800, 5000, 5000], 'the final attempt reuses the 5000 ms cap');
	assert.equal(sandbox.calls.length, 5);
	assert.equal(sandbox.timers.length, 0, 'no sixth attempt is scheduled');
});

test('restart stops the artwork loop and asks for exactly one full feed', async () => {
	const sandbox = artworkSandbox({
		data: feedWith({ Id: 'm1', Name: 'Film' }),
		responses: [{ restart: true }],
	});
	sandbox.helpers.startHomeArtworkContinuation();
	await sandbox.step();
	assert.deepEqual(sandbox.loads, [true]);
	assert.equal(sandbox.calls.length, 1);
	assert.equal(sandbox.timers.length, 0);
});

test('leaving Home, a generation change or a scope change stops before the next request', async () => {
	const scenarios = [
		async box => { box.setHome(false); },
		async box => { box.helpers.stopHomeArtworkContinuation(); },
		async box => { box.homeFeedState.generation += 1; },
		async box => { box.homeFeedState.context = 'other'; },
		async box => { box.homeFeedState.scope = 'other'; },
	];
	for (const mutate of scenarios) {
		let onHome = true;
		const sandbox = artworkSandbox({
			data: feedWith({ Id: 'm1', Name: 'Film' }),
			home: () => onHome,
			responses: [{ updates: [], availability: { pending: 1, remaining: 1 } }, { updates: [{ Id: 'm1', Artwork: '/late.jpg' }], availability: { pending: 0, remaining: 0 } }],
		});
		sandbox.helpers.startHomeArtworkContinuation();
		await sandbox.step();
		assert.equal(sandbox.calls.length, 1);
		await mutate({ ...sandbox, setHome: value => { onHome = value; } });
		assert.equal(sandbox.timers.length, 1, 'the next check was scheduled before the change');
		await sandbox.step();
		assert.equal(sandbox.calls.length, 1, 'no further artwork request after the stop condition');
		assert.equal(sandbox.loads.length, 0);
	}
});

test('applyHomeArtwork updates rows and featured by Id and records availability', () => {
	const rowItem = { Id: 'm1', Name: 'Film', Artwork: '/old.jpg' };
	const featured = { Id: 's1', Name: 'Show', BackdropArtwork: '/old-backdrop.jpg' };
	const sandbox = artworkSandbox({ data: { rows: [{ id: 'new', items: [rowItem] }], featured: [featured] } });
	const changed = sandbox.helpers.applyHomeArtwork({
		updates: [
			{ Id: 'm1', Artwork: '/new.jpg', Name: 'ignored' },
			{ Id: 's1', BackdropArtwork: '/new-backdrop.jpg' },
			{ Id: 'unknown', Artwork: '/nope.jpg' },
		],
		availability: { pending: 0, remaining: 0, visible: 2 },
	});
	assert.equal(changed, 2);
	assert.equal(rowItem.Artwork, '/new.jpg');
	assert.equal(rowItem.Name, 'Film', 'non-artwork identity fields are not overwritten');
	assert.equal(featured.BackdropArtwork, '/new-backdrop.jpg');
	assert.equal(sandbox.homeFeedState.data.rows[0].items[0], rowItem, 'the row object is updated in place');
	assert.equal(sandbox.homeFeedState.data.availability.artwork.remaining, 0);
	assert.equal(sandbox.rehydrated.length, 1);
	assert.equal(sandbox.statuses.length, 1);
});

// ---------------------------------------------------------------------------
// B. Warm return / cold skeleton / stale context
// ---------------------------------------------------------------------------

function homeViewSandbox({ data = null, context = '', authReady = true, scope = 'scope', payload = { favourites: [] }, feedsStarted = true } = {}) {
	const record = [];
	const homeState = { skeleton: false };
	const homeFeedState = { data, context, authReady, scope, fetchedAt: Date.now(), deferred: false, settled: Boolean(data), failed: false };
	const env = {
		homeFeedState,
		homeContextPayload: () => payload,
		renderHomeFeed: () => { record.push('render'); },
		renderHomeSkeleton: () => { record.push('skeleton'); homeState.skeleton = true; },
		startHomeArtworkContinuation: () => { record.push('artwork'); },
		updateHomeSections: () => { record.push('sections'); },
		loadHomeFeeds: () => { record.push('feeds'); },
		loadLikedEpisodes: async () => {},
		loadHomeFeed: force => { record.push('load:' + force); },
		homeFeedsStarted: feedsStarted,
		homeSkeletonShown: false,
		homeState,
		document: {
			activeElement: null,
			body: {},
			scrollingElement: { scrollTop: 99 },
			querySelector: () => null,
		},
	};
	const factory = new Function(...Object.keys(env), showHomeViewSource + '\nreturn showHomeView;');
	const showHomeView = factory(...Object.values(env));
	return { showHomeView, homeFeedState, record, env };
}

test('a warm Home return paints the cached feed before any background refresh', () => {
	const data = { rows: [{ id: 'new', items: [{ Id: 'm1', Name: 'Film' }] }] };
	const sandbox = homeViewSandbox({ data, context: JSON.stringify({ favourites: [] }) });
	sandbox.showHomeView({ scroll: true });
	assert.deepEqual(sandbox.record.slice(0, 3), ['render', 'artwork', 'sections']);
	assert.ok(sandbox.record.indexOf('load:false') > sandbox.record.indexOf('render'), 'cached data is painted first');
	assert.equal(sandbox.record.includes('skeleton'), false, 'no skeleton replaces warm data');
	assert.equal(sandbox.env.document.scrollingElement.scrollTop, 0, 'the same-document Home click scrolls to the top');
});

test('a cold Home return shows the skeleton before the feed resolves', () => {
	const sandbox = homeViewSandbox({ data: null });
	sandbox.showHomeView({ scroll: true });
	assert.equal(sandbox.record.includes('skeleton'), true);
	assert.equal(sandbox.record.includes('render'), false);
	assert.ok(sandbox.record.indexOf('load:false') > sandbox.record.indexOf('skeleton'));
});

test('a stale auth/source context never paints the previous feed as current', () => {
	const data = { rows: [{ id: 'new', items: [{ Id: 'other-account', Name: 'Title' }] }] };
	const sandbox = homeViewSandbox({ data, context: 'old-context' });
	sandbox.showHomeView({ scroll: false });
	assert.equal(sandbox.homeFeedState.data, null, 'the mismatched feed is dropped, not painted');
	assert.equal(sandbox.record.includes('render'), false);
	assert.equal(sandbox.record.includes('skeleton'), true);
	assert.equal(sandbox.record.includes('load:false'), true);
});

test('Home cannot paint before auth and the nav resets library/type/search', () => {
	const sandbox = homeViewSandbox({ data: { rows: [] }, context: 'ctx', authReady: false });
	sandbox.showHomeView();
	assert.equal(sandbox.homeFeedState.data, null);
	assert.equal(sandbox.record.includes('feeds'), false, 'no personalized feed starts before auth');
	assert.match(resetSource, /state\.library = null;/);
	assert.match(resetSource, /state\.type = 'all';/);
	assert.match(resetSource, /search\.value = '';/);
	assert.match(resetSource, /node\.dataset\.type === 'all'/);
	assert.match(resetSource, /stopHomeArtworkContinuation\(\)/);
});

// ---------------------------------------------------------------------------
// Same-document navigation, history and player coexistence
// ---------------------------------------------------------------------------

test('index-page Home/brand links are intercepted with history and no page reload', () => {
	assert.match(appJs, /document\.addEventListener\('click', event => \{/);
	assert.match(appJs, /if \(location\.pathname !== '\/'\) return;/);
	assert.match(appJs, /if \(url\.origin !== location\.origin \|\| url\.pathname !== '\/'\) return;/);
	assert.match(appJs, /if \(url\.searchParams\.has\('view'\) \|\| url\.searchParams\.has\('item'\)\) return;/);
	assert.match(appJs, /event\.preventDefault\(\);\n\tnavigateHome\(\{ mode: 'push', scroll: true \}\);/);
	assert.match(navigateHomeSource, /history\.pushState\(\{ tellyboxHome: true \}, '', url\)/);
	assert.match(navigateHomeSource, /history\.replaceState\(\{ tellyboxHome: true \}, '', url\)/);
	assert.match(navigateHomeSource, /url\.searchParams\.delete\('view'\);/);
	assert.match(navigateHomeSource, /url\.searchParams\.delete\('item'\);/);
	assert.match(popStateSource, /const view = new URLSearchParams\(location\.search\)\.get\('view'\)/);
	assert.match(popStateSource, /resetHomeViewControls\(\);/);
	assert.match(popStateSource, /applySameDocumentView\(view\)/);
});

test('player Back/Close stays owned by playerNavigation', () => {
	assert.match(popStateSource, /playerNavigation\.isPushed\(\) \|\| player\.open \|\| details\.open \|\| state\.session \|\| casting\.active/);
	assert.match(appJs, /window\.addEventListener\('popstate', playerNavigation\.onPopState\);/);
	assert.match(appJs, /window\.addEventListener\('popstate', onHomePopState\);/);
	// The player listener is registered first.
	assert.ok(appJs.indexOf("window.addEventListener('popstate', playerNavigation.onPopState)") < appJs.indexOf("window.addEventListener('popstate', onHomePopState)"));
	assert.match(appJs, /function selectLibrary\(id, options = \{\}\) \{/);
	assert.match(appJs, /if \(options\.history !== false\) \{/);
});

// ---------------------------------------------------------------------------
// Startup: early skeleton, auth before personalized paint, parallel reads
// ---------------------------------------------------------------------------

test('the Home skeleton renders before the first bootstrap await', () => {
	const skeleton = initSource.indexOf('if (isHomeView()) updateHomeSections();');
	const firstAwait = initSource.indexOf('await capabilitiesRequest');
	assert.notEqual(skeleton, -1);
	assert.ok(skeleton < firstAwait, 'the skeleton is synchronous at the top of init');
});

test('capabilities and auth start together, then Home starts without waiting for status or libraries', () => {
	const capabilities = initSource.indexOf("const capabilitiesRequest = api('/api/capabilities')");
	const auth = initSource.indexOf("const accessRequest = (async () => await api('/api/auth/status'))()");
	const firstAwait = initSource.indexOf('await capabilitiesRequest');
	assert.ok(capabilities > -1 && auth > -1);
	assert.ok(capabilities < firstAwait && auth < firstAwait, 'both requests start before either is awaited');

	const trust = initSource.indexOf('trustBrowserProgress(access);');
	const authReady = initSource.indexOf('homeFeedState.authReady = true;');
	const favouritesRequest = initSource.indexOf('const favouritesRequest = serverFavouritesRequired');
	const startHome = initSource.indexOf('loadHomeFeeds();');
	const favouritesAwait = initSource.indexOf('await favouritesRequest');
	const statusAwait = initSource.indexOf("await api('/api/status')");
	const librariesAwait = initSource.indexOf("await api('/api/libraries')");
	assert.ok(trust > -1 && trust < startHome, 'personalized state is trusted before the feed starts');
	assert.ok(authReady > -1 && authReady < startHome);
	assert.ok(favouritesRequest > -1 && favouritesRequest < startHome, 'the favourites read starts before Home');
	assert.ok(startHome > -1 && startHome < favouritesAwait, 'Home starts without awaiting favourites itself');
	assert.ok(startHome < statusAwait, 'Home does not wait for /api/status');
	assert.ok(startHome < librariesAwait, 'Home does not wait for /api/libraries');
	assert.match(initSource, /homeFavouritesRequest = favouritesRequest;/);
	assert.match(loadHomeFeedSource, /if \(serverFavouritesRequired && !sharedFavourites && homeFavouritesRequest\) \{/);
	assert.match(loadHomeFeedSource, /if \(!homeFeedState\.authReady\) return;/);
});

test('favourites stay behind auth and the feed is posted once with that context', () => {
	const auth = initSource.indexOf("await api('/api/auth/status')");
	const favourites = initSource.indexOf('const favouritesRequest = serverFavouritesRequired');
	assert.ok(auth > -1 && favourites > auth, 'favourites are requested only after auth');
	assert.equal((initSource.match(/void loadHomeFeed\(true\);/g) || []).length, 1, 'one conditional reconcile, never an unconditional second fetch');
	assert.match(initSource, /if \(feedStartedWithoutFavourites && favourites\) void loadHomeFeed\(true\);/);
	assert.match(loadHomeFeedSource, /if \(homeFeedState\.queued\) \{\n\t\t\t\tconst queuedInternal = homeFeedState\.queuedInternal;\n\t\t\t\thomeFeedState\.queued = false;\n\t\t\t\thomeFeedState\.queuedInternal = false;\n\t\t\t\tvoid loadHomeFeed\(true, \{ internal: queuedInternal \}\);/);
});

test('non-Home ?view= deep links keep their existing mapping', () => {
	assert.match(initSource, /if\(view==='nonstop'\)selectLibrary\('dispatch-247'\)/);
	assert.match(initSource, /else if\(\['movies','tvshows'\]\.includes\(view\)\)\{const library=state\.libraries\.find\(item=>item\.CollectionType===view\)/);
	assert.match(initSource, /else void loadItems\(\);/);
	assert.match(appJs, /function applySameDocumentView\(view\) \{/);
});
