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
	const states = {}, resets = {};
	const node = map => key => map[key] || (map[key] = { textContent: '', hidden: true, onclick: null });
	const state = node(states), reset = node(resets);
	const context = vm.createContext({
		localStorage: {
			getItem: key => storage.has(key) ? storage.get(key) : null,
			setItem: (key, value) => storage.set(key, value),
			removeItem: key => storage.delete(key)
		},
		document: {
			querySelector: selector => {
				if (selector === '#englishSubtitles') return english;
				if (selector === '#autoNext') return autoplay;
				if (selector === '#skipIntros') return skipIntros;
				const stateKey = /^\[data-preference-state="(.+)"\]$/.exec(selector);
				if (stateKey) return state(stateKey[1]);
				const resetKey = /^\[data-preference-reset="(.+)"\]$/.exec(selector);
				if (resetKey) return reset(resetKey[1]);
				return null;
			}
		}
	});
	vm.runInContext(preferencesSource, context);
	return { context, english, autoplay, skipIntros, states, resets };
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

test('viewer preferences inherit server defaults until a local choice is saved or reset', () => {
	const storage = new Map();
	const first = preferenceContext(storage);
	first.context.TellyboxViewerPreferences.apply({ englishSubtitles: true, autoNext: true, skipIntros: false });
	assert.equal(first.english.checked, true, 'missing override inherits a true server default');
	assert.equal(first.autoplay.checked, true, 'missing override inherits autoplay');
	assert.equal(first.skipIntros.checked, false, 'missing override inherits a false server default');
	storage.set('tellybox-english', 'false');
	first.context.TellyboxViewerPreferences.render();
	assert.equal(first.english.checked, false, 'an explicit false choice overrides a true server default');
	assert.equal(first.states.englishSubtitles.textContent, 'Saved for this browser.');
	assert.equal(first.resets.englishSubtitles.hidden, false);
	first.resets.englishSubtitles.onclick();
	assert.equal(first.english.checked, true, 'the reset control resumes inheritance');
	assert.equal(storage.has('tellybox-english'), false, 'reset does not seed a local value');
	assert.equal(first.states.englishSubtitles.textContent, 'Using the server default (on).');
	storage.set('tellybox-english', 'not-a-choice');
	first.context.TellyboxViewerPreferences.render();
	assert.equal(first.english.checked, true, 'an invalid local value is not treated as an override');
	first.context.TellyboxViewerPreferences.apply(undefined);
	assert.equal(first.autoplay.checked, false, 'missing server defaults fail safely to off');
});

test('the player resolves all three saved choices through the server defaults helper', () => {
	const start = appSource.indexOf('// PLAYBACK_DEFAULTS_START');
	const end = appSource.indexOf('// PLAYBACK_DEFAULTS_END', start);
	const skipStart = appSource.indexOf('function skipIntrosEnabled()');
	const skipEnd = appSource.indexOf("window.addEventListener('storage'", skipStart);
	assert.ok(start >= 0 && end > start, 'missing playback defaults helper');
	assert.ok(skipStart >= 0 && skipEnd > skipStart, 'missing skipIntrosEnabled helper');
	const storage = new Map();
	const context = vm.createContext({
		localStorage: {
			getItem: key => storage.has(key) ? storage.get(key) : null,
			setItem: (key, value) => storage.set(key, value)
		}
	});
	vm.runInContext(appSource.slice(start, end) + '\n' + appSource.slice(skipStart, skipEnd), context);
	assert.equal(context.skipIntrosEnabled(), false);
	vm.runInContext('serverPlaybackDefaults.skipIntros = true', context);
	assert.equal(context.skipIntrosEnabled(), true, 'a missing override inherits the server default');
	storage.set('tellybox-skip-intros', 'false');
	assert.equal(context.skipIntrosEnabled(), false, 'an explicit false choice overrides the server default');
	storage.delete('tellybox-skip-intros');
	assert.equal(context.skipIntrosEnabled(), true, 'resetting resumes inheritance');
	vm.runInContext('serverPlaybackDefaults.skipIntros = "yes"', context);
	assert.equal(context.skipIntrosEnabled(), false, 'an invalid server value fails safely to off');
	assert.equal(appSource.includes("querySelector('#skipIntros')"), false);
	assert.ok(appSource.includes("normalisePlaybackDefaults(capabilities.playbackDefaults)"));
	assert.ok(appSource.includes("playbackPreference('tellybox-english', 'englishSubtitles')"));
});

test('the dedicated preferences page has only viewer controls and no admin scripts', () => {
	for (const id of ['englishSubtitles', 'autoNext', 'skipIntros']) assert.ok(preferencesHtml.includes(`id="${id}"`), id);
	assert.ok(preferencesHtml.includes('/viewer-preferences.js'));
	assert.ok(preferencesHtml.includes('Watching settings'));
	assert.ok(preferencesHtml.includes('data-preference-reset="englishSubtitles"'), 'viewer reset control is present');
	assert.ok(preferencesHtml.includes('Use server defaults'));
	for (const admin of ['settings.js', 'installation-settings.js', 'dispatcharr-settings.js', 'people.js', 'apps.js', 'admin-downloads.js', 'server-health.js', 'auth.js', 'playback-defaults-settings.js']) {
		assert.equal(preferencesHtml.includes(admin), false, 'preferences page must not load ' + admin);
	}
	assert.equal(indexHtml.includes('id="skipIntros"'), false, 'the player must not contain the intro toggle');
	assert.ok(settingsHtml.includes('id="skipIntros"'), 'local Settings > Watching keeps the control');
	assert.ok(settingsHtml.includes('id="englishSubtitles"'), 'local Settings > Watching keeps English subtitles');
	assert.ok(settingsHtml.includes('id="autoNext"'), 'local Settings > Watching keeps autoplay');
	for (const id of ['serverDefaultEnglish', 'serverDefaultAutoNext', 'serverDefaultSkipIntros']) assert.ok(settingsHtml.includes(`id="${id}"`), id);
	assert.ok(settingsHtml.includes('/playback-defaults-settings.js'), 'admin-only defaults control uses its own script');
	for (const page of [indexHtml, discoverHtml, searchHtml]) {
		assert.ok(page.includes('/navigation.js'), 'shared topbar navigation is loaded');
		assert.ok(page.includes('account-actions'), 'the viewer link has a topbar account slot');
	}
	assert.ok(appSource.includes("state.playing?.Type==='Episode' && !state.live"), 'intro skipping still excludes live and 24/7');
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
