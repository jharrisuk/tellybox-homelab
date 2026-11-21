import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import test from 'node:test';

const helper = readFileSync(new URL('../public/autoplay.js', import.meta.url), 'utf8');
const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const index = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const autoplay = vm.runInNewContext(helper + '\nTellyboxAutoplay', {});

test('classifies browser policy separately from source races', () => {
	assert.equal(autoplay.classify({ name: 'NotAllowedError' }), 'blocked');
	assert.equal(autoplay.classify({ name: 'AbortError' }), 'race');
	assert.equal(autoplay.classify({ name: 'NotSupportedError' }), 'unsupported');
	assert.equal(autoplay.classify({ name: 'NotReadableError' }), 'unsupported');
	assert.equal(autoplay.classify({ name: 'TypeError' }), 'unknown');
	assert.equal(autoplay.classify(null), 'unknown');
});

test('only a source race is retried automatically', () => {
	assert.equal(autoplay.shouldRetry('race'), true);
	for (const kind of ['blocked', 'unsupported', 'unknown']) assert.equal(autoplay.shouldRetry(kind), false);
});

test('blocked playback gets an explicit live or on-demand message', () => {
	assert.match(autoplay.status('blocked', true), /Play live/);
	assert.match(autoplay.status('blocked', false), /Press play/);
	assert.match(autoplay.status('unsupported', true), /compatibility mode/);
	assert.doesNotMatch(autoplay.status('blocked', true), /mute/i);
});

test('the spinner is hidden when paused or blocked and shown while starting/playing', () => {
	assert.equal(autoplay.loadingVisible({ starting: false, paused: true, blocked: true }), false);
	assert.equal(autoplay.loadingVisible({ starting: true, paused: true, blocked: true }), false);
	assert.equal(autoplay.loadingVisible({ starting: true, paused: true, blocked: false }), true);
	assert.equal(autoplay.loadingVisible({ starting: false, paused: false, blocked: false }), true);
	assert.equal(autoplay.loadingVisible({ starting: false, paused: true, blocked: false }), false);
});

test('Play live is offered only for a paused live source with a source attached', () => {
	assert.equal(autoplay.playVisible({ live: true, paused: true, hasSource: true }), true);
	assert.equal(autoplay.playVisible({ live: true, paused: false, hasSource: true }), false);
	assert.equal(autoplay.playVisible({ live: true, paused: true, hasSource: false }), false);
	assert.equal(autoplay.playVisible({ live: false, paused: true, hasSource: true }), false);
});

