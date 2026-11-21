import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { defaultConfig, materialize } from '../homelab/config.mjs';
import { createSetup } from '../homelab/admin.mjs';
import { catalogueCacheDirectory } from '../homelab/dispatcharr-status.mjs';

const PASSWORD = 'test-only-password-1234';
const BASE_TIME = 1763450000000;
const TOP_KEYS = ['configured', 'enabled', 'source', 'state', 'reachable', 'checkedAt', 'stale', 'notice', 'stats', 'catalogue', 'guide'].sort();
const STAT_KEYS = ['liveChannels', 'liveChannelsAt', 'vodConnections', 'vodConnectionsAt', 'catchupConnections', 'catchupConnectionsAt'].sort();
const CATALOGUE_KEYS = ['available', 'count', 'lastRefresh', 'indexing', 'error'].sort();
const GUIDE_KEYS = ['available', 'fetchedAt', 'channels', 'withListings'].sort();
const HEALTHY = {
	live: { channels: 12, count: 99, timestamp: '2026-11-18T10:00:00.000Z' },
	vod: { vod_connections: 3, total_connections: 7, timestamp: 1763450100 },
	catchup: { timeshift_sessions: 2, total_connections: 5, timestamp: 1763450200 }
};

function directory(t) { const dir = mkdtempSync(path.join(tmpdir(), 'tellybox-dispatcharr-status-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; }

function dispatcharrConfig(overrides = {}) {
	const config = defaultConfig();
	config.network.publicOrigin = 'https://tellybox.example';
	config.services.dispatcharr = {
		enabled: true, location: 'anotherServer', url: 'http://dispatcharr.invalid:9191',
		key: 'test-only-key', live: true, vod: true, catchup: true, ...overrides
	};
	return config;
}

function seedConfig(dir, config) { writeFileSync(path.join(dir, 'configuration.json'), JSON.stringify(config, null, '\t')); }

function json(value, status = 200) { return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } }); }

function recorder(handler) {
	const calls = [];
	return {
		calls,
		fetcher: async (url, options) => { calls.push({ url: String(url), options }); return handler(url, options, calls.length); }
	};
}

async function fixture(t, { fetcher = async () => json(HEALTHY), clock = Date.now, seed } = {}) {
	const dir = directory(t);
	if (seed) seed(dir);
	const setup = createSetup({ directory: dir, fetcher, clock, apply: async () => {} });
	const server = setup.app.listen(0, '127.0.0.1');
	await once(server, 'listening');
	t.after(() => server.close());
	const base = 'http://127.0.0.1:' + server.address().port;
	const raw = (route, { method = 'GET', body, headers = {} } = {}) => fetch(base + '/api/setup/' + route, {
		method,
		headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json', Origin: base }), ...headers },
		body: body === undefined ? undefined : JSON.stringify(body)
	});
	const login = async () => {
		const response = await raw('login', { method: 'POST', body: { bootstrap: JSON.parse(readFileSync(path.join(dir, 'bootstrap.json'), 'utf8')).token, password: PASSWORD } });
		assert.equal(response.status, 200);
		return { Cookie: response.headers.get('set-cookie').split(';')[0] };
	};
	const save = async (headers, config) => {
		const response = await raw('config', { method: 'POST', headers, body: { ...config, revision: setup.store.get().revision } });
		assert.equal(response.status, 200);
	};
	const status = (headers = {}, query = '') => raw('dispatcharr/status' + query, { headers });
	return { dir, base, raw, login, save, status, setup };
}

function assertShape(body) {
	assert.deepEqual(Object.keys(body).sort(), TOP_KEYS);
	assert.deepEqual(Object.keys(body.stats).sort(), STAT_KEYS);
	assert.deepEqual(Object.keys(body.catalogue).sort(), CATALOGUE_KEYS);
	assert.deepEqual(Object.keys(body.guide).sort(), GUIDE_KEYS);
}

function assertSanitized(text, extra = []) {
	for (const needle of ['test-only-key', 'rotated-key', 'worker-only-key', 'Authorization', 'X-API-Key',
		'dispatcharr.invalid', 'dispatcharr-b.invalid', '192.0.2.10', 'host.docker.internal',
		'vod_connections', 'timeshift_sessions', 'Invalid token', 'ECONNREFUSED', 'RAW-UPSTREAM-MARKER', ...extra]) {
		assert.equal(text.includes(needle), false, needle);
	}
}

