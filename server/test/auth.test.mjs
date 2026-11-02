import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import http from 'node:http';
import { installAuth } from '../auth.mjs';
import { createActivity } from '../activity.mjs';

async function fixture(t, directory, extra = {}) {
	const app = express();
	app.use(express.json());
	const local = await new Promise(resolve => { const server = app.listen(0, '127.0.0.1', () => resolve(server)); });
	const remote = await new Promise(resolve => { const server = app.listen(0, '127.0.0.1', () => resolve(server)); });
	t.after(() => { local.closeAllConnections(); remote.closeAllConnections(); local.close(); remote.close(); });
	const audit = createActivity(directory);
	if (typeof extra === 'function') extra = extra({ local, remote });
	const access = installAuth(app, { directory, publicDirectory: path.resolve('public'), localPort: local.address().port, localHosts: ['127.0.0.1'], localNetworks: ['127.0.0.0/8'], audit, ...extra });
	app.get(['/api/items', '/images/test', '/stream/test'], (req, res) => res.json({ ok: true }));
	app.all(['/api/shares','/api/shares/fixture','/api/shares/fixture/revoke'],(req,res)=>res.json({ok:true}));
	app.get('/stream/continuous', (req, res) => { res.write('first chunk'); });
	const base = side => `http://127.0.0.1:${(side === 'local' ? local : remote).address().port}`;
	const request = (side, route, body, cookie, headers = {}) => fetch(base(side) + route, {
		method: body === undefined ? 'GET' : 'POST', redirect: 'manual',
		headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json', Origin: base(side) }), ...(cookie ? { Cookie: cookie } : {}), ...headers },
		body: body === undefined ? undefined : JSON.stringify(body)
	});
	return { request, audit, base, access };
}

