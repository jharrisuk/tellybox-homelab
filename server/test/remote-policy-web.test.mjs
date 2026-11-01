import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const appSource = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const shareSource = readFileSync(new URL('../public/share-player.js', import.meta.url), 'utf8');

function between(source, start, end) {
	const from = source.indexOf(start), to = source.indexOf(end, from);
	assert.ok(from >= 0 && to > from, `Missing source block ${start} .. ${end}`);
	return source.slice(from, to);
}

function fakeNode(properties = {}) {
	return {
		hidden: false, disabled: false, textContent: '', value: '', max: '0',
		options: { length: 1 }, focused: false,
		setAttribute() {}, focus() { this.focused = true; }, classList: { toggle() {} },
		...properties
	};
}

const liveSlice = between(appSource, 'function updateCastControls(', 'function setupCast(');
const quotaSlice = between(appSource, 'function resetViewingState(', 'let nextEpisode');
const detachSlice = between(appSource, 'async function detach()', 'function chooseCatchupResume(');
const failureSlice = between(appSource, 'function policyDenialFromBody(', 'function closePlayer(');
const episodeSlice = between(appSource, 'function episodeNumber(', 'function card(');
const shareLiveSlice = between(shareSource, 'function updateLiveControls(', 'function stopForPolicy(');

function appFixture({ api, fetch } = {}) {
	const nodes = new Map();
	const seekLabel = fakeNode();
	nodes.set('#castSeek', fakeNode({ closest: () => seekLabel }));
	const $ = selector => {
		if (!nodes.has(selector)) nodes.set(selector, fakeNode());
		return nodes.get(selector);
	};
	const video = {
		controls: true, disablePictureInPicture: false, paused: false, currentSrc: 'blob:live',
		muted: false, currentTime: 10, readyState: 4, playbackRate: 1, playCalls: 0, removeCalls: 0, loadCalls: 0,
		seekable: { length: 1, end: () => 100 },
		play() { this.playCalls++; return Promise.resolve(); },
		pause() {}, load() { this.loadCalls++; }, removeAttribute() { this.removeCalls++; }
	};
	const document = { activeElement: null, fullscreenElement: null, addEventListener() {} };
	const player = { open: true };
	const state = { live: false, session: 'session-1', sessionBase: '', playing: { Type: 'Episode' }, playbackKind: 'hls', hls: null };
	const casting = {
		active: false, busy: false, pendingTarget: null, context: { getCurrentSession: () => null },
		remote: { playerState: 'PLAYING', isPaused: false, currentTime: 10, duration: 100, canPause: true, canSeek: true, isMuted: false }
	};
	const requests = { api: [], fetch: [] };
	const apiMock = api || (async (url, body) => { requests.api.push({ url, body }); return null; });
	const fetchMock = fetch || ((url, options) => {
		requests.fetch.push({ url: String(url), options });
		return Promise.resolve({});
	});
	const context = {
		$, video, document, player, state, casting, fetch: fetchMock, api: apiMock,
		location: { origin: 'https://example.test' }, playerLoading() {}, updateRouting() {},
		playbackPosition() { return 10; }, saveProgress() {}, startPlayback() {},
		Number, Math, Date, JSON, Object, Set, Map, Boolean, String, Promise, URL
	};
	vm.createContext(context);
	vm.runInContext(`let playGeneration = 1;
let viewingWarningShown = false;
let viewingBlocked = false;
let segments = [];
function cancelNext() {}
function __setGeneration(value) { playGeneration = value; }
function __viewingState() { return { viewingWarningShown, viewingBlocked }; }
${liveSlice}
${quotaSlice}
${detachSlice}
${failureSlice}
${episodeSlice}`, context);
	context.resetViewingState();
	return { context, nodes, video, player, state, casting, requests, seekLabel, $ };
}

function shareFixture() {
	const nodes = new Map();
	const $ = selector => {
		if (!nodes.has(selector)) nodes.set(selector, fakeNode());
		return nodes.get(selector);
	};
	const video = {
		controls: true, disablePictureInPicture: false, paused: false, currentSrc: 'blob:live',
		muted: false, currentTime: 10, playCalls: 0,
		seekable: { length: 1, end: () => 100 },
		play() { this.playCalls++; return Promise.resolve(); }, pause() {}, load() {}, removeAttribute() {}
	};
	const context = { $, video, document: { fullscreenElement: null, addEventListener() {} } };
	vm.createContext(context);
	vm.runInContext(`let live = false, busy = false, expired = false, blocked = false;
${shareLiveSlice}
${between(shareSource, 'function episodeNumber(', 'function endAccess(')}`, context);
	return { context, nodes, video };
}

