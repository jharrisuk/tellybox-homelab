import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createVodLibrary } from '../vod-library.mjs';

const genres = ['Drama', 'Comedy', 'Action', 'Documentary', 'Crime', 'Family', 'Horror', 'Romance'];
const catalogue = (count = 45000) => Array.from({ length: count }, (_, index) => ({
	Id: 'local-' + index,
	Name: 'Title ' + String(index).padStart(5, '0'),
	Type: 'Movie',
	Genres: [genres[index % genres.length], 'Drama'].filter((value, at, all) => all.indexOf(value) === at),
	PremiereDate: `${1980 + (index % 47)}-01-01`,
	CommunityRating: (index % 90) / 10 + 1,
	Overview: 'long provider synopsis '.repeat(400),
	UserData: { Played: true, PlaybackPositionTicks: 123456789, IsFavorite: true },
	Played: true,
	Source: 'local'
}));

async function library(t, items) {
	const directory = await mkdtemp(path.join(os.tmpdir(), 'recommendation-pool-'));
	t.after(() => rm(directory, { recursive: true, force: true }));
	return createVodLibrary({
		file: path.join(directory, 'cache.json'),
		dispatcharr: { status: () => ({ connected: false }) },
		localItems: async () => items
	});
}

test('the app recommendation pool is broad, bounded, slim and deterministic', async t => {
	const lib = await library(t, catalogue());
	const first = await lib.recommendationPool('Movie', 600);
	const same = await lib.recommendationPool('Movie', 600);
	assert.equal(first.length, 600);
	assert.deepEqual(first.map(item => item.Id), same.map(item => item.Id), 'same catalogue returns the same pool');
	assert.equal(new Set(first.map(item => item.Id)).size, first.length, 'no duplicate titles');
	assert.ok(first.slice(0, 800).every(item => item.Overview === undefined), 'overview is stripped from the phone payload');
	assert.ok(first.every(item => item.UserData === undefined && item.Played === undefined), 'shared playback state never reaches the app pool');
	assert.ok(new Set(first.slice(0, 64).map(item => item.Genres[0])).size >= 6, 'the pool is not one genre or the newest titles only');
	assert.ok(first.some(item => item.PremiereDate < '2000-01-01'), 'older catalogue titles are reachable');
});

test('policy filtering happens before the balanced sample so narrow viewers are not starved', async t => {
	const lib = await library(t, catalogue());
	const docs = await lib.recommendationPool('Movie', 600, { allowed: item => item.Genres.includes('Documentary') });
	assert.equal(docs.length, 600);
	assert.ok(docs.every(item => item.Genres.includes('Documentary')), 'only permitted titles are sampled');
	const narrow = await lib.recommendationPool('Movie', 600, { allowed: item => item.Genres.includes('Documentary') && Number(item.Id.slice(6)) < 200 });
	assert.equal(narrow.length, 25, 'a small permitted set is returned in full rather than diluted by hidden titles');
});

test('recommendation pool caps and empty catalogues stay safe', async t => {
	const empty = await library(t, []);
	assert.deepEqual(await empty.recommendationPool('Movie', 600), []);
	const lib = await library(t, catalogue(20));
	const pool = await lib.recommendationPool('Movie', 5000);
	assert.equal(pool.length, 20);
	assert.equal((await lib.recommendationPool('Movie', 0)).length, 1);
	assert.deepEqual(await lib.recommendationPool('Series', 600), []);
});
