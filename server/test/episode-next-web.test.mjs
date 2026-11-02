import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const policySource = readFileSync(new URL('../public/episode-flow.js', import.meta.url), 'utf8');
const start = source.indexOf('let nextEpisode = null, nextTimer = null');
const end = source.indexOf("video.addEventListener('timeupdate'", start);
assert.ok(start >= 0 && end > start, 'missing browser next-card block');
const nextSource = source.slice(start, end);

function fakeNode(tag = 'div', className = '') {
	return {
		tag, className, textContent: '', hidden: false, disabled: false, children: [],
		append(...items) { this.children.push(...items); },
		replaceChildren(...items) { this.children = items; },
		remove() { this.removed = true; },
		setAttribute(name, value) { this[name] = value; },
		focus() { this.focused = true; },
		classList: { add() {}, remove() {}, toggle() {} },
		querySelector(selector) {
			if (selector === '.next-preview > div') return this.copyNode || null;
			return findNode(this, node => node.className === selector.replace(/^\./, ''));
		},
		querySelectorAll() { return []; }
	};
}
function findNode(root, match) {
	if (match(root)) return root;
	for (const child of root.children || []) {
		const found = findNode(child, match);
		if (found) return found;
	}
	return null;
}

function fixture() {
	const context = vm.createContext({ setInterval: () => 1, clearInterval: () => {}, console });
	vm.runInContext(policySource, context);
	const host = fakeNode();
	host.hidden = true;
	const skipIntro = fakeNode();
	const videoListeners = {};
	const video = {
		duration: 1500, currentTime: 1400, ended: false, paused: false, readyState: 4, seeking: false,
		addEventListener(name, listener) { videoListeners[name] = listener; }
	};
	const state = { live: false, playing: { Id: 'episode-1', Type: 'Episode', SeriesName: 'Example series', Name: 'Episode 1', ParentIndexNumber: 1, IndexNumber: 1 } };
	const casting = { active: false };
	const player = { open: true };
	const autoplayPreference = { checked: true };
	let interval = null;
	context.$ = selector => selector === '#upNext' ? host : selector === '#skipIntro' ? skipIntro : fakeNode();
	context.video = video;
	context.state = state;
	context.casting = casting;
	context.player = player;
	context.document = { hidden: false, createElement: tag => fakeNode(tag) };
	context.autoplayPreference = autoplayPreference;
	context.setInterval = callback => { interval = callback; return 1; };
	context.clearInterval = () => { interval = null; };
	context.__host = host;
	context.__video = video;
	context.__interval = () => interval;
	context.__setInterval = value => { interval = value; };
	context.element = (tag, className, text) => {
		const node = fakeNode(tag, className || '');
		if (text !== undefined) node.textContent = text;
		if (tag === 'div' && !className) host.copyNode = node;
		return node;
	};
	context.imageUrl = () => '';
	context.episodeNumber = () => 'S1 E2';
	context.startPlayback = async () => {};
	context.getProgress = () => 0;
	context.closePlayer = () => {};
	context.showDetails = () => {};
	context.api = async () => ({});
	context.playGeneration = 1;
	const definitions = vm.runInContext(`let viewingBlocked = false;
function __setNext(value) { nextEpisode = value; }
function __setResult(value) { nextResult = value; }
function __state() { return { nextTimer, nextDismissed, nextBusy, nextRenderedId, nextRenderedResult }; }
${nextSource}
({ setNext: __setNext, setResult: __setResult, state: __state });`, context);
	return { context, host, video, state, casting, autoplayPreference, definitions, run: code => vm.runInContext(code, context) };
}