test('web episode labels keep series, S/E and title without duplicate or null parts', () => {
	const fixture = appFixture();
	const label = fixture.context.playbackTitle;
	assert.equal(label({ Type: 'Episode', SeriesName: 'The Show', ParentIndexNumber: 2, IndexNumber: 6, Name: 'The Episode' }), 'The Show · S2 E6 · The Episode');
	assert.equal(label({ Type: 'Episode', SeriesName: 'The Show', ParentIndexNumber: 2, IndexNumber: 6, Name: 'The Show' }), 'The Show · S2 E6');
	assert.equal(label({ Type: 'Episode', SeriesName: 'The Show', Name: 'The Show' }), 'The Show');
	assert.equal(label({ Type: 'Episode', Name: 'Standalone' }), 'Standalone');
	for (const item of [
		{ Type: 'Episode', SeriesName: 'The Show', ParentIndexNumber: 2, IndexNumber: 6, Name: 'The Episode' },
		{ Type: 'Episode', Name: 'Standalone' },
		{ Type: 'Movie', Name: 'A Film' }
	]) assert.doesNotMatch(label(item), /undefined|null/);
});

test('live mode disables native controls and cast seek while catch-up retains both', () => {
	const fixture = appFixture();
	fixture.context.setLiveMode(true);
	assert.equal(fixture.video.controls, false);
	assert.equal(fixture.nodes.get('#liveControls').hidden, false);
	assert.equal(fixture.nodes.get('#castPause').hidden, true);
	assert.equal(fixture.seekLabel.hidden, true);

	fixture.video.paused = true;
	fixture.context.updateLiveControls();
	assert.equal(fixture.nodes.get('#livePlay').hidden, false);
	fixture.video.paused = false;
	fixture.context.updateLiveControls();
	assert.equal(fixture.nodes.get('#livePlay').hidden, true);

	fixture.context.setLiveMode(false);
	assert.equal(fixture.video.controls, true);
	assert.equal(fixture.nodes.get('#liveControls').hidden, true);
	assert.equal(fixture.nodes.get('#castPause').hidden, false);
	assert.equal(fixture.seekLabel.hidden, false);
});

test('native pause and seek attempts are undone only for live playback', () => {
	const fixture = appFixture();
	fixture.state.live = true;
	fixture.video.currentTime = 40;
	fixture.context.keepLiveEdge();
	assert.equal(fixture.video.currentTime, 100);
	assert.equal(fixture.context.keepLivePlayback(), true);
	assert.equal(fixture.video.playCalls, 1);

	fixture.state.live = false;
	fixture.video.currentTime = 40;
	fixture.context.keepLiveEdge();
	assert.equal(fixture.video.currentTime, 40, 'catch-up seeking is left alone');
	const before = fixture.video.playCalls;
	assert.equal(fixture.context.keepLivePlayback(), false);
	assert.equal(fixture.video.playCalls, before, 'catch-up pause is left alone');
});

test('quota block shows the reason, releases media, disables retry and clears on reset', () => {
	const fixture = appFixture();
	fixture.context.__setGeneration(3);
	fixture.context.showViewingBlocked('Your daily remote viewing allowance has been used.', 3);
	assert.equal(fixture.nodes.get('#viewingBlocked').hidden, false);
	assert.equal(fixture.nodes.get('#viewingBlockedMessage').textContent, 'Your daily remote viewing allowance has been used.');
	assert.equal(fixture.state.session, null);
	assert.equal(fixture.nodes.get('#retryPlayer').disabled, true);
	assert.equal(fixture.nodes.get('#quality').disabled, true);
	assert.equal(fixture.nodes.get('#audioTrack').disabled, true);
	assert.equal(fixture.nodes.get('#subtitleTrack').disabled, true);
	assert.equal(fixture.nodes.get('#castButton').disabled, true);
	assert.equal(fixture.requests.fetch.length, 1);
	assert.match(fixture.requests.fetch[0].url, /\/api\/sessions\/session-1$/);
	assert.equal(JSON.parse(fixture.requests.fetch[0].options.body).action, 'stop');
	assert.equal(fixture.context.__viewingState().viewingBlocked, true);

	fixture.context.resetViewingState();
	assert.equal(fixture.nodes.get('#viewingBlocked').hidden, true);
	assert.equal(fixture.nodes.get('#viewingBlockedMessage').textContent, '');
	assert.equal(fixture.context.__viewingState().viewingBlocked, false);
	assert.equal(fixture.context.__viewingState().viewingWarningShown, false);

	fixture.state.session = 'new-session';
	fixture.context.__setGeneration(4);
	fixture.context.showViewingBlocked('stale quota result', 3);
	assert.equal(fixture.state.session, 'new-session', 'a stale block result must not stop the newer stream');
	assert.equal(fixture.nodes.get('#viewingBlocked').hidden, true);
	assert.equal(fixture.context.__viewingState().viewingBlocked, false);
	assert.equal(fixture.requests.fetch.length, 1);
});

