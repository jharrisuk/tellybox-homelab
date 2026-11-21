import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const liked = 'a'.repeat(32);
const series = id => ({ Id: id, Name: 'Long Show', Type: 'Series', Genres: ['Drama'], ProviderIds: { Tmdb: '101' }, DateCreated: '2026-01-01T00:00:00Z', ChildCount: 100 });
const episodes = Array.from({ length: 100 }, (_, index) => ({
	Id: 'long-e' + (index + 1), Name: 'Episode ' + (index + 1), Type: 'Episode', MediaType: 'Video',
	SeriesId: liked, SeriesName: 'Long Show', ParentIndexNumber: 1, IndexNumber: index + 1,
	PremiereDate: new Date(Date.UTC(2025, 0, index + 1)).toISOString(), RunTimeTicks: 2400e7,
	ImageTags: { Primary: 'tag-' + index }, BackdropImageTags: [], PrimaryImageAspectRatio: 1.77
}));

test('the composed route resolves an exact early anchor and reports truthful completeness', { timeout: 30000 }, async t => {
	const requests = [], servers = [];
	const listen = handler => new Promise(resolve => {
		const server = http.createServer(handler);
		server.listen(0, '127.0.0.1', () => { servers.push(server); resolve(server); });
	});
	const upstream = await listen((req, res) => {
		const url = new URL(req.url, 'http://127.0.0.1');
		requests.push(url);
		res.setHeader('Content-Type', 'application/json');
		if (url.pathname === '/Items') {
			const parent = url.searchParams.get('ParentId');
			if (!parent) return res.end(JSON.stringify({ Items: [series(liked)], TotalRecordCount: 1 }));
			return res.end(JSON.stringify({ Items: episodes }));
		}
		const show = /^\/Shows\/([^/]+)\/Episodes$/.exec(url.pathname);
		if (show) return res.end(JSON.stringify({ Items: episodes }));
		const item = /^\/Users\/[^/]+\/Items\/([^/]+)$/.exec(url.pathname);
		if (item) return res.end(JSON.stringify(series(decodeURIComponent(item[1]))));
		return res.end('{}');
	});
	const local = await listen();
	const directory = mkdtempSync(path.join(os.tmpdir(), 'home-episodes-anchor-route-'));
	Object.assign(process.env, {
		NODE_ENV: 'test', AUTH_DIR: directory, DATA_DIR: directory,
		JELLYFIN_URL: `http://127.0.0.1:${upstream.address().port}`,
		DISPATCHARR_URL: 'http://127.0.0.1:1',
		LOCAL_HOSTS: '127.0.0.1', LOCAL_NETWORKS: '127.0.0.0/8',
		PUBLIC_ORIGIN: 'https://remote.test', PORT: String(local.address().port)
	});
	writeFileSync(path.join(directory, 'connection.json'), JSON.stringify({ userId: 'test', token: 'fixture-only' }));
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
	const showQueries = () => requests.filter(url => /^\/Shows\/[^/]+\/Episodes$/.test(url.pathname));

	const response = await fetch(base + '/api/web/releases/episodes?series=' + liked + '&anchors=' + encodeURIComponent(`${liked}:1:5`));
	const body = await response.json();
	assert.equal(response.status, 200);
	assert.equal(response.headers.get('cache-control'), 'no-store');
	assert.ok(body.items.some(item => item.Id === 'long-e5'), 'the exact early anchor must be returned');
	assert.ok(body.items.some(item => item.Id === 'long-e6'), 'the authoritative immediate successor must be returned');
	assert.deepEqual(body.anchors, [{ seriesId: liked, season: 1, number: 5, found: true, hasBefore: true, hasAfter: true }]);
	assert.deepEqual(body.series, [{ seriesId: liked, complete: true }]);
	assert.ok(showQueries().length <= 2, 'one bounded series read, never a catalogue scan');

	const withoutSeries = await fetch(base + '/api/web/releases/episodes?anchors=' + encodeURIComponent(`${liked}:1:5`));
	assert.equal(withoutSeries.status, 200, 'an anchor implies its series');
	assert.ok((await withoutSeries.json()).items.some(item => item.Id === 'long-e5'));

	const invalid = await fetch(base + '/api/web/releases/episodes?series=' + liked + '&anchors=' + encodeURIComponent(`${liked}:1`));
	assert.equal(invalid.status, 400);
	const unknown = await fetch(base + '/api/web/releases/episodes?series=' + liked + '&anchors=' + encodeURIComponent(`${liked}:1:5`) + '&url=' + encodeURIComponent('https://example.test'));
	assert.equal(unknown.status, 400, 'anchors never become an arbitrary fetch switch');
});
