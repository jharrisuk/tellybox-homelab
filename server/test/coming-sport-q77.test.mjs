// Q77: Sport is a first-class section of Coming Soon.
// Mounts the real page scripts in a vm with a schedule that contains sport,
// and asserts the redesign: sport visible without a tab switch, owned
// channels only, a persistent "UK football only" toggle, calendar fixture
// markers, and the removal of the old <details> browse control.
// No network: fetch is stubbed and counted.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const read = name => readFileSync(new URL('../public/' + name, import.meta.url), 'utf8');

function makeNode(tag) {
	return {
		tag, className: '', textContent: '', href: '', hidden: false, open: false, dataset: {}, children: [], attributes: {},
		append(...items) { this.children.push(...items); },
		replaceChildren(...items) { this.children = [...items]; },
		setAttribute(name, value) { this.attributes[name] = String(value); },
		getAttribute(name) { return Object.hasOwn(this.attributes, name) ? this.attributes[name] : null; },
		addEventListener() {}, remove() {}, focus() {},
		classList: { add() {}, remove() {}, toggle() {} },
		showModal() { this.open = true; }, close() { this.open = false; }
	};
}
function walk(node, visit) {
	visit(node);
	for (const child of node.children || []) walk(child, visit);
}
const textOf = node => [node.textContent, ...(node.children || []).map(textOf)].filter(Boolean).join(' ');

function makeStore(initial = {}) {
	const values = new Map(Object.entries(initial));
	return { values, getItem: key => values.has(key) ? values.get(key) : null, setItem: (key, value) => values.set(key, String(value)) };
}

async function mount(schedule, search = '', store = makeStore()) {
	const nodes = new Map();
	const selectorNode = selector => { if (!nodes.has(selector)) nodes.set(selector, makeNode('div')); return nodes.get(selector); };
	const tabs = ['tv', 'movie'].map(type => { const tab = makeNode('button'); tab.dataset.coming = type; return tab; });
	let fetches = 0;
	const context = vm.createContext({
		window: { addEventListener() {} },
		document: { createElement: makeNode, querySelector: selectorNode, querySelectorAll: selector => selector === '[data-coming]' ? tabs : [] },
		location: { href: 'http://localhost/coming-soon' + search, search, pathname: '/coming-soon', assign() {}, replace() {} },
		history: { state: null, replaceState() {}, pushState() {}, back() {} },
		matchMedia: () => ({ matches: false, addEventListener() {} }),
		fetch: async () => { fetches++; return { ok: true, status: 200, json: async () => schedule }; },
		localStorage: store,
		URL, URLSearchParams, console
	});
	vm.runInContext(read('visitor-ui.js'), context);
	vm.runInContext('jserverUI = window.jserverUI;', context);
	vm.runInContext(read('coming-calendar.js'), context);
	vm.runInContext('jserverCalendar = window.jserverCalendar;', context);
	vm.runInContext(read('coming-soon.js'), context);
	await new Promise(resolve => setImmediate(resolve));
	return { nodes, selectorNode, tabs, store, fetches: () => fetches };
}

const fixture = (id, title, competition, channels, day = 2) => ({
	type: 'sport', id, title, competition,
	date: new Date(Date.now() + day * 86400000 + 5 * 3600000).toISOString(),
	dateLabel: day === 0 ? 'Today' : day === 1 ? 'Tomorrow' : 'In a few days', channels
});
const owned = name => ({ name, channelId: 'chan-' + name.toLowerCase().replace(/[^a-z0-9]+/g, '-') });
const schedule = {
	tv: [], movies: [], unavailable: [], sportUnavailable: false,
	sport: [
		fixture('sport-a', 'Hearts v Celtic', 'Scottish Premiership', [owned('Premier Sports 1'), { name: 'Premier Sports 2' }], 2),
		fixture('sport-b', 'Arsenal v Chelsea', 'Premier League', [owned('Sky Sports Football')], 2),
		fixture('sport-c', 'Liverpool v Everton', 'Premier League', [owned('Sky Sports Main Event')], 3),
		fixture('sport-d', 'Real Madrid v Barcelona', 'La Liga', [owned('Premier Sports 1')], 1),
		fixture('sport-e', 'Manchester United v Leeds', 'FA Cup', [{ name: 'BBC One' }], 2)
	]
};

test('Sport is visible on first paint, without opening browse or switching a tab', async () => {
	const { selectorNode, tabs } = await mount(schedule);
	assert.equal(selectorNode('#comingSport').hidden, false);
	const text = textOf(selectorNode('#sportList'));
	assert.match(text, /Hearts v Celtic/);
	assert.match(text, /Arsenal v Chelsea/);
	assert.match(text, /Scottish Premiership/);
	assert.match(text, /Premier League/);
	assert.doesNotMatch(textOf(selectorNode('#comingGrid')), /Hearts v Celtic/, 'the browse grid keeps TV and films only');
	assert.equal(tabs[0].getAttribute('aria-pressed'), 'true', 'Episodes stays the selected browse segment');
	assert.equal(tabs[1].getAttribute('aria-pressed'), 'false');
});

