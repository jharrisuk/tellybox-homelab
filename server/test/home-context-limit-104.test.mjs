import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';

const token = 'c'.repeat(64);
const deviceId = 'd'.repeat(32);
const digest = value => createHash('sha256').update(value).digest('hex');

test('a heavy viewer can send large home context without hitting the small JSON ceiling', { timeout: 30000 }, async t => {
	const directory = mkdtempSync(path.join(os.tmpdir(), 'home-context-limit-'));
	const servers = [];
	const listen = handler => new Promise(resolve => {
		const server = http.createServer(handler);
		server.listen(0, '127.0.0.1', () => { servers.push(server); resolve(server); });
	});
	const upstream = await listen((req, res) => {
		res.setHeader('Content-Type', 'application/json');
		res.end(JSON.stringify({ Items: [], TotalRecordCount: 0 }));
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
		[digest(token)]: { id: deviceId, name: 'Limit fixture', status: 'approved', role: 'viewer', created: Date.now(), approved: Date.now(), expires: Date.now() + 3600000 }
	}));
	writeFileSync(path.join(directory, 'account-limits.json'), JSON.stringify({ accounts: {} }));
	(await import('./enabled-fixture.mjs')).enableIntegrations();
	const { app } = await import('../server.mjs');
	local.on('request', app);
	const base = `http://127.0.0.1:${local.address().port}`;
	const post = body => fetch(base + '/api/web/home', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', Origin: base, Authorization: 'Bearer ' + token },
		body: JSON.stringify(body)
	});
	t.after(() => {
		for (const server of servers) { server.closeAllConnections(); server.close(); }
		rmSync(directory, { recursive: true, force: true });
	});

	const id = index => (String(index).padStart(8, '0') + 'a').padEnd(36, '0').slice(0, 36);
	const heavy = await post({
		favourites: Array.from({ length: 1000 }, (_, index) => id(index)),
		watched: Array.from({ length: 5000 }, (_, index) => id(index + 1000)),
		progress: {}
	});
	assert.equal(heavy.status, 200, await heavy.clone().text());
	const feed = await heavy.json();
	assert.equal(typeof feed.personalized, 'boolean');
	assert.ok(Array.isArray(feed.rows));

	const oversized = await post({ watched: Array.from({ length: 14000 }, (_, index) => id(index)) });
	assert.equal(oversized.status, 413, 'the raised ceiling is still bounded');

	const pool = await fetch(base + '/api/web/recommendations?limit=600', {
		headers: { Origin: base, Authorization: 'Bearer ' + token }
	});
	assert.equal(pool.status, 200, await pool.clone().text());
	const poolBody = await pool.json();
	assert.ok(Array.isArray(poolBody.items), 'the app pool route returns an items array');
});