test('Dispatcharr status requires the installation administrator before any cached read or upstream request', async t => {
	const { fetcher, calls } = recorder(() => json(HEALTHY));
	const f = await fixture(t, { fetcher });

	const local = await f.status();
	assert.equal(local.status, 401);
	assert.equal(calls.length, 0);

	const viewer = await f.status({ Cookie: 'tellybox_session=' + 'a'.repeat(64) });
	assert.equal(viewer.status, 401);
	assert.equal(calls.length, 0);

	const forged = await f.status({ Cookie: 'tellybox_setup=' + 'b'.repeat(64) });
	assert.equal(forged.status, 401);
	assert.equal(calls.length, 0);

	const headers = await f.login();
	await f.save(headers, dispatcharrConfig());
	const allowed = await f.status(headers);
	assert.equal(allowed.status, 200);
	assert.equal(allowed.headers.get('cache-control'), 'no-store');
	assert.equal(calls.length, 1);
});

test('healthy status returns only the allowlisted channel and connection figures', async t => {
	const { fetcher, calls } = recorder(() => json(HEALTHY));
	const f = await fixture(t, { fetcher, clock: () => BASE_TIME });
	const headers = await f.login();
	await f.save(headers, dispatcharrConfig());

	const response = await f.status(headers);
	assert.equal(response.status, 200);
	const body = await response.json();
	assertShape(body);
	assert.equal(body.configured, true);
	assert.equal(body.enabled, true);
	assert.equal(body.source, 'anotherServer');
	assert.equal(body.state, 'healthy');
	assert.equal(body.reachable, true);
	assert.equal(body.checkedAt, BASE_TIME);
	assert.equal(body.stale, false);
	assert.equal(body.notice, 'Dispatcharr answered this check.');
	assert.deepEqual(body.stats, {
		liveChannels: 12, liveChannelsAt: Date.parse('2026-11-18T10:00:00.000Z'),
		vodConnections: 3, vodConnectionsAt: 1763450100000,
		catchupConnections: 2, catchupConnectionsAt: 1763450200000
	});
	assert.deepEqual(body.catalogue, { available: false, count: null, lastRefresh: null, indexing: null, error: null });
	assert.deepEqual(body.guide, { available: false, fetchedAt: null, channels: null, withListings: null });

	const call = calls[0];
	assert.equal(call.url, 'http://dispatcharr.invalid:9191/proxy/stats/');
	assert.equal(call.options.redirect, 'error');
	assert.equal(call.options.headers['X-API-Key'], 'test-only-key');
	assert.equal(call.options.headers.Authorization, 'ApiKey test-only-key');
	assert.equal(call.options.headers.Authorization.startsWith('Bearer'), false);
	assert.ok(call.options.signal instanceof AbortSignal);

	assertSanitized(JSON.stringify(body));
});

test('local catalogue and guide caches are reported under the installation directory, and missing is unavailable rather than zero', async t => {
	const f = await fixture(t, { clock: () => BASE_TIME });
	const headers = await f.login();
	const config = dispatcharrConfig();
	await f.save(headers, config);

	const saved = f.setup.store.get();
	const env = materialize(saved, f.dir);
	assert.equal(catalogueCacheDirectory(f.dir, saved), env.CATALOGUE_CACHE_DIR);
	mkdirSync(env.CATALOGUE_CACHE_DIR, { recursive: true, mode: 0o700 });
	writeFileSync(path.join(env.CATALOGUE_CACHE_DIR, 'vod-catalogue.json'), JSON.stringify({ items: [{ Id: 'a' }, { Id: 'b' }, { Id: 'c' }], time: BASE_TIME - 5000 }));
	writeFileSync(path.join(env.CATALOGUE_CACHE_DIR, 'dispatcharr-guide.json'), JSON.stringify({
		channels: [{ programmes: [{ Name: 'One' }] }, { programmes: [] }],
		fetchedAt: BASE_TIME - 6000, available: true, stale: false
	}));

	const body = await (await f.status(headers, '?refresh=1')).json();
	assertShape(body);
	assert.deepEqual(body.catalogue, { available: true, count: 3, lastRefresh: BASE_TIME - 5000, indexing: null, error: null });
	assert.deepEqual(body.guide, { available: true, fetchedAt: BASE_TIME - 6000, channels: 2, withListings: 1 });

	const missing = await fixture(t, { clock: () => BASE_TIME });
	const missingHeaders = await missing.login();
	await missing.save(missingHeaders, dispatcharrConfig());
	const empty = await (await missing.status(missingHeaders)).json();
	assert.deepEqual(empty.catalogue, { available: false, count: null, lastRefresh: null, indexing: null, error: null });
	assert.deepEqual(empty.guide, { available: false, fetchedAt: null, channels: null, withListings: null });
});

