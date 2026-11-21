import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createVodLibrary, vodView } from '../vod-library.mjs';

const NOW = Date.parse('2026-11-12T00:00:00Z');
const torrentday = { m3u_account: { name: 'TorrentDay VOD (Merger)', priority: 5, is_active: true } };

async function paginatedFixture(t, { movies = 0, series = 0, pageSize = 100 } = {}) {
	const directory = await mkdtemp(path.join(os.tmpdir(), 'consolidation-121-td-pages-'));
	const file = path.join(directory, 'catalogue.json');
	const requests = [];
	const pages = (kind, total) => {
		const rows = [];
		for (let i = 0; i < total; i++) rows.push({ id: i + 1, name: `${kind} ${i + 1} (2025)`, tmdb_id: 90000 + i, providers: [torrentday] });
		const list = [];
		for (let start = 0; start < rows.length; start += pageSize) {
			const slice = rows.slice(start, start + pageSize);
			list.push({ results: slice, next: start + pageSize < rows.length ? `/api/vod/${kind}/?page_size=${pageSize}&page=${list.length + 2}&ordering=id` : null });
		}
		return list;
	};
	const moviePages = pages('movies', movies);
	const seriesPages = pages('series', series);
	const dispatcharr = {
		status: () => ({ connected: true }),
		api: async route => {
			requests.push(route);
			const movie = /^\/api\/vod\/movies\/\?page_size=(\d+)&page=(\d+)&ordering=id$/.exec(route);
			if (movie) return moviePages[Number(movie[2]) - 1] || { results: [], next: null };
			const show = /^\/api\/vod\/series\/\?page_size=(\d+)&page=(\d+)&ordering=id$/.exec(route);
			if (show) return seriesPages[Number(show[2]) - 1] || { results: [], next: null };
			return { results: [], next: null };
		}
	};
	const lib = createVodLibrary({ dispatcharr, file, clock: () => NOW, localItems: async () => [], localItem: async () => null, localEpisodes: async () => [] });
	await lib.refresh();
	t.after(async () => { await lib.flushIndex(); await rm(directory, { recursive: true, force: true }); });
	return { lib, requests, directory, file };
}

test('catalogue refresh walks every provider page with the Dispatcharr page size and ordering', async t => {
	const { lib, requests } = await paginatedFixture(t, { movies: 260, series: 140 });
	assert.equal(lib.status().indexed, 400, 'all movie and series rows land in the catalogue');
	assert.deepEqual(requests.slice(0, 4), [
		'/api/vod/movies/?page_size=100&page=1&ordering=id',
		'/api/vod/movies/?page_size=100&page=2&ordering=id',
		'/api/vod/movies/?page_size=100&page=3&ordering=id',
		'/api/vod/series/?page_size=100&page=1&ordering=id'
	], 'pagination uses page_size 100 and stable ordering, and stops when next is absent');
	assert.equal(requests.filter(r => r.includes('/movies/')).length, 3);
	assert.equal(requests.filter(r => r.includes('/series/')).length, 2);
});

test('browse pagination returns full 60-item pages, real hasMore and no truncation at the end', async t => {
	const { lib } = await paginatedFixture(t, { movies: 260 });
	const first = await lib.list({ type: 'movies', start: 0 });
	assert.equal(first.items.length, 60);
	assert.equal(first.hasMore, true);
	const second = await lib.list({ type: 'movies', start: 60 });
	assert.equal(second.items.length, 60);
	const fourth = await lib.list({ type: 'movies', start: 180 });
	assert.equal(fourth.items.length, 60);
	const last = await lib.list({ type: 'movies', start: 240 });
	assert.equal(last.items.length, 20, 'the final page holds the remainder');
	assert.equal(last.hasMore, false);
	assert.equal(last.total, 260);
	// Page content never overlaps: each of the 260 ids appears exactly once across the walk.
	const seen = new Set();
	let start = 0, hasMore = true, rounds = 0;
	while (hasMore && rounds < 10) {
		const page = await lib.list({ type: 'movies', start });
		for (const item of page.items) assert.ok(!seen.has(item.Id), `duplicate id ${item.Id} on page start=${start}`);
		for (const item of page.items) seen.add(item.Id);
		hasMore = page.hasMore;
		start += page.items.length;
		rounds++;
	}
	assert.equal(seen.size, 260, 'a full walk sees every streamed movie exactly once');
});

test('series browse pages stay verified-available and report unknown series beyond the page', async t => {
	const { lib } = await paginatedFixture(t, { series: 60 });
	// None of the series has a saved episode list, so the first page must
	// verify instead of advertising titles that may be empty.
	const first = await lib.list({ type: 'tvshows', start: 0 });
	assert.equal(first.items.length, 0, 'unverified series are not shown as playable');
	assert.ok(first.hasMore || first.availability.pending > 0, 'unknown series are either pending verification or reported as more pages');
});

test('a huge provider catalogue stops at the safety bound instead of looping forever', async t => {
	const directory = await mkdtemp(path.join(os.tmpdir(), 'consolidation-121-td-bound-'));
	const file = path.join(directory, 'catalogue.json');
	const dispatcharr = {
		status: () => ({ connected: true }),
		api: async () => ({ results: [{ id: 1, name: 'One (2025)' }], next: '/api/vod/movies/?page_size=100&page=2&ordering=id' })
	};
	const lib = createVodLibrary({ dispatcharr, file, clock: () => NOW, localItems: async () => [], localItem: async () => null, localEpisodes: async () => [] });
	await lib.refresh();
	t.after(async () => { await lib.flushIndex(); await rm(directory, { recursive: true, force: true }); });
	assert.equal(lib.status().indexed, 0, 'an endless next link must not produce an unbounded loop');
	assert.match(lib.status().error, /could not be refreshed/);
});

test('an array catalogue response without next links still indexes and paginates', async t => {
	const directory = await mkdtemp(path.join(os.tmpdir(), 'consolidation-121-td-array-'));
	const file = path.join(directory, 'catalogue.json');
	const rows = Array.from({ length: 3 }, (_, i) => ({ id: i + 1, name: `Plain ${i + 1} (2024)`, tmdb_id: 91000 + i, providers: [torrentday] }));
	const dispatcharr = { status: () => ({ connected: true }), api: async route => route.includes('/movies/') ? rows : [] };
	const lib = createVodLibrary({ dispatcharr, file, clock: () => NOW, localItems: async () => [], localItem: async () => null, localEpisodes: async () => [] });
	await lib.refresh();
	t.after(async () => { await lib.flushIndex(); await rm(directory, { recursive: true, force: true }); });
	assert.equal(lib.status().indexed, 3);
	const page = await lib.list({ type: 'movies' });
	assert.equal(page.items.length, 3);
	assert.equal(page.items[0].Provider, 'TorrentDay VOD (Merger)');
	assert.equal(page.hasMore, false);
});
