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

test('the sport strip is a collapsed section, not always-on furniture', () => {
	assert.match(html, /<details id="liveSportToday"[^>]*hidden/);
	assert.match(html, /<summary><span>Sport on TV<\/span>/);
	assert.match(app, /inSportsCategory\(\) && \$\('#liveSportList'\)/);
});

test('the sport strip only appears in a sports guide category', () => {
	assert.match(app, /function inSportsCategory\(\)/);
	assert.match(app, /\/sport\/i\.test\(channelGroup/);
	assert.match(app, /section\.hidden = !inSportsCategory\(\)/);
	assert.match(app, /updateSportVisibility\(\);/);
});
