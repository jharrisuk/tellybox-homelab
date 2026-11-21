import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';

const token = 'a'.repeat(64);
const deviceId = 'b'.repeat(32);
const digest = value => createHash('sha256').update(value).digest('hex');
const baseItem = (id, name, type, extra = {}) => ({ Id: id, Name: name, Type: type, Genres: ['Drama'], ProviderIds: { Tmdb: String(Number(id[0]) || 1) }, RunTimeTicks: 7200e7, ...extra });
const series = baseItem('11111111111111111111111111111111', 'Long Series', 'Series');
const episodes = [
	baseItem('55555555555555555555555555555555', 'Old episode', 'Episode', { SeriesId: series.Id, SeriesName: series.Name, ParentIndexNumber: 1, IndexNumber: 1, RunTimeTicks: 3000e7 }),
	baseItem('66666666666666666666666666666666', 'Latest episode', 'Episode', { SeriesId: series.Id, SeriesName: series.Name, ParentIndexNumber: 1, IndexNumber: 2, RunTimeTicks: 3000e7 }),
	baseItem('77777777777777777777777777777777', 'Finished episode', 'Episode', { SeriesId: series.Id, SeriesName: series.Name, ParentIndexNumber: 1, IndexNumber: 3, RunTimeTicks: 3000e7 }),
];
const films = [
	baseItem('22222222222222222222222222222222', 'Partial Film', 'Movie'),
	baseItem('33333333333333333333333333333333', 'Finished Film', 'Movie'),
	baseItem('44444444444444444444444444444444', 'Other Person Film', 'Movie'),
];

test('real home route and play target keep partial, finished, series and cross-user history separate', { timeout: 30000 }, async t => {
	const directory = mkdtempSync(path.join(os.tmpdir(), 'web-home-history-'));
	const servers = [];
	const listen = handler => new Promise(resolve => {
		const server = http.createServer(handler);
		server.listen(0, '127.0.0.1', () => { servers.push(server); resolve(server); });
	});
	const itemById = new Map([...films, series, ...episodes].map(item => [item.Id, item]));
	const upstream = await listen((req, res) => {
		const url = new URL(req.url, 'http://127.0.0.1');
		res.setHeader('Content-Type', 'application/json');
		if (url.pathname === '/Items') return res.end(JSON.stringify({ Items: [...films, series], TotalRecordCount: films.length + 1 }));
		const itemMatch = url.pathname.match(/^\/Users\/[^/]+\/Items\/([^/]+)$/);
		if (itemMatch) {
			const item = itemById.get(decodeURIComponent(itemMatch[1]));
			if (!item) { res.statusCode = 404; return res.end('{}'); }
			return res.end(JSON.stringify(item));
		}
		const showMatch = url.pathname.match(/^\/Shows\/([^/]+)\/Episodes$/);
		if (showMatch) return res.end(JSON.stringify({ Items: episodes, TotalRecordCount: episodes.length }));
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
		[digest(token)]: { id: deviceId, name: 'History fixture', status: 'approved', role: 'viewer', created: Date.now(), approved: Date.now(), expires: Date.now() + 3600000 }
	}));
	writeFileSync(path.join(directory, 'account-limits.json'), JSON.stringify({ accounts: {} }));
	const now = Date.now();
	const event = (itemId, extra) => ({ id: 'event-' + itemId, type: 'playback', deviceId, itemId, state: 'ended', time: now, updated: now, ...extra });
	writeFileSync(path.join(directory, 'activity.json'), JSON.stringify([
		event('22222222222222222222222222222222', { position: 120, duration: 7200 }),
		event('33333333333333333333333333333333', { position: 7150, duration: 7200 }),
		event('44444444444444444444444444444444', { position: 900, duration: 7200, deviceId: 'f'.repeat(32) }),
		event('55555555555555555555555555555555', { seriesId: series.Id, position: 600, duration: 3000, updated: now - 30000 }),
		event('66666666666666666666666666666666', { seriesId: series.Id, position: 240, duration: 3000, updated: now - 10000 }),
		event('77777777777777777777777777777777', { seriesId: series.Id, position: 2980, duration: 3000, updated: now - 5000 }),
	]));
	(await import('./enabled-fixture.mjs')).enableIntegrations();
	const { app } = await import('../server.mjs');
	local.on('request', app);
	const base = `http://127.0.0.1:${local.address().port}`;
	const request = (route, body) => fetch(base + route, {
		method: body === undefined ? 'GET' : 'POST',
		headers: { 'Content-Type': 'application/json', Origin: base, Authorization: 'Bearer ' + token },
		body: body === undefined ? undefined : JSON.stringify(body)
	});
	t.after(() => {
		for (const server of servers) { server.closeAllConnections(); server.close(); }
		rmSync(directory, { recursive: true, force: true });
	});

	const home = await request('/api/web/home', {});
	const homeText = await home.clone().text();
	assert.equal(home.status, 200, homeText);
	const feed = await home.json();
	const continueRow = feed.rows.find(row => row.id === 'continue');
	assert.ok(continueRow, 'continue watching row exists');
	assert.deepEqual(continueRow.items.map(entry => entry.Id).sort(), ['22222222222222222222222222222222', '66666666666666666666666666666666']);
	assert.ok(feed.rows.every(row => row.items.every(entry => entry.Id !== '33333333333333333333333333333333')), 'the finished film is excluded');
	const episodeItem = continueRow.items.find(entry => entry.Id === '66666666666666666666666666666666');
	assert.ok(episodeItem, 'the exact unfinished episode is in Continue watching');
	assert.equal(episodeItem.Type, 'Episode');
	assert.equal(episodeItem.SeriesId, series.Id);
	assert.equal(episodeItem.SeriesName, series.Name);
	assert.equal(episodeItem.UserData.PlaybackPositionTicks, 240e7, 'the exact episode position is preserved');
	assert.ok(!continueRow.items.some(entry => entry.Id === series.Id), 'a series card never substitutes for its unfinished episode');
	assert.ok(!continueRow.items.some(entry => entry.Id === '44444444444444444444444444444444'), 'another device cannot create Continue watching');
	const other = feed.rows.flatMap(row => row.items).find(entry => entry.Id === '44444444444444444444444444444444');
	if (other) assert.equal(other._resume, 0, 'another device history is not applied');

	const target = await request('/api/web/play-target/' + series.Id);
	const targetText = await target.clone().text();
	assert.equal(target.status, 200, targetText);
	const resolved = await target.json();
	assert.deepEqual({ id: resolved.id, type: resolved.type, position: resolved.position, reason: resolved.reason },
		{ id: '66666666666666666666666666666666', type: 'Episode', position: 240, reason: 'resume' });
});
