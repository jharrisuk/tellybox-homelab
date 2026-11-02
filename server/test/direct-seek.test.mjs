import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';

const ffmpeg = spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0;

test('normal direct play stays a file, and the seek fallback re-opens it as seekable HLS from any segment', {skip: !ffmpeg, timeout: 120000}, async t => {
	const directory = mkdtempSync(path.join(tmpdir(), 'jserver-direct-seek-'));
	t.after(() => rmSync(directory, {recursive: true, force: true}));
	const media = path.join(directory, 'episode.mkv');
	const made = spawnSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=25',
		'-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo', '-t', '20', '-c:v', 'libx264', '-preset', 'ultrafast',
		'-g', '50', '-c:a', 'aac', '-f', 'matroska', media]);
	assert.equal(made.status, 0, String(made.stderr));
	const id = '0123456789abcdef0123456789abcdef';
	const sources = [{Id: 'ms', Container: 'mkv', SupportsDirectPlay: true, RunTimeTicks: 200000000,
		MediaStreams: [{Type: 'Video', Index: 0, Codec: 'h264', Width: 320, Height: 180}, {Type: 'Audio', Index: 1, Codec: 'aac', Language: 'eng'},
			{Type: 'Subtitle', Index: 2, Codec: 'srt', Language: 'eng', IsExternal: true}]}];
	const upstream = express();
	upstream.get('/Users/test/Items/:id', (req, res) => res.json({Id: id, Name: 'Episode', Type: 'Episode', SeriesId: id,
		MediaSources: sources}));
	upstream.post('/Items/:id/PlaybackInfo', (req, res) => res.json({PlaySessionId: 'test-play', MediaSources: sources}));
	upstream.get('/Videos/:id/stream.mkv', (req, res) => res.sendFile(media));
	upstream.get('/Videos/:id/:source/Subtitles/:index/Stream.vtt', (req, res) => res.type('text/vtt')
		.send('WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nOriginal caption\n'));
	upstream.post('/Sessions/Playing', (req, res) => res.sendStatus(204));
	upstream.post('/Sessions/Playing/Progress', (req, res) => res.sendStatus(204));
	upstream.post('/Sessions/Playing/Stopped', (req, res) => res.sendStatus(204));
	upstream.delete('/Videos/ActiveEncodings', (req, res) => res.sendStatus(204));
	const listen = app => new Promise(resolve => { const server = app.listen(0, '127.0.0.1', () => resolve(server)); });
	const jellyfin = await listen(upstream);
	const front = express();
	const local = await listen(front);
	t.after(() => { for (const server of [local, jellyfin]) { server.closeAllConnections(); server.close(); } });
	Object.assign(process.env, {NODE_ENV: 'test', PORT: String(local.address().port),
		JELLYFIN_URL: `http://127.0.0.1:${jellyfin.address().port}`, DATA_DIR: directory, AUTH_DIR: directory,
		LOCAL_HOSTS: '127.0.0.1', LOCAL_NETWORKS: '127.0.0.0/8'});
	const {writeFileSync} = await import('node:fs');
	writeFileSync(path.join(directory, 'connection.json'), JSON.stringify({userId: 'test', token: 'synthetic-secret'}));
	(await import('./enabled-fixture.mjs')).enableIntegrations();
	front.use((await import('../server.mjs')).app);
	const base = `http://127.0.0.1:${local.address().port}`;
	const post = (route, body) => fetch(base + route, {method: 'POST', headers: {'Content-Type': 'application/json', Origin: base}, body: JSON.stringify(body)});

	const direct = await post('/api/play', {id});
	assert.equal(direct.status, 200);
	const file = await direct.json();
	assert.equal(file.kind, 'video');
	assert.equal(file.method, 'DirectPlay');
	assert.equal(Math.round(file.duration), 20);
	await post('/api/sessions/' + file.session, {action: 'stop'});

	const fallback = await post('/api/play', {id, seekFallback: true, textSubtitles: true, subtitleIndex: 2});
	assert.equal(fallback.status, 200);
	const play = await fallback.json();
	assert.equal(play.kind, 'hls');
	assert.equal(play.seekFallback, true);
	assert.equal(play.method, 'Transcode');
	assert.equal(Math.round(play.duration), 20);
	assert.equal(play.subtitleIndex, 2);
	const caption = (play.subtitles || []).find(track => track.index === 2);
	assert.ok(caption?.url, 'The selected Jellyfin sidecar caption must survive the handover');
	assert.match(await (await fetch(base + caption.url)).text(), /Original caption/);
	const playlist = await (await fetch(base + play.url)).text();
	assert.match(playlist, /#EXT-X-PLAYLIST-TYPE:VOD/);
	assert.match(playlist, /#EXT-X-ENDLIST/);
	const segment = playlist.split('\n').find(line => line.trim() && !line.startsWith('#'));
	assert.ok(segment, 'The fallback must advertise a full segment timeline');
	const resource = segment.trim().slice(segment.trim().lastIndexOf('/') + 1);
	const decoded = Buffer.from(resource, 'base64url').toString();
	assert.match(decoded, /^segment\d{9}\.ts$/);
	const forward = Buffer.from('segment' + String(Number(decoded.slice(7, 16)) + 2).padStart(9, '0') + '.ts').toString('base64url');
	const baseUrl = base + play.url.slice(0, play.url.lastIndexOf('/') + 1);
	const bytes = Buffer.from(await (await fetch(baseUrl + forward)).arrayBuffer());
	assert.ok(bytes.length > 1000, 'A forward segment must be encoded from the requested position');
	assert.equal((await post('/api/sessions/' + play.session, {action: 'stop'})).status, 204);
});
