/* Release 137: the activity summary mount order is exercised through the real
 * server.mjs, not a mirrored express app. The route must stay behind installAuth:
 * an anonymous remote caller is refused by the auth gate (401), an approved but
 * non-admin remote viewer by the summary guard (403), and a local caller gets the
 * sanitized read model with no-store.
 *
 * The positive home branch is tested at the installAuth boundary because
 * server.mjs only refreshes the home address when NODE_ENV !== 'test' and it
 * exposes no injection point for the HTTPS relay lookup. The classifier itself
 * (trusted proxy + forwarded proto + configured public origin + real home
 * matcher + client-ip header) is the real code; only the relay fetch is stubbed.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import express from 'express';
import { installAuth } from '../auth.mjs';
import { createActivity } from '../activity.mjs';
import { createHomeNetwork } from '../home-network.mjs';

const HOME_IP = '203.0.113.9';
const PUBLIC_ORIGIN = 'https://remote.test';
const SUMMARY_ERROR = 'Read-only activity statistics are available to installation administrators only.';

async function listen(handler) {
	const server = http.createServer(handler);
	server.listen(0, '127.0.0.1');
	await once(server, 'listening');
	return server;
}

// node:http, not fetch: the home classifier reads the Host header and fetch
// silently overwrites it with the socket address.
function get(port, route, headers = {}) {
	return new Promise((resolve, reject) => {
		const request = http.request({ host: '127.0.0.1', port, path: route, method: 'GET', headers }, response => {
			const chunks = [];
			response.on('data', chunk => chunks.push(chunk));
			response.on('end', () => resolve({
				status: response.statusCode,
				headers: response.headers,
				text: Buffer.concat(chunks).toString('utf8')
			}));
		});
		request.on('error', reject);
		request.end();
	});
}

test('the real server mounts the activity summary behind the auth gate and the administrator guard', { timeout: 45000 }, async t => {
	const directory = mkdtempSync(path.join(tmpdir(), 'tellybox-activity-mount-137-'));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const dead = await listen((req, res) => { res.writeHead(503); res.end('{}'); });
	t.after(() => { dead.closeAllConnections?.(); dead.close(); });
	const local = await listen(() => {});
	const remote = await listen(() => {});
	t.after(() => {
		local.closeAllConnections?.();
		remote.closeAllConnections?.();
		local.close();
		remote.close();
	});
	Object.assign(process.env, {
		NODE_ENV: 'test', AUTH_DIR: directory, DATA_DIR: directory, CATALOGUE_CACHE_DIR: directory,
		JELLYFIN_URL: 'http://127.0.0.1:' + dead.address().port,
		DISPATCHARR_URL: 'http://127.0.0.1:' + dead.address().port,
		PORT: String(local.address().port), SETUP_PORT: '8990',
		LOCAL_HOSTS: '127.0.0.1', LOCAL_NETWORKS: '127.0.0.0/8', PUBLIC_ORIGIN
	});
	writeFileSync(path.join(directory, 'connection.json'), JSON.stringify({ userId: 'fixture', token: 'fixture-only' }));
	writeFileSync(path.join(directory, 'apps.json'), JSON.stringify({}));
	writeFileSync(path.join(directory, 'account-limits.json'), JSON.stringify({ accounts: {} }));
	writeFileSync(path.join(directory, 'dispatcharr.json'), JSON.stringify({ key: 'fixture-only' }));
	writeFileSync(path.join(directory, 'capabilities.json'), JSON.stringify({
		jellyfin: true, library: true, live: false, nonstop: false, vod: false, recordings: false,
		catchup: false, discover: false, comingSoon: false, introdb: false, subtitles: false
	}));

	const { app } = await import('../server.mjs');
	local.on('request', app);
	remote.on('request', app);
	const localBase = 'http://127.0.0.1:' + local.address().port;
	const call = (base, route, { method = 'GET', body, headers = {} } = {}) => fetch(base + route, {
		method,
		headers: {
			...(body === undefined ? {} : { 'Content-Type': 'application/json', Origin: base }),
			...headers
		},
		body: body === undefined ? undefined : JSON.stringify(body)
	});

	// The remote listener is not the configured local port, so local() is false.
	// If the route were moved above installAuth this would be its 403 guard answer
	// instead of the gate's 401.
	const anonymous = await call('http://127.0.0.1:' + remote.address().port, '/api/activity/summary');
	assert.equal(anonymous.status, 401, 'an anonymous remote caller is stopped by the auth gate, not the summary guard');
	assert.equal((await anonymous.json()).error, 'Please sign in to jServer.');

	// A real approved viewer app is authenticated but is not an installation
	// administrator; the summary guard must answer its own 403.
	const enrolled = await call(localBase, '/api/apps/enroll', {
		method: 'POST', body: { name: 'Synthetic remote viewer 137' }
	});
	assert.ok([200, 201].includes(enrolled.status), 'local enrolment should succeed: ' + enrolled.status);
	const viewer = await enrolled.json();
	assert.equal(viewer.role, 'viewer');
	assert.equal(viewer.status, 'approved', 'a local enrolment is approved as a viewer');
	const remoteBase = 'http://127.0.0.1:' + remote.address().port;
	const denied = await call(remoteBase, '/api/activity/summary', {
		headers: { Authorization: 'Bearer ' + viewer.token }
	});
	assert.equal(denied.status, 403, 'an authenticated non-admin remote viewer is refused by the summary guard');
	assert.equal(denied.headers.get('cache-control'), 'no-store');
	assert.deepEqual(await denied.json(), { error: SUMMARY_ERROR });

	// Spoofing the viewer address still does not create local/home authority.
	const spoofed = await call(remoteBase, '/api/activity/summary', {
		headers: { Authorization: 'Bearer ' + viewer.token, 'X-Forwarded-For': '127.0.0.1', 'CF-Connecting-IP': '127.0.0.1' }
	});
	assert.equal(spoofed.status, 403);
	assert.deepEqual(await spoofed.json(), { error: SUMMARY_ERROR });

	const localSummary = await call(localBase, '/api/activity/summary');
	assert.equal(localSummary.status, 200);
	assert.equal(localSummary.headers.get('cache-control'), 'no-store');
	const body = await localSummary.json();
	assert.equal(body.readOnly, true);
	assert.equal(body.stats.active, 0);
	assert.ok(Array.isArray(body.active));
});

test('home presence alone no longer authorises the activity summary', async t => {
	const directory = mkdtempSync(path.join(tmpdir(), 'tellybox-activity-home-137-'));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const app = express();
	app.use(express.json());
	const server = app.listen(0, '127.0.0.1');
	await once(server, 'listening');
	t.after(() => { server.closeAllConnections?.(); server.close(); });

	// The real matcher, fed by a stubbed relay response. createHomeNetwork itself
	// rejects LAN, carrier-private and malformed answers; HOME_IP is TEST-NET-3.
	const homeNetwork = createHomeNetwork('https://relay.example.test/relay-client-ip', {
		fetcher: async () => new Response(HOME_IP)
	});
	await homeNetwork.refresh();
	assert.equal(homeNetwork.matches(HOME_IP), true, 'the home matcher is primed with the relay address');

	const activity = createActivity(directory);
	const auth = installAuth(app, {
		directory, publicDirectory: path.resolve('public'),
		localPort: server.address().port,
		localHosts: ['127.0.0.1'], localNetworks: ['127.0.0.0/8'],
		publicOrigin: PUBLIC_ORIGIN,
		trustedProxies: ['127.0.0.1'],
		homeTrustedProxy: '127.0.0.1',
		homeNetwork
	});
	// Mirrors the production mount in server.mjs.
	app.get('/api/activity/summary', (req, res) => {
		res.set('Cache-Control', 'no-store');
		if (!auth.isOwnerAdmin(req)) {
			return res.status(403).json({ error: SUMMARY_ERROR });
		}
		res.json(activity.summary());
	});

	const port = server.address().port;
	const homeHeaders = {
		Host: 'remote.test', 'X-Forwarded-Proto': 'https', 'CF-Connecting-IP': HOME_IP
	};
	// Prove the classifier itself says home:true and local:false for this socket,
	// so the 200 below is the home branch rather than local access.
	const status = await get(port, '/api/auth/status', homeHeaders);
	assert.equal(status.status, 200);
	const state = JSON.parse(status.text);
	assert.equal(state.home, true, 'the trusted proxy + matching client address classify as home');
	assert.equal(state.local, false, 'the forwarded request is not local access');

	const summary = await get(port, '/api/activity/summary', homeHeaders);
	assert.equal(summary.status, 403, 'being at home is not an administrator role');
	assert.deepEqual(JSON.parse(summary.text), { error: SUMMARY_ERROR });

	// Without the relay-verified client address the same proxy request is only
	// an unauthenticated remote caller.
	const notHome = await get(port, '/api/auth/status', { Host: 'remote.test', 'X-Forwarded-Proto': 'https' });
	assert.equal(JSON.parse(notHome.text).home, false);
	assert.equal((await get(port, '/api/activity/summary', { Host: 'remote.test', 'X-Forwarded-Proto': 'https' })).status, 401);
});
