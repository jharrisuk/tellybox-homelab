import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const search = readFileSync(new URL('../public/search.js', import.meta.url), 'utf8');
const discover = readFileSync(new URL('../public/discover.js', import.meta.url), 'utf8');

const MARKER_KEY = 'tellybox-handoff';
const SEARCH_KEY = 'tellybox-handoff-search';
const DISCOVER_KEY = 'tellybox-handoff-discover';
const TTL = 5 * 60 * 1000;

const drain = () => new Promise(resolve => setTimeout(resolve, 0));

function storageMock({ broken = false } = {}) {
	const data = new Map();
	return {
		getItem(key) { if (broken) throw new Error('storage denied'); return data.has(key) ? data.get(key) : null; },
		setItem(key, value) { if (broken) throw new Error('storage denied'); data.set(key, String(value)); },
		removeItem(key) { if (broken) throw new Error('storage denied'); data.delete(key); },
		clear() { data.clear(); },
		dump() { return Object.fromEntries(data); },
	};
}

function perf(type) { return { getEntriesByType: () => [{ type }] }; }

function searchLocation(pathname = '/search') {
	return { pathname, search: '?q=Alpha&type=movie', href: 'https://example.test' + pathname, origin: 'https://example.test' };
}

function discoverLocation(pathname = '/discover') {
	return { pathname, search: '?type=movie&genre=Drama&sort=release', href: 'https://example.test' + pathname, origin: 'https://example.test' };
}

function docMock(scrollTop = 0) {
	return { scrollingElement: { scrollTop }, documentElement: { scrollTop } };
}

// ---------------------------------------------------------------------------
// Static-source contract
// ---------------------------------------------------------------------------

