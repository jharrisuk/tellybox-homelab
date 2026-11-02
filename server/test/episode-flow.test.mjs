import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { cleanSegments } from '../media-segments.mjs';

const source = readFileSync(new URL('../public/episode-flow.js', import.meta.url), 'utf8');
const context = vm.createContext({});
vm.runInContext(source, context);
const flow = context.TellyboxEpisodeFlow;
const segment = (type, start, end) => ({ type, start, end });
const segments = (...values) => values;

test('confirmed intros skip once and recaps or outros are never automatic', () => {
	const values = segments(segment('Recap', 10, 40), segment('Intro', 40, 70), segment('Outro', 1400, 1500));
	assert.equal(flow.introAt(values, 20000, 1500000), null);
	const intro = flow.introAt(values, 50000, 1500000);
	assert.equal(intro.type, 'Intro');
	const ledger = new flow.IntroLedger();
	assert.equal(ledger.shouldSkip(intro, 50000, 1500000), true);
	ledger.mark(intro);
	assert.equal(ledger.shouldSkip(intro, 51000, 1500000), false);
	assert.equal(ledger.shouldSkip(intro, 45000, 1500000), false);
	assert.equal(flow.introAt(values, 1450000, 1500000), null);
	assert.equal(ledger.shouldSkip(segment('Intro', 40, 400), 50000, 1500000), false);
	assert.equal(ledger.shouldSkip(segment('Intro', 0, 20), 5000, 0), true);
});

test('credits card and countdown start only from a conservative outro', () => {
	const duration = 1500000, outro = segment('Outro', 1400, 1500);
	assert.equal(flow.cardDue(1399000, duration, false, outro), false);
	assert.equal(flow.cardDue(1400000, duration, false, outro), true);
	assert.equal(flow.creditsCountdown(1399000, duration, false, outro), false);
	assert.equal(flow.creditsCountdown(1400000, duration, false, outro), true);
	assert.equal(flow.creditsCountdown(1470000, duration, false, segment('Outro', 900, 1000)), false);
	assert.equal(flow.creditsCountdown(1485000, duration, false, segment('Outro', 900, 1000)), true);
	assert.equal(flow.creditsCountdown(0, duration, true, null), true);
});

test('unknown credits fall back to a bounded early card and a final countdown', () => {
	assert.equal(flow.reliableOutro(segments(segment('Outro', 900, 1000)), 1500000), null);
	assert.equal(flow.fallbackLeadMs(3600000), 45000);
	assert.equal(flow.fallbackLeadMs(120000), 24000);
	assert.equal(flow.fallbackLeadMs(30000), 6000);
	assert.equal(flow.cardDue(3600000 - 45001, 3600000, false, null), false);
	assert.equal(flow.cardDue(3600000 - 45000, 3600000, false, null), true);
	assert.equal(flow.cardDue(500000, 0, false, null), false);
	assert.equal(flow.cardDue(3600000 - 45000, 3600000, false, segment('Outro', 900, 1000)), true);
	assert.equal(flow.earlyCountdownLeadMs(3600000), 15000);
	assert.equal(flow.earlyCountdownLeadMs(120000), 12000);
	assert.equal(flow.earlyCountdownLeadMs(100000), 10000);
	assert.equal(flow.earlyCountdownLeadMs(99999), 0);
	assert.equal(flow.earlyCountdownLeadMs(9000), 0);
	assert.equal(flow.creditsCountdown(3600000 - 15001, 3600000, false, null), false);
	assert.equal(flow.creditsCountdown(3600000 - 15000, 3600000, false, null), true);
	assert.equal(flow.creditsCountdown(3600000 - 5000, 3600000, false, null), true);
	assert.equal(flow.creditsCountdown(85000, 90000, false, null), false);
	assert.equal(flow.creditsCountdown(90000, 90000, true, null), true);
});

test('paused buffering hidden casting and stopped states do not consume the countdown', () => {
	assert.equal(flow.countdownCanAdvance({ playing: true }), true);
	assert.equal(flow.countdownCanAdvance({ playing: false }), false);
	assert.equal(flow.countdownCanAdvance({ playing: true, buffering: true }), false);
	assert.equal(flow.countdownCanAdvance({ playing: true, seeking: true }), false);
	assert.equal(flow.countdownCanAdvance({ playing: true, hidden: true }), false);
	assert.equal(flow.countdownCanAdvance({ playing: true, casting: true }), false);
	assert.equal(flow.countdownCanAdvance({ playing: true, stopped: true }), false);
	assert.equal(flow.countdownCanAdvance({ ended: true }), true);
	assert.equal(flow.countdownCanAdvance({ ended: true, casting: true }), false);
});

test('seeking back cancels the card and later re-entry is allowed', () => {
	const duration = 1500000, outro = segment('Outro', 1400, 1500);
	assert.equal(flow.cardDue(1400000, duration, false, outro), true);
	assert.equal(flow.cardDue(1200000, duration, false, outro), false);
	assert.equal(flow.cardDue(1410000, duration, false, outro), true);
});

test('server segment validation still excludes unusable or unrelated markers', () => {
	const items = cleanSegments([
		segment('Intro', 12, 42), segment('Recap', 5, 30), segment('Outro', 1380, 1440),
		segment('Intro', 100, 120), segment('Trailer', 1, 20), segment('Intro', 5000, 5030)
	], 1440);
	assert.deepEqual(items.map(value => value.type), ['Recap', 'Intro', 'Intro', 'Outro']);
});