test('installation features share the existing capability endpoint without overriding access permissions',async t=>{
	const directory=mkdtempSync(path.join(tmpdir(),'tellybox-capabilities-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
	const {request}=await fixture(t,directory,{installationCapabilities:{library:true,live:false,discover:true,managedInstallation:true,canShare:false}});
	const response=await request('local','/api/capabilities');assert.equal(response.status,200);
	assert.deepEqual(await response.json(),{library:true,live:false,discover:true,managedInstallation:true,playbackDefaults:{englishSubtitles:false,autoNext:false,skipIntros:false},canShare:true,canDownload:true});
});

test('remote email input limit counts invalid input and cannot be bypassed with a forged client IP',async t=>{
	const directory=mkdtempSync(path.join(tmpdir(),'tellybox-login-ip-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
	const {request}=await fixture(t,directory,{emailDelivery:async()=>{}});
	await request('local','/api/auth/email/config',{enabled:true,key:'re_fixture_only_123456',from:'watch@example.test'});
	for(let i=0;i<3;i++) assert.equal((await request('remote','/api/auth/email/code',{email:'bad'},undefined,{'CF-Connecting-IP':'192.0.2.'+i})).status,400);
	assert.equal((await request('remote','/api/auth/email/code',{email:'guest@example.test'},undefined,{'CF-Connecting-IP':'192.0.2.99'})).status,429);
	assert.equal((await request('local','/api/items')).status,200);
	assert.equal((await request('remote','/api/auth/login-protection')).status,403);
	const blocked=await (await request('local','/api/auth/login-protection')).json();assert.equal(blocked.blocked.length,1);
	assert.equal((await request('remote','/api/auth/login-protection',{id:blocked.blocked[0].id})).status,403);
	assert.equal((await request('local','/api/auth/login-protection',{id:blocked.blocked[0].id})).status,200);
	assert.equal((await request('remote','/api/auth/email/code',{email:'guest@example.test'})).status,200);
});

test('sign-in dashboard records safe email failures, shows pending limits and audits admin resets without approving accounts',async t=>{
	const directory=mkdtempSync(path.join(tmpdir(),'tellybox-login-dashboard-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
	const {request}=await fixture(t,directory,{emailDelivery:async()=>{}});
	await request('local','/api/auth/email/config',{enabled:true,key:'re_fixture_only_123456',from:'watch@example.test'});
	assert.equal((await request('remote','/api/auth/email/code',{email:'private-invalid-input'})).status,400);
	assert.equal((await request('remote','/api/auth/email/verify',{challenge:'unknown',code:'87654321'})).status,401);
	for(let i=0;i<2;i++)assert.equal((await request('remote','/api/auth/email/code',{email:'person@example.test'})).status,200);
	let response=await request('local','/api/auth/login-protection'),data=await response.json();
	assert.equal(response.headers.get('cache-control'),'no-store');
	assert.equal(data.failed.length,2);assert.equal(data.connections[0].attempts,3);assert.equal(data.connections[0].state,'warning');assert.equal(data.blocked.length,0);
	assert.equal(data.connections[0].email,'person@example.test');
	assert.ok(data.failed.some(e=>e.reason==='Incorrect or expired email code'));
	assert.ok(!JSON.stringify(data).includes('87654321'));assert.ok(!JSON.stringify(data).includes('private-invalid-input'));
	assert.equal((await request('remote','/api/auth/email/code',{email:'person@example.test'})).status,429);
	data=await (await request('local','/api/auth/login-protection')).json();assert.equal(data.blocked.length,1);
	assert.ok(data.failed.some(e=>e.reason==='IP blocked for 24 hours'));
	const device=await (await request('local','/api/apps/enroll',{name:'Viewer phone'})).json();
	for(const body of [undefined,{id:data.blocked[0].id}])assert.equal((await request('local','/api/auth/login-protection',body,undefined,{Authorization:'Bearer '+device.token})).status,403);
	assert.equal((await request('remote','/api/auth/login-protection',{id:data.blocked[0].id})).status,403);
	await request('local','/api/auth/login-protection',{id:data.blocked[0].id});
	data=await (await request('local','/api/auth/login-protection')).json();assert.equal(data.blocked.length,0);
	assert.ok(data.failed.some(e=>e.type==='login_limit_reset'&&e.ip==='127.0.0.1'));
	assert.equal(data.failed.filter(e=>e.type!=='login_limit_reset').length,3);
	assert.deepEqual(await (await request('remote','/api/auth/email/code',{email:'person@example.test'})).json(),{status:'pending'});
});

test('home browser identity is stable and links favourites without granting remote access',async t=>{
	const directory=mkdtempSync(path.join(tmpdir(),'tellybox-home-browser-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
	const {request}=await fixture(t,directory,{emailDelivery:async()=>{}});
	await request('local','/api/auth/email/config',{enabled:true,key:'re_fixture_only_123456',from:'watch@example.test'});
	const status=await request('local','/api/auth/status'),cookie=status.headers.get('set-cookie').split(';')[0];
	assert.match(cookie,/^tellybox_browser=[a-f0-9]{64}$/);assert.equal((await status.json()).authenticated,false);
	await request('local','/api/auth/status',undefined,cookie);
	const data=await (await request('local','/api/people')).json();assert.equal(data.localBrowsers.length,1);
	await request('remote','/api/auth/email/code',{email:'guest@example.test'});
	const person=(await (await request('local','/api/people')).json()).people[0];await request('local','/api/people',{id:person.id,action:'approve'});
	const body={id:data.localBrowsers[0].id,action:'link',personId:person.id};
	assert.equal((await request('remote','/api/people/browsers',body,cookie)).status,403);
	assert.equal((await request('local','/api/people/browsers',body)).status,200);
	assert.equal((await (await request('local','/api/auth/status',undefined,cookie)).json()).person,person.email);
	const favourites=await (await request('local','/api/favourites',undefined,cookie)).json();assert.equal(favourites.own.name,person.email);
	assert.equal((await request('remote','/api/items',undefined,cookie)).status,401);
	assert.equal((await (await request('remote','/api/auth/status',undefined,cookie)).json()).person,null);
	await request('local','/api/people',{id:person.id,action:'remove'});
	assert.equal((await (await request('local','/api/auth/status',undefined,cookie)).json()).person,null);
	assert.equal((await request('local','/api/items',undefined,cookie)).status,200);
});

test('local bypass, remote authentication, audit privacy, revocation and persistence', async t => {
	const directory = mkdtempSync(path.join(tmpdir(), 'jserver-auth-'));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const { request, base } = await fixture(t, directory);
	assert.equal((await request('local', '/api/items')).status, 200);
	for (const route of ['/api/items', '/images/test', '/stream/test']) assert.equal((await request('remote', route)).status, 401);
	assert.equal((await request('remote', '/')).status, 302);
	const badgeScript = await request('remote', '/connection-status.js');
	assert.equal(badgeScript.status, 200);
	assert.match(badgeScript.headers.get('content-type'), /javascript/);
	assert.match(await badgeScript.text(), /tellybox-route/);
	for (const route of ['/settings', '/settings.html', '/activity', '/activity.html', '/api/activity', '/api/auth/tunnel']) assert.equal((await request('remote', route)).status, 403);
	for (const headers of [{ 'X-Forwarded-For': '192.168.0.42' }, { 'CF-Connecting-IP': '192.168.0.42' }, { Forwarded: 'for=192.168.0.42' }]) assert.equal((await request('local', '/api/items', undefined, undefined, headers)).status, 401, JSON.stringify(headers));
	const rebound = await new Promise((resolve, reject) => { const call = http.get(base('local') + '/api/items', { headers: { Host: 'evil.example' } }, response => { response.resume(); resolve(response.statusCode); }); call.on('error', reject); });
	assert.equal(rebound, 401);
	const password = 'synthetic-test-password-only';
	assert.equal((await request('remote', '/api/auth/password', { password })).status, 403);
	assert.equal((await request('local', '/api/auth/password', { password }, undefined, { Origin: 'https://evil.example' })).status, 403);
	assert.equal((await request('local', '/api/auth/password', { password: 'short' })).status, 400);
	assert.equal((await request('local', '/api/auth/password', { password })).status, 200);
	assert.equal((await request('remote', '/api/auth/login', { password: 'wrong' }, undefined, { 'CF-Connecting-IP': '203.0.113.88' })).status, 401);
	const login = await request('remote', '/api/auth/login', { password });
	assert.equal(login.status, 200);
	const setCookie = login.headers.get('set-cookie');
	assert.match(setCookie, /HttpOnly/); assert.match(setCookie, /SameSite=Strict/);
	const cookie = setCookie.split(';')[0];
	assert.equal((await request('remote', '/api/items', undefined, cookie)).status, 200);
	assert.equal((await request('remote', '/api/activity', undefined, cookie)).status, 403);
	assert.equal((await request('remote', '/api/auth/tunnel', undefined, cookie)).status, 403);
	assert.equal((await request('remote', '/api/auth/revoke', {}, cookie)).status, 403);
	assert.equal((await request('remote', '/api/auth/password', { password }, cookie)).status, 403);
	const stats = await (await request('local', '/api/activity')).json();
	assert.equal(stats.stats.failed, 1);
	assert.equal(stats.browsers.length, 1);
	assert.equal(stats.recent.find(entry => entry.type === 'login_failed').ip, '127.0.0.1');
	assert.ok(!JSON.stringify(stats).includes(password));
	assert.ok(!JSON.stringify(stats).includes(cookie.split('=')[1]));
	assert.ok(!readFileSync(path.join(directory, 'password.json'), 'utf8').includes(password));
	const restarted = await fixture(t, directory);
	assert.equal((await restarted.request('remote', '/api/items', undefined, cookie)).status, 200);
	const stream = await request('remote', '/stream/continuous', undefined, cookie);
	const reader = stream.body.getReader();
	await reader.read();
	const closed = assert.rejects(reader.read());
	assert.equal((await request('local', '/api/auth/revoke-browser', { id: stats.browsers[0].id })).status, 200);
	await closed;
	assert.equal((await request('remote', '/api/items', undefined, cookie)).status, 401);
	const loginAgain = await request('remote', '/api/auth/login', { password });
	const cookieAgain = loginAgain.headers.get('set-cookie').split(';')[0];
	await request('local', '/api/auth/password', { password: password + '-changed' });
	assert.equal((await request('remote', '/api/items', undefined, cookieAgain)).status, 401);
	const finalLogin = await request('remote', '/api/auth/login', { password: password + '-changed' });
	const finalCookie = finalLogin.headers.get('set-cookie').split(';')[0];
	await request('remote', '/api/auth/logout', {}, finalCookie);
	assert.equal((await request('remote', '/api/items', undefined, finalCookie)).status, 401);
});

test('trusted proxy address is logged, never treated as permission for local access', async t => {
	const directory = mkdtempSync(path.join(tmpdir(), 'jserver-proxy-'));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const { request } = await fixture(t, directory, { trustedProxies: ['127.0.0.1'] });
	await request('local', '/api/auth/password', { password: 'synthetic-test-password' });
	await request('remote', '/api/auth/login', { password: 'bad' }, undefined, { 'CF-Connecting-IP': '203.0.113.50' });
	const snapshot = await (await request('local', '/api/activity')).json();
	assert.equal(snapshot.recent[0].ip, '203.0.113.50');
	assert.equal(snapshot.recent[0].ipSource, 'trusted proxy');
	assert.equal((await request('remote', '/api/activity', undefined, undefined, { 'CF-Connecting-IP': '127.0.0.1' })).status, 403);
	for (let index = 0; index < 7; index++) await request('remote', '/api/auth/login', { password: 'bad' });
	await request('remote', '/api/auth/login', { password: 'bad' });
	assert.equal((await request('remote', '/api/auth/login', { password: 'bad' })).status, 429);
});

test('HTTPS proxy origins and Secure cookies require an explicitly trusted peer', async t => {
	const directory = mkdtempSync(path.join(tmpdir(), 'jserver-https-'));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const trusted = await fixture(t, directory, { trustedProxies: ['127.0.0.1'] });
	const password = 'synthetic-https-password';
	await trusted.request('local', '/api/auth/password', { password });
	const proxyHeaders = { Origin: trusted.base('remote').replace('http:', 'https:'), 'X-Forwarded-Proto': 'https', 'CF-Connecting-IP': '203.0.113.20' };
	const login = await trusted.request('remote', '/api/auth/login', { password }, undefined, proxyHeaders);
	assert.equal(login.status, 200);
	assert.match(login.headers.get('set-cookie'), /; Secure/);
	assert.equal((await trusted.request('remote', '/api/auth/login', { password }, undefined, { ...proxyHeaders, Origin: 'https://unrelated.example' })).status, 403);
	const untrusted = await fixture(t, directory);
	const spoofed = { ...proxyHeaders, Origin: untrusted.base('remote').replace('http:', 'https:') };
	assert.equal((await untrusted.request('remote', '/api/auth/login', { password }, undefined, spoofed)).status, 403);
});

test('home public-IP bypass trusts only the designated HTTPS proxy and never grants administration', async t => {
	const directory = mkdtempSync(path.join(tmpdir(), 'jserver-home-'));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	let homeIp = '203.0.113.50';
	const homeNetwork = { matches: value => Boolean(homeIp && value === homeIp) };
	const options = { homeNetwork, homeTrustedProxy: '127.0.0.1', trustedProxies: ['127.0.0.1'], publicOrigin: 'https://jserver.example.test' };
	const { request, access, base } = await fixture(t, directory, ({ remote }) => {
		options.publicOrigin = `https://127.0.0.1:${remote.address().port}`;
		return options;
	});
	const headers = { 'X-Forwarded-Proto': 'https', 'CF-Connecting-IP': homeIp };
	assert.equal((await request('remote', '/api/items', undefined, undefined, headers)).status, 200);
	const status = await (await request('remote', '/api/auth/status', undefined, undefined, headers)).json();
	assert.equal(status.home, true);
	assert.equal(status.local, false);
	assert.equal(status.authenticated, false);
	for (const route of ['/settings', '/api/activity', '/api/auth/tunnel']) assert.equal((await request('remote', route, undefined, undefined, headers)).status, 403);
	assert.equal((await request('remote', '/api/auth/password', { password: 'synthetic-should-not-work' }, undefined, { ...headers, Origin: options.publicOrigin })).status, 403);
	for (const changes of [{ 'CF-Connecting-IP': '203.0.113.51' }, { 'CF-Connecting-IP': '203.0.113.50, 127.0.0.1' }, { 'X-Forwarded-Proto': 'http' }]) {
		assert.equal((await request('remote', '/api/items', undefined, undefined, { ...headers, ...changes })).status, 401);
	}
	const wrongHost = await new Promise((resolve, reject) => {
		const call = http.get(base('remote') + '/api/items', { headers: { ...headers, Host: 'other.example.test' } }, response => { response.resume(); resolve(response.statusCode); });
		call.on('error', reject);
	});
	assert.equal(wrongHost, 401);
	const untrusted = await fixture(t, directory, { ...options, homeTrustedProxy: '192.0.2.1' });
	assert.equal((await untrusted.request('remote', '/api/items', undefined, undefined, headers)).status, 401);
	assert.equal(access.validOwner('home:' + homeIp), true);
	const stream = await request('remote', '/stream/continuous', undefined, undefined, headers);
	const reader = stream.body.getReader();
	await reader.read();
	const ended = assert.rejects(reader.read());
	const previous = homeIp;
	homeIp = '';
	access.revokeOwner('home:' + previous);
	await ended;
	assert.equal(access.validOwner('home:' + previous), false);
	assert.equal((await request('remote', '/api/items', undefined, undefined, headers)).status, 401);
});

test('public player can opt into LAN playback CORS without exposing administration or unrelated origins', async t => {
	const directory = mkdtempSync(path.join(tmpdir(), 'jserver-lan-playback-'));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const publicOrigin = 'https://jserver.example.test';
	const { request, base } = await fixture(t, directory, { publicOrigin, localPlaybackOrigin: 'http://10.50.0.10:8082', instanceId: 'synthetic-instance' });
	const status = await (await request('local', '/api/auth/status')).json();
	assert.equal(status.localPlayback.instance, 'synthetic-instance');
	assert.equal((await (await request('remote', '/api/auth/status')).json()).localPlayback, null);
	const probe = await request('local', '/api/local-playback', undefined, undefined, { Origin: publicOrigin });
	assert.equal(probe.status, 200);
	assert.equal(probe.headers.get('access-control-allow-origin'), publicOrigin);
	assert.equal((await probe.json()).instance, 'synthetic-instance');
	assert.equal((await request('remote', '/api/local-playback')).status, 403);
	for (const route of ['/api/play', '/api/sessions/01234567-89ab-cdef-0123-456789abcdef', '/api/sessions/01234567-89ab-cdef-0123-456789abcdef/cast']) {
		const preflight = await fetch(base('local') + route, { method: 'OPTIONS', headers: { Origin: publicOrigin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type', 'Access-Control-Request-Private-Network': 'true' } });
		assert.equal(preflight.status, 204);
		assert.equal(preflight.headers.get('access-control-allow-origin'), publicOrigin);
		assert.equal(preflight.headers.get('access-control-allow-private-network'), 'true');
		assert.equal(preflight.headers.get('access-control-allow-credentials'), null);
	}
	for (const [side, route, origin] of [['local', '/api/local-playback', 'https://evil.example'], ['remote', '/api/local-playback', publicOrigin], ['local', '/api/activity', publicOrigin], ['local', '/api/auth/password', publicOrigin]]) {
		const response = await fetch(base(side) + route, { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'POST' } });
		assert.equal(response.headers.get('access-control-allow-origin'), null);
	}
});

test('email guests cannot watch before approval, home stays login-free, linked apps share favourites without admin escalation', async t => {
	const directory = mkdtempSync(path.join(tmpdir(), 'tellybox-email-'));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	let mail;
	const { request } = await fixture(t, directory, { emailDelivery: async value => { mail = value; } });
	assert.equal((await request('local','/api/auth/email/config',{enabled:true,key:'re_fixture_only_123456',from:'watch@example.test'})).status,200);
	assert.equal((await request('local','/api/items')).status,200);
	assert.equal((await request('remote','/api/items')).status,401);
	const pending=await request('remote','/api/auth/email/code',{email:'person@example.test'});
	assert.equal(pending.status,200);assert.deepEqual(await pending.json(),{status:'pending'});
	assert.equal(pending.headers.get('set-cookie'),null);assert.equal(mail,undefined);
	assert.equal((await request('remote','/api/items')).status,401);
	assert.equal((await request('remote','/api/favourites')).status,401);
	assert.equal((await request('remote','/api/people')).status,403);
	const person=(await (await request('local','/api/people')).json()).people[0];
	assert.equal(person.name,'person@example.test');assert.equal(person.status,'pending');
	assert.equal((await request('remote','/api/people',{action:'approve',id:person.id})).status,403);
	assert.equal((await request('remote','/api/auth/email/code',{email:person.email})).status,200);assert.equal(mail,undefined);
	await request('local','/api/people',{action:'approve',id:person.id});
	const challenge=await (await request('remote','/api/auth/email/code',{email:person.email})).json();
	assert.equal(challenge.status,'code-sent');assert.equal(mail.email,person.email);
	const verified=await request('remote','/api/auth/email/verify',{...challenge,code:mail.code,remember:true});
	assert.equal(verified.status,200);assert.equal((await verified.json()).name,person.email);
	const cookie=verified.headers.get('set-cookie').split(';')[0];
	assert.equal((await request('remote','/api/items',undefined,cookie)).status,200);
	assert.deepEqual(await (await request('remote','/api/capabilities',undefined,cookie)).json(),{playbackDefaults:{englishSubtitles:false,autoNext:false,skipIntros:false},canShare:false,canDownload:true});
	for(const [route,body] of [['/api/shares/fixture',undefined],['/api/shares',{}],['/api/shares/fixture/revoke',{}]])assert.equal((await request('remote',route,body,cookie)).status,403);
	const own=(await (await request('remote','/api/favourites',undefined,cookie)).json()).own;
	assert.equal(own.name,'person@example.test');
	const item={Id:'film-1',Name:'Shared film',Type:'Movie'};
	await request('remote','/api/favourites',{profileId:own.id,changes:[{id:item.Id,saved:true,item}]},cookie);
	const device=await (await request('local','/api/apps/enroll',{name:'Phone'})).json();
	assert.equal((await request('local','/api/people',{id:person.id,action:'device',deviceId:device.id})).status,200);
	const headers={Authorization:'Bearer '+device.token};
	const linked=await (await request('remote','/api/favourites',undefined,undefined,headers)).json();
	assert.equal(linked.own.id,own.id);assert.equal(linked.own.items[0].Id,item.Id);
	const managed=await (await request('local','/api/favourites/manage')).json();
	assert.equal(managed.devices[device.id].profileId,own.id);
	const another=await (await request('local','/api/favourites/profiles',{name:'Personal collection'})).json();
	assert.equal((await request('local','/api/favourites/devices/'+device.id,{profileId:another.id,linkedProfiles:[]})).status,200);
	assert.equal((await (await request('remote','/api/favourites',undefined,cookie)).json()).own.id,another.id);
	assert.equal((await (await request('remote','/api/favourites',undefined,undefined,headers)).json()).own.id,another.id);
	assert.equal((await request('remote','/api/people',undefined,undefined,headers)).status,403);
	assert.equal((await request('remote','/api/apps/push/config',undefined,undefined,headers)).status,403);
	assert.equal((await request('remote','/api/apps/push/register',{token:'fixture-token-that-is-not-real',types:['watch_started']},undefined,headers)).status,403);
	assert.equal((await request('remote','/api/favourites/home',undefined,cookie)).status,403);
	assert.equal((await request('remote','/api/favourites/home',undefined,undefined,headers)).status,403);
	const homeItem={Id:'channel-1',Name:'Always on',Type:'TvChannel'};
	await request('local','/api/favourites/home',{id:homeItem.Id,saved:true,item:homeItem});
	const home=await (await request('local','/api/favourites/home',undefined,undefined,headers)).json();
	assert.equal(home.own.items[0].Id,homeItem.Id);
	const moreItems=['second','third'].map(id=>({Id:id,Name:id,Type:'Movie'}));
	await Promise.all(moreItems.map(item=>request('local','/api/favourites/home',{id:item.Id,saved:true,item},undefined,headers)));
	assert.equal((await (await request('local','/api/favourites/home')).json()).own.items.length,3);
	assert.equal((await request('local','/api/favourites/home',undefined,undefined,{Authorization:'Bearer invalid'})).status,401);
	await request('local','/api/auth/revoke',{});
	assert.equal((await request('remote','/api/items',undefined,cookie)).status,401);
	assert.equal((await request('local','/api/items')).status,200);
});


test('sharing is limited to current admins or trusted home access, including all management routes', async t => {
	const directory=mkdtempSync(path.join(tmpdir(),'tellybox-sharing-'));
	t.after(()=>rmSync(directory,{recursive:true,force:true}));
	const {request}=await fixture(t,directory,({remote})=>({homeNetwork:{matches:ip=>ip==='203.0.113.50'},homeTrustedProxy:'127.0.0.1',trustedProxies:['127.0.0.1'],publicOrigin:`https://127.0.0.1:${remote.address().port}`}));
	const routes=[['/api/shares/fixture',undefined],['/api/shares',{}],['/api/shares/fixture/revoke',{}]];
	async function permitted(side,expected,headers={},cookie) {
		const caps=await request(side,'/api/capabilities',undefined,cookie,headers);
		if(expected===401)assert.equal(caps.status,401);
		else {assert.equal(caps.status,200);assert.deepEqual(await caps.json(),{playbackDefaults:{englishSubtitles:false,autoNext:false,skipIntros:false},canShare:expected===200,canDownload:true});assert.equal(caps.headers.get('cache-control'),'no-store');}
		for(const [route,body] of routes)assert.equal((await request(side,route,body,cookie,headers)).status,expected,side+' '+route);
	}
	await permitted('local',200);
	await permitted('remote',401);
	await permitted('local',401,{'X-jServer-App':'android'});
	await permitted('local',401,{'X-Forwarded-For':'192.168.0.42'});
	const device=await (await request('local','/api/apps/enroll',{name:'Phone'})).json();
	const token={Authorization:'Bearer '+device.token};
	await permitted('local',200,token);
	await permitted('remote',403,token);
	await permitted('remote',403,{...token,'X-Forwarded-For':'192.168.0.42'});
	await permitted('remote',200,{...token,'X-Forwarded-Proto':'https','CF-Connecting-IP':'203.0.113.50'});
	await permitted('remote',403,{...token,'X-Forwarded-Proto':'https','CF-Connecting-IP':'203.0.113.51'});
	await permitted('remote',200,{'X-Forwarded-Proto':'https','CF-Connecting-IP':'203.0.113.50'});
	assert.equal((await request('local','/api/apps/'+device.id,{action:'role',role:'admin'})).status,200);
	await permitted('remote',200,token);
	await request('local','/api/apps/'+device.id,{action:'role',role:'viewer'});
	await permitted('remote',403,token);
	await request('local','/api/apps/'+device.id,{action:'revoke'});
	await permitted('local',401,token);
	await permitted('remote',401,{...token,'X-Forwarded-Proto':'https','CF-Connecting-IP':'203.0.113.50'});
	const pending=await (await request('remote','/api/apps/enroll',{name:'Pending'})).json();
	await permitted('local',401,{Authorization:'Bearer '+pending.token});
	await request('local','/api/auth/password',{password:'fixture-password-only'});
	const login=await request('remote','/api/auth/login',{password:'fixture-password-only'});
	await permitted('remote',403,{},login.headers.get('set-cookie').split(';')[0]);
});

test('linked app sessions use the email account daily allowance and viewers cannot change it',async t=>{
	const {createAccountLimits}=await import('../account-limits.mjs');
	const directory=mkdtempSync(path.join(tmpdir(),'tellybox-linked-limits-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
	let env,now=100000;const limits=createAccountLimits(directory,{clock:()=>now,resolveViewer:v=>env.access.viewerAccount(v)});
	env=await fixture(t,directory,{accountLimits:limits,emailDelivery:async()=>{}});const {request}=env;
	await request('local','/api/auth/email/config',{enabled:true,key:'re_fixture_only_123456',from:'watch@example.test'});
	await request('remote','/api/auth/email/code',{email:'guest@example.test'});
	const person=(await(await request('local','/api/people')).json()).people[0];await request('local','/api/people',{id:person.id,action:'approve'});
	const phone=await(await request('local','/api/apps/enroll',{name:'Phone'})).json(),tv=await(await request('local','/api/apps/enroll',{name:'TV'})).json();
	const devices=(await(await request('local','/api/people')).json()).apps;
	for(const device of devices)await request('local','/api/people',{action:'device',id:person.id,deviceId:device.id});
	const account='person:'+person.id,body={minutes:0,dailyMinutes:1,downloads:false};
	assert.equal((await request('local','/api/account-limits/'+account,body)).status,200);
	assert.equal((await request('local','/api/account-limits/'+account,body,null,{Authorization:'Bearer '+phone.token})).status,403);
	assert.equal((await request('remote','/api/account-limits/'+account,body,null,{Authorization:'Bearer '+tv.token})).status,403);
	limits.media('web',{personId:person.id});for(const device of devices)limits.media(device.id,{deviceId:device.id});
	for(let i=0;i<4;i++){now+=5000;limits.tick();for(const id of ['web',...devices.map(x=>x.id)])limits.heartbeat(id,true);}
	const status=await(await request('local','/api/account-limits/'+account)).json();assert.equal(status.dailySeconds,60);
	for(const device of devices)assert.equal(limits.allowed({deviceId:device.id}),false);
	assert.equal(limits.allowed({personId:person.id}),false);assert.equal(limits.allowed({deviceId:devices[0].id,local:true}),true);
});

test('migration trusts both named home proxies while rejecting other VPN peers and forged headers',async t=>{
	const directory=mkdtempSync(path.join(tmpdir(),'tellybox-dual-relay-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
	const env=await fixture(t,directory,({remote})=>({homeNetwork:{matches:value=>value==='203.0.113.50'},homeTrustedProxy:'127.0.0.1, 127.0.0.2',trustedProxies:['127.0.0.1','127.0.0.2'],publicOrigin:`https://127.0.0.1:${remote.address().port}`}));
	const request=(peer,route,extra={})=>new Promise((resolve,reject)=>{
		const call=http.get(env.base('remote')+route,{localAddress:peer,headers:{'X-Forwarded-Proto':'https','CF-Connecting-IP':'203.0.113.50',...extra}},res=>{let body='';res.on('data',chunk=>body+=chunk);res.on('end',()=>resolve({status:res.statusCode,body}));});call.on('error',reject);
	});
	for(const peer of ['127.0.0.1','127.0.0.2']){
		assert.equal((await request(peer,'/api/items')).status,200);
		const status=JSON.parse((await request(peer,'/api/auth/status')).body);assert.equal(status.home,true);assert.equal(status.local,false);
		assert.equal((await request(peer,'/api/activity')).status,403);
		assert.equal((await request(peer,'/settings')).status,403);
		for(const headers of [{'CF-Connecting-IP':'203.0.113.51'},{'X-Forwarded-Proto':'http'},{'Host':'wrong.example.test'},{'CF-Connecting-IP':'203.0.113.50,127.0.0.1'}])assert.equal((await request(peer,'/api/items',headers)).status,401);
	}
	assert.equal((await request('127.0.0.3','/api/items')).status,401);
});
