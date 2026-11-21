import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createVodLibrary } from '../vod-library.mjs';

const NOW = Date.parse('2026-11-12T12:00:00Z');
const HOUR = 3600000;

function saved(series, episodes, time) {
	return { series, value: { items: episodes, notice: '' }, time, retry: 0, access: time };
}

test('a saved positive local episode list that has gone stale is rechecked and hidden when Jellyfin now returns no episodes', async t => {
	const directory = await mkdtemp(path.join(os.tmpdir(), 'playable-117-stale-local-'));
	const file = path.join(directory, 'catalogue.json');
	await writeFile(file, JSON.stringify({ items: [], time: NOW }));
	const local = [{ Id: 'was-playable-local', Name: 'Was playable local', Type: 'Series', ChildCount: 2, ProviderIds: { Tmdb: '7201' } }];
	await writeFile(file + '.series.json', JSON.stringify({ version: 1, updated: NOW, entries: [
		saved({ Id: 'was-playable-local', Name: 'Was playable local', Type: 'Series', Source: 'local', VodIds: [], ProviderIds: { Tmdb: '7201' } },
			[{ Id: 'old-local-episode', Name: 'Old episode', Type: 'Episode', Source: 'local', PremiereDate: '2020-01-01' }], NOW - 2 * HOUR)
	] }));
	let localCalls = 0;
	const lib = createVodLibrary({ file, clock: () => NOW, dispatcharr: { status: () => ({ connected: false }), api: async () => { throw Error('no provider'); } },
		localItems: async () => local, localItem: async () => local[0], localEpisodes: async () => { localCalls++; return []; } });
	t.after(async () => { await lib.flushIndex(); await rm(directory, { recursive: true, force: true }); });
	const list = await lib.list({ type: 'tvshows' });
	assert.deepEqual(list.items.map(item => item.Id), [], 'a stale saved positive must not keep a currently empty local title');
	assert.equal(localCalls, 1, 'the stale local positive is rechecked through Jellyfin');
	const discover = await lib.availability([{ id: '7201', type: 'tv', watchId: 'stale-seerr-id', statusLabel: 'In your library' }]);
	assert.equal(discover[0].watchId, undefined, 'an inbound stale watchId is stripped when the local series is empty');
	assert.equal(discover[0].statusLabel, undefined);
});

test('a saved positive streamed episode list that has gone stale is force-refreshed and hidden when the provider now returns no episodes', async t => {
	const directory = await mkdtemp(path.join(os.tmpdir(), 'playable-117-stale-streamed-'));
	const file = path.join(directory, 'catalogue.json');
	const series = { Id: 'dispatch-series-201', Name: 'Was playable streamed', Type: 'Series', Source: 'streamed', Provider: 'Dispatcharr',
		VodIds: [201], ProviderIds: { Tmdb: '8201' }, PremiereDate: '2020-01-01', DateCreated: '2020-01-01' };
	await writeFile(file, JSON.stringify({ items: [series], time: NOW }));
	await writeFile(file + '.series.json', JSON.stringify({ version: 1, updated: NOW, entries: [
		saved(series, [{ Id: 'old-streamed-episode', Name: 'Old streamed episode', Type: 'Episode', Source: 'streamed', PremiereDate: '2020-01-01' }], NOW - 2 * HOUR)
	] }));
	const calls = { detail: 0, info: 0, episodes: 0 };
	const dispatcharr = { status: () => ({ connected: true }), api: async route => {
		if (route === '/api/vod/series/201/') { calls.detail++; return { id: 201, name: 'Was playable streamed', tmdb_id: 8201, year: 2020 }; }
		if (route.includes('/provider-info/')) { calls.info++; return {}; }
		if (route.includes('/episodes/')) { calls.episodes++; return []; }
		return [];
	} };
	const lib = createVodLibrary({ file, clock: () => NOW, dispatcharr, localItems: async () => [], localItem: async () => { throw Error('no local'); }, localEpisodes: async () => [] });
	t.after(async () => { await lib.flushIndex(); await rm(directory, { recursive: true, force: true }); });
	const list = await lib.list({ type: 'tvshows' });
	assert.deepEqual(list.items.map(item => item.Id), [], 'a stale saved positive must not keep a currently empty streamed title');
	assert.equal(calls.info, 1, 'the stale streamed positive is force-refreshed');
	assert.equal(calls.episodes, 1);
});

test('repeated failures back off instead of retrying the provider on every poll', async t => {
	const directory = await mkdtemp(path.join(os.tmpdir(), 'playable-117-backoff-'));
	const file = path.join(directory, 'catalogue.json');
	await writeFile(file, JSON.stringify({ items: [], time: NOW }));
	const local = [{ Id: 'failing-local', Name: 'Failing local', Type: 'Series', ChildCount: 2, ProviderIds: { Tmdb: '7301' } }];
	let calls = 0;
	const lib = createVodLibrary({ file, clock: () => NOW, dispatcharr: { status: () => ({ connected: false }), api: async () => { throw Error('no provider'); } },
		localItems: async () => local, localItem: async () => local[0], localEpisodes: async () => { calls++; throw Error('Jellyfin unavailable'); } });
	t.after(async () => { await lib.flushIndex(); await rm(directory, { recursive: true, force: true }); });
	assert.deepEqual((await lib.list({ type: 'tvshows' })).items, []);
	const afterFirst = calls;
	assert.deepEqual((await lib.list({ type: 'tvshows' })).items, []);
	assert.equal(calls, afterFirst, 'a fresh failure backoff suppresses repeated provider calls');
});
