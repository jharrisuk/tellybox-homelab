// LATE-FALLBACK-PROOF, route half: the remote catalogue policy snapshot must
// share ONE deadline with the episode lookup. A noncooperative catalogue read
// must not hold Home open, must not be repeated per request, and must not leave
// late episode work behind.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { REQUEST_TIMEOUT_MS } from '../home-episodes.mjs';

const token = '1'.repeat(64);
const deviceId = '3'.repeat(32);
const digest = value => createHash('sha256').update(value).digest('hex');
const liked = 'a'.repeat(32);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test('a noncooperative catalogue snapshot is bounded by the one route deadline', { timeout: 30000 }, async t => {
	const requests = [];
	const servers = [];
	const listen = handler => new Promise(resolve => {
		const server = http.createServer(handler);
		server.listen(0, '127.0.0.1', () => { servers.push(server); resolve(server); });
	});
	const upstream = await listen((req, res) => {
		const url = new URL(req.url, 'http://127.0.0.1');
		requests.push({ pathname: url.pathname, parent: url.searchParams.get('ParentId'), at: Date.now() });
		// The catalogue enumeration never answers: an uncooperative provider.
		if (url.pathname === '/Items' && !url.searchParams.has('ParentId')) return;
		res.setHeader('Content-Type', 'application/json');
		if (url.pathname === '/Items') return res.end(JSON.stringify({ Items: [] }));
		if (/^\/Shows\//.test(url.pathname)) return res.end(JSON.stringify({ Items: [] }));
		return res.end('{}');
	});
	const local = await listen();
	const directory = mkdtempSync(path.join(os.tmpdir(), 'home-episodes-snapshot-'));
	Object.assign(process.env, {
		NODE_ENV: 'test', AUTH_DIR: directory, DATA_DIR: directory,
		JELLYFIN_URL: `http://127.0.0.1:${upstream.address().port}`,
		DISPATCHARR_URL: 'http://127.0.0.1:1',
		LOCAL_HOSTS: '192.0.2.10', LOCAL_NETWORKS: '192.0.2.0/24',
		PUBLIC_ORIGIN: 'https://remote.test', PORT: '8082'
	});
	writeFileSync(path.join(directory, 'connection.json'), JSON.stringify({ userId: 'test', token: 'fixture-only' }));
	writeFileSync(path.join(directory, 'apps.json'), JSON.stringify({
		[digest(token)]: { id: deviceId, name: 'Allowed app', status: 'approved', role: 'viewer', created: Date.now(), approved: Date.now(), expires: Date.now() + 3600000 }
	}));
	writeFileSync(path.join(directory, 'account-limits.json'), JSON.stringify({ accounts: {} }));
	writeFileSync(path.join(directory, 'remote-controls.json'), JSON.stringify({ enabled: true, vod: true, nonstop: true }));
	(await import('./enabled-fixture.mjs')).enableIntegrations();
	const { app } = await import('../server.mjs');
	local.on('request', app);
	const base = `http://127.0.0.1:${local.address().port}`;
	t.after(() => {
		for (const server of servers) { server.closeAllConnections(); server.close(); }
		rmSync(directory, { recursive: true, force: true });
	});

	const url = base + '/api/web/releases/episodes?series=' + encodeURIComponent(liked);
	const started = Date.now();
	const [first, second] = await Promise.all([
		fetch(url, { headers: { Authorization: 'Bearer ' + token } }),
		fetch(url, { headers: { Authorization: 'Bearer ' + token } })
	]);
	const elapsed = Date.now() - started;
	const bodies = await Promise.all([first.json(), second.json()]);

	assert.equal(first.status, 200);
	assert.equal(second.status, 200);
	assert.deepEqual(bodies, [{ items: [] }, { items: [] }], 'a stalled policy snapshot fails closed with a useful empty body');
	assert.equal(first.headers.get('cache-control'), 'no-store');
	assert.ok(elapsed >= REQUEST_TIMEOUT_MS - 250, 'the route waits for its one deadline, took ' + elapsed + 'ms');
	assert.ok(elapsed < REQUEST_TIMEOUT_MS + 1500, 'the route does not hang on the snapshot, took ' + elapsed + 'ms');

	assert.equal(requests.filter(entry => entry.pathname === '/Items' && !entry.parent).length, 1,
		'two concurrent requests share one catalogue read');
	assert.equal(requests.filter(entry => entry.parent || /^\/Shows\//.test(entry.pathname)).length, 0,
		'no episode lookup starts when the policy snapshot misses the deadline');

	const settled = requests.length;
	await sleep(200);
	assert.equal(requests.length, settled, 'no provider work starts after the caller has returned');
});
