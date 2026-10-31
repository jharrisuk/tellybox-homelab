import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { installAuth } from '../auth.mjs';

async function fixture(t) {
	const directory = mkdtempSync(path.join(tmpdir(), 'tellybox-favourites-'));
	const app = express(); app.use(express.json({ limit: '16kb' }));
	const listen = () => new Promise(resolve => { const server = app.listen(0, '127.0.0.1', () => resolve(server)); });
	const local = await listen(), remote = await listen();
	t.after(() => { local.closeAllConnections(); remote.closeAllConnections(); local.close(); remote.close(); rmSync(directory, { recursive: true, force: true }); });
	const base = side => `http://127.0.0.1:${(side === 'local' ? local : remote).address().port}`;
	installAuth(app, { directory, publicDirectory: path.resolve('public'), localPort: local.address().port, localHosts: ['127.0.0.1'], localNetworks: ['127.0.0.0/8'], trustedProxies: ['127.0.0.1'], publicOrigin: 'https://127.0.0.1:' + remote.address().port });
	const call = (route, body, token, side = 'local', extra = {}) => fetch(base(side) + route, { method: body ? 'POST' : 'GET', headers: { ...(body ? { 'Content-Type': 'application/json', Origin: base(side) } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(side === 'remote' ? { 'X-Forwarded-Proto': 'https', Origin: 'https://127.0.0.1:' + remote.address().port } : {}), ...extra }, body: body ? JSON.stringify(body) : undefined });
	const enroll = async name => (await call('/api/apps/enroll', { name })).json();
	return { call, enroll, directory };
}
const item = { Id: 'film-123', Name: 'A favourite film', Type: 'Movie', Artwork: '/images/film-123/Primary', secret: 'must-not-be-saved' };

test('favourites are private until linked, independently owned and unlinked without deletion', async t => {
	const { call, enroll, directory } = await fixture(t);
	const james = await enroll('James phone'), wife = await enroll('Wife phone'), tv = await enroll('Living room TV');
	const first = await (await call('/api/favourites', null, james.token)).json();
	assert.equal((await call('/api/favourites', { profileId: first.own.id, changes: [{ id: item.Id, saved: true, item }] }, james.token)).status, 200);
	const second = await (await call('/api/favourites', null, wife.token)).json();
	await call('/api/favourites', { profileId: second.own.id, changes: [{ id: item.Id, saved: true, item }] }, wife.token);
	const initialTV = await (await call('/api/favourites', null, tv.token)).json();
	assert.equal(initialTV.collections.length, 1); assert.equal(initialTV.own.items.length, 0);
	assert.equal((await call('/api/favourites/devices/' + tv.id, { profileId: initialTV.own.id, linkedProfiles: [first.own.id, second.own.id] }, james.token)).status, 403);
	await call('/api/favourites/devices/' + tv.id, { profileId: initialTV.own.id, linkedProfiles: [first.own.id, second.own.id] });
	const linked = await (await call('/api/favourites', null, tv.token)).json();
	assert.equal(linked.collections.length, 3); assert.equal(linked.collections[1].items[0].Id, item.Id);
	await call('/api/favourites', { profileId: first.own.id, changes: [{ id: item.Id, saved: false }] }, james.token);
	assert.equal((await (await call('/api/favourites', null, wife.token)).json()).own.items.length, 1);
	assert.equal((await call('/api/favourites', { profileId: second.own.id, changes: [{ id: item.Id, saved: false }] }, tv.token)).status, 409);
	await call('/api/favourites/devices/' + tv.id, { profileId: initialTV.own.id, linkedProfiles: [] });
	assert.equal((await (await call('/api/favourites', null, tv.token)).json()).collections.length, 1);
	assert.equal((await (await call('/api/favourites', null, wife.token)).json()).own.items.length, 1);
	assert.ok(!readFileSync(path.join(directory, 'favourites.json'), 'utf8').includes('must-not-be-saved'));
});

test('collection management and device renaming require admin, never change roles or tokens', async t => {
	const { call, enroll } = await fixture(t);
	const phone = await enroll('A phone');
	assert.equal((await call('/api/apps/' + phone.id, { action: 'rename', name: 'James phone' }, phone.token)).status, 403);
	const renamed = await (await call('/api/apps/' + phone.id, { action: 'rename', name: 'James phone' })).json();
	assert.equal(renamed.id, phone.id); assert.equal(renamed.role, 'viewer'); assert.equal(renamed.name, 'James phone');
	assert.equal((await (await call('/api/apps/me', null, phone.token)).json()).name, 'James phone');
	const own = await (await call('/api/favourites', null, phone.token)).json();
	await call('/api/favourites/profiles/' + own.own.id, { name: 'James' });
	assert.equal((await (await call('/api/favourites', null, phone.token)).json()).own.name, 'James');
	assert.equal((await call('/api/favourites/manage', null, phone.token)).status, 403);
	assert.equal((await call('/api/favourites', { profileId: own.own.id, changes: [null] }, phone.token)).status, 400);
	assert.equal((await call('/api/favourites/devices/' + phone.id, { profileId: 'constructor', linkedProfiles: [] })).status, 400);
	assert.equal((await call('/api/favourites/profiles', { name: 'Someone' }, phone.token)).status, 403);
	assert.equal((await call('/api/favourites/profiles', { name: 'Someone' }, null, 'local', { Origin: 'https://evil.test' })).status, 403);
	assert.equal((await call('/api/favourites', { profileId: own.own.id, changes: [{ id: 'bad', saved: true, item: { Id: 'bad', Name: 'Bad', Type: 'Movie', Artwork: 'javascript:alert(1)' } }] }, phone.token)).status, 200);
	assert.equal((await (await call('/api/favourites', null, phone.token)).json()).own.items[0].Artwork, undefined);
	await call('/api/apps/' + phone.id, { action: 'revoke' });
	assert.equal((await call('/api/favourites', null, phone.token)).status, 401);
	assert.equal((await call('/api/favourites', null, null, 'remote')).status, 401);
});


test('episode favourites save one show, including Home and existing collections, without affecting other people', async t => {
	const { call, enroll, directory } = await fixture(t);
	const phone = await enroll('Phone'), other = await enroll('Other phone');
	const own = (await (await call('/api/favourites', null, phone.token)).json()).own;
	const otherOwn = (await (await call('/api/favourites', null, other.token)).json()).own;
	const episode = { Id: 'dispatch-episode-10', Name: 'Episode one', Type: 'Episode', SeriesId: 'dispatch-series-7', SeriesName: 'A show', Source: 'streamed', Artwork: '/episode.jpg', IndexNumber: 1 };
	const change = (item, saved = true) => ({ id: item.Id, saved, item });
	const put = (changes, token = phone.token, profileId = own.id) => call('/api/favourites', { profileId, changes }, token);
	assert.equal((await put([change(episode)])).status, 200);
	await put([change({ ...episode, Id: 'dispatch-episode-11' })]);
	let items = (await (await call('/api/favourites', null, phone.token)).json()).own.items;
	assert.equal(items[0].LastPlayedAt, 0); assert.ok(items[0].FavouritedAt > 0);
	assert.deepEqual(items.map(({ LastPlayedAt, FavouritedAt, ...item }) => item), [{ Id: 'dispatch-series-7', Name: 'A show', Type: 'Series', Source: 'streamed', Artwork: '/api/web/art/series/7' }]);
	await put([change(episode)], other.token, otherOwn.id);
	// An old app can still remove using the episode ID without its metadata.
	await put([{ id: episode.Id, saved: false }]);
	assert.equal((await (await call('/api/favourites', null, phone.token)).json()).own.items.length, 0);
	assert.equal((await (await call('/api/favourites', null, other.token)).json()).own.items.length, 1);
	await call('/api/favourites/home', change(episode), phone.token);
	await call('/api/favourites/home', change({ ...episode, Id: 'dispatch-episode-11' }), phone.token);
	assert.equal((await (await call('/api/favourites/home', null, phone.token)).json()).own.items.length, 1);
	await call('/api/favourites/home', { id: episode.Id, saved: false }, phone.token);
	// The other person's favourite remains in the combined Home collection.
	assert.equal((await (await call('/api/favourites/home', null, phone.token)).json()).own.items.length, 1);
	// Simulate the collection saved by the previous release.
	const file = path.join(directory, 'favourites.json'), state = JSON.parse(readFileSync(file, 'utf8'));
	state.profiles[own.id].items = { [episode.Id]: episode, another: { ...episode, Id: 'another' }, film: { Id: 'film', Name: 'Film', Type: 'Movie' }, channel: { Id: 'channel', Name: '24/7', Type: 'TvChannel' } };
	writeFileSync(file, JSON.stringify(state));
	items = (await (await call('/api/favourites', null, phone.token)).json()).own.items;
	assert.deepEqual(items.map(i => i.Type).sort(), ['Movie', 'Series', 'TvChannel']);
	await put([{ id: 'another', saved: false }]);
	assert.deepEqual((await (await call('/api/favourites', null, phone.token)).json()).own.items.map(i => i.Type).sort(), ['Movie', 'TvChannel']);
});

test('web and server target the same show without copying episode metadata or guessing missing parents', async () => {
	const { favouriteTitle } = await import('../favourites.mjs');
	const { runInNewContext } = await import('node:vm');
	const source = readFileSync(path.resolve('public/app.js'), 'utf8');
	const fn = source.slice(source.indexOf('function favouriteTitle('), source.indexOf('function normaliseFavourites('));
	const browser = runInNewContext(fn + '; favouriteTitle');
	for (const item of [
		{ Id: 'ep1', Name: 'Episode 1', Type: 'Episode', SeriesId: 'abc123', SeriesName: 'Show', IndexNumber: 1, Artwork: '/episode.jpg', ProductionYear: 2026 },
		{ Id: 'ep2', Name: 'Episode 2', Type: 'Episode', SeriesId: 'dispatch-series-8', SeriesName: 'VOD show', Source: 'streamed' },
		{ Id: 'film', Name: 'Film', Type: 'Movie' },
		{ Id: '247', Name: '24/7', Type: 'TvChannel' },
		{ Id: 'unknown', Name: 'Unknown episode', Type: 'Episode' }
	]) assert.equal(JSON.stringify(browser(item)), JSON.stringify(favouriteTitle(item)));
	const title = favouriteTitle({ Id: 'e', Name: 'Episode', Type: 'Episode', SeriesId: 'show', SeriesName: 'Show', IndexNumber: 1, ProductionYear: 2026 });
	assert.equal(title.Id, 'show'); assert.equal(title.Type, 'Series'); assert.equal(title.IndexNumber, undefined); assert.equal(title.ProductionYear, undefined);
});
