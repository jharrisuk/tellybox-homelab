/* Release 133: the provider ID map is reused per catalogue generation and is
 * rebuilt after a real catalogue refresh. No provider request is made. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createVodLibrary } from '../vod-library.mjs';

test('availability reuses one provider map and invalidates it after refresh', async t => {
	const directory = mkdtempSync(path.join(tmpdir(), 'tellybox-catalogue-index-'));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const file = path.join(directory, 'catalogue.json');
	const now = () => 1_800_000_000_000;
	const row = id => ({ Id: 'vod-' + id, Name: 'Title ' + id, Type: 'Movie', Source: 'streamed', ProviderIds: { Tmdb: String(id) } });
	writeFileSync(file, JSON.stringify({ items: [row(1)], time: now() }));
	let apiCalls = 0;
	const dispatcharr = {
		status: () => ({ connected: true }),
		api: async () => { apiCalls++; return [{ id: 2, name: 'Title 2', tmdb_id: 2 }]; }
	};
	const library = createVodLibrary({
		dispatcharr, localItems: async () => [], localItem: async () => null, localEpisodes: async () => [],
		file, linksFile: path.join(directory, 'links.json'), metadata: null, clock: now,
		indexFile: path.join(directory, 'index.json')
	});
	assert.equal((await library.all({ refresh: false })).length, 1);
	const one = await library.availability([{ id: 1, type: 'movie' }]);
	assert.equal(one[0].vodAvailable, true);
	await library.availability([{ id: 1, type: 'movie' }]);
	assert.equal(apiCalls, 0, 'a cached provider map causes no catalogue call');

	await library.refresh();
	assert.equal(apiCalls, 2, 'one page per catalogue kind is read');
	const old = await library.availability([{ id: 1, type: 'movie' }]);
	const next = await library.availability([{ id: 2, type: 'movie' }]);
	assert.equal(old[0].vodAvailable, undefined, 'removed catalogue IDs are not served from the old map');
	assert.equal(next[0].vodAvailable, true, 'the new generation is mapped');
});
