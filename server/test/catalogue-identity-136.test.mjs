import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createDispatcharr} from '../dispatcharr.mjs';
import {createVodLibrary, vodView} from '../vod-library.mjs';
import {createHomeEpisodeLookup} from '../home-episodes.mjs';

const NOW = Date.parse('2026-11-19T00:00:00Z');
const CANONICAL = 18055;
const RELATION = 19172;

function canonicalSeriesRow(overrides = {}) {
	return {
		id: CANONICAL,
		name: 'The Horne Section TV Show',
		year: 2022,
		tmdb_id: 158001,
		providers: [{
			// Dispatcharr's M3U series relation owns this id in a separate sequence.
			id: RELATION,
			stream_id: 'relation-stream-19172',
			series: {id: CANONICAL, name: 'The Horne Section TV Show'},
			m3u_account: {id: 12, name: 'TorrentDay VOD (Merger)', priority: 5, is_active: true}
		}],
		...overrides
	};
}

test('a provider relation id is never emitted as a series content id or VodIds entry', () => {
	const view = vodView(canonicalSeriesRow(), 'Series');
	assert.ok(view, 'a canonical row resolves');
	assert.equal(view.Id, `dispatch-series-${CANONICAL}`, 'the top-level canonical id owns the content id');
	assert.deepEqual(view.VodIds, [CANONICAL]);
	assert.equal(view.Provider, 'TorrentDay VOD (Merger)', 'the relation row still labels the provider');
	assert.doesNotMatch(JSON.stringify(view), new RegExp(String(RELATION)), 'the relation id is not copied into any content field');

	// Same provider relation, different canonical row: the content id follows the
	// top-level canonical id and never the relation id.
	const other = vodView(canonicalSeriesRow({id: CANONICAL + 1, name: 'Another show'}), 'Series');
	assert.equal(other.Id, `dispatch-series-${CANONICAL + 1}`);
	assert.ok(!other.VodIds.includes(RELATION));

	// The same contract applies to movies.
	const movie = {id: 9001, name: 'A film', providers: [{id: 70000, movie: {id: 9001}}]};
	const movieView = vodView(movie, 'Movie');
	assert.equal(movieView.Id, 'dispatch-movie-9001');
	assert.deepEqual(movieView.VodIds, [9001]);
	assert.doesNotMatch(JSON.stringify(movieView), /70000/);
});

