// Admin sport settings for the Coming Soon rail (Q80).
//
// One small file-backed store, modelled on playback-defaults.mjs:
//   { enabled: true, sports: ['football', 'boxing', ...], football: 'uk' | 'all' }
// Defaults: enabled true, every sport the source carries, football 'uk'. A
// missing or malformed file falls back to the defaults and never blocks startup.
//
// Reads are open to any authenticated/local viewer; writes are gated to a local
// installation administrator in server.mjs (the store itself only validates the
// shape). Validation is against the known sport list so a viewer cannot invent a
// sport, and football is a strict enum.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { KNOWN_SPORTS } from './livesportontv.mjs';

const FOOTBALL_MODES = ['uk', 'all'];

export function normaliseSportSettings(value, knownSports = KNOWN_SPORTS) {
	const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
	const known = new Set(knownSports);
	const enabled = typeof source.enabled === 'boolean' ? source.enabled : true;
	let sports;
	if (Array.isArray(source.sports)) {
		sports = [...new Set(source.sports.filter(s => typeof s === 'string' && known.has(s)))].sort();
	} else {
		sports = [...knownSports].sort();
	}
	const football = FOOTBALL_MODES.includes(source.football) ? source.football : 'uk';
	return { enabled, sports, football };
}

export function createSportSettings(directory, { knownSports = KNOWN_SPORTS } = {}) {
	const file = path.join(directory, 'sport-settings.json');
	const known = [...knownSports].sort();
	let current = normaliseSportSettings(null, known);
	try { current = normaliseSportSettings(JSON.parse(readFileSync(file, 'utf8')), known); }
	catch (error) { if (error.code !== 'ENOENT') current = normaliseSportSettings(null, known); }
	function status() { return { ...current, sports: [...current.sports], knownSports: [...known] }; }
	function set(input) {
		if (!input || typeof input !== 'object' || Array.isArray(input)) {
			throw Object.assign(Error('Choose whether the sport rail is on, which sports to show, and the football scope.'), { status: 400 });
		}
		if (input.enabled !== undefined && typeof input.enabled !== 'boolean') {
			throw Object.assign(Error('The sport rail must be on or off.'), { status: 400 });
		}
		if (input.football !== undefined && !FOOTBALL_MODES.includes(input.football)) {
			throw Object.assign(Error('Football scope must be "uk" or "all".'), { status: 400 });
		}
		if (input.sports !== undefined) {
			if (!Array.isArray(input.sports) || input.sports.some(s => typeof s !== 'string' || !known.includes(s))) {
				throw Object.assign(Error('Choose sports from the list the source provides.'), { status: 400 });
			}
		}
		const next = normaliseSportSettings({ ...current, ...input }, known);
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		writeFileSync(file + '.tmp', JSON.stringify({ enabled: next.enabled, sports: next.sports, football: next.football }), { mode: 0o600 });
		renameSync(file + '.tmp', file);
		current = next;
		return status();
	}
	return { status, set, knownSports: [...known] };
}
