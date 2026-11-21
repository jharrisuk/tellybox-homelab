/* Release 137: read-only qBittorrent statistics for the trusted local panel.
 *
 * The summary carries bounded counts and transfer speeds only. Torrent names,
 * hashes, categories, save paths and every saved credential stay on the
 * server, and the route refuses a remote caller before it touches qBittorrent.
 * All fixtures here are synthetic; no real service or credential is used.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { installAuth } from '../auth.mjs';
import { createHomeNetwork } from '../home-network.mjs';
import { createQbittorrent, installQbittorrentRoutes } from '../qbittorrent.mjs';

const UPSTREAM_USER = 'synthetic-webui-user';
const UPSTREAM_PASSWORD = 'synthetic-webui-secret';
const CATEGORY = 'Synthetic Category Alpha';
const SAVE_PATH = '/srv/synthetic-private-save';
const STEM = 'Synthetic Stalled Delta';

const TORRENTS = [
	{
		hash: '1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d',
		name: 'Synthetic Download Alpha', state: 'downloading', progress: 0.25
	},
	{
		hash: '2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e',
		name: 'Synthetic Seeding Beta', state: 'uploading', progress: 1
	},
	{
		hash: '3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f',
		name: 'Synthetic Queued Gamma', state: 'queuedDL', progress: 0
	},
	{
		hash: '4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f70',
		name: STEM, state: 'stalledDL', progress: 0.25
	}
];

const SECRETS = [
	...TORRENTS.map(item => item.name),
	...TORRENTS.map(item => item.hash),
	...TORRENTS.map(item => item.hash.slice(0, 8)),
	CATEGORY,
	SAVE_PATH,
	UPSTREAM_USER,
	UPSTREAM_PASSWORD
];

const SUMMARY_KEYS = [
	'readOnly', 'generatedAt', 'configured', 'enabled', 'state', 'reachable',
	'stale', 'checkedAt', 'sampleSize', 'hasMore', 'counts', 'countsLowerBound', 'transfer'
].sort();

const FORBIDDEN_KEYS = new Set([
	'rows', 'name', 'hash', 'displayHash', 'category', 'filters', 'page',
	'webapiVersion', 'applicationVersion', 'pollSeconds', 'stalledMinutes',
	'generation', 'url', 'username', 'password'
]);

function temporaryDirectory(t, prefix) {
	const directory = mkdtempSync(path.join(tmpdir(), prefix));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	return directory;
}

function configFor(base, overrides = {}) {
	return {
		url: base + '/', username: UPSTREAM_USER, password: UPSTREAM_PASSWORD,
		enabled: true, pollSeconds: 20, stalledMinutes: 30, ...overrides
	};
}

function allKeys(value, found = new Set()) {
	if (!value || typeof value !== 'object') return found;
	for (const [key, child] of Object.entries(value)) {
		found.add(key);
		allKeys(child, found);
	}
	return found;
}

function assertSanitized(body, extra = []) {
	const text = JSON.stringify(body);
	for (const secret of [...SECRETS, ...extra]) {
		assert.equal(text.includes(secret), false, 'the summary must not contain ' + secret);
	}
	for (const key of allKeys(body)) {
		assert.equal(FORBIDDEN_KEYS.has(key), false, 'the summary must not expose a ' + key + ' key');
	}
}

function torrentRow(item, completed) {
	return {
		hash: item.hash, name: item.name, state: item.state, progress: item.progress,
		completed: completed ?? Math.round(item.progress * 1000), size: 1000, total_size: 1200,
		dlspeed: 1000, upspeed: 20, eta: 300, category: CATEGORY,
		num_seeds: 1, num_complete: 2, num_leechs: 0, num_incomplete: 1,
		added_on: 1700000000, last_activity: 1700000100
	};
}

/* A local stand-in for the qBittorrent WebUI. It records every request so the
 * tests can prove that a disabled, unconfigured or denied caller made none. */
