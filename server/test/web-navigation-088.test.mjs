import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = name => readFileSync(new URL('../public/' + name, import.meta.url), 'utf8');
const pages = ['index.html', 'discover.html', 'coming-soon.html', 'search.html', 'settings.html', 'activity.html', 'preferences.html'];
const navigation = read('navigation.js');
const style = read('style.css');
const app = read('app.js');
const discover = read('discover.js');
const settings = read('settings.html');
const canonical = ['/', '/discover', '/coming-soon', '/?view=movies', '/?view=tvshows', '/?view=livetv', '/?view=nonstop', '/?view=recordings', '/search'];

test('every primary page has one canonical single-line navigation and a menu toggle', () => {
	for (const name of pages) {
		const html = read(name);
		assert.match(html, /<header class="topbar">/, name + ' has the shared topbar');
		assert.match(html, /id="menuToggle"[^>]*aria-controls="siteNavigation"[^>]*aria-expanded="false"/, name + ' has an accessible menu toggle');
		assert.match(html, /id="siteNavigation"/, name + ' has the navigation panel');
		for (const href of canonical) assert.ok(html.includes(`href="${href}"`), name + ' links ' + href);
		assert.match(html, /class="nav-item nav-coming(?: active)?"/, name + ' marks Coming soon compact');
		assert.doesNotMatch(html, /id="activityLink"/, name + ' no longer has a topbar Activity link');
		assert.doesNotMatch(html, /data-watching-settings/, name + ' no longer has topbar Watching settings');
		assert.match(html, /id="remoteSettings"/, name + ' keeps one Settings destination');
		assert.match(html, /\/navigation\.js/, name + ' loads the shared navigation');
	}
});

test('Coming soon is the only compact primary item and primary navigation never wraps', () => {
	assert.match(style, /nav \{[^}]*flex-wrap:\s*nowrap/s);
	assert.match(style, /\.nav-item\s*\{[^}]*white-space:\s*nowrap/s);
	assert.match(style, /\.nav-item\.nav-coming\s*\{[^}]*font-size:\s*12px/s);
	assert.match(style, /\.nav-item\.nav-coming\s*\{[^}]*border-radius:\s*999px/s);
	assert.match(style, /@media \(max-width: 1100px\)[\s\S]*?\.navigation-panel \{[^}]*position:\s*absolute/s);
	assert.doesNotMatch(style, /nav \{[^}]*flex-wrap:\s*wrap/s);
});

test('Activity and Watching settings live in Settings, with a viewer-safe remote destination', () => {
	assert.match(settings, /href="\/activity"/, 'Settings links to viewing activity');
	assert.match(settings, /data-open-panel="watching"[^>]*>Playback, subtitles/, 'Settings opens the in-page Watching panel');
	assert.match(navigation, /const canonical = \[/, 'navigation is normalised once');
	assert.doesNotMatch(navigation, /Watching settings/, 'the topbar no longer injects Watching settings');
	assert.doesNotMatch(navigation, /activityLink/, 'the topbar no longer injects Activity');
	assert.match(navigation, /fetch\('\/api\/auth\/status'/, 'Settings visibility follows the caller');
	assert.match(navigation, /access\.authenticated/, 'signed-in viewers keep a Settings destination');
	assert.match(navigation, /\/preferences\.html/, 'remote viewers reach viewer preferences');
	assert.match(navigation, /access\.local \? '\/settings'/, 'local viewers reach the full Settings page');
});

test('dynamic library buttons no longer grow the primary navigation', () => {
	assert.doesNotMatch(app, /\$\('#nav'\)\.append\(button\)/, 'server libraries are not appended to the primary nav');
	assert.doesNotMatch(app, /activityLink/, 'home no longer manages an Activity topbar link');
	assert.doesNotMatch(discover, /activityLink/, 'discover no longer manages an Activity topbar link');
});

test('settings and activity pages keep the shared topbar without admin links', () => {
	for (const name of ['settings.html', 'activity.html', 'preferences.html']) {
		const html = read(name);
		assert.match(html, /<header class="topbar">/, name + ' uses the shared topbar');
		assert.doesNotMatch(html, /settings-tabs[^>]*>[^]*?href="\/people"/, name + ' does not invent an admin-only topbar path');
	}
	assert.match(read('activity.html'), /class="activity-page"/, 'Activity is not centred behind the topbar');
});