test('HLS segment SESSION_LIMIT body stops immediately without a generic retry', async () => {
	const fixture = appFixture();
	const hls = { destroy() {} };
	fixture.state.hls = hls;
	fixture.state.session = 'segment-session';
	fixture.context.__setGeneration(5);
	const body = JSON.stringify({ error: 'This account is already watching on another screen.', code: 'SESSION_LIMIT' });
	await fixture.context.playbackFailed('Playback was interrupted. Try compatibility mode.', hls, { response: { code: 429, text: body } });
	assert.equal(fixture.nodes.get('#viewingBlocked').hidden, false);
	assert.equal(fixture.nodes.get('#viewingBlockedMessage').textContent, 'This account is already watching on another screen.');
	assert.equal(fixture.nodes.get('#playerStatus').textContent, '');
	assert.equal(fixture.nodes.get('#retryPlayer').disabled, true);
	assert.equal(fixture.requests.api.length, 0, 'a structured body must not be replaced by a generic heartbeat guess');
	assert.equal(fixture.state.session, null);
});

test('a native media failure asks the owned-session heartbeat before showing a generic retry', async () => {
	let rejectHeartbeat;
	const calls = [];
	const fixture = appFixture({
		api: (url, body, base, timeout) => {
			calls.push({ url, body, base, timeout });
			return new Promise((resolve, reject) => { if (url.startsWith('/api/sessions/')) rejectHeartbeat = reject; else resolve(null); });
		}
	});
	fixture.state.hls = null;
	fixture.state.session = 'native-session';
	fixture.context.__setGeneration(6);
	const pending = fixture.context.playbackFailed('This browser could not play the stream. Try compatibility mode below.');
	assert.equal(fixture.nodes.get('#playerStatus').textContent, 'Checking playback status...');
	assert.equal(fixture.nodes.get('#retryPlayer').disabled, true);
	rejectHeartbeat(Object.assign(new Error('This account is already watching on another screen.'), { code: 'SESSION_LIMIT' }));
	await pending;
	assert.equal(fixture.nodes.get('#viewingBlocked').hidden, false);
	assert.equal(fixture.nodes.get('#viewingBlockedMessage').textContent, 'This account is already watching on another screen.');
	assert.equal(fixture.nodes.get('#playerStatus').textContent, '');
	assert.equal(fixture.nodes.get('#retryPlayer').disabled, true);
	assert.equal(calls.filter(call => call.url === '/api/viewing-status').length, 0, 'the authoritative heartbeat denial is enough');
});

test('a valid active slot with the cap full is not treated as a session-limit denial', async () => {
	const calls = [];
	const fixture = appFixture({
		api: async url => {
			calls.push(url);
			if (url === '/api/viewing-status') return { blocked: false, remainingSeconds: null, maxSessions: 1, activeSessions: 1, code: null, message: '' };
			return null;
		}
	});
	fixture.state.hls = null;
	fixture.state.session = 'valid-session';
	fixture.context.__setGeneration(7);
	await fixture.context.playbackFailed('This browser could not play the stream. Try compatibility mode below.');
	assert.equal(fixture.context.__viewingState().viewingBlocked, false);
	assert.equal(fixture.nodes.get('#viewingBlocked').hidden, true);
	assert.equal(fixture.state.session, 'valid-session');
	assert.equal(fixture.nodes.get('#playerStatus').textContent, 'This browser could not play the stream. Try compatibility mode below.');
	assert.equal(fixture.nodes.get('#retryPlayer').disabled, false, 'a valid slot may retry a genuine media failure');
	assert.ok(calls.some(url => url === '/api/viewing-status'));
});

