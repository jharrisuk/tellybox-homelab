/* Release 110: an actual HTTP request must produce the client identity that
 * Activity displays. The auth middleware, activity store and shared renderer
 * are the real modules; only the playback route is a fixture. */
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { installAuth } from '../auth.mjs';
import { createActivity } from '../activity.mjs';

async function fixture(t) {
	const directory = mkdtempSync(path.join(tmpdir(), 'tellybox-client-110-'));
	const app = express();
	app.use(express.json());
	const local = await new Promise(resolve => { const server = app.listen(0, '127.0.0.1', () => resolve(server)); });
	const remote = await new Promise(resolve => { const server = app.listen(0, '127.0.0.1', () => resolve(server)); });
	t.after(() => { local.closeAllConnections(); remote.closeAllConnections(); local.close(); remote.close(); rmSync(directory, { recursive: true, force: true }); });
	const delivered = [];
	const audit = createActivity(directory);
	const auth = installAuth(app, {
		directory, audit, publicDirectory: path.resolve('public'), localPort: local.address().port,
		localHosts: ['127.0.0.1'], localNetworks: ['127.0.0.0/8'],
		emailDelivery: async message => { delivered.push(message); }
	});
	// Fixture routes: the real request viewer goes into the real Activity store.
	app.post('/api/test/play/:id', (req, res) => {
		const viewer = req.jserverViewer;
		audit.begin(req.params.id, viewer, { Id: 'film-' + req.params.id, Name: 'Film ' + req.params.id, Type: 'Movie' }, { purpose: 'watch' });
		audit.update(req.params.id, { client: viewer.client, state: 'playing' });
		res.json({ client: viewer.client, local: viewer.local, personName: viewer.personName || null });
	});
	app.post('/api/test/progress/:id', (req, res) => {
		audit.update(req.params.id, { heartbeat: true, client: req.jserverViewer?.client, state: 'playing', position: 30,
			mediaRoute: req.body.route, personId: req.jserverViewer?.personId, personName: req.jserverViewer?.personName });
		res.sendStatus(204);
	});
	const base = side => `http://127.0.0.1:${(side === 'local' ? local : remote).address().port}`;
	const call = (side, route, { body, cookie, headers = {} } = {}) => fetch(base(side) + route, {
		method: body === undefined ? 'GET' : 'POST', redirect: 'manual',
		headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json', Origin: base(side) }), ...(cookie ? { Cookie: cookie } : {}), ...headers },
		body: body === undefined ? undefined : JSON.stringify(body)
	});
	return { call, audit, delivered, auth };
}

function renderer() {
	const context = { document: { createElement: () => ({ append() {}, setAttribute() {}, style: {} }) } };
	vm.runInNewContext(readFileSync(new URL('../public/activity-summary.js', import.meta.url), 'utf8'), context);
	return context.TellyboxActivitySummary;
}

