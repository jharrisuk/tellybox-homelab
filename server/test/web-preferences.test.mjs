import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const preferencesSource = readFileSync(new URL('../public/viewer-preferences.js', import.meta.url), 'utf8');
const appSource = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const navigationSource = readFileSync(new URL('../public/navigation.js', import.meta.url), 'utf8');
const indexHtml = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const discoverHtml = readFileSync(new URL('../public/discover.html', import.meta.url), 'utf8');
const searchHtml = readFileSync(new URL('../public/search.html', import.meta.url), 'utf8');
const settingsHtml = readFileSync(new URL('../public/settings.html', import.meta.url), 'utf8');
const preferencesHtml = readFileSync(new URL('../public/preferences.html', import.meta.url), 'utf8');

function checkbox() {
	return { checked: false, onchange: null };
}

function preferenceContext(storage) {
	const english = checkbox(), autoplay = checkbox(), skipIntros = checkbox();
	const context = vm.createContext({
		localStorage: {
			getItem: key => storage.has(key) ? storage.get(key) : null,
			setItem: (key, value) => storage.set(key, value)
		},
		document: {
			querySelector: selector => selector === '#englishSubtitles' ? english : selector === '#autoNext' ? autoplay : selector === '#skipIntros' ? skipIntros : null
		}
	});
	vm.runInContext(preferencesSource, context);
	return { context, english, autoplay, skipIntros };
}

test('shared viewer preferences persist all three keys and restore on refresh', () => {
	const storage = new Map();
	const first = preferenceContext(storage);
	assert.equal(first.english.checked, false);
	assert.equal(first.autoplay.checked, false);
	assert.equal(first.skipIntros.checked, false);
	first.english.checked = true; first.english.onchange();
	first.autoplay.checked = true; first.autoplay.onchange();
	first.skipIntros.checked = true; first.skipIntros.onchange();
	assert.equal(storage.get('tellybox-english'), 'true');
	assert.equal(storage.get('tellybox-autoplay'), 'true');
	assert.equal(storage.get('tellybox-skip-intros'), 'true');
	const refreshed = preferenceContext(storage);
	assert.equal(refreshed.english.checked, true, 'a refresh restores English subtitles');
	assert.equal(refreshed.autoplay.checked, true, 'a refresh restores autoplay');
	assert.equal(refreshed.skipIntros.checked, true, 'a refresh restores intro skipping');
});

test('the player reads the stored intro preference without a player checkbox', () => {
	const start = appSource.indexOf('function skipIntrosEnabled()');
	const end = appSource.indexOf("window.addEventListener('storage'", start);
	assert.ok(start >= 0 && end > start, 'missing skipIntrosEnabled helper');
	const storage = new Map();
	const context = vm.createContext({
		localStorage: {
			getItem: key => storage.has(key) ? storage.get(key) : null
		}
	});
	vm.runInContext(appSource.slice(start, end), context);
	assert.equal(context.skipIntrosEnabled(), false);
	storage.set('tellybox-skip-intros', 'true');
	assert.equal(context.skipIntrosEnabled(), true);
	assert.equal(appSource.includes("querySelector('#skipIntros')"), false);
});

test('the dedicated preferences page has only viewer controls and no admin scripts', () => {
	for (const id of ['englishSubtitles', 'autoNext', 'skipIntros']) assert.ok(preferencesHtml.includes(`id="${id}"`), id);
	assert.ok(preferencesHtml.includes('/viewer-preferences.js'));
	assert.ok(preferencesHtml.includes('Watching settings'));
	for (const admin of ['settings.js', 'installation-settings.js', 'dispatcharr-settings.js', 'people.js', 'apps.js', 'admin-downloads.js', 'server-health.js', 'auth.js']) {
		assert.equal(preferencesHtml.includes(admin), false, 'preferences page must not load ' + admin);
	}
	assert.equal(indexHtml.includes('id="skipIntros"'), false, 'the player must not contain the intro toggle');
	assert.ok(settingsHtml.includes('id="skipIntros"'), 'local Settings > Watching keeps the control');
	assert.ok(settingsHtml.includes('id="englishSubtitles"'), 'local Settings > Watching keeps English subtitles');
	for (const page of [indexHtml, discoverHtml, searchHtml]) {
		assert.ok(page.includes('/navigation.js'), 'shared topbar navigation is loaded');
		assert.ok(page.includes('account-actions'), 'the viewer link has a topbar account slot');
	}
});

function fakeNode(properties = {}) {
	const node = {
		id: '', href: '', textContent: '', className: '', hidden: false, children: [], attributes: {},
		classList: { add() {}, remove() {}, toggle() {} },
		setAttribute(name, value) { this.attributes[name] = String(value); },
		getAttribute(name) { return this.attributes[name] ?? null; },
		addEventListener() {},
		append(...items) { this.children.push(...items); },
		insertBefore(item, before) {
			const index = this.children.indexOf(before);
			if (index < 0) this.children.push(item); else this.children.splice(index, 0, item);
		},
		contains() { return false; },
		...properties
	};
	return node;
}

test('the shared topbar adds Watching settings for every viewer without duplicating it', () => {
	const signOut = fakeNode({ id: 'signOut' });
	const account = fakeNode({
		children: [fakeNode({ id: 'activityLink' }), fakeNode({ id: 'remoteSettings' }), signOut],
		querySelector(selector) {
			if (selector === '#signOut') return this.children.find(node => node.id === 'signOut') || null;
			if (selector === '[data-watching-settings]') return this.children.find(node => 'data-watching-settings' in node.attributes) || null;
			return null;
		}
	});
	const nav = fakeNode({
		querySelector(selector) { return selector === '[href="/search"]' ? this.children.find(node => node.href === '/search') || null : null; }
	});
	const header = fakeNode();
	const toggle = fakeNode();
	const panel = fakeNode({
		querySelector(selector) { return selector === 'nav' ? nav : selector === '.account-actions' ? account : null; }
	});
	const document = {
		activeElement: null,
		querySelector: selector => selector === '.topbar' ? header : selector === '#menuToggle' ? toggle : selector === '#siteNavigation' ? panel : null,
		createElement: () => fakeNode(),
		createComment: () => fakeNode(),
		addEventListener() {}
	};
	const context = vm.createContext({
		document, location: { pathname: '/' }, matchMedia: () => ({ matches: false, addEventListener() {} })
	});
	vm.runInContext(navigationSource, context);
	vm.runInContext(navigationSource, context);
	const links = account.children.filter(node => 'data-watching-settings' in node.attributes);
	assert.equal(links.length, 1, 'the link must not be duplicated');
	assert.equal(links[0].href, '/preferences.html');
	assert.equal(links[0].textContent, 'Watching settings');
	assert.equal(account.children.at(-1).id, 'signOut');
	assert.ok(nav.children.some(node => node.href === '/search'));
});
