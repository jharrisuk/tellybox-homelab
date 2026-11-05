import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWorkerPlayers } from '../../relay/worker/players.mjs';

const available = ['ffmpeg', 'ffprobe'].every(binary => spawnSync(binary, ['-version'], { stdio: 'ignore' }).status === 0);
test('real ffmpeg synthetic fixture exposes duration and audio without starting the HLS encoder', { skip: !available && 'ffmpeg/ffprobe are not installed in this environment' }, async t => {
	const directory = mkdtempSync(path.join(os.tmpdir(), 'relay-ffmpeg-'));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const file = path.join(directory, 'fixture.mp4');
	const made = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=25:duration=5', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=5', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest', file], { encoding: 'utf8' });
	assert.equal(made.status, 0, made.stderr);
	const bytes = readFileSync(file);
	const upstream = { origin: 'http://fixture.invalid', health: async () => true,
		stream: async () => new Response(bytes, { status: 200, headers: { 'content-type': 'video/mp4', 'content-length': String(bytes.length) } }),
		recordingFile: async () => new Response(bytes, { status: 200, headers: { 'content-type': 'video/mp4' } }),
		catchupSession: async () => ({ open: async () => new Response(bytes), stop: async () => {} }) };
	const players = createWorkerPlayers({ upstream, maxSessions: 1 });
	const metadata = await players.probe({ mode: 'vod', params: { type: 'movie', uuid: 'a'.repeat(36) }, options: { subtitleIndex: -1 } });
	assert.ok(metadata.duration >= 4.5 && metadata.duration <= 6, 'duration comes from the synthetic file');
	assert.equal(metadata.audio.length, 1);
	assert.equal(metadata.method, 'Transcode');
});
