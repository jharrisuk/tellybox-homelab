/* The main Settings page no longer has an Integrations tab or any qBittorrent
 * configuration surface. Connection settings and credential editing live in
 * installation settings on port 8990 behind the owner session. The read-only
 * summary stays, and every owner route remains authenticated.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import { installQbittorrentRoutes } from '../qbittorrent.mjs';

const settings = readFileSync(new URL('../public/settings.html', import.meta.url), 'utf8');
const settingsScript = readFileSync(new URL('../public/qbittorrent-settings.js', import.meta.url), 'utf8');

test('the empty Integrations tab and the qBittorrent configuration form are gone', () => {
	assert.doesNotMatch(settings, /data-panel="integrations"/);
	assert.doesNotMatch(settings, /data-settings="integrations"/);
	assert.doesNotMatch(settings, /settingsTabIntegrations|settingsPanelIntegrations/);
	assert.match(settings, /id="qbittorrentSettings"/, 'the read-only statistics remain on the Server panel');
	assert.equal(settings.includes('>Integrations<'), false);
});

test('the read-only script cannot configure qBittorrent or send a credential', () => {
	assert.match(settingsScript, /\/api\/qbittorrent\/summary/);
	assert.doesNotMatch(settingsScript, /\/api\/qbittorrent\/(?:status|config|disconnect)/);
	assert.doesNotMatch(settingsScript, /createElement\('form'\)|createElement\('input'\)|type\s*=\s*'password'/);
	assert.doesNotMatch(settingsScript, /\bpassword\b/i);
	assert.doesNotMatch(settingsScript, /\busername\b/i);
});

test('qBittorrent status and every mutation route stay owner-only', async t => {
	const directory = mkdtempSync(path.join(tmpdir(), 'tellybox-integrations-137-'));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const configPath = path.join(directory, 'qbittorrent.json');
	const saved = JSON.stringify({
		url: 'http://127.0.0.1:9/', username: 'synthetic-owner', password: 'synthetic-password',
		enabled: true, pollSeconds: 20, stalledMinutes: 30
	});
	writeFileSync(configPath, saved);

	const denied = [];
	const requireOwner = (req, res) => {
		denied.push(req.method + ' ' + req.path);
		res.status(401).json({ error: 'Sign in as installation administrator.', signInRequired: true });
		return false;
	};
	const app = express();
	app.use(express.json());
	installQbittorrentRoutes(app, { requireOwner, directory, sameOrigin: () => true });
	const server = await new Promise(resolve => {
		const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
	});
	t.after(() => { server.closeAllConnections?.(); server.close(); });
	const base = 'http://127.0.0.1:' + server.address().port;
	const call = (route, method = 'GET', body) => fetch(base + route, {
		method,
		headers: {
			Origin: base,
			...(body === undefined ? {} : { 'content-type': 'application/json' })
		},
		body: body === undefined ? undefined : JSON.stringify(body)
	});

	const status = await call('/api/qbittorrent/status');
	assert.equal(status.status, 401);
	assert.equal((await status.json()).signInRequired, true);
	assert.equal(status.headers.get('cache-control'), 'no-store');

	for (const route of [
		'/api/qbittorrent/config',
		'/api/qbittorrent/disconnect',
		'/api/qbittorrent/confirm',
		'/api/qbittorrent/delete'
	]) {
		const response = await call(route, 'POST', { enabled: false, id: 'a'.repeat(32), token: 'b'.repeat(64) });
		assert.equal(response.status, 401, route + ' must refuse an unauthenticated caller');
		assert.equal((await response.json()).signInRequired, true);
	}
	const downloads = await call('/api/qbittorrent/downloads');
	assert.equal(downloads.status, 401);
	const page = await call('/activity/downloads');
	assert.equal(page.status, 401);

	assert.equal(denied.length, 7, 'every route asked the owner boundary first');
	// No mutation ran: the saved configuration is byte-for-byte unchanged and
	// no temporary write exists.
	assert.equal(readFileSync(configPath, 'utf8'), saved);
	assert.deepEqual(readdirSync(directory), ['qbittorrent.json']);
});