test('route: a canonical series resolves, a relation id 404s without any fallback, and a missing id 404s', async t => {
	const directory = await mkdtemp(path.join(os.tmpdir(), 'catalogue-identity-'));
	const hits = [];
	const server = createServer((request, response) => {
		const url = new URL(request.url, 'http://127.0.0.1');
		hits.push(url.pathname);
		const send = (status, body) => {
			response.writeHead(status, {'Content-Type': 'application/json'});
			response.end(JSON.stringify(body));
		};
		if (url.pathname === '/api/vod/movies/') return send(200, {results: [], next: null});
		if (url.pathname === '/api/vod/series/') return send(200, {results: [canonicalSeriesRow()], next: null});
		if (url.pathname === `/api/vod/series/${CANONICAL}/`) return send(200, canonicalSeriesRow());
		if (url.pathname === `/api/vod/series/${CANONICAL}/provider-info/`) return send(200, {});
		if (url.pathname === `/api/vod/series/${CANONICAL}/episodes/`) {
			return send(200, [{id: 27414, name: 'Episode one', series: {id: CANONICAL, name: 'The Horne Section TV Show'}, season_number: 1, episode_number: 1}]);
		}
		// A relation id is not a canonical detail route in Dispatcharr. It must
		// never be redirected by Tellybox to the related series or /providers/.
		return send(404, {detail: 'Not found.'});
	});
	await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
	t.after(async () => {
		await new Promise(resolve => server.close(resolve));
		await rm(directory, {recursive: true, force: true});
	});
	const origin = `http://127.0.0.1:${server.address().port}`;
	const config = path.join(directory, 'dispatcharr.json');
	await writeFile(config, JSON.stringify({key: 'identity-test-key'}));
	const dispatcharr = createDispatcharr({file: config, origin});
	const library = createVodLibrary({
		dispatcharr,
		file: path.join(directory, 'vod.json'),
		clock: () => NOW,
		localItems: async () => [],
		localItem: async () => null,
		localEpisodes: async () => []
	});
	await library.refresh();

	// The browse payload carries only the canonical id, even though the provider
	// relation id is present in the same row.
	const all = await library.all();
	assert.deepEqual(all.filter(item => item.Type === 'Series').map(item => item.Id), [`dispatch-series-${CANONICAL}`]);
	assert.ok(!JSON.stringify(all).includes(String(RELATION)), 'a relation id never reaches the browse payload');

	const canonical = await library.item(`dispatch-series-${CANONICAL}`);
	assert.equal(canonical.Id, `dispatch-series-${CANONICAL}`);
	assert.deepEqual(canonical.VodIds, [CANONICAL]);

	const episodes = await library.episodes(`dispatch-series-${CANONICAL}`);
	assert.equal(episodes.items.length, 1);
	assert.equal(episodes.items[0].Id, `dispatch-episode-27414-${CANONICAL}`);
	assert.equal(episodes.items[0].SeriesId, `dispatch-series-${CANONICAL}`);
	assert.deepEqual(episodes.items[0].VodIds, [27414]);

	// Stale relation/history id: exactly one detail request, clean 404, no
	// relation lookup and no numeric substitution of the canonical id.
	let mark = hits.length;
	await assert.rejects(
		() => library.item(`dispatch-series-${RELATION}`),
		error => error.status === 404 && /no longer available/i.test(error.message)
	);
	assert.deepEqual(hits.slice(mark), [`/api/vod/series/${RELATION}/`], 'the relation id is never mapped or probed for providers');

	// A genuinely missing id has the same fail-closed shape.
	mark = hits.length;
	await assert.rejects(
		() => library.item('dispatch-series-999999'),
		error => error.status === 404 && /no longer available/i.test(error.message)
	);
	assert.deepEqual(hits.slice(mark), ['/api/vod/series/999999/']);

	// The canonical id still works after the stale id failed.
	const again = await library.item(`dispatch-series-${CANONICAL}`);
	assert.equal(again.Id, `dispatch-series-${CANONICAL}`);
});

test('the Home episode route never translates a stale series id', async () => {
	const calls = [];
	const lookup = createHomeEpisodeLookup({
		jelly: async () => { throw Error('Jellyfin must not be called for a streamed id'); },
		userId: 'test-user',
		library: {
			episodes: async id => {
				calls.push(id);
				if (id === `dispatch-series-${RELATION}`) {
					throw Object.assign(Error('This title is no longer available.'), {status: 404});
				}
				return {items: [{
					Id: `dispatch-episode-27414-${CANONICAL}`,
					Name: 'Episode one',
					Type: 'Episode',
					SeriesId: `dispatch-series-${CANONICAL}`,
					SeriesName: 'The Horne Section TV Show',
					ParentIndexNumber: 1,
					IndexNumber: 1,
					PremiereDate: '2026-01-01'
				}]};
			}
		}
	});
	const stale = await lookup([`dispatch-series-${RELATION}`], {deadline: Date.now() + 2000});
	assert.deepEqual(stale, [], 'a stale id yields no episodes, not another show');
	assert.deepEqual(calls, [`dispatch-series-${RELATION}`], 'the route never probes the canonical id for a stale one');

	const canonical = await lookup([`dispatch-series-${CANONICAL}`], {deadline: Date.now() + 2000});
	assert.equal(canonical.length, 1);
	assert.equal(canonical[0].SeriesId, `dispatch-series-${CANONICAL}`);
	assert.deepEqual(calls, [`dispatch-series-${RELATION}`, `dispatch-series-${CANONICAL}`]);
});
