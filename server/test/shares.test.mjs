import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import { createShares, installPublicShares } from '../shares.mjs';

const id = 'a'.repeat(32);
const other = 'b'.repeat(32);
test('expiry closes an already-open response and prevents further requests', async t => {
	const directory = mkdtempSync(path.join(tmpdir(), 'jserver-share-expiry-'));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	let clock = Date.now() - 86400000 + 700;
	const shares = createShares(directory, { now: () => clock });
	const entry = shares.create({ Id: id, Type: 'Movie', Name: 'Expiry test' }, 'local');
	clock = Date.now();
	const app = express();
	installPublicShares(app, { shares, publicDirectory: path.resolve('public'), hlsFile: '', identity: () => ({}),
		sameOrigin: () => true, playback: () => {}, session: () => {}, stream: (req, res) => res.write('started') });
	const server = await new Promise(resolve => { const listener = app.listen(0, '127.0.0.1', () => resolve(listener)); });
	t.after(() => { server.closeAllConnections(); server.close(); });
	const base = `http://127.0.0.1:${server.address().port}/share/${entry.token}`;
	const response = await fetch(base + '/stream/session/resource');
	const reader = response.body.getReader(); await reader.read();
	await assert.rejects(reader.read());
	clock = entry.expires;
	assert.equal((await fetch(base + '/info')).status, 410);
});

test('shares are single-item, hashed, persisted, expire at 24 hours and can be revoked', t => {
	const directory = mkdtempSync(path.join(tmpdir(), 'jserver-shares-'));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	let now = 100000;
	let revoked;
	const store = createShares(directory, { now: () => now, onRevoke: owner => { revoked = owner; } });
	assert.throws(() => store.create({ Id: id, Type: 'Folder' }, 'local'));
	const series = store.create({ Id: other, Type: 'Series', Name: 'Series' }, 'local', 168);
	assert.equal(series.expires - now, 7 * 86400000);
	assert.equal(store.resolve(series.token).type, 'Series');
	assert.throws(() => store.create({ Id: id, Type: 'Movie' }, 'local', 999));
	assert.throws(() => store.create({ Id: id, Type: 'Movie', IsVirtualItem: true }, 'local'));
	const issued = store.create({ Id: id, Type: 'Episode', Name: 'Pilot', SeriesName: 'Example' }, 'local');
	assert.equal(issued.expires - now, 86400000);
	assert.equal(store.resolve(issued.token).itemId, id);
	assert.equal(store.resolve('0'.repeat(64)), null);
	assert.ok(!readFileSync(path.join(directory, 'shares.json'), 'utf8').includes(issued.token));
	assert.ok(!JSON.stringify(store.list(id)).includes(issued.token));
	assert.equal(createShares(directory, { now: () => now }).resolve(issued.token).id, issued.id);
	now = issued.expires;
	assert.equal(store.resolve(issued.token), null);
	const fresh = store.create({ Id: id, Type: 'Movie', Name: 'Example' }, 'local');
	const owner = store.resolve(fresh.token).owner;
	assert.equal(store.revoke(fresh.id), true);
	assert.equal(revoked, owner);
	assert.equal(store.validOwner(owner), false);
	assert.equal(store.resolve(fresh.token), null);
});

