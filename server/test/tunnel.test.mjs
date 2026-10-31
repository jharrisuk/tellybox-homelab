import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { tunnelStatus, remoteAccessStatus } from '../tunnel.mjs';

test('stable relay status verifies health and preserves its address during an outage', async t => {
	let result = new Response('{"ok":true}', { status: 200 });
	t.mock.method(globalThis, 'fetch', async (url, options) => {
		assert.equal(String(url), 'https://relay.example/health');
		assert.equal(options.redirect, 'error');
		if (result instanceof Error) throw result;
		return result;
	});
	assert.deepEqual(await remoteAccessStatus('https://relay.example'), { url: 'https://relay.example', connected: true, temporary: false });
	result = new Response('{"ok":false}', { status: 200 });
	assert.equal((await remoteAccessStatus('https://relay.example')).connected, false);
	result = new Error('Connection unavailable');
	assert.deepEqual(await remoteAccessStatus('https://relay.example'), { url: 'https://relay.example', connected: false, temporary: false });
	await assert.rejects(remoteAccessStatus('http://relay.example'), /HTTPS/);
});

test('temporary address follows the live connector and handles reconnects and shutdown', async t => {
	let hostname = 'first-address.trycloudflare.com';
	let ready = true;
	const server = http.createServer((req, res) => {
		if (req.url === '/quicktunnel') res.end(JSON.stringify({ hostname }));
		else { res.statusCode = ready ? 200 : 503; res.end(); }
	});
	await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
	t.after(() => { server.closeAllConnections(); server.close(); });
	const address = `http://127.0.0.1:${server.address().port}`;
	assert.deepEqual(await tunnelStatus(address), { url: 'https://first-address.trycloudflare.com', connected: true });
	hostname = 'replacement-address.trycloudflare.com';
	assert.deepEqual(await tunnelStatus(address), { url: 'https://replacement-address.trycloudflare.com', connected: true });
	ready = false;
	assert.deepEqual(await tunnelStatus(address), { url: 'https://replacement-address.trycloudflare.com', connected: false });
	for (const unsafe of ['javascript:alert(1)', 'trycloudflare.com.evil.example', 'a.trycloudflare.com/path', '']) {
		hostname = unsafe;
		assert.deepEqual(await tunnelStatus(address), { url: null, connected: false });
	}
	server.closeAllConnections();
	await new Promise(resolve => server.close(resolve));
	assert.deepEqual(await tunnelStatus(address), { url: null, connected: false });
});
