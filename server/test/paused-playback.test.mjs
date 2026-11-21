import test from 'node:test';
import assert from 'node:assert/strict';
import { createPausedPlayback, isPausableSession, PAUSED_TIMEOUT, terminalStopFor } from '../paused-playback.mjs';

let now = 0;
const playback = () => createPausedPlayback({ clock: () => now, minutes: () => 10 });
const session = (extra = {}) => ({ id: 's1', owner: 'o', position: 42, ...extra });
const advance = ms => { now += ms; };

test('continuous user pause expires after ten minutes and saves the position', () => {
	now = 1000;
	const p = playback(), s = session();
	p.observe(s, { paused: true, position: 42 });
	assert.equal(p.state(s).paused, true);
	advance(9 * 60000);
	assert.deepEqual(p.expired(new Map([[s.id, s]])), []);
	advance(60000);
	const expired = p.expired(new Map([[s.id, s]]));
	assert.equal(expired.length, 1);
	assert.equal(expired[0].id, 's1');
	assert.equal(expired[0].position, 42);
	assert.equal(PAUSED_TIMEOUT, 'PAUSED_TIMEOUT');
});

test('repeated paused heartbeats do not restart the timer; unpause resets it', () => {
	now = 0;
	const p = playback(), s = session();
	p.observe(s, { paused: true });
	advance(5 * 60000);
	p.observe(s, { paused: true });
	advance(5 * 60000);
	assert.equal(p.expired(new Map([[s.id, s]])).length, 1, 'the original paused instant is retained');
	p.observe(s, { paused: false });
	assert.equal(p.state(s).paused, false);
	p.observe(s, { paused: true });
	advance(9 * 60000);
	assert.equal(p.expired(new Map([[s.id, s]])).length, 0, 'unpause then repause starts a fresh interval');
});

test('buffering and seeking clear the user-pause timer', () => {
	now = 0;
	const p = playback(), s = session();
	p.observe(s, { paused: true });
	advance(60000);
	p.observe(s, { paused: true, buffering: true });
	assert.equal(p.state(s).paused, false);
	advance(9 * 60000);
	assert.equal(p.expired(new Map([[s.id, s]])).length, 0);
	p.observe(s, { paused: true, seeking: true });
	assert.equal(p.state(s).paused, false);
	advance(10 * 60000);
	assert.equal(p.expired(new Map([[s.id, s]])).length, 0);
});

test('live, 24/7 and live relay sessions are excluded', () => {
	now = 0;
	const p = playback();
	for (const s of [session({ live: true }), session({ nonstop: true }), session({ relayMode: 'live' }), session({ itemId: 'dispatch-live-1' })]) {
		p.observe(s, { paused: true });
		assert.equal(p.state(s).paused, false);
	}
	advance(60 * 60000);
	const all = new Map([['a', session({ live: true })], ['b', session({ nonstop: true })]]);
	for (const s of all.values()) { s.paused = true; s.pausedSince = 0; }
	assert.deepEqual(p.expired(all), []);
});

test('zero minutes disables the timeout and malformed settings fail safe', () => {
	now = 0;
	for (const minutes of [0, -1, NaN, null]) {
		const p = createPausedPlayback({ clock: () => now, minutes: () => minutes });
		const s = session();
		p.observe(s, { paused: true });
		advance(24 * 60 * 60000);
		assert.deepEqual(p.expired(new Map([[s.id, s]])), [], String(minutes));
	}
});

test('only pausable VOD, local and catch-up shapes are accepted', () => {
	assert.equal(isPausableSession(session({ vod: true })), true);
	assert.equal(isPausableSession(session({ relayMode: 'catchup' })), true);
	assert.equal(isPausableSession(session({ relayMode: 'recording' })), true);
	assert.equal(isPausableSession(session({ relayMode: 'live' })), false);
	assert.equal(isPausableSession(session({ nonstop: true })), false);
	assert.equal(isPausableSession(session({ live: true })), false);
	assert.equal(isPausableSession(session({ download: true })), false);
});

test('terminal stop ownership is exact and does not delete another owner record', () => {
	const stops = new Map([['s1', { owner: 'owner-a', code: 'PAUSED_TIMEOUT', position: 12 }]]);
	assert.equal(terminalStopFor(stops, 's1', 'owner-b'), null);
	assert.equal(terminalStopFor(stops, 's1', ''), null);
	assert.equal(terminalStopFor(stops, 's1', undefined), null);
	assert.equal(stops.size, 1, 'a rejected lookup must not consume the tombstone');
	assert.equal(terminalStopFor(stops, 's1', 'owner-a').position, 12);
	assert.equal(stops.size, 1, 'a successful lookup is idempotent');
});

test('exact clock boundary uses the configured minute boundary', () => {
	now = 0;
	const p = playback(), s = session();
	p.observe(s, { paused: true });
	advance(10 * 60000 - 1);
	assert.equal(p.expired(new Map([[s.id, s]])).length, 0);
	advance(1);
	assert.equal(p.expired(new Map([[s.id, s]])).length, 1);
});
