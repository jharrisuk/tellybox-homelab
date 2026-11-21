/* qBittorrent filtered reads and honest counts.
 *
 * The synthetic upstream applies qBittorrent's own filter before limit/offset,
 * so these tests prove that an active download outside the newest 200 torrents
 * is still listed and counted, that a large seed queue does not cap the counts,
 * and that a capped bounded query is disclosed as a lower bound.
 *
 * No live qBittorrent or credential is used.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import express from 'express';
import { createQbittorrent, installQbittorrentRoutes, QbitError } from '../qbittorrent.mjs';

const QB_USER = 'synthetic-webui-user-144';
const QB_PASSWORD = 'synthetic-webui-secret-144';
const ACTIVE = 'Active Download Outside The All Sample';

const DOWNLOADING_STATES = new Set([
	'downloading', 'forcedDL', 'stalledDL', 'metaDL', 'forcedMetaDL',
	'queuedDL', 'checkingDL', 'pausedDL', 'stoppedDL'
]);
const SEEDING_STATES = new Set(['uploading', 'forcedUP', 'stalledUP', 'queuedUP', 'checkingUP']);
const STOPPED_STATES = new Set(['pausedDL', 'pausedUP', 'stoppedDL', 'stoppedUP']);
const CHECKING_STATES = new Set(['checkingDL', 'checkingUP', 'checkingResumeData', 'queuedForChecking']);
const ERROR_STATES = new Set(['error', 'missingFiles']);

const MATCHERS = {
	all: () => true,
	downloading: state => DOWNLOADING_STATES.has(state),
	seeding: state => SEEDING_STATES.has(state),
	stopped: state => STOPPED_STATES.has(state),
	checking: state => CHECKING_STATES.has(state),
	moving: state => state === 'moving',
	errored: state => ERROR_STATES.has(state)
};

function temporaryDirectory(t, prefix) {
	const directory = mkdtempSync(path.join(tmpdir(), prefix));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	return directory;
}

function fixtureRow(index, state, overrides = {}) {
	return {
		hash: (index + 1).toString(16).padStart(40, '0'),
		name: 'Synthetic torrent ' + index,
		state,
		progress: 0.4,
		completed: 400,
		size: 1000,
		total_size: 1000,
		dlspeed: 5000,
		upspeed: 120,
		eta: 300,
		ratio: 0.5,
		category: 'Synthetic',
		save_path: '/srv/synthetic-private',
		magnet_uri: 'magnet:?xt=urn:btih:' + (index + 1).toString(16).padStart(40, '0'),
		num_seeds: 1,
		num_complete: 2,
		num_leechs: 0,
		num_incomplete: 1,
		added_on: 1700000000 + index,
		last_activity: 1700000100,
		...overrides
	};
}

async function startUpstream(t, torrents) {
	const state = { torrents, requests: [] };
	const server = http.createServer(async (req, res) => {
		for await (const chunk of req) { /* drain fixture request bodies */ }
		const url = new URL(req.url, 'http://127.0.0.1');
		state.requests.push({ method: req.method, path: url.pathname, url: req.url });
		const text = (status, value, headers = {}) => {
			res.writeHead(status, { 'content-type': 'text/plain; charset=UTF-8', ...headers });
			res.end(value);
		};
		const json = (status, value) => {
			res.writeHead(status, { 'content-type': 'application/json; charset=UTF-8' });
			res.end(JSON.stringify(value));
		};
		if (url.pathname === '/api/v2/auth/login') {
			return text(200, 'Ok.', { 'set-cookie': 'SID=synthetic-144; path=/' });
		}
		if (req.headers.cookie !== 'SID=synthetic-144') return text(401, '');
		if (url.pathname === '/api/v2/app/webapiVersion') return text(200, '2.16.0');
		if (url.pathname === '/api/v2/app/version') return text(200, 'v5.3.0');
		if (url.pathname === '/api/v2/transfer/info') {
			return json(200, { dl_info_speed: 5000, up_info_speed: 120, connection_status: 'connected' });
		}
		if (url.pathname === '/api/v2/torrents/categories') return json(200, {});
		if (url.pathname === '/api/v2/torrents/count') return text(200, String(state.torrents.length));
		if (url.pathname === '/api/v2/torrents/info') {
			const filter = url.searchParams.get('filter') || 'all';
			const matcher = MATCHERS[filter] || MATCHERS.all;
			const rows = state.torrents
				.filter(row => matcher(row.state))
				.sort((left, right) => (right.added_on || 0) - (left.added_on || 0));
			const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
			const limitValue = url.searchParams.get('limit');
			const limit = limitValue === null ? rows.length : Math.max(0, Number(limitValue) || 0);
			return json(200, rows.slice(offset, offset + limit));
		}
		return text(404, '');
	});
	server.listen(0, '127.0.0.1');
	await once(server, 'listening');
	t.after(() => { server.closeAllConnections?.(); server.close(); });
	return { base: 'http://127.0.0.1:' + server.address().port, state };
}

