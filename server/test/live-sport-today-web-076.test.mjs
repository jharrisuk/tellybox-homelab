import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

test('the Live TV page carries a today sport strip above the guide', () => {
	assert.match(html, /id="liveSportToday"/);
	assert.match(app, /loadSportToday/);
	assert.match(app, /\/api\/sport-today/);
	assert.match(app, /playSportChannel/);
});