async function startUpstream(t) {
	const state = { requests: [], infoReads: 0 };
	const server = http.createServer(async (req, res) => {
		const chunks = [];
		for await (const chunk of req) chunks.push(chunk);
		const url = new URL(req.url, 'http://127.0.0.1');
		state.requests.push({ method: req.method, path: url.pathname, url: req.url });
		const text = (status, value, headers = {}) => {
			res.writeHead(status, { 'content-type': 'text/plain', ...headers });
			res.end(value);
		};
		const json = (status, value) => {
			res.writeHead(status, { 'content-type': 'application/json' });
			res.end(JSON.stringify(value));
		};
		if (url.pathname === '/api/v2/auth/login') {
			return text(200, 'Ok.', { 'set-cookie': 'SID=synthetic-sid; path=/' });
		}
		if (req.headers.cookie !== 'SID=synthetic-sid') return text(401, '');
		if (url.pathname === '/api/v2/app/webapiVersion') return text(200, '2.11.2');
		if (url.pathname === '/api/v2/app/version') return text(200, 'v5.0.3');
		if (url.pathname === '/api/v2/torrents/categories') {
			return json(200, { [CATEGORY]: { name: CATEGORY, savePath: SAVE_PATH } });
		}
		if (url.pathname === '/api/v2/transfer/info') {
			return json(200, { dl_info_speed: 4200000, up_info_speed: 1100000, connection_status: 'connected' });
		}
		if (url.pathname === '/api/v2/torrents/info') {
			// The plain downloading row keeps making progress, so only the
			// stalled synthetic row is ever eligible for "needs attention".
			state.infoReads += 1;
			return json(200, TORRENTS.map(item => torrentRow(item,
				item.state === 'downloading' ? 250 + state.infoReads * 100 : undefined)));
		}
		return text(404, '');
	});
	server.listen(0, '127.0.0.1');
	await once(server, 'listening');
	t.after(() => { server.closeAllConnections?.(); server.close(); });
	return { base: 'http://127.0.0.1:' + server.address().port, state };
}

test('the summary reports bounded counts and never leaks torrent or configuration data', async t => {
	const directory = temporaryDirectory(t, 'tellybox-qb-summary-137-');
	const upstream = await startUpstream(t);
	const file = path.join(directory, 'qbittorrent.json');
	writeFileSync(file, JSON.stringify(configFor(upstream.base)));

	let now = 1700000000000;
	const qb = createQbittorrent({ file, clock: () => now });

	// The first read establishes the progress sample. Attention is only claimed
	// after a period without progress, so advance a fixed clock past the
	// configured 30 minutes instead of waiting.
	const first = await qb.summary();
	assert.equal(first.state, 'ok');
	assert.equal(first.sampleSize, 4, 'every synthetic torrent is sampled');
	assert.equal(first.hasMore, false);

	now += 31 * 60 * 1000;
	const body = await qb.summary();

	assert.deepEqual(Object.keys(body).sort(), SUMMARY_KEYS, 'the summary has exactly the documented top-level fields');
	assert.equal(body.readOnly, true);
	assert.equal(body.generatedAt, now);
	assert.equal(body.configured, true);
	assert.equal(body.enabled, true);
	assert.equal(body.state, 'ok');
	assert.equal(body.reachable, true);
	assert.equal(body.stale, false);
	assert.equal(body.checkedAt, now);
	assert.equal(body.sampleSize, 4);
	assert.equal(body.hasMore, false);
	assert.deepEqual(body.countsLowerBound, [], 'a small queue needs no lower-bound marker');
	assert.deepEqual(body.counts, {
		downloading: 2, queued: 1, seeding: 1, paused: 0,
		checking: 0, moving: 0, attention: 1, other: 0
	});
	assert.deepEqual(body.transfer, {
		downloadSpeed: 4200000, uploadSpeed: 1100000, connection: 'connected'
	});
	assertSanitized(body, [upstream.base]);
});