function configFor(base) {
	return {
		url: base + '/', username: QB_USER, password: QB_PASSWORD,
		enabled: true, pollSeconds: 20, stalledMinutes: 30
	};
}

async function startQb(t, torrents, { clock = () => 1700000000000 } = {}) {
	const directory = temporaryDirectory(t, 'tellybox-qb-filters-144-');
	const upstream = await startUpstream(t, torrents);
	const file = path.join(directory, 'qbittorrent.json');
	writeFileSync(file, JSON.stringify(configFor(upstream.base)));
	const qb = createQbittorrent({ file, clock });
	return { directory, upstream, file, qb };
}

const infoReads = state => state.requests.filter(request => request.path === '/api/v2/torrents/info');
const infoQueries = state => infoReads(state).map(request => new URL('http://mock' + request.url).searchParams);
const filterFor = (state, filter) => infoQueries(state).find(query => query.get('filter') === filter);

function largeQueue() {
	const torrents = [
		fixtureRow(0, 'downloading', { name: ACTIVE, added_on: 1600000000, dlspeed: 9000, eta: 420 }),
		fixtureRow(1, 'queuedDL', { added_on: 1600000100 }),
		fixtureRow(2, 'stoppedDL', { added_on: 1600000200 }),
		fixtureRow(3, 'checkingDL', { added_on: 1600000300 })
	];
	for (let index = 0; index < 250; index += 1) {
		torrents.push(fixtureRow(10 + index, 'stalledUP', {
			name: 'Synthetic seed ' + index, progress: 1, completed: 1000,
			dlspeed: 0, eta: 8640000, added_on: 1700000000 + index
		}));
	}
	return torrents;
}

test('an active download outside the first 200 all-rows is listed and counted under downloading', async t => {
	const { upstream, qb } = await startQb(t, largeQueue());

	// Reproduce the truncation: the newest 200 rows of an all-sample are all
	// seeding, so the old active download is invisible there.
	const allSample = await qb.list({ limit: 200, filter: 'all' });
	assert.equal(allSample.rows.length, 200);
	assert.equal(allSample.rows.some(row => row.name === ACTIVE), false, 'the all-sample hides the old download');
	assert.equal(allSample.page.hasMore, true);

	const before = upstream.state.requests.length;
	const downloads = await qb.readOnlyDownloads({ filter: 'downloading' });
	assert.equal(downloads.filter, 'downloading');
	assert.equal(downloads.rows.some(row => row.name === ACTIVE), true, 'the downloading filter reveals the active download');
	assert.equal(downloads.sampleSize, 4);
	assert.equal(downloads.hasMore, false);
	assert.deepEqual(downloads.counts, {
		downloading: 1, queued: 1, seeding: 250, paused: 1,
		checking: 1, moving: 0, attention: 0, other: 0
	});
	assert.deepEqual(downloads.countsLowerBound, [], 'a 250-torrent bucket is below the bounded query cap');

	const queries = infoQueries({ requests: upstream.state.requests.slice(before) });
	const requested = queries.find(query => query.get('filter') === 'downloading');
	assert.ok(requested, 'the viewer filter is requested from qBittorrent');
	assert.equal(requested.get('limit'), '501', 'the bound applies after filtering, not to an all-sample');
	assert.equal(queries.some(query => query.get('filter') === 'all'), false, 'a downloading view does not read an all-sample');
});

