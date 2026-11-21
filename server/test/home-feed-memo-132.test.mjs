/* Release 132: Home feed memo isolation and static validator headers.
 *
 * The Home response is memoised for a short time to remove repeated catalogue
 * and playability work. This fixture proves the memo is per-viewer: two app
 * tokens with the same request body must each receive their own Continue row,
 * and a repeat for the first viewer reuses its own entry. It also proves the
 * page shell keeps a validator without becoming a browser-shared cache and
 * that the vendored HLS bundle is immutable while APIs stay no-store.
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

test('the Home memo isolates viewers and the shell keeps revalidated cache headers', { timeout: 45000 }, async t => {
	const directory = mkdtempSync(path.join(os.tmpdir(), 'home-feed-memo-132-'));
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
	t.after(() => {
		for (const server of servers) { server.closeAllConnections(); server.close(); }
		rmSync(directory, { recursive: true, force: true });
	});

	const home = token => fetch(base + '/api/web/home', {
		method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base, Authorization: 'Bearer ' + token },
		body: '{}'
	});
	const continueIds = feed => ((feed.rows || []).find(row => row.id === 'continue')?.items || []).map(item => item.Id);

	const startedA = performance.now();
	const firstA = await home(tokenA);
	const coldMs = performance.now() - startedA;
	assert.equal(firstA.status, 200, await firstA.clone().text());
	assert.equal(firstA.headers.get('cache-control'), 'no-store', 'the personalized response is never browser-cached');
	assert.notEqual(JSON.parse(firstA.headers.get('x-tellybox-home-timing') || 'null')?.memoHit, true, 'the first build is not a memo hit');
	const feedA = await firstA.json();
	assert.deepEqual(continueIds(feedA), [filmA.Id], 'viewer A sees only its own Continue item');

	const firstB = await home(tokenB);
	assert.equal(firstB.status, 200, await firstB.clone().text());
	assert.notEqual(JSON.parse(firstB.headers.get('x-tellybox-home-timing') || 'null')?.memoHit, true, 'another viewer never shares the first entry');
	const feedB = await firstB.json();
	assert.deepEqual(continueIds(feedB), [filmB.Id], 'viewer B sees only its own Continue item');
	assert.ok(!continueIds(feedB).includes(filmA.Id), 'viewer A data never leaks into viewer B');

	const repeatStarted = performance.now();
	const repeatA = await home(tokenA);
	const warmMs = performance.now() - repeatStarted;
	assert.equal(repeatA.status, 200);
	assert.equal(JSON.parse(repeatA.headers.get('x-tellybox-home-timing') || 'null')?.memoHit, true, 'the repeat reuses the same viewer entry');
	assert.ok(warmMs < Math.max(50, coldMs / 2), 'the memo skips the rebuild work: cold ' + Math.round(coldMs) + 'ms, warm ' + Math.round(warmMs) + 'ms');
	const repeatFeedA = await repeatA.json();
	assert.deepEqual(continueIds(repeatFeedA), [filmA.Id], 'the repeat still belongs to viewer A');
	assert.deepEqual(repeatFeedA.rows.map(row => [row.id, row.items.map(item => item.Id)]),
		feedA.rows.map(row => [row.id, row.items.map(item => item.Id)]), 'a memo hit returns the same rows and items');
	assert.equal(repeatFeedA.availability.checked, 0, 'a memo hit reports no fresh series checks');

	const otherContext = await fetch(base + '/api/web/home', {
		method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base, Authorization: 'Bearer ' + tokenA },
		body: JSON.stringify({ taste: { genres: [{ name: 'Comedy', weight: 4 }], exclude: [] } })
	});
	assert.equal(otherContext.status, 200, await otherContext.clone().text());
	assert.notEqual(JSON.parse(otherContext.headers.get('x-tellybox-home-timing') || 'null')?.memoHit, true,
		'a different request-body context is a different entry');
	await otherContext.json();

	// The source fingerprint is part of the key, so a configuration change
	// cannot reuse the old catalogue build.
	writeFileSync(path.join(directory, 'dispatcharr.json'), JSON.stringify({ key: 'changed-fixture-only' }));
	const afterRefresh = await home(tokenA);
	assert.equal(afterRefresh.status, 200);
	assert.notEqual(JSON.parse(afterRefresh.headers.get('x-tellybox-home-timing') || 'null')?.memoHit, true,
		'a source/catalogue fingerprint change invalidates the entry');
	await afterRefresh.json();

	for (const [file, expected] of [
		['app.js', 'max-age=0, must-revalidate'],
		['style.css', 'max-age=0, must-revalidate'],
		['home-124.css', 'max-age=0, must-revalidate'],
		['tellybox-logo.png', 'max-age=0, must-revalidate'],
		['tellybox-logo.webp', 'max-age=0, must-revalidate'],
		['vendor/hls.min.js', 'public, max-age=31536000, immutable']
	]) {
		const response = await fetch(base + '/' + file, { headers: { Authorization: 'Bearer ' + tokenA } });
		assert.equal(response.status, 200, file + ' is served');
		assert.equal(response.headers.get('cache-control'), expected, file + ' cache policy');
		assert.ok(response.headers.get('etag'), file + ' keeps a validator');
		await response.arrayBuffer();
	}
	assert.ok((await fetch(base + '/tellybox-logo.webp')).headers.get('content-type')?.includes('image/webp'));

	// The cache headers did not move the gated scripts in front of auth.
	assert.equal((await fetch(base + '/app.js')).status, 401, 'app.js still requires a signed-in viewer');
	assert.equal((await fetch(base + '/home-124.css')).status, 401, 'home CSS still requires a signed-in viewer');
	assert.equal((await fetch(base + '/style.css')).status, 200, 'the login stylesheet stays public as before');
	assert.equal((await fetch(base + '/tellybox-logo.png')).status, 200, 'the login logo stays public as before');
});
