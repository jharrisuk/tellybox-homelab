import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { generateKeyPairSync } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { get, request as httpRequest } from 'node:http';
import { defaultConfig, validateConfig, redacted, capabilities, configStore, materialize, serviceUrl } from '../homelab/config.mjs';
import { services } from '../homelab/services.mjs';
import { createSetup } from '../homelab/admin.mjs';
import { optionalDispatcharr } from '../homelab/runtime.mjs';
import { setupHosts, localConnectionSuggestion } from '../homelab/setup-hosts.mjs';

function directory(t) { const dir = mkdtempSync(path.join(os.tmpdir(), 'tellybox-homelab-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return dir; }
const configured = () => { const c = defaultConfig(); c.services.jellyfin = { enabled: true, url: 'http://jellyfin:8096', key: 'test-only-key', userId: 'a'.repeat(32) }; return c; };
test('fresh installs have no implied media service, personal network or proxy trust', () => {
	const c = defaultConfig(); assert.ok(Object.values(c.services).every(s => !s.enabled));
	assert.ok(Object.values(capabilities(c)).every(v => !v));
	assert.deepEqual(c.network.localNetworks, []); assert.deepEqual(c.network.trustedProxies, []);
});
test('every integration explains purpose, requirements and what happens without it', () => {
	for (const s of services) for (const key of ['summary', 'description', 'requires', 'without', 'note', 'docs']) assert.ok(s[key], s.id + ':' + key);
});
test('Jellyfin-only and IPTV-only capability sets are independent', () => {
	const local = capabilities(validateConfig(configured())); assert.equal(local.library, true); assert.equal(local.live, false); assert.equal(local.discover, false);
	const iptv = defaultConfig(); iptv.services.dispatcharr = { enabled: true, url: 'http://dispatcharr:9191', live: true, vod: true, key: 'fixture' };
	const remote = capabilities(validateConfig(iptv)); assert.equal(remote.jellyfin, false); assert.equal(remote.live, true); assert.equal(remote.vod, true);
});
test('secrets stay server-side and blank edits preserve saved values', () => {
	const c = validateConfig(configured()), safe = redacted(c);
	assert.equal(safe.services.jellyfin.key, undefined); assert.equal(safe.services.jellyfin.keySaved, true);
	assert.equal(JSON.stringify(safe).includes('test-only-key'), false);
	safe.services.jellyfin.key = ''; assert.equal(validateConfig(safe, c).services.jellyfin.key, 'test-only-key');
});
test('stale saves cannot overwrite newer config', t => {
	const store = configStore(directory(t)); store.save(configured()); assert.throws(() => store.save(configured()), { status: 409 });
});
test('invalid URL schemes, credentials, queries, fragments and metadata hosts are refused', () => {
	for (const value of ['file:///etc/passwd', 'ftp://x', 'https://user:secret@example.com', 'http://x?key=s', 'http://x/#a', 'http://169.254.169.254']) assert.throws(() => serviceUrl(value));
	assert.equal(serviceUrl('http://jellyfin:8096/'), 'http://jellyfin:8096');
});
test('invalid proxy addresses, broad local trust and missing service dependencies are refused', () => {
	const c = defaultConfig(); c.network.localNetworks = ['0.0.0.0/0']; assert.throws(() => validateConfig(c));
	c.network.localNetworks = []; c.network.trustedProxies = ['*']; assert.throws(() => validateConfig(c));
	c.network.trustedProxies = []; c.services.dispatcharr = { enabled: true, url: 'http://dispatcharr:9191', vod: true }; assert.throws(() => validateConfig(c), /API key/);
});
test('materialized settings only contain enabled services and use separate storage', t => {
	const dir = directory(t), c = validateConfig(configured()), env = materialize(c, dir);
	assert.equal(env.JELLYFIN_URL, 'http://jellyfin:8096'); assert.equal(env.INTRODB_ENABLED, '0'); assert.equal(env.TRUSTED_PROXIES, '');
	assert.deepEqual(JSON.parse(readFileSync(path.join(env.AUTH_DIR, 'dispatcharr.json'))), {});
	c.services.jellyfin.enabled = false; materialize(c, dir);
	assert.deepEqual(JSON.parse(readFileSync(path.join(env.DATA_DIR, 'connection.json'))), {});
});
test('catalogue caches are isolated by service identity while account storage is retained', t => {
	const dir = directory(t), c = validateConfig(configured()), first = materialize(c, dir);
	c.services.jellyfin.url = 'http://replacement:8096'; const second = materialize(c, dir);
	assert.notEqual(first.CATALOGUE_CACHE_DIR, second.CATALOGUE_CACHE_DIR); assert.equal(first.AUTH_DIR, second.AUTH_DIR);
	c.services.jellyfin.url = 'http://jellyfin:8096'; assert.equal(materialize(c, dir).CATALOGUE_CACHE_DIR, first.CATALOGUE_CACHE_DIR);
});
test('Firebase project must match its private credential and disabling removes runtime credentials', t => {
	const c = defaultConfig(), dir = directory(t);
	const private_key = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
	c.services.firebase = { enabled: true, projectId: 'homelab-fixture', applicationId: '1:123456789:android:abcdef', senderId: '123456789', apiKey: 'fixture-client-key',
		serviceAccount: JSON.stringify({ type: 'service_account', project_id: 'homelab-fixture', client_email: 'test@homelab-fixture.iam.gserviceaccount.com', private_key }) };
	const checked = validateConfig(c), safe = redacted(checked); assert.equal(safe.services.firebase.serviceAccount, undefined);
	const env = materialize(checked, dir); assert.equal(JSON.parse(readFileSync(path.join(env.AUTH_DIR, 'firebase-client.json'))).projectId, 'homelab-fixture');
	c.services.firebase.publicApplicationId='1:987654321:android:abcdef';assert.throws(()=>validateConfig(c),/app IDs/);
	c.services.firebase.publicApplicationId='1:123456789:android:123abc';c.services.firebase.applicationId='';
	const publicOnly=validateConfig(c);materialize(publicOnly,dir);
	assert.equal(JSON.parse(readFileSync(path.join(env.AUTH_DIR,'firebase-client.json'))).publicApplicationId,'1:123456789:android:123abc');
	c.services.firebase.projectId = 'wrong-project'; assert.throws(() => validateConfig(c), /same project/);
	checked.services.firebase.enabled = false; materialize(checked, dir); assert.deepEqual(JSON.parse(readFileSync(path.join(env.AUTH_DIR, 'firebase-service-account.json'))), {});
});
test('disabled Dispatcharr features never reach the underlying client', async () => {
	const unexpected = () => { throw Error('network called'); }, client = { origin: 'http://dispatcharr:9191', channels: unexpected, api: unexpected, status: unexpected, stream: unexpected, recordingApi: unexpected, catchupSession: unexpected };
	const disabled = optionalDispatcharr(client, capabilities(defaultConfig()));
	assert.deepEqual(await disabled.channels(), []); assert.equal(disabled.status().connected, false);
	await assert.rejects(disabled.api('/api/vod/movies/'), { status: 503 }); await assert.rejects(disabled.recordingApi(), { status: 503 });
});
async function fixture(t, options={}) {
	const dir = directory(t); let applies = 0, calls = 0;
	const setup = createSetup({ directory: dir, apply: async () => { applies++; }, fetcher: async () => { calls++; return new Response('{}'); }, ...options });
	const server = setup.app.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => server.close());
	const base = 'http://127.0.0.1:' + server.address().port;
	const req = (route, body, headers = {}) => fetch(base + '/api/setup/' + route, { method: body ? 'POST' : 'GET', headers: { ...(body ? { 'Content-Type': 'application/json', Origin: base } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
	const claim = () => req('login', { bootstrap: JSON.parse(readFileSync(path.join(dir, 'bootstrap.json'))).token, password: 'test-only-password-1234' });
	return { dir, base, req, claim, counts: () => ({ applies, calls }) };
}
test('configuration and apply endpoints require a setup session; local viewing grants none', async t => {
	const f = await fixture(t); assert.equal((await f.req('config')).status, 401); assert.equal((await f.req('apply', {})).status, 401); assert.equal(f.counts().applies, 0);
	assert.equal((await f.req('relay/health')).status, 401); assert.equal(f.counts().calls, 0);
	assert.equal((await f.req('relay')).status, 401); assert.equal((await f.req('relay/run', { action: 'install' })).status, 401);
});
test('bootstrap is one-use, passwords are hashed, configuration is masked, apply is explicit', async t => {
	const f = await fixture(t); const response = await f.claim(); assert.equal(response.status, 200);
	const cookie = response.headers.get('set-cookie').split(';')[0]; const headers = { Cookie: cookie };
	assert.equal(JSON.parse(readFileSync(path.join(f.dir, 'bootstrap.json'))).consumed, true);
	assert.ok(!readFileSync(path.join(f.dir, 'owner.json'), 'utf8').includes('test-only-password'));
	assert.equal((await f.req('config', configured(), headers)).status, 200); assert.equal(f.counts().applies, 0);
	const config = await (await f.req('config', null, headers)).json(); assert.equal(config.config.services.jellyfin.key, undefined);
	assert.equal((await f.req('apply', {revision:1}, headers)).status, 200); assert.equal(f.counts().applies, 1);
	assert.equal((await f.req('login', { bootstrap: 'anything', password: 'different-password-123' })).status, 401);
});
test('cross-site writes and untrusted host headers are rejected', async t => {
	const f = await fixture(t); assert.equal((await f.req('login', { password: 'test-only-password' }, { Origin: 'https://evil.example' })).status, 403);
	const status = await new Promise((resolve, reject) => get(f.base + '/api/setup/status', {headers:{Host:'evil.example'}}, response => {response.resume();resolve(response.statusCode);}).on('error',reject));
	assert.equal(status, 403);
});
test('disabled integrations cannot be tested; read-only checks do not apply settings', async t => {
	const f = await fixture(t), cookie = (await f.claim()).headers.get('set-cookie').split(';')[0], headers = { Cookie: cookie };
	assert.equal((await f.req('test/jellyfin', {}, headers)).status, 400); assert.equal(f.counts().calls, 0);
	await f.req('config', configured(), headers); assert.equal((await (await f.req('test/jellyfin', {}, headers)).json()).verified, true);
	assert.deepEqual(f.counts(), { calls: 1, applies: 0 });
});
test('setup host allowlist defaults to loopback and accepts only explicitly configured private IPs',()=>{
	const local=setupHosts();assert.equal(local('localhost:8990'),true);assert.equal(local('[::1]:8990'),true);assert.equal(local('192.168.50.12:8990'),false);
	const lan=setupHosts('192.168.50.12,100.64.1.2,fd00::12');
	for(const host of ['192.168.50.12:8990','100.64.1.2:8990','[fd00::12]:8990'])assert.equal(lan(host),true);
	for(const host of ['192.168.50.13:8990','192.168.50.12.evil.test','192.168.50.12:99999','evil@192.168.50.12','[::::]:8990'])assert.equal(lan(host),false);
	for(const value of ['0.0.0.0','203.0.113.10','server.local','192.168.50.0/24','https://192.168.50.12'])assert.throws(()=>setupHosts(value),/private/);
});
test('Docker local-viewing suggestion is a single observed private peer, never a subnet or public address',()=>{
	assert.deepEqual(localConnectionSuggestion('::ffff:192.168.65.1'),{address:'192.168.65.1',cidr:'192.168.65.1/32'});
	assert.deepEqual(localConnectionSuggestion('fd00::12'),{address:'fd00::12',cidr:'fd00::12/128'});
	for(const peer of ['127.0.0.1','::1','203.0.113.10','bad',''])assert.equal(localConnectionSuggestion(peer),null);
});
test('LAN setup still requires bootstrap and owner login, rejects spoofed hosts and allows explicit Save and Apply',async t=>{
	const ip='192.168.50.12',host=ip+':8990',origin='http://'+host,f=await fixture(t,{allowedHosts:ip});
	const raw=(route,body,headers={})=>new Promise((resolve,reject)=>{
		const req=httpRequest(f.base+'/api/setup/'+route,{method:body?'POST':'GET',headers:{Host:host,...(body?{Origin:origin,'Content-Type':'application/json'}:{}),...headers}},res=>{
			const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>resolve({status:res.statusCode,headers:res.headers,text:Buffer.concat(chunks).toString()}));
		});req.on('error',reject);req.end(body?JSON.stringify(body):undefined);
	});
	assert.equal((await raw('config')).status,401);
	assert.equal((await raw('status',null,{Host:'evil.test'})).status,403);
	assert.equal((await raw('status',null,{Host:'192.168.50.13:8990'})).status,403);
	assert.equal((await raw('status',null,{'X-Forwarded-Host':host})).status,403);
	assert.equal((await raw('login',{password:'fixture-password-long'})).status,401);
	const login={bootstrap:JSON.parse(readFileSync(path.join(f.dir,'bootstrap.json'))).token,password:'fixture-password-long'};
	assert.equal((await raw('login',login,{Origin:'http://evil.test'})).status,403);
	const response=await raw('login',login);assert.equal(response.status,200);
	const headers={Cookie:response.headers['set-cookie'][0].split(';')[0]};
	assert.equal((await raw('config',defaultConfig(),headers)).status,200);
	assert.equal((await raw('apply',{revision:1},headers)).status,200);assert.equal(f.counts().applies,1);
	assert.equal((await f.req('status')).status,200);
});
