import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';

test('live playback resolves placeholder metadata, preserves track choices, streams HLS and closes the tuner', async t => {
	const directory = mkdtempSync(path.join(tmpdir(), 'jserver-live-playback-'));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const id = 'a'.repeat(32);
	const sourceId = 'native_real_tuner_source';
	const upstream = express(); upstream.use(express.json());
	const selected = [], closed = [];
	let lookups = 0;
	let missingOutput = false;
	upstream.get('/Users/test/Items/:id', (req, res) => res.json({ Id: id, Name: 'Test channel', Type: 'TvChannel', MediaType: 'Video',
		MediaSources: [{ Id: id, Type: 'Placeholder', MediaStreams: [] }] }));
	upstream.get('/Items/:id/PlaybackInfo', (req, res) => {
		lookups++;
		res.json({ MediaSources: [{ Id: sourceId, Type: 'Default', RequiresOpening: true,
			MediaStreams: [{ Type: 'Subtitle', Index: 2, Language: 'eng' }] }] });
	});
	upstream.post('/Items/:id/PlaybackInfo', (req, res) => {
		selected.push(req.body);
		if (req.body.MediaSourceId !== sourceId) return res.json({ ErrorCode: 'NoCompatibleStream', MediaSources: [] });
		res.json({ PlaySessionId: 'test-play', MediaSources: [{ Id: sourceId, LiveStreamId: 'tuner/with+special&characters',
			...(missingOutput ? {} : { TranscodingUrl: `/Videos/${id}/master.m3u8?api_key=secret` }),
			MediaStreams: [{ Type: 'Audio', Index: 1, Language: 'English' }, { Type: 'Subtitle', Index: 2, Language: 'English' }] }] });
	});
	upstream.get('/Videos/:id/master.m3u8', (req, res) => res.type('application/vnd.apple.mpegurl').send('#EXTM3U\n#EXTINF:6,\nsegment.ts\n'));
	upstream.get('/Videos/:id/segment.ts', (req, res) => res.type('video/mp2t').send('live media bytes'));
	upstream.post('/LiveStreams/Close', (req, res) => {
		if (!req.query.liveStreamId) return res.sendStatus(400);
		closed.push(req.query.liveStreamId); res.sendStatus(204);
	});
	upstream.post('/Sessions/Playing/Stopped', (req, res) => res.sendStatus(204));
	upstream.delete('/Videos/ActiveEncodings', (req, res) => res.sendStatus(204));
	const listen = app => new Promise(resolve => { const server = app.listen(0, '127.0.0.1', () => resolve(server)); });
	const jellyfin = await listen(upstream);
	const front = express(); const local = await listen(front);
	t.after(() => { for (const server of [local, jellyfin]) { server.closeAllConnections(); server.close(); } });
	Object.assign(process.env, { NODE_ENV: 'test', PORT: String(local.address().port), JELLYFIN_URL: `http://127.0.0.1:${jellyfin.address().port}`,
		DATA_DIR: directory, AUTH_DIR: directory, LOCAL_HOSTS: '127.0.0.1', LOCAL_NETWORKS: '127.0.0.0/8' });
	writeFileSync(path.join(directory, 'connection.json'), JSON.stringify({ userId: 'test', token: 'synthetic-secret' }));
	(await import('./enabled-fixture.mjs')).enableIntegrations();
	front.use((await import('../server.mjs')).app);
	const base = `http://127.0.0.1:${local.address().port}`;
	const post = (route, body) => fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify(body) });
	for (const options of [{}, { compatibility: true, audioIndex: 1, subtitleIndex: 2 }, { preferEnglishSubtitles: true }, { preferEnglishSubtitles: true, subtitleIndex: -1 }]) {
		const response = await post('/api/play', { id, ...options });
		assert.equal(response.status, 200);
		const play = await response.json();
		assert.equal(play.live, true); assert.equal(play.kind, 'hls');
		assert.equal(selected.at(-1).MediaSourceId, sourceId);
		assert.equal(selected.at(-1).AutoOpenLiveStream, true);
		const expected = options.subtitleIndex ?? (options.preferEnglishSubtitles ? 2 : -1);
		assert.equal(selected.at(-1).SubtitleStreamIndex, expected);
		assert.equal(play.subtitleIndex, expected);
		assert.equal(selected.at(-1).AlwaysBurnInSubtitleWhenTranscoding, expected >= 0);
		if (options.audioIndex) assert.equal(selected.at(-1).AudioStreamIndex, options.audioIndex);
		const playlist = await (await fetch(base + play.url)).text();
		assert.ok(!playlist.includes('secret'));
		const segment = playlist.split('\n')[2];
		assert.equal(await (await fetch(base + segment)).text(), 'live media bytes');
		assert.equal((await post('/api/sessions/' + play.session, { action: 'stop' })).status, 204);
		assert.equal(closed.at(-1), 'tuner/with+special&characters');
	}
	assert.equal(lookups, 4, 'Resolve a fresh tuner source for each live playback');
	missingOutput = true;
	assert.equal((await post('/api/play', { id })).status, 500);
	assert.equal(closed.length, 5, 'An opened tuner must also close if stream preparation fails');
});
