import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

function functionBody(name) {
	const start = app.indexOf('function ' + name + '(');
	assert.notEqual(start, -1, name + ' exists');
	const end = app.indexOf('\nfunction ', start + 10);
	return app.slice(start, end === -1 ? app.length : end);
}

test('the player loads the shared monitor before app.js', () => {
	const still = html.indexOf('<script src="/still-watching.js"');
	const player = html.indexOf('<script src="/app.js"');
	assert.notEqual(still, -1, 'still-watching.js is loaded');
	assert.notEqual(player, -1, 'app.js is loaded');
	assert.ok(still < player, 'still-watching.js must load before app.js');
});

test('the prompt uses player classes and an accessible alertdialog with both actions', () => {
	assert.match(html, /id="stillWatching"[^>]*class="viewing-blocked"[^>]*role="alertdialog"/);
	assert.match(html, /aria-labelledby="stillWatchingTitle"/);
	assert.match(html, /aria-describedby="stillWatchingDetail"/);
	assert.match(html, /id="stillWatchingTitle"/);
	assert.match(html, /id="stillWatchingDetail"[\s\S]{0,160}id="stillWatchingSeconds"[^>]*>60</);
	assert.match(html, /class="button primary" id="stillWatchingKeep"/);
	assert.match(html, /class="button secondary" id="stillWatchingStop"/);
	assert.match(html, /id="stillWatchingKeep">Keep watching</);
	assert.match(html, /id="stillWatchingStop">Stop watching</);
});

test('a monitor is created per playback session with the live flag deciding resume', () => {
	const begin = functionBody('beginStillWatchingSession');
	assert.match(app, /let stillWatching = null/);
	assert.match(functionBody('createStillWatchingSession'), /TellyboxStillWatching\.create\(\{ resumeApplies: resumeApplies === true \}\)/);
	assert.match(begin, /stillWatching\.setResumeApplies\(resumeApplies\)/);
	assert.match(begin, /stillWatching\.transition\(playbackClock\(\)\)/);
	assert.match(app, /async function startPlayback\(item, position = 0, keepSettings = false, options = \{\}\)/);
	assert.match(app, /beginStillWatchingSession\(playback\.live !== true, options\.automatic === true\)/);
	assert.match(app, /startPlayback\(next, getProgress\(next\.Id\), true, \{ automatic: true \}\)/);
	assert.match(app, /stillWatching = null;/, 'the session monitor is cleared when the player tears down');
});

test('the update uses the monotonic clock and excludes unhealthy or invisible playback', () => {
	const update = functionBody('updateStillWatching');
	assert.match(app, /const playbackClock = \(\) => .*performance\.now/);
	assert.match(update, /stillWatching\.update\(playbackClock\(\), playing, buffering, video\.seeking, visible, canPrompt\)/);
	assert.match(update, /const visible = !document\.hidden && !pip/);
	assert.match(update, /const playing = !casting\.active && !video\.paused && !video\.ended && video\.readyState >= 3/);
	assert.match(update, /const buffering = !pip && !video\.paused && !video\.seeking && !video\.ended && video\.readyState < 3/);
	assert.match(update, /blockingModalOpen\(\)/);
	assert.match(update, /playbackWarning && playbackWarning\.isShown\(\)/);
	assert.match(update, /upNext && upNext\.hidden/);
});

test('only deliberate input resets the accumulator', () => {
	const update = functionBody('updateStillWatching');
	assert.doesNotMatch(update, /\.reset\(/);
	assert.doesNotMatch(update, /\.keepWatching\(/);
	assert.match(app, /setInterval\(updatePlaybackTrouble, 1000\)/);
	assert.match(functionBody('updatePlaybackTrouble'), /updateStillWatching\(\)/);
	assert.match(app, /for \(const type of \['keydown', 'pointerdown', 'touchstart', 'wheel', 'click'\]\) document\.addEventListener\(type, deliberatePlaybackInput, true\)/);
	assert.match(app, /document\.addEventListener\('change', deliberatePlaybackInput, true\)/);
	const deliberate = functionBody('deliberatePlaybackInput');
	assert.match(deliberate, /stillWatching\.reset\(playbackClock\(\)\)/);
	assert.doesNotMatch(functionBody('updatePlaybackTrouble'), /stillWatching\.reset/);
});

test('automatic next keeps the session; a manual retry starts a fresh one', () => {
	assert.match(app, /startPlayback\(next, getProgress\(next\.Id\), true, \{ automatic: true \}\)/);
	assert.match(app, /beginStillWatchingSession\(playback\.live !== true, options\.automatic === true\)/);
	// The transition path is the only automatic reuse. The ordinary call path
	// creates a new monitor, which is what a deliberate retry or quality change does.
	assert.match(functionBody('beginStillWatchingSession'), /if \(automatic && stillWatching\)[\s\S]{0,220}return stillWatching;\n\t\}\n\treturn createStillWatchingSession/);
});

test('keep, stop, timeout and Back/Escape all leave through the normal player path', () => {
	assert.match(app, /function keepWatchingFromPrompt\(\)[\s\S]{0,160}stillWatching\.keepWatching\(playbackClock\(\)\)/);
	assert.match(app, /function stopFromStillWatching\(\)[\s\S]{0,220}saveProgress\(\);[\s\S]{0,80}closePlayer\(\)/);
	assert.match(functionBody('updateStillWatching'), /if \(result\.stop\)[\s\S]{0,320}saveProgress\(\);[\s\S]{0,80}closePlayer\(\)/);
	assert.match(app, /onPopState[\s\S]{0,520}stillWatchingPromptOpen\(\)[\s\S]{0,260}history\.pushState[\s\S]{0,160}keepWatchingFromPrompt\(\)/);
	assert.match(app, /player\.addEventListener\('cancel'[\s\S]{0,260}stillWatchingPromptOpen\(\)[\s\S]{0,100}keepWatchingFromPrompt\(\)/);
	assert.match(functionBody('deliberatePlaybackInput'), /\['Escape', 'Backspace', 'GoBack', 'BrowserBack'\]/);
});