test('a switched-off integration answers disabled with zero counts and makes no request', async t => {
	const directory = temporaryDirectory(t, 'tellybox-qb-disabled-137-');
	const upstream = await startUpstream(t);
	const file = path.join(directory, 'qbittorrent.json');
	writeFileSync(file, JSON.stringify(configFor(upstream.base, { enabled: false })));

	const qb = createQbittorrent({ file, clock: () => 1700000000000 });
	const body = await qb.summary();

	assert.equal(body.state, 'disabled');
	assert.equal(body.configured, true, 'the saved target still counts as configured');
	assert.equal(body.enabled, false);
	assert.equal(body.reachable, false);
	assert.equal(body.sampleSize, 0);
	assert.equal(body.transfer, null);
	assert.deepEqual(body.counts, {
		downloading: 0, queued: 0, seeding: 0, paused: 0,
		checking: 0, moving: 0, attention: 0, other: 0
	});
	assertSanitized(body, [upstream.base]);
	assert.equal(upstream.state.requests.length, 0, 'a disabled integration never opens a connection');
});

test('an unconfigured integration answers unconfigured and makes no request', async t => {
	const directory = temporaryDirectory(t, 'tellybox-qb-unconfigured-137-');
	const upstream = await startUpstream(t);

	const qb = createQbittorrent({ file: path.join(directory, 'qbittorrent.json'), clock: () => 1700000000000 });
	const body = await qb.summary();

	assert.equal(body.state, 'unconfigured');
	assert.equal(body.configured, false);
	assert.equal(body.enabled, false);
	assert.equal(body.reachable, false);
	assert.equal(body.sampleSize, 0);
	assert.equal(body.transfer, null);
	assert.deepEqual(body.counts, {
		downloading: 0, queued: 0, seeding: 0, paused: 0,
		checking: 0, moving: 0, attention: 0, other: 0
	});
	assertSanitized(body, [upstream.base]);
	assert.equal(upstream.state.requests.length, 0, 'an unconfigured integration never opens a connection');
});

test('a denied summary on a cold cache makes no qBittorrent request', { timeout: 45000 }, async t => {
	const qbDirectory = temporaryDirectory(t, 'tellybox-qb-cold-137-');
	const authDirectory = temporaryDirectory(t, 'tellybox-qb-cold-auth-137-');
	const upstream = await startUpstream(t);
	writeFileSync(path.join(qbDirectory, 'qbittorrent.json'), JSON.stringify(configFor(upstream.base)));

	const app = express();
	app.use(express.json());
	const local = app.listen(0, '127.0.0.1');
	const remote = app.listen(0, '127.0.0.1');
	await Promise.all([once(local, 'listening'), once(remote, 'listening')]);
	t.after(() => {
		local.closeAllConnections?.();
		remote.closeAllConnections?.();
		local.close();
		remote.close();
	});

	let auth;
	installQbittorrentRoutes(app, {
		requireOwner: (req, res) => { res.status(401).json({ error: 'Sign in as installation administrator.', signInRequired: true }); return false; },
		directory: qbDirectory,
		sameOrigin: () => true,
		allowSummary: req => auth.isOwnerAdmin(req)
	});
	auth = installAuth(app, {
		directory: authDirectory,
		publicDirectory: fileURLToPath(new URL('../public', import.meta.url)),
		localPort: local.address().port,
		localHosts: ['127.0.0.1'],
		localNetworks: ['127.0.0.0/8'],
		setupPort: 8990
	});

	// This denial runs before any successful summary, so the list(200) cache key
	// that the later route test warms cannot hide an upstream read here.
	const denied = await fetch('http://127.0.0.1:' + remote.address().port + '/api/qbittorrent/summary');
	assert.equal(denied.status, 403);
	assert.equal(upstream.state.requests.length, 0, 'a denied cold-cache summary never opens a qBittorrent connection');
	assert.equal(upstream.state.infoReads, 0, 'the denied summary read no torrent list');

	// The same instance would contact the upstream if the guard admitted it, so
	// the zero above is the denial and not a broken fixture.
	const allowed = await fetch('http://127.0.0.1:' + local.address().port + '/api/qbittorrent/summary');
	assert.equal(allowed.status, 200);
	assert.equal((await allowed.json()).state, 'ok');
	assert.ok(upstream.state.requests.length > 0, 'the local summary proves the synthetic upstream is reachable');
});

