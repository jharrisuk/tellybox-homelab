import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';

const token = 'e'.repeat(64);
const deviceId = 'f'.repeat(32);
const digest = value => createHash('sha256').update(value).digest('hex');
const genres = ['Drama', 'Comedy', 'Documentary', 'Crime'];
const movies = Array.from({ length: 30 }, (_, index) => ({
	Id: index.toString(16).padStart(32, '0'),
	Name: 'Private fixture ' + index,
	Type: 'Movie',
	Genres: [genres[index % genres.length]],
	ProviderIds: { Tmdb: String(9000 + index) },
	RunTimeTicks: 7200e7,
	CommunityRating: 7,
	Overview: 'shared provider synopsis that the app does not need '.repeat(20),
	UserData: { Played: true, PlaybackPositionTicks: 123456789, IsFavorite: true },
	Played: true
}));

test('the app recommendation route never returns shared Jellyfin playback state', { timeout: 30000 }, async t => {
	const directory = mkdtempSync(path.join(os.tmpdir(), 'recommendation-privacy-'));
	const servers = [];
	const listen = handler => new Promise(resolve => {
		const server = http.createServer(handler);
		server.listen(0, '127.0.0.1', () => { servers.push(server); resolve(server); });
	});
	const upstream = await listen((req, res) => {
		const url = new URL(req.url, 'http://127.0.0.1');
		res.setHeader('Content-Type', 'application/json');
		if (url.pathname === '/Items') return res.end(JSON.stringify({ Items: movies, TotalRecordCount: movies.length }));
		if (url.pathname.startsWith('/Users/')) return res.end(JSON.stringify({ Items: [] }));
		res.end('{}');
	});
	const local = await listen();
	Object.assign(process.env, {
		NODE_ENV: 'test', AUTH_DIR: directory, DATA_DIR: directory,
		JELLYFIN_URL: `http://127.0.0.1:${upstream.address().port}`,
		DISPATCHARR_URL: 'http://127.0.0.1:1',
		LOCAL_HOSTS: '127.0.0.1', LOCAL_NETWORKS: '127.0.0.0/8',
		PUBLIC_ORIGIN: 'https://remote.test'
	});
	writeFileSync(path.join(directory, 'connection.json'), JSON.stringify({ userId: 'test', token: 'fixture-only' }));
	writeFileSync(path.join(directory, 'apps.json'), JSON.stringify({
		[digest(token)]: { id: deviceId, name: 'Privacy fixture', status: 'approved', role: 'viewer', created: Date.now(), approved: Date.now(), expires: Date.now() + 3600000 }
	}));
	writeFileSync(path.join(directory, 'account-limits.json'), JSON.stringify({ accounts: {} }));
	writeFileSync(path.join(directory, 'remote-controls.json'), JSON.stringify({ enabled: true, vod: true, nonstop: true }));
	(await import('./enabled-fixture.mjs')).enableIntegrations();
	const { app } = await import('../server.mjs');
	local.on('request', app);
	const base = `http://127.0.0.1:${local.address().port}`;
	const get = () => fetch(base + '/api/web/recommendations?limit=600', {
		headers: { Origin: base, Authorization: 'Bearer ' + token }
	});
	t.after(() => {
		for (const server of servers) { server.closeAllConnections(); server.close(); }
		rmSync(directory, { recursive: true, force: true });
	});

	const first = await get();
	const text = await first.clone().text();
	assert.equal(first.status, 200, text);
	assert.ok(!text.includes('PlaybackPositionTicks'), 'shared playback position is not serialized');
	assert.ok(!text.includes('IsFavorite'), 'shared favourite flag is not serialized');
	assert.ok(!text.includes('shared provider synopsis'), 'provider synopsis is not returned to the phone');
	const body = await first.json();
	assert.equal(body.items.length, movies.length);
	for (const item of body.items) {
		assert.equal(item.UserData, undefined);
		assert.equal(item.Played, undefined);
		assert.equal(item.PlaybackPositionTicks, undefined);
		assert.equal(item.Overview, undefined);
		assert.ok(item.Id && item.Name && Array.isArray(item.Genres));
	}

	// A restrictive allowance is handled elsewhere by account-limits tests; the
	// pool must already contain only safe fields before any client sees it.
});
