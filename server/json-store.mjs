import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import path from 'node:path';

export function jsonStore(file, initial) {
	let value;
	try { value = JSON.parse(readFileSync(file, 'utf8')); }
	catch (error) { if (error.code !== 'ENOENT') throw error; value = structuredClone(initial); }
	return {
		get: () => value,
		save() {
			mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
			writeFileSync(file + '.tmp', JSON.stringify(value), { mode: 0o600 });
			renameSync(file + '.tmp', file);
		}
	};
}
