import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';

const id = '1'.repeat(32);
const token = 'a'.repeat(64);
const otherToken = 'c'.repeat(64);
const adminToken = 'e'.repeat(64);
const deviceId = 'b'.repeat(32);
const otherDeviceId = 'd'.repeat(32);
const adminId = 'f'.repeat(32);
const digest = value => createHash('sha256').update(value).digest('hex');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

test('paused timeout closes the actual session, preserves position and keeps an idempotent owner tombstone', { timeout: 15000 }, async t => {
	const directory = mkdtempSync(path.join(os.tmpdir(), 'paused-session-e2e-'));
	const servers = [];
	let stopped = 0;
	const listen = async handler => {
		const server = http.createServer(handler);
		await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
		servers.push(server);
		return server;
	};
	const upstream = await listen((req, res) => {
		if (req.url.startsWith('/Users/')) {
			res.setHeader('Content-Type', 'application/json');
			return res.end(JSON.stringify({ Id: id, Name: 'Pause fixture', Type: 'Movie', RunTimeTicks: 600000000, MediaSources: [{ Id: 'source' }] }));
		}
		if (req.url.includes('/PlaybackInfo')) {
			res.setHeader('Content-Type', 'application/json');
			return res.end(JSON.stringify({ PlaySessionId: 'fixture', MediaSources: [{ Id: 'source', Container: 'mp4', TranscodingUrl: `/Videos/${id}/master.m3u8`, MediaStreams: [] }] }));
		}
		if (req.url.includes('/Sessions/Playing/Stopped')) { stopped++; res.writeHead(204); return res.end(); }
		res.writeHead(204); res.end();
	});
	const local = await listen();
	Object.assign(process.env, {
		NODE_ENV: 'test', TELLYBOX_TEST_PAUSED_TIMEOUT_MS: '200',
		AUTH_DIR: directory, DATA_DIR: directory,
		JELLYFIN_URL: `http://127.0.0.1:${upstream.address().port}`,
		DISPATCHARR_URL: 'http://127.0.0.1:1',
		LOCAL_HOSTS: '127.0.0.1', LOCAL_NETWORKS: '127.0.0.0/8',
		PUBLIC_ORIGIN: 'https://remote.test'
	});
	writeFileSync(path.join(directory, 'connection.json'), JSON.stringify({ userId: 'test', token: 'fixture-only' }));
	writeFileSync(path.join(directory, 'apps.json'), JSON.stringify({
		[digest(token)]: { id: deviceId, name: 'Pause fixture', status: 'approved', role: 'viewer', created: Date.now(), approved: Date.now(), expires: Date.now() + 3600000 },
		[digest(otherToken)]: { id: otherDeviceId, name: 'Other fixture', status: 'approved', role: 'viewer', created: Date.now(), approved: Date.now(), expires: Date.now() + 3600000 },
		[digest(adminToken)]: { id: adminId, name: 'Share fixture', status: 'approved', role: 'admin', created: Date.now(), approved: Date.now(), expires: Date.now() + 3600000 }
	}));
	writeFileSync(path.join(directory, 'account-limits.json'), JSON.stringify({ accounts: {} }));
	(await import('./enabled-fixture.mjs')).enableIntegrations();
	const { app } = await import('../server.mjs');
	local.on('request', app);
	const base = `http://127.0.0.1:${local.address().port}`;
	const request = (route, body = undefined, token = '') => fetch(base + route, {
		method: body === undefined ? 'GET' : 'POST',
		headers: { 'Content-Type': 'application/json', Origin: base, ...(token ? { Authorization: 'Bearer ' + token } : {}) },
		body: body === undefined ? undefined : JSON.stringify(body)
	});
	t.after(() => {
		for (const server of servers) { server.closeAllConnections(); server.close(); }
		rmSync(directory, { recursive: true, force: true });
	});

	const play = await request('/api/play', { id }, token);
	const playBody = await play.json();
	assert.equal(play.status, 200, JSON.stringify(playBody));
	const { session } = playBody;
	assert.ok(session);

	let heartbeat = await request('/api/sessions/' + session, { action: 'progress', position: 12, paused: true }, token);
	assert.equal(heartbeat.status, 204);
	await wait(1300);
	heartbeat = await request('/api/sessions/' + session, { action: 'progress', position: 12, paused: true }, token);
	assert.equal(heartbeat.status, 409);
	const first = await heartbeat.json();
	assert.equal(first.code, 'PAUSED_TIMEOUT');
	assert.equal(first.position, 12);

	const repeated = await request('/api/sessions/' + session, { action: 'progress', position: 12, paused: true }, token);
	assert.equal(repeated.status, 409, 'the tombstone must remain idempotent after the first response');
	assert.equal((await repeated.json()).code, 'PAUSED_TIMEOUT');
	const otherOwner = await request('/api/sessions/' + session, { action: 'progress', position: 12, paused: true }, otherToken);
	assert.equal(otherOwner.status, 204, 'another owner must not observe or consume the tombstone');
	const stillThere = await request('/api/sessions/' + session, { action: 'progress', position: 12, paused: true }, token);
	assert.equal(stillThere.status, 409, 'the original owner must still receive the terminal reason');
	const stoppedRequest = await request('/api/sessions/' + session, { action: 'stop', position: 12 }, token);
	assert.equal(stoppedRequest.status, 409, 'an explicit stop must also observe the terminal reason');
	assert.equal((await stoppedRequest.json()).code, 'PAUSED_TIMEOUT');

	await wait(100);
	assert.ok(stopped >= 1, 'Jellyfin stop must be sent during timeout cleanup');

	const shareResponse = await request('/api/shares', { id }, adminToken);
	const shareBody = await shareResponse.json();
	assert.equal(shareResponse.status, 201, JSON.stringify(shareBody));
	const sharePath = new URL(shareBody.url).pathname;
	const sharePlay = await request(sharePath + '/play', { id });
	const sharePlayBody = await sharePlay.json();
	assert.equal(sharePlay.status, 200, JSON.stringify(sharePlayBody));
	const shareSession = sharePlayBody.session;
	assert.ok(shareSession);
	assert.equal((await request(sharePath + '/session/' + shareSession, { action: 'progress', position: 21, paused: true })).status, 204);
	await wait(1300);
	const shareTimeout = await request(sharePath + '/session/' + shareSession, { action: 'progress', position: 21, paused: true });
	assert.equal(shareTimeout.status, 409);
	const shareReason = await shareTimeout.json();
	assert.equal(shareReason.code, 'PAUSED_TIMEOUT');
	assert.equal(shareReason.position, 21);
	assert.equal((await request(sharePath + '/session/' + shareSession, { action: 'stop', position: 21 })).status, 409);
	await wait(100);
	assert.ok(stopped >= 2, 'shared-link timeout must also stop Jellyfin cleanly');
});
