import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const token = '1'.repeat(64);
const blockedToken = '2'.repeat(64);
const deviceId = '3'.repeat(32);
const blockedDevice = '4'.repeat(32);
const digest = value => createHash('sha256').update(value).digest('hex');
const liked = 'a'.repeat(32);
const other = 'b'.repeat(32);
const hidden = 'f'.repeat(32);
const series = (id, name) => ({ Id: id, Name: name, Type: 'Series', Genres: ['Drama'], ProviderIds: { Tmdb: id === liked ? '551' : '552' }, DateCreated: '2026-01-01T00:00:00Z', ChildCount: 3 });
const episode = (id, seriesId, seriesName, date) => ({ Id: id, Name: 'Episode', Type: 'Episode', SeriesId: seriesId, SeriesName: seriesName,
	ParentIndexNumber: 1, IndexNumber: 1, PremiereDate: date, RunTimeTicks: 1200e7, ImageTags: { Primary: 'tag' },
	UserData: { Played: true, PlaybackPositionTicks: 900e7 } });

test('Home episodes require a viewer and only look up series that viewer may see', { timeout: 30000 }, async t => {
	const requests = [];
	const shows = {
		[liked]: [episode('liked-1', liked, 'Liked Show', '2026-10-01T00:00:00Z')],
		[other]: [episode('other-1', other, 'Other Show', '2026-10-02T00:00:00Z')]
	};
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
			return res.end(JSON.stringify({ Items: shows[parent] || [] }));
		}
		const episodes = /^\/Shows\/([^/]+)\/Episodes$/.exec(url.pathname);
		if (episodes) return res.end(JSON.stringify({ Items: shows[decodeURIComponent(episodes[1])] || [] }));
		return res.end('{}');
	});
	const local = await listen();
	const directory = mkdtempSync(path.join(os.tmpdir(), 'home-episodes-remote-'));
	Object.assign(process.env, {
		NODE_ENV: 'test', AUTH_DIR: directory, DATA_DIR: directory,
		JELLYFIN_URL: `http://127.0.0.1:${upstream.address().port}`,
		DISPATCHARR_URL: 'http://127.0.0.1:1',
		LOCAL_HOSTS: '192.0.2.10', LOCAL_NETWORKS: '192.0.2.0/24',
		PUBLIC_ORIGIN: 'https://remote.test', PORT: '8082'
	});
	writeFileSync(path.join(directory, 'connection.json'), JSON.stringify({ userId: 'test', token: 'fixture-only' }));
	writeFileSync(path.join(directory, 'apps.json'), JSON.stringify({
		[digest(token)]: { id: deviceId, name: 'Allowed app', status: 'approved', role: 'viewer', created: Date.now(), approved: Date.now(), expires: Date.now() + 3600000 },
		[digest(blockedToken)]: { id: blockedDevice, name: 'Blocked app', status: 'approved', role: 'viewer', created: Date.now(), approved: Date.now(), expires: Date.now() + 3600000 }
	}));
	writeFileSync(path.join(directory, 'account-limits.json'), JSON.stringify({ accounts: {
		['device:' + blockedDevice]: { minutes: 1, seconds: 60, downloads: false, dailyMinutes: 0, dailySeconds: 0, day: '2000-01-01', maxSessions: 0 }
	} }));
	writeFileSync(path.join(directory, 'remote-controls.json'), JSON.stringify({ enabled: true, vod: true, nonstop: true }));
	(await import('./enabled-fixture.mjs')).enableIntegrations();
	const { app } = await import('../server.mjs');
	local.on('request', app);
	const base = `http://127.0.0.1:${local.address().port}`;
	t.after(() => {
		for (const server of servers) { server.closeAllConnections(); server.close(); }
		rmSync(directory, { recursive: true, force: true });
	});
	const url = (ids) => base + '/api/web/releases/episodes' + (ids === undefined ? '' : '?series=' + encodeURIComponent(ids));
	const parentCalls = () => requests.filter(value => value.pathname === '/Items' && value.searchParams.has('ParentId'));

	const anonymous = await fetch(url(liked));
	assert.equal(anonymous.status, 401, 'no viewer means no episode catalogue');
	assert.equal(requests.length, 0, 'an unauthenticated request makes no provider call');

	const blocked = await fetch(url(liked), { headers: { Authorization: 'Bearer ' + blockedToken } });
	assert.equal(blocked.status, 200);
	const blockedBody = await blocked.json();
	assert.deepEqual(blockedBody.items, []);
	assert.equal(blockedBody.restricted, true);
	assert.match(blockedBody.reason, /allowance/i);
	assert.equal(requests.length, 0, 'a restricted account makes no provider call');

	const allowed = await fetch(url(`${liked},${other}`), { headers: { Authorization: 'Bearer ' + token } });
	assert.equal(allowed.status, 200);
	assert.equal(allowed.headers.get('cache-control'), 'no-store');
	const allowedBody = await allowed.json();
	assert.deepEqual(allowedBody.items.map(item => item.Id), ['other-1', 'liked-1']);
	assert.ok(allowedBody.items.every(item => item.UserData === undefined), 'shared Jellyfin UserData never reaches a remote viewer');
	assert.deepEqual(parentCalls().map(value => value.searchParams.get('ParentId')).sort(), [liked, other].sort());

	const before = parentCalls().length;
	const unknown = await fetch(url(`${liked},${hidden}`), { headers: { Authorization: 'Bearer ' + token } });
	assert.equal(unknown.status, 200);
	assert.deepEqual((await unknown.json()).items.map(item => item.Id), ['liked-1']);
	assert.equal(parentCalls().length, before + 1, 'the hidden series id is skipped before any lookup');
	assert.equal(parentCalls().some(value => value.searchParams.get('ParentId') === hidden), false);

	const streamed = await fetch(url('dispatch-series-9'), { headers: { Authorization: 'Bearer ' + token } });
	assert.deepEqual(await streamed.json(), { items: [] }, 'a guessed streamed id is not a visible catalogue series');
	assert.equal(requests.filter(value => value.pathname.startsWith('/api/')).length, 0, 'no provider path is taken from the caller');

	const oversized = await fetch(url(Array.from({ length: 51 }, (_, index) => (index + 1).toString(16).padStart(32, '0')).join(',')), { headers: { Authorization: 'Bearer ' + token } });
	assert.equal(oversized.status, 400);
	const malformed = await fetch(url('not-an-id'), { headers: { Authorization: 'Bearer ' + token } });
	assert.equal(malformed.status, 400);
});
