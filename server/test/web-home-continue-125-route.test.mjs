import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const baseItem = (id, name, type, extra = {}) => ({ Id: id, Name: name, Type: type, Genres: ['Drama'], ProviderIds: { Tmdb: String(Number(id[0]) || 1) }, RunTimeTicks: 7200e7, ...extra });

const series = baseItem('11111111111111111111111111111111', 'Long Series', 'Series');
const episodes = [
	baseItem('55555555555555555555555555555555', 'Old episode', 'Episode', { SeriesId: series.Id, SeriesName: series.Name, ParentIndexNumber: 1, IndexNumber: 1, RunTimeTicks: 3000e7 }),
	baseItem('66666666666666666666666666666666', 'Latest episode', 'Episode', { SeriesId: series.Id, SeriesName: series.Name, ParentIndexNumber: 2, IndexNumber: 3, RunTimeTicks: 3000e7 }),
	baseItem('77777777777777777777777777777777', 'Finished episode', 'Episode', { SeriesId: series.Id, SeriesName: series.Name, ParentIndexNumber: 1, IndexNumber: 3, RunTimeTicks: 3000e7 }),
];
const films = [
	baseItem('22222222222222222222222222222222', 'Partial Film', 'Movie'),
	baseItem('33333333333333333333333333333333', 'Old Long Film', 'Movie'),
];

async function fixture(t) {
	const directory = mkdtempSync(path.join(os.tmpdir(), 'web-home-continue-local-'));
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
	// PORT makes this listener the app's local port, so requests from 127.0.0.1
	// take the genuine local/home path with no Authorization header.
	Object.assign(process.env, {
		NODE_ENV: 'test', AUTH_DIR: directory, DATA_DIR: directory,
		JELLYFIN_URL: `http://127.0.0.1:${upstream.address().port}`,
		DISPATCHARR_URL: 'http://127.0.0.1:1', PORT: String(local.address().port),
		LOCAL_HOSTS: '127.0.0.1', LOCAL_NETWORKS: '127.0.0.0/8',
		PUBLIC_ORIGIN: 'https://remote.test'
	});
	writeFileSync(path.join(directory, 'connection.json'), JSON.stringify({ userId: 'test', token: 'fixture-only' }));
	writeFileSync(path.join(directory, 'apps.json'), JSON.stringify({}));
	writeFileSync(path.join(directory, 'account-limits.json'), JSON.stringify({ accounts: {} }));
	const now = Date.now();
	const localEvent = (itemId, extra) => ({ id: 'local-' + itemId, type: 'playback', local: true, itemId, state: 'ended', time: now, updated: now, ...extra });
	writeFileSync(path.join(directory, 'activity.json'), JSON.stringify([
		localEvent(films[1].Id, { position: 5400, duration: 7200, updated: now - 7_200_000 }),
		localEvent(episodes[1].Id, { seriesId: series.Id, position: 30, duration: 3000, updated: now }),
	]));
	(await import('./enabled-fixture.mjs')).enableIntegrations();
	const { app } = await import('../server.mjs');
	local.on('request', app);
	const base = `http://127.0.0.1:${local.address().port}`;
	const request = body => fetch(base + '/api/web/home', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Origin: base },
		body: JSON.stringify(body)
	});
	t.after(() => {
		for (const server of servers) { server.closeAllConnections(); server.close(); }
		rmSync(directory, { recursive: true, force: true });
	});
	return { request, series, episodes, films };
}

const continueRow = feed => feed.rows.find(row => row.id === 'continue');
const ids = feed => (continueRow(feed)?.items || []).map(item => item.Id);

test('local home Continue returns the exact unfinished episode from browser progress, not a series placeholder', { timeout: 45000 }, async t => {
	const { request, series, episodes, films } = await fixture(t);

	// 1. Local/home mixed: exact episode from browser progress plus the unfinished film.
	const mixedFeed = await (await request({ progress: { [films[0].Id]: 120, [episodes[1].Id]: 240 } })).json();
	const mixedRow = continueRow(mixedFeed);
	assert.ok(mixedRow, 'Continue row exists on local home');
	const exact = mixedRow.items.find(item => item.Id === episodes[1].Id);
	assert.ok(exact, 'the exact episode is in Continue');
	assert.equal(exact.Type, 'Episode');
	assert.equal(exact.SeriesId, series.Id);
	assert.equal(exact.SeriesName, series.Name);
	assert.equal(exact.ParentIndexNumber, 2);
	assert.equal(exact.IndexNumber, 3);
	assert.equal(exact.UserData.PlaybackPositionTicks, 240e7, 'the exact position is preserved');
	assert.ok(!mixedRow.items.some(item => item.Id === series.Id), 'no series substitutes for the episode');
	assert.ok(mixedRow.items.some(item => item.Id === films[0].Id), 'the unfinished film stays in Continue');

	// 2. Episode-only local: the original symptom, with no film row to hide behind.
	const onlyFeed = await (await request({ progress: { [episodes[1].Id]: 240 } })).json();
	assert.deepEqual(ids(onlyFeed), [episodes[1].Id]);
	assert.equal(continueRow(onlyFeed).items[0].UserData.PlaybackPositionTicks, 240e7);

	// 3. Recency: a recent short episode outranks an old long film; completed excluded.
	const recentFeed = await (await request({ progress: { [films[1].Id]: 5400, [episodes[1].Id]: 30 } })).json();
	const recentRow = continueRow(recentFeed);
	assert.equal(recentRow.items[0].Id, episodes[1].Id, 'recent episode outranks the old long film');
	assert.ok(!recentRow.items.some(item => item.Id === episodes[2].Id), 'the completed episode is excluded');
});
