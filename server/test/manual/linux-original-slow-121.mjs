// Targeted Linux acceptance for the ORIGINAL 180 s 1080p HEVC slow case.
// Fixture generation/validation must already be done by prepare-original-slow-121.mjs
// outside this playback timer. This reconstructs the original PRIMARY-passing
// 6E369BDF... slow case: 0.72x input, far segment 28, then 29 and the next
// window 30/31, with phase timestamps and range/producer diagnostics.
import assert from 'node:assert/strict';
import {readFile, readdir, rm, stat} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createVodPlayer} from '../../vod-player.mjs';
import {fixtureRoot, loadBytes, rangeOpener} from '../consolidation-121-vod-fixture.mjs';

const started = Date.now();
const phase = (name, extra = {}) => console.log(JSON.stringify({phase: name, t: Date.now() - started, ...extra}));
const wrapper = setTimeout(() => {
	console.error(JSON.stringify({phase: 'wrapper-timeout', t: Date.now() - started}));
	process.exit(3);
}, 600000);

const fixture = {file: path.join(fixtureRoot(), 'hevc-1080p25-180s', 'source-hevc-1080p25-srt.mkv')};
const info = await stat(fixture.file).catch(() => null);
if (!info || info.size < 1000000) {
	console.error(JSON.stringify({phase: 'fixture-missing', file: fixture.file, instruction: 'run prepare-original-slow-121.mjs outside the playback timer'}));
	clearTimeout(wrapper);
	process.exit(2);
}
phase('fixture-ready', {file: fixture.file, bytes: info.size, fixtureRoot: process.env.TELLYBOX_VOD_FIXTURE_ROOT || '(default)'});
const bytes = await readFile(fixture.file);
const sourceBps = bytes.length / 180;
const throttleBps = Math.round(sourceBps * 0.72);
const ranges = [];
const before = new Set((await readdir(os.tmpdir())).filter(name => name.startsWith('tellybox-vod-')));
const errors = [], originalError = console.error;
console.error = (...args) => { errors.push(args.map(String).join(' ')); };
const player = createVodPlayer({open: rangeOpener(bytes, {throttleBps, onRequest: r => ranges.push({first: r.first, bytes: r.size, t: Date.now() - started})})});
const result = {source: 'server/vod-player.mjs', fixture: {file: fixture.file, bytes: info.size}, throttleBps, phases: [], checks: [], pass: false};
const session = await player.start({type: 'episode', uuid: 'original-slow-hevc'});
phase('player-start', session.producer());
result.phases.push({name: 'player-start', t: Date.now() - started});
let folder = '';
try {
	const first = await session.read('segment000000000.ts');
	phase('first-segment', {bytes: first.length, producer: session.producer()});
	result.phases.push({name: 'first-segment', t: Date.now() - started});
	folder = (await readdir(os.tmpdir())).filter(name => name.startsWith('tellybox-vod-') && !before.has(name)).sort().at(-1) || '';
	const progress = [];
	const sampler = setInterval(() => progress.push(session.producer().produced), 2000).unref();
	const farStarted = Date.now();
	const far = await session.read('segment000000028.ts');
	clearInterval(sampler);
	const farMs = Date.now() - farStarted;
	phase('far-28', {ms: farMs, bytes: far.length, producer: session.producer()});
	result.farMs = farMs;
	result.progress = progress;
	const monotonic = progress.every((v, i) => i === 0 || v >= progress[i - 1]);
	result.checks.push({name: 'far segment 28 waits beyond the old 45 s deadline', pass: farMs > 45000, farMs});
	result.checks.push({name: 'far segment 28 stays under the 240 s hard cap', pass: farMs < 240000, farMs});
	result.checks.push({name: 'progress never regresses', pass: monotonic, samples: progress});
	result.checks.push({name: 'producer reached segment 28', pass: session.producer().produced >= 28, produced: session.producer().produced});
	result.checks.push({name: 'no false vod_producer_stall', pass: !errors.some(line => line.includes('vod_producer_stall')), errors});
	await session.read('segment000000029.ts');
	phase('segment-29', session.producer());
	for (let wait = 0; wait < 300; wait++) {
		if (session.producer().windowStart >= 30) break;
		await new Promise(r => setTimeout(r, 100));
	}
	assert.ok(session.producer().windowStart >= 30, 'window 30 must be prefetched after the slow first window');
	phase('window-30-start', session.producer());
	const s30 = await session.read('segment000000030.ts');
	const s31 = await session.read('segment000000031.ts');
	phase('segments-30-31', {s30: s30.length, s31: s31.length, producer: session.producer()});
	result.checks.push({name: 'next window 30/31 is produced and served', pass: s30.length > 1000 && s31.length > 1000, producer: session.producer()});
	result.checks.push({name: 'prune did not delete the next window', pass: session.producer().windowStart >= 30, windowStart: session.producer().windowStart});
	result.pass = result.checks.every(c => c.pass);
} catch (error) {
	result.error = String(error && error.message || error);
	phase('failure', {error: result.error, producer: session.producer()});
	if (folder) {
		try { result.tempFiles = (await readdir(folder)).map(name => name); } catch {}
	}
} finally {
	await session.stop().catch(() => {});
	console.error = originalError;
	clearTimeout(wrapper);
	if (folder) {
		try { result.tempRemoved = !(await readdir(os.tmpdir())).includes(folder); } catch {}
	}
}
result.phases.push({name: 'stop', t: Date.now() - started});
result.ranges = {count: ranges.length, minFirst: Math.min(...ranges.map(r => r.first)), maxFirst: Math.max(...ranges.map(r => r.first)), totalBytes: ranges.reduce((sum, r) => sum + r.bytes, 0)};
console.log(JSON.stringify(result, null, 2));
if (!result.pass) process.exitCode = 1;
