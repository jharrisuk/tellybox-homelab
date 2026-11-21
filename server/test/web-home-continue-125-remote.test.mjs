import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';

const token = 'a'.repeat(64);
const deviceId = 'b'.repeat(32);
const otherDevice = 'f'.repeat(32);
const digest = value => createHash('sha256').update(value).digest('hex');
const baseItem = (id, name, type, extra = {}) => ({ Id: id, Name: name, Type: type, Genres: ['Drama'], ProviderIds: { Tmdb: String(Number(id[0]) || 1) }, RunTimeTicks: 7200e7, ...extra });

const series = baseItem('11111111111111111111111111111111', 'Long Series', 'Series');
const episodes = [
	baseItem('55555555555555555555555555555555', 'Other device episode', 'Episode', { SeriesId: series.Id, SeriesName: series.Name, ParentIndexNumber: 1, IndexNumber: 1, RunTimeTicks: 3000e7 }),
	baseItem('66666666666666666666666666666666', 'Own episode', 'Episode', { SeriesId: series.Id, SeriesName: series.Name, ParentIndexNumber: 2, IndexNumber: 3, RunTimeTicks: 3000e7 }),
	baseItem('77777777777777777777777777777777', 'Finished episode', 'Episode', { SeriesId: series.Id, SeriesName: series.Name, ParentIndexNumber: 1, IndexNumber: 4, RunTimeTicks: 3000e7 }),
];
const films = [baseItem('22222222222222222222222222222222', 'Partial Film', 'Movie')];

async function fixture(t) {
	const directory = mkdtempSync(path.join(os.tmpdir(), 'web-home-continue-remote-'));
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
	// No PORT override: this listener is not the configured local port, so the
	// authenticated requests take the remote person/device path.
	Object.assign(process.env, {
		NODE_ENV: 'test', AUTH_DIR: directory, DATA_DIR: directory,
		JELLYFIN_URL: `http://127.0.0.1:${upstream.address().port}`,
		DISPATCHARR_URL: 'http://127.0.0.1:1',
		LOCAL_HOSTS: '127.0.0.1', LOCAL_NETWORKS: '127.0.0.0/8',
		PUBLIC_ORIGIN: 'https://remote.test'
	});
	writeFileSync(path.join(directory, 'connection.json'), JSON.stringify({ userId: 'test', token: 'fixture-only' }));
	writeFileSync(path.join(directory, 'apps.json'), JSON.stringify({
		[digest(token)]: { id: deviceId, name: 'Continue fixture', status: 'approved', role: 'viewer', created: Date.now(), approved: Date.now(), expires: Date.now() + 3600000 }
	}));
	writeFileSync(path.join(directory, 'account-limits.json'), JSON.stringify({ accounts: {} }));
	const now = Date.now();
	const event = (itemId, extra) => ({ id: 'event-' + itemId, type: 'playback', deviceId, itemId, state: 'ended', time: now, updated: now, ...extra });
	writeFileSync(path.join(directory, 'activity.json'), JSON.stringify([
		event(episodes[1].Id, { seriesId: series.Id, position: 240, duration: 3000, updated: now }),
		event(episodes[0].Id, { seriesId: series.Id, position: 900, duration: 3000, deviceId: otherDevice, updated: now }),
		event(episodes[2].Id, { seriesId: series.Id, position: 2980, duration: 3000, updated: now }),
	]));
	(await import('./enabled-fixture.mjs')).enableIntegrations();
	const { app } = await import('../server.mjs');
	local.on('request', app);
	const base = `http://127.0.0.1:${local.address().port}`;
	const request = body => fetch(base + '/api/web/home', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Origin: base, Authorization: 'Bearer ' + token },
		body: JSON.stringify(body)
	});
	t.after(() => {
		for (const server of servers) { server.closeAllConnections(); server.close(); }
		rmSync(directory, { recursive: true, force: true });
	});
	return { request, episodes };
}

test('remote Continue uses the caller own history only, refuses client progress, another device and completed items', { timeout: 45000 }, async t => {
	const { request, episodes } = await fixture(t);
	// The body tries to hydrate another device's id; a remote caller must not
	// be able to create a Continue card that way.
	const feed = await (await request({ progress: { [episodes[0].Id]: 1200 } })).json();
	const row = feed.rows.find(entry => entry.id === 'continue');
	const own = row.items.find(item => item.Id === episodes[1].Id);
	assert.ok(own, 'the caller own unfinished episode is present');
	assert.equal(own.Type, 'Episode');
	assert.equal(own.UserData.PlaybackPositionTicks, 240e7);
	assert.ok(!row.items.some(item => item.Id === episodes[0].Id), 'another device progress is not applied and client progress is ignored');
	assert.ok(!row.items.some(item => item.Id === episodes[2].Id), 'the completed episode is excluded');
	assert.ok(!row.items.some(item => item.Type === 'Series'), 'no series placeholder substitutes for the episode');
});
