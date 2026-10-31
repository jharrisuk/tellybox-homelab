import path from 'node:path';
import { jsonStore } from './json-store.mjs';

// Wall-clock stream minutes, never the furthest seek position. Stale intervals are discarded.
export function createViewingTime(directory, { clock = Date.now } = {}) {
	const store = jsonStore(path.join(directory, 'viewing-totals.json'), { since: clock(), people: {} });
	const sessions = new Map();
	function begin(id, identity, purpose) {
		if (purpose === 'download') return;
		const key = identity.home || identity.local ? 'local' : identity.personId ? 'person:' + identity.personId : identity.shareId ? 'shared' : 'device:' + (identity.deviceId || identity.browserId || 'guest');
		const name = key === 'local' ? 'Local' : identity.personName || identity.deviceName || (key === 'shared' ? 'Shared-link viewers' : 'Guest');
		sessions.set(id, { key, name, at: clock(), position: null, playing: false });
	}
	function update(id, { position, playing, rate = 1, ended = false }) {
		const s = sessions.get(id); if (!s) return false;
		const now = clock(), elapsed = (now - s.at) / 1000;
		const movement = Number.isFinite(position) && s.position !== null ? position - s.position : 0;
		const speed = Number.isFinite(rate) && rate >= .25 && rate <= 4 ? rate : 1;
		if (s.playing && playing && elapsed > 0 && elapsed <= 45 && movement > 0 && movement <= elapsed * speed + 3) {
			const seconds = Math.min(elapsed, movement / speed);
			const entry = store.get().people[s.key] ||= { name: s.name, seconds: 0 };
			entry.name = s.name; entry.seconds += seconds;
			store.save();
		}
		s.at = now; s.position = Number.isFinite(position) ? position : null; s.playing = Boolean(playing);
		if (ended) sessions.delete(id);
	}
	return { begin, update, snapshot: () => ({ since: store.get().since, users: Object.entries(store.get().people).map(([id, value]) => ({ id, name: value.name, seconds: Math.floor(value.seconds), minutes: Math.floor(value.seconds / 60) })) }) };
}
