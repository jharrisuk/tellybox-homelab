import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const DEFAULT_PAUSED_TIMEOUT_MINUTES = 10;
export const MAX_PAUSED_TIMEOUT_MINUTES = 1440;

export function normalisePausedTimeout(value) {
	const minutes = Number(value?.minutes);
	if (!Number.isInteger(minutes) || minutes < 0 || minutes > MAX_PAUSED_TIMEOUT_MINUTES) {
		return { minutes: DEFAULT_PAUSED_TIMEOUT_MINUTES };
	}
	return { minutes };
}

// Server-wide paused-stream timeout. 0 disables the automatic close. A missing
// or malformed file uses the documented 10-minute default and never blocks start.
export function createPausedTimeout(directory) {
	const file = path.join(directory, 'paused-timeout.json');
	let current = normalisePausedTimeout(null);
	try { current = normalisePausedTimeout(JSON.parse(readFileSync(file, 'utf8'))); }
	catch (error) { if (error.code !== 'ENOENT') current = normalisePausedTimeout(null); }
	function status() { return { ...current }; }
	function set(input) {
		if (!input || typeof input !== 'object' || Array.isArray(input)) {
			throw Object.assign(Error('Enter a paused-stream timeout in minutes.'), { status: 400 });
		}
		const minutes = input.minutes;
		if (typeof minutes !== 'number' || !Number.isInteger(minutes) || minutes < 0 || minutes > MAX_PAUSED_TIMEOUT_MINUTES) {
			throw Object.assign(Error(`Use a whole number from 0 to ${MAX_PAUSED_TIMEOUT_MINUTES} minutes.`), { status: 400 });
		}
		const next = { minutes };
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		writeFileSync(file + '.tmp', JSON.stringify(next), { mode: 0o600 });
		renameSync(file + '.tmp', file);
		current = next;
		return status();
	}
	return { status, set };
}
