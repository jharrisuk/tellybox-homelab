import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

// ---------------------------------------------------------------------------
// Source-level contract: the navigation wiring in app.js
// ---------------------------------------------------------------------------

test('player open records the browsing origin once, before the details dialog closes', () => {
	// Origin capture must run only for a fresh open (autoplay/retry/quality
	// keep the player open and must not overwrite the recorded origin).
	const start = app.indexOf('const freshOpen = !player.open;');
	const end = app.indexOf('$(\'#playerTitle\').textContent = playbackTitle(item);', start);
	assert.ok(start >= 0 && end > start, 'startPlayback origin capture is present');
	const block = app.slice(start, end);
	assert.match(block, /const freshOpen = !player\.open;/);
	assert.match(block, /if \(freshOpen\) playerNavigation\.open\(\);/);
	// The origin is captured while the details dialog is still open.
	assert.ok(block.indexOf('playerNavigation.open();') < block.indexOf('details.close();'), 'origin is captured before details closes');
});

test('player Back controls, the dialog cancel and the blocked back all share one path', () => {
	assert.match(app, /\$\('#closePlayer'\)\.onclick = closePlayer;/);
	assert.match(app, /#viewingBlockedBack'\)\.onclick = closePlayer;/);
	assert.match(app, /if\(troubleBack\) troubleBack\.onclick=closePlayer;/);
	assert.match(app, /player\.addEventListener\('cancel', event => \{ event\.preventDefault\(\); closePlayer\(\); \}\);/);
});

test('closing the player never pushes a new history entry (no duplicates)', () => {
	// closePlayer is the Back wrapper; the low-level teardown is separate and
	// neither touches history, so closing cannot add an entry.
	assert.match(app, /function closePlayer\(\) \{\s*playerNavigation\.back\(\);\s*\}/);
	const teardown = app.slice(app.indexOf('function teardownPlayer()'), app.indexOf('function closePlayer()'));
	assert.doesNotMatch(teardown, /history\.(?:pushState|back|replaceState|go)/, 'teardown never touches history');
});

test('a popstate listener closes the player instead of leaving the page', () => {
	assert.match(app, /window\.addEventListener\('popstate', playerNavigation\.onPopState\);/);
	assert.match(app, /function onPopState\(\) \{[\s\S]*?if \(player\.open\) \{[\s\S]*?finish\(\);/);
});

test('the recorded origin restores the details dialog and scroll, falling back to home only with no context', () => {
	const nav = app.slice(app.indexOf('const playerNavigation = (() => {'), app.indexOf('window.addEventListener(\'popstate\''));
	assert.match(nav, /detailsOpen: details\.open/);
	assert.match(nav, /if \(snapshot\.detailsOpen && !details\.open\) details\.showModal\(\);/);
	assert.match(nav, /scrollTop: host \? host\.scrollTop : 0/);
	assert.match(nav, /if \(!restore\(snapshot\)\) goHomeFallback\(\);/);
	assert.match(app, /function goHomeFallback\(\) \{[\s\S]*?location\.replace\('\/'\)/);
});

test('the catalogue notice block in loadItems is left untouched', () => {
	assert.match(app, /if \(data\.notice\) \{ \$\(['"]#status['"]\)\.textContent = data\.notice; \$\(['"]#status['"]\)\.hidden = false; \}/);
	assert.match(app, /if \(data\.indexing\) setTimeout/);
});

test('rapid Back clicks are guarded by an in-flight flag so they cannot walk past the origin', () => {
	const nav = app.slice(app.indexOf('const playerNavigation = (() => {'), app.indexOf('window.addEventListener(\'popstate\''));
	assert.match(nav, /let returning = false;/);
	assert.match(nav, /function back\(\) \{[\s\S]*?if \(returning\) return;/);
	assert.match(nav, /returning = true;/);
});

test('player Back exits fullscreen before closing the dialog', () => {
	const teardown = app.slice(app.indexOf('function teardownPlayer()'), app.indexOf('function closePlayer()'));
	assert.match(teardown, /if \(fullscreenElement\(\)\) void exitFullscreen\(\)\.catch\(\(\) => \{\}\);/);
	// The existing fullscreen helpers are reused, not reimplemented.
	assert.match(app, /const exitFullscreen = \(\) =>/);
	assert.match(app, /const fullscreenElement = \(\) =>/);
});

test('a same-origin /search or /discover handoff is skipped back to on player Back', () => {
	const nav = app.slice(app.indexOf('const playerNavigation = (() => {'), app.indexOf('window.addEventListener(\'popstate\''));
	assert.match(nav, /function skipBackDocument\(\)/);
	assert.match(nav, /if \(history\.length < 3\) return null;/);
	assert.match(nav, /const from = new URLSearchParams\(location\.search\)\.get\('from'\);/);
	assert.match(nav, /from === 'search' \|\| from === 'discover'/);
	assert.match(nav, /if \(skipDocument\) \{[\s\S]*?teardownPlayer\(\);[\s\S]*?history\.go\(-2\);/);
});

// ---------------------------------------------------------------------------
// Behavior-level contract: the playerNavigation state machine
// ---------------------------------------------------------------------------

const navStart = app.indexOf('const playerNavigation = (() => {');
const navEnd = app.indexOf('})();', navStart) + '})();'.length;
const navSource = app.slice(navStart, navEnd);
assert.ok(navStart >= 0 && navEnd > navStart, 'playerNavigation block is present');

function dialog(open = false) {
	const node = { open, showModalCalls: 0, closeCalls: 0 };
	node.showModal = () => { node.open = true; node.showModalCalls++; };
	node.close = () => { node.open = false; node.closeCalls++; };
	return node;
}

function fixture({ detailsOpen = false, playerOpen = false, scrollTop = 120, href = '/?view=movies', referrer = '', base = 'https://example.test', priorEntries = 0 } = {}) {
	const details = dialog(detailsOpen);
	const player = dialog(playerOpen);
	const popstate = [];
	const entries = [];
	for (let i = 0; i < priorEntries; i++) entries.push({ state: null, url: '/prior/' + i });
	entries.push({ state: null, url: href });
	let index = entries.length - 1;
	const navigation = [];
	const fire = () => { for (const fn of popstate) fn({ state: entries[index].state }); };
	const history = {
		get length() { return entries.length; },
		pushState(state, title, url) { entries.splice(index + 1); entries.push({ state, url }); index = entries.length - 1; },
		replaceState(state, title, url) { entries[index] = { state, url }; },
		back() { navigation.push({ type: 'back' }); if (index > 0) { index--; queueMicrotask(fire); } },
		forward() { navigation.push({ type: 'forward' }); if (index < entries.length - 1) { index++; queueMicrotask(fire); } },
		go(n) { navigation.push({ type: 'go', n }); index = Math.max(0, Math.min(entries.length - 1, index + n)); }
	};
	const parsed = new URL(href, base);
	const location = {
		href: parsed.href, pathname: parsed.pathname, search: parsed.search, origin: parsed.origin, replaceCalls: [],
		replace(url) { this.replaceCalls.push(url); this.href = url; }
	};
	const document = { scrollingElement: { scrollTop }, referrer };
	const state = { teardown: 0, homeFallback: 0 };
	const teardownPlayer = () => { state.teardown++; player.close(); };
	const goHomeFallback = () => { state.homeFallback++; location.replace('/'); };
	const window = { addEventListener(type, fn) { if (type === 'popstate') popstate.push(fn); } };
	const context = vm.createContext({ details, player, document, history, location, teardownPlayer, goHomeFallback, window, Number, URL, URLSearchParams });
	vm.runInContext(navSource + '\nthis.playerNavigation = playerNavigation;', context);
	popstate.push(context.playerNavigation.onPopState);
	return { nav: context.playerNavigation, details, player, history, location, document, state, entries, navigation, index: () => index, drain: () => Promise.resolve() };
}

// openPlay mirrors startPlayback: capture the origin first, then close the
// details dialog and show the player.
function openPlay(f) {
	f.nav.open();
	f.details.close();
	f.player.open = true;
}

test('fresh open records the origin and pushes exactly one history entry', () => {
	const f = fixture({ detailsOpen: true, scrollTop: 200 });
	f.nav.open();
	assert.equal(f.entries.length, 2, 'one entry pushed');
	assert.equal(f.index(), 1, 'the player entry is current');
	assert.equal(f.entries[f.index()].state.tellyboxPlayerOpen, 1, 'entry carries the player token');
	assert.equal(f.nav.isPushed(), true);
	assert.equal(f.nav.hasOrigin(), true);
	// A repeat open while already pushed (autoplay/retry/quality) is a no-op.
	f.nav.open();
	assert.equal(f.entries.length, 2, 'no duplicate entry');
});

test('Back returns to the origin screen: reopens details and restores scroll, without pushing', async () => {
	const f = fixture({ detailsOpen: true, scrollTop: 320 });
	openPlay(f);
	f.document.scrollingElement.scrollTop = 0; // something scrolled while playing
	f.nav.back(); // pushes a history.back(), which fires popstate -> finish
	await f.drain();
	assert.equal(f.state.teardown, 1, 'player torn down');
	assert.equal(f.player.open, false, 'player closed');
	assert.equal(f.details.showModalCalls, 1, 'details dialog reopened');
	assert.equal(f.document.scrollingElement.scrollTop, 320, 'scroll restored');
	assert.equal(f.index(), 0, 'back on the origin entry');
	assert.equal(f.entries.length, 2, 'closing never pushed another entry');
	assert.equal(f.nav.isPushed(), false);
});

test('browser Back (popstate) closes the player and restores the origin identically', async () => {
	const f = fixture({ detailsOpen: true, scrollTop: 88 });
	openPlay(f);
	f.document.scrollingElement.scrollTop = 0;
	f.history.back(); // the browser's own Back
	await f.drain();
	assert.equal(f.state.teardown, 1);
	assert.equal(f.details.showModalCalls, 1);
	assert.equal(f.document.scrollingElement.scrollTop, 88);
	assert.equal(f.index(), 0);
	assert.equal(f.nav.isPushed(), false);
});

test('opening from the list (no details) does not reopen a dialog, and Back does not loop', async () => {
	const f = fixture({ detailsOpen: false, scrollTop: 55 });
	openPlay(f);
	f.nav.back();
	await f.drain();
	assert.equal(f.state.teardown, 1);
	assert.equal(f.details.showModalCalls, 0, 'no details dialog was open');
	assert.equal(f.document.scrollingElement.scrollTop, 55);
	// A stale forward/back navigation after close must not tear down or push again.
	f.history.forward();
	await f.drain();
	assert.equal(f.state.teardown, 1, 'forward into a consumed entry is a no-op');
	f.history.back();
	await f.drain();
	assert.equal(f.state.teardown, 1, 'back after close is a no-op');
	assert.equal(f.entries.length, 2, 'no additional entry was ever pushed');
});

test('no recorded origin (direct link straight into playback) falls back to home', () => {
	const f = fixture({ href: '/?item=direct' });
	// Simulate a player that opened without a recorded origin: back() finishes
	// immediately with no origin snapshot.
	f.player.open = true;
	f.nav.back();
	assert.equal(f.state.teardown, 1, 'player still torn down');
	assert.equal(f.state.homeFallback, 1, 'home fallback used');
	assert.equal(f.location.replaceCalls.includes('/'), true);
});

test('a fresh open after a close records a fresh origin with a new token', async () => {
	const f = fixture({ detailsOpen: false });
	f.nav.open();
	const firstToken = f.entries[f.index()].state.tellyboxPlayerOpen;
	f.player.open = true;
	f.nav.back();
	await f.drain();
	assert.equal(f.index(), 0);
	f.nav.open();
	assert.equal(f.entries.length, 2, 'the consumed entry is truncated, not stacked');
	assert.notEqual(f.entries[f.index()].state.tellyboxPlayerOpen, firstToken, 'new token per session');
});

test('rapid Back clicks are a no-op while a Back is already in flight', async () => {
	const f = fixture({ detailsOpen: true });
	f.nav.open();
	f.player.open = true;
	// Three synchronous clicks before popstate can fire.
	f.nav.back();
	f.nav.back();
	f.nav.back();
	assert.equal(f.navigation.length, 1, 'only one history navigation is issued');
	assert.equal(f.navigation[0].type, 'back');
	assert.equal(f.index(), 0, 'the history stops on the origin, not past it');
	await f.drain();
	assert.equal(f.state.teardown, 1, 'the single Back still closes the player');
	assert.equal(f.nav.isPushed(), false);
});

test('player Back from a /search handoff skips the intermediate home entry and tears down first', () => {
	const f = fixture({ href: '/?item=abc&from=search', referrer: 'https://example.test/search?q=Alpha', detailsOpen: true, priorEntries: 1 });
	openPlay(f);
	f.nav.back();
	assert.equal(f.navigation.length, 1);
	assert.deepEqual(f.navigation[0], { type: 'go', n: -2 }, 'skips the player and the intermediate home ?item= entry');
	assert.equal(f.state.teardown, 1, 'session/progress/fullscreen teardown runs before unload');
	assert.equal(f.details.showModalCalls, 0, 'home details are not restored');
});

test('player Back from a /discover handoff is treated the same and never skips cross-origin referrers', async () => {
	const f = fixture({ href: '/?item=abc&from=discover', referrer: 'https://example.test/discover?type=movie', detailsOpen: true, priorEntries: 1 });
	openPlay(f);
	f.nav.back();
	assert.deepEqual(f.navigation[0], { type: 'go', n: -2 });

	// A cross-origin referrer must not be skipped (no external traversal).
	const g = fixture({ href: '/?item=abc', referrer: 'https://elsewhere.test/search?q=Alpha', detailsOpen: true, priorEntries: 1 });
	openPlay(g);
	g.nav.back();
	assert.deepEqual(g.navigation[0], { type: 'back' }, 'cross-origin referrer uses a normal single back');
	await g.drain();
});

test('a same-origin handoff referrer with insufficient history uses a normal in-document Back', async () => {
	const f = fixture({ href: '/?item=abc&from=search', referrer: 'https://example.test/search?q=Alpha', detailsOpen: true, priorEntries: 0 });
	openPlay(f);
	f.nav.back();
	assert.deepEqual(f.navigation[0], { type: 'back' }, 'history.length < 3 falls back to a normal Back');
	await f.drain();
	assert.equal(f.state.teardown, 1);
	assert.equal(f.details.showModalCalls, 1, 'home details restored via the in-document path');
});

test('a same-origin non-handoff referrer (home, not ?item=) uses a normal back', async () => {
	const f = fixture({ href: '/', referrer: 'https://example.test/search?q=Alpha', detailsOpen: false });
	f.nav.open();
	f.player.open = true;
	f.nav.back();
	assert.deepEqual(f.navigation[0], { type: 'back' }, 'no ?item= means no intermediate entry to skip');
	await f.drain();
	assert.equal(f.state.teardown, 1);
});
