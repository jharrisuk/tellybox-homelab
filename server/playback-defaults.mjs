import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const keys = ['englishSubtitles', 'autoNext', 'skipIntros'];

export function normalisePlaybackDefaults(value) {
	const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
	return Object.fromEntries(keys.map(key => [key, source[key] === true]));
}

// Server-wide viewing defaults. A missing or malformed file is treated as all
// false, which matches the old per-device defaults and never blocks startup.
export function createPlaybackDefaults(directory) {
	const file = path.join(directory, 'playback-defaults.json');
	let current = normalisePlaybackDefaults(null);
	try { current = normalisePlaybackDefaults(JSON.parse(readFileSync(file, 'utf8'))); }
	catch (error) { if (error.code !== 'ENOENT') current = normalisePlaybackDefaults(null); }
	function status() { return { ...current }; }
	function set(input) {
		if (!input || typeof input !== 'object' || Array.isArray(input)) {
			throw Object.assign(Error('Choose a value for each playback default.'), { status: 400 });
		}
		for (const key of keys) {
			if (input[key] !== undefined && typeof input[key] !== 'boolean') {
				throw Object.assign(Error('Playback defaults must be on or off.'), { status: 400 });
			}
		}
		const next = normalisePlaybackDefaults({ ...current, ...input });
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		writeFileSync(file + '.tmp', JSON.stringify(next), { mode: 0o600 });
		renameSync(file + '.tmp', file);
		current = next;
		return status();
	}
	return { status, set };
}

export const playbackDefaultKeys = [...keys];
