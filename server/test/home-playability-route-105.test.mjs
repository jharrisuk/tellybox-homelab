import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';

const token = '1'.repeat(64);
const deviceId = '2'.repeat(32);
const digest = value => createHash('sha256').update(value).digest('hex');
const id = hex => hex.repeat(32).slice(0, 32);
const series = (suffix, name) => ({ Id: id(suffix), Name: name, Type: 'Series', Genres: ['Drama'], ProviderIds: { Tmdb: '8' + suffix }, DateCreated: '2026-11-08T20:00:00Z', UserData: { Played: false } });
const movie = (suffix, name) => ({ Id: id(suffix), Name: name, Type: 'Movie', Genres: ['Drama'], ProviderIds: { Tmdb: '9' + suffix }, DateCreated: '2026-11-08T19:00:00Z', RunTimeTicks: 7200e7, UserData: { Played: false } });

test('home excludes a confirmed empty series from every rail but keeps available series, films and missing-art titles', { timeout: 30000 }, async t => {
	const emptySeries = series('a', 'Empty series');
	const liveSeries = series('b', 'Live series');
	const film = movie('c', 'Film without artwork');
	const shows = new Map([[emptySeries.Id, []], [liveSeries.Id, [{ Id: id('d'), Name: 'Episode one', Type: 'Episode', SeriesId: liveSeries.Id, ParentIndexNumber: 1, IndexNumber: 1, PremiereDate: '2026-11-01', UserData: { Played: false } }]]]);
	const directory = mkdtempSync(path.join(os.tmpdir(), 'home-playability-route-'));
	const servers = [];
	const listen = handler => new Promise(resolve => {
		const server = http.createServer(handler);
		server.listen(0, '127.0.0.1', () => { servers.push(server); resolve(server); });
	});
	const upstream = await listen((req, res) => {
		const url = new URL(req.url, 'http://127.0.0.1');
		res.setHeader('Content-Type', 'application/json');
		if (url.pathname === '/Items') return res.end(JSON.stringify({ Items: [emptySeries, liveSeries, film], TotalRecordCount: 3 }));
		const itemMatch = url.pathname.match(/^\/Users\/[^/]+\/Items\/([^/]+)$/);
		if (itemMatch) {
			const item = [emptySeries, liveSeries, film].find(value => value.Id === decodeURIComponent(itemMatch[1]));
			if (!item) { res.statusCode = 404; return res.end('{}'); }
			return res.end(JSON.stringify(item));
		}
		const showMatch = url.pathname.match(/^\/Shows\/([^/]+)\/Episodes$/);
		if (showMatch) return res.end(JSON.stringify({ Items: shows.get(decodeURIComponent(showMatch[1])) || [] }));
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
		[digest(token)]: { id: deviceId, name: 'Playability fixture', status: 'approved', role: 'viewer', created: Date.now(), approved: Date.now(), expires: Date.now() + 3600000 }
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
	const response = await fetch(base + '/api/web/home', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Origin: base, Authorization: 'Bearer ' + token },
		body: '{}'
	});
	const text = await response.clone().text();
	assert.equal(response.status, 200, text);
	const feed = await response.json();
	const ids = new Set(feed.rows.flatMap(row => row.items || []).map(item => item.Id));
	assert.ok(!ids.has(emptySeries.Id), 'a confirmed empty series is excluded from the feed');
	assert.ok(ids.has(liveSeries.Id), 'a series with an available episode remains');
	assert.ok(ids.has(film.Id), 'a missing-art film remains');
	const emptyInFeatured = (feed.featured || []).some(item => item.Id === emptySeries.Id);
	assert.equal(emptyInFeatured, false, 'the empty series is also excluded from featured');
});