test('only owned channels render; a fixture we cannot play says so plainly', async () => {
	const { selectorNode } = await mount(schedule);
	const text = textOf(selectorNode('#sportList'));
	assert.match(text, /Premier Sports 1/);
	assert.match(text, /Sky Sports Football/);
	assert.doesNotMatch(text, /Premier Sports 2/, 'an unowned broadcaster is never named on a card');
	assert.doesNotMatch(text, /BBC One/);
	const unownedCard = selectorNode('#sportList').children.find(node => textOf(node).includes('Manchester United v Leeds'));
	assert.match(textOf(unownedCard), /Not on your channels/);
});

test('the UK toggle defaults on, filters non-UK football, and is remembered in localStorage', async () => {
	const first = await mount(schedule);
	const toggle = first.selectorNode('#ukOnlyToggle');
	assert.equal(toggle.getAttribute('aria-pressed'), 'true', 'default is UK football only');
	assert.doesNotMatch(textOf(first.selectorNode('#sportList')), /Real Madrid/, 'La Liga is hidden while the toggle is on');
	toggle.onclick();
	assert.equal(toggle.getAttribute('aria-pressed'), 'false');
	assert.equal(first.store.values.get('tellybox.coming.ukOnly'), '0', 'the preference is persisted');
	assert.match(textOf(first.selectorNode('#sportList')), /Real Madrid/);
	assert.match(textOf(first.selectorNode('#sportList')), /La Liga/);
	toggle.onclick();
	assert.equal(first.store.values.get('tellybox.coming.ukOnly'), '1');
	assert.doesNotMatch(textOf(first.selectorNode('#sportList')), /Real Madrid/);
	// A fresh page load restores the stored preference in both directions.
	const off = await mount(schedule, '', makeStore({ 'tellybox.coming.ukOnly': '0' }));
	assert.equal(off.selectorNode('#ukOnlyToggle').getAttribute('aria-pressed'), 'false');
	assert.match(textOf(off.selectorNode('#sportList')), /Real Madrid/);
	const on = await mount(schedule, '', makeStore({ 'tellybox.coming.ukOnly': '1' }));
	assert.equal(on.selectorNode('#ukOnlyToggle').getAttribute('aria-pressed'), 'true');
	assert.doesNotMatch(textOf(on.selectorNode('#sportList')), /Real Madrid/);
});

test('the documented UK competition list passes the filter; unknown competitions do not', async () => {
	const uk = ['Premier League', 'Championship', 'League One', 'League Two', 'FA Cup', 'EFL Cup', 'Carabao Cup',
		'Scottish Premiership', 'Scottish Championship', 'Scottish Cup', "Women's Super League", 'Community Shield', 'National League',
		'English Premier League', 'EFL Championship', 'Emirates FA Cup', "Barclays Women's Super League"];
	const other = ['La Liga', 'Bundesliga', 'UEFA Champions League', 'International Friendly', ''];
	const competitions = [...uk, ...other];
	const rail = { tv: [], movies: [], unavailable: [], sportUnavailable: false,
		sport: competitions.map((competition, index) => fixture('comp-' + index, 'Match ' + index, competition, [owned('Sky Sports Football')], 1)) };
	const { selectorNode } = await mount(rail);
	selectorNode('#sportMore').onclick(); // expand past the preview so every card renders
	const onText = textOf(selectorNode('#sportList'));
	uk.forEach((_, index) => assert.match(onText, new RegExp('Match ' + index + '\\b'), 'UK competition ' + competitions[index] + ' is kept'));
	other.forEach((_, index) => assert.doesNotMatch(onText, new RegExp('Match ' + (uk.length + index) + '\\b'), 'unknown competition ' + JSON.stringify(competitions[uk.length + index]) + ' is excluded'));
	selectorNode('#ukOnlyToggle').onclick();
	selectorNode('#sportMore').onclick();
	const offText = textOf(selectorNode('#sportList'));
	other.forEach((_, index) => assert.match(offText, new RegExp('Match ' + (uk.length + index) + '\\b'), 'with the toggle off every competition shows'));
});

test('when the toggle hides everything the panel says so plainly', async () => {
	const onlyNonUk = { tv: [], movies: [], unavailable: [], sportUnavailable: false,
		sport: [fixture('sport-x', 'Real Madrid v Barcelona', 'La Liga', [owned('Premier Sports 1')], 1)] };
	const { selectorNode } = await mount(onlyNonUk);
	assert.equal(selectorNode('#sportStatus').textContent, 'No UK football in the next three days. Turn off “UK football only” to see every televised match.');
	assert.equal(selectorNode('#sportList').children.length, 0);
	selectorNode('#ukOnlyToggle').onclick();
	assert.equal(selectorNode('#sportStatus').hidden, true);
	assert.equal(selectorNode('#sportList').children.length, 1);
});

