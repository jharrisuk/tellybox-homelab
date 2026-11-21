/* Release 106 route contract for POST /api/web/similar and the GET equivalent.
 *
 * The catalogue is a synthetic persisted Dispatcharr snapshot, so this test
 * exercises the real permission, history and response-shaping path without any
 * provider or production request.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';

const viewerToken = 'e'.repeat(64);
const adminToken = 'f'.repeat(64);
const viewerDevice = '2'.repeat(32);
const adminDevice = '3'.repeat(32);
const digest = value => createHash('sha256').update(value).digest('hex');

test('similar titles route filters permissions, uses own history and returns safe cards', { timeout: 30000 }, async t => {
	const directory = mkdtempSync(path.join(os.tmpdir(), 'similar-titles-route-'));
	const servers = [];
	const listen = handler => new Promise(resolve => {
		const server = http.createServer(handler);
		server.listen(0, '127.0.0.1', () => { servers.push(server); resolve(server); });
	});
	const upstream = await listen((req, res) => {
		res.setHeader('Content-Type', 'application/json');
		res.end(JSON.stringify({ Items: [], TotalRecordCount: 0 }));
	});
	const dispatcharr = await listen((req, res) => {
		res.setHeader('Content-Type', 'application/json');
		res.end(JSON.stringify({ results: [], next: null, page: 1 }));
	});
	const local = await listen();
	const now = Date.now();
	const catalogue = [
		{ Id: 'dispatch-movie-1', Name: 'Seed film', Type: 'Movie', Source: 'streamed', Provider: 'Dispatcharr', Genres: ['Drama'], Overview: 'A quiet family drama', ProviderIds: { Tmdb: '700001' }, Artwork: '/api/web/art/movie/1', VodIds: [1], UserData: { Played: false } },
		...Array.from({ length: 8 }, (_, index) => ({
			Id: 'dispatch-movie-' + (index + 2), Name: 'Drama title ' + (index + 1), Type: 'Movie', Source: 'streamed', Provider: 'Dispatcharr',
			Genres: ['Drama'], Overview: 'Another family drama', ProviderIds: { Tmdb: String(700002 + index) },
			Artwork: '/api/web/art/movie/' + (index + 2), VodIds: [index + 2], UserData: { Played: true, PlaybackPositionTicks: 999 }
		})),
		{ Id: 'dispatch-movie-20', Name: 'Comedy title', Type: 'Movie', Source: 'streamed', Provider: 'Dispatcharr', Genres: ['Comedy'], ProviderIds: { Tmdb: '700020' }, Artwork: '/api/web/art/movie/20', VodIds: [20], UserData: {} },
		{ Id: 'dispatch-movie-21', Name: 'Horror title', Type: 'Movie', Source: 'streamed', Provider: 'Dispatcharr', Genres: ['Horror'], ProviderIds: { Tmdb: '700021' }, Artwork: '/api/web/art/movie/21', VodIds: [21], UserData: {} }
	];
	Object.assign(process.env, {
		NODE_ENV: 'test', AUTH_DIR: directory, DATA_DIR: directory,
		JELLYFIN_URL: `http://127.0.0.1:${upstream.address().port}`,
		DISPATCHARR_URL: `http://127.0.0.1:${dispatcharr.address().port}`,
		LOCAL_HOSTS: '127.0.0.1', LOCAL_NETWORKS: '127.0.0.0/8',
		PUBLIC_ORIGIN: 'https://remote.test'
	});
	writeFileSync(path.join(directory, 'connection.json'), JSON.stringify({ userId: 'test', token: 'fixture-only' }));
	writeFileSync(path.join(directory, 'apps.json'), JSON.stringify({
		[digest(viewerToken)]: { id: viewerDevice, name: 'Similar viewer', status: 'approved', role: 'viewer', created: now, approved: now, expires: now + 3600000 },
		[digest(adminToken)]: { id: adminDevice, name: 'Similar admin', status: 'approved', role: 'admin', created: now, approved: now, expires: now + 3600000 }
	}));
	writeFileSync(path.join(directory, 'account-limits.json'), JSON.stringify({ accounts: {} }));
	writeFileSync(path.join(directory, 'remote-controls.json'), JSON.stringify({ enabled: true, vod: true, nonstop: true }));
	writeFileSync(path.join(directory, 'dispatcharr.json'), JSON.stringify({ key: 'fixture-only' }));
	writeFileSync(path.join(directory, 'vod-catalogue.json'), JSON.stringify({ items: catalogue, time: now }));
	writeFileSync(path.join(directory, 'activity.json'), JSON.stringify([{
		id: 'fixture-history', type: 'playback', deviceId: viewerDevice, deviceName: 'Similar viewer',
		itemId: 'dispatch-movie-2', title: 'Previously watched drama', genres: ['Drama'],
		position: 120, duration: 6000, state: 'playing', time: now, updated: now
	}]));
	(await import('./enabled-fixture.mjs')).enableIntegrations();
	const { app } = await import('../server.mjs');
	local.on('request', app);
	const base = `http://127.0.0.1:${local.address().port}`;
	t.after(() => {
		for (const server of servers) { server.closeAllConnections(); server.close(); }
		rmSync(directory, { recursive: true, force: true });
	});
	const call = (method, route, body, token = viewerToken) => fetch(base + route, {
		method,
		headers: { 'Content-Type': 'application/json', Origin: base, Authorization: 'Bearer ' + token },
		...(body === undefined ? {} : { body: JSON.stringify(body) })
	});

	const post = await call('POST', '/api/web/similar', {
		id: 'dispatch-movie-1',
		limit: 6,
		taste: { genres: [{ name: 'Drama', weight: 3 }], exclude: [] },
		favourites: [],
		watched: []
	});
	assert.equal(post.status, 200, await post.clone().text());
	const posted = await post.json();
	assert.ok(Array.isArray(posted.items));
	assert.equal(posted.items.length, 6);
	assert.ok(!posted.items.some(item => item.Id === 'dispatch-movie-1'), 'the seed is excluded');
	assert.ok(posted.items.every(item => item.reason === 'Because you like drama'));
	const serialized = JSON.stringify(posted);
	assert.ok(!/UserData|PlaybackPositionTicks|"Overview"|_score/.test(serialized), 'only safe display fields are returned');
	assert.ok(!serialized.includes('Seed film'), 'the seed title is not echoed');
	for (const item of posted.items) {
		assert.ok(item.Id && item.Name && item.Type && item.reason);
		assert.equal('UserData' in item, false);
	}

	const bodyless = await call('POST', '/api/web/similar', { id: 'dispatch-movie-1', limit: 4, taste: null });
	assert.equal(bodyless.status, 200, await bodyless.clone().text());
	const bodylessResults = await bodyless.json();
	assert.equal(bodylessResults.items.length, 4);
	assert.ok(bodylessResults.items.every(item => item.reason === 'Because you like drama'), 'body-less POST uses the caller history');

	const get = await call('GET', '/api/web/items/dispatch-movie-1/similar?limit=4');
	assert.equal(get.status, 200, await get.clone().text());
	const historyResults = await get.json();
	assert.equal(historyResults.items.length, 4);
	assert.ok(historyResults.items.every(item => item.reason === 'Because you like drama'), 'the GET route uses the caller activity history');

	const disable = await call('POST', '/api/remote-controls', { enabled: true, vod: false, nonstop: true }, adminToken);
	assert.equal(disable.status, 200, await disable.clone().text());
	const blocked = await call('POST', '/api/web/similar', { id: 'dispatch-movie-1', limit: 6 });
	assert.equal(blocked.status, 200);
	assert.deepEqual((await blocked.json()).items, [], 'remote film access policy filters the section');
	const restore = await call('POST', '/api/remote-controls', { enabled: true, vod: true, nonstop: true }, adminToken);
	assert.equal(restore.status, 200);

	const missing = await call('POST', '/api/web/similar', { limit: 6 });
	assert.equal(missing.status, 400);
	const oversized = await call('POST', '/api/web/similar', {
		id: 'dispatch-movie-1',
		favourites: Array.from({ length: 1001 }, () => 'dispatch-movie-2')
	});
	assert.equal(oversized.status, 400);
});