test('the summary route is trusted-local only and every other route stays owner-only', { timeout: 45000 }, async t => {
	const qbDirectory = temporaryDirectory(t, 'tellybox-qb-route-137-');
	const authDirectory = temporaryDirectory(t, 'tellybox-qb-auth-137-');
	const upstream = await startUpstream(t);
	writeFileSync(path.join(qbDirectory, 'qbittorrent.json'), JSON.stringify(configFor(upstream.base)));

	const app = express();
	app.use(express.json());
	const local = app.listen(0, '127.0.0.1');
	const remote = app.listen(0, '127.0.0.1');
	await Promise.all([once(local, 'listening'), once(remote, 'listening')]);
	t.after(() => {
		local.closeAllConnections?.();
		remote.closeAllConnections?.();
		local.close();
		remote.close();
	});

	const denied = [];
	const requireOwner = (req, res) => {
		denied.push(req.method + ' ' + req.path);
		res.status(401).json({ error: 'Sign in as installation administrator.', signInRequired: true });
		return false;
	};

	// The routes are mounted ahead of the owner gate so this test exercises the
	// summary boundary itself. allowSummary still calls the real auth helper.
	let auth;
	installQbittorrentRoutes(app, {
		requireOwner,
		directory: qbDirectory,
		sameOrigin: () => true,
		allowSummary: req => auth.isOwnerAdmin(req)
	});
	auth = installAuth(app, {
		directory: authDirectory,
		publicDirectory: fileURLToPath(new URL('../public', import.meta.url)),
		localPort: local.address().port,
		localHosts: ['127.0.0.1'],
		localNetworks: ['127.0.0.0/8'],
		setupPort: 8990
	});

	const call = (port, route, headers = {}) => fetch('http://127.0.0.1:' + port + route, { headers });

	const localSummary = await call(local.address().port, '/api/qbittorrent/summary');
	assert.equal(localSummary.status, 200);
	assert.equal(localSummary.headers.get('cache-control'), 'no-store');
	const body = await localSummary.json();
	assert.equal(body.readOnly, true);
	assert.equal(body.state, 'ok');
	assert.deepEqual(body.counts, {
		downloading: 2, queued: 1, seeding: 1, paused: 0,
		checking: 0, moving: 0, attention: 0, other: 0
	});
	assertSanitized(body, [upstream.base]);
	const afterLocalSummary = upstream.state.requests.length;
	assert.ok(afterLocalSummary > 0, 'the local panel read the synthetic upstream');

	const remoteSummary = await call(remote.address().port, '/api/qbittorrent/summary');
	assert.equal(remoteSummary.status, 403);
	assert.deepEqual(await remoteSummary.json(), {
		error: 'Read-only qBittorrent statistics are available only at home or to an installation administrator.'
	});

	const status = await call(local.address().port, '/api/qbittorrent/status');
	assert.equal(status.status, 401);
	assert.equal((await status.json()).signInRequired, true);
	const downloads = await call(local.address().port, '/api/qbittorrent/downloads');
	assert.equal(downloads.status, 401);
	assert.equal((await downloads.json()).signInRequired, true);

	for (const headers of [
		{ 'X-Forwarded-For': '192.168.0.42' },
		{ 'CF-Connecting-IP': '192.168.0.42' },
		{ Forwarded: 'for=192.168.0.42' }
	]) {
		const response = await call(local.address().port, '/api/qbittorrent/summary', headers);
		assert.equal(response.status, 403, JSON.stringify(headers) + ' must not create trusted-local access');
		assert.deepEqual(await response.json(), {
			error: 'Read-only qBittorrent statistics are available only at home or to an installation administrator.'
		});
	}

	assert.equal(upstream.state.requests.length, afterLocalSummary, 'denied summary and owner requests add no upstream request');
	assert.ok(denied.length >= 2, 'the owner boundary answered the status and download routes');
});