test('the player nudges play before metadata and retries on manifest/canplay', () => {
	assert.match(app, /function beginPlayback\(generation\)/);
	assert.match(app, /function nudgePlayback\(generation\)/);
	assert.match(app, /hls\.on\(Hls\.Events\.MANIFEST_PARSED, \(\) => \{ if \(generation === playGeneration && state\.hls === hls\) \{ state\.hlsReady = true; nudgePlayback\(generation\); \} \}\)/);
	assert.match(app, /nudgePlayback\(generation\);\n\t} catch/);
	assert.match(app, /video\.addEventListener\('canplay', \(\) => \{\n\tif \(state\.playRetry/);
	assert.match(app, /if \(!hasPlaybackSource\(\)\) \{ state\.playRetry = true; return; \}/);
});

test('a genuine NotAllowedError is surfaced, not muted or retried in a loop', () => {
	assert.match(app, /autoplay\.classify\(error\)/);
	assert.match(app, /kind === 'unsupported'/);
	assert.match(app, /state\.playBlocked = true;/);
	assert.match(app, /autoplay\.status\(kind, state\.live\)/);
	assert.match(app, /if \(state\.playBlocked\) return true;/);
	assert.doesNotMatch(app, /video\.muted = true/);
	assert.doesNotMatch(app, /muted = true/);
});

test('the waiting spinner cannot reappear after a blocked play', () => {
	assert.match(app, /autoplay\.loadingVisible\(\{starting:state\.playStarting,paused:video\.paused,blocked:state\.playBlocked\}\)/);
	assert.doesNotMatch(app, /video\.addEventListener\('waiting',\(\)=>playerLoading\(true\)\)/);
});

test('the helper loads before the player script', () => {
	assert.ok(index.indexOf('/autoplay.js') >= 0);
	assert.ok(index.indexOf('/autoplay.js') < index.indexOf('/app.js'));
});

test('the local route probe is bounded, cached, and skipped when not applicable', () => {
	assert.equal(autoplay.localProbeTimeout(), 4000);
	assert.equal(autoplay.localFailureCacheMs(), 300000);
	const base = { home: true, origin: 'http://home.test:8082', preferLocal: true, direct: false };
	assert.equal(autoplay.localProbeDue({ ...base, checked: false }, 1000), true);
	assert.equal(autoplay.localProbeDue({ ...base, checked: true, enabled: true, checkedAt: 1000 }, 2000), false);
	assert.equal(autoplay.localProbeDue({ ...base, checked: true, enabled: false, checkedAt: 1000 }, 2000), false);
	assert.equal(autoplay.localProbeDue({ ...base, checked: true, enabled: false, checkedAt: 1000 }, 301001), true);
	assert.equal(autoplay.localProbeDue({ ...base, direct: true, checked: false }, 1000), false);
});

test('playback preparation overlaps the route probe and uses the capped timeout', () => {
	assert.match(app, /const playbackBasePromise = playbackBase\(\)\.catch\(\(\) => ''\);/);
	assert.match(app, /await playbackBasePromise/);
	assert.match(app, /AbortSignal\.timeout\(autoplay\.localProbeTimeout\(\)\)/);
	assert.match(app, /Checking local playback/);
});

function playbackHarness(play) {
	const ui = { textContent: '', focused: false, hidden: false, focus() { this.focused = true; } };
	const context = {
		playGeneration: 1,
		player: { open: true },
		state: { live: true, playStarting: false, playBlocked: false, playRetry: false, playAttempt: null },
		video: { paused: true, currentSrc: 'blob:test', getAttribute: () => null, play },
		autoplay,
		playerLoading() {},
		updateLiveControls() {},
		playbackFailed() {},
		$: () => ui,
		ui,
		calls: { play: 0 }
	};
	vm.createContext(context);
	const start = app.indexOf('function hasPlaybackSource()');
	const end = app.indexOf('// Native media keys');
	assert.ok(start >= 0 && end > start, 'playback helpers missing');
	vm.runInContext(app.slice(start, end) + '\nthis.__api = { beginPlayback, nudgePlayback, state, video, ui };', context);
	return context;
}

const tick = () => new Promise(resolve => setImmediate(resolve));

test('a NotAllowedError blocks automatic retries and shows the live affordance', async () => {
	const harness = playbackHarness(() => Promise.reject(Object.assign(new Error('blocked'), { name: 'NotAllowedError' })));
	harness.__api.beginPlayback(1);
	await tick();
	assert.equal(harness.__api.state.playBlocked, true);
	assert.equal(harness.__api.state.playStarting, false);
	assert.match(harness.__api.ui.textContent, /Play live/);
	assert.equal(harness.__api.ui.focused, true);
});

test('an AbortError is treated as a source race, not a policy block', async () => {
	const harness = playbackHarness(() => Promise.reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
	harness.__api.beginPlayback(1);
	await tick();
	assert.equal(harness.__api.state.playRetry, true);
	assert.equal(harness.__api.state.playBlocked, false);
});

test('a NotSupportedError is surfaced as a real playback failure', async () => {
	let failed = 0;
	const harness = playbackHarness(() => Promise.reject(Object.assign(new Error('unsupported'), { name: 'NotSupportedError' })));
	harness.playbackFailed = () => { failed++; };
	harness.__api.beginPlayback(1);
	await tick();
	assert.equal(harness.__api.state.playBlocked, true);
	assert.equal(failed, 1);
});

test('one play attempt is shared while it is pending', async () => {
	let resolve;
	const harness = playbackHarness(() => { harness.calls.play++; return new Promise(r => { resolve = r; }); });
	harness.__api.beginPlayback(1);
	harness.__api.beginPlayback(1);
	harness.__api.nudgePlayback(1);
	assert.equal(harness.calls.play, 1);
	resolve();
	await tick();
	assert.equal(harness.__api.state.playBlocked, false);
});

test('nudging before a source is ready records a retry instead of calling play', async () => {
	const harness = playbackHarness(() => { harness.calls.play++; return Promise.resolve(); });
	harness.__api.video.currentSrc = '';
	harness.__api.video.getAttribute = () => null;
	harness.__api.nudgePlayback(1);
	await tick();
	assert.equal(harness.calls.play, 0);
	assert.equal(harness.__api.state.playRetry, true);
});

test('nudging a ready source starts playback before metadata arrives', async () => {
	const harness = playbackHarness(() => { harness.calls.play++; return Promise.resolve(); });
	harness.__api.nudgePlayback(1);
	await tick();
	assert.equal(harness.calls.play, 1);
	assert.equal(harness.__api.state.playBlocked, false);
	assert.equal(harness.__api.state.playStarting, false);
});

test('HLS waits for the manifest before nudging play', async () => {
	const harness = playbackHarness(() => { harness.calls.play++; return Promise.resolve(); });
	harness.__api.state.hls = {};
	harness.__api.state.hlsReady = false;
	harness.__api.nudgePlayback(1);
	await tick();
	assert.equal(harness.calls.play, 0);
	assert.equal(harness.__api.state.playRetry, true);
	harness.__api.state.hlsReady = true;
	harness.__api.nudgePlayback(1);
	await tick();
	assert.equal(harness.calls.play, 1);
});
