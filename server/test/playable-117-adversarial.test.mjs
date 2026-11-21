import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createVodLibrary } from '../vod-library.mjs';

const NOW = Date.parse('2026-11-12T12:00:00Z');

function savedEmpty(series, time = NOW) {
	return { series, value: { items: [], notice: '' }, time, retry: 0, access: time };
}

test('concurrent disjoint verification calls share one global admission bound and discard expired queued work', async t => {
	const directory = await mkdtemp(path.join(os.tmpdir(), 'playable-117-admission-'));
	const file = path.join(directory, 'catalogue.json');
	await writeFile(file, JSON.stringify({ items: [], time: NOW }));
	let active = 0, started = 0, peak = 0;
	const gates = [];
	const localEpisodes = async () => {
		started++; active++; peak = Math.max(peak, active);
		await new Promise(resolve => gates.push(resolve));
		active--;
		return [{ Id: 'episode', Name: 'Episode', Type: 'Episode', PremiereDate: '2020-01-01' }];
	};
	const lib = createVodLibrary({ file, clock: () => Date.now(), dispatcharr: { status: () => ({ connected: false }), api: async () => [] },
		localItems: async () => [], localItem: async () => null, localEpisodes });
	t.after(async () => { await lib.flushIndex(); await rm(directory, { recursive: true, force: true }); });

	const calls = Array.from({ length: 20 }, (_, call) => {
		const ids = Array.from({ length: 4 }, (_, index) => `admission-${call}-${index}`);
		return lib.verifySeries(ids, { limit: 4, deadlineMs: 100, concurrency: 4 });
	});
	await Promise.all(calls);
	assert.ok(peak <= 4, `global active verification must stay bounded, saw ${peak}`);
	assert.ok(started <= 4, `queued work must not start after its caller deadline, saw ${started} starts`);
	for (const release of gates.splice(0)) release();
	await new Promise(resolve => setTimeout(resolve, 50));
	assert.ok(peak <= 4, 'late completion must not raise the global active bound');
});

test('a failed prefix does not consume every later verification opportunity', async t => {
	const directory = await mkdtemp(path.join(os.tmpdir(), 'playable-117-failed-prefix-'));
	const file = path.join(directory, 'catalogue.json');
	await writeFile(file, JSON.stringify({ items: [], time: NOW }));
	const local = Array.from({ length: 40 }, (_, index) => ({
		Id: `failed-prefix-${String(index).padStart(3, '0')}`,
		Name: (index < 24 ? 'AAAA Failing ' : 'ZZZZ Playable ') + String(index).padStart(3, '0'),
		Type: 'Series', ChildCount: 2, ProviderIds: { Tmdb: String(9200 + index) }, DateCreated: new Date(NOW + index * 1000).toISOString()
	}));
	const calls = [];
	let failures = 0;
	const lib = createVodLibrary({ file, clock: () => NOW, dispatcharr: { status: () => ({ connected: false }), api: async () => [] },
		localItems: async () => local, localItem: async id => local.find(item => item.Id === id) || null,
		localEpisodes: async id => {
			calls.push(id);
			const index = Number(id.slice(-3));
			if (index < 24) { failures++; throw Error('transient Jellyfin failure'); }
			return [{ Id: 'episode-' + id, Name: 'Episode', Type: 'Episode', ParentIndexNumber: 1, IndexNumber: 1, PremiereDate: '2020-01-01' }];
		} });
	t.after(async () => { await lib.flushIndex(); await rm(directory, { recursive: true, force: true }); });

	const first = await lib.list({ type: 'tvshows', sort: 'az', start: 0 });
	assert.equal(first.items.length, 0, 'the initial failed prefix must not be presented as playable');
	assert.ok(failures >= 1);
	await lib.flushAvailability();
	const second = await lib.list({ type: 'tvshows', sort: 'az', start: 0 });
	assert.equal(second.items.length, 16, 'later actionable titles must be verified after the failed prefix backs off');
	assert.equal(second.total, 16);
	assert.ok(calls.some(id => Number(id.slice(-3)) >= 24), 'the playable suffix must receive verification work');
	const callsAfterSecond = calls.length;
	const third = await lib.list({ type: 'tvshows', sort: 'az', start: 0 });
	assert.equal(third.items.length, 16);
	assert.equal(calls.length, callsAfterSecond, 'repeated lists must not keep retrying backed-off or pending prefixes');
});

test('a long cached-empty prefix cannot permanently starve a later playable page', async t => {
	const directory = await mkdtemp(path.join(os.tmpdir(), 'playable-117-prefix-'));
	const file = path.join(directory, 'catalogue.json');
	await writeFile(file, JSON.stringify({ items: [], time: NOW }));
	const local = Array.from({ length: 100 }, (_, index) => ({
		Id: `prefix-${String(index).padStart(3, '0')}`,
		Name: (index < 84 ? 'AAAA Empty ' : 'ZZZZ Playable ') + String(index).padStart(3, '0'),
		Type: 'Series', ChildCount: 2, ProviderIds: { Tmdb: String(9000 + index) }, DateCreated: new Date(NOW + index * 1000).toISOString()
	}));
	const entries = local.slice(0, 84).map(item => savedEmpty({ ...item, Source: 'local', VodIds: [] }));
	await writeFile(file + '.series.json', JSON.stringify({ version: 1, updated: NOW, entries }));
	const localCalls = [];
	const lib = createVodLibrary({ file, clock: () => NOW, dispatcharr: { status: () => ({ connected: false }), api: async () => [] },
		localItems: async () => local, localItem: async id => local.find(item => item.Id === id) || null,
		localEpisodes: async id => {
			localCalls.push(id);
			const index = Number(id.slice(-3));
			return index >= 84 ? [{ Id: 'episode-' + id, Name: 'Episode', Type: 'Episode', ParentIndexNumber: 1, IndexNumber: 1, PremiereDate: '2020-01-01' }] : [];
		} });
	t.after(async () => { await lib.flushIndex(); await rm(directory, { recursive: true, force: true }); });

	const first = await lib.list({ type: 'tvshows', sort: 'az', start: 0 });
	assert.equal(first.items.length, 16, 'the first page scans past the cached-empty prefix to playable titles');
	assert.equal(first.total, 16);
	assert.equal(first.availability.pending, 0);
	assert.equal(first.availability.queued, 0);
	assert.ok(first.availability.checked > 0);
	assert.ok(localCalls.every(id => Number(id.slice(-3)) >= 84), 'only the unknown suffix is verified');
	const before = localCalls.length;
	const second = await lib.list({ type: 'tvshows', sort: 'az', start: 0 });
	assert.equal(second.items.length, 16, 'the page remains populated after the verification cache is warm');
	assert.equal(second.total, 16);
	assert.equal(localCalls.length, before, 'warm playable titles are not rechecked on every request');
});
