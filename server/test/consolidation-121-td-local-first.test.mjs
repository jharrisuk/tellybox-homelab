import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createVodLibrary, mergeEpisodes, mergeLibrary, vodView } from '../vod-library.mjs';

const NOW = Date.parse('2026-11-12T00:00:00Z');
const torrentday = { m3u_account: { name: 'TorrentDay VOD (Merger)', priority: 5, is_active: true } };

test('a TorrentDay series merged into a local copy keeps the local identity and absorbs the provider id', () => {
	const local = { Id: 'local-series', Name: 'Bake-alike show', Type: 'Series', Source: 'local', ProviderIds: { Tmdb: '93001' }, ChildCount: 6 };
	const streamed = vodView({ id: 19300, name: 'Bake-alike show', tmdb_id: 93001, providers: [torrentday] }, 'Series');
	const merged = mergeLibrary([local], [streamed]);
	assert.equal(merged.length, 1);
	assert.equal(merged[0].Id, 'local-series');
	assert.equal(merged[0].Source, 'local', 'the local copy wins the display identity');
	assert.deepEqual(merged[0].VodIds, [19300], 'the streamed provider id is kept for episode fallback');
});

test('episode merge prefers the local copy on the same season and episode and keeps streamed providers elsewhere', () => {
	const local = [
		{ Id: 'local-1', Name: 'Local S01E01', Type: 'Episode', ParentIndexNumber: 1, IndexNumber: 1, Source: 'local' },
		{ Id: 'local-2', Name: 'Local S01E02', Type: 'Episode', ParentIndexNumber: 1, IndexNumber: 2, Source: 'local' }
	];
	const remote = [
		{ Id: 'dispatch-episode-1-19', Name: 'Show S01E01', Type: 'Episode', Source: 'streamed', Provider: 'TorrentDay VOD (Merger)', ParentIndexNumber: 1, IndexNumber: 1, VodIds: [1] },
		{ Id: 'dispatch-episode-2-19', Name: 'Show S01E02', Type: 'Episode', Source: 'streamed', Provider: 'TorrentDay VOD (Merger)', ParentIndexNumber: 1, IndexNumber: 2, VodIds: [2] },
		{ Id: 'dispatch-episode-3-19', Name: 'Show S01E03', Type: 'Episode', Source: 'streamed', Provider: 'TorrentDay VOD (Merger)', ParentIndexNumber: 1, IndexNumber: 3, VodIds: [3] }
	];
	const merged = mergeEpisodes(local, remote, { Id: 'series', Name: 'Show' });
	assert.deepEqual(merged.map(e => e.Id), ['local-1', 'local-2', 'dispatch-episode-3-19'], 'local copies win S01E01 and S01E02; the streamed gap remains');
	assert.equal(merged[0].Source, 'local');
	assert.equal(merged[2].Provider, 'TorrentDay VOD (Merger)', 'the streamed episode keeps its provider identity');
});

test('list keeps local copies ahead of streamed ones and a local-only view never calls the provider', async t => {
	const directory = await mkdtemp(path.join(os.tmpdir(), 'consolidation-121-td-local-'));
	const file = path.join(directory, 'catalogue.json');
	await writeFile(file, JSON.stringify({ items: [], time: NOW }));
	const local = [
		{ Id: 'local-movie', Name: 'A local film', Type: 'Movie', Source: 'local', ProviderIds: { Tmdb: '51001' }, PremiereDate: '2020-01-01' },
		{ Id: 'local-series', Name: 'A local show', Type: 'Series', Source: 'local', ProviderIds: { Tmdb: '51002' }, ChildCount: 3, PremiereDate: '2021-01-01' }
	];
	const providerCalls = [];
	const dispatcharr = {
		status: () => ({ connected: true }),
		api: async route => { providerCalls.push(route); return []; }
	};
	const lib = createVodLibrary({ dispatcharr, file, clock: () => NOW, localItems: async () => local, localItem: async () => null,
		localEpisodes: async id => id === 'local-series' ? [{ Id: 'local-ep', Name: 'Pilot', Type: 'Episode', ParentIndexNumber: 1, IndexNumber: 1 }] : [] });
	t.after(async () => { await lib.flushIndex(); await rm(directory, { recursive: true, force: true }); });

	const all = await lib.list({ type: 'movies' });
	assert.equal(all.items[0].Id, 'local-movie');
	const localOnly = await lib.list({ source: 'local' });
	assert.deepEqual(localOnly.items.map(i => i.Id).sort(), ['local-movie', 'local-series']);
	assert.deepEqual(localOnly.items.map(i => i.Source), ['local', 'local']);
	assert.equal(providerCalls.length, 0, 'a local-only list must make zero provider calls');
});

test('local movies and streamed movies share the browse list with local first and no availability gating', async t => {
	const directory = await mkdtemp(path.join(os.tmpdir(), 'consolidation-121-td-movies-'));
	const file = path.join(directory, 'catalogue.json');
	const streamed = [
		vodView({ id: 1, name: 'Streamed one (2025)', providers: [torrentday] }, 'Movie'),
		vodView({ id: 2, name: 'Streamed two (2024)', providers: [torrentday] }, 'Movie')
	];
	await writeFile(file, JSON.stringify({ items: streamed, time: NOW }));
	const local = [{ Id: 'local-film', Name: 'Local film', Type: 'Movie', Source: 'local', ProviderIds: { Tmdb: '52001' }, PremiereDate: '2023-01-01' }];
	const lib = createVodLibrary({ dispatcharr: { status: () => ({ connected: true }), api: async () => [] }, file, clock: () => NOW,
		localItems: async () => local, localItem: async () => null, localEpisodes: async () => [] });
	t.after(async () => { await lib.flushIndex(); await rm(directory, { recursive: true, force: true }); });
	const page = await lib.list({ type: 'movies' });
	assert.deepEqual(page.items.map(i => i.Id), ['local-film', 'dispatch-movie-1', 'dispatch-movie-2'], 'local first, then newest streamed');
	assert.equal(page.items[1].Provider, 'TorrentDay VOD (Merger)', 'streamed movies keep their real provider label');
});