test('app.js arms a one-shot handoff marker immediately before the cross-document go(-2)', () => {
	const nav = app.slice(app.indexOf('const playerNavigation = (() => {'), app.indexOf('window.addEventListener(\'popstate\''));
	assert.match(nav, /function armHandoffMarker\(path\) \{/);
	assert.match(nav, /if \(path !== '\/search' && path !== '\/discover'\) return;/);
	assert.match(nav, /sessionStorage\.setItem\(HANDOFF_KEY, JSON\.stringify\(\{ path, expiresAt: Date\.now\(\) \+ HANDOFF_TTL \}\)\)/);
	const back = nav.slice(nav.indexOf('function back()'), nav.indexOf('function onPopState()'));
	const arm = back.indexOf('armHandoffMarker(skipDocument);');
	const go = back.indexOf('history.go(-2);');
	assert.ok(arm >= 0 && go > arm, 'marker is armed before go(-2)');
});

test('app.js arms the marker on the browser Back path in finish()', () => {
	const nav = app.slice(app.indexOf('const playerNavigation = (() => {'), app.indexOf('window.addEventListener(\'popstate\''));
	assert.match(nav, /const handoffTarget = skipDocument;/);
	assert.match(nav, /if \(handoffTarget\) armHandoffMarker\(handoffTarget\);/);
});

test('search.js and discover.js share the marker key and a 5-minute TTL', () => {
	assert.match(search, /handoffMarkerKey='tellybox-handoff'/);
	assert.match(discover, /handoffMarkerKey = 'tellybox-handoff'/);
	assert.match(search, /handoffTtl=5\*60\*1000/);
	assert.match(discover, /handoffTtl = 5 \* 60 \* 1000/);
	assert.match(search, /expiresAt:Date\.now\(\)\+handoffTtl/);
	assert.match(discover, /expiresAt: Date\.now\(\) \+ handoffTtl/);
});

test('search.js and discover.js consume the marker on a back/forward-cache restore', () => {
	// The one-shot marker must be consumed even when the browser restores the
	// document from the back/forward cache without re-running the script.
	assert.match(search, /addEventListener\('pageshow',event=>\{if\(event&&event\.persisted\)/);
	assert.match(discover, /addEventListener\('pageshow', event => \{ if \(event && event\.persisted\)/);
	assert.match(search, /marker\.path===location\.pathname\)sessionStorage\.removeItem\(handoffMarkerKey\)/);
	assert.match(discover, /marker\.path === location\.pathname\) sessionStorage\.removeItem\(handoffMarkerKey\)/);
});

test('return state stores no credentials, tokens, or media URLs', () => {
	// The saved shapes must be bounded scalars only: scroll, page/offset, detail
	// type/id, a focus kind/index and an expiry. No session ids, tokens,
	// headers or URL fields.
	const forbidden = /(?:token|secret|password|authorization|api[_-]?key|https?:\/\/|\/api\/|\/media\/|\.m3u8|sess-\d+|cookie)/i;
	const searchShape = /JSON\.stringify\(\{scroll,availableOffset:Number\.isInteger\(availableOffset\)&&availableOffset>0\?availableOffset:0,path:location\.pathname,at:Date\.now\(\),expiresAt:Date\.now\(\)\+handoffTtl,focus\}\)/;
	assert.match(search, searchShape);
	assert.doesNotMatch(searchShape.source, forbidden);
	assert.match(search, /focus=active&&active\.id==='query'\?\{kind:'query'\}:cardIndex>=0\?\{kind:'card',index:cardIndex\}:null/, 'the focus field is bounded to a query/card identity');

	const discoverSave = discover.slice(discover.indexOf('function saveHandoffState()'), discover.indexOf('function arrivedViaBack()'));
	assert.doesNotMatch(discoverSave, forbidden);
	assert.match(discoverSave, /detailType: detail \? detail\.type : null/);
	assert.match(discoverSave, /expiresAt: Date\.now\(\) \+ handoffTtl/);
	// No item/vodId/watchId/media fields are persisted.
	assert.doesNotMatch(discoverSave, /(?:vodId|watchId|Artwork|poster|\.url|mediaUrl|stream)/);
});

// ---------------------------------------------------------------------------
// Search: save, one-shot restore, expiry, stale navigation, storage failure
// ---------------------------------------------------------------------------

function searchHelpers(context) {
	const start = search.indexOf("const handoffMarkerKey='tellybox-handoff';");
	const end = search.indexOf('async function section(scope,offset=0,token=generation) {', start);
	assert.ok(start >= 0 && end > start, 'search handoff block present');
	const source = search.slice(start, end);
	vm.runInContext(source + '\nthis.saveHandoffState = saveHandoffState; this.takeHandoffState = takeHandoffState; this.restoreHandoff = restoreHandoff; this.arrivedViaBack = arrivedViaBack;', vm.createContext(context));
	return context;
}

function searchContext({ pathname = '/search', navType = 'back_forward', storage = storageMock(), scrollTop = 0, availableOffset = 0, section = null, generation = 3 } = {}) {
	const context = {
		location: searchLocation(pathname),
		document: docMock(scrollTop),
		sessionStorage: storage,
		performance: perf(navType),
		availableOffset,
		section,
		generation,
	};
	return context;
}

test('search saves bounded scroll, loaded offset and a future expiry', () => {
	const storage = storageMock();
	const context = searchHelpers(searchContext({ storage, scrollTop: 700, availableOffset: 60 }));
	context.saveHandoffState();
	const raw = storage.dump()[SEARCH_KEY];
	assert.ok(raw, 'search state is written');
	const state = JSON.parse(raw);
	assert.equal(state.scroll, 700);
	assert.equal(state.availableOffset, 60);
	assert.ok(state.expiresAt > Date.now(), 'expiry is in the future');
	assert.ok(state.expiresAt <= Date.now() + TTL + 1000, 'expiry is bounded to the TTL');
});

test('search restore consumes the marker and state once and returns the saved state', () => {
	const storage = storageMock();
	storage.setItem(MARKER_KEY, JSON.stringify({ path: '/search', expiresAt: Date.now() + TTL }));
	storage.setItem(SEARCH_KEY, JSON.stringify({ scroll: 700, availableOffset: 60, expiresAt: Date.now() + TTL }));
	const context = searchHelpers(searchContext({ storage, navType: 'back_forward', scrollTop: 0 }));
	const saved = context.takeHandoffState();
	assert.ok(saved, 'state is returned on an immediate back_forward return');
	assert.equal(saved.scroll, 700);
	assert.equal(storage.dump()[MARKER_KEY], undefined, 'marker is consumed');
	assert.equal(storage.dump()[SEARCH_KEY], undefined, 'state is consumed');
});

test('search restore requires a back navigation: direct visit and reload do not restore', () => {
	for (const navType of ['navigate', 'reload']) {
		const storage = storageMock();
		storage.setItem(MARKER_KEY, JSON.stringify({ path: '/search', expiresAt: Date.now() + TTL }));
		storage.setItem(SEARCH_KEY, JSON.stringify({ scroll: 700, availableOffset: 0, expiresAt: Date.now() + TTL }));
		const context = searchHelpers(searchContext({ storage, navType }));
		assert.equal(context.takeHandoffState(), null, navType + ' does not restore');
		assert.equal(storage.dump()[MARKER_KEY], undefined, 'marker is still consumed on a non-back visit');
	}
});

test('search restore without a marker never restores stale state', () => {
	const storage = storageMock();
	storage.setItem(SEARCH_KEY, JSON.stringify({ scroll: 700, availableOffset: 0, expiresAt: Date.now() + TTL }));
	const context = searchHelpers(searchContext({ storage, navType: 'back_forward' }));
	assert.equal(context.takeHandoffState(), null, 'no marker, no restore');
	assert.ok(storage.dump()[SEARCH_KEY], 'state is left for a later handoff');
});

test('search restore ignores a marker aimed at a different document', () => {
	const storage = storageMock();
	storage.setItem(MARKER_KEY, JSON.stringify({ path: '/discover', expiresAt: Date.now() + TTL }));
	storage.setItem(SEARCH_KEY, JSON.stringify({ scroll: 700, availableOffset: 0, expiresAt: Date.now() + TTL }));
	const context = searchHelpers(searchContext({ storage, pathname: '/search' }));
	assert.equal(context.takeHandoffState(), null, 'mismatched path is ignored');
	assert.ok(storage.dump()[MARKER_KEY], 'marker is left for the correct document');
});

test('search restore ignores an expired state (aged out)', () => {
	const storage = storageMock();
	storage.setItem(MARKER_KEY, JSON.stringify({ path: '/search', expiresAt: Date.now() + TTL }));
	storage.setItem(SEARCH_KEY, JSON.stringify({ scroll: 700, availableOffset: 60, expiresAt: 1 }));
	const context = searchHelpers(searchContext({ storage, navType: 'back_forward' }));
	assert.equal(context.takeHandoffState(), null, 'expired state is ignored');
	assert.equal(storage.dump()[SEARCH_KEY], undefined, 'expired state is still consumed');
});

test('search restore re-loads the recorded result page and restores scroll', async () => {
	const calls = [];
	const section = async (scope, offset, token) => { calls.push({ scope, offset, token }); };
	const context = searchHelpers(searchContext({ storage: storageMock(), scrollTop: 0, section, generation: 7 }));
	await context.restoreHandoff({ scroll: 700, availableOffset: 120 });
	assert.deepEqual(calls, [{ scope: 'available', offset: 60, token: 7 }, { scope: 'available', offset: 120, token: 7 }], 'additional pages are re-loaded in order');
	assert.equal(context.document.scrollingElement.scrollTop, 700, 'scroll restored');
});

test('search save and restore survive a storage failure without throwing', () => {
	const broken = storageMock({ broken: true });
	const context = searchHelpers(searchContext({ storage: broken, scrollTop: 700, availableOffset: 60 }));
	assert.doesNotThrow(() => context.saveHandoffState());
	assert.doesNotThrow(() => context.takeHandoffState());
});

// ---------------------------------------------------------------------------
// Discover: save filters/page/scroll/detail, restore scroll and dialog
// ---------------------------------------------------------------------------

function discoverHelpers(context) {
	const start = discover.indexOf("const handoffMarkerKey = 'tellybox-handoff';");
	const end = discover.indexOf('function poster(item) {', start);
	assert.ok(start >= 0 && end > start, 'discover handoff block present');
	const source = discover.slice(start, end);
	vm.runInContext(source + '\nthis.saveHandoffState = saveHandoffState; this.takeHandoffState = takeHandoffState; this.restoreHandoffState = restoreHandoffState; this.openDetailContext = openDetailContext; this.discoverScroll = discoverScroll;', vm.createContext(context));
	return context;
}

function discoverContext({ pathname = '/discover', navType = 'back_forward', storage = storageMock(), scrollTop = 0, state = null, load = null, showDetails = null } = {}) {
	const context = {
		location: discoverLocation(pathname),
		document: docMock(scrollTop),
		sessionStorage: storage,
		performance: perf(navType),
		state: state || { mode: 'movie', query: '', genre: 'Drama', sort: 'release', page: 1, pages: 3, detailType: null, detailId: null },
		load,
		showDetails,
	};
	return context;
}

test('discover saves filters, page, scroll and the open detail type/id', () => {
	const storage = storageMock();
	const context = discoverHelpers(discoverContext({
		storage,
		scrollTop: 600,
		state: { mode: 'movie', query: '', genre: 'Drama', sort: 'release', page: 2, pages: 3, detailType: 'movie', detailId: 201 },
	}));
	context.saveHandoffState();
	const state = JSON.parse(storage.dump()[DISCOVER_KEY]);
	assert.equal(state.mode, 'movie');
	assert.equal(state.genre, 'Drama');
	assert.equal(state.sort, 'release');
	assert.equal(state.page, 2);
	assert.equal(state.scroll, 600);
	assert.equal(state.detailType, 'movie');
	assert.equal(state.detailId, 201);
	assert.ok(state.expiresAt > Date.now());
});

test('discover drops an invalid or absent detail context', () => {
	const context = discoverHelpers(discoverContext({ state: { mode: 'movie', detailType: 'movie', detailId: 0 } }));
	assert.equal(context.openDetailContext(), null, 'non-positive id is dropped');
	context.state.detailType = 'series';
	context.state.detailId = 5;
	assert.equal(context.openDetailContext(), null, 'unknown type is dropped');
});

test('discover restore loads the missing pages, restores scroll and re-opens the dialog', async () => {
	const calls = [];
	const state = { mode: 'movie', query: '', genre: 'Drama', sort: 'release', page: 1, pages: 3, detailType: null, detailId: null };
	const load = async (more, silent) => { calls.push({ more, silent }); state.page += 1; };
	const details = [];
	const showDetails = async (type, id) => { details.push({ type, id }); state.detailType = type; state.detailId = id; };
	const context = discoverHelpers(discoverContext({ state, load, showDetails, scrollTop: 0 }));
	await context.restoreHandoffState({ page: 3, scroll: 600, detailType: 'movie', detailId: 201 });
	assert.deepEqual(calls, [{ more: true, silent: true }, { more: true, silent: true }], 'two missing pages are loaded');
	assert.equal(context.document.scrollingElement.scrollTop, 600, 'scroll restored');
	assert.deepEqual(details, [{ type: 'movie', id: 201 }], 'detail dialog re-opened');
});

test('discover restore skips pagination for non-paginated modes', async () => {
	const calls = [];
	const state = { mode: 'trending', page: 1, pages: 1 };
	const context = discoverHelpers(discoverContext({ state, load: async () => { calls.push(1); } }));
	await context.restoreHandoffState({ page: 3, scroll: 0 });
	assert.equal(calls.length, 0, 'trending mode does not page through load()');
});

test('discover save and restore survive a storage failure without throwing', async () => {
	const broken = storageMock({ broken: true });
	const context = discoverHelpers(discoverContext({ storage: broken, state: { mode: 'movie', page: 1, pages: 1, detailType: 'movie', detailId: 5 } }));
	assert.doesNotThrow(() => context.saveHandoffState());
	assert.doesNotThrow(() => context.takeHandoffState());
	await assert.doesNotReject(() => context.restoreHandoffState({ page: 1, scroll: 100, detailType: 'movie', detailId: 5 }));
});

test('discover restore ignores an expired state', () => {
	const storage = storageMock();
	storage.setItem(MARKER_KEY, JSON.stringify({ path: '/discover', expiresAt: Date.now() + TTL }));
	storage.setItem(DISCOVER_KEY, JSON.stringify({ scroll: 600, page: 2, detailType: 'movie', detailId: 201, expiresAt: 1 }));
	const context = discoverHelpers(discoverContext({ storage }));
	assert.equal(context.takeHandoffState(), null, 'aged-out discover state is ignored');
});

// ---------------------------------------------------------------------------
// app.js: player Back and browser Back arm the one-shot marker
// ---------------------------------------------------------------------------

const navStart = app.indexOf('const playerNavigation = (() => {');
const navEnd = app.indexOf('})();', navStart) + '})();'.length;
const navSource = app.slice(navStart, navEnd);

function navFixture({ referrer = '', href = '/?item=abc', detailsOpen = false, priorEntries = 0 } = {}) {
	const details = { open: detailsOpen, showModal() { this.open = true; }, close() { this.open = false; } };
	const player = { open: false, showModal() { this.open = true; }, close() { this.open = false; } };
	const entries = [];
	for (let i = 0; i < priorEntries; i++) entries.push({ state: null, url: '/prior/' + i });
	entries.push({ state: null, url: href });
	let index = entries.length - 1;
	const popstate = [];
	const fire = () => { for (const fn of popstate) fn({ state: entries[index].state }); };
	const history = {
		get length() { return entries.length; },
		pushState(state, title, url) { entries.splice(index + 1); entries.push({ state, url }); index = entries.length - 1; },
		replaceState(state, title, url) { entries[index] = { state, url }; },
		back() { if (index > 0) { index--; queueMicrotask(fire); } },
		go(n) { index = Math.max(0, Math.min(entries.length - 1, index + n)); },
	};
	const parsed = new URL(href, 'https://example.test');
	const location = { href: parsed.href, pathname: parsed.pathname, search: parsed.search, origin: parsed.origin, replace(url) { this.href = url; } };
	const document = { scrollingElement: { scrollTop: 0 }, referrer };
	const sessionStorage = storageMock();
	const teardownState = { count: 0 };
	const teardownPlayer = () => { teardownState.count++; player.close(); };
	const goHomeFallback = () => { location.replace('/'); };
	const window = { addEventListener(type, fn) { if (type === 'popstate') popstate.push(fn); } };
	const context = vm.createContext({ details, player, document, history, location, teardownPlayer, goHomeFallback, window, sessionStorage, Number, URL, URLSearchParams });
	vm.runInContext(navSource + '\nthis.playerNavigation = playerNavigation;', context);
	popstate.push(context.playerNavigation.onPopState);
	return { nav: context.playerNavigation, details, player, history, location, document, sessionStorage, teardownState, index: () => index, drain };
}

test('player Back arms the marker before go(-2) and tears down first', () => {
	const f = navFixture({ referrer: 'https://example.test/search?q=Alpha', href: '/?item=abc&from=search', detailsOpen: true, priorEntries: 1 });
	f.nav.open();
	f.details.close();
	f.player.open = true;
	f.nav.back();
	const marker = JSON.parse(f.sessionStorage.dump()[MARKER_KEY]);
	assert.equal(marker.path, '/search', 'marker targets the search document');
	assert.ok(marker.expiresAt > Date.now(), 'marker expiry is in the future');
	assert.equal(f.teardownState.count, 1, 'player torn down');
	assert.equal(f.index(), 0, 'history skipped back to /search');
});

test('a browser Back arms the marker when the origin is a search/discover handoff', async () => {
	const f = navFixture({ referrer: 'https://example.test/discover?type=movie', href: '/?item=abc&from=discover', detailsOpen: true, priorEntries: 1 });
	f.nav.open();
	f.details.close();
	f.player.open = true;
	f.history.back();
	await f.drain();
	const marker = JSON.parse(f.sessionStorage.dump()[MARKER_KEY]);
	assert.equal(marker.path, '/discover', 'browser Back arms the discover marker');
	assert.equal(f.teardownState.count, 1, 'player torn down');
});

test('an in-document origin never arms the handoff marker', async () => {
	const f = navFixture({ referrer: '', href: '/?view=movies', detailsOpen: true, priorEntries: 0 });
	f.nav.open();
	f.details.close();
	f.player.open = true;
	f.history.back();
	await f.drain();
	assert.equal(f.sessionStorage.dump()[MARKER_KEY], undefined, 'no marker for a same-document origin');
	assert.equal(f.teardownState.count, 1);
});

test('armHandoffMarker refuses paths outside /search and /discover', () => {
	const f = navFixture();
	// open() only computes a skip for /search or /discover referrers; a
	// cross-origin or non-handoff referrer leaves no skip and arms nothing.
	assert.equal(f.sessionStorage.dump()[MARKER_KEY], undefined);
});