// The calendar marker must agree with the visible (filtered) fixture list,
// whatever the runtime timezone: expected labels are derived from the same
// fixture instants the page renders.
function expectedMarkerCounts(items) {
	const counts = new Map();
	for (const item of items) {
		const label = new Date(item.date).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' });
		counts.set(label, (counts.get(label) || 0) + 1);
	}
	return counts;
}
function renderedMarkerCounts(grid) {
	const counts = new Map();
	walk(grid, node => {
		if (node.className !== 'calendar-sport') return;
		const section = node.__section;
		const label = section.getAttribute('aria-label');
		counts.set(label, (counts.get(label) || 0) + Number(node.children[1].textContent));
	});
	return counts;
}
function attachSections(grid) {
	walk(grid, node => {
		if (typeof node.className === 'string' && /^calendar-day(\s|$)/.test(node.className) && !node.className.includes('empty')) {
			walk(node, child => { child.__section = node; });
		}
	});
}

test('the calendar keeps Monday alignment and marks fixture days with icon and count', async () => {
	const withFilm = { ...schedule, movies: [{ type: 'movie', id: 9, title: 'Test Film', dateLabel: 'Released', released: false, date: fixture('f', '', '', [], 2).date, ratings: [] }] };
	const { selectorNode } = await mount(withFilm);
	const grid = selectorNode('#calendarDays').children[0];
	assert.deepEqual(Array.from(grid.children.slice(0, 7), cell => cell.textContent), ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'], 'Monday-first columns are unchanged');
	assert.equal(grid.children.length % 7, 0, 'whole weeks keep a Monday above a Monday');
	attachSections(grid);
	const visible = schedule.sport.filter(item => item.competition !== 'La Liga');
	assert.deepEqual(renderedMarkerCounts(grid), expectedMarkerCounts(visible), 'markers follow the UK filter');
	let markers = 0;
	walk(grid, node => {
		if (node.className !== 'calendar-sport') return;
		markers++;
		assert.equal(node.tag, 'button');
		assert.equal(node.children[0].textContent, '⚽');
		assert.equal(node.children[0].getAttribute('aria-hidden'), 'true');
		assert.match(node.getAttribute('aria-label'), /football match/);
		node.onclick(); // jumps to the sport panel; must not throw in any environment
	});
	assert.ok(markers > 0, 'fixture days carry a marker');
	assert.ok(textOf(grid).includes('Test Film'), 'TV and film entries still render alongside markers');
	// Turning the toggle off adds the La Liga day back to the markers.
	selectorNode('#ukOnlyToggle').onclick();
	const offGrid = selectorNode('#calendarDays').children[0];
	attachSections(offGrid);
	assert.deepEqual(renderedMarkerCounts(offGrid), expectedMarkerCounts(schedule.sport));
});

test('the sport list expands inline instead of hiding behind a details toggle', async () => {
	const many = { tv: [], movies: [], unavailable: [], sportUnavailable: false,
		sport: Array.from({ length: 8 }, (_, index) => fixture('m-' + index, 'Match ' + index, 'Premier League', [owned('Sky Sports Football')], 1)) };
	const { selectorNode } = await mount(many);
	assert.equal(selectorNode('#sportList').children.length, 6, 'a compact desktop preview');
	const more = selectorNode('#sportMore');
	assert.equal(more.hidden, false);
	assert.equal(more.textContent, 'Show all 8 matches');
	assert.equal(more.getAttribute('aria-expanded'), 'false');
	more.onclick();
	assert.equal(selectorNode('#sportList').children.length, 8);
	assert.equal(more.textContent, 'Show fewer');
	assert.equal(more.getAttribute('aria-expanded'), 'true');
});

test('a sport deep link still opens the fixture details', async () => {
	const { selectorNode } = await mount(schedule, '?type=sport&title=sport-a');
	assert.equal(selectorNode('#comingDetails').open, true);
	assert.match(textOf(selectorNode('#comingDetailsBody')), /Hearts v Celtic/);
});

test('the old details browse control is gone and the page stays accessible', async () => {
	const html = read('coming-soon.html');
	assert.doesNotMatch(html, /<details/i, 'no collapsed details control remains');
	assert.doesNotMatch(html, /<summary/i);
	assert.match(html, /id="comingFilters" role="group"/, 'a labelled segmented control replaces it');
	assert.match(html, /data-coming="tv"/);
	assert.match(html, /data-coming="movie"/);
	assert.doesNotMatch(html, /data-coming="sport"/, 'sport no longer hides behind a browse chip');
	assert.match(html, /<button class="uk-toggle" id="ukOnlyToggle" type="button" aria-pressed="true">UK football only<\/button>/, 'the toggle is a real keyboard-operable button');
	assert.match(html, /id="comingSport"[^>]*tabindex="-1"/, 'the sport panel can receive focus from calendar markers');
	assert.equal((html.match(/<h1[ >]/g) || []).length, 1, 'exactly one h1');
	assert.match(html, /id="sportStatus" class="sport-status" role="status"/);
	assert.match(html, /id="sportMore"[^>]*aria-controls="sportList"/);
});

test('rendering uses no innerHTML and makes exactly one API request', async () => {
	const js = read('coming-soon.js');
	assert.doesNotMatch(js, /innerHTML/, 'data is only ever rendered through textContent/createElement');
	const { fetches } = await mount(schedule);
	assert.equal(fetches(), 1, 'the single /api/coming-soon request is unchanged');
});
