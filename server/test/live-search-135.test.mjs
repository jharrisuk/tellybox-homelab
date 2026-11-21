import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

test('Live TV has no dedicated text search control', () => {
	assert.doesNotMatch(app, /Find a channel or programme/);
	assert.doesNotMatch(app, /Search channels and programmes/);
	assert.match(app, /const searchControl = \$\('#search'\)\.closest\('label'\)/);
	assert.match(app, /searchControl\.hidden = live/);
	// The guide no longer filters channels or programmes by a search term.
	assert.doesNotMatch(app, /channel\.Name \+ ' ' \+ channel\.ChannelNumber/);
	assert.match(app, /No channels in this category\. Try All channels\./);
});

test('Live TV keeps categories, favourites and the EPG, and global search remains elsewhere', () => {
	assert.match(app, /channelGroups\(\[\.\.\.new Set\(guideData\.channels\.map\(c=>c\.Group\)/);
	assert.match(app, /onlyFavourites/);
	assert.match(app, /\/api\/web\/live-guide/);
	// Global Search still leaves the page on Enter for every other view.
	assert.match(app, /location\.assign\('\/search\?'/);
});
