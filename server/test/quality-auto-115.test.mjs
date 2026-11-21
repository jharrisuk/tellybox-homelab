import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

/* Quality-Auto regression (post-115 buffering defect):
 * when the quality value is 0 (Auto), the trouble-panel lower action must
 * resolve Auto against the effective negotiated ceiling instead of returning
 * 0 immediately, and must offer a strictly lower supported rung. */

const context = {};
vm.runInNewContext(readFileSync(new URL('../public/playback-warning.js', import.meta.url), 'utf8'), context);
const nextLowerQuality = context.TellyboxBufferingWarning.nextLowerQuality;
const QUALITY_RUNGS = context.TellyboxBufferingWarning.QUALITY_RUNGS;

test('supported rungs include 2 Mbps and keep 4/8/20/80', () => {
	// Spread into a local array: the vm context has its own realm, so a frozen
	// array from it cannot be reference-compared with deepEqual directly.
	assert.deepEqual([...QUALITY_RUNGS], [80000000, 20000000, 8000000, 4000000, 2000000]);
});

test('Auto with a negotiated 8 Mbps ceiling steps down to 4 Mbps', () => {
	assert.equal(nextLowerQuality(0, null, 8000000), 4000000);
});

test('Auto with a negotiated 20 Mbps ceiling steps down to 8 Mbps', () => {
	assert.equal(nextLowerQuality(0, null, 20000000), 8000000);
});

test('Auto with no negotiated ceiling falls back to 8 Mbps, never 80', () => {
	assert.equal(nextLowerQuality(0), 4000000);
	assert.equal(nextLowerQuality(0, null, 0), 4000000);
	assert.equal(nextLowerQuality(-1, null, 0), 4000000);
});

test('explicit 4 Mbps steps down to the 2 Mbps rung', () => {
	assert.equal(nextLowerQuality(4000000), 2000000);
});

test('2 Mbps has no lower rung and returns 0', () => {
	assert.equal(nextLowerQuality(2000000), 0);
	assert.equal(nextLowerQuality(2000000, null, 8000000), 0);
});

test('a result never reaches the effective ceiling', () => {
	const currents = [0, -1, 2000000, 4000000, 8000000, 20000000, 80000000, 120000000];
	const negotiated = [0, 2000000, 4000000, 8000000, 20000000, 80000000];
	for (const current of currents) for (const ceiling of negotiated) {
		const effective = current > 0 ? current : (ceiling > 0 ? ceiling : 8000000);
		const result = nextLowerQuality(current, null, ceiling);
		assert.ok(result === 0 || result < effective,
			`nextLowerQuality(${current}, null, ${ceiling}) = ${result} must be below ${effective}`);
	}
});

test('web app stores the negotiated quality from the play response', () => {
	const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
	assert.match(app, /state\.playbackQuality = Number\(playback\.quality\) \|\| 0;/);
	assert.match(app, /playbackQuality: 0/);
});

test('web app passes the negotiated ceiling to both trouble actions', () => {
	const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
	assert.match(app, /nextLowerQuality\(Number\(quality\.value\), null, state\.playbackQuality\)/g);
	const matches = app.match(/nextLowerQuality\(Number\(quality\.value\), null, state\.playbackQuality\)/g);
	assert.equal(matches.length, 2, 'lowerQualityFromTrouble and updateTroubleLowerAction both pass the ceiling');
});

test('web quality select gains an honest 2 Mbps option and keeps Auto first', () => {
	const html = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
	const select = html.match(/<select id="quality">([^<]*(?:<option[^>]*>[^<]*<\/option>)*[^<]*)<\/select>/);
	assert.ok(select, 'quality select found');
	assert.ok(select[0].indexOf('<option value="20000000">Auto · up to 20 Mbps</option>') === select[0].indexOf('<option'),
		'Auto remains the default (first) option');
	assert.match(select[0], /<option value="2000000">Lightest · up to 2 Mbps<\/option>/);
});
