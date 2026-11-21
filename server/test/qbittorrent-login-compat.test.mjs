/* qBittorrent WebUI login compatibility across versions.
 *
 * qBittorrent 4.x answered a cookie login with 200 "Ok."; 5.x answers 204 with
 * the SID cookie and no body. Both must count as a signed-in session, an
 * unreadable answer must not be reported as a rejected password, and an
 * apparent success without a session cookie must not continue unauthenticated.
 * Every fetcher here is synthetic; no live qBittorrent or credential is used.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createQbittorrent, probeQbittorrent } from '../qbittorrent.mjs';

const WEBUI = 'http://qbt.example:8080';
const USERNAME = 'synthetic-webui-user';
const PASSWORD = 'synthetic-webui-password';
const SID = 'SID=synthetic-session';

function loginAnswer({ status = 200, body = '', cookie = '' } = {}) {
	// A 204 response has no body; fetch refuses a non-null body for it.
	const headers = cookie ? { 'set-cookie': cookie + '; path=/' } : {};
	return new Response(status === 204 ? null : body, { status, headers });
}

function probeTarget(overrides = {}) {
	return { url: WEBUI, username: USERNAME, password: PASSWORD, ...overrides };
}

async function probeWith(makeResponse) {
	const calls = [];
	const fetcher = async (url, options) => {
		calls.push({ url: String(url), method: options?.method, headers: { ...options?.headers } });
		return makeResponse();
	};
	return { result: await probeQbittorrent(probeTarget(), { fetcher }), calls };
}

// Each case is the exact answer the live WebUI can give. `state` is the only
// state vocabulary the settings panel already understands.
const PROBE_CASES = [
	{
		name: '204 with a SID cookie is a qBittorrent 5.x success',
		make: () => loginAnswer({ status: 204, cookie: SID }),
		state: 'ok', ok: true
	},
	{
		name: '200 Ok. with a SID cookie is a legacy success',
		make: () => loginAnswer({ status: 200, body: 'Ok.', cookie: SID }),
		state: 'ok', ok: true
	},
	{
		name: '200 Ok without the optional period still succeeds',
		make: () => loginAnswer({ status: 200, body: 'OK', cookie: SID }),
		state: 'ok', ok: true
	},
	{
		name: '200 Fails. is an actual credential rejection',
		make: () => loginAnswer({ status: 200, body: 'Fails.' }),
		state: 'auth-failed', ok: false, rejected: true
	},
	{
		name: '403 is the temporary address ban',
		make: () => loginAnswer({ status: 403, body: 'banned' }),
		state: 'banned', ok: false, rejected: true
	},
	{
		name: '401 is an actual credential rejection',
		make: () => loginAnswer({ status: 401 }),
		state: 'auth-failed', ok: false, rejected: true
	},
	{
		name: '200 with an empty body and no cookie is unreadable',
		make: () => loginAnswer({ status: 200, body: '' }),
		state: 'invalid', ok: false
	},
	{
		name: '204 without a SID cookie must not continue unauthenticated',
		make: () => loginAnswer({ status: 204 }),
		state: 'invalid', ok: false
	},
	{
		name: '200 Ok. without a SID cookie must not continue unauthenticated',
		make: () => loginAnswer({ status: 200, body: 'Ok.' }),
		state: 'invalid', ok: false
	},
	{
		name: 'a 500 login answer is unreadable, not a rejected password',
		make: () => loginAnswer({ status: 500, body: 'Internal Server Error' }),
		state: 'invalid', ok: false
	},
	{
		name: 'a 502 login answer is unreadable, not a rejected password',
		make: () => loginAnswer({ status: 502 }),
		state: 'invalid', ok: false
	}
];

for (const item of PROBE_CASES) {
	test('connection test: ' + item.name, async () => {
		const { result, calls } = await probeWith(item.make);
		assert.equal(result.ok, item.ok);
		assert.equal(result.state, item.state);
		assert.equal(calls.length, 1);
		assert.equal(calls[0].url, WEBUI + '/api/v2/auth/login');
		assert.equal(calls[0].method, 'POST');
		if (item.rejected) {
			// A real rejection may talk about credentials; an unreadable answer may not.
			assert.match(result.message, /refused|banned|username and password/);
		} else if (item.state === 'invalid') {
			assert.match(result.message, /could not be read as a session/i);
			assert.doesNotMatch(result.message, /refused|username and password/i);
		}
		// The probe never echoes the password or username back.
		assert.equal(JSON.stringify(result).includes(PASSWORD), false);
		assert.equal(JSON.stringify(result).includes(USERNAME), false);
	});
}

function temporaryConfig(t) {
	const directory = mkdtempSync(path.join(tmpdir(), 'tellybox-qbt-login-'));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const file = path.join(directory, 'qbittorrent.json');
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, JSON.stringify({
		url: WEBUI, username: USERNAME, password: PASSWORD,
		enabled: true, pollSeconds: 20, stalledMinutes: 30
	}));
	return file;
}

/* A fake WebUI that records request paths and the cookie header each one used.
 * Login answers come from `makeLogin`; every later route requires the SID. */
