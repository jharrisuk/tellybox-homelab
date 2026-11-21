/* NIGHT BATCH 2026-11-20: qBittorrent count, hasMore, sample eviction and
 * version fallbacks.
 *
 * All upstreams are synthetic local HTTP servers. No live qBittorrent, real
 * hash or credential is used.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createQbittorrent, SAMPLE_TTL_MS } from '../qbittorrent.mjs';

const QB_USER = 'synthetic-batch-user';
const QB_PASSWORD = 'synthetic-batch-secret';

const DOWNLOADING_STATES = new Set([
	'downloading', 'forcedDL', 'stalledDL', 'metaDL', 'forcedMetaDL',
	'queuedDL', 'checkingDL', 'pausedDL', 'stoppedDL'
]);
const SEEDING_STATES = new Set(['uploading', 'forcedUP', 'stalledUP', 'queuedUP', 'checkingUP']);
const PAUSED_STATES = new Set(['pausedDL', 'pausedUP', 'stoppedDL', 'stoppedUP']);
const CHECKING_STATES = new Set(['checkingDL', 'checkingUP', 'checkingResumeData', 'queuedForChecking']);
const ERROR_STATES = new Set(['error', 'missingFiles']);

const MATCHERS = {
	all: () => true,
	downloading: state => DOWNLOADING_STATES.has(state),
	seeding: state => SEEDING_STATES.has(state),
	paused: state => PAUSED_STATES.has(state),
	stopped: state => PAUSED_STATES.has(state),
	checking: state => CHECKING_STATES.has(state),
	moving: state => state === 'moving',
	errored: state => ERROR_STATES.has(state),
	resumed: state => !PAUSED_STATES.has(state),
	running: () => true
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
		num_seeds: 1,
		num_complete: 2,
		num_leechs: 0,
		num_incomplete: 1,
		added_on: 1700000000 + index,
		last_activity: 1700000100,
		...overrides
	};
}

async function startUpstream(t, { torrents, webapiVersion, countStatus = 200, duplicateAll = false }) {
	const state = { torrents, webapiVersion, countStatus, duplicateAll, requests: [] };
	const server = http.createServer(async (req, res) => {
		for await (const chunk of req) { /* drain fixture bodies */ }
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
			return text(200, 'Ok.', { 'set-cookie': 'SID=synthetic-batch; path=/' });
		}
		if (req.headers.cookie !== 'SID=synthetic-batch') return text(401, '');
		if (url.pathname === '/api/v2/app/webapiVersion') return text(200, state.webapiVersion);
		if (url.pathname === '/api/v2/app/version') return text(200, 'v5.0.3');
		if (url.pathname === '/api/v2/transfer/info') {
			return json(200, { dl_info_speed: 5000, up_info_speed: 120, connection_status: 'connected' });
		}
		if (url.pathname === '/api/v2/torrents/categories') return json(200, {});
		if (url.pathname === '/api/v2/torrents/count') {
			if (state.countStatus !== 200) return text(state.countStatus, '');
			return text(200, String(state.torrents.length));
		}
		if (url.pathname === '/api/v2/torrents/info') {
			const filter = url.searchParams.get('filter') || 'all';
			const matcher = MATCHERS[filter] || MATCHERS.all;
			const rows = state.torrents
				.filter(row => matcher(row.state))
				.sort((left, right) => (right.added_on || 0) - (left.added_on || 0));
			const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
			const limitValue = url.searchParams.get('limit');
			const limit = limitValue === null ? rows.length : Math.max(0, Number(limitValue) || 0);
			const page = rows.slice(offset, offset + limit);
			// Simulate qBittorrent repeating a boundary hash in an all-sample.
			if (state.duplicateAll && filter === 'all' && page.length) page.push({ ...page[0] });
			return json(200, page);
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

async function startQb(t, options = {}) {
	const directory = temporaryDirectory(t, 'tellybox-qb-batch-');
	const upstream = await startUpstream(t, {
		torrents: options.torrents || [],
		webapiVersion: options.webapiVersion ?? '2.9.3',
		countStatus: options.countStatus ?? 200,
		duplicateAll: options.duplicateAll === true
	});
	const file = path.join(directory, 'qbittorrent.json');
	writeFileSync(file, JSON.stringify(configFor(upstream.base)));
	const qb = createQbittorrent({ file, clock: options.clock || (() => 1700000000000) });
	return { directory, upstream, file, qb };
}

const infoQueries = state => state.requests
	.filter(request => request.path === '/api/v2/torrents/info')
	.map(request => new URL('http://mock' + request.url).searchParams);

test('the authoritative count is requested from WebUI API 2.9.3 and stays best-effort', async t => {
	const { qb, upstream } = await startQb(t, {
		torrents: [fixtureRow(0, 'downloading')],
		webapiVersion: '2.9.3',
		countStatus: 500
	});
	const body = await qb.summary();
	assert.equal(body.state, 'ok', 'a failing count endpoint does not fail the reading');
	assert.ok(upstream.state.requests.some(request => request.path === '/api/v2/torrents/count'),
		'API 2.9.3 is above the real 2.9.3 introduction, not the old 2.15.1 gate');

	const old = await startQb(t, {
		torrents: [fixtureRow(0, 'downloading')],
		webapiVersion: '2.9.2'
	});
	await old.qb.summary();
	assert.equal(old.upstream.state.requests.some(request => request.path === '/api/v2/torrents/count'), false,
		'the count endpoint is not probed below API 2.9.3');
});

test('hasMore is true when more than 200 deduplicated rows exist', async t => {
	const torrents = [];
	for (let index = 0; index < 250; index += 1) {
		torrents.push(fixtureRow(index, 'stalledUP', {
			name: 'Seed ' + index, progress: 1, completed: 1000, dlspeed: 0, eta: 8640000
		}));
	}
	const { qb } = await startQb(t, { torrents, webapiVersion: '2.9.3' });
	const summary = await qb.summary();
	assert.equal(summary.sampleSize, 250, 'the deduplicated sample is complete');
	assert.deepEqual(summary.countsLowerBound, [], 'no bounded query hit its cap');
	assert.equal(summary.hasMore, true, 'more than 200 rows exist even without a lower bound');

	const all = await qb.readOnlyDownloads({ filter: 'all' });
	assert.equal(all.rows.length, 200, 'the viewer still renders at most 200 rows');
	assert.equal(all.hasMore, true, 'the all-view also reports the extra rows');
});

test('viewerAllRows deduplicates hashes before applying the 200-row limit', async t => {
	const torrents = [];
	for (let index = 0; index < 200; index += 1) {
		torrents.push(fixtureRow(index, 'stalledUP', {
			name: 'Seed ' + index, progress: 1, completed: 1000, dlspeed: 0, eta: 8640000
		}));
	}
	const { qb } = await startQb(t, { torrents, webapiVersion: '2.9.3', duplicateAll: true });
	const all = await qb.readOnlyDownloads({ filter: 'all' });
	assert.equal(all.rows.length, 200, '200 unique hashes are rendered');
	assert.equal(all.hasMore, false, 'one repeated hash is not proof of a 201st unique row');
});

test('old progress samples are evicted while a live sample is retained', async t => {
	const start = 1_700_000_000_000;
	let now = start;
	const A = fixtureRow(1, 'downloading', { name: 'Old sample', progress: 0.2, completed: 100 });
	const B = fixtureRow(2, 'downloading', { name: 'Live sample', progress: 0.2, completed: 100 });
	const { qb, upstream } = await startQb(t, { torrents: [A, B], clock: () => now });

	const first = await qb.readOnlyDownloads({ filter: 'downloading' });
	assert.equal(first.rows.length, 2);

	// Only B is still listed, so its sample stays recent while A ages out.
	now = start + Math.floor(SAMPLE_TTL_MS * 0.6);
	upstream.state.torrents = [B];
	await qb.readOnlyDownloads({ filter: 'downloading' });

	// A returns after its old sample aged past the window. If that sample had
	// survived, both rows would be reported as stalled after the 30-minute
	// threshold; a fresh sample for A keeps the attention count honest.
	now = start + Math.floor(SAMPLE_TTL_MS * 1.2);
	upstream.state.torrents = [A, B];
	const summary = await qb.summary();
	assert.equal(summary.counts.downloading, 2);
	assert.equal(summary.counts.attention, 1, 'the retained live sample is the only stalled row');
});

test('an unknown, 2.8.x or 2.11.x WebUI version selects the right filter names', async t => {
	const cases = [
		['', 'paused', 'resumed'],
		['2.8.0', 'paused', 'resumed'],
		['2.11.2', 'stopped', 'running']
	];
	for (const [version, pausedFilter, runningFilter] of cases) {
		const { qb, upstream } = await startQb(t, {
			torrents: [fixtureRow(0, 'pausedDL')],
			webapiVersion: version
		});
		await qb.summary();
		const label = version || 'unknown';
		assert.equal(qb.filterFor('paused'), pausedFilter, label + ' paused filter');
		assert.equal(qb.filterFor('running'), runningFilter, label + ' running filter');
		const filters = infoQueries(upstream.state);
		assert.ok(filters.some(query => query.get('filter') === pausedFilter),
			label + ' sends its supported paused filter upstream');
		if (pausedFilter === 'paused') {
			assert.equal(filters.some(query => query.get('filter') === 'stopped'), false,
				label + ' never sends the 5.x stopped filter to a legacy WebUI');
		}
	}
});