test('real routes allow anonymous single-title playback but no library, administration or other streams', async t => {
	const directory = mkdtempSync(path.join(tmpdir(), 'jserver-share-routes-'));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const upstream = express(); upstream.use(express.json());
	const channelId='dispatch-live-11111111-1111-1111-1111-111111111111';
	upstream.get('/output/m3u',(req,res)=>res.send(`#EXTM3U\n#EXTINF:-1 group-title="24/7",Comedy\nhttp://${req.get('host')}/proxy/ts/stream/11111111-1111-1111-1111-111111111111`));
	const played = [];
	upstream.get('/Users/test/Items/:id', (req, res) => res.json({ Id: req.params.id, Name: 'Example film', Type: 'Movie', MediaType: 'Video', MediaSources: [{ Id: 'source', Size: 14, Container: 'mp4' }] }));
	upstream.post('/Items/:id/PlaybackInfo', (req, res) => {
		played.push({ id: req.params.id, subtitles: req.body.SubtitleStreamIndex });
		res.json({ PlaySessionId: 'play', MediaSources: [{ Id: 'source', TranscodingUrl: `/Videos/${req.params.id}/master.m3u8?api_key=SECRET`, MediaStreams: [] }] });
	});
	upstream.get('/Videos/:id/master.m3u8', (req, res) => res.type('application/vnd.apple.mpegurl').send('#EXTM3U\n#EXTINF:6,\nchunk.ts?api_key=SECRET\n'));
	upstream.get('/Videos/:id/chunk.ts', (req, res) => res.type('video/mp2t').send('video bytes'));
	upstream.get('/Videos/:id/continuous.mp4', (req, res) => { res.type('video/mp4'); res.write('first bytes'); });
	upstream.get('/Videos/:id/stream.mp4', (req, res) => {
		res.type('video/mp4').set('Accept-Ranges', 'bytes');
		if (req.get('range') === 'bytes=0-3') res.status(206).set('Content-Range', 'bytes 0-3/14').send('down');
		else res.send('download bytes');
	});
	upstream.post('/Sessions/Playing/Stopped', (req, res) => res.sendStatus(204));
	upstream.delete('/Videos/ActiveEncodings', (req, res) => res.sendStatus(204));
	const listen = app => new Promise(resolve => { const server = app.listen(0, '127.0.0.1', () => resolve(server)); });
	const mock = await listen(upstream);
	const front = express();
	const local = await listen(front);
	const remote = await listen(front);
	t.after(() => { for (const server of [mock, local, remote]) { server.closeAllConnections(); server.close(); } });
	process.env.NODE_ENV = 'test';
	process.env.JELLYFIN_URL = `http://127.0.0.1:${mock.address().port}`;
	process.env.DISPATCHARR_URL=process.env.JELLYFIN_URL;
	process.env.DATA_DIR = path.join(directory, 'data');
	process.env.AUTH_DIR = path.join(directory, 'auth');
	process.env.PORT = String(local.address().port);
	process.env.PUBLIC_ORIGIN = 'https://jserver.example';
	mkdirSync(process.env.DATA_DIR);
	writeFileSync(path.join(process.env.DATA_DIR, 'connection.json'), JSON.stringify({ userId: 'test', token: 'SECRET' }));
	(await import('./enabled-fixture.mjs')).enableIntegrations();
	const { app, directStreamLink } = await import('../server.mjs'); front.use(app);
	const localBase = `http://127.0.0.1:${local.address().port}`;
	const remoteBase = `http://127.0.0.1:${remote.address().port}`;
	const request = (base, route, body, headers = {}) => fetch(base + route, { method: body ? 'POST' : 'GET', redirect: 'manual',
		headers: { ...(body ? { 'Content-Type': 'application/json', Origin: base } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
	assert.equal((await request(remoteBase, '/api/shares', { id })).status, 401);
	assert.equal((await request(localBase, '/api/shares', { id }, { Origin: 'https://evil.invalid' })).status, 403);
	assert.equal((await request(localBase, '/api/shares', { id }, { Authorization: 'Bearer invalid' })).status, 401);
	assert.equal((await request(remoteBase,'/api/shares',{id:channelId})).status,401);
	assert.equal((await request(localBase,'/api/shares',{id:channelId,hours:72})).status,400);
	assert.equal((await request(localBase,'/api/shares',{id:channelId.replaceAll('1','2')})).status,404);
	const channelShare=await(await request(localBase,'/api/shares',{id:channelId})).json();
	const channelRoute=new URL(channelShare.url).pathname;
	assert.equal((await(await request(remoteBase,channelRoute+'/info')).json()).type,'TvChannel');
	assert.equal((await(await request(localBase,'/api/shares/'+channelId)).json()).shares.length,1);
	const sharedSession={id:'session',shareToken:channelRoute.split('/').at(-1)};
	assert.equal(directStreamLink(sharedSession,'aW5kZXgubTN1OA'),channelRoute+'/stream/session/aW5kZXgubTN1OA');
	assert.equal(directStreamLink(sharedSession,'c2VnbWVudDAudHM','unrelated-cast'),channelRoute+'/stream/session/c2VnbWVudDAudHM');
	await request(localBase,'/api/shares/'+channelShare.id+'/revoke',{});
	assert.equal((await request(remoteBase,channelRoute+'/info')).status,410);
	const response = await request(localBase, '/api/shares', { id }); assert.equal(response.status, 201);
	const share = await response.json();
	const route = new URL(share.url).pathname;
	const token = route.split('/').at(-1);
	const page = await request(remoteBase, route); assert.equal(page.status, 200);
	assert.equal(page.headers.get('cache-control'), 'no-store');
	assert.equal(page.headers.get('referrer-policy'), 'no-referrer');
	assert.match(page.headers.get('x-robots-tag'), /noindex/);
	const info = await (await request(remoteBase, route + '/info')).json();
	assert.equal(info.title, 'Example film'); assert.ok(!JSON.stringify(info).includes('SECRET'));
	for (const endpoint of ['/api/items', '/api/shares/' + id, '/api/downloads/' + id + '/file']) {
		assert.equal((await request(remoteBase, endpoint, undefined, { Authorization: 'Bearer ' + token })).status, 401);
	}
	assert.equal((await request(remoteBase, '/settings')).status, 403);
	assert.equal((await request(remoteBase, route + '/api/items')).status, 404);
	assert.equal((await request(remoteBase, route + '/play', { id: other }, { Origin: 'https://evil.invalid' })).status, 403);
	const playback = await (await request(remoteBase, route + '/play', { id: other, subtitleIndex: 3 })).json();
	assert.deepEqual(played.at(-1), { id, subtitles: 3 });
	assert.ok(playback.url.startsWith(route + '/stream/'));
	const playlist = await (await request(remoteBase, playback.url)).text();
	assert.ok(!playlist.includes('SECRET'));
	const segment = playlist.split('\n')[2];
	assert.equal(await (await request(remoteBase, segment)).text(), 'video bytes');
	const counted = await (await request(localBase, '/api/auth/upload-limit')).json();
	assert.equal(counted.transferredBytes, Buffer.byteLength('video bytes'));
	assert.equal(counted.mbps, 50);
	assert.equal(await (await request(localBase, segment)).text(), 'video bytes');
	const lanActivity = await (await request(localBase, '/api/activity')).json();
	assert.equal(lanActivity.active.find(x => x.itemId === id).mediaRoute, 'local');
	assert.equal(lanActivity.active.find(x => x.itemId === id).local, true);
	assert.equal((await (await request(localBase, '/api/auth/upload-limit')).json()).transferredBytes, counted.transferredBytes, 'LAN delivery is unrestricted');
	const forged = Buffer.from(`/Videos/${other}/chunk.ts`).toString('base64url');
	assert.equal((await request(remoteBase, route + '/stream/' + playback.session + '/' + forged)).status, 400);
	const second = await (await request(localBase, '/api/shares', { id: other })).json();
	assert.equal((await request(remoteBase, new URL(second.url).pathname + '/stream/' + playback.session + '/' + segment.split('/').at(-1))).status, 403);
	assert.equal((await request(remoteBase, route + '/session/' + playback.session + '/cast', {})).status, 404);
	const continuous = Buffer.from(`/Videos/${id}/continuous.mp4`).toString('base64url');
	const streaming = await request(remoteBase, route + '/stream/' + playback.session + '/' + continuous);
	const reader = streaming.body.getReader(); await reader.read();
	const closed = assert.rejects(reader.read());
	assert.equal((await request(localBase, '/api/shares/' + share.id + '/revoke', {})).status, 200);
	await closed;
	assert.equal((await request(remoteBase, route)).status, 410);
	assert.equal((await request(remoteBase, playback.url)).status, 410);
	assert.equal((await request(remoteBase, '/share/' + '0'.repeat(64))).status, 410);
	const audit = await (await request(localBase, '/api/activity')).json();
	assert.ok(audit.recent.some(entry => entry.type === 'playback' && entry.shareId === share.id && entry.ip === '127.0.0.1'));
	assert.ok(!JSON.stringify(audit).includes(token));
	const device = await (await request(localBase, '/api/apps/enroll', { name: 'Synthetic download test' })).json();
	await request(localBase, '/api/apps/' + device.id, { action: 'approve', role: 'viewer' });
	assert.equal((await request(localBase,'/api/account-limits/device:'+device.id,{minutes:0,downloads:true})).status,200);
	const beforeDownload = (await (await request(localBase, '/api/auth/upload-limit')).json()).transferredBytes;
	const downloaded = await request(remoteBase, '/api/downloads/' + id + '/file', undefined, { Authorization: 'Bearer ' + device.token, Range: 'bytes=0-3' });
	assert.equal(downloaded.status, 206);
	assert.equal(downloaded.headers.get('content-range'), 'bytes 0-3/14');
	assert.equal(await downloaded.text(), 'down');
	assert.equal((await (await request(localBase, '/api/auth/upload-limit')).json()).transferredBytes, beforeDownload + 4, 'Android downloads share the same allowance');
});

test('series shares scope every episode and respect chosen expiry and revocation', async t => {
	const directory = mkdtempSync(path.join(tmpdir(), 'tellybox-series-'));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const shares = createShares(directory);
	const issued = shares.create({ Id: id, Type: 'Series', Name: 'Our series' }, 'local', 72);
	const app = express(); app.use(express.json());
	installPublicShares(app, { shares, publicDirectory: path.resolve('public'), hlsFile: '', identity: () => ({}), sameOrigin: () => true,
		seriesEpisodes: async series => { assert.equal(series, id); return [{ Id: other, Type: 'Episode', SeriesId: id }]; },
		sharedItem: async item => ({ Id: item, Type: item === 'film' ? 'Movie' : 'Episode', SeriesId: item === other ? id : 'another', IsVirtualItem: item === 'missing' }),
		playback: (req, res) => res.json({ id: req.body.id }), stream: (req,res) => res.sendStatus(204), session: (req,res) => res.sendStatus(204)
	});
	const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
	t.after(() => { server.closeAllConnections(); server.close(); });
	const base = 'http://127.0.0.1:' + server.address().port + '/share/' + issued.token;
	assert.equal((await (await fetch(base + '/episodes')).json()).items[0].Id, other);
	const play = value => fetch(base + '/play', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: value }) });
	assert.deepEqual(await (await play(other)).json(), { id: other });
	for (const value of [id, 'film', 'missing', 'outside']) assert.equal((await play(value)).status, 404);
	shares.revoke(issued.id);
	assert.equal((await play(other)).status, 410);
	assert.equal((await fetch(base + '/episodes')).status, 410);
});

test('live channel shares last exactly 24 hours and cannot select a different channel',async t=>{
	const directory=mkdtempSync(path.join(tmpdir(),'tellybox-channel-share-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
	let now=Date.now();const shares=createShares(directory,{now:()=>now});
	const item={Id:'dispatch-live-11111111-1111-1111-1111-111111111111',Name:'24/7 Comedy',Type:'TvChannel'};
	assert.throws(()=>shares.create(item,'local',72),/24 hours/);
	const issued=shares.create(item,'local');assert.equal(issued.expires-now,86400000);
	const app=express();app.use(express.json());
	installPublicShares(app,{shares,publicDirectory:path.resolve('public'),hlsFile:'',identity:()=>({}),sameOrigin:()=>true,
		playback:(req,res)=>res.json({id:req.body.id,live:true,owner:req.jserverOwner}),stream:(req,res)=>res.sendStatus(204),session:(req,res)=>res.sendStatus(204)});
	const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});t.after(()=>{server.closeAllConnections();server.close();});
	const base=`http://127.0.0.1:${server.address().port}/share/${issued.token}`;
	assert.equal((await(await fetch(base+'/info')).json()).type,'TvChannel');
	const response=await fetch(base+'/play',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id:other})});
	assert.equal((await response.json()).id,item.Id);assert.equal((await fetch(base+'/episodes')).status,404);
	assert.equal((await fetch(base+'/api/dispatcharr/channels')).status,404);
	now=issued.expires;assert.equal((await fetch(base+'/info')).status,410);
});