function fakeWebUi(makeLogin) {
	const calls = [];
	const fetcher = async (url, options = {}) => {
		const pathname = new URL(String(url)).pathname;
		calls.push({ pathname, headers: { ...options.headers } });
		if (pathname === '/api/v2/auth/login') return makeLogin();
		if (pathname === '/api/v2/app/webapiVersion') return new Response('2.11.2', { status: 200 });
		if (pathname === '/api/v2/app/version') return new Response('v5.0.3', { status: 200 });
		if (pathname === '/api/v2/torrents/info') return new Response('[]', { status: 200 });
		if (pathname === '/api/v2/torrents/categories') return new Response('{}', { status: 200 });
		if (pathname === '/api/v2/transfer/info') {
			return new Response(JSON.stringify({ dl_info_speed: 0, up_info_speed: 0, connection_status: 'connected' }), { status: 200 });
		}
		return new Response('', { status: 404 });
	};
	return { calls, fetcher };
}

function dataCalls(calls) {
	return calls.filter(call => call.pathname !== '/api/v2/auth/login');
}

for (const [label, makeLogin] of [
	['204 with a SID cookie', () => loginAnswer({ status: 204, cookie: SID })],
	['200 Ok. with a SID cookie', () => loginAnswer({ status: 200, body: 'Ok.', cookie: SID })]
]) {
	test('monitoring login: ' + label + ' captures and reuses the SID', async t => {
		const file = temporaryConfig(t);
		const { calls, fetcher } = fakeWebUi(makeLogin);
		const qb = createQbittorrent({ file, fetcher, clock: () => 1_700_000_000_000 });
		const summary = await qb.summary();
		assert.equal(summary.state, 'ok');
		assert.equal(summary.reachable, true);
		assert.equal(calls.filter(call => call.pathname === '/api/v2/auth/login').length, 1);
		const later = dataCalls(calls);
		assert.ok(later.length >= 3, 'version and torrent reads follow the login');
		for (const call of later) {
			assert.equal(call.headers.cookie, SID, 'every later API call must use the captured SID');
			assert.equal(call.headers.referer, 'http://qbt.example:8080/');
		}
	});
}

const FAILURE_CASES = [
	{
		name: '200 Fails. is reported as a credential rejection',
		make: () => loginAnswer({ status: 200, body: 'Fails.' }),
		state: 'auth-failed'
	},
	{
		name: '403 is reported as the address ban',
		make: () => loginAnswer({ status: 403, body: 'banned' }),
		state: 'banned'
	},
	{
		name: '401 is reported as a credential rejection',
		make: () => loginAnswer({ status: 401 }),
		state: 'auth-failed'
	},
	{
		name: '200 with an empty body and no cookie is unreadable and makes no data call',
		make: () => loginAnswer({ status: 200, body: '' }),
		state: 'invalid'
	},
	{
		name: '204 without a SID cookie is unreadable and makes no data call',
		make: () => loginAnswer({ status: 204 }),
		state: 'invalid'
	},
	{
		name: '500 is unreadable and makes no data call',
		make: () => loginAnswer({ status: 500 }),
		state: 'invalid'
	}
];

for (const item of FAILURE_CASES) {
	test('monitoring login: ' + item.name, async t => {
		const file = temporaryConfig(t);
		const { calls, fetcher } = fakeWebUi(item.make);
		const qb = createQbittorrent({ file, fetcher, clock: () => 1_700_000_000_000 });
		const summary = await qb.summary();
		assert.equal(summary.state, item.state);
		assert.equal(summary.reachable, false);
		assert.equal(dataCalls(calls).length, 0, 'a failed login must not continue without a session');
		if (item.state === 'invalid') {
			const notice = await qb.status();
			assert.match(notice.notice, /could not read/i);
			assert.doesNotMatch(notice.notice, /refused the saved WebUI sign-in/i);
		}
	});
}
