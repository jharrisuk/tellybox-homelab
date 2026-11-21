import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const read = name => readFileSync(new URL('../public/' + name, import.meta.url), 'utf8');

function makeNode(tag) {
	const node = {
		tag, className: '', textContent: '', href: '', hidden: false, open: false, dataset: {}, children: [], attributes: {},
		append(...items) { this.children.push(...items); },
		replaceChildren(...items) { this.children = [...items]; },
		setAttribute(name, value) { this.attributes[name] = String(value); },
		getAttribute(name) { return Object.hasOwn(this.attributes, name) ? this.attributes[name] : null; },
		addEventListener() {},
		remove() {},
		focus() {},
		classList: { add() {}, remove() {}, toggle() {} },
		showModal() { this.open = true; },
		close() { this.open = false; }
	};
	return node;
}

function walk(node, visit) {
	visit(node);
	for (const child of node.children || []) walk(child, visit);
}

function textOf(node) {
	return [node.textContent, ...(node.children || []).map(textOf)].filter(Boolean).join(' ');
}

async function mount(schedule) {
	const nodes = new Map();
	const navigations = [];
	const selectorNode = selector => {
		if (!nodes.has(selector)) nodes.set(selector, makeNode('div'));
		return nodes.get(selector);
	};
	const tabs = ['tv', 'movie'].map(type => {
		const tab = makeNode('button');
		tab.dataset.coming = type;
		return tab;
	});
	const document = {
		createElement: makeNode,
		querySelector: selectorNode,
		querySelectorAll: selector => selector === '[data-coming]' ? tabs : []
	};
	const location = { href: 'http://localhost/coming-soon', search: '', pathname: '/coming-soon',
		assign(url) { navigations.push(url); }, replace() {} };
	const context = vm.createContext({
		window: { addEventListener() {} },
		document,
		location,
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
	return { nodes, navigations, document, selectorNode };
}

const day = offset => new Date(Date.now() + offset * 86400000).toISOString();
function findButton(root, text) {
	let found = null;
	walk(root, node => { if (!found && node.tag === 'button' && textOf(node).includes(text)) found = node; });
	return found;
}

test('past days are grouped as Recently released and library titles open in the library', async () => {
	const schedule = {
		tv: [],
		movies: [
			{ type: 'movie', id: 1, title: 'Library film', dateLabel: 'Released', released: true, date: day(-3), ratings: [], library: { id: 'jf-film-1', type: 'movie' } },
			{ type: 'movie', id: 2, title: 'Later film', dateLabel: 'Digital release', released: false, date: day(3), ratings: [] }
		],
		unavailable: []
	};
	const { selectorNode, navigations } = await mount(schedule);
	const calendar = selectorNode('#calendarDays');
	const groups = calendar.children;
	assert.deepEqual(groups.map(group => group.children[0].textContent), ['Recently released', 'Next 7 days']);
	const recentButton = findButton(groups[0].children[1], 'Library film');
	assert.ok(recentButton);
	recentButton.onclick();
	assert.deepEqual(navigations, ['/?item=jf-film-1'], 'a matched title opens the existing library item route');
	assert.equal(selectorNode('#comingDetails').open, false, 'the details panel is not used for a library title');

	const upcomingButton = findButton(groups[1].children[1], 'Later film');
	assert.ok(upcomingButton);
	upcomingButton.onclick();
	assert.equal(selectorNode('#comingDetails').open, true, 'an unmatched title keeps the details panel');
	assert.equal(navigations.length, 1);
});

test('the hero action follows the same library target and keeps details for unmatched titles', async () => {
	const library = { type: 'movie', id: 1, title: 'Library film', dateLabel: 'Released', released: true, date: day(-2), ratings: [], library: { id: 'jf-film-1', type: 'movie' } };
	const { selectorNode, navigations } = await mount({ tv: [], movies: [library], unavailable: [] });
	const action = selectorNode('#comingHeroAction');
	assert.equal(action.textContent, 'Open in library');
	action.onclick();
	assert.deepEqual(navigations, ['/?item=jf-film-1']);
});

test('the calendar marks exactly one day as Today when recent days are shown', async () => {
	const schedule = { tv: [], movies: [{ type: 'movie', id: 3, title: 'Recent film', dateLabel: 'Released', released: true, date: day(-3), ratings: [] }], unavailable: [] };
	const { selectorNode } = await mount(schedule);
	const calendar = selectorNode('#calendarDays');
	assert.equal(calendar.children[0].children[0].textContent, 'Recently released');
	const labels = [];
	walk(calendar, node => { if (node.tag === 'strong' && node.textContent === 'Today') labels.push(node); });
	assert.equal(labels.length, 1, 'today is not mistaken for the first rendered day');
});
