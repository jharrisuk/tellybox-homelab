import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const setup = readFileSync(new URL('../homelab/public/setup.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../homelab/public/index.html', import.meta.url), 'utf8');
const web = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const share = readFileSync(new URL('../public/share-player.js', import.meta.url), 'utf8');
test('setup UI has exactly the three Dispatcharr choices and no address entry for local/relay', () => {
	assert.match(setup, /'On this server'[\s\S]*'On relay'[\s\S]*'Another server'/);
	assert.match(setup, /Advanced: nonstandard ports only/);
	assert.match(setup, /urlLabel\.hidden = select\.value !== 'anotherServer'/);
	assert.match(setup, /relayMediaInfo\.approved/);
	assert.match(html, /id="relayMediaPanel"/);
	assert.match(html, /id="relayMediaEnrol"/);
	assert.match(html, /id="relayMediaDeploy"/);
});
test('web and share clients advertise relay support and never drop the replacement position', () => {
	assert.match(web, /relayMedia: true, position/);
	assert.match(web, /payload\.replaceSession = state\.session/);
	assert.match(web, /state\.relayMedia = playback\.mediaRoute === 'relay'/);
	assert.match(share, /relayMedia: true, position/);
	assert.match(share, /new URL\(data\.url, location\.origin\)/);
});