test('home presence alone no longer authorises the qBittorrent summary', { timeout: 45000 }, async t => {
	const qbDirectory = temporaryDirectory(t, 'tellybox-qb-home-137-');
	const authDirectory = temporaryDirectory(t, 'tellybox-qb-home-auth-137-');
	const upstream = await startUpstream(t);
	writeFileSync(path.join(qbDirectory, 'qbittorrent.json'), JSON.stringify(configFor(upstream.base)));

	const HOME_IP = '203.0.113.9';
	const app = express();
	app.use(express.json());
	const server = app.listen(0, '127.0.0.1');
	await once(server, 'listening');
	t.after(() => { server.closeAllConnections?.(); server.close(); });

	// The real matcher, fed by a stubbed relay response. HOME_IP is TEST-NET-3,
	// so the matcher's public-address rule is exercised rather than bypassed.
	const homeNetwork = createHomeNetwork('https://relay.example.test/relay-client-ip', {
		fetcher: async () => new Response(HOME_IP)
	});
	await homeNetwork.refresh();
	assert.equal(homeNetwork.matches(HOME_IP), true, 'the home matcher is primed with the relay address');

	const auth = installAuth(app, {
		directory: authDirectory,
		publicDirectory: fileURLToPath(new URL('../public', import.meta.url)),
		localPort: server.address().port,
		localHosts: ['127.0.0.1'],
		localNetworks: ['127.0.0.0/8'],
		publicOrigin: 'https://remote.test',
		trustedProxies: ['127.0.0.1'],
		homeTrustedProxy: '127.0.0.1',
		homeNetwork,
		setupPort: 8990
	});
	// Production order: the viewer gate runs before the summary route.
	installQbittorrentRoutes(app, {
		requireOwner: (req, res) => { res.status(401).json({ error: 'Sign in as installation administrator.', signInRequired: true }); return false; },
		directory: qbDirectory,
		sameOrigin: () => true,
		allowSummary: req => auth.isOwnerAdmin(req)
	});

	// node:http, not fetch: the home classifier reads the Host header and fetch
	// silently overwrites it with the socket address.
	const get = (route, headers) => new Promise((resolve, reject) => {
		const request = http.request({ host: '127.0.0.1', port: server.address().port, path: route, method: 'GET', headers }, response => {
			const chunks = [];
			response.on('data', chunk => chunks.push(chunk));
			response.on('end', () => resolve({
				status: response.statusCode,
				headers: response.headers,
				text: Buffer.concat(chunks).toString('utf8')
			}));
		});
		request.on('error', reject);
		request.end();
	});
	const homeHeaders = { Host: 'remote.test', 'X-Forwarded-Proto': 'https', 'CF-Connecting-IP': HOME_IP };

	const status = await get('/api/auth/status', homeHeaders);
	const state = JSON.parse(status.text);
	assert.equal(state.home, true, 'the trusted proxy + matching client address classify as home');
	assert.equal(state.local, false, 'the forwarded request is not local access');

	const summary = await get('/api/qbittorrent/summary', homeHeaders);
	assert.equal(summary.status, 403, 'being at home is not an administrator role');
	assert.equal(summary.headers['cache-control'], 'no-store');
	assert.deepEqual(JSON.parse(summary.text), {
		error: 'Read-only qBittorrent statistics are available only at home or to an installation administrator.'
	});

	// Without the relay-verified client address the same proxy request is only
	// an unauthenticated remote caller.
	assert.equal(JSON.parse((await get('/api/auth/status', { Host: 'remote.test', 'X-Forwarded-Proto': 'https' })).text).home, false);
	const notHome = await get('/api/qbittorrent/summary', { Host: 'remote.test', 'X-Forwarded-Proto': 'https' });
	assert.equal(notHome.status, 401);
});