test('browser credits card counts down during credits and holds while paused', () => {
	const f = fixture();
	f.definitions.setNext({ Id: 'episode-2', Name: 'Episode 2', ParentIndexNumber: 1, IndexNumber: 2 });
	f.definitions.setResult({ status: 'next' });
	f.run("segments = [{type:'Outro',start:1400,end:1500}]");
	f.run('updateNext()');
	assert.equal(f.host.hidden, false);
	assert.match(f.host.querySelector('.next-countdown').textContent, /Starts in 10 seconds/);
	const tick = f.context.__interval();
	assert.ok(tick);
	tick();
	assert.match(f.host.querySelector('.next-countdown').textContent, /Starts in 9 seconds/);
	f.video.paused = true;
	tick();
	assert.match(f.host.querySelector('.next-countdown').textContent, /Starts in 9 seconds/);
	f.video.paused = false;
	tick();
	assert.match(f.host.querySelector('.next-countdown').textContent, /Starts in 8 seconds/);
});

test('browser seeking back hides the card and later re-entry restarts it', () => {
	const f = fixture();
	f.definitions.setNext({ Id: 'episode-2', Name: 'Episode 2', ParentIndexNumber: 1, IndexNumber: 2 });
	f.definitions.setResult({ status: 'next' });
	f.run("segments = [{type:'Outro',start:1400,end:1500}]");
	f.run('updateNext()');
	assert.equal(f.host.hidden, false);
	f.video.currentTime = 1200;
	f.run('updateNext()');
	assert.equal(f.host.hidden, true);
	assert.equal(f.definitions.state().nextTimer, null);
	assert.equal(f.definitions.state().nextDismissed, false);
	f.video.currentTime = 1410;
	f.run('updateNext()');
	assert.equal(f.host.hidden, false);
	assert.ok(f.definitions.state().nextTimer);
});

test('browser Keep watching dismisses the card for the episode', () => {
	const f = fixture();
	f.definitions.setNext({ Id: 'episode-2', Name: 'Episode 2' });
	f.definitions.setResult({ status: 'next' });
	f.run("segments = [{type:'Outro',start:1400,end:1500}]");
	f.run('updateNext()');
	const keep = findNode(f.host, node => node.tag === 'button' && node.textContent === 'Keep watching');
	assert.ok(keep);
	keep.onclick();
	assert.equal(f.definitions.state().nextDismissed, true);
	assert.equal(f.host.hidden, true);
	f.run('updateNext()');
	assert.equal(f.host.hidden, true);
});

test('browser fallback card counts down in the last fifteen seconds', () => {
	const f = fixture();
	f.definitions.setNext({ Id: 'episode-2', Name: 'Episode 2' });
	f.definitions.setResult({ status: 'next' });
	f.video.duration = 600;
	f.video.currentTime = 555;
	f.run('updateNext()');
	assert.equal(f.host.hidden, false);
	assert.equal(f.definitions.state().nextTimer, null);
	f.video.currentTime = 585;
	f.run('updateNext()');
	assert.ok(f.definitions.state().nextTimer);
	f.video.currentTime = 600;
	f.video.ended = true;
	f.run('updateNext()');
	assert.ok(f.definitions.state().nextTimer);
});

test('browser short episodes wait for the end before counting down', () => {
	const f = fixture();
	f.definitions.setNext({ Id: 'episode-2', Name: 'Episode 2' });
	f.definitions.setResult({ status: 'next' });
	f.video.duration = 90;
	f.video.currentTime = 80;
	f.run('updateNext()');
	assert.equal(f.host.hidden, false);
	assert.equal(f.definitions.state().nextTimer, null);
	f.video.currentTime = 85;
	f.run('updateNext()');
	assert.equal(f.definitions.state().nextTimer, null, 'A short episode keeps its last ten seconds');
	f.video.currentTime = 90;
	f.video.ended = true;
	f.run('updateNext()');
	assert.ok(f.definitions.state().nextTimer);
});

test('browser no-next end view updates without inventing recommendations', () => {
	const f = fixture();
	f.definitions.setResult({ status: 'caught-up' });
	f.video.currentTime = 1500;
	f.video.ended = true;
	f.run('updateNext()');
	assert.equal(f.host.hidden, false);
	assert.ok(findNode(f.host, node => node.textContent === 'You’re up to date'));
	assert.equal(findNode(f.host, node => node.textContent === 'More to explore'), null);
});
