import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

test('browser episode downloads require access, support ranges, share the upload cap and stop on logout', async t => {
	const directory = mkdtempSync(path.join(tmpdir(), 'tellybox-browser-download-'));
	const id = 'a'.repeat(32), movie = 'b'.repeat(32), missing = 'c'.repeat(32);
	const servers = [], payload = Buffer.alloc(128 * 1024, 57);
	let continuous = false, calls = 0, encodings = 0, cleaned = 0, streamCalls = 0, failStream = false;
	const listen = async handler => {
		const server = http.createServer(handler); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); servers.push(server); return server;
	};
	t.after(() => { for (const server of servers) { server.closeAllConnections(); server.close(); } rmSync(directory, { recursive: true, force: true }); });
	const upstream = await listen((req, res) => {
		calls++;
		if (req.url.startsWith('/Users/')) {
			const item = req.url.split('/').at(-1);
			return res.end(JSON.stringify({ Id: item, Name: 'Café / test', SeriesName: 'Example series', IndexNumber: 2, ParentIndexNumber: 1, Type: item === movie ? 'Movie' : 'Episode', IsMissing: item === missing,
				MediaSources: [{ Id: 'source', RunTimeTicks:36000000000, Size: payload.length, Container: 'mkv', Path: '/private/media/path' }] }));
		}
		if (req.url.startsWith('/Videos/ActiveEncodings')) { cleaned++; res.writeHead(204); return res.end(); }
		if (req.url.startsWith('/Videos/')) {
			streamCalls++;
			if (failStream) { res.writeHead(503); return res.end(); }
			const url = new URL(req.url, 'http://test');
			if (url.searchParams.get('Static') === 'false') { encodings++; assert.equal(url.pathname, '/Videos/' + id + '/stream.mp4'); assert.equal(url.searchParams.get('VideoBitRate'), '1808000'); assert.equal(url.searchParams.get('AllowVideoStreamCopy'), 'false'); }
			assert.equal(req.headers['x-emby-token'], 'synthetic-upstream-secret');
			res.setHeader('Content-Type', 'video/x-matroska'); res.setHeader('Accept-Ranges', 'bytes');
			if (req.headers.range) {
				assert.equal(req.headers.range, 'bytes=4-11'); res.statusCode = 206;
				res.setHeader('Content-Range', 'bytes 4-11/' + payload.length); res.setHeader('Content-Length', 8);
				return res.end(req.method === 'HEAD' ? undefined : payload.subarray(4, 12));
			}
			res.setHeader('Content-Length', payload.length);
			if (req.method === 'HEAD') return res.end();
			if (continuous) return res.write(payload.subarray(0, 1024));
			return res.end(payload);
		}
		res.writeHead(404); res.end();
	});
	const local = await listen(), remote = await listen();
	Object.assign(process.env, { NODE_ENV: 'test', PORT: String(local.address().port), JELLYFIN_URL: 'http://127.0.0.1:' + upstream.address().port, DATA_DIR: directory, AUTH_DIR: directory, PUBLIC_ORIGIN: 'https://download.example.test', LOCAL_HOSTS: '127.0.0.1', LOCAL_NETWORKS: '127.0.0.0/8' });
	writeFileSync(path.join(directory, 'connection.json'), JSON.stringify({ userId: 'test', token: 'synthetic-upstream-secret' }));
	(await import('./enabled-fixture.mjs')).enableIntegrations();
	const { app } = await import('../server.mjs'); local.on('request', app); remote.on('request', app);
	const base = side => 'http://127.0.0.1:' + (side === 'local' ? local : remote).address().port;
	const call = (side, route, { body, headers = {}, method } = {}) => fetch(base(side) + route, { method: method || (body ? 'POST' : 'GET'), redirect: 'manual', headers: { Origin: base(side), ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
	const route = '/api/episode-downloads/' + id;
	assert.equal((await call('remote', route + '/info')).status, 401);
	assert.equal((await call('remote', route + '/file')).status, 401);
	assert.equal(calls, 0, 'Unauthenticated callers never reach Jellyfin');
	assert.equal((await call('local', '/api/downloads/' + id + '/file')).status, 403, 'Existing app-only download API stays app-only');
	assert.equal((await call('local', route + '/file', { headers: { Authorization: 'Bearer invalid' } })).status, 401);
	assert.equal((await call('local', '/api/episode-downloads/' + movie + '/info')).status, 400);
	assert.equal((await call('local', '/api/episode-downloads/' + missing + '/file')).status, 400);
	const info = await (await call('local', route + '/info')).json();
	assert.equal(info.options.length, 4); assert.equal(info.options[0].bytes, 972000000);
	assert.equal((await call('local', route + '/file?quality=invalid')).status, 400);
	assert.equal((await call('local', route + '/file?quality=small', { headers:{ Range:'bytes=4-11' } })).status, 416);
	const smaller = await call('local', route + '/file?quality=small'); assert.equal(smaller.status, 200); assert.match(smaller.headers.get('content-disposition'), /Small.mp4/); await smaller.arrayBuffer();
	await new Promise(resolve => setTimeout(resolve, 25)); assert.equal(encodings, 1); assert.equal(cleaned, 1);
	assert.equal(info.bytes, payload.length); assert.equal(info.url, route + '/file');
	assert.ok(!JSON.stringify(info).includes('private')); assert.ok(!JSON.stringify(info).includes('secret'));
	const head = await call('local', info.url, { method: 'HEAD' }); assert.equal(head.status, 200);
	assert.match(head.headers.get('content-disposition'), /^attachment;/); assert.match(head.headers.get('content-disposition'), /S01E02/);
	assert.equal(head.headers.get('content-length'), String(payload.length)); assert.equal(head.headers.get('cache-control'), 'private, no-store');
	assert.equal(await head.text(), '');
	const range = await call('local', info.url, { headers: { Range: 'bytes=4-11' } });
	assert.equal(range.status, 206); assert.equal(range.headers.get('content-range'), 'bytes 4-11/' + payload.length);
	assert.deepEqual(Buffer.from(await range.arrayBuffer()), payload.subarray(4, 12));
	assert.equal((await call('local', info.url, { headers: { Range: 'bytes=0-1,4-5' } })).status, 416);
	assert.equal((await call('local', info.url, { body: {} })).status, 405);
	assert.equal((await (await call('local', '/api/auth/upload-limit')).json()).transferredBytes, 0);
	const password = 'synthetic-download-password';
	await call('local', '/api/auth/password', { body: { password } });
	const login = await call('remote', '/api/auth/login', { body: { password } });
	const Cookie = login.headers.get('set-cookie').split(';')[0];
	const file = await call('remote', info.url, { headers: { Cookie } });
	assert.equal(file.status, 200); assert.deepEqual(Buffer.from(await file.arrayBuffer()), payload);
	assert.equal((await (await call('local', '/api/auth/upload-limit')).json()).transferredBytes, payload.length);
	const activity = await (await call('local', '/api/activity')).json();
	assert.ok(activity.recent.some(entry => entry.type === 'browser_download'));
	continuous = true;
	const transfer = await call('remote', info.url, { headers: { Cookie } }); const reader = transfer.body.getReader();
	await reader.read();
	const current=await (await call('local','/api/activity')).json();
	assert.equal(current.downloads.length,1);assert.equal(current.downloads[0].title,'Example series · Café / test');
	assert.ok(current.downloads[0].bytes>0);assert.equal(current.downloads[0].totalBytes,payload.length);assert.equal(current.downloads[0].mediaRoute,'remote');assert.equal(current.stats.active,0);
	const streamsBeforeBlocked = streamCalls;
	const blocked = await call('remote', info.url, { headers: { Cookie } });
	assert.equal(blocked.status, 409); assert.match((await blocked.json()).error, /Finish or cancel/);
	assert.equal((await call('remote', info.url + '?quality=small', { headers: { Cookie } })).status, 409);
	assert.equal(streamCalls, streamsBeforeBlocked, 'Denied downloads never open an upstream stream or encoder');
	assert.equal((await call('remote', '/api/downloads/status', { headers: { Cookie } })).status, 409);
	assert.equal((await call('remote', info.url, { method: 'HEAD', headers: { Cookie } })).status, 200, 'HEAD does not consume a download slot');
	continuous = false;
	const anotherUser = await call('local', info.url); assert.equal(anotherUser.status, 200); await anotherUser.arrayBuffer();
	const stopped = assert.rejects(reader.read());
	await call('remote', '/api/auth/logout', { body: {}, headers: { Cookie } }); await stopped;
	for(let i=0;i<20;i++) { if(!(await (await call('local','/api/activity')).json()).downloads.length)break; await new Promise(resolve=>setTimeout(resolve,10)); }
	assert.equal((await (await call('local','/api/activity')).json()).downloads.length,0);
	assert.equal((await call('remote', info.url, { headers: { Cookie } })).status, 401);
	failStream = true;
	assert.equal((await call('local', info.url)).status, 503);
	assert.equal((await call('local', '/api/downloads/status')).status, 200, 'Upstream failures release the reservation');
	failStream = false; continuous = true;
	const cancel = new AbortController();
	const simultaneous = await Promise.all([0, 1].map(() => fetch(base('local') + info.url, { signal: cancel.signal })));
	assert.deepEqual(simultaneous.map(r => r.status).sort(), [200, 409], 'Simultaneous starts cannot both reserve a slot');
	const cancelled = simultaneous.find(r => r.status === 200);
	await cancelled.body.getReader().read(); cancel.abort();
	for (let i = 0; i < 50; i++) { if ((await call('local', '/api/downloads/status')).status === 200) break; await new Promise(resolve => setTimeout(resolve, 10)); }
	assert.equal((await call('local', '/api/downloads/status')).status, 200, 'Cancellation frees the slot');
	continuous = false;
	const resumed = await call('local', info.url, { headers: { Range: 'bytes=4-11' } }); assert.equal(resumed.status, 206); await resumed.arrayBuffer();
});