test('auth failure, transport failure, timeout, malformed and oversized responses stay honest and sanitized', async t => {
	const cases = [
		{ name: 'auth', handler: () => json({ detail: 'Invalid token' }, 401), state: 'auth-failed', reachable: true, notice: 'Dispatcharr did not accept the saved API key.' },
		{ name: 'unreachable', handler: () => { throw Object.assign(Error('connect ECONNREFUSED http://dispatcharr.invalid:9191'), { name: 'TypeError' }); }, state: 'unreachable', reachable: false, notice: 'Dispatcharr could not be reached. Check the address from inside the Tellybox container.' },
		{ name: 'timeout', handler: () => { throw Object.assign(Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }); }, state: 'unreachable', reachable: false, notice: 'Dispatcharr did not answer within 10 seconds.' },
		{ name: 'malformed', handler: () => new Response('{"live":', { status: 200 }), state: 'invalid', reachable: true, notice: 'Dispatcharr returned an unreadable status response.' },
		{ name: 'empty', handler: () => json({}), state: 'invalid', reachable: true, notice: 'Dispatcharr returned an unreadable status response.' },
		{ name: 'schema', handler: () => json({ live: {}, vod: {} }), state: 'invalid', reachable: true, notice: 'Dispatcharr returned an unreadable status response.' },
		{ name: 'oversized', handler: () => json({ live: { channels: 1 }, pad: 'RAW-UPSTREAM-MARKER'.repeat(5000) }), state: 'invalid', reachable: true, notice: 'Dispatcharr returned an unexpectedly large status response.' }
	];
	for (const item of cases) {
		const f = await fixture(t, { fetcher: item.handler, clock: () => BASE_TIME });
		const headers = await f.login();
		await f.save(headers, dispatcharrConfig());
		const response = await f.status(headers);
		assert.equal(response.status, 200, item.name);
		const body = await response.json();
		assertShape(body);
		assert.equal(body.state, item.state, item.name);
		assert.equal(body.reachable, item.reachable, item.name);
		assert.equal(body.checkedAt, BASE_TIME, item.name);
		assert.equal(body.stale, false, item.name);
		assert.equal(body.notice, item.notice, item.name);
		assert.equal(body.stats.liveChannels, null, item.name);
		assert.equal(body.stats.vodConnections, null, item.name);
		assert.equal(body.stats.catchupConnections, null, item.name);
		assertSanitized(JSON.stringify(body));
	}
});

test('upstream failure after a healthy check preserves the last good figures with an honest stale state', async t => {
	let mode = 'healthy', now = BASE_TIME;
	const calls = [];
	const fetcher = async url => {
		calls.push(String(url));
		if (mode === 'fail') throw Object.assign(Error('connect ECONNREFUSED'), { name: 'TypeError' });
		if (mode === 'auth') return json({ detail: 'Invalid token' }, 403);
		return json(HEALTHY);
	};
	const f = await fixture(t, { fetcher, clock: () => now });
	const headers = await f.login();
	await f.save(headers, dispatcharrConfig());

	const first = await (await f.status(headers)).json();
	assert.equal(first.state, 'healthy');

	now += 20000;
	mode = 'fail';
	const stale = await (await f.status(headers)).json();
	assertShape(stale);
	assert.equal(stale.state, 'stale');
	assert.equal(stale.stale, true);
	assert.equal(stale.reachable, false);
	assert.equal(stale.checkedAt, BASE_TIME + 20000);
	assert.equal(stale.notice, 'Dispatcharr could not be reached. Check the address from inside the Tellybox container. Showing the last successful check.');
	assert.deepEqual(stale.stats, first.stats);

	now += 20000;
	mode = 'auth';
	const stillStale = await (await f.status(headers, '?refresh=1')).json();
	assert.equal(stillStale.state, 'stale');
	assert.equal(stillStale.reachable, true);
	assert.deepEqual(stillStale.stats, first.stats);
	assert.ok(stillStale.notice.startsWith('Dispatcharr did not accept the saved API key.'));
	assertSanitized(JSON.stringify(stillStale));

	now += 20000;
	mode = 'healthy';
	const recovered = await (await f.status(headers, '?refresh=1')).json();
	assert.equal(recovered.state, 'healthy');
	assert.equal(recovered.stale, false);
	assert.equal(calls.length, 4);
});

