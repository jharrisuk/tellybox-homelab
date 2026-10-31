import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { atomicJson } from '../homelab/config.mjs';
import { relayHealth } from '../homelab/relay-health.mjs';

const instance = '12345678-1234-1234-1234-123456789abc';
function fixture(t) {
	const directory = mkdtempSync(path.join(os.tmpdir(), 'relay-health-'));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const apply = (origin = 'https://watch.example.test') => atomicJson(path.join(directory, 'applied-configuration.json'), { network: { publicOrigin: origin, trustedProxies: ['100.64.1.2'] } });
	return { directory, apply };
}
test('unapplied relay settings never probe or appear operational', async t => {
	const { directory } = fixture(t); let calls = 0;
	atomicJson(path.join(directory, 'configuration.json'), { network: { publicOrigin: 'https://draft.example.test' } });
	const probe = relayHealth(directory, { fetcher: async () => { calls++; } });
	assert.equal((await probe()).state, 'not-configured'); assert.equal(calls, 0);
});
test('an existing relay without SSH credentials is operational only when it reaches this process', async t => {
	const { directory, apply } = fixture(t); apply(); const requests = [];
	const probe = relayHealth(directory, { fetcher: async (url, options) => { requests.push({ url: String(url), options }); return Response.json({ instance }); } });
	const result = await probe();
	assert.equal(result.state, 'operational'); assert.equal(result.origin, 'https://watch.example.test'); assert.deepEqual(result.proxies, ['100.64.1.2']);
	assert.equal(requests.length, 2); assert.match(requests[1].url, /^https:\/\/watch\.example\.test\/homelab-ready\?check=/);
	assert.equal(requests[1].options.redirect, 'error'); assert.equal(requests[1].options.headers.Authorization, undefined);
});
test('ordinary HTTP success, another installation, redirects and invalid responses are not operational', async t => {
	const { directory, apply } = fixture(t); apply();
	for (const value of [{ ok: true }, { instance: 'aaaaaaaa-1234-1234-1234-123456789abc' }, { instance: '' }]) {
		const probe = relayHealth(directory, { fetcher: async url => Response.json(String(url).startsWith('http://127.') ? { instance } : value) });
		assert.equal((await probe()).state, 'different-server');
	}
	for (const response of [new Response('', { status: 302 }), new Response('x'.repeat(2048)), new Response('<html>Other site</html>')]) {
		const probe = relayHealth(directory, { fetcher: async url => String(url).startsWith('http://127.') ? Response.json({ instance }) : response });
		assert.equal((await probe()).state, 'unavailable');
	}
	assert.equal((await relayHealth(directory, { fetcher: async () => { throw Error('Private network details'); } })()).state, 'unavailable');
});
test('probes are deduplicated, briefly cached and invalidated when applied route changes', async t => {
	const { directory, apply } = fixture(t); apply(); let calls = 0, now = 100000;
	const probe = relayHealth(directory, { clock: () => now, fetcher: async () => { calls++; return Response.json({ instance }); } });
	await Promise.all([probe(), probe(), probe()]); assert.equal(calls, 2);
	await probe(); assert.equal(calls, 2);
	now += 30001; await probe(); assert.equal(calls, 4);
	apply('https://replacement.example.test'); await probe(); assert.equal(calls, 6);
	apply(''); assert.equal((await probe()).state, 'not-configured'); assert.equal(calls, 6);
});
