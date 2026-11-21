import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createSetup } from '../homelab/admin.mjs';
import { installAuth } from '../auth.mjs';

function directory(t, prefix) {
	const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

function get(port, route, headers = {}) {
	return new Promise((resolve, reject) => {
		const request = httpRequest({ host: '127.0.0.1', port, path: route, method: 'GET', headers }, response => {
			const chunks = [];
			response.on('data', chunk => chunks.push(chunk));
			response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, text: Buffer.concat(chunks).toString() }));
		});
		request.on('error', reject);
		request.end();
	});
}

async function setupFixture(t) {
	const setup = createSetup({ directory: directory(t, 'tellybox-setup-137-'), apply: async () => {} });
	const server = setup.app.listen(0, '127.0.0.1');
	await once(server, 'listening');
	t.after(() => server.close());
	return { port: server.address().port };
}

async function authFixture(t, options = {}) {
	const app = express();
	app.use(express.json());
	const local = app.listen(0, '127.0.0.1');
	const remote = app.listen(0, '127.0.0.1');
	await Promise.all([once(local, 'listening'), once(remote, 'listening')]);
	t.after(() => { local.closeAllConnections(); remote.closeAllConnections(); local.close(); remote.close(); });
	installAuth(app, {
		directory: directory(t, 'tellybox-auth-137-'),
		publicDirectory: fileURLToPath(new URL('../public', import.meta.url)),
		localPort: local.address().port,
		localHosts: ['127.0.0.1'],
		localNetworks: ['127.0.0.0/8'],
		setupPort: 8990,
		...options
	});
	return { localPort: local.address().port, remotePort: remote.address().port };
}

test('a fresh setup serves the real page at the root with Host localhost', async t => {
	const { port } = await setupFixture(t);
	const root = await get(port, '/', { Host: 'localhost:' + port });
	assert.equal(root.status, 200);
	assert.match(root.headers['content-type'], /^text\/html;\s*charset=utf-8$/i);
	assert.match(root.text, /<title>Tellybox HomeLab/);
	assert.match(root.text, /Setup<\/title>/);
	assert.equal((await get(port, '/setup.js', { Host: 'localhost:' + port })).status, 200);
	assert.deepEqual(JSON.parse((await get(port, '/api/setup/status', { Host: 'localhost:' + port })).text), { claimed: false });
});

test('the setup Host allowlist rejects spoofed hosts and untrusted forwarded hosts', async t => {
	const { port } = await setupFixture(t);
	assert.equal((await get(port, '/', { Host: 'evil.example' })).status, 403);
	assert.equal((await get(port, '/', { Host: '192.168.50.12:' + port })).status, 403);
	assert.equal((await get(port, '/', { Host: 'localhost:' + port, 'X-Forwarded-Host': '192.168.50.12:8990' })).status, 403);
	assert.equal((await get(port, '/', { Host: 'evil.example', 'X-Forwarded-Host': 'localhost:' + port })).status, 403);
});

test('only a local status response includes the server-computed installation origin', async t => {
	const { localPort, remotePort } = await authFixture(t);
	const local = JSON.parse((await get(localPort, '/api/auth/status')).text);
	assert.equal(local.local, true);
	assert.deepEqual(local.installation, { origin: 'http://127.0.0.1:8990', port: 8990 });

	const remote = JSON.parse((await get(remotePort, '/api/auth/status')).text);
	assert.equal(remote.local, false);
	assert.equal('installation' in remote, false);
});

test('untrusted forwarded headers never create or change an installation link', async t => {
	const { localPort, remotePort } = await authFixture(t);
	const forwarded = { 'X-Forwarded-Host': '192.168.50.12:8990', 'X-Forwarded-For': '198.51.100.7' };
	const local = JSON.parse((await get(localPort, '/api/auth/status', forwarded)).text);
	assert.equal(local.local, false);
	assert.equal('installation' in local, false);

	const remote = JSON.parse((await get(remotePort, '/api/auth/status', forwarded)).text);
	assert.equal(remote.local, false);
	assert.equal('installation' in remote, false);
});

test('an explicitly configured private Host is used without deriving it from the browser', async t => {
	const { localPort } = await authFixture(t, { localHosts: ['127.0.0.1', '192.168.50.12'] });
	const status = JSON.parse((await get(localPort, '/api/auth/status', { Host: '192.168.50.12:' + localPort })).text);
	assert.equal(status.local, true);
	assert.deepEqual(status.installation, { origin: 'http://192.168.50.12:8990', port: 8990 });
});

test('an explicitly configured setup origin is returned only to local callers', async t => {
	const { localPort, remotePort } = await authFixture(t, { setupPublicOrigin: 'https://setup.home.example:8443/' });
	const local = JSON.parse((await get(localPort, '/api/auth/status')).text);
	assert.deepEqual(local.installation, { origin: 'https://setup.home.example:8443', port: 8443 });
	const remote = JSON.parse((await get(remotePort, '/api/auth/status')).text);
	assert.equal('installation' in remote, false);
});

test('an unsafe configured setup origin is omitted instead of being repaired', async t => {
	for (const value of ['http://user:secret@setup.home.example:8990', 'http://setup.home.example:8990/private', 'http://setup.home.example:8990/?next=1', 'file:///setup']) {
		const { localPort } = await authFixture(t, { setupPublicOrigin: value });
		const local = JSON.parse((await get(localPort, '/api/auth/status')).text);
		assert.equal('installation' in local, false, value);
	}
});

test('the settings script uses the server field and never rewrites localPlayback to port 8990', () => {
	const source = readFileSync(fileURLToPath(new URL('../public/installation-settings.js', import.meta.url)), 'utf8');
	assert.equal(/localPlayback/.test(source), false);
	assert.match(source, /access\.installation/);
	assert.equal(/url\.port\s*=\s*['"]8990['"]/.test(source), false);
	assert.match(source, /administrator password is required/);
});
