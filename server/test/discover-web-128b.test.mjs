/* Release 128B owner D2: Discover shelf loading.
 *
 * These are structural checks against public/discover.js plus a small
 * behavioural sandbox for the new worker pool and the AbortSignal-aware
 * `api` helper. No server and no browser is needed. Browser acceptance is
 * still owner C's; nothing here proves the rendered result.
 *
 * Covered:
 *  - Provider shelves get every holder up front, in provider order.
 *  - Shelves load through a pool of at most 3 workers, never a serial
 *    `for ... await`.
 *  - A slow first shelf does not block later shelves from starting/finishing.
 *  - A generation change (mode switch) stops further shelf jobs and aborts
 *    in-flight requests.
 *  - Per-shelf error/retry UI is kept, and retries stay on the same shelf.
 *  - Trending chart rows use the same bounded limiter and keep row order.
 *  - The personalised for-you POST, handoff and detail behaviour is unchanged.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const discoverJs = readFileSync(fileURLToPath(new URL('../public/discover.js', import.meta.url)), 'utf8');

function section(startMarker, endMarker = null) {
	const start = discoverJs.indexOf(startMarker);
	assert.notEqual(start, -1, 'missing marker: ' + startMarker);
	const end = endMarker === null ? discoverJs.length : discoverJs.indexOf(endMarker, start);
	assert.notEqual(end, -1, 'missing end marker: ' + endMarker);
	return discoverJs.slice(start, end);
}

const shelfLoaderSource = section('const shelfConcurrency = 3;', '// Cross-document handoff state.');
const apiSource = section('async function api(route, body, options = {}) {', '// Shelves (discover services and charts)');
const loadFeedsSource = section('async function loadFeeds() {', 'async function loadProviderShelf(provider,holder,generation,note) {');
const providerShelfSource = section('async function loadProviderShelf(provider,holder,generation,note) {', 'function openProvider(provider,note) {');
const switchModeSource = section('function switchMode(mode) {', 'async function showDetails(');
const loadTrendingSource = section("async function loadTrending(groupId='highlights',onlyGroup=false) {");

const tick = () => new Promise(resolve => setImmediate(resolve));

function shelfSandbox(generation = 1) {
	const factory = new Function('state', 'AbortController',
		shelfLoaderSource + '\nreturn { shelfConcurrency, shelfPool, startShelves, stopShelves, shelfSignal };');
	const state = { generation };
	return { state, ...factory(state, AbortController) };
}

function apiSandbox() {
	const calls = [];
	const fetch = async (route, init) => {
		if (init && init.signal && init.signal.aborted) {
			const error = new Error('The operation was aborted.');
			error.name = 'AbortError';
			throw error;
		}
		calls.push({ route, init });
		return { status: 200, ok: true, json: async () => ({ ok: true }) };
	};
	const factory = new Function('fetch', 'location', apiSource + '\nreturn api;');
	return { calls, api: factory(fetch, { assign() {} }) };
}

test('shelfPool starts at most three jobs, in order, and lets later shelves finish first', async () => {
	const sandbox = shelfSandbox(1);
	assert.equal(sandbox.shelfConcurrency, 3);
	let inFlight = 0, peak = 0;
	const started = [], finished = [], gates = [];
	const jobs = Array.from({ length: 5 }, (_, index) => async () => {
		started.push(index);
		inFlight += 1;
		peak = Math.max(peak, inFlight);
		await new Promise(resolve => gates.push({ index, resolve }));
		inFlight -= 1;
		finished.push(index);
	});
	const pending = sandbox.shelfPool(1, jobs);
	await tick();
	assert.deepEqual(started, [0, 1, 2], 'only the first three jobs start');
	assert.equal(peak, 3, 'the pool never exceeds three concurrent requests');
	assert.deepEqual(finished, []);

	const release = index => gates.find(gate => gate.index === index).resolve();
	release(1); release(2);
	await tick();
	assert.deepEqual(started, [0, 1, 2, 3, 4], 'freed workers pick up the remaining shelves');
	assert.deepEqual(finished, [1, 2], 'later shelves are not blocked by the slow first job');
	assert.equal(peak, 3);

	release(3); release(4);
	await tick();
	assert.deepEqual(finished, [1, 2, 3, 4], 'shelves 2-5 settle while shelf 1 is still pending');
	release(0);
	await pending;
	assert.deepEqual(finished, [1, 2, 3, 4, 0], 'the slow shelf keeps its position and settles last');
	assert.equal(peak, 3);
});

test('a generation change prevents the pool from starting later shelf jobs', async () => {
	const sandbox = shelfSandbox(1);
	const started = [], gates = [];
	const jobs = Array.from({ length: 5 }, (_, index) => async () => {
		started.push(index);
		await new Promise(resolve => gates.push({ index, resolve }));
	});
	const pending = sandbox.shelfPool(1, jobs);
	await tick();
	assert.deepEqual(started, [0, 1, 2]);
	sandbox.state.generation += 1;
	for (const gate of gates.slice()) gate.resolve();
	await pending;
	await tick();
	assert.deepEqual(started, [0, 1, 2], 'no further shelf starts once the generation changed');
});

test('stopShelves aborts in-flight shelf requests and clears the signal', () => {
	const sandbox = shelfSandbox(1);
	const signal = sandbox.startShelves();
	assert.equal(sandbox.shelfSignal(), signal);
	assert.equal(signal.aborted, false);
	sandbox.stopShelves();
	assert.equal(signal.aborted, true, 'mode changes abort requests already on the wire');
	assert.equal(sandbox.shelfSignal(), undefined);
});

test('api forwards an AbortSignal without changing existing two-argument calls', async () => {
	const sandbox = apiSandbox();
	const controller = new AbortController();
	assert.deepEqual(await sandbox.api('/api/discover/provider/8', undefined, { signal: controller.signal }), { ok: true });
	assert.equal(sandbox.calls[0].init.signal, controller.signal);

	await sandbox.api('/api/discover/options');
	assert.deepEqual(sandbox.calls[1].init, {}, 'a plain GET still sends an empty init');

	await sandbox.api('/api/discover/for-you', { genres: [] });
	assert.equal(sandbox.calls[2].init.method, 'POST');
	assert.equal(sandbox.calls[2].init.body, JSON.stringify({ genres: [] }));

	controller.abort();
	await assert.rejects(
		() => sandbox.api('/api/discover/provider/8', undefined, { signal: controller.signal }),
		error => error.name === 'AbortError'
	);
});

test('provider shelves create every holder in order before the pool starts', () => {
	assert.match(loadFeedsSource, /const jobs=options\.providers\.map\(provider=>\{/);
	assert.match(loadFeedsSource, /parent\.append\(holder\)/);
	assert.match(loadFeedsSource, /await shelfPool\(generation,jobs\)/);
	const mapStart = loadFeedsSource.indexOf('const jobs=options.providers.map(provider=>{');
	const append = loadFeedsSource.indexOf('parent.append(holder)', mapStart);
	const jobReturn = loadFeedsSource.indexOf('return()=>loadProviderShelf', mapStart);
	const pool = loadFeedsSource.indexOf('shelfPool(generation,jobs)');
	assert.ok(mapStart >= 0 && append > mapStart, 'the holder is appended inside the ordered map');
	assert.ok(jobReturn > append, 'the holder exists before the job is returned to the pool');
	assert.ok(pool > jobReturn, 'every holder is staged before the pool is awaited');
	assert.doesNotMatch(loadFeedsSource, /\.sort\(|\.reverse\(/, 'provider order is never rearranged');
});

test('provider shelves never fall back to a serial for-await loop', () => {
	assert.doesNotMatch(loadFeedsSource, /for\s*\(const provider of options\.providers\)/);
	assert.doesNotMatch(loadFeedsSource, /await\s+api\('\/api\/discover\/provider\//, 'the ordered holder loop never awaits a provider');
	assert.doesNotMatch(loadFeedsSource, /for\s*\([^)]*\)\s*\{[^}]*await\s+api\(/s, 'no serial await inside a loop');
	assert.match(providerShelfSource, /await api\('\/api\/discover\/provider\/'\+provider\.id,undefined,\{signal:shelfSignal\(\)\}\)/);
});

test('a shelf failure keeps its own retry and does not reset the other shelves', () => {
	assert.match(providerShelfSource, /holder\.replaceChildren\(node\('p',provider\.name\+': '\+error\.message,'status'\)\)/);
	assert.match(providerShelfSource, /const retry=node\('button','Try again','button quiet'\)/);
	assert.match(providerShelfSource, /retry\.onclick=\(\)=>\{void loadProviderShelf\(provider,holder,state\.generation,note\);\}/);
	assert.doesNotMatch(providerShelfSource, /switchMode\('services'\)/, 'retry loads only the failed shelf');
	const generationChecks = providerShelfSource.match(/generation!==state\.generation/g) || [];
	assert.ok(generationChecks.length >= 2, 'both before and after the request the shelf checks its generation');
	assert.match(providerShelfSource, /error\.name==='AbortError'/);
});

test('switching mode cancels shelf loading before the new view starts', () => {
	const stop = switchModeSource.indexOf('stopShelves();');
	const assign = switchModeSource.indexOf('state.mode = mode;');
	assert.ok(stop >= 0 && stop < assign, 'cancellation happens before the mode is changed');
	assert.match(switchModeSource, /if \(mode === 'for-you' \|\| mode === 'services'\)/);
	assert.match(switchModeSource, /return loadFeeds\(\)/);
	assert.match(switchModeSource, /return loadTrending\(\)/);
});

test('for-you keeps its single personalised POST and renders sections in order', () => {
	assert.match(loadFeedsSource, /api\('\/api\/discover\/for-you',TellyboxTaste\.payload\(\),\{signal:shelfSignal\(\)\}\)/);
	assert.match(loadFeedsSource, /for\(const section of data\.sections\) if\(section\.items\.length\) shelf\(section\.title,section\.items,parent\)/);
	assert.doesNotMatch(loadFeedsSource, /data\.sections\.(?:sort|reverse)\(/);
	assert.match(loadFeedsSource, /data\.partial \? 'Some suggestions are temporarily unavailable\. Here’s what we found\.'/);
	assert.match(loadFeedsSource, /No fresh matches yet\./);
});

test('trending rows use the same bounded limiter and keep chart order', () => {
	assert.match(loadTrendingSource, /startShelves\(\)/);
	assert.match(loadTrendingSource, /const jobs=group\.rows\.map\(key=>\{const holder=node\('section',undefined,'trending-section'\);parent\.append\(holder\);return\(\)=>row\(key,holder,generation\);\}\)/);
	assert.match(loadTrendingSource, /await shelfPool\(generation,jobs\)/);
	assert.doesNotMatch(loadTrendingSource, /void row\(key,holder\)/, 'rows no longer launch outside the limiter');
	assert.match(loadTrendingSource, /api\('\/api\/discover\/trending\/'\+key,undefined,\{signal:shelfSignal\(\)\}\)/);
	assert.match(loadTrendingSource, /retry\.onclick=\(\)=>\{void row\(key,holder,generation\);\}/);
	assert.match(loadTrendingSource, /error\.name==='AbortError'/);
});

test('handoff and detail behaviour is untouched', () => {
	for (const marker of [
		'function saveHandoffState() {',
		'function takeHandoffState() {',
		'async function restoreHandoffState(restored) {',
		'async function showDetails(type, id) {',
		"if (restored.detailType === 'movie' || restored.detailType === 'tv') {",
	]) {
		assert.ok(discoverJs.includes(marker), 'missing preserved marker: ' + marker);
	}
	assert.match(discoverJs, /stream\.href='\/\?item='\+encodeURIComponent\(item\.vodId\)\+'&from=discover'/);
	assert.match(discoverJs, /link\.href = '\/\?item=' \+ encodeURIComponent\(item\.watchId\) \+ '&from=discover'/);
});
