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

async function mount(schedule, search = '') {
	const nodes = new Map();
	const selectorNode = selector => { if (!nodes.has(selector)) nodes.set(selector, makeNode('div')); return nodes.get(selector); };
	const tabs = ['tv', 'movie'].map(type => { const tab = makeNode('button'); tab.dataset.coming = type; return tab; });
	const context = vm.createContext({
		window: { addEventListener() {} },
		document: { createElement: makeNode, querySelector: selectorNode, querySelectorAll: selector => selector === '[data-coming]' ? tabs : [] },
		location: { href: 'http://localhost/coming-soon' + search, search, pathname: '/coming-soon', assign() {}, replace() {} },
		history: { state: null, replaceState() {}, pushState() {}, back() {} },
		matchMedia: () => ({ matches: false, addEventListener() {} }),
		fetch: async () => ({ ok: true, status: 200, json: async () => schedule }),
		URL, URLSearchParams, console
	});
	vm.runInContext(read('visitor-ui.js'), context);
	vm.runInContext('jserverUI = window.jserverUI;', context);
	vm.runInContext(read('coming-calendar.js'), context);
	vm.runInContext('jserverCalendar = window.jserverCalendar;', context);
	vm.runInContext(read('coming-soon.js'), context);
	await new Promise(resolve => setImmediate(resolve));
	return { nodes, selectorNode };
}

const fixture = (id, title, competition, channels, day = 2) => ({
	type: 'sport', id, title, competition,
	date: new Date(Date.now() + day * 86400000 + 5 * 3600000).toISOString(),
	dateLabel: 'In two days', channels
});
const schedule = {
	tv: [], movies: [], unavailable: [], sportUnavailable: false,
	sport: [
		fixture('sport-a', 'Hearts v Celtic', 'Scottish Premiership', [{ name: 'Premier Sports 1', channelId: 'chan-1' }, { name: 'Premier Sports 2' }]),
		fixture('sport-b', 'Arsenal v Chelsea', 'Premier League', [{ name: 'Sky Sports Football', channelId: 'chan-2' }], 3)
	]
};

test('the Sport panel shows the next fixtures without opening browse or switching tabs', async () => {
	const { selectorNode } = await mount(schedule);
	const list = selectorNode('#sportList');
	const text = textOf(list);
	assert.match(text, /Hearts v Celtic/);
	assert.match(text, /Scottish Premiership/);
	assert.match(text, /Arsenal v Chelsea/);
	assert.match(text, /Premier League/);
	assert.equal(selectorNode('#comingSport').hidden, false, 'the sport panel is visible on first paint');
	assert.equal(selectorNode('#comingHero').hidden, true, 'fixtures do not take over the hero');
	assert.equal(selectorNode('#sportStatus').hidden, true);
	assert.doesNotMatch(textOf(selectorNode('#comingGrid')), /Hearts v Celtic/, 'fixtures live in the sport panel, not the browse grid');
});

test('only channels in the installation lineup render on fixture cards', async () => {
	const { selectorNode } = await mount(schedule);
	const text = textOf(selectorNode('#sportList'));
	assert.match(text, /Premier Sports 1/);
	assert.match(text, /Sky Sports Football/);
	assert.doesNotMatch(text, /Premier Sports 2/, 'a broadcaster we cannot play is never listed');
});

test('a fixture opens details listing only the channels we have', async () => {
	const { selectorNode } = await mount(schedule);
	const card = selectorNode('#sportList').children[0];
	card.onclick();
	const dialog = selectorNode('#comingDetails');
	assert.equal(dialog.open, true);
	const body = textOf(selectorNode('#comingDetailsBody'));
	assert.match(body, /Where to watch/);
	assert.match(body, /Premier Sports 1 In your lineup/);
	assert.doesNotMatch(body, /Premier Sports 2/);
	assert.doesNotMatch(body, /Not in your lineup/);
	assert.match(body, /live-footballontv\.com/);
	assert.match(body, /Kick-off times use your device time zone/);
});

test('a fixture with no owned channel says so plainly instead of naming broadcasters', async () => {
	const unowned = { tv: [], movies: [], unavailable: [], sportUnavailable: false,
		sport: [fixture('sport-c', 'Manchester United v Leeds', 'FA Cup', [{ name: 'BBC One' }, { name: 'ITV 1' }])] };
	const { selectorNode } = await mount(unowned);
	const card = selectorNode('#sportList').children[0];
	const text = textOf(card);
	assert.match(text, /Not on your channels/);
	assert.doesNotMatch(text, /BBC One|ITV 1/);
	card.onclick();
	const body = textOf(selectorNode('#comingDetailsBody'));
	assert.match(body, /This match is not on a channel in your lineup\./);
	assert.doesNotMatch(body, /BBC One|ITV 1/);
});

test('an empty sport list says so plainly instead of using the film wording', async () => {
	const { selectorNode } = await mount({ tv: [], movies: [], sport: [], unavailable: [], sportUnavailable: false });
	assert.equal(selectorNode('#sportStatus').textContent, 'No televised football in the next three days.');
});

test('a source outage marks the rail unavailable without breaking TV or films', async () => {
	const { selectorNode } = await mount({ tv: [], movies: [], sport: [], unavailable: [], sportUnavailable: true });
	assert.equal(selectorNode('#sportStatus').textContent, 'Football listings are temporarily unavailable. Please check back shortly.');
	const tv = await mount({ tv: [], movies: [], sport: [], unavailable: [], sportUnavailable: true }, '?type=tv');
	assert.equal(tv.selectorNode('#comingStatus').textContent, 'Nothing dated yet. As soon as a release is announced, it’ll appear here.');
});
