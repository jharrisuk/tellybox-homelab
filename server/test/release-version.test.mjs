import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { once } from 'node:events';
import { get } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { installReleaseVersion, serverRelease } from '../release-version.mjs';
import { createSetup } from '../homelab/admin.mjs';

async function listen(t, app) {
	const listener = app.listen(0, '127.0.0.1');
	await once(listener, 'listening');
	t.after(() => listener.close());
	return `http://127.0.0.1:${listener.address().port}`;
}

test('release information exposes only the server product and package version, without caching stale upgrades', async t => {
	const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
	const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'));
	assert.equal(manifest.version, lock.version);
	assert.equal(manifest.version, lock.packages[''].version);
	const app = express(); installReleaseVersion(app);
	const base = await listen(t, app), response = await fetch(base + '/api/version');
	assert.equal(response.status, 200);
	assert.equal(response.headers.get('cache-control'), 'no-store');
	assert.deepEqual(await response.json(), { product: 'Tellybox', version: manifest.version });
});

test('installation setup shows the same release without exposing configuration or bypassing host protection', async t => {
	const directory = mkdtempSync(path.join(os.tmpdir(), 'tellybox-release-'));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const { app } = createSetup({ directory });
	const base = await listen(t, app);
	assert.deepEqual(await (await fetch(base + '/api/version')).json(), serverRelease);
	assert.equal((await fetch(base + '/api/setup/config')).status, 401);
	const spoofedStatus = await new Promise((resolve, reject) => {
		get(base + '/api/version', { headers: { host: 'untrusted.example' } }, response => {
			response.resume(); resolve(response.statusCode);
		}).on('error', reject);
	});
	assert.equal(spoofedStatus, 403);
	assert.equal((await fetch(base + '/server-version.js')).status, 200);
});

test('web release labels ignore invalid responses and network failures without affecting the page', async () => {
	const script = readFileSync(new URL('../public/server-version.js', import.meta.url), 'utf8');
	async function render(fetcher) {
		const labels = [{ textContent: '', hidden: true }, { textContent: '', hidden: true }];
		await vm.runInNewContext(script, { fetch: fetcher, document: { querySelectorAll: () => labels } });
		return labels;
	}
	const good = await render(async () => ({ ok: true, json: async () => serverRelease }));
	assert.ok(good.every(label => label.textContent === `Server v${serverRelease.version}` && !label.hidden));
	for (const fetcher of [
		async () => { throw Error('Offline'); },
		async () => ({ ok: false }),
		async () => ({ ok: true, json: async () => ({ version: '<img src=x onerror=alert(1)>' }) })
	]) assert.ok((await render(fetcher)).every(label => label.textContent === '' && label.hidden));
});
