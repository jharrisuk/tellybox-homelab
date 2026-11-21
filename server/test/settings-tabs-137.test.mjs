/* Release 137: Settings section tabs must expose one selected tab, show its
 * matching panel, keep keyboard focus on the active tab and scroll a clipped
 * mobile tab into view. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../public/settings.html', import.meta.url), 'utf8');
const script = readFileSync(new URL('../public/settings.js', import.meta.url), 'utf8');
const names = ['overview', 'people', 'watching', 'server'];

class Element {
	constructor(tag = 'div') {
		this.tag = tag;
		this.dataset = {};
		this.hidden = false;
		this.tabIndex = 0;
		this.textContent = '';
		this.classes = new Set();
		this.attributes = {};
		this.listeners = {};
		this.document = null;
		this.scrollCalls = [];
		this.classList = {
			toggle: (name, force) => {
				const active = force === undefined ? !this.classes.has(name) : Boolean(force);
				if (active) this.classes.add(name); else this.classes.delete(name);
				return active;
			},
			contains: name => this.classes.has(name)
		};
	}
	setAttribute(name, value) { this.attributes[name] = String(value); }
	getAttribute(name) { return Object.hasOwn(this.attributes, name) ? this.attributes[name] : null; }
	addEventListener(name, handler) { (this.listeners[name] ||= []).push(handler); }
	focus() { if (this.document) this.document.activeElement = this; }
	scrollIntoView(options) { this.scrollCalls.push(options); }
}

function browser() {
	const tabs = names.map(name => {
		const tab = new Element('button');
		tab.dataset.panel = name;
		tab.textContent = name;
		return tab;
	});
	const panels = names.map(name => {
		const panel = new Element('section');
		panel.dataset.settings = name;
		return panel;
	});
	const opener = new Element('button');
	opener.dataset.openPanel = 'server';
	const document = {
		activeElement: null,
		querySelectorAll(selector) {
			if (selector === '[data-panel]') return tabs;
			if (selector === '[data-settings]') return panels;
			if (selector === '[data-open-panel]') return [opener];
			return [];
		}
	};
	for (const element of [...tabs, ...panels, opener]) element.document = document;
	return { document, tabs, panels, opener };
}

function run() {
	const view = browser();
	vm.runInNewContext(script, { document: view.document });
	return view;
}

function selected(view) {
	return view.tabs.filter(tab => tab.getAttribute('aria-selected') === 'true');
}

function visible(view) {
	return view.panels.filter(panel => !panel.hidden);
}

test('settings markup exposes a real tablist, tabs, panels and one initial selection', () => {
	assert.match(html, /<nav class="settings-tabs" role="tablist" aria-label="Settings sections">/);
	for (const name of names) {
		const title = name[0].toUpperCase() + name.slice(1);
		const id = 'settingsTab' + title;
		const panel = 'settingsPanel' + title;
		assert.match(html, new RegExp('id="' + id + '"[^>]*role="tab"[^>]*data-panel="' + name + '"[^>]*aria-selected="(?:true|false)"[^>]*aria-controls="' + panel + '"[^>]*tabindex="(?:0|-1)"'));
		assert.match(html, new RegExp('id="' + panel + '"[^>]*data-settings="' + name + '"[^>]*role="tabpanel"[^>]*aria-labelledby="' + id + '"'));
	}
	assert.match(html, /id="settingsTabOverview"[^>]*aria-selected="true"[^>]*tabindex="0"/);
	const tabsBlock = html.match(/<nav class="settings-tabs"[\s\S]*?<\/nav>/)?.[0] || '';
	assert.equal((tabsBlock.match(/aria-selected="true"/g) || []).length, 1, 'exactly one tab starts selected');
	assert.doesNotMatch(tabsBlock, /aria-pressed/, 'settings tabs use aria-selected, not aria-pressed');
});

test('clicking a tab selects it, shows only its panel and scrolls it into view', () => {
	const view = run();
	assert.deepEqual(selected(view).map(tab => tab.dataset.panel), ['overview']);
	assert.deepEqual(visible(view).map(panel => panel.dataset.settings), ['overview']);
	assert.equal(view.tabs[0].getAttribute('tabindex'), '0');
	assert.equal(view.tabs[1].getAttribute('tabindex'), '-1');

	const watching = view.tabs.find(tab => tab.dataset.panel === 'watching');
	watching.onclick();
	assert.deepEqual(selected(view).map(tab => tab.dataset.panel), ['watching']);
	assert.deepEqual(visible(view).map(panel => panel.dataset.settings), ['watching']);
	assert.equal(watching.classList.contains('active'), true);
	assert.equal(watching.getAttribute('tabindex'), '0');
	assert.equal(view.tabs[0].classList.contains('active'), false);
	assert.equal(view.tabs[0].getAttribute('tabindex'), '-1');
	const scroll = watching.scrollCalls.at(-1);
	assert.equal(scroll?.block, 'nearest');
	assert.equal(scroll?.inline, 'nearest');
});

test('arrow, Home and End keys move selection with focus and keep the panel in sync', () => {
	const view = run();
	view.tabs[0].focus();
	const keydown = view.tabs[0].listeners.keydown?.[0];
	assert.ok(keydown, 'settings tabs install a keyboard handler');

	keydown({ key: 'ArrowRight', preventDefault() {} });
	assert.deepEqual(selected(view).map(tab => tab.dataset.panel), ['people']);
	assert.equal(view.document.activeElement, view.tabs[1]);
	assert.deepEqual(visible(view).map(panel => panel.dataset.settings), ['people']);

	keydown({ key: 'End', preventDefault() {} });
	assert.deepEqual(selected(view).map(tab => tab.dataset.panel), ['server']);
	assert.equal(view.document.activeElement, view.tabs[3]);
	assert.deepEqual(visible(view).map(panel => panel.dataset.settings), ['server']);

	keydown({ key: 'Home', preventDefault() {} });
	assert.deepEqual(selected(view).map(tab => tab.dataset.panel), ['overview']);
	assert.equal(view.document.activeElement, view.tabs[0]);

	keydown({ key: 'ArrowLeft', preventDefault() {} });
	assert.deepEqual(selected(view).map(tab => tab.dataset.panel), ['server'], 'ArrowLeft wraps to the last tab');
	assert.equal(view.document.activeElement, view.tabs[3]);
});

test('the overview shortcut opens the server panel with focus', () => {
	const view = run();
	view.opener.onclick();
	assert.deepEqual(selected(view).map(tab => tab.dataset.panel), ['server']);
	assert.equal(view.document.activeElement, view.tabs[3]);
	assert.deepEqual(visible(view).map(panel => panel.dataset.settings), ['server']);
	assert.equal(selected(view).length, 1);
	assert.equal(visible(view).length, 1);
});
