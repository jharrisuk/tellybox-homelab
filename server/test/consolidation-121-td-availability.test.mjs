import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createVodLibrary, vodView } from '../vod-library.mjs';

const NOW = Date.parse('2026-11-12T00:00:00Z');
const torrentday = { m3u_account: { name: 'TorrentDay VOD (Merger)', priority: 5, is_active: true } };

async function fixture(t, { api }) {
	const directory = await mkdtemp(path.join(os.tmpdir(), 'consolidation-121-td-avail-'));
	const file = path.join(directory, 'catalogue.json');
	await writeFile(file, JSON.stringify({ items: [], time: NOW }));
	const lib = createVodLibrary({ dispatcharr: { status: () => ({ connected: true }), api }, file, clock: () => NOW,
		localItems: async () => [], localItem: async () => null, localEpisodes: async () => [] });
	t.after(async () => { await lib.flushIndex(); await rm(directory, { recursive: true, force: true }); });
	return lib;
}

test('a TorrentDay series removed upstream is a clean 404, not a fake upstream outage', async t => {
	const calls = [];
	const lib = await fixture(t, { api: async route => {
		calls.push(route);
		if (/\/series\/8144\/$/.test(route)) throw Object.assign(Error('upstream 404'), { upstreamStatus: 404 });
		if (/\/series\/8144\/episodes\//.test(route)) throw Object.assign(Error('upstream 404'), { upstreamStatus: 404 });
		return { results: [], next: null };
	} });
	await assert.rejects(() => lib.item('dispatch-series-8144'), error => error.status === 404 && /no longer available/.test(error.message));
	await assert.rejects(() => lib.raw('dispatch-series-8144'), error => error.status === 404);
	await assert.rejects(() => lib.item('dispatch-episode-27466-8144'), error => error.status === 404 && /no longer available/.test(error.message));
	assert.equal(calls.length, 3);
});

test('an upstream 5xx keeps its outage status and is not misread as a removed title', async t => {
	const lib = await fixture(t, { api: async route => {
		if (/\/series\/12\/$/.test(route)) throw Object.assign(Error('Dispatcharr is unavailable. Please try again.'), { status: 502, upstreamStatus: 500 });
		return { results: [], next: null };
	} });
	await assert.rejects(() => lib.item('dispatch-series-12'), error => error.status === 502 && error.upstreamStatus === 500);
});

test('future-dated episodes never make a TorrentDay series playable, and aired ones do', async t => {
	const directory = await mkdtemp(path.join(os.tmpdir(), 'consolidation-121-td-dates-'));
	const file = path.join(directory, 'catalogue.json');
	const series = vodView({ id: 8144, name: 'A fishing show (2018)', providers: [torrentday] }, 'Series');
	const saved = {
		version: 1, updated: NOW, entries: [
			{ series, time: NOW, access: NOW, value: { items: [
				{ Id: 'dispatch-episode-1-8144', Name: 'E01', Type: 'Episode', Source: 'streamed', ParentIndexNumber: 9, IndexNumber: 1, PremiereDate: '2026-10-25' },
				{ Id: 'dispatch-episode-2-8144', Name: 'E02', Type: 'Episode', Source: 'streamed', ParentIndexNumber: 9, IndexNumber: 2, PremiereDate: '2026-11-29' }
			], notice: '' } }
		]
	};
	await writeFile(file, JSON.stringify({ items: [series], time: NOW }));
	await writeFile(file + '.series.json', JSON.stringify(saved));
	const lib = createVodLibrary({ dispatcharr: { status: () => ({ connected: true }), api: async () => { throw Error('must not fetch'); } }, file, clock: () => NOW,
		localItems: async () => [], localItem: async () => null, localEpisodes: async () => [] });
	t.after(async () => { await lib.flushIndex(); await rm(directory, { recursive: true, force: true }); });
	const page = await lib.list({ type: 'tvshows' });
	assert.deepEqual(page.items.map(i => i.Id), ['dispatch-series-8144'], 'one aired episode is enough for browse');
	const episodes = await lib.episodes('dispatch-series-8144');
	assert.equal(episodes.items.length, 2, 'the saved list is served whole');
});

test('an episode list failure keeps the saved list and never reports the series as empty', async t => {
	const directory = await mkdtemp(path.join(os.tmpdir(), 'consolidation-121-td-keep-'));
	const file = path.join(directory, 'catalogue.json');
	const series = vodView({ id: 8144, name: 'A fishing show (2018)', providers: [torrentday] }, 'Series');
	const saved = { version: 1, updated: NOW, entries: [
		{ series, time: NOW - 3600001, access: NOW, value: { items: [
			{ Id: 'dispatch-episode-1-8144', Name: 'E01', Type: 'Episode', Source: 'streamed', ParentIndexNumber: 1, IndexNumber: 1, PremiereDate: '2026-01-01' }
		], notice: '' } }
	] };
	await writeFile(file, JSON.stringify({ items: [series], time: NOW }));
	await writeFile(file + '.series.json', JSON.stringify(saved));
	let now = NOW;
	let fail = true;
	const lib = createVodLibrary({ dispatcharr: { status: () => ({ connected: true }), api: async route => {
		if (fail) throw Error('provider down');
		if (/\/series\/8144\/$/.test(route)) return { id: 8144, name: 'A fishing show (2018)', providers: [torrentday], year: 2018 };
		if (/\/series\/8144\/provider-info\//.test(route)) return {};
		if (/\/series\/8144\/episodes\//.test(route)) return [{ id: 1, name: 'E01', series: { id: 8144, name: 'A fishing show (2018)' }, providers: [torrentday], season_number: 1, episode_number: 1 }];
		return { results: [], next: null };
	} }, file, clock: () => now,
		localItems: async () => [], localItem: async () => null, localEpisodes: async () => [] });
	t.after(async () => { await lib.flushIndex(); await rm(directory, { recursive: true, force: true }); });
	const states = await lib.verifySeries(['dispatch-series-8144'], { limit: 1, deadlineMs: 2000, concurrency: 1 });
	assert.equal(states.states.get('dispatch-series-8144'), 'unknown', 'a failure is unknown, never empty');
	fail = false;
	now += 300001;
	const page = await lib.list({ type: 'tvshows' });
	assert.deepEqual(page.items.map(i => i.Id), ['dispatch-series-8144'], 'the saved list is trusted again once the provider recovers and the backoff passes');
});
