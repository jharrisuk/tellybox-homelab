import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import test from 'node:test';

const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../public/style.css', import.meta.url), 'utf8');

class Element {
	constructor(tag, className = '') {
		this.tag = tag;
		this.className = className;
		this.hidden = false;
		this.src = '';
		this.alt = '';
		this.listeners = new Map();
		this.removed = false;
	}
	addEventListener(name, fn) {
		const list = this.listeners.get(name) || [];
		list.push(fn);
		this.listeners.set(name, list);
	}
	emit(name) {
		for (const fn of this.listeners.get(name) || []) fn();
	}
	remove() { this.removed = true; }
}

const start = app.indexOf('function channelLogo');
const end = app.indexOf('function minutes');
assert.ok(start >= 0 && end > start, 'channelLogo helper is missing');
const sandbox = { element: (tag, className) => new Element(tag, className) };
vm.createContext(sandbox);
vm.runInContext(app.slice(start, end) + '\nthis.channelLogo = channelLogo;', sandbox);

test('a channel logo stays hidden until it loads and falls back on failure', () => {
	assert.equal(sandbox.channelLogo(null), null);
	assert.equal(sandbox.channelLogo({}), null);
	let ready = 0, failed = 0;
	const image = sandbox.channelLogo({ Artwork: '/api/dispatcharr/channels/one/image?v=221' }, 'guide-logo', () => ready++, () => failed++);
	assert.ok(image instanceof Element);
	assert.equal(image.hidden, true);
	assert.equal(image.alt, '');
	assert.equal(image.src, '/api/dispatcharr/channels/one/image?v=221');
	image.emit('load');
	assert.equal(image.hidden, false);
	assert.equal(ready, 1);
	assert.equal(failed, 0);

	let readyAfterError = 0, failedAfterError = 0;
	const broken = sandbox.channelLogo({ Artwork: '/api/dispatcharr/channels/two/image?v=224' }, 'guide-logo', () => readyAfterError++, () => failedAfterError++);
	broken.emit('error');
	assert.equal(broken.removed, true);
	assert.equal(failedAfterError, 1);
	assert.equal(readyAfterError, 0);
});

test('web channel rows reserve a logo-only state and keep the text fallback in the DOM', () => {
	assert.match(css, /\.guide-logo\s*\{[^}]*object-fit:\s*contain/s);
	assert.match(css, /\.timetable-channel\.logo-only\s+\.guide-channel-name\s*\{\s*display:\s*none/);
	assert.match(css, /\.guide-detail-channel\.logo-only\s*>\s*div\s*\{\s*display:\s*none/);
	assert.match(css, /#previousChannel\.logo-only\s+\.previous-label\s*\{\s*display:\s*none/);
	assert.match(app, /onReady\(\)/);
	assert.match(app, /onFailure\(\)/);
	assert.match(app, /identity\.classList\.add\('logo-only'\)/);
	assert.match(app, /identity\.classList\.remove\('logo-only'\)/);
	assert.match(app, /'Watch '\s*\+\s*\(channel\.ChannelNumber/);
});