test('the seeding filter lists seeding rows and its count is not sample-capped', async t => {
	const { qb } = await startQb(t, largeQueue());
	await qb.readOnlyDownloads({ filter: 'downloading' });
	const seeding = await qb.readOnlyDownloads({ filter: 'seeding' });
	assert.equal(seeding.filter, 'seeding');
	assert.equal(seeding.rows.length, 200, 'the rendered page is bounded');
	assert.equal(seeding.hasMore, true, 'the page says more seeding rows exist');
	assert.equal(seeding.rows.every(row => ['uploading', 'forcedUP', 'stalledUP', 'queuedUP', 'checkingUP'].includes(row.state)), true);
	assert.equal(seeding.counts.seeding, 250, 'the count covers the whole filtered bucket');
	assert.deepEqual(seeding.countsLowerBound, []);
});

test('a bounded query that hits its cap marks affected counts as lower bounds', async t => {
	const torrents = [];
	for (let index = 0; index < 600; index += 1) {
		torrents.push(fixtureRow(index, 'stalledUP', {
			name: 'Synthetic capped seed ' + index, progress: 1, completed: 1000,
			dlspeed: 0, eta: 8640000
		}));
	}
	const { qb } = await startQb(t, torrents, { clock: () => 1800000000000 });

	const summary = await qb.summary();
	assert.equal(summary.counts.seeding, 500, 'the reported value is the observed cap');
	assert.equal(summary.hasMore, true);
	assert.ok(summary.countsLowerBound.includes('seeding'));
	assert.ok(summary.countsLowerBound.includes('queued'), 'queued-up could also be beyond the seeding cap');

	const downloads = await qb.readOnlyDownloads({ filter: 'seeding' });
	assert.equal(downloads.counts.seeding, 500);
	assert.equal(downloads.sampleSize, 200);
	assert.equal(downloads.hasMore, true);
	assert.ok(downloads.countsLowerBound.includes('seeding'), 'the client can mark the value as a lower bound');
});

test('the state mapping covers the real qBittorrent states and never invents an unknown label', async t => {
	const states = [
		'stalledDL', 'stalledUP', 'metaDL', 'forcedMetaDL', 'forcedDL', 'queuedDL', 'queuedUP',
		'checkingUP', 'checkingDL', 'checkingResumeData', 'moving', 'allocating', 'error',
		'missingFiles', 'stoppedDL', 'stoppedUP', 'queuedForChecking', 'unknown'
	];
	const torrents = states.map((state, index) => fixtureRow(index, state, {
		name: 'State ' + state,
		progress: state === 'stalledUP' ? 1 : state === 'unknown' ? 0 : 0.4
	}));
	const { qb } = await startQb(t, torrents);
	const body = await qb.readOnlyDownloads({ filter: 'all' });
	assert.equal(body.rows.length, states.length);

	const byName = new Map(body.rows.map(row => [row.name, row]));
	for (const state of states) {
		const row = byName.get('State ' + state);
		assert.ok(row, 'row for ' + state);
		assert.equal(row.state, state, 'the real state is exposed');
		if (state === 'unknown') continue;
		assert.notEqual(row.stateLabel, 'Unknown', state + ' must have a real label');
	}
	assert.deepEqual(body.counts, {
		downloading: 4, queued: 2, seeding: 1, paused: 2,
		checking: 4, moving: 1, attention: 0, other: 4
	});
	assert.deepEqual(body.countsLowerBound, [], 'the authoritative total resolves the other bucket');
});

test('ETA is omitted for a completed torrent or a zero-speed torrent', async t => {
	const torrents = [
		fixtureRow(0, 'downloading', { name: 'Active ETA', progress: 0.5, dlspeed: 5000, eta: 300 }),
		fixtureRow(1, 'stalledDL', { name: 'Stalled ETA', progress: 0.4, dlspeed: 0, eta: 600 }),
		fixtureRow(2, 'stalledUP', { name: 'Seeding ETA', progress: 1, completed: 1000, dlspeed: 0, eta: 1234 })
	];
	const { qb } = await startQb(t, torrents);
	const body = await qb.readOnlyDownloads({ filter: 'all' });
	const byName = new Map(body.rows.map(row => [row.name, row]));
	assert.equal(byName.get('Active ETA').eta, 300);
	assert.equal(byName.get('Stalled ETA').eta, null, 'no speed means no meaningful ETA');
	assert.equal(byName.get('Seeding ETA').eta, null, 'a completed torrent has no transfer ETA');
});