test('config and target changes invalidate cached results and discard old-generation last-good figures', async t => {
	let mode = 'a', now = BASE_TIME;
	const calls = [];
	const fetcher = async url => {
		calls.push(String(url));
		if (mode === 'fail') throw Object.assign(Error('connect ECONNREFUSED'), { name: 'TypeError' });
		return json(mode === 'b' ? { live: { channels: 21, timestamp: BASE_TIME - 1000 }, vod: {}, catchup: {} } : HEALTHY);
	};
	const f = await fixture(t, { fetcher, clock: () => now });
	const headers = await f.login();
	await f.save(headers, dispatcharrConfig());
	assert.equal((await (await f.status(headers)).json()).stats.liveChannels, 12);

	now += 20000;
	mode = 'fail';
	await f.save(headers, dispatcharrConfig({ url: 'http://dispatcharr-b.invalid:9191' }));
	const changed = await (await f.status(headers)).json();
	assert.equal(calls[1], 'http://dispatcharr-b.invalid:9191/proxy/stats/');
	assert.equal(changed.state, 'unreachable');
	assert.equal(changed.stale, false);
	assert.equal(changed.stats.liveChannels, null);
	assert.equal(changed.stats.vodConnections, null);
	assertSanitized(JSON.stringify(changed));

	mode = 'b';
	now += 20000;
	const fresh = await (await f.status(headers, '?refresh=1')).json();
	assert.equal(fresh.state, 'healthy');
	assert.equal(fresh.stats.liveChannels, 21);

	now += 20000;
	mode = 'fail';
	await f.save(headers, dispatcharrConfig({ url: 'http://dispatcharr-b.invalid:9191', key: 'rotated-key' }));
	const rotated = await (await f.status(headers)).json();
	assert.equal(rotated.state, 'unreachable');
	assert.equal(rotated.stats.liveChannels, null);
	assertSanitized(JSON.stringify(rotated));

	await f.save(headers, dispatcharrConfig({ enabled: false }));
	const before = calls.length;
	const disabled = await (await f.status(headers)).json();
	assert.equal(disabled.state, 'disabled');
	assert.equal(disabled.configured, true);
	assert.equal(disabled.source, 'disabled');
	assert.equal(calls.length, before);
	assertSanitized(JSON.stringify(disabled));
});

test('live count and connection fallbacks keep a real zero and use the aggregate timestamp when a section has none', async t => {
	const fetcher = async () => json({
		timestamp: 1763450300,
		live: { count: 9 },
		vod: { total_connections: 2 },
		catchup: { total_connections: 0 }
	});
	const f = await fixture(t, { fetcher, clock: () => BASE_TIME });
	const headers = await f.login();
	await f.save(headers, dispatcharrConfig());
	const body = await (await f.status(headers)).json();
	assert.equal(body.state, 'healthy');
	assert.deepEqual(body.stats, {
		liveChannels: 9, liveChannelsAt: 1763450300000,
		vodConnections: 2, vodConnectionsAt: 1763450300000,
		catchupConnections: 0, catchupConnectionsAt: 1763450300000
	});
});

test('manual refresh bypasses the short cache while ordinary polls reuse it', async t => {
	let live = 12, calls = 0;
	const fetcher = async () => { calls++; return json({ live: { channels: live, timestamp: BASE_TIME } }); };
	const f = await fixture(t, { fetcher, clock: () => BASE_TIME });
	const headers = await f.login();
	await f.save(headers, dispatcharrConfig());

	assert.equal((await (await f.status(headers)).json()).stats.liveChannels, 12);
	assert.equal((await (await f.status(headers)).json()).stats.liveChannels, 12);
	assert.equal(calls, 1);
	live = 15;
	assert.equal((await (await f.status(headers, '?refresh=1')).json()).stats.liveChannels, 15);
	assert.equal(calls, 2);
	assert.equal((await (await f.status(headers)).json()).stats.liveChannels, 15);
	assert.equal(calls, 2);
});

test('concurrent administrator polls share one bounded upstream check', async t => {
	let release;
	const gate = new Promise(resolve => { release = resolve; });
	let calls = 0;
	const fetcher = async () => { calls++; await gate; return json(HEALTHY); };
	const f = await fixture(t, { fetcher, clock: () => BASE_TIME });
	const headers = await f.login();
	await f.save(headers, dispatcharrConfig());

	const requests = Array.from({ length: 8 }, () => f.status(headers));
	for (let i = 0; i < 200 && calls < 1; i++) await new Promise(resolve => setTimeout(resolve, 5));
	assert.equal(calls, 1);
	release();
	const responses = await Promise.all(requests);
	assert.equal(calls, 1);
	const bodies = await Promise.all(responses.map(response => response.json()));
	for (const body of bodies) {
		assert.equal(responseOk(body), true);
		assert.deepEqual(body, bodies[0]);
	}
});

