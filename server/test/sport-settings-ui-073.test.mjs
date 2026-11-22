import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../public/settings.html', import.meta.url), 'utf8');
const script = readFileSync(new URL('../public/sport-settings.js', import.meta.url), 'utf8');

test('the local administrator can choose sports from the Server settings tab', () => {
	assert.match(html, /id="sportSettings"/);
	assert.match(html, /id="sportListingsEnabled"/);
	assert.match(html, /id="sportFootballScope"/);
	assert.match(html, /id="sportChoices"/);
	assert.match(html, /id="saveSportSettings"/);
	assert.match(html, /src="\/sport-settings\.js(?:\?[^"]*)?"/);
});

test('the sport panel edits the existing settings API and shows current fixture counts', () => {
	assert.match(script, /\/api\/sport-settings/);
	assert.match(script, /knownSports/);
	assert.match(script, /enabled:/);
	assert.match(script, /football:/);
	assert.match(script, /\/api\/coming-soon/);
});
