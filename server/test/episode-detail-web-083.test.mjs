import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

test('an episode detail shows its season and episode number', () => {
	assert.match(app, /item\.Type === 'Episode' \? episodeNumber\(item\) : ''/);
	assert.match(app, /kind \+ \(number \?/);
});

test('an episode detail offers Go to show for the parent series', () => {
	assert.match(app, /'Go to show'/);
	assert.match(app, /showDetails\(item\.SeriesId\)/);
});
