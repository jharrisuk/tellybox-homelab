// Prepare/validate the original 180 s 1080p HEVC slow-case fixture OUTSIDE the
// playback acceptance timer. Run on the isolated Linux build host with:
//   TELLYBOX_VOD_FIXTURE_ROOT=/fixtures node test/manual/prepare-original-slow-121.mjs
// The fixture root should be a mounted host directory so the playback run can
// reuse the validated file without charging generation to its timer.
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFile, stat} from 'node:fs/promises';
import {hevc1080p} from '../consolidation-121-vod-fixture.mjs';

const started = Date.now();
const fixture = await hevc1080p({seconds: 180});
const info = await stat(fixture.file);
const bytes = await readFile(fixture.file);
const probe = spawnSync('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', fixture.file], {maxBuffer: 8 * 1024 * 1024});
const decode = spawnSync('ffmpeg', ['-v', 'error', '-i', fixture.file, '-f', 'null', '-'], {timeout: 300000, maxBuffer: 8 * 1024 * 1024});
let parsed = {};
try { parsed = JSON.parse(probe.stdout.toString()); } catch {}
const video = (parsed.streams || []).find(s => s.codec_type === 'video') || {};
const audio = (parsed.streams || []).find(s => s.codec_type === 'audio') || {};
console.log(JSON.stringify({
	phase: 'fixture-ready',
	root: process.env.TELLYBOX_VOD_FIXTURE_ROOT || '(default temp)',
	file: fixture.file,
	bytes: info.size,
	sha256: createHash('sha256').update(bytes).digest('hex'),
	durationSeconds: Number(parsed.format?.duration),
	video: {codec: video.codec_name, width: video.width, height: video.height, pixFmt: video.pix_fmt, fps: video.r_frame_rate},
	audio: {codec: audio.codec_name, channels: audio.channels, sampleRate: audio.sample_rate},
	ffprobeExit: probe.status,
	decodeExit: decode.status,
	buildMs: Date.now() - started
}, null, 2));
if (probe.status !== 0 || decode.status !== 0) process.exitCode = 1;
