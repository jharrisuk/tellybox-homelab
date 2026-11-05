import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const style = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');
const shareStyle = readFileSync(new URL('../public/share-player.css', import.meta.url), 'utf8');
const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const shareApp = readFileSync(new URL('../public/share-player.js', import.meta.url), 'utf8');

function rule(source, selector) {
	const start = source.indexOf(selector);
	assert.ok(start >= 0, `missing rule for ${selector}`);
	const end = source.indexOf('}', start);
	assert.ok(end > start, `unterminated rule for ${selector}`);
	return source.slice(start, end + 1);
}

test('main player fullscreen fills the viewport and contains the picture', () => {
	const stage = rule(style, '.video-stage:fullscreen,');
	assert.match(stage, /width:\s*100%/);
	assert.match(stage, /height:\s*100dvh/);
	assert.match(stage, /max-height:\s*none/);
	assert.match(stage, /display:\s*flex/);
	const video = rule(style, '.video-stage:fullscreen video,');
	assert.match(video, /height:\s*100%/);
	assert.match(video, /max-height:\s*100%/);
	assert.match(video, /object-fit:\s*contain/);
	assert.match(video, /object-position:\s*center/);
	assert.match(style, /\.video-stage:-webkit-full-screen video/);
});

test('main fullscreen controls respect safe areas', () => {
	const controls = rule(style, '.video-stage:fullscreen .live-controls,');
	assert.match(controls, /env\(safe-area-inset-bottom/);
	assert.match(controls, /env\(safe-area-inset-left/);
	assert.match(controls, /env\(safe-area-inset-right/);
});

test('shared player fullscreen has the same viewport contract', () => {
	const stage = rule(shareStyle, '.screen:fullscreen,');
	assert.match(stage, /width:\s*100%/);
	assert.match(stage, /height:\s*100dvh/);
	assert.match(stage, /max-height:\s*none/);
	assert.match(stage, /border-radius:\s*0/);
	const video = rule(shareStyle, '.screen:fullscreen video,');
	assert.match(video, /height:\s*100%/);
	assert.match(video, /max-height:\s*100%/);
	assert.match(video, /object-fit:\s*contain/);
	assert.match(shareStyle, /\.screen:-webkit-full-screen video/);
});

test('fullscreen buttons use prefixed APIs and iOS native fallback', () => {
	for (const source of [app, shareApp]) {
		assert.match(source, /webkitRequestFullscreen/);
		assert.match(source, /webkitEnterFullscreen/);
		assert.match(source, /webkitFullscreenElement/);
		assert.match(source, /webkitExitFullscreen/);
		assert.match(source, /addEventListener\('webkitfullscreenchange'/);
		assert.match(source, /fullscreenElement\(\)/);
		assert.doesNotMatch(source, /document\.fullscreenElement \? 'Exit fullscreen'/);
	}
});
