import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { createWorkerUpstream } from '../../relay/worker/upstream.mjs';
import { createRelayWorker } from '../../relay/worker/worker.mjs';

const origin = 'http://dispatcharr.example.test:9191';
const key = 'synthetic-worker-key';

const client = (fetcher, options = {}) => createWorkerUpstream({ origin, key, fetcher, ...options });
const body = (payload, status = 200, type = 'application/json') =>
	async () => new Response(typeof payload === 'string' ? payload : JSON.stringify(payload), { status, headers: { 'content-type': type } });
async function waitFor(predicate, timeout = 8000) {
	const deadline = Date.now() + timeout;
	while (Date.now() < deadline) {
		if (predicate()) return;
		await new Promise(resolve => setTimeout(resolve, 20));
	}
	throw Error('Timed out waiting for the worker health check.');
}
function workerFixture(upstream) {
	let now = 1_000_000;
	const main = generateKeyPairSync('ed25519'), worker = generateKeyPairSync('ed25519');
	const w = createRelayWorker({ workerId: 'relay-worker-113', version: 'test-113', mainControlPublicKey: main.publicKey, mainMediaPublicKey: main.publicKey,
		workerPrivateKey: worker.privateKey, players: { start: async () => { throw Error('No players are needed for a health check.'); } },
		upstream, clock: () => now, maxSessions: 1, heartbeatEnabled: false, dataDirectory: '' });
	return { w, advance: seconds => { now += seconds * 1000; } };
}

test('health reads one catalogue row from the same origin with the worker credential', async () => {
	const calls = [];
	const upstream = client(async (url, options) => { calls.push({ url: String(url), options }); return Response.json([]); });
	assert.equal(await upstream.health(), true);
	assert.equal(calls.length, 1);
	const url = new URL(calls[0].url);
	assert.equal(url.origin, origin);
	assert.equal(url.pathname, '/api/channels/channels/');
	assert.equal(url.search, '?page_size=1');
	assert.equal(calls[0].options.headers['X-API-Key'], key);
	assert.equal(calls[0].options.headers.Authorization, 'ApiKey ' + key);
	assert.equal(calls[0].options.redirect, 'error');
	assert.ok(calls[0].options.signal instanceof AbortSignal, 'a timeout signal is supplied');
	assert.equal(calls[0].options.signal.aborted, false);
	assert.ok(!calls.some(call => call.url.includes('/output/m3u')), 'health never fetches the full playlist');
});

test('health accepts a bare JSON array or a paginated results envelope', async () => {
	for (const payload of [[], { results: [] }, { count: 1, next: null, results: [{ id: 1, name: 'Channel' }] }]) {
		const calls = [];
		const upstream = client(async url => { calls.push(String(url)); return Response.json(payload); });
		assert.equal(await upstream.health(), true, JSON.stringify(payload));
		assert.equal(calls.length, 1);
		assert.equal(new URL(calls[0]).pathname, '/api/channels/channels/');
	}
});

test('health refuses a rejected worker credential', async () => {
	for (const status of [401, 403]) {
		const upstream = client(body({ detail: 'Invalid token.' }, status));
		await assert.rejects(() => upstream.health(), error => error.status === 503 && /credential was refused/.test(error.message), String(status));
	}
});

test('health reports an unavailable Dispatcharr on server errors', async () => {
	for (const status of [500, 502, 503, 504]) {
		const upstream = client(body({ detail: 'Server error.' }, status));
		await assert.rejects(() => upstream.health(), error => error.status === 502 && /unavailable/.test(error.message), String(status));
	}
});

test('health treats an abort as unhealthy and keeps the five second timeout', async () => {
	const controller = new AbortController(), signals = [];
	const upstream = client((url, options) => {
		signals.push(options.signal);
		return new Promise((resolve, reject) => {
			const stop = () => reject(options.signal.reason || Object.assign(Error('This operation was aborted'), { name: 'AbortError' }));
			if (options.signal.aborted) stop(); else options.signal.addEventListener('abort', stop, { once: true });
		});
	});
	const rejected = assert.rejects(() => upstream.health(controller.signal), /aborted/);
	controller.abort(Object.assign(Error('aborted by test'), { name: 'AbortError' }));
	await rejected;
	assert.equal(signals[0], controller.signal, 'the caller signal is forwarded to the upstream fetch');

	const original = AbortSignal.timeout;
	let timeoutMs;
	AbortSignal.timeout = function timeout(ms) { timeoutMs = ms; return original.call(AbortSignal, ms); };
	try { assert.equal(await client(body([])).health(), true); } finally { AbortSignal.timeout = original; }
	assert.equal(timeoutMs, 5000, 'the readiness check keeps the five second timeout');
});

test('health rejects HTML, malformed JSON and unexpected JSON shapes', async () => {
	const html = client(body('<!doctype html><html><title>Login</title></html>', 200, 'text/html'));
	await assert.rejects(() => html.health(), error => error.status === 502 && /unexpected readiness response/.test(error.message));
	for (const payload of [{}, { results: {} }, { results: null }, { list: [] }, 42, null]) {
		const upstream = client(body(payload));
		await assert.rejects(() => upstream.health(), error => error.status === 502 && /unexpected readiness response/.test(error.message), JSON.stringify(payload));
	}
	let cancelled = 0;
	const stub = json => ({ ok: true, json, body: { cancel: async () => { cancelled++; } } });
	assert.equal(await client(async () => stub(async () => [])).health(), true);
	await assert.rejects(() => client(async () => stub(async () => { throw SyntaxError('Unexpected token <'); })).health(), /unexpected readiness response/);
	assert.equal(cancelled, 2, 'the readiness body is always cancelled');
});

test('the worker caches upstream health for thirty seconds and retries after the interval', { timeout: 30000 }, async t => {
	let down = false, calls = 0;
	const f = workerFixture({ health: async () => { calls++; return down ? Promise.reject(Error('Dispatcharr is unavailable to the relay worker.')) : true; } });
	t.after(async () => { await f.w.close(); });
	f.w.start();
	await waitFor(() => calls === 1);
	await waitFor(() => f.w.status().upstreamHealthy === true);
	f.advance(29);
	await new Promise(resolve => setTimeout(resolve, 1500));
	assert.equal(calls, 1, 'a check younger than thirty seconds is reused');

	down = true;
	f.advance(2);
	await waitFor(() => calls === 2);
	await waitFor(() => f.w.status().upstreamHealthy === false);

	down = false;
	f.advance(31);
	await waitFor(() => calls === 3);
	await waitFor(() => f.w.status().upstreamHealthy === true, 4000);
	assert.equal(calls, 3);
});

test('a refused upstream credential makes the worker report unhealthy', { timeout: 30000 }, async t => {
	let requests = 0;
	const upstream = client(async () => { requests++; return new Response('{"detail":"Invalid token."}', { status: 401, headers: { 'content-type': 'application/json' } }); });
	const f = workerFixture(upstream);
	t.after(async () => { await f.w.close(); });
	assert.equal(f.w.status().upstreamHealthy, true, 'a worker starts optimistic before its first check');
	f.w.start();
	await waitFor(() => requests === 1);
	await waitFor(() => f.w.status().upstreamHealthy === false);
	assert.equal(f.w.status().upstreamHealthy, false);
});
