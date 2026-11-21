/* Release 128B owner F1: persistent artwork restart budget + opaque auth scope.
 *
 * Static/structural checks over the public frontend plus small behavioural
 * sandboxes. No server, browser or network.
 *
 * Covered:
 *  - restart:true consumes one per-Home-session allowance, never one per loop;
 *  - an internally-triggered full reload (including a queued one) cannot hand
 *    the artwork continuation a fresh allowance;
 *  - normal initial loads, explicit refreshes and artwork updates still work;
 *  - the server-issued opaque scope wins over the legacy fingerprint;
 *  - same-document Home revalidation clears a stale cached feed in the
 *    background without delaying the warm paint.
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

const artworkSource = section('// Bounded artwork continuation (light route)', '// A single compact skeleton');
const loadHomeFeedSource = section('async function loadHomeFeed(force = false, { internal = false } = {}) {', '// Continue watching uses a dedicated landscape resume card.');
const scopeSource = section('function homeAuthScope(access) {', 'function resetHomeViewControls() {');
const resetSource = section('function resetHomeViewControls() {', '// Render the current Home state');
const navigateHomeSource = section('function navigateHome(', '// A same-document view entry');
const popStateSource = section('function onHomePopState() {', '// The server verifies streamed series before returning a normal watch list.');

// ---------------------------------------------------------------------------
// Structural contract
// ---------------------------------------------------------------------------

test('the restart allowance is persistent state, not a per-loop counter', () => {
	assert.match(appJs, /const homeFeedState = \{[^}]*artworkRestartBudget: 1/);
	assert.match(appJs, /const homeArtworkRestartLimit = 1;/);
	assert.match(artworkSource, /homeFeedState\.artworkRestartBudget = budget - 1;/);
	assert.match(artworkSource, /Number\.isFinite\(budget\) && budget > 0/);
	assert.match(artworkSource, /loadHomeFeed\(true, \{ internal: true \}\)/);
	assert.match(artworkSource, /if \(Number\.isFinite\(budget\) && budget > 0\)/, 'an exhausted budget never queues another full Home POST');
	// A full reload must not reset or spend the allowance itself.
	assert.doesNotMatch(loadHomeFeedSource, /artworkRestartBudget\s*=/);
	// Only explicit Home entry and a changed validated scope replenish it.
	assert.match(resetSource, /resetHomeArtworkRestartBudget\(\);/);
	assert.match(scopeSource, /if \(homeFeedState\.scope && homeFeedState\.scope !== scope\) \{[\s\S]*resetHomeArtworkRestartBudget\(\);/);
	assert.equal((appJs.match(/resetHomeArtworkRestartBudget\(\);/g) || []).length, 2, 'the two lifecycle call sites');
});

test('explicit Home navigation revalidates the scope after the warm paint', () => {
	assert.match(navigateHomeSource, /showHomeView\(\{ scroll \}\);\n\tvoid revalidateHomeAuthScope\(\);/);
	assert.match(popStateSource, /showHomeView\(\{ scroll: false \}\);\n\t\tvoid revalidateHomeAuthScope\(\);/);
	const navPaint = navigateHomeSource.indexOf('showHomeView({ scroll });');
	const navRevalidate = navigateHomeSource.indexOf('revalidateHomeAuthScope();');
	assert.ok(navPaint > -1 && navRevalidate > navPaint, 'Home click paints before revalidating');
	const popPaint = popStateSource.indexOf('showHomeView({ scroll: false });');
	const popRevalidate = popStateSource.indexOf('revalidateHomeAuthScope();');
	assert.ok(popPaint > -1 && popRevalidate > popPaint, 'popstate return paints before revalidating');
	assert.match(scopeSource, /async function revalidateHomeAuthScope\(access = null\) \{/);
	assert.match(scopeSource, /if \(!homeFeedState\.authReady\) return;/);
	assert.match(scopeSource, /api\('\/api\/auth\/status'\)/);
	assert.match(scopeSource, /if \(previousScope !== homeFeedState\.scope \|\| !access \|\| homeAuthScope\(access\) === previousScope\) return;/);
	assert.match(scopeSource, /setHomeAuthScope\(access\);/);
	assert.match(scopeSource, /void loadHomeFeed\(true\);/);
});

// ---------------------------------------------------------------------------
// Behavioural sandbox: actual continuation + actual loadHomeFeed
// ---------------------------------------------------------------------------

function feedWithRemaining() {
	return {
		rows: [{ id: 'new', items: [{ Id: 'm1', Name: 'Film', Artwork: '/images/m1/Primary?width=400' }] }],
		featured: [],
		availability: { pending: 0, artwork: { pending: 0, remaining: 1, visible: 1 } },
	};
}

function restartBudgetSandbox(options = {}) {
	const timers = [];
	const homeCalls = [];
	const lightCalls = [];
	const pendingHome = [];
	const homeFeedState = {
		data: null, fetchedAt: 0, context: '', loading: false, generation: 0,
		deferred: false, artworkDeferred: false, signature: '', artworkSignature: '',
		settled: false, failed: false, queued: false, queuedInternal: false,
		authReady: true, scope: 'scope', artworkRestartBudget: 1,
	};
	const env = {
		homeFeedState,
		homeArtworkPollDelays: [0],
		homeArtworkPollLimit: 5,
		homeArtworkRestartLimit: 1,
		homeArtworkPoll: { token: 0, active: false },
		serverFavouritesRequired: false,
		sharedFavourites: null,
		homeFavouritesRequest: null,
		setTimeout: (resolve, ms) => { timers.push({ resolve, ms }); return timers.length; },
		isHomeView: () => true,
		homeContextPayload: () => ({ favourites: [] }),
		$: () => ({ textContent: '' }),
		api: async path => {
			if (path === '/api/web/home') {
				homeCalls.push(true);
				if (options.deferHome) return new Promise(resolve => pendingHome.push(resolve));
				return feedWithRemaining();
			}
			lightCalls.push(path);
			return options.artwork ? options.artwork() : { restart: true };
		},
		renderHomeFeed: () => {},
		hideBootOverlay: () => {},
		bootOverlayError: () => {},
		writeHomeCache: () => {},
		feedAvailabilityPending: () => 0,
		updateHomeSections: () => {},
		renderHomeFeedError: () => {},
		applyHomeArtwork: () => {},
		applyHomeFeedStatus: () => {},
		homeArtworkSignature: () => '',
		homeFeedSignature: () => '',
		rehydrateHomeArtwork: () => {},
		artworkContinuationPending: data => Boolean(data?.availability?.artwork?.remaining),
		details: { open: false },
		player: { open: false },
		state: { session: null },
		casting: { active: false },
	};
	const factory = new Function(...Object.keys(env),
		artworkSource + '\n' + loadHomeFeedSource
		+ '\nreturn { loadHomeFeed, startHomeArtworkContinuation, stopHomeArtworkContinuation, continueHomeArtwork, resetHomeArtworkRestartBudget };');
	const helpers = factory(...Object.values(env));
	async function settle() { for (let index = 0; index < 80; index += 1) await Promise.resolve(); }
	async function step() {
		const next = timers.shift();
		assert.ok(next, 'expected another scheduled artwork check');
		next.resolve();
		await settle();
		return next.ms;
	}
	function releaseHome() {
		const resolve = pendingHome.shift();
		assert.ok(resolve, 'expected a pending Home request');
		resolve(feedWithRemaining());
	}
	return { helpers, homeFeedState, timers, homeCalls, lightCalls, pendingHome, settle, step, releaseHome };
}

test('repeated restart:true spends exactly one internal full Home reload', async () => {
	const sandbox = restartBudgetSandbox();
	await sandbox.helpers.loadHomeFeed(true);
	await sandbox.settle();
	assert.equal(sandbox.homeCalls.length, 1, 'the ordinary initial load happens once');
	assert.equal(sandbox.timers.length, 1, 'the ordinary load still starts the bounded artwork loop');

	await sandbox.step();
	assert.equal(sandbox.lightCalls.length, 1, 'the first artwork check is the only one needed to trigger the restart');
	assert.equal(sandbox.homeCalls.length, 2, 'exactly one internal full Home reload');
	assert.equal(sandbox.homeFeedState.artworkRestartBudget, 0, 'the restart allowance is consumed');
	assert.equal(sandbox.timers.length, 0, 'the restart reload does not start another artwork loop');

	// Even if another explicit loop is started later, an exhausted allowance
	// stops at the restart response without another full Home POST.
	await sandbox.helpers.loadHomeFeed(true);
	await sandbox.settle();
	assert.equal(sandbox.homeCalls.length, 3, 'an explicit refresh is never blocked');
	assert.equal(sandbox.timers.length, 1);
	await sandbox.step();
	assert.equal(sandbox.lightCalls.length, 2);
	assert.equal(sandbox.homeCalls.length, 3, 'no runaway full Home reload after the budget is gone');
	assert.equal(sandbox.timers.length, 0);
});

test('an internal reload queued behind an in-flight load keeps its marker', async () => {
	const sandbox = restartBudgetSandbox({ deferHome: true });
	const initial = sandbox.helpers.loadHomeFeed(true);
	await sandbox.settle();
	assert.equal(sandbox.homeCalls.length, 1);
	assert.equal(sandbox.homeFeedState.loading, true);

	const internal = sandbox.helpers.loadHomeFeed(true, { internal: true });
	await sandbox.settle();
	assert.equal(sandbox.homeCalls.length, 1, 'the queued call did not run concurrently');
	assert.equal(sandbox.homeFeedState.queued, true);
	assert.equal(sandbox.homeFeedState.queuedInternal, true);

	sandbox.releaseHome();
	await initial;
	await sandbox.settle();
	assert.equal(sandbox.homeCalls.length, 2, 'the queued internal reload runs after the first settles');

	sandbox.releaseHome();
	await internal;
	await sandbox.settle();
	assert.equal(sandbox.homeFeedState.queued, false);
	assert.equal(sandbox.homeFeedState.queuedInternal, false);
	assert.equal(sandbox.homeFeedState.artworkRestartBudget, 1, 'an internal reload neither spends nor resets the allowance');
	assert.equal(sandbox.timers.length, 1, 'only the first load left a loop timer; the internal reload starts none');
	await sandbox.step();
	assert.equal(sandbox.lightCalls.length, 0, 'the superseded loop timer exits without a request');
});

test('normal artwork completion and explicit restart allowance reset still work', async () => {
	const sandbox = restartBudgetSandbox({
		artwork: () => ({ updates: [], availability: { pending: 0, remaining: 0, visible: 1 } }),
	});
	await sandbox.helpers.loadHomeFeed(true);
	await sandbox.settle();
	assert.equal(sandbox.homeCalls.length, 1);
	assert.equal(sandbox.timers.length, 1);
	await sandbox.step();
	assert.equal(sandbox.lightCalls.length, 1);
	assert.equal(sandbox.timers.length, 0, 'the loop stops when the server says no work remains');
	assert.equal(sandbox.homeFeedState.artworkRestartBudget, 1, 'a normal artwork check does not spend the restart allowance');

	// Returning Home (or a newly validated scope) replenishes the allowance.
	sandbox.homeFeedState.artworkRestartBudget = 0;
	sandbox.helpers.resetHomeArtworkRestartBudget();
	assert.equal(sandbox.homeFeedState.artworkRestartBudget, 1);
});

// ---------------------------------------------------------------------------
// Opaque auth scope + same-document revalidation
// ---------------------------------------------------------------------------

function scopeSandbox({ scope = 'old', data = { rows: [{ id: 'new', items: [{ Id: 'stale' }] }] }, apiAccess = { scope: 'new' } } = {}) {
	const record = { loads: [], skeletons: 0, sections: 0 };
	const storedScope = scope.startsWith('scope:') || scope.startsWith('legacy:') ? scope : 'scope:' + scope;
	const homeFeedState = {
		data, fetchedAt: 1, context: 'ctx', loading: false, generation: 1,
		deferred: false, artworkDeferred: false, signature: 'sig', artworkSignature: 'art',
		settled: Boolean(data), failed: false, queued: false, queuedInternal: false,
		authReady: true, scope: storedScope, artworkRestartBudget: 0,
	};
	const factory = new Function(
		'homeFeedState', 'homeSkeletonShown', 'api', 'routing', 'trustBrowserProgress',
		'stopHomeArtworkContinuation', 'resetHomeArtworkRestartBudget', 'isHomeView',
		'renderHomeSkeleton', 'updateHomeSections', 'loadHomeFeed',
		'sharedFavourites', 'favouriteHome', 'serverFavouritesRequired', 'loadLikedEpisodes',
		scopeSource + '\nreturn { homeAuthScope, setHomeAuthScope, revalidateHomeAuthScope };');
	const helpers = factory(
		homeFeedState, false, async () => apiAccess, {}, () => {},
		() => { homeFeedState.stopped = (homeFeedState.stopped || 0) + 1; },
		() => { homeFeedState.artworkRestartBudget = 1; },
		() => true,
		() => { record.skeletons += 1; },
		() => { record.sections += 1; },
		() => { record.loads.push(true); },
		null, false, false, async () => {},
	);
	return { helpers, homeFeedState, record };
}

test('different opaque scopes never collide and secrets are not included', () => {
	const { helpers } = scopeSandbox();
	const a = helpers.homeAuthScope({ scope: 'acct:alice|device:1', token: 'secret-token', password: 'hunter2' });
	const b = helpers.homeAuthScope({ scope: 'acct:bob|device:1' });
	assert.notEqual(a, b);
	assert.match(a, /^scope:acct:alice/);
	assert.doesNotMatch(a, /secret-token|hunter2/);

	// The opaque value wins even when every legacy fallback field is identical.
	const legacy = { local: false, home: false, authenticated: true, email: true, person: 'Viewer' };
	assert.notEqual(helpers.homeAuthScope({ ...legacy, scope: 'acct:alice|device:1' }), helpers.homeAuthScope({ ...legacy, scope: 'acct:bob|device:1' }));
	assert.equal(helpers.homeAuthScope({ ...legacy, scope: 'acct:alice|device:1' }), a);
	assert.match(helpers.homeAuthScope(legacy), /^legacy:/, 'old servers keep the legacy fingerprint');
	assert.notEqual(helpers.homeAuthScope(legacy), helpers.homeAuthScope({ ...legacy, person: 'Other' }));
});

test('a changed validated scope clears the stale feed and requests the new one', async () => {
	const sandbox = scopeSandbox({ scope: 'old', data: { rows: [{ id: 'new', items: [{ Id: 'stale' }] }] }, apiAccess: { scope: 'new' } });
	await sandbox.helpers.revalidateHomeAuthScope();
	assert.equal(sandbox.homeFeedState.data, null, 'the previous account/source feed is invalidated');
	assert.equal(sandbox.homeFeedState.scope, 'scope:new');
	assert.equal(sandbox.homeFeedState.context, '');
	assert.equal(sandbox.record.skeletons, 1, 'the honest skeleton is shown when the cache is empty');
	assert.deepEqual(sandbox.record.loads, [true], 'the new feed is requested');
	assert.equal(sandbox.homeFeedState.artworkRestartBudget, 1, 'a genuinely new scope replenishes the artwork restart allowance');
});

test('an unchanged scope keeps the warm cached feed and makes no request', async () => {
	const data = { rows: [{ id: 'new', items: [{ Id: 'm1' }] }] };
	const sandbox = scopeSandbox({ scope: 'same', data, apiAccess: { scope: 'same' } });
	await sandbox.helpers.revalidateHomeAuthScope();
	assert.equal(sandbox.homeFeedState.data, data, 'the warm paint stays authoritative');
	assert.equal(sandbox.record.skeletons, 0);
	assert.deepEqual(sandbox.record.loads, []);
	assert.equal(sandbox.homeFeedState.artworkRestartBudget, 0, 'no new scope means no new allowance');
});
