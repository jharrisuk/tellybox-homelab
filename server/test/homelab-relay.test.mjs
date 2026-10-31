import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { validateRelay, caddySite, installScript, sshArgs } from '../../relay/setup.mjs';
const example = { hostname:'watch.example.com',sshHost:'203.0.113.10',sshUser:'ubuntu',keyFile:path.resolve('fixture-key'),knownHostsFile:path.resolve('fixture-hosts'),homeTailscaleIp:'100.100.10.20' };
test('relay uses remote-authenticated port, overwrites spoofable client headers and pins SSH hosts', () => {
	const c = validateRelay(example), site = caddySite(c), args = sshArgs(c);
	assert.match(site,/reverse_proxy 100\.100\.10\.20:8083/); assert.match(site,/X-Forwarded-For \{http.request.remote.host\}/);
	assert.ok(args.includes('StrictHostKeyChecking=yes')); assert.ok(args.includes('BatchMode=yes'));
});
test('relay input cannot inject shell commands or route to arbitrary destinations', () => {
	for (const [key,value] of [['hostname','watch.example.com; id'],['sshHost','-oProxyCommand=x'],['sshUser','root; id'],['homeTailscaleIp','127.0.0.1'],['homeTailscaleIp','100.100.999.2']]) assert.throws(()=>validateRelay({...example,[key]:value}));
});
test('relay refuses existing Caddy, validates before install and preserves rollback', () => {
	const script = installScript(example); assert.match(script,/Existing Caddy installation detected/); assert.match(script,/Caddyfile.previous/);
	assert.ok(script.indexOf('caddy validate') < script.indexOf('install -m 644'));
	assert.match(script,/--advertise-exit-node=false/); assert.doesNotMatch(script,/ufw disable|ufw reset|sshd_config|StrictHostKeyChecking=no/);
});