test('stale heartbeat failures cannot block a newer or closed playback', async () => {
	let rejectRequest;
	const fixture = appFixture({ api: () => new Promise((resolve, reject) => { rejectRequest = reject; }) });
	fixture.state.session = 'old-session';
	fixture.player.open = true;
	fixture.context.__setGeneration(1);
	const pending = fixture.context.report('progress');
	fixture.state.session = 'new-session';
	fixture.context.__setGeneration(2);
	rejectRequest(Object.assign(new Error('Your allowance has been used.'), { code: 'VIEWING_LIMIT' }));
	await pending;
	assert.equal(fixture.state.session, 'new-session');
	assert.equal(fixture.$('#viewingBlocked').hidden, true);
	assert.equal(fixture.context.__viewingState().viewingBlocked, false);
	assert.equal(fixture.requests.fetch.length, 0, 'a stale failure must not stop or release the new stream');
});

test('a stale detach cannot tear down a newer stream after its stop request', async () => {
	let resolveStop;
	const fixture = appFixture({ api: () => new Promise(resolve => { resolveStop = resolve; }) });
	fixture.state.session = 'old-session';
	fixture.context.__setGeneration(2);
	const pending = fixture.context.detach();
	fixture.state.session = 'new-session';
	fixture.context.__setGeneration(3);
	resolveStop(null);
	await pending;
	assert.equal(fixture.state.session, 'new-session');
	assert.equal(fixture.video.removeCalls, 0, 'stale detach must not clear the newer media source');
	assert.equal(fixture.video.loadCalls, 0, 'stale detach must not reload the newer media element');
});

test('a stale viewing-status response cannot block playback after the player closes', async () => {
	let resolveStatus;
	const fixture = appFixture({
		api: url => url === '/api/viewing-status'
			? new Promise(resolve => { resolveStatus = resolve; })
			: Promise.resolve(null)
	});
	fixture.player.open = true;
	fixture.context.__setGeneration(1);
	const pending = fixture.context.checkViewingStatus();
	fixture.player.open = false;
	fixture.context.__setGeneration(2);
	resolveStatus({ blocked: true, message: 'Your allowance has been used.' });
	assert.equal(await pending, null);
	assert.equal(fixture.$('#viewingBlocked').hidden, true);
	assert.equal(fixture.context.__viewingState().viewingBlocked, false);
});

test('quota warning is shown once and cleared with viewing state', async () => {
	const responses = [
		{ blocked: false, remainingSeconds: 120, resetAt: null },
		{ blocked: false, remainingSeconds: 60, resetAt: null },
		{ blocked: false, remainingSeconds: 30, resetAt: null }
	];
	const fixture = appFixture({ api: async () => responses.shift() });
	await fixture.context.checkViewingStatus();
	const notice = fixture.nodes.get('#viewingNotice');
	assert.equal(notice.hidden, false);
	assert.match(notice.textContent, /About 2 minutes/);
	await fixture.context.checkViewingStatus();
	assert.match(notice.textContent, /About 2 minutes/, 'the warning must not repeat or change for the same playback');
	fixture.context.resetViewingState();
	assert.equal(notice.hidden, true);
	await fixture.context.checkViewingStatus();
	assert.equal(notice.hidden, false);
	assert.match(notice.textContent, /Less than a minute/);
});

test('shared live playback disables native controls and keeps live keys from pausing or seeking', () => {
	const fixture = shareFixture();
	fixture.context.setLive(true);
	assert.equal(fixture.video.controls, false);
	assert.equal(fixture.nodes.get('liveControls').hidden, false);
	fixture.context.setLive(false);
	assert.equal(fixture.video.controls, true);
	assert.equal(fixture.nodes.get('liveControls').hidden, true);

	fixture.context.setLive(true);
	fixture.video.currentTime = 30;
	fixture.context.keepLiveEdge();
	assert.equal(fixture.video.currentTime, 100);
	assert.equal(fixture.context.keepLivePlayback(), true);
	assert.equal(fixture.video.playCalls, 1);
	fixture.context.setLive(false);
	fixture.video.currentTime = 30;
	fixture.context.keepLiveEdge();
	const before = fixture.video.playCalls;
	assert.equal(fixture.context.keepLivePlayback(), false);
	assert.equal(fixture.video.currentTime, 30);
	assert.equal(fixture.video.playCalls, before);
});

test('shared episode titles use series, S/E and title fallback', () => {
	const fixture = shareFixture();
	assert.equal(fixture.context.episodeTitle({ ParentIndexNumber: 2, IndexNumber: 6, Name: 'The Episode' }, 'The Show'), 'The Show · S2 E6 · The Episode');
	assert.equal(fixture.context.episodeTitle({ Name: 'The Show' }, 'The Show'), 'The Show');
	assert.equal(fixture.context.episodeTitle({ IndexNumber: 6, Name: 'The Episode' }, 'The Show'), 'The Show · E6 · The Episode');
});
