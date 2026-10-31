import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { issueCastTicket, validCastTicket } from '../cast.mjs';

test('Cast tickets expire, rotate and follow owner revocation', () => {
	const session = { id: 'session', resource: 'resource', owner: 'owner' };
	const ticket = issueCastTicket(session, 'https://example.test', 1000);
	const token = new URL(ticket.url).pathname.split('/')[2];
	assert.equal(validCastTicket(session, token, () => true, 1001), true);
	assert.equal(validCastTicket(session, token, () => false, 1001), false);
	assert.equal(validCastTicket(session, token, () => true, ticket.expires), false);
	assert.equal(validCastTicket(session, 'invalid', () => true, 1001), false);
	assert.equal(validCastTicket(undefined, token, () => true, 1001), false);
	issueCastTicket(session, 'https://example.test', 1002);
	assert.equal(validCastTicket(session, token, () => true, 1003), false);
	assert.throws(() => issueCastTicket(session, 'http://example.test'));
});

test('receiver streams work without cookies but cannot access other sessions or survive revocation', async t => {
	const directory = mkdtempSync(path.join(tmpdir(), 'jserver-cast-'));
	const id = '0123456789abcdef0123456789abcdef';
	const servers = [];
	const listen = async handler => {
		const server = http.createServer(handler);
		await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
		servers.push(server);
		return server;
	};
	t.after(() => { for (const server of servers) { server.closeAllConnections(); server.close(); } rmSync(directory, { recursive: true, force: true }); });
	const playbackRequests = [];
	const upstream = await listen(async (req, res) => {
		if (req.url.startsWith('/Users/')) return res.end(JSON.stringify({ Id: id, Name: 'Synthetic Cast fixture', Type: 'Movie', RunTimeTicks: 600000000, MediaSources: [{ Id: 'source' }] }));
		if (req.url.includes('/PlaybackInfo')) {
			if (req.method === 'POST') {
				let text = '';
				for await (const chunk of req) text += chunk;
				playbackRequests.push(JSON.parse(text));
			}
			return res.end(JSON.stringify({ PlaySessionId: 'play', MediaSources: [{ Id: 'source', TranscodingUrl: `/Videos/${id}/master.m3u8`, MediaStreams: [] }] }));
		}
		if (req.url.endsWith('master.m3u8')) { res.setHeader('Content-Type', 'application/vnd.apple.mpegurl'); return res.end('#EXTM3U\n#EXT-X-MAP:URI="init.mp4?api_key=secret"\n#EXTINF:6,\nsegment.ts?api_key=secret\n'); }
		if (req.url.includes('segment.ts') || req.url.includes('init.mp4')) { res.setHeader('Content-Type', 'video/mp2t'); return res.end('synthetic media bytes'); }
		if (req.url.endsWith('continuous.ts')) { res.setHeader('Content-Type', 'video/mp2t'); return res.write('first bytes'); }
		res.writeHead(204); res.end();
	});
	const local = await listen();
	const remote = await listen();
	Object.assign(process.env, { NODE_ENV: 'test', PORT: String(local.address().port), JELLYFIN_URL: `http://127.0.0.1:${upstream.address().port}`, DATA_DIR: directory, AUTH_DIR: directory, PUBLIC_ORIGIN: 'https://cast.example.test', LOCAL_PLAYBACK_ORIGIN:'http://10.50.0.10:8082', LOCAL_HOSTS: '127.0.0.1', LOCAL_NETWORKS: '127.0.0.0/8' });
	writeFileSync(path.join(directory, 'connection.json'), JSON.stringify({ userId: 'test', token: 'synthetic-upstream-secret' }));
	(await import('./enabled-fixture.mjs')).enableIntegrations();
	const { app } = await import('../server.mjs');
	local.on('request', app); remote.on('request', app);
	const base = side => `http://127.0.0.1:${(side === 'local' ? local : remote).address().port}`;
	const request = (side, route, body, cookie, extra = {}) => fetch(base(side) + route, {
		method: body === undefined ? 'GET' : 'POST', redirect: 'manual',
		headers: { 'Content-Type': 'application/json', Origin: base(side), ...(cookie ? { Cookie: cookie } : {}), ...extra },
		body: body === undefined ? undefined : JSON.stringify(body)
	});
	assert.equal((await request('local', '/api/play', { id, download: true })).status, 403, 'Browser sessions cannot reserve offline preparation');
	const play = await (await request('local', '/api/play', { id })).json();
	assert.equal(playbackRequests.at(-1).MediaSourceId, 'source');
	assert.equal(playbackRequests.at(-1).SubtitleStreamIndex, -1);
	assert.equal(playbackRequests.at(-1).AlwaysBurnInSubtitleWhenTranscoding, false);
	const withSubtitles = await (await request('local', '/api/play', { id, subtitleIndex: 2, audioIndex: 1 })).json();
	const selected = playbackRequests.at(-1);
	assert.equal(selected.MediaSourceId, 'source');
	assert.equal(selected.SubtitleStreamIndex, 2);
	assert.equal(selected.AudioStreamIndex, 1);
	assert.equal(selected.AlwaysBurnInSubtitleWhenTranscoding, true);
	assert.equal(selected.AllowVideoStreamCopy, false);
	assert.equal(selected.EnableDirectPlay, false);
	assert.equal(selected.EnableDirectStream, false);
	await request('local', `/api/sessions/${withSubtitles.session}`, { action: 'stop' });
	const lanPlayResponse = await request('local', '/api/play', { id }, undefined, { Origin: process.env.PUBLIC_ORIGIN });
	assert.equal(lanPlayResponse.headers.get('access-control-allow-origin'), process.env.PUBLIC_ORIGIN);
	const lanPlay = await lanPlayResponse.json();
	const lanPlaylist = await request('local', lanPlay.url, undefined, undefined, { Origin: process.env.PUBLIC_ORIGIN });
	assert.equal(lanPlaylist.status, 200);
	assert.equal(lanPlaylist.headers.get('access-control-allow-origin'), process.env.PUBLIC_ORIGIN);
	const lanText = await lanPlaylist.text();
	assert.ok(lanText.includes('/stream/' + lanPlay.session));
	await request('local', '/api/sessions/' + lanPlay.session, { action: 'stop' }, undefined, { Origin: process.env.PUBLIC_ORIGIN });
	assert.equal((await request('remote', `/api/sessions/${play.session}/cast`, {})).status, 401);
	assert.equal((await request('local', `/api/sessions/${play.session}/cast`, {}, null, { Origin: 'https://evil.test' })).status, 403);
	const ticket = await (await request('local', `/api/sessions/${play.session}/cast`, {})).json();
	const receiverPath = new URL(ticket.url).pathname;
	assert.equal(new URL(ticket.localUrl).origin, 'http://10.50.0.10:8082');
	assert.equal(new URL(ticket.localUrl).pathname, receiverPath);
	const localReceiver = await request('local', receiverPath, undefined, undefined, { Origin: 'https://www.gstatic.com' });
	assert.equal(localReceiver.status, 200);
	assert.equal(localReceiver.headers.get('access-control-allow-origin'), '*');
	const localText = await localReceiver.text();
	const localSegment = localText.split('\n').find(line => line && !line.startsWith('#'));
	assert.equal(new URL(localSegment, ticket.localUrl).origin, new URL(ticket.localUrl).origin);
	assert.equal(await (await request('local', localSegment)).text(), 'synthetic media bytes');
	assert.equal((await (await request('local', '/api/auth/upload-limit')).json()).transferredBytes, 0, 'LAN cast media bypasses the budget');
	const localPreflight = await fetch(base('local') + receiverPath, { method: 'OPTIONS', headers: { Origin: 'https://www.gstatic.com', 'Access-Control-Request-Private-Network': 'true' } });
	assert.equal(localPreflight.status, 204);
	assert.equal(localPreflight.headers.get('access-control-allow-private-network'), 'true');
	const playlist = await request('remote', receiverPath);
	assert.equal(playlist.status, 200);
	assert.equal(playlist.headers.get('access-control-allow-origin'), '*');
	const text = await playlist.text();
	assert.ok(!text.includes('secret'));
	assert.ok(text.includes('/cast-stream/'));
	const segment = text.split('\n').find(line => line && !line.startsWith('#'));
	assert.equal(await (await request('remote', segment)).text(), 'synthetic media bytes');
	assert.equal((await (await request('local', '/api/auth/upload-limit')).json()).transferredBytes, Buffer.byteLength('synthetic media bytes'), 'Remote cast media uses the shared budget');
	const preflight = await fetch(base('remote') + segment, { method: 'OPTIONS', headers: { Origin: 'https://www.gstatic.com', 'Access-Control-Request-Headers': 'range' } });
	assert.equal(preflight.status, 204);
	const other = await (await request('local', '/api/play', { id })).json();
	assert.equal((await request('remote', receiverPath.replace(play.session, other.session))).status, 403);
	assert.equal((await request('remote', receiverPath.replace('/cast-stream/', '/cast-stream/bad'))).status, 403);
	assert.equal((await request('remote', '/api/items')).status, 401);
	assert.equal((await request('remote', '/api/items')).headers.get('access-control-allow-origin'), null);
	assert.equal((await request('remote', receiverPath, {})).status, 405);
	await request('local', `/api/sessions/${play.session}`, { action: 'stop' });
	assert.equal((await request('remote', receiverPath)).status, 403);
	assert.equal((await request('local', receiverPath)).status, 403);
	await request('local', `/api/sessions/${other.session}`, { action: 'stop' });
	// Android keeps its installation token on the control connection; the LAN only
	// receives a capability for this session. Revoking the app revokes that capability.
	const device = await (await request('local', '/api/apps/enroll', { name: 'TV route fixture' })).json();
	await request('local', `/api/apps/${device.id}`, { action: 'approve', role: 'viewer' });
	const appHeaders = { Authorization: `Bearer ${device.token}`, 'X-jServer-App': 'android' };
	assert.equal((await request('remote','/api/play',{id,download:true},undefined,appHeaders)).status,403,'Downloads default to disabled');
	assert.equal((await request('remote','/api/account-limits/device:'+device.id,{minutes:0,downloads:true},undefined,appHeaders)).status,403,'A viewer cannot enable their downloads');
	assert.equal((await request('local','/api/account-limits/device:'+device.id,{minutes:0,downloads:true})).status,200);
	const appPlayResponse = await request('remote', '/api/play', { id, download: true, quality: 2000000 }, undefined, appHeaders);
	assert.equal(appPlayResponse.status, 200);
	const appPlay = await appPlayResponse.json();
	assert.equal((await request('remote', '/api/play', { id, download: true }, undefined, appHeaders)).status, 409, 'Offline preparation reserves one file');
	const appTicketResponse = await request('remote', `/api/sessions/${appPlay.session}/cast`, {}, undefined, appHeaders);
	assert.equal(appTicketResponse.status, 200);
	const appTicket = await appTicketResponse.json();
	const appReceiver = new URL(appTicket.url).pathname;
	assert.equal((await request('local', appReceiver)).status, 200);
	assert.equal((await request('remote', '/api/downloads/status', undefined, undefined, appHeaders)).status, 409, 'Finished playlist requests keep the file reservation between segments');
	const diagnostics = await (await request('local', '/api/activity')).json();
	const download = diagnostics.active.find(entry => entry.purpose === 'download');
	assert.equal(download.mediaRoute, 'local');
	assert.equal(download.qualityMbps, 2);
	assert.equal(download.remoteMbps, 0);
	assert.ok(!JSON.stringify(diagnostics).includes(device.token));
	assert.equal((await request('remote', '/api/apps/activity', undefined, undefined, appHeaders)).status, 403);
	await request('local', `/api/apps/${device.id}`, { action: 'revoke', role: 'viewer' });
	assert.equal((await request('local', appReceiver)).status, 403);
	const password = 'synthetic-cast-test-password';
	await request('local', '/api/auth/password', { password });
	const login = await request('remote', '/api/auth/login', { password });
	const cookie = login.headers.get('set-cookie').split(';')[0];
	const owned = await (await request('remote', '/api/play', { id }, cookie)).json();
	assert.equal((await request('local', `/api/sessions/${owned.session}/cast`, {})).status, 403);
	const ownedTicket = await (await request('remote', `/api/sessions/${owned.session}/cast`, {}, cookie)).json();
	assert.equal(ownedTicket.localUrl, undefined);
	const ownedPath = new URL(ownedTicket.url).pathname;
	const continuous = ownedPath.slice(0, ownedPath.lastIndexOf('/') + 1) + Buffer.from(`/Videos/${id}/continuous.ts`).toString('base64url');
	const stream = await request('remote', continuous);
	const reader = stream.body.getReader();
	await reader.read();
	const aborted = assert.rejects(reader.read());
	await request('remote', '/api/auth/logout', {}, cookie);
	await aborted;
	assert.equal((await request('remote', ownedPath)).status, 403);
});
