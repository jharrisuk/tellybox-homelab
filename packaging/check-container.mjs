import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
const base = 'http://127.0.0.1:8990';
const docker = args => { const r = spawnSync('docker', ['compose', '-p', 'homelab-ci', ...args], { encoding: 'utf8' }); if (r.status) throw Error(r.stderr); return r.stdout; };
const request = (route, body, cookie) => fetch(base + '/api/setup/' + route, { method: body ? 'POST' : 'GET', headers: { ...(body ? { Origin: base, 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
assert.notEqual(docker(['exec', '-T', 'tellybox', 'id', '-u']).trim(), '0');
assert.equal((await request('config')).status, 401);
const bootstrap = JSON.parse(docker(['exec', '-T', 'tellybox', 'cat', '/config/bootstrap.json']));
const login = await request('login', { bootstrap: bootstrap.token, password: 'container-fixture-only-97531' });
assert.equal(login.status, 200);
const cookie = login.headers.get('set-cookie').split(';')[0];
const config = await (await request('config', null, cookie)).json();
assert.ok(Object.values(config.config.services).every(s => !s.enabled));
assert.equal(config.runtime.running, true);
assert.equal((await fetch('http://127.0.0.1:8082/health')).status, 200);
assert.equal((await request('relay')).status, 401);
assert.equal((await request('relay', null, cookie)).status, 200);
assert.equal((await request('apply', {revision:config.config.revision}, cookie)).status, 200);
docker(['restart', 'tellybox']);
for (let i = 0; i < 30; i++) {
	try { const s = await request('status'); if (s.ok) { assert.equal((await s.json()).claimed, true); break; } } catch { }
	if (i === 29) throw Error('Setup did not recover after restart');
	await new Promise(resolve => setTimeout(resolve, 1000));
}
const restored = await request('login', { password: 'container-fixture-only-97531' });
assert.equal(restored.status, 200);
console.log('Container: non-root, private setup, disabled services, explicit apply and persistent owner verified.');