test('TV, phone, web, legacy, invalid, account, local, direct and relay reach Activity correctly', { timeout: 30000 }, async t => {
	const { call, delivered, auth } = await fixture(t);
	const lib = renderer();

	// One approved app installation. The same friendly name is deliberately used
	// for every request so the label cannot come from the device name.
	const enrollment = await call('local', '/api/apps/enroll', { body: { name: 'Kitchen TV' },
		headers: { 'X-Tellybox-Client': 'android-tv', 'User-Agent': 'Dalvik/2.1.0 (Linux; U; Android 9; Kitchen TV) BeyondTV' } });
	assert.ok([200, 201].includes(enrollment.status));
	const app = await enrollment.json();
	const appHeaders = extra => ({ Authorization: 'Bearer ' + app.token, 'X-jServer-App': 'android', ...extra });

	// Android TV app: explicit validated kind.
	let response = await call('remote', '/api/test/play/tv', { body: {}, headers: appHeaders({ 'X-Tellybox-Client': 'android-tv', 'User-Agent': 'Dalvik/2.1.0 (Linux; U; Android 9; Kitchen TV) BeyondTV' }) });
	assert.equal((await response.json()).client, 'android-tv');
	await call('remote', '/api/test/progress/tv', { body: { route: 'relay' }, headers: appHeaders({ 'X-Tellybox-Client': 'android-tv' }) });

	// Android phone/tablet app with the same friendly name must not become a TV.
	response = await call('remote', '/api/test/play/phone', { body: {}, headers: appHeaders({ 'X-Tellybox-Client': 'android-phone', 'User-Agent': 'Dalvik/2.1.0 (Linux; U; Android 9; Pixel 4)' }) });
	assert.equal((await response.json()).client, 'android-phone');
	await call('remote', '/api/test/progress/phone', { body: { route: 'remote' }, headers: appHeaders({ 'X-Tellybox-Client': 'android-phone' }) });

	// Legacy app without the header: BeyondTV user agent is the narrow fallback.
	response = await call('remote', '/api/test/play/legacy', { body: {}, headers: appHeaders({ 'User-Agent': 'Dalvik/2.1.0 (Linux; U; Android 9; Kitchen TV) BeyondTV/1.0' }) });
	assert.equal((await response.json()).client, 'android-tv');
	await call('remote', '/api/test/progress/legacy', { body: { route: 'relay' }, headers: appHeaders({ 'User-Agent': 'BeyondTV Android 9' }) });

	// Invalid header falls back to the user agent, never to the value.
	response = await call('remote', '/api/test/play/invalid', { body: {}, headers: appHeaders({ 'X-Tellybox-Client': 'smart-tv', 'User-Agent': 'Dalvik/2.1.0 (Linux; U; Android 9; Kitchen TV) BeyondTV' }) });
	assert.equal((await response.json()).client, 'android-tv');
	response = await call('remote', '/api/test/play/invalid-phone', { body: {}, headers: appHeaders({ 'X-Tellybox-Client': 'smart-tv', 'User-Agent': 'Dalvik/2.1.0 (Linux; U; Android 9; Pixel 4)' }) });
	assert.equal((await response.json()).client, 'android-phone');

	// A web request cannot claim an app identity.
	response = await call('local', '/api/test/play/web', { body: {}, headers: { 'X-Tellybox-Client': 'android-tv', 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } });
	assert.equal((await response.json()).client, 'web');
	await call('local', '/api/test/progress/web', { body: { route: 'local' }, headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } });

	// Signed-in web account over the internet keeps its account identity.
	await call('local', '/api/auth/email/config', { body: { enabled: true, key: 're_fixture_only_123456', from: 'watch@example.test' } });
	let codeResponse = await call('remote', '/api/auth/email/code', { body: { email: 'person@example.test' } });
	let codeBody = await codeResponse.json();
	const people = await (await call('local', '/api/people')).json();
	await call('local', '/api/people', { body: { id: people.people[0].id, action: 'approve' } });
	codeResponse = await call('remote', '/api/auth/email/code', { body: { email: 'person@example.test' } });
	codeBody = await codeResponse.json();
	const code = String(delivered.at(-1).text).match(/\d{8}/)[0];
	const verified = await call('remote', '/api/auth/email/verify', { body: { challenge: codeBody.challenge, code } });
	assert.equal(verified.status, 200);
	const cookie = verified.headers.get('set-cookie').split(';')[0];
	response = await call('remote', '/api/test/play/account', { body: {}, cookie, headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)' } });
	assert.deepEqual(await response.json(), { client: 'web', local: false, personName: 'person@example.test' });
	await call('remote', '/api/test/progress/account', { body: { route: 'remote' }, cookie, headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)' } });

	// The identity function itself accepts the same real session cookie with app
	// markers and no Authorization header. This is the cookie-authenticated app
	// case; authentication still comes from the normal session store.
	const requestOf = headers => ({ get: name => headers[name.toLowerCase()], socket: { remoteAddress: '127.0.0.1' },
		hostname: '127.0.0.1', protocol: 'http', headers });
	const cookieHeaders = { host: 'jserver.test', cookie, 'x-jserver-app': 'android', 'x-tellybox-client': 'android-phone',
		'user-agent': 'Dalvik/2.1.0 (Linux; U; Android 17; SM-F966B)' };
	assert.equal(cookieHeaders.authorization, undefined);
	const cookieViewer = auth.identity(requestOf(cookieHeaders));
	assert.equal(cookieViewer.client, 'android-phone');
	assert.deepEqual(cookieViewer.appMarkers, { app: true, declared: 'android-phone' });
	const externalViewer = auth.identity(requestOf({ ...cookieHeaders, origin: 'https://evil.example' }));
	assert.equal(externalViewer.client, 'web', 'an external Origin cannot claim the app identity');
	assert.deepEqual(externalViewer.appMarkers, { app: true, declared: 'android-phone' });

	// A browser bearer request is authenticated but still a browser, not the app.
	response = await call('remote', '/api/test/play/browser-bearer', { body: {}, headers: { Authorization: 'Bearer ' + app.token, 'User-Agent': 'Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/120 Mobile Safari' } });
	assert.equal((await response.json()).client, 'web');
	await call('remote', '/api/test/progress/browser-bearer', { body: { route: 'remote' }, headers: { Authorization: 'Bearer ' + app.token, 'User-Agent': 'Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/120 Mobile Safari' } });

	const snapshot = await (await call('local', '/api/activity')).json();
	const active = new Map(snapshot.active.map(entry => [entry.itemId.replace(/^film-/, ''), entry]));
	const tv = active.get('tv');
	assert.equal(tv.client, 'android-tv');
	assert.equal(tv.deviceName, 'Kitchen TV');
	assert.equal(lib.deviceOf(tv).label, 'Android TV');
	assert.equal(lib.deviceOf(tv).key, 'tv');
	assert.equal(lib.routeOf(tv).kind, 'relay');
	assert.equal(tv.local, false);
	assert.deepEqual(tv.appMarkers, { app: true, declared: 'android-tv' });

	const phone = active.get('phone');
	assert.equal(phone.client, 'android-phone');
	assert.equal(phone.deviceName, 'Kitchen TV', 'friendly name is not used for classification');
	assert.equal(lib.deviceOf(phone).label, 'Android app');
	assert.equal(lib.routeOf(phone).kind, 'remote');
	assert.deepEqual(phone.appMarkers, { app: true, declared: 'android-phone' });

	const legacy = active.get('legacy');
	assert.equal(legacy.client, 'android-tv');
	assert.deepEqual(legacy.appMarkers, { app: true }, 'the app marker is present without a declared kind');
	const invalid = active.get('invalid');
	assert.equal(invalid.client, 'android-tv');
	assert.deepEqual(invalid.appMarkers, { app: true }, 'an invalid declaration is not echoed back');

	const web = active.get('web');
	assert.equal(web.client, 'web');
	assert.equal(web.local, true);
	assert.equal(lib.deviceOf(web).label, 'Desktop web');
	assert.equal(lib.identityOf(web).kind, 'local');
	assert.equal(lib.accessOf(web).kind, 'local');
	assert.equal(lib.routeOf(web).kind, 'lan');
	assert.deepEqual(web.appMarkers, { app: false, declared: 'android-tv' }, 'a header without the app marker is not an app');

	const account = active.get('account');
	assert.equal(account.client, 'web');
	assert.equal(lib.identityOf(account).kind, 'account');
	assert.equal(lib.identityOf(account).label, 'person@example.test');
	assert.equal(lib.accessOf(account).kind, 'remote');
	assert.equal(lib.routeOf(account).kind, 'remote');
	assert.deepEqual(account.appMarkers, { app: false });

	const browserBearer = active.get('browser-bearer');
	assert.equal(browserBearer.client, 'web', 'a bearer token alone is not an app marker');
	assert.equal(lib.deviceOf(browserBearer).label, 'Android browser');
	assert.equal(lib.routeOf(browserBearer).kind, 'remote');
	assert.deepEqual(browserBearer.appMarkers, { app: false });

	// Every route remains available on the same request-to-Activity path.
	for (const entry of [tv, phone, web, account, browserBearer]) assert.equal(entry.state, 'playing');
});
