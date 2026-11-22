import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createJellyfinAdmin } from '../jellyfin-admin.mjs';

const ID = '0123456789abcdef0123456789abcdef';
const SERIES_ID = 'fedcba9876543210fedcba9876543210';
const MOVIE_ID = '11111111111111111111111111111111';
const EPISODE_ID = '22222222222222222222222222222222';

function fixture({ key = 'admin-key', items = {}, episodes = {} } = {}) {
	const directory = mkdtempSync(path.join(tmpdir(), 'tellybox-purge-'));
	const configPath = path.join(directory, 'configuration.json');
	writeFileSync(configPath, JSON.stringify({ jellyfin: { enabled: true, url: 'http://jellyfin.test', key } }), 'utf8');
	const calls = [];
	const fetcher = async (url, options = {}) => {
		const parsed = new URL(url);
		calls.push({ path: parsed.pathname, search: parsed.search, method: options.method || 'GET' });
		if (options.method === 'DELETE') return new Response(null, { status: 204 });
		if (parsed.pathname === '/Items') {
			const id = parsed.searchParams.get('Ids') || '';
			const item = items[id];
			return item ? Response.json({ Items: [item] }) : new Response('missing', { status: 404 });
		}
		if (/^\/Shows\/[^/]+\/Episodes$/.test(parsed.pathname)) {
			const seriesId = parsed.pathname.split('/')[2];
			const season = parsed.searchParams.get('season');
			const rows = (episodes[seriesId] || []).filter(row => !season || String(row.ParentIndexNumber) === season);
			return Response.json({ Items: rows });
		}
		return new Response('unexpected', { status: 404 });
	};
	const admin = createJellyfinAdmin({ configPath, fetcher, clock: () => 1000 });
	return { admin, calls };
}

test('a film preview and delete use the Jellyfin admin key and delete file contents', async () => {
	const { admin, calls } = fixture({ items: { [MOVIE_ID]: { Id: MOVIE_ID, Name: 'A film', Type: 'Movie', Path: '/media/films/a.mkv', MediaSources: [{ Size: 2048 }] } } });
	const preview = await admin.preview(MOVIE_ID);
	assert.equal(preview.type, 'Movie');
	assert.equal(preview.count, 1);
	assert.equal(preview.bytes, 2048);
	await admin.remove(MOVIE_ID);
	const removal = calls.find(call => call.method === 'DELETE');
	assert.equal(removal.path, '/Items/' + MOVIE_ID);
	assert.match(removal.search, /DeleteFileContents=true/);
});

test('a series preview counts its local episodes and deletion cascades through the series id', async () => {
	const { admin, calls } = fixture({
		items: { [SERIES_ID]: { Id: SERIES_ID, Name: 'A series', Type: 'Series' } },
		episodes: { [SERIES_ID]: [
			{ Id: EPISODE_ID, Name: 'One', ParentIndexNumber: 1, IndexNumber: 1, Path: '/media/tv/a/s01e01.mkv', MediaSources: [{ Size: 100 }] },
			{ Id: '33333333333333333333333333333333', Name: 'Two', ParentIndexNumber: 1, IndexNumber: 2, Path: '/media/tv/a/s01e02.mkv', MediaSources: [{ Size: 200 }] },
			{ Id: '44444444444444444444444444444444', Name: 'Unaired', ParentIndexNumber: 2, IndexNumber: 1 }
		] }
	});
	const preview = await admin.preview(SERIES_ID);
	assert.equal(preview.count, 2, 'only episodes with local files count');
	assert.equal(preview.bytes, 300);
	await admin.remove(SERIES_ID);
	assert.ok(calls.some(call => call.method === 'DELETE' && call.path === '/Items/' + SERIES_ID));
});

test('a season preview asks Jellyfin for that season only', async () => {
	const { admin, calls } = fixture({
		items: { [ID]: { Id: ID, Name: 'Season 2', Type: 'Season', SeriesId: SERIES_ID, IndexNumber: 2 } },
		episodes: { [SERIES_ID]: [
			{ Id: EPISODE_ID, Name: 'S1', ParentIndexNumber: 1, IndexNumber: 1, Path: '/media/s1e1.mkv' },
			{ Id: '55555555555555555555555555555555', Name: 'S2', ParentIndexNumber: 2, IndexNumber: 1, Path: '/media/s2e1.mkv' }
		] }
	});
	const preview = await admin.preview(ID);
	assert.equal(preview.count, 1);
	assert.ok(calls.some(call => call.path.endsWith('/Episodes') && call.search.includes('season=2')));
});

test('a non-local or pathless title is refused before any delete request', async () => {
	const { admin, calls } = fixture({ items: {
		[MOVIE_ID]: { Id: MOVIE_ID, Name: 'Streamed', Type: 'Movie', Path: 'https://provider.example/movie.mkv' },
		[ID]: { Id: ID, Name: 'No file', Type: 'Episode' }
	} });
	await assert.rejects(() => admin.preview(MOVIE_ID), /not be deleted here/);
	await assert.rejects(() => admin.preview(ID), /No local files/);
	assert.equal(calls.some(call => call.method === 'DELETE'), false);
});

test('a missing administrator key fails closed', async () => {
	const { admin } = fixture({ key: '' });
	await assert.rejects(() => admin.preview(MOVIE_ID), /administrator API key/);
	assert.equal(admin.configured(), false);
});