function responseOk(body) { return body.state === 'healthy' && body.stats.liveChannels === 12; }

test('disabled, unconfigured and keyless Dispatcharr settings are distinct and never fetch', async t => {
	const disabled = await fixture(t, { clock: () => BASE_TIME });
	const disabledHeaders = await disabled.login();
	await disabled.save(disabledHeaders, dispatcharrConfig({ enabled: false }));
	const disabledBody = await (await disabled.status(disabledHeaders)).json();
	assertShape(disabledBody);
	assert.equal(disabledBody.enabled, false);
	assert.equal(disabledBody.configured, true);
	assert.equal(disabledBody.source, 'disabled');
	assert.equal(disabledBody.state, 'disabled');
	assert.equal(disabledBody.reachable, null);
	assert.equal(disabledBody.checkedAt, null);
	assert.deepEqual(disabledBody.stats, { liveChannels: null, liveChannelsAt: null, vodConnections: null, vodConnectionsAt: null, catchupConnections: null, catchupConnectionsAt: null });

	let unconfiguredCalls = 0;
	const unconfiguredConfig = defaultConfig();
	unconfiguredConfig.services.dispatcharr = { enabled: true, location: 'onThisServer', key: 'test-only-key', live: true };
	const unconfigured = await fixture(t, {
		clock: () => BASE_TIME,
		fetcher: async () => { unconfiguredCalls++; return json(HEALTHY); },
		seed: dir => seedConfig(dir, unconfiguredConfig)
	});
	const unconfiguredHeaders = await unconfigured.login();
	const unconfiguredBody = await (await unconfigured.status(unconfiguredHeaders)).json();
	assert.equal(unconfiguredBody.enabled, true);
	assert.equal(unconfiguredBody.configured, false);
	assert.equal(unconfiguredBody.source, 'onThisServer');
	assert.equal(unconfiguredBody.state, 'invalid');
	assert.equal(unconfiguredBody.notice, 'Dispatcharr is enabled but has no usable server address in installation settings.');
	assert.equal(unconfiguredCalls, 0);

	let keylessCalls = 0;
	const keyless = await fixture(t, {
		clock: () => BASE_TIME,
		fetcher: async () => { keylessCalls++; return json(HEALTHY); }
	});
	const keylessHeaders = await keyless.login();
	await keyless.save(keylessHeaders, dispatcharrConfig({ key: '', live: true, vod: false, catchup: false }));
	const keylessBody = await (await keyless.status(keylessHeaders)).json();
	assert.equal(keylessBody.enabled, true);
	assert.equal(keylessBody.configured, true);
	assert.equal(keylessBody.state, 'auth-failed');
	assert.equal(keylessBody.notice, 'Add a personal API key in installation settings to check Dispatcharr status.');
	assert.equal(keylessBody.stats.liveChannels, null);
	assert.equal(keylessCalls, 0);
});

test('the saved Dispatcharr source and its configured target drive the check, not a hardcoded address', async t => {
	const { fetcher, calls } = recorder(() => json(HEALTHY));
	const local = await fixture(t, { fetcher, clock: () => BASE_TIME });
	const localHeaders = await local.login();
	await local.save(localHeaders, dispatcharrConfig({ location: 'onThisServer', url: undefined }));
	const localBody = await (await local.status(localHeaders)).json();
	assert.equal(localBody.source, 'onThisServer');
	assert.equal(calls[0].url, 'http://host.docker.internal:9191/proxy/stats/');

	const relayConfig = defaultConfig();
	relayConfig.network.publicOrigin = 'https://tellybox.example';
	relayConfig.services.dispatcharr = {
		enabled: true, location: 'relay', url: 'http://192.0.2.10:9191', relayMetadataUrl: 'http://192.0.2.10:9191',
		relayUrl: 'http://host.containers.internal:9191', relayKey: 'worker-only-key', key: 'test-only-key', live: true
	};
	const relay = await fixture(t, { fetcher, clock: () => BASE_TIME, seed: dir => seedConfig(dir, relayConfig) });
	const relayHeaders = await relay.login();
	const relayBody = await (await relay.status(relayHeaders)).json();
	assert.equal(relayBody.source, 'relay');
	assert.equal(calls.at(-1).url, 'http://192.0.2.10:9191/proxy/stats/');
	assertSanitized(JSON.stringify(relayBody));
});
