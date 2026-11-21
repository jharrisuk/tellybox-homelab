import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const read = name => readFileSync(new URL('../public/' + name, import.meta.url), 'utf8');
const index = read('index.html');
const coming = read('coming-soon.html');
const comingJs = read('coming-soon.js');
const style = read('style.css');
const settings = read('settings.html');
const server = readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');

test('home has a focused Continue watching shelf and a separate Coming soon route', () => {
	assert.match(index, /id="homeFeed"/);
	assert.match(index, /id="homeRows"/);
	assert.match(index, /<h1 id="homeFeedTitle">Your Tellybox<\/h1>/);
	assert.match(index, /id="homeDiscovery"/);
	assert.doesNotMatch(index, /id="homeHero"/, 'the duplicate hero is removed from the focused home');
	assert.match(index, /id="collectionView"/);
	assert.match(index, /href="\/coming-soon"/);
	assert.doesNotMatch(index, /id="comingSoon"/, 'the old inline Coming soon section is gone');
	assert.match(server, /app\.get\('\/coming-soon'/);
	assert.match(server, /app\.post\('\/api\/web\/home'/);
});

test('Coming soon has navigable filters, calendar, deep links and Back handling', () => {
	assert.match(coming, /aria-current="page"[^>]*>Coming soon|>Coming soon<\/a>/);
	assert.match(coming, /id="calendarDays"/);
	assert.match(coming, /data-coming="tv"/);
	assert.match(coming, /id="comingDetails"/);
	assert.match(comingJs, /new URLSearchParams\(location\.search\)/);
	assert.match(comingJs, /query\.get\('title'\)/);
	assert.match(comingJs, /history\.pushState/);
	assert.match(comingJs, /addEventListener\('popstate'/);
	assert.match(comingJs, /openDetails\(item, false\)/);
	assert.match(comingJs, /history\.back\(\)/);
});

test('Pause timeout numeric input is explicit, labelled and responsive', () => {
	assert.match(settings, /class="preference-control"[^>]*><input id="serverPausedTimeout" type="number"/);
	assert.match(settings, /class="preference-unit">minutes/);
	assert.match(settings, /min="0" max="1440"/);
	assert.match(style, /\.preference-row input\[type=number\][^}]*width:\s*112px/s);
	assert.match(style, /\.preference-row input\[type=number\][^}]*min-width:\s*112px/s);
	assert.match(style, /\.preference-row input\[type=checkbox\], \.preference-row input\[type=radio\]/);
	assert.doesNotMatch(style, /\.preference-row input\s*\{[^}]*width:\s*24px/s, 'the old blanket preference-row input rule is gone');
	assert.match(style, /@media \(max-width: 650px\)[\s\S]*?\.preference-row input\[type=number\][\s\S]*?width:\s*100%/);
});
