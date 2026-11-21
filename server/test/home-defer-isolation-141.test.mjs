/* Release 141: the deferred Continue route is per-viewer.
 *
 * Two approved app tokens on the same server send the same context body. The
 * deferred Home route returns no Continue row for either, and the dedicated
 * Continue route returns only the caller's own row. A repeat is served from
 * that viewer's own memo entry; the other viewer's entry is never reused.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';

const tokenA = 'a'.repeat(64);
const tokenB = 'b'.repeat(64);
const deviceA = 'c'.repeat(32);
const deviceB = 'd'.repeat(32);
const digest = value => createHash('sha256').update(value).digest('hex');
const movie = (id, name) => ({ Id: id, Name: name, Type: 'Movie', Genres: ['Drama'], RunTimeTicks: 7200e7 });
const filmA = movie('11111111111111111111111111111111', 'Viewer A Film');
const filmB = movie('22222222222222222222222222222222', 'Viewer B Film');

test('the deferred Continue route returns only the caller own row for each viewer', { timeout: 45000 }, async t => {
	const directory = mkdtempSync(path.join(os.tmpdir(), 'home-defer-isolation-141-'));
	const servers = [];
	const listen = handler => new Promise(resolve => {
		const server = http.createServer(handler);
		server.listen(0, '127.0.0.1', () => { servers.push(server); resolve(server); });
	});
	const jellyfin = await listen((req, res) => {
		const url = new URL(req.url, 'http://127.0.0.1');
		res.setHeader('Content-Type', 'application/json');
		if (url.pathname === '/Items') return res.end(JSON.stringify({ Items: [filmA, filmB], TotalRecordCount: 2 }));
		const item = /^\/Users\/[^/]+\/Items\/([^/]+)$/.exec(url.pathname);
		if (item) {
			const found = [filmA, filmB].find(entry => entry.Id === decodeURIComponent(item[1]));
			if (!found) { res.statusCode = 404; return res.end('{}'); }
			return res.end(JSON.stringify(found));
		}
		if (url.pathname.startsWith('/Users/')) return res.end(JSON.stringify({ Items: [] }));
		res.end('{}');
	});
	const local = await listen();
	// No PORT override: these authenticated calls take the remote person/device
	// path, which is the one that must never reuse another viewer's history.
	Object.assign(process.env, {
		NODE_ENV: 'test', AUTH_DIR: directory, DATA_DIR: directory,
		JELLYFIN_URL: `http://127.0.0.1:${jellyfin.address().port}`,
		DISPATCHARR_URL: 'http://127.0.0.1:1',
		LOCAL_HOSTS: '127.0.0.1', LOCAL_NETWORKS: '127.0.0.0/8',
		PUBLIC_ORIGIN: 'https://remote.test', TELLYBOX_HOME_TIMING: '1'
	});
	writeFileSync(path.join(directory, 'connection.json'), JSON.stringify({ userId: 'test', token: 'fixture-only' }));
	const now = Date.now();
	writeFileSync(path.join(directory, 'apps.json'), JSON.stringify({
		[digest(tokenA)]: { id: deviceA, name: 'Viewer A device', status: 'approved', role: 'viewer', created: now, approved: now, expires: now + 3600000 },
		[digest(tokenB)]: { id: deviceB, name: 'Viewer B device', status: 'approved', role: 'viewer', created: now, approved: now, expires: now + 3600000 }
	}));
	writeFileSync(path.join(directory, 'account-limits.json'), JSON.stringify({ accounts: {} }));
	writeFileSync(path.join(directory, 'activity.json'), JSON.stringify([
		{ id: 'a-play', type: 'playback', deviceId: deviceA, itemId: filmA.Id, state: 'stopped', position: 1200, duration: 7200, time: now, updated: now },
		{ id: 'b-play', type: 'playback', deviceId: deviceB, itemId: filmB.Id, state: 'stopped', position: 2400, duration: 7200, time: now, updated: now }
	]));
	(await import('./enabled-fixture.mjs')).enableIntegrations();
	const { app } = await import('../server.mjs');
	local.on('request', app);
	const base = `http://127.0.0.1:${local.address().port}`;
	const post = (route, token, body) => fetch(base + route, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Origin: base, Authorization: 'Bearer ' + token },
		body: JSON.stringify(body)
	});
	t.after(() => {
		for (const server of servers) { server.closeAllConnections(); server.close(); }
		rmSync(directory, { recursive: true, force: true });
	});

	const continueIds = feed => ((feed.rows || []).find(row => row.id === 'continue')?.items || []).map(item => item.Id);

	// Both deferred feeds are row-only for their own viewer.
	for (const token of [tokenA, tokenB]) {
		const response = await post('/api/web/home', token, { deferContinue: true });
		const text = await response.clone().text();
		assert.equal(response.status, 200, text);
		const feed = JSON.parse(text);
		assert.equal(feed.continuePending, true);
		assert.equal((feed.rows || []).some(row => row.id === 'continue'), false, 'no Continue row is in the deferred feed');
		assert.equal(response.headers.get('cache-control'), 'no-store');
	}

	const continueA = await post('/api/web/home/continue', tokenA, {});
	const continueAText = await continueA.clone().text();
	assert.equal(continueA.status, 200, continueAText);
	assert.equal(continueA.headers.get('cache-control'), 'no-store');
	const feedA = JSON.parse(continueAText);
	assert.deepEqual(feedA.rows.map(row => row.id), ['continue'], 'the dedicated route returns only Continue');
	assert.deepEqual(continueIds(feedA), [filmA.Id], 'viewer A sees only its own Continue item');
	assert.equal(feedA.continuePending, false);

	const continueB = await post('/api/web/home/continue', tokenB, {});
	const continueBText = await continueB.clone().text();
	assert.equal(continueB.status, 200, continueBText);
	const feedB = JSON.parse(continueBText);
	assert.deepEqual(continueIds(feedB), [filmB.Id], 'viewer B sees only its own Continue item');
	assert.ok(!continueIds(feedB).includes(filmA.Id), 'viewer A data never leaks into viewer B');
	assert.ok(!continueIds(feedA).includes(filmB.Id), 'viewer B data never leaks into viewer A');

	// A repeat is this viewer's own memo entry, not the other viewer's.
	const repeatA = await post('/api/web/home/continue', tokenA, {});
	const repeatAText = await repeatA.clone().text();
	assert.equal(JSON.parse(repeatA.headers.get('x-tellybox-home-timing') || 'null')?.memoHit, true,
		'the repeat reuses viewer A own Continue memo');
	const repeatFeedA = JSON.parse(repeatAText);
	assert.deepEqual(continueIds(repeatFeedA), [filmA.Id], 'the memo entry still belongs to viewer A');

	// The flag-less (native) path keeps a single complete response and the same
	// isolation, so the new route did not change its contract.
	const fullA = await post('/api/web/home', tokenA, {});
	const fullAText = await fullA.clone().text();
	assert.equal(fullA.status, 200, fullAText);
	const fullFeedA = JSON.parse(fullAText);
	assert.equal(fullFeedA.continuePending, undefined, 'the flag-less response keeps its old shape');
	assert.deepEqual(continueIds(fullFeedA), [filmA.Id], 'the complete response still has only viewer A Continue');
	assert.ok(!continueIds(fullFeedA).includes(filmB.Id), 'the complete response never leaks viewer B');
});
