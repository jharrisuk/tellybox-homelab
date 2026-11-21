import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';

const token = '3'.repeat(64);
const deviceId = '4'.repeat(32);
const digest = value => createHash('sha256').update(value).digest('hex');
const id = (index, prefix = 'a') => (prefix + index.toString(16).padStart(31, '0')).slice(0, 32);
const makeSeries = (index, name, created) => ({ Id: id(index), Name: name, Type: 'Series', Genres: ['Drama'], ProviderIds: { Tmdb: '80' + index }, DateCreated: created, UserData: { Played: false } });
const makeMovie = index => ({ Id: id(index, 'b'), Name: 'Film ' + index, Type: 'Movie', Genres: ['Drama'], ProviderIds: { Tmdb: '90' + index }, DateCreated: '2026-11-01T00:00:00Z', RunTimeTicks: 7200e7, UserData: { Played: false } });

test('a full feed with more than twelve earlier series still checks the priority new row and excludes its empties', { timeout: 30000 }, async t => {
	const empty = [0, 1, 2].map(index => makeSeries(index, 'New empty ' + index, '2026-11-08T20:0' + index + ':00Z'));
	const older = Array.from({ length: 20 }, (_, index) => makeSeries(index + 10, 'Older ' + index, '2026-10-20T20:00:00Z'));
	const film = makeMovie(99);
	const catalogue = [...empty, ...older, film];
	const episodes = new Map();
	for (const series of older) episodes.set(series.Id, [{ Id: id(100 + Number(series.ProviderIds.Tmdb.slice(2))), Name: series.Name + ' episode', Type: 'Episode', SeriesId: series.Id, ParentIndexNumber: 1, IndexNumber: 1, PremiereDate: '2026-10-01', UserData: { Played: false } }]);
	const directory = mkdtempSync(path.join(os.tmpdir(), 'home-playability-full-'));
	const servers = [];
	const listen = handler => new Promise(resolve => {
		const server = http.createServer(handler);
		server.listen(0, '127.0.0.1', () => { servers.push(server); resolve(server); });
	});
	const upstream = await listen((req, res) => {
		const url = new URL(req.url, 'http://127.0.0.1');
		res.setHeader('Content-Type', 'application/json');
		if (url.pathname === '/Items') return res.end(JSON.stringify({ Items: catalogue, TotalRecordCount: catalogue.length }));
		const itemMatch = url.pathname.match(/^\/Users\/[^/]+\/Items\/([^/]+)$/);
		if (itemMatch) {
			const item = catalogue.find(value => value.Id === decodeURIComponent(itemMatch[1]));
			if (!item) { res.statusCode = 404; return res.end('{}'); }
			return res.end(JSON.stringify(item));
		}
		const showMatch = url.pathname.match(/^\/Shows\/([^/]+)\/Episodes$/);
		if (showMatch) return res.end(JSON.stringify({ Items: episodes.get(decodeURIComponent(showMatch[1])) || [] }));
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
		[digest(token)]: { id: deviceId, name: 'Full playability fixture', status: 'approved', role: 'viewer', created: Date.now(), approved: Date.now(), expires: Date.now() + 3600000 }
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
	for (const series of empty) assert.ok(!ids.has(series.Id), 'priority new empty series must be excluded: ' + series.Name);
	assert.ok(ids.has(film.Id), 'film remains');
	const newRow = feed.rows.find(row => row.id === 'new');
	if (newRow) assert.ok(newRow.items.every(item => !empty.some(series => series.Id === item.Id)), 'empty series absent from the new row');
});
