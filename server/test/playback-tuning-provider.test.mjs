import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

/* Provider playback must not expose local-only tuning controls. The policy is
 * a positive provider predicate so a local Jellyfin film/episode can never be
 * mistaken for a provider item by an absent property. */

const context = {};
vm.runInNewContext(readFileSync(new URL('../public/playback-tuning.js', import.meta.url), 'utf8'), context);
const tuning = context.TellyboxPlaybackTuning;
const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const index = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

const localMovie = { Id: '0f6e4a2c9b8d4f1e8a7c6b5d4e3f2a1b', Name: 'Local film', Type: 'Movie', Source: 'local' };
const localEpisode = { Id: '1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d', Name: 'Local episode', Type: 'Episode', Source: 'local', ProviderIds: { Tmdb: '123' } };

test('provider live and 24/7 items hide tuning', () => {
	assert.equal(tuning.isProviderPlayback({ Id: 'dispatch-live-12345678-1234-1234-1234-123456789abc', Type: 'TvChannel', Provider: 'Dispatcharr' }), true);
	assert.equal(tuning.isProviderPlayback({ Id: 'dispatch-live-12345678-1234-1234-1234-123456789abc', Type: 'TvChannel', Provider: 'Dispatcharr', Nonstop: true }), true);
	// The live transport flag from /api/play is authoritative even without a marker.
	assert.equal(tuning.isProviderPlayback({ Id: 'unknown', Type: 'Movie' }, true), true);
});

test('provider VOD, catch-up and provider recordings hide tuning', () => {
	assert.equal(tuning.isProviderPlayback({ Id: 'dispatch-movie-42', Type: 'Movie', Source: 'streamed', Provider: 'Provider One' }), true);
	assert.equal(tuning.isProviderPlayback({ Id: 'dispatch-episode-42-7', Type: 'Episode', Source: 'streamed', Provider: 'Provider One' }), true);
	assert.equal(tuning.isProviderPlayback({ Id: 'catchup-12345678-1234-1234-1234-123456789abc-1700000000000', Type: 'Catchup' }), true);
	assert.equal(tuning.isProviderPlayback({ Id: 'dispatch-recording-42', Type: 'Recording' }), true);
	assert.equal(tuning.isProviderPlayback({ Id: 'anything', Type: 'Movie', Provider: 'Dispatcharr' }), true);
});

test('local library films, episodes and recordings keep tuning', () => {
	assert.equal(tuning.isProviderPlayback(localMovie), false);
	assert.equal(tuning.isProviderPlayback(localEpisode), false);
	assert.equal(tuning.isProviderPlayback({ ...localMovie, Source: undefined }), false);
	assert.equal(tuning.isProviderPlayback({ Id: 'local-recording-42', Type: 'Recording', Source: 'local' }), false);
});

test('live TV is hidden even when it comes from the local library', () => {
	assert.equal(tuning.isProviderPlayback({ Id: '0f6e4a2c9b8d4f1e8a7c6b5d4e3f2a1b', Type: 'TvChannel', Source: 'local' }), true);
});

test('visibility toggles the same nodes back on a local item', () => {
	const tuningBlock = { hidden: false };
	const autoNext = { hidden: false };
	const english = { hidden: false };
	const note = { hidden: false };
	const nodes = [tuningBlock, autoNext, english, note, null];
	tuning.applyVisibility(nodes, true);
	assert.deepEqual(nodes.slice(0, 4).map(node => node.hidden), [true, true, true, true]);
	tuning.applyVisibility(nodes, false);
	assert.deepEqual(nodes.slice(0, 4).map(node => node.hidden), [false, false, false, false]);
});

test('the player applies the policy before the request and again from the live response', () => {
	assert.match(index, /class="player-note browser-preference-note"/);
	const tuningScript = index.indexOf('<script src="/playback-tuning.js"');
	const appScript = index.indexOf('<script src="/app.js');
	assert.ok(tuningScript > 0 && appScript > tuningScript, 'tuning policy loads before app.js');
	assert.match(app, /const playbackTuning = globalThis\.TellyboxPlaybackTuning \|\| null;/);
	assert.match(app, /updatePlaybackTuning\(item, false\);/);
	assert.match(app, /updatePlaybackTuning\(item, playback\.live === true\);/);
	assert.match(app, /\$\('\.player-settings'\)/);
	assert.match(app, /\$\('#autoNext'\)\?\.closest\('\.browser-preference'\)/);
	assert.match(app, /\$\('#defaultEnglish'\)\?\.closest\('\.browser-preference'\)/);
	assert.match(app, /\$\('\.browser-preference-note'\)/);
});

test('provider requests use normal defaults instead of hidden control values', () => {
	assert.match(app, /const providerDefaults = Boolean\(playbackTuning && playbackTuning\.isProviderPlayback\(item, false\)\);/);
	const providerBlock = app.slice(app.indexOf('if (providerDefaults) {'), app.indexOf('} else {', app.indexOf('if (providerDefaults) {')));
	assert.ok(providerBlock.length > 0);
	assert.match(providerBlock, /if \(!keepSettings\) state\.providerQuality = 0;/);
	assert.match(providerBlock, /payload\.quality = Number\(state\.providerQuality\) > 0 \? Number\(state\.providerQuality\) : playbackTuning\.PROVIDER_DEFAULT_QUALITY;/);
	assert.match(providerBlock, /payload\.subtitleIndex = -1;/);
	assert.match(providerBlock, /payload\.textSubtitles = false;/);
	assert.doesNotMatch(providerBlock, /audioIndex/);
	const localBlock = app.slice(app.indexOf('} else {', app.indexOf('if (providerDefaults) {')), app.indexOf('if (relayReplacement) payload.replaceSession'));
	assert.match(localBlock, /preferEnglishSubtitles = true/);
	assert.match(localBlock, /payload\.audioIndex = Number\(\$\('#audioTrack'\)\.value\);/);
	assert.equal(tuning.PROVIDER_DEFAULT_QUALITY, 20000000);
});
