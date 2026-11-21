/* qBittorrent configuration belongs to installation settings on port 8990.
 *
 * These tests prove that the setup service writes the exact file the media
 * process reads, that the password is never returned, that a disabled
 * integration makes no upstream call, and that the explicit connection test
 * reports every failure mode without echoing the target or credentials.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createSetup } from '../homelab/admin.mjs';
import { defaultConfig, materialize } from '../homelab/config.mjs';
import { createQbittorrent } from '../qbittorrent.mjs';

const PASSWORD = 'synthetic-qbittorrent-secret';
const USERNAME = 'synthetic-webui-owner';
const ADDRESS = 'http://qbit.internal:8080';

function directory(t) {
	const dir = mkdtempSync(path.join(tmpdir(), 'tellybox-setup-qb-140-'));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

async function fixture(t) {
	const dir = directory(t);
	const calls = [];
	let handler = async () => new Response('Ok.', { status: 200, headers: { 'set-cookie': 'SID=synthetic' } });
	const setup = createSetup({
		directory: dir,
		apply: async () => {},
		fetcher: async (url, options) => {
			calls.push({ url: String(url), method: options?.method || 'GET', body: options?.body });
			return handler(url, options);
		}
	});
	const server = setup.app.listen(0, '127.0.0.1');
	await once(server, 'listening');
	t.after(() => server.close());
	const base = 'http://127.0.0.1:' + server.address().port;
	const req = (route, body, headers = {}) => fetch(base + '/api/setup/' + route, {
		method: body ? 'POST' : 'GET',
		headers: { ...(body ? { 'Content-Type': 'application/json', Origin: base } : {}), ...headers },
		body: body ? JSON.stringify(body) : undefined
	});
	const login = await req('login', {
		bootstrap: JSON.parse(readFileSync(path.join(dir, 'bootstrap.json'), 'utf8')).token,
		password: 'synthetic-setup-password-1234'
	});
	assert.equal(login.status, 200);
	const cookie = login.headers.get('set-cookie').split(';')[0];
	return {
		dir, req, cookie,
		withSession: (route, body) => req(route, body, { Cookie: cookie }),
		setHandler: value => { handler = value; },
		calls
	};
}

const savedBody = {
	url: ADDRESS, username: USERNAME, password: PASSWORD,
	enabled: true, pollSeconds: 20, stalledMinutes: 30
};

test('settings saved on the setup site are the file the media process reads', async t => {
	const f = await fixture(t);

	const saved = await f.withSession('qbittorrent', savedBody);
	assert.equal(saved.status, 200);
	const savedText = await saved.text();
	assert.equal(savedText.includes(PASSWORD), false, 'the saved response never contains the password');
	assert.equal(savedText.includes('password'), false, 'the saved response has no password key');

	const file = path.join(f.dir, 'access', 'qbittorrent.json');
	const stored = JSON.parse(readFileSync(file, 'utf8'));
	assert.equal(stored.url, ADDRESS);
	assert.equal(stored.username, USERNAME);
	assert.equal(stored.password, PASSWORD);
	assert.equal(stored.enabled, true);

	// This is the exact constructor the media process uses in server.mjs.
	const qb = createQbittorrent({ file });
	const status = qb.status();
	assert.equal(status.configured, true);
	assert.equal(status.enabled, true);
	assert.equal(status.pollSeconds, 20);
	assert.equal(status.stalledMinutes, 30);

	const readBack = await f.withSession('qbittorrent');
	const text = await readBack.text();
	assert.equal(readBack.status, 200);
	assert.equal(text.includes(PASSWORD), false, 'the read route never returns the password');
	assert.equal(text.includes('password'), false, 'no password key is returned');
	assert.equal(JSON.parse(text).username, USERNAME);

	// A later save with a blank password keeps the saved secret.
	const kept = await f.withSession('qbittorrent', { enabled: false, password: '' });
	assert.equal(kept.status, 200);
	assert.equal(JSON.parse(readFileSync(file, 'utf8')).password, PASSWORD);
	assert.equal((await kept.text()).includes(PASSWORD), false);

	// A restart materializes the installation configuration into the same
	// AUTH_DIR. That must not remove or rewrite the qBittorrent file.
	materialize(defaultConfig(), f.dir);
	const afterRestart = createQbittorrent({ file }).status();
	assert.equal(afterRestart.configured, true);
	assert.equal(afterRestart.enabled, false);
});

test('a disabled integration is saved with no upstream request', async t => {
	const f = await fixture(t);
	const saved = await f.withSession('qbittorrent', { ...savedBody, enabled: false });
	assert.equal(saved.status, 200);
	assert.equal(f.calls.length, 0, 'saving does not contact qBittorrent');

	let called = false;
	const qb = createQbittorrent({
		file: path.join(f.dir, 'access', 'qbittorrent.json'),
		fetcher: () => { called = true; throw Error('upstream must not be called'); }
	});
	const summary = await qb.summary();
	assert.equal(summary.state, 'disabled');
	assert.equal(summary.configured, true);
	assert.equal(summary.enabled, false);
	assert.equal(called, false, 'monitoring disabled means no upstream call');
});

test('the connection test reports reachable, auth-failed, timeout and unreachable without credentials', async t => {
	const f = await fixture(t);
	assert.equal((await f.withSession('qbittorrent', { ...savedBody, enabled: false })).status, 200);

	const results = [];
	f.setHandler(async () => new Response('Ok.', { status: 200, headers: { 'set-cookie': 'SID=synthetic' } }));
	results.push({ mode: 'ok', body: await (await f.withSession('qbittorrent/test', { password: '' })).json() });

	f.setHandler(async () => new Response('Fails.', { status: 200 }));
	results.push({ mode: 'auth-failed', body: await (await f.withSession('qbittorrent/test', { password: '' })).json() });

	f.setHandler(async () => { throw Object.assign(Error('timed out'), { name: 'TimeoutError' }); });
	results.push({ mode: 'timeout', body: await (await f.withSession('qbittorrent/test', { password: '' })).json() });

	f.setHandler(async () => { throw new TypeError('fetch failed'); });
	results.push({ mode: 'unreachable', body: await (await f.withSession('qbittorrent/test', { password: '' })).json() });

	assert.equal(results[0].body.ok, true);
	assert.equal(results[0].body.state, 'ok');
	assert.equal(results[1].body.ok, false);
	assert.equal(results[1].body.state, 'auth-failed');
	assert.equal(results[2].body.ok, false);
	assert.equal(results[2].body.state, 'timeout');
	assert.equal(results[3].body.ok, false);
	assert.equal(results[3].body.state, 'unreachable');

	const text = JSON.stringify(results);
	assert.equal(text.includes(PASSWORD), false, 'the test result never contains the password');
	assert.equal(text.includes(USERNAME), false, 'the test result never contains the username');
	assert.equal(text.includes(ADDRESS), false, 'the test result never contains the WebUI address');
	assert.equal(text.includes('"password"'), false, 'the test result has no password key');
	for (const result of results) assert.match(result.body.message, /[.!]$/);
});

test('configuration, tests and removal all require the owner session', async t => {
	const f = await fixture(t);
	for (const [route, body] of [
		['qbittorrent', savedBody],
		['qbittorrent/test', savedBody],
		['qbittorrent/disconnect', {}]
	]) {
		const response = await f.req(route, body);
		assert.equal(response.status, 401, route + ' must refuse an unauthenticated caller');
	}
	assert.equal((await f.req('qbittorrent')).status, 401);
	assert.equal(f.calls.length, 0, 'no unauthenticated request reaches qBittorrent');
});

test('installation settings contain the qBittorrent section and no old monitor sentence', async t => {
	const f = await fixture(t);
	const page = await f.withSession('config');
	// The static page is served outside /api/setup, so read the source directly.
	const html = readFileSync(new URL('../homelab/public/index.html', import.meta.url), 'utf8');
	const script = readFileSync(new URL('../homelab/public/setup.js', import.meta.url), 'utf8');
	assert.match(html, /id="qbittorrentPanel"/);
	assert.match(html, /id="qbittorrentForm"/);
	assert.match(html, /id="qbittorrentTest"/);
	assert.match(html, /id="qbittorrentRemove"/);
	assert.match(html, /name="pollSeconds"/);
	assert.match(html, /name="stalledMinutes"/);
	assert.match(html, /name="enabled"/);
	assert.doesNotMatch(html, /Dispatcharr connection settings stay here/);
	assert.doesNotMatch(html, /Upstream channel and connection monitoring/);
	assert.doesNotMatch(script, /streamsActivityLink/);
	assert.equal(page.status, 200, 'the owner can still read installation configuration');
});

test('removing the saved connection deletes the file and leaves the app unconfigured', async t => {
	const f = await fixture(t);
	await f.withSession('qbittorrent', { ...savedBody, enabled: false });
	const file = path.join(f.dir, 'access', 'qbittorrent.json');
	assert.equal(existsSync(file), true);
	const removed = await f.withSession('qbittorrent/disconnect', {});
	assert.equal(removed.status, 200);
	const body = await removed.json();
	assert.equal(body.configured, false);
	assert.equal(body.removed, true);
	assert.equal(existsSync(file), false);
	assert.equal(JSON.stringify(body).includes(PASSWORD), false);
});

test('an out-of-band setup save is noticed by the running media process', async t => {
	const f = await fixture(t);
	await f.withSession('qbittorrent', { ...savedBody, enabled: false });
	const file = path.join(f.dir, 'access', 'qbittorrent.json');
	const qb = createQbittorrent({ file, fetcher: () => { throw Error('upstream must not be called while disabled'); } });
	const first = qb.status();
	assert.equal(first.generation, 1);
	assert.equal(first.enabled, false);

	await f.withSession('qbittorrent', { username: 'changed-owner', enabled: false });
	const second = qb.status();
	assert.equal(second.configured, true);
	assert.equal(second.enabled, false);
	assert.equal(second.generation, first.generation + 1, 'the file change starts a new configuration generation');
	const summary = await qb.summary();
	assert.equal(summary.state, 'disabled');
});

test('a write is atomic and leaves only the real configuration file', async t => {
	const f = await fixture(t);
	await f.withSession('qbittorrent', savedBody);
	const access = path.join(f.dir, 'access');
	assert.deepEqual(readdirSync(access), ['qbittorrent.json'], 'no temporary file is left behind');
	const before = readFileSync(path.join(access, 'qbittorrent.json'), 'utf8');
	const again = await f.withSession('qbittorrent', { ...savedBody, enabled: false });
	assert.equal(again.status, 200);
	assert.equal(JSON.parse(before).enabled, true);
	assert.equal(JSON.parse(readFileSync(path.join(access, 'qbittorrent.json'), 'utf8')).enabled, false);
	assert.deepEqual(readdirSync(access), ['qbittorrent.json']);
});
