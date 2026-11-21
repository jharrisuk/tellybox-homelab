import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const liked = 'a'.repeat(32);
const other = 'b'.repeat(32);
const failing = 'd'.repeat(32);
const series = (id, name) => ({ Id: id, Name: name, Type: 'Series', Genres: ['Drama'], ProviderIds: { Tmdb: String(Number(id.slice(-2), 16) + 100) }, DateCreated: '2026-01-01T00:00:00Z', ChildCount: 5 });
const episode = (id, seriesId, name, season, number, date, extra = {}) => ({
	Id: id, Name: name, Type: 'Episode', MediaType: 'Video', SeriesId: seriesId,
	SeriesName: seriesId === liked ? 'Liked Show' : 'Other Show', ParentIndexNumber: season, IndexNumber: number,
	PremiereDate: date, RunTimeTicks: 2400e7, ImageTags: { Primary: 'tag-' + id },
	BackdropImageTags: [], PrimaryImageAspectRatio: 1.77, ...extra
});

test('the endpoint returns real, bounded itemView episodes for the requested series only', { timeout: 30000 }, async t => {
	const shows = {
		[liked]: [
			episode('liked-1', liked, 'Pilot', 2, 1, '2026-10-01T00:00:00Z'),
			episode('liked-2', liked, 'Second', 2, 2, '2026-10-02T00:00:00Z')
		],
		[other]: [
			episode('other-1', other, 'Start', 1, 1, '2026-09-01T00:00:00Z'),
			episode('other-1', other, 'Start', 1, 1, '2026-09-01T00:00:00Z'),
			episode('other-missing', other, 'Missing', 1, 2, '2026-09-02T00:00:00Z', { IsMissing: true }),
			episode('other-unaired', other, 'Unaired', 1, 3, '2026-09-03T00:00:00Z', { IsUnaired: true }),
			episode('other-future', other, 'Future', 1, 4, '2027-09-04T00:00:00Z'),
			episode('other-virtual', other, 'Virtual', 1, 5, '2026-09-05T00:00:00Z', { IsVirtualItem: true }),
			episode('other-undated', other, 'Undated', 1, 6, undefined)
		]
	};
	const requests = [];
	const servers = [];
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
			if (!parent) return res.end(JSON.stringify({ Items: [series(liked, 'Liked Show'), series(other, 'Other Show')], TotalRecordCount: 2 }));
			if (parent === failing) { res.statusCode = 500; return res.end('{}'); }
			return res.end(JSON.stringify({ Items: shows[parent] || [] }));
		}
		const episodes = /^\/Shows\/([^/]+)\/Episodes$/.exec(url.pathname);
		if (episodes) return res.end(JSON.stringify({ Items: shows[decodeURIComponent(episodes[1])] || [] }));
		const item = /^\/Users\/[^/]+\/Items\/([^/]+)$/.exec(url.pathname);
		if (item) {
			const found = [series(liked, 'Liked Show'), series(other, 'Other Show')].find(value => value.Id === decodeURIComponent(item[1]));
			if (!found) { res.statusCode = 404; return res.end('{}'); }
			return res.end(JSON.stringify(found));
		}
		return res.end('{}');
	});
	// local() compares the listening port with PORT, so reserve the server first.
	const local = await listen();
	const directory = mkdtempSync(path.join(os.tmpdir(), 'home-episodes-route-'));
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
	const parentQueries = () => requests.filter(url => url.pathname === '/Items' && url.searchParams.has('ParentId'));
	const showQueries = () => requests.filter(url => /^\/Shows\/[^/]+\/Episodes$/.test(url.pathname));
	const catalogueScans = () => requests.filter(url => url.pathname === '/Items' && !url.searchParams.has('ParentId'));

	const response = await fetch(base + '/api/web/releases/episodes?series=' + encodeURIComponent(`${liked},${other}`));
	const body = await response.json();
	assert.equal(response.status, 200);
	assert.equal(response.headers.get('cache-control'), 'no-store');
	assert.deepEqual(body.items.map(item => item.Id), ['liked-2', 'liked-1', 'other-1', 'other-undated']);
	assert.equal(new Set(body.items.map(item => item.Id)).size, body.items.length, 'no duplicate episode ids');
	for (const item of body.items) {
		assert.equal(item.Type, 'Episode');
		assert.equal(typeof item.Name, 'string');
		assert.ok(item.SeriesId === liked || item.SeriesId === other, 'only the requested series');
		assert.ok(['Liked Show', 'Other Show'].includes(item.SeriesName), 'a real series name is required');
		assert.equal(typeof item.ParentIndexNumber, 'number');
		assert.equal(typeof item.IndexNumber, 'number');
		assert.equal(typeof item.RunTimeTicks, 'number');
		assert.ok(item.ImageTags?.Primary, 'the existing itemView artwork fields are present');
	}
	// A local canonical id now reads the merged library list so a VOD-only
	// episode is not lost; the scoped ParentId query is only a fallback.
	assert.equal(parentQueries().length, 0, 'an indexed local series needs no ParentId query');
	assert.deepEqual(showQueries().map(url => decodeURIComponent(url.pathname.split('/')[2])).sort(), [liked, other].sort(),
		'one scoped episode read per requested series');
	for (const url of showQueries()) {
		assert.equal(url.searchParams.get('UserId'), 'test');
		assert.equal(url.searchParams.get('IsMissing'), 'false');
		assert.equal(url.searchParams.get('IsUnaired'), 'false');
	}
	assert.equal(catalogueScans().filter(url => (url.searchParams.get('IncludeItemTypes') || '').includes('Episode')).length, 0,
		'the endpoint never enumerates the whole episode library');

	const before = parentQueries().length;
	const oversized = Array.from({ length: 51 }, (_, index) => (index + 1).toString(16).padStart(32, '0')).join(',');
	const rejected = await fetch(base + '/api/web/releases/episodes?series=' + oversized);
	assert.equal(rejected.status, 400);
	const malformed = await fetch(base + '/api/web/releases/episodes?series=' + encodeURIComponent('https://example.test/show'));
	assert.equal(malformed.status, 400);
	const extra = await fetch(base + '/api/web/releases/episodes?series=' + liked + '&url=' + encodeURIComponent('http://example.test'));
	assert.equal(extra.status, 400, 'only a series list is accepted');
	assert.equal(parentQueries().length, before, 'invalid input costs no upstream work');

	const empty = await fetch(base + '/api/web/releases/episodes');
	assert.deepEqual(await empty.json(), { items: [] });
	const blank = await fetch(base + '/api/web/releases/episodes?series=');
	assert.deepEqual(await blank.json(), { items: [] });
	assert.equal(parentQueries().length, before, 'an empty request costs no upstream work');

	const showBefore = showQueries().length;
	const partial = await fetch(base + '/api/web/releases/episodes?series=' + `${liked},${failing}`);
	const partialBody = await partial.json();
	assert.equal(partial.status, 200, 'one failed series must not fail Home');
	assert.deepEqual(partialBody.items.map(item => item.Id), ['liked-2', 'liked-1']);
	const failed = parentQueries().filter(url => url.searchParams.get('ParentId') === failing);
	assert.equal(failed.length, 1, 'a local series the library cannot resolve falls back to one scoped query');
	for (const url of failed) {
		assert.equal(url.searchParams.get('IncludeItemTypes'), 'Episode');
		assert.equal(url.searchParams.get('Recursive'), 'true');
		assert.equal(url.searchParams.get('IsMissing'), 'false');
		assert.equal(url.searchParams.get('IsUnaired'), 'false');
		assert.equal(url.searchParams.get('UserId'), 'test');
		assert.equal(url.searchParams.get('Limit'), '60');
	}
	assert.ok(showQueries().length >= showBefore, 'the failed series still costs at most one library read');

	const streamedBefore = requests.length;
	const streamed = await fetch(base + '/api/web/releases/episodes?series=dispatch-series-9');
	assert.equal(streamed.status, 200);
	assert.deepEqual(await streamed.json(), { items: [] }, 'an unavailable streamed source is skipped');
	assert.equal(requests.slice(streamedBefore).filter(url => url.pathname === '/Items').length, 0, 'a streamed id is never sent to Jellyfin');
});
