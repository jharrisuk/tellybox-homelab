import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const index = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const share = readFileSync(new URL('../public/share-player.html', import.meta.url), 'utf8');
const shareJs = readFileSync(new URL('../public/share-player.js', import.meta.url), 'utf8');
const shareCss = readFileSync(new URL('../public/share-player.css', import.meta.url), 'utf8');
const css = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
const settings = readFileSync(new URL('../public/settings.html', import.meta.url), 'utf8');
const pausedSettings = readFileSync(new URL('../public/paused-timeout-settings.js', import.meta.url), 'utf8');

test('web player loader is branded, announced and present in the video stage', () => {
	assert.match(index, /id="playerLoading" class="brand-loading player-loading" role="status" aria-label="Loading video"/);
	assert.match(index, /tellybox-mark\.svg/);
	assert.match(css, /@media\(prefers-reduced-motion:reduce\)\{\.brand-loading img\{animation:none\}\}/);
	assert.match(css, /\.player-loading\{position:absolute;inset:0/);
});

test('web player loader tracks buffering and seeking but not a normal pause', () => {
	assert.match(app, /video\.addEventListener\('waiting'.*playerLoading\(true\)/);
	assert.match(app, /video\.addEventListener\('stalled'.*playerLoading\(true\)/);
	assert.match(app, /video\.addEventListener\('seeking'.*playerLoading\(true\)/);
	assert.match(app, /video\.addEventListener\('seeked'.*playerLoading\(false\)/);
	assert.match(app, /video\.addEventListener\('pause',\(\)=>\{if\(!video\.seeking\)playerLoading\(false\);\}\)/);
	assert.doesNotMatch(app, /for\(const event of \['playing','canplay','pause'/);
});

test('heartbeat reports seeking and clients leave cleanly on PAUSED_TIMEOUT', () => {
	assert.match(app, /seeking: !casting\.active && video\.seeking/);
	assert.match(app, /error\.code === 'PAUSED_TIMEOUT'/);
	assert.match(app, /function showPlaybackClosed/);
	assert.match(app, /showPlaybackClosed\(error\.message/);
	assert.match(app, /#viewingBlockedBack'\)\.onclick = closePlayer/);
	assert.match(app, /showViewingBlocked\(data\?\.message \|\| error\.message/);
});

test('shared-link player has the same branded ident and motion opt-out', () => {
	assert.match(share, /id="shareLoading" class="brand-loading share-loading" role="status" aria-label="Loading video"/);
	assert.match(share, /tellybox-mark\.svg/);
	assert.match(shareCss, /@media\(prefers-reduced-motion: reduce\) \{ \.share-loading img \{ animation:none; \} \}/);
	assert.match(shareJs, /video\.addEventListener\('waiting'.*showLoading\(true\)/);
	assert.match(shareJs, /video\.addEventListener\('seeking'.*showLoading\(true\)/);
	assert.match(shareJs, /error\.code === 'PAUSED_TIMEOUT'/);
});

test('admin settings expose the validated paused-stream timeout control', () => {
	assert.match(settings, /id="serverPausedTimeout"/);
	assert.match(settings, /id="savePausedTimeout"/);
	assert.match(settings, /paused-timeout-settings\.js/);
	assert.match(pausedSettings, /\/api\/auth\/paused-timeout/);
	assert.match(pausedSettings, /minutes < 0 \|\| minutes > 1440/);
});