test('concurrent reads coalesce and the existing cache TTL is reused', async t => {
	let now = 1700000000000;
	const { upstream, qb } = await startQb(t, largeQueue(), { clock: () => now });

	await Promise.all([
		qb.summary(),
		qb.readOnlyDownloads({ filter: 'downloading' }),
		qb.readOnlyDownloads({ filter: 'seeding' })
	]);
	assert.equal(infoReads(upstream.state).length, 6, 'one bounded filtered query per count bucket, shared by concurrent callers');

	await qb.summary();
	await qb.readOnlyDownloads({ filter: 'downloading' });
	assert.equal(infoReads(upstream.state).length, 6, 'a short poll reuses the cached catalogue reading');

	now += 21000;
	await qb.summary();
	assert.equal(infoReads(upstream.state).length, 12, 'the configured TTL starts one fresh bounded reading');
});

test('the route accepts only the three viewer filters, validates before upstream, and keeps the guard first', { timeout: 45000 }, async t => {
	const directory = temporaryDirectory(t, 'tellybox-qb-filter-route-144-');
	const upstream = await startUpstream(t, largeQueue());
	writeFileSync(path.join(directory, 'qbittorrent.json'), JSON.stringify(configFor(upstream.base)));

	const app = express();
	app.use(express.json());
	installQbittorrentRoutes(app, {
		requireOwner: (req, res) => { res.status(401).json({ error: 'Sign in as installation administrator.', signInRequired: true }); return false; },
		directory,
		sameOrigin: () => true,
		allowDownloads: req => req.headers['x-test-local'] === '1'
	});
	const server = app.listen(0, '127.0.0.1');
	await once(server, 'listening');
	t.after(() => { server.closeAllConnections?.(); server.close(); });
	const base = 'http://127.0.0.1:' + server.address().port;
	const call = (route, headers = {}) => fetch(base + route, { headers });

	// The guard is consulted before the invalid query string can reach anything.
	const denied = await call('/api/activity/downloads?filter=bogus');
	assert.equal(denied.status, 403);
	assert.equal(upstream.state.requests.length, 0, 'a denied caller makes no upstream request');

	const invalid = await call('/api/activity/downloads?filter=completed', { 'x-test-local': '1' });
	assert.equal(invalid.status, 400);
	assert.equal((await invalid.json()).code, 'invalid-filter');
	assert.equal(upstream.state.requests.length, 0, 'an invalid filter is rejected before qBittorrent contact');

	const allowed = await call('/api/activity/downloads?filter=downloading', { 'x-test-local': '1' });
	assert.equal(allowed.status, 200);
	assert.equal(allowed.headers.get('cache-control'), 'no-store');
	const body = await allowed.json();
	assert.equal(body.filter, 'downloading');
	assert.equal(body.rows.some(row => row.name === ACTIVE), true);
	assert.ok(filterFor(upstream.state, 'downloading'), 'the allowed read used the requested filter');

	const afterAllowed = upstream.state.requests.length;
	const invalidWarm = await call('/api/activity/downloads?filter=seeding%2Cdownloading', { 'x-test-local': '1' });
	assert.equal(invalidWarm.status, 400, 'an allowlist rejection applies even after a warm cache');
	assert.equal(upstream.state.requests.length, afterAllowed, 'a rejected filter never adds an upstream request');

	const fallback = await call('/api/activity/downloads', { 'x-test-local': '1' });
	assert.equal(fallback.status, 200);
	assert.equal((await fallback.json()).filter, 'all', 'an omitted filter keeps the read-only default');
});

test('invalid filters are rejected by the module with a 400 before any request', async t => {
	const { upstream, qb } = await startQb(t, largeQueue());
	for (const filter of ['completed', 'paused', 'downloading,seeding']) {
		await assert.rejects(qb.readOnlyDownloads({ filter }), error =>
			error instanceof QbitError && error.status === 400 && error.code === 'invalid-filter');
	}
	assert.equal(upstream.state.requests.length, 0);
	assert.equal((await qb.readOnlyDownloads({})).filter, 'all');
});
