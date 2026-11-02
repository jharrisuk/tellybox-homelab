import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import { installAuth } from '../auth.mjs';
import { createActivity } from '../activity.mjs';

async function fixture(t, directory, extra = {}) {
	const app = express();
	app.use(express.json());
	const local = await new Promise(resolve => { const server = app.listen(0, '127.0.0.1', () => resolve(server)); });
	const remote = await new Promise(resolve => { const server = app.listen(0, '127.0.0.1', () => resolve(server)); });
	t.after(() => { local.closeAllConnections(); remote.closeAllConnections(); local.close(); remote.close(); });
	const audit = createActivity(directory);
	installAuth(app, {
		directory, publicDirectory: path.resolve('public'), localPort: local.address().port,
		localHosts: ['127.0.0.1'], localNetworks: ['127.0.0.0/8'], audit, ...extra
	});
	app.use(express.static(path.resolve('public')));
	const base = side => `http://127.0.0.1:${(side === 'local' ? local : remote).address().port}`;
	const request = (side, route, body, cookie) => fetch(base(side) + route, {
		method: body === undefined ? 'GET' : 'POST', redirect: 'manual',
		headers: {
			...(body === undefined ? {} : { 'Content-Type': 'application/json', Origin: base(side) }),
			...(cookie ? { Cookie: cookie } : {})
		},
		body: body === undefined ? undefined : JSON.stringify(body)
	});
	return { request, base };
}

test('preferences page is denied signed out, available to approved remote viewers and local viewers, and separate from settings', async t => {
	const directory = mkdtempSync(path.join(tmpdir(), 'tellybox-preferences-'));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	let mail;
	const { request } = await fixture(t, directory, { emailDelivery: async value => { mail = value; } });

	assert.equal((await request('remote', '/preferences.html')).status, 401);
	assert.equal((await request('remote', '/viewer-preferences.js')).status, 401);
	const local = await request('local', '/preferences.html');
	assert.equal(local.status, 200);
	assert.match(local.headers.get('content-type'), /text\/html/);
	const localText = await local.text();
	assert.match(localText, /Watching settings/);
	for (const id of ['englishSubtitles', 'autoNext', 'skipIntros']) assert.ok(localText.includes(`id="${id}"`), id);

	await request('local', '/api/auth/email/config', { enabled: true, key: 're_fixture_only_123456', from: 'watch@example.test' });
	const pending = await request('remote', '/api/auth/email/code', { email: 'viewer@example.test' });
	assert.deepEqual(await pending.json(), { status: 'pending' });
	const person = (await (await request('local', '/api/people')).json()).people[0];
	await request('local', '/api/people', { id: person.id, action: 'approve' });
	const challenge = await (await request('remote', '/api/auth/email/code', { email: person.email })).json();
	assert.equal(challenge.status, 'code-sent');
	const verified = await request('remote', '/api/auth/email/verify', { ...challenge, code: mail.code, remember: true });
	assert.equal(verified.status, 200);
	const cookie = verified.headers.get('set-cookie').split(';')[0];

	const remote = await request('remote', '/preferences.html', undefined, cookie);
	assert.equal(remote.status, 200);
	assert.match(remote.headers.get('content-type'), /text\/html/);
	const remoteText = await remote.text();
	assert.ok(remoteText.includes('/viewer-preferences.js'));
	for (const script of ['settings.js', 'installation-settings.js', 'people.js', 'apps.js', 'admin-downloads.js', 'auth.js']) assert.equal(remoteText.includes(script), false);
	const asset = await request('remote', '/viewer-preferences.js', undefined, cookie);
	assert.equal(asset.status, 200);
	assert.match(asset.headers.get('content-type'), /javascript/);
	const capabilities = await request('remote', '/api/capabilities', undefined, cookie);
	assert.equal(capabilities.status, 200);
	assert.deepEqual((await capabilities.json()).playbackDefaults, { englishSubtitles: false, autoNext: false, skipIntros: false });
	assert.equal((await request('remote', '/settings', undefined, cookie)).status, 403);
});
