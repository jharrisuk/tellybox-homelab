import test from 'node:test';
import assert from 'node:assert/strict';
import { createDispatcharr } from '../dispatcharr.mjs';
import { providerLabel, selectProvider, vodView } from '../vod-library.mjs';

const account = (name, priority, active = true, id = 0) => ({ id, m3u_account: { name, priority, is_active: active } });
const torrentday = (priority = 5, id = 7) => account('TorrentDay VOD (Merger)', priority, true, id);
const other = (priority = 20, id = 3) => account('Other account', priority, true, id);

test('TorrentDay provider identity survives movie, series and episode mapping', () => {
	const movie = vodView({ id: 41, name: 'A TorrentDay film (2025)', providers: [torrentday()] }, 'Movie');
	assert.equal(movie.Provider, 'TorrentDay VOD (Merger)');
	assert.equal(movie.Source, 'streamed');
	const series = vodView({ id: 42, name: 'A TorrentDay series', providers: [torrentday(5, 9)] }, 'Series');
	assert.equal(series.Provider, 'TorrentDay VOD (Merger)');
	const episode = vodView({ id: 43, name: 'A TorrentDay series S01E01', series: { id: 42 }, providers: [torrentday()], season_number: 1, episode_number: 1 }, 'Episode');
	assert.equal(episode.Provider, 'TorrentDay VOD (Merger)');
	assert.equal(episode.ParentIndexNumber, 1);
	assert.equal(episode.IndexNumber, 1);
	const unknown = vodView({ id: 44, name: 'No provider row' }, 'Movie');
	assert.equal(unknown.Provider, 'Dispatcharr', 'a list row without providers keeps the exact Dispatcharr fallback');
});

test('provider selection keeps the active highest-priority account and its stream option', () => {
	const records = [
		{ ...torrentday(5, 7), stream_id: '555' },
		{ ...other(20, 3), stream_id: '999' },
		{ ...account('Disabled', 99, false, 1), stream_id: '111' }
	];
	const chosen = selectProvider(records);
	assert.equal(chosen.m3u_account.name, 'Other account');
	assert.equal(chosen.stream_id, '999');
	assert.equal(providerLabel([torrentday(5, 7)]), 'TorrentDay VOD (Merger)');
	assert.equal(providerLabel([torrentday(5, 7), torrentday(5, 2)]), 'TorrentDay VOD (Merger)', 'duplicate rows for one account are harmless');
});

test('stream requests carry the selected m3u account and stream id without leaking credentials', async () => {
	const origin = 'http://dispatch.test:9191';
	const seen = [];
	const fetcher = async (url, options) => {
		seen.push({ url: String(url), options });
		return new Response('', { status: 200 });
	};
	const client = createDispatcharr({ file: 'unused-never-written', origin, fetcher });
	const movie = { type: 'movie', uuid: '11111111-1111-1111-1111-111111111111', account: 7, streamId: '555' };
	await client.stream(movie);
	assert.equal(seen.length, 1);
	const url = new URL(seen[0].url);
	assert.equal(url.pathname, '/proxy/vod/movie/11111111-1111-1111-1111-111111111111');
	assert.equal(url.searchParams.get('m3u_account_id'), '7');
	assert.equal(url.searchParams.get('stream_id'), '555');
	assert.equal(seen[0].options.headers['User-Agent'], 'Tellybox');
	assert.ok(!JSON.stringify(seen).includes('secret'), 'no credential text enters the request');
	const episode = { type: 'episode', uuid: '22222222-2222-2222-2222-222222222222' };
	await client.stream(episode);
	assert.equal(new URL(seen[1].url).searchParams.get('m3u_account_id'), null, 'episodes ride the uuid route without account pinning');
	await assert.rejects(() => client.stream({ type: 'movie', uuid: 'not-a-uuid' }), /Invalid streamed title/);
	await assert.rejects(() => client.stream({ type: 'series', uuid: '11111111-1111-1111-1111-111111111111' }), /Invalid streamed title/);
});

test('same-prefix redirects are followed and cross-provider redirects are refused', async () => {
	const origin = 'http://dispatch.test:9191';
	const uuid = '33333333-3333-3333-3333-333333333333';
	const prefix = `/proxy/vod/movie/${uuid}`;
	const calls = [];
	const fetcher = async url => {
		calls.push(String(url));
		if (calls.length === 1) return new Response('', { status: 302, headers: { location: origin + prefix + '/session' } });
		return new Response('stream', { status: 200 });
	};
	const client = createDispatcharr({ file: 'unused', origin, fetcher });
	assert.equal((await client.stream({ type: 'movie', uuid })).status, 200);
	assert.equal(calls.length, 2);
	const redirecting = createDispatcharr({
		file: 'unused', origin,
		fetcher: async () => new Response('', { status: 302, headers: { location: 'https://provider.example/media' } })
	});
	await assert.rejects(() => redirecting.stream({ type: 'movie', uuid }), /proxy VOD streams rather than redirecting/);
});
