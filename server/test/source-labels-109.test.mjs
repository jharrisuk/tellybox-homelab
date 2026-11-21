import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createVodLibrary, providerLabel, selectProvider, vodView } from '../vod-library.mjs';

const account = (name, priority, active = true, id = 0) => ({ id, m3u_account: { name, priority, is_active: active } });

test('provider selection uses the actual active upstream account by priority', () => {
	assert.equal(providerLabel([account('Digital (Maxiumus)', 20, true, 2), account('TorrentDay VOD (Merger)', 5, true, 1)]), 'Digital (Maxiumus)');
	assert.equal(providerLabel([account('TorrentDay VOD (Merger)', 5)]), 'TorrentDay VOD (Merger)');
	assert.equal(providerLabel([account('Disabled', 99, false), account('TorrentDay VOD (Merger)', 5)]), 'TorrentDay VOD (Merger)');
	assert.equal(providerLabel([account('Second', 5, true, 20), account('First', 5, true, 10)]), 'First', 'equal priority uses the lower Dispatcharr relation id');
	assert.equal(providerLabel([]), '');
	assert.equal(providerLabel(null), '');
	assert.equal(selectProvider([account('A', 1)]).m3u_account.name, 'A');
});

test('vodView keeps movie, series and episode fixtures honest with the exact Dispatcharr fallback', () => {
	const movie = vodView({ id: 1, name: 'A film', providers: [account('TorrentDay VOD (Merger)', 5)] }, 'Movie');
	assert.equal(movie.Source, 'streamed');
	assert.equal(movie.Provider, 'TorrentDay VOD (Merger)');
	const series = vodView({ id: 2, name: 'A series', providers: [account('Digital (Maxiumus)', 20)] }, 'Series');
	assert.equal(series.Provider, 'Digital (Maxiumus)');
	const episode = vodView({ id: 3, name: 'A series S01E01', series: { id: 2 }, providers: [account('TorrentDay VOD (Merger)', 5)] }, 'Episode');
	assert.equal(episode.Provider, 'TorrentDay VOD (Merger)');
	const unknown = vodView({ id: 4, name: 'No provider' }, 'Movie');
	assert.equal(unknown.Source, 'streamed');
	assert.equal(unknown.Provider, 'Dispatcharr');
});

test('a legacy Dispatcharr catalogue entry keeps the requested fallback in lists', async () => {
	const directory = mkdtempSync(path.join(os.tmpdir(), 'source-labels-'));
	const file = path.join(directory, 'vod-catalogue.json');
	try {
		writeFileSync(file, JSON.stringify({ items: [
			{ Id: 'dispatch-movie-1', Name: 'Legacy film', Type: 'Movie', Source: 'streamed', Provider: 'Dispatcharr', Genres: ['Drama'] },
			{ Id: 'dispatch-series-2', Name: 'Legacy series', Type: 'Series', Source: 'streamed', Provider: 'Dispatcharr', Genres: ['Drama'] }
		], time: Date.now() }));
		const dispatcharr = { status: () => ({ connected: true }), api: async () => [] };
		const library = createVodLibrary({ dispatcharr, localItems: async () => [], localItem: async () => { throw new Error('unused'); },
			localEpisodes: async () => [], file, linksFile: '', metadata: null });
		const list = await library.list({ type: 'movies' });
		assert.equal(list.items[0].Id, 'dispatch-movie-1');
		assert.equal(list.items[0].Provider, 'Dispatcharr');
		assert.equal(list.items[0].Source, 'streamed');
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test('web source labels use a known provider and the exact Dispatcharr fallback', () => {
	const context = {};
	vm.runInNewContext(requireText('../public/source-label.js'), context);
	const label = context.TellyboxSourceLabel;
	assert.equal(label.streamed({ Provider: 'TorrentDay VOD (Merger)' }), 'Streamed \u00b7 TorrentDay VOD (Merger)');
	assert.equal(label.streamed({ Provider: 'Dispatcharr' }), 'Streamed \u00b7 Dispatcharr');
	assert.equal(label.streamed({}), 'Streamed \u00b7 Dispatcharr');
	assert.equal(label.streamNow({ Provider: 'Digital (Maxiumus)' }), 'Stream now \u00b7 Digital (Maxiumus)');
	assert.equal(label.streamNow({ Provider: '', vodProvider: 'Digital (Maxiumus)' }), 'Stream now \u00b7 Digital (Maxiumus)');
	assert.equal(label.streamNow({ Provider: 'Dispatcharr', vodProvider: 'Digital (Maxiumus)' }), 'Stream now \u00b7 Digital (Maxiumus)');
	assert.equal(label.streamNow({}), 'Stream now \u00b7 Dispatcharr');
	assert.equal(label.available({ Provider: 'TorrentDay VOD (Merger)' }), 'Available through TorrentDay VOD (Merger).');
	assert.equal(label.available({}), 'Available through Dispatcharr.');
});

test('all web surfaces load the shared label and never hardcode the transport as a provider', () => {
	const app = requireText('../public/app.js');
	const search = requireText('../public/search.js');
	const discover = requireText('../public/discover.js');
	assert.match(app, /sourceLabel\.streamed\(item\)/);
	assert.match(search, /sourceLabel\.streamNow\(item\)/);
	assert.match(discover, /sourceLabel\.streamNow\(item\)/);
	assert.doesNotMatch(app, /\(item\.Provider \|\| 'Dispatcharr'\)/);
	assert.doesNotMatch(search, /'Stream now[^']*Dispatcharr'/);
	assert.doesNotMatch(discover, /'Stream now[^']*Dispatcharr'/);
	for (const page of ['index.html', 'search.html', 'discover.html']) {
		assert.match(requireText('../public/' + page), /source-label\.js/);
	}
});

function requireText(relative) {
	return readFileSync(new URL(relative, import.meta.url), 'utf8');
}
