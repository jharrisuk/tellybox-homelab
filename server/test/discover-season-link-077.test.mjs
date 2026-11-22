import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const discover = readFileSync(new URL('../public/discover.js', import.meta.url), 'utf8');

test('an available Discover season links straight to that season', () => {
	assert.match(discover, /&season=' \+ season\.number/);
	assert.match(app, /let pendingSeason = null;/);
	assert.match(app, /requestedSeason/);
	assert.match(app, /choose\(requested \?\?/);
});

test('a non-series detail view clears any pending season', () => {
	assert.match(app, /if \(item\.Type !== 'Series'\) pendingSeason = null;/);
});
