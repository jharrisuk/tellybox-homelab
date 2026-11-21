/* Release 134: qBittorrent WebUI protocol tests against a real mock HTTP server.
 *
 * These exercise the installed qBittorrent v5 WebUI API shape: cookie login,
 * Referer/CSRF expectation, WebUI version discovery, bounded torrents/info
 * paging and the documented torrents/delete form. No live qBittorrent is used
 * and no torrent or file is changed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createQbittorrent, isExactHash, normalizeWebUiUrl, QbitError } from '../qbittorrent.mjs';

const PASSWORD = 'test-only-qbittorrent-password';
const HASH_A = 'a'.repeat(40);
const HASH_B = 'b'.repeat(40);
const SESSION_A = 'd'.repeat(64);
const SESSION_B = 'e'.repeat(64);

function torrent(hash, overrides = {}) {
	return {
		hash,
		name: 'Example.Movie.2026.1080p',
		state: 'downloading',
		progress: 0.42,
		completed: 420,
		size: 1000,
		total_size: 1200,
		dlspeed: 5000,
		upspeed: 120,
		eta: 90,
		category: 'Movies',
		num_seeds: 2,
		num_complete: 10,
		num_leechs: 1,
		num_incomplete: 3,
		added_on: 1700000000,
		last_activity: 1700000100,
		magnet_uri: 'magnet:?xt=urn:btih:' + hash + '&tr=https://tracker.example/passkey',
		tracker: 'https://tracker.example/passkey/announce',
		content_path: '/srv/private-media/Example.Movie',
		save_path: '/srv/private-media',
		peers: [{ ip: '192.0.2.99', port: 51413 }],
		...overrides
	};
}

async function startMock(t) {
	const state = {
		calls: [], torrents: [torrent(HASH_A)],
		categories: { Movies: { name: 'Movies', savePath: '/srv/private-media' } },
		webapiVersion: '2.11.2', applicationVersion: 'v5.0.3',
		loginBody: 'Ok.', loginStatus: 200, infoStatus: 200, deleteStatus: 200,
		expireNextInfo: false, deleteBlocked: false, deleteRelease: null
	};
	const server = http.createServer(async (req, res) => {
		const chunks = [];
		for await (const chunk of req) chunks.push(chunk);
		const body = Buffer.concat(chunks).toString('utf8');
		const url = new URL(req.url, 'http://127.0.0.1');
		state.calls.push({ method: req.method, path: url.pathname, url: req.url, headers: { ...req.headers }, body });
		const send = (status, text, headers = {}) => {
			res.writeHead(status, { 'content-type': 'text/plain; charset=UTF-8', ...headers });
			res.end(text);
		};
		const json = (status, value) => {
			res.writeHead(status, { 'content-type': 'application/json; charset=UTF-8' });
			res.end(JSON.stringify(value));
		};
		if (url.pathname === '/api/v2/auth/login') {
			if (state.loginStatus !== 200) return send(state.loginStatus, '');
			const headers = state.loginBody === 'Ok.' ? { 'set-cookie': 'QBT_SID_8443=test-sid; path=/' } : {};
			return send(200, state.loginBody, headers);
		}
		if (req.headers.referer !== 'http://127.0.0.1:' + server.address().port + '/') return send(403, 'bad referer');
		if (req.headers.cookie !== 'QBT_SID_8443=test-sid') return send(401, 'forbidden');
		if (url.pathname === '/api/v2/app/webapiVersion') return send(200, state.webapiVersion);
		if (url.pathname === '/api/v2/app/version') return send(200, state.applicationVersion);
		if (url.pathname === '/api/v2/torrents/categories') return json(200, state.categories);
		if (url.pathname === '/api/v2/transfer/info') return json(200, { dl_info_speed: 5000, up_info_speed: 120, connection_status: 'connected', dl_info_data: 999 });
		if (url.pathname === '/api/v2/torrents/info') {
			if (state.expireNextInfo) { state.expireNextInfo = false; return send(401, 'expired'); }
			if (state.infoStatus !== 200) return send(state.infoStatus, '');
			let rows = [...state.torrents];
			const hashes = url.searchParams.get('hashes');
			if (hashes) {
				const wanted = new Set(hashes.split('|'));
				rows = rows.filter(row => wanted.has(row.hash));
			}
			if (url.searchParams.has('category')) {
				const category = url.searchParams.get('category');
				rows = rows.filter(row => (row.category || '') === category);
			}
			const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
			const limit = Math.max(0, Number(url.searchParams.get('limit')) || rows.length);
			return json(200, rows.slice(offset, offset + limit));
		}
		if (url.pathname === '/api/v2/torrents/delete') {
			if (state.deleteBlocked) await new Promise(resolve => { state.deleteRelease = resolve; });
			if (state.deleteStatus !== 200) return send(state.deleteStatus, '');
			const form = new URLSearchParams(body);
			const hashes = String(form.get('hashes') || '').split('|');
			state.torrents = state.torrents.filter(row => !hashes.includes(row.hash));
			return send(200, '');
		}
		return send(404, '');
	});
	server.listen(0, '127.0.0.1');
	await once(server, 'listening');
	t.after(() => {
		try { state.deleteRelease?.(); } catch {}
		try { server.closeAllConnections?.(); } catch {}
		server.close();
	});
	return { base: 'http://127.0.0.1:' + server.address().port, state };
}

function directory(t) {
	const dir = mkdtempSync(path.join(tmpdir(), 'tellybox-qbittorrent-134-'));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

function saveConfig(dir, overrides = {}) {
	writeFileSync(path.join(dir, 'qbittorrent.json'), JSON.stringify({
		url: overrides.url, username: 'owner', password: PASSWORD, enabled: true,
		pollSeconds: 15, stalledMinutes: 10, ...overrides
	}), { mode: 0o600 });
}

async function expectCode(promise, code) {
	await assert.rejects(promise, error => {
		assert.ok(error instanceof QbitError, 'expected a QbitError');
		assert.equal(error.code, code);
		return true;
	});
}

function deleteCalls(state) {
	return state.calls.filter(call => call.path === '/api/v2/torrents/delete');
}

test('disabled and unconfigured integrations make no network request', async t => {
	const mock = await startMock(t);
	const dir = directory(t);
	const qb = createQbittorrent({ file: path.join(dir, 'qbittorrent.json') });
	let data = await qb.list();
	assert.equal(data.state, 'unconfigured');
	assert.equal(mock.state.calls.length, 0);
	saveConfig(dir, { url: mock.base, enabled: false });
	data = await qb.list();
	assert.equal(data.state, 'disabled');
	assert.equal(mock.state.calls.length, 0);
	const status = qb.status();
	assert.equal(status.configured, true);
	assert.equal(status.enabled, false);
	assert.equal(status.state, 'disabled');
	assert.equal(mock.state.calls.length, 0, 'status never checks upstream');
});

test('login uses the returned cookie name and referer, and safe fields only are exposed', async t => {
	const mock = await startMock(t);
	mock.state.torrents = [
		torrent(HASH_A),
		torrent(HASH_B, { state: 'pausedUP', progress: 1, completed: 1000, eta: 8640000, name: 'magnet:?xt=urn:btih:secret & https://tracker.example/passkey' })
	];
	const dir = directory(t);
	const qb = createQbittorrent({ file: path.join(dir, 'qbittorrent.json') });
	saveConfig(dir, { url: mock.base });
	const data = await qb.list();
	assert.equal(data.state, 'ok');
	assert.equal(data.webapiVersion, '2.11.2');
	assert.equal(data.applicationVersion, 'v5.0.3');
	assert.equal(data.rows.length, 2);
	const login = mock.state.calls.find(call => call.path === '/api/v2/auth/login');
	assert.equal(login.method, 'POST');
	assert.equal(login.headers['content-type'], 'application/x-www-form-urlencoded');
	assert.equal(login.body, 'username=owner&password=' + encodeURIComponent(PASSWORD).replace(/%20/g, '+'));
	assert.equal(login.headers.referer, mock.base + '/');
	const first = data.rows[0];
	assert.equal(first.name, 'Example.Movie.2026.1080p');
	assert.equal(first.displayHash.length, 8);
	assert.equal(first.eta, 90);
	assert.equal(first.seeds, 2);
	assert.equal(first.stateLabel, 'Downloading');
	assert.equal(data.rows[1].name, '[magnet] & [link]');
	assert.equal(data.rows[1].eta, null, 'qBittorrent infinity ETA is shown as unknown');
	assert.equal(data.rows[1].completed, true);
	assert.match(data.rows[1].note, /does not prove the file was imported or is playable/);
	const text = JSON.stringify(data);
	for (const secret of [HASH_A, HASH_B, 'test-only-qbittorrent-password', 'tracker.example', '/srv/private-media', '192.0.2.99', 'magnet:?', 'savePath', 'content_path']) {
		assert.equal(text.includes(secret), false, secret);
	}
	assert.equal(JSON.stringify(data.filters.categories), JSON.stringify(['Movies']));
	assert.equal('password' in data, false);
	// Cached while visible, then a fresh check after the configured poll window.
	const infoBefore = mock.state.calls.filter(call => call.path === '/api/v2/torrents/info').length;
	await qb.list();
	assert.equal(mock.state.calls.filter(call => call.path === '/api/v2/torrents/info').length, infoBefore, 'a short poll reuses the in-memory cache');
});

test('large queues use bounded limit/offset paging and category filters', async t => {
	const mock = await startMock(t);
	mock.state.torrents = Array.from({ length: 250 }, (_, index) => torrent(index.toString(16).padStart(40, '0'), {
		name: 'Queue item ' + index, category: index % 2 ? 'Movies' : 'Series'
	}));
	const dir = directory(t);
	const qb = createQbittorrent({ file: path.join(dir, 'qbittorrent.json') });
	saveConfig(dir, { url: mock.base });
	const data = await qb.list({ limit: 50, offset: 100 });
	assert.equal(data.page.limit, 50);
	assert.equal(data.page.offset, 100);
	assert.equal(data.page.count, 50);
	assert.equal(data.page.hasMore, true);
	assert.equal(data.page.nextOffset, 150);
	assert.equal(data.page.previousOffset, 50);
	const info = mock.state.calls.find(call => call.path === '/api/v2/torrents/info');
	const query = new URL('http://mock' + info.url).searchParams;
	assert.equal(query.get('limit'), '51', 'one extra row detects more pages without a total scan');
	assert.equal(query.get('offset'), '100');
	assert.equal(query.get('filter'), 'all');
	assert.equal(query.has('category'), false);
	const categoryData = await qb.list({ limit: 10, offset: 0, category: 'Movies' });
	assert.equal(categoryData.rows.length, 10);
	const categoryInfo = mock.state.calls.filter(call => call.path === '/api/v2/torrents/info').at(-1);
	assert.equal(new URL('http://mock' + categoryInfo.url).searchParams.get('category'), 'Movies');
});

test('session expiry re-authenticates once, while bad credentials back off without a request loop', async t => {
	const mock = await startMock(t);
	mock.state.expireNextInfo = true;
	const dir = directory(t);
	const qb = createQbittorrent({ file: path.join(dir, 'qbittorrent.json') });
	saveConfig(dir, { url: mock.base });
	const data = await qb.list();
	assert.equal(data.state, 'ok');
	assert.equal(mock.state.calls.filter(call => call.path === '/api/v2/auth/login').length, 2, 'one normal login and one single-flight re-auth');
	assert.equal(mock.state.calls.filter(call => call.path === '/api/v2/torrents/info').length, 2);

	const failedDir = directory(t);
	const failedMock = await startMock(t);
	failedMock.state.loginBody = 'Fails.';
	const failed = createQbittorrent({ file: path.join(failedDir, 'qbittorrent.json') });
	saveConfig(failedDir, { url: failedMock.base });
	const denied = await failed.list();
	assert.equal(denied.state, 'auth-failed');
	assert.equal(denied.rows.length, 0);
	const logins = failedMock.state.calls.filter(call => call.path === '/api/v2/auth/login').length;
	assert.equal(logins, 1);
	const again = await failed.list();
	assert.equal(again.state, 'backoff');
	assert.equal(failedMock.state.calls.filter(call => call.path === '/api/v2/auth/login').length, logins, 'error backoff prevents a login loop');
});

test('filter names follow the detected WebUI API version', async t => {
	const legacyMock = await startMock(t);
	legacyMock.state.webapiVersion = '2.8.0';
	const legacyDir = directory(t);
	const legacy = createQbittorrent({ file: path.join(legacyDir, 'qbittorrent.json') });
	saveConfig(legacyDir, { url: legacyMock.base });
	await legacy.list({ filter: 'paused', limit: 10 });
	const legacyInfo = legacyMock.state.calls.filter(call => call.path === '/api/v2/torrents/info').at(-1);
	assert.equal(new URL('http://mock' + legacyInfo.url).searchParams.get('filter'), 'paused');

	const modernMock = await startMock(t);
	modernMock.state.webapiVersion = '2.11.2';
	const modernDir = directory(t);
	const modern = createQbittorrent({ file: path.join(modernDir, 'qbittorrent.json') });
	saveConfig(modernDir, { url: modernMock.base });
	await modern.list({ filter: 'paused', limit: 10 });
	const modernInfo = modernMock.state.calls.filter(call => call.path === '/api/v2/torrents/info').at(-1);
	assert.equal(new URL('http://mock' + modernInfo.url).searchParams.get('filter'), 'stopped');
});

test('a failed refresh keeps a clearly marked last-good reading and backs off', async t => {
	const mock = await startMock(t);
	const dir = directory(t);
	let now = 1800000000000;
	const qb = createQbittorrent({ file: path.join(dir, 'qbittorrent.json'), clock: () => now });
	saveConfig(dir, { url: mock.base });
	let data = await qb.list();
	assert.equal(data.state, 'ok');
	const goodAt = data.upstreamAt;
	mock.state.infoStatus = 503;
	now += 16 * 1000;
	data = await qb.list();
	assert.equal(data.state, 'stale');
	assert.equal(data.stale, true);
	assert.equal(data.reachable, false);
	assert.equal(data.upstreamAt, goodAt);
	assert.equal(data.rows.length, 1);
	assert.match(data.notice, /last good/i);
	const infoCalls = mock.state.calls.filter(call => call.path === '/api/v2/torrents/info').length;
	now += 16 * 1000;
	const backedOff = await qb.list();
	assert.equal(backedOff.state, 'stale');
	assert.equal(mock.state.calls.filter(call => call.path === '/api/v2/torrents/info').length, infoCalls, 'error backoff skips the next upstream attempt');
});

test('oversized responses are refused and a confirmation expires', async t => {
	const mock = await startMock(t);
	mock.state.torrents = [torrent(HASH_A, { name: 'x'.repeat(400), tracker: 'https://tracker.example/' + 'y'.repeat(2000) })];
	const dir = directory(t);
	const qb = createQbittorrent({ file: path.join(dir, 'qbittorrent.json'), maxBody: 300 });
	saveConfig(dir, { url: mock.base });
	const first = await qb.list();
	assert.equal(first.state, 'too-large');
	assert.equal(first.rows.length, 0);

	const smallDir = directory(t);
	const smallMock = await startMock(t);
	let now = 1800000000000;
	const small = createQbittorrent({ file: path.join(smallDir, 'qbittorrent.json'), clock: () => now });
	saveConfig(smallDir, { url: smallMock.base });
	const data = await small.list();
	const review = await small.confirmation({ id: data.rows[0].id, action: 'remove', sessionToken: SESSION_A });
	now += 61000;
	await expectCode(small.commit({ token: review.token, sessionToken: SESSION_A }), 'replay');
	assert.equal(deleteCalls(smallMock.state).length, 0, 'an expired confirmation cannot delete');
});

test('stalled detection requires measured no-progress and excludes non-download states', async t => {
	const mock = await startMock(t);
	const rows = [
		torrent('1'.repeat(40), { state: 'downloading', progress: 0.4, completed: 400 }),
		torrent('2'.repeat(40), { state: 'stalledDL', progress: 0.2, completed: 200, num_seeds: 0 }),
		torrent('3'.repeat(40), { state: 'metaDL', progress: 0, completed: 0 }),
		torrent('4'.repeat(40), { state: 'pausedDL', progress: 0.1, completed: 100 }),
		torrent('5'.repeat(40), { state: 'queuedDL', progress: 0.1, completed: 100 }),
		torrent('6'.repeat(40), { state: 'checkingDL', progress: 0.1, completed: 100 }),
		torrent('7'.repeat(40), { state: 'moving', progress: 1, completed: 1000 }),
		torrent('8'.repeat(40), { state: 'uploading', progress: 1, completed: 1000 }),
		torrent('9'.repeat(40), { state: 'downloading', progress: 0.4, completed: 400 })
	];
	mock.state.torrents = rows;
	const dir = directory(t);
	let now = 1800000000000;
	const qb = createQbittorrent({ file: path.join(dir, 'qbittorrent.json'), clock: () => now });
	saveConfig(dir, { url: mock.base });
	let data = await qb.list();
	assert.equal(data.rows.filter(row => row.needsAttention).length, 0, 'the first sample starts the window');
	now += 5 * 60 * 1000;
	data = await qb.list();
	assert.equal(data.rows.filter(row => row.needsAttention).length, 0, 'five minutes is shorter than the ten minute window');
	now += 6 * 60 * 1000;
	data = await qb.list();
	const byHash = new Map(data.rows.map(row => [row.displayHash, row]));
	assert.equal(byHash.get('11111111').needsAttention, true);
	assert.equal(byHash.get('22222222').needsAttention, true, 'a measured stall is shown even with zero seeds');
	assert.equal(byHash.get('33333333').needsAttention, false, 'missing metadata is not proof');
	assert.equal(byHash.get('44444444').needsAttention, false);
	assert.equal(byHash.get('55555555').needsAttention, false);
	assert.equal(byHash.get('66666666').needsAttention, false);
	assert.equal(byHash.get('77777777').needsAttention, false);
	assert.equal(byHash.get('88888888').needsAttention, false);
	assert.equal(byHash.get('22222222').stalledHint, true);
	assert.ok(byHash.get('11111111').measuredNoProgressSeconds >= 660);
});

test('delete transmits one exact hash and the correct deleteFiles flag, with one-use tokens', async t => {
	const mock = await startMock(t);
	const dir = directory(t);
	const qb = createQbittorrent({ file: path.join(dir, 'qbittorrent.json') });
	saveConfig(dir, { url: mock.base });
	let data = await qb.list();
	const id = data.rows[0].id;
	const review = await qb.confirmation({ id, action: 'remove', sessionToken: SESSION_A });
	assert.match(review.token, /^[a-f0-9]{64}$/);
	assert.equal(JSON.stringify(review).includes(HASH_A), false, 'the exact hash never reaches the browser');
	const removed = await qb.commit({ token: review.token, sessionToken: SESSION_A });
	assert.equal(removed.ok, true);
	assert.equal(removed.deleteFiles, false);
	assert.equal(removed.files, 'kept');
	let deletes = deleteCalls(mock.state);
	assert.equal(deletes.length, 1);
	assert.equal(deletes[0].method, 'POST');
	const form = new URLSearchParams(deletes[0].body);
	assert.equal(form.get('hashes'), HASH_A);
	assert.equal(form.get('hashes').includes('|'), false);
	assert.equal(form.get('hashes').includes('all'), false);
	assert.equal(form.get('deleteFiles'), 'false');
	assert.equal(deletes[0].headers['content-type'], 'application/x-www-form-urlencoded');
	assert.equal(deletes[0].headers.referer, mock.base + '/');
	await expectCode(qb.commit({ token: review.token, sessionToken: SESSION_A }), 'replay');
	assert.equal(deleteCalls(mock.state).length, 1, 'a replay never sends a second delete');

	// A separate explicit destructive action uses deleteFiles=true.
	mock.state.torrents = [torrent(HASH_B)];
	data = await qb.list({ filter: 'completed' });
	const deleteReview = await qb.confirmation({ id: data.rows[0].id, action: 'delete-files', sessionToken: SESSION_A });
	const deleted = await qb.commit({ token: deleteReview.token, sessionToken: SESSION_A });
	assert.equal(deleted.ok, true);
	assert.equal(deleted.deleteFiles, true);
	assert.equal(deleted.files, 'delete-requested');
	deletes = deleteCalls(mock.state);
	assert.equal(deletes.length, 2);
	assert.equal(new URLSearchParams(deletes[1].body).get('deleteFiles'), 'true');
	assert.equal(new URLSearchParams(deletes[1].body).get('hashes'), HASH_B);
});

test('wrong session, source change, race, and missing targets are refused before delete', async t => {
	const mock = await startMock(t);
	const dir = directory(t);
	const qb = createQbittorrent({ file: path.join(dir, 'qbittorrent.json') });
	saveConfig(dir, { url: mock.base });
	let data = await qb.list();
	const id = data.rows[0].id;

	let review = await qb.confirmation({ id, action: 'remove', sessionToken: SESSION_A });
	await expectCode(qb.commit({ token: review.token, sessionToken: SESSION_B }), 'replay');
	assert.equal(deleteCalls(mock.state).length, 0);

	review = await qb.confirmation({ id, action: 'remove', sessionToken: SESSION_A });
	qb.disconnect();
	await expectCode(qb.commit({ token: review.token, sessionToken: SESSION_A }), 'source-changed');
	assert.equal(deleteCalls(mock.state).length, 0);

	saveConfig(dir, { url: mock.base });
	data = await qb.list();
	const raceId = data.rows[0].id;
	review = await qb.confirmation({ id: raceId, action: 'remove', sessionToken: SESSION_A });
	mock.state.torrents[0] = { ...mock.state.torrents[0], size: 9999, state: 'pausedDL' };
	await expectCode(qb.commit({ token: review.token, sessionToken: SESSION_A }), 'changed');
	assert.equal(deleteCalls(mock.state).length, 0);

	mock.state.torrents = [torrent(HASH_A)];
	data = await qb.list({ filter: 'all' });
	review = await qb.confirmation({ id: data.rows[0].id, action: 'remove', sessionToken: SESSION_A });
	mock.state.torrents = [];
	const gone = await qb.commit({ token: review.token, sessionToken: SESSION_A });
	assert.equal(gone.ok, false);
	assert.equal(gone.outcome, 'not-found');
	assert.equal(deleteCalls(mock.state).length, 0);

	await expectCode(qb.confirmation({ id: '0'.repeat(32), action: 'remove', sessionToken: SESSION_A }), 'not-found');
	await expectCode(qb.confirmation({ id: data.rows[0].id, action: 'all', sessionToken: SESSION_A }), 'invalid');
});

test('an auth failure or timeout after review never repeats the destructive request', async t => {
	const mock = await startMock(t);
	const dir = directory(t);
	const qb = createQbittorrent({ file: path.join(dir, 'qbittorrent.json') });
	saveConfig(dir, { url: mock.base });
	let data = await qb.list();
	let review = await qb.confirmation({ id: data.rows[0].id, action: 'remove', sessionToken: SESSION_A });
	mock.state.deleteStatus = 401;
	await expectCode(qb.commit({ token: review.token, sessionToken: SESSION_A }), 'auth-failed');
	assert.equal(deleteCalls(mock.state).length, 1, 'no re-auth retry of a destructive POST');

	mock.state.deleteStatus = 200;
	mock.state.deleteBlocked = true;
	const timeoutDir = directory(t);
	const timeoutMock = await startMock(t);
	timeoutMock.state.deleteBlocked = true;
	const timeoutQb = createQbittorrent({ file: path.join(timeoutDir, 'qbittorrent.json'), timeoutMs: 150 });
	saveConfig(timeoutDir, { url: timeoutMock.base });
	data = await timeoutQb.list();
	review = await timeoutQb.confirmation({ id: data.rows[0].id, action: 'remove', sessionToken: SESSION_A });
	const result = await timeoutQb.commit({ token: review.token, sessionToken: SESSION_A });
	assert.equal(result.ok, false);
	assert.equal(result.outcome, 'unknown');
	assert.equal(result.needsRecheck, true);
	assert.equal(deleteCalls(timeoutMock.state).length, 1);
	timeoutMock.state.deleteRelease?.();
	await new Promise(resolve => setTimeout(resolve, 250));
	assert.equal(deleteCalls(timeoutMock.state).length, 1, 'a timeout is never retried automatically');
});

test('configuration tests an enabled target, keeps saved secrets, and never tests a disabled integration', async t => {
	const mock = await startMock(t);
	const dir = directory(t);
	const qb = createQbittorrent({ file: path.join(dir, 'qbittorrent.json') });
	let status = await qb.configure({ url: mock.base, username: 'owner', password: PASSWORD, enabled: true, pollSeconds: 20, stalledMinutes: 30 });
	assert.equal(status.configured, true);
	assert.equal(status.enabled, true);
	assert.equal(status.webapiVersion, '2.11.2');
	assert.ok(mock.state.calls.some(call => call.path === '/api/v2/auth/login'));
	await expectCode(qb.configure({ url: 'ftp://qbit.example', enabled: true }), 'invalid-target');
	const beforeDisable = mock.state.calls.length;
	status = await qb.configure({ enabled: false });
	assert.equal(status.enabled, false);
	assert.equal(status.state, 'disabled');
	assert.equal(mock.state.calls.length, beforeDisable, 'saving a disabled integration makes no qBittorrent request');
	const saved = JSON.parse(readFileSync(path.join(dir, 'qbittorrent.json'), 'utf8'));
	assert.equal(saved.password, PASSWORD, 'a blank password keeps the saved secret');
	assert.equal(saved.url, mock.base);
});

test('URL and hash validation rejects credentials, redirects, wildcards and bulk values', () => {
	assert.equal(normalizeWebUiUrl('http://127.0.0.1:8080/qb/'), 'http://127.0.0.1:8080/qb');
	assert.equal(normalizeWebUiUrl('https://qbit.example'), 'https://qbit.example');
	for (const bad of ['ftp://qbit.example', 'http://user:pass@qbit.example', 'http://qbit.example/?x=1', 'http://qbit.example/#x', 'qbit.example', '']) {
		assert.throws(() => normalizeWebUiUrl(bad), error => error.code === 'invalid-target');
	}
	assert.equal(isExactHash('a'.repeat(40)), true);
	assert.equal(isExactHash('c'.repeat(64)), true);
	assert.equal(isExactHash('a'.repeat(36)), true);
	assert.equal(isExactHash('a'.repeat(41)), false);
	assert.equal(isExactHash('a'.repeat(63)), false);
	assert.equal(isExactHash('a'.repeat(35)), false);
	for (const bad of ['', 'all', 'ALL', '*', 'a'.repeat(40) + '|' + 'b'.repeat(40), 'a'.repeat(40) + ',', 'a'.repeat(40) + 'b']) {
		assert.equal(isExactHash(bad), false, bad);
	}
});
