// Rolling guide archive.
//
// Dispatcharr 0.32 replaces a whole EPG source's programme set on every refresh,
// so its guide can only ever be as old as the feed it just parsed. UK catch-up
// streams are usually good for seven days, but the guide rows are not. This
// archive keeps the past programmes Tellybox has already seen, so catch-up does
// not depend on the upstream's retention window.
//
// Rules:
//   * only past programmes are kept (a programme is archived once it has ended,
//     plus a small grace for a late refresh); the live guide stays as it was;
//   * entries are keyed by the existing programme Id, so repeated refreshes
//     replace rather than duplicate;
//   * anything older than retentionDays is pruned, and a hard entry cap drops
//     the oldest rows rather than growing without bound;
//   * writes are atomic (tmp + rename), throttled, and never fatal: an archive
//     error must not take the guide or catch-up down.
import { readFile, writeFile, rename } from 'node:fs/promises';

const DAY = 86400000;
const GRACE_MS = 5 * 60000;

const trim = programme => {
	const kept = { Id: String(programme.Id ?? ''), Name: String(programme.Name ?? ''),
		StartDate: programme.StartDate, EndDate: programme.EndDate };
	if (!kept.Id || !kept.Name || !Number.isFinite(Date.parse(kept.StartDate)) || !Number.isFinite(Date.parse(kept.EndDate))) return null;
	for (const key of ['EpisodeTitle', 'ParentIndexNumber', 'IndexNumber', 'IsMovie', 'ProductionYear']) {
		if (programme[key] !== undefined && programme[key] !== null) kept[key] = programme[key];
	}
	return kept;
};

export function createGuideArchive({ file = '', clock = Date.now, retentionDays = 8, maxEntries = 60000, flushMs = 6 * 3600000 } = {}) {
	// channelId -> Map(programmeId -> programme)
	const channels = new Map();
	let restored = false, dirty = false, lastFlush = 0, writing = null, failedWrites = 0;

	const ready = (async () => {
		if (!file) { restored = true; return; }
		try {
			const value = JSON.parse(await readFile(file, 'utf8'));
			const saved = value?.channels;
			if (value?.version === 1 && saved && typeof saved === 'object') {
				for (const [channelId, list] of Object.entries(saved)) {
					if (!Array.isArray(list)) continue;
					const set = new Map();
					for (const raw of list) {
						const programme = trim(raw);
						if (programme) set.set(programme.Id, programme);
					}
					if (set.size) channels.set(channelId, set);
				}
			}
		} catch { /* missing or corrupt archive starts empty */ }
		prune();
		enforceCap();
		restored = true;
	})();

	const cutoff = () => clock() - retentionDays * DAY;
	function prune() {
		const floor = cutoff();
		for (const [channelId, set] of channels) {
			for (const [key, programme] of set) if (Date.parse(programme.EndDate) < floor) set.delete(key);
			if (!set.size) channels.delete(channelId);
		}
	}
	const size = () => { let total = 0; for (const set of channels.values()) total += set.size; return total; };
	function enforceCap() {
		let total = size();
		if (total <= maxEntries) return;
		// Drop the oldest rows first. This only happens if a feed is pathological;
		// normal use is ~20k rows for a week of linear channels.
		const all = [];
		for (const [channelId, set] of channels) for (const [key, programme] of set) all.push({ channelId, key, end: Date.parse(programme.EndDate) });
		all.sort((a, b) => a.end - b.end);
		for (let i = 0; i < all.length && total > maxEntries; i++, total--) {
			const set = channels.get(all[i].channelId);
			set?.delete(all[i].key);
			if (set && !set.size) channels.delete(all[i].channelId);
		}
	}

	// Merge the programmes of one live guide channel into the archive. Only
	// programmes that have already ended (or end within the grace window) are
	// kept; the rest remain the live guide's job.
	function mergeChannel(channel) {
		if (!channel?.Id) return false;
		const now = clock();
		let set = channels.get(channel.Id);
		let changed = false;
		for (const raw of channel.programmes || []) {
			const programme = trim(raw);
			if (!programme) continue;
			if (Date.parse(programme.EndDate) > now + GRACE_MS) continue;
			if (!set) set = new Map();
			const previous = set.get(programme.Id);
			if (!previous || previous.Name !== programme.Name || previous.EndDate !== programme.EndDate || previous.StartDate !== programme.StartDate) changed = true;
			set.set(programme.Id, programme);
		}
		if (set?.size) channels.set(channel.Id, set);
		return changed;
	}

	function merge(guideChannels) {
		let changed = false;
		for (const channel of Array.isArray(guideChannels) ? guideChannels : []) if (mergeChannel(channel)) changed = true;
		const before = size();
		prune();
		if (size() !== before) changed = true;
		if (changed) { enforceCap(); dirty = true; }
		return changed;
	}

	// Live channel rows with their archived past programmes folded back in,
	// deduplicated by programme Id and ordered by start time.
	function snapshot(guideChannels) {
		return (Array.isArray(guideChannels) ? guideChannels : []).map(channel => {
			const archived = channels.get(channel.Id);
			if (!archived?.size) return channel;
			const live = channel.programmes || [];
			const spans = live
				.map(programme => [Date.parse(programme.StartDate), Date.parse(programme.EndDate)])
				.filter(([start, end]) => Number.isFinite(start) && Number.isFinite(end) && end > start);
			const byId = new Map();
			for (const programme of archived.values()) {
				const start = Date.parse(programme.StartDate), end = Date.parse(programme.EndDate);
				// A feed that corrects a programme's start gives it a new Id. The
				// live copy wins; the stale archived row must not appear as a
				// duplicate catch-up entry.
				if (spans.some(([s, e]) => start < e && end > s)) continue;
				byId.set(programme.Id, programme);
			}
			for (const programme of live) byId.set(programme.Id, programme);
			const programmes = [...byId.values()].sort((a, b) => Date.parse(a.StartDate) - Date.parse(b.StartDate) || String(a.Name).localeCompare(String(b.Name)));
			return { ...channel, programmes };
		});
	}

	async function write() {
		const payload = { version: 1, savedAt: clock(), channels: {} };
		for (const [channelId, set] of channels) payload.channels[channelId] = [...set.values()];
		await writeFile(file + '.tmp', JSON.stringify(payload), { mode: 0o600 });
		await rename(file + '.tmp', file);
		lastFlush = clock();
	}

	// Throttled persistence. force=true is for tests and shutdown. The archive is
	// authoritative in memory; a restart only loses the programmes that ended
	// since the last write, and those are still inside Dispatcharr's own window,
	// so the next refresh folds them straight back in. Six-hourly keeps writes
	// to a few megabytes a day instead of a constant rewrite.
	async function flush(force = false) {
		await ready;
		if (!file || !dirty) return false;
		if (!force && clock() - lastFlush < flushMs) return false;
		if (writing) return writing;
		writing = (async () => {
			try { await write(); dirty = false; failedWrites = 0; }
			catch { failedWrites++; }
			finally { writing = null; }
		})();
		return writing;
	}

	return {
		ready, merge, snapshot, flush, size, prune,
		get restored() { return restored; },
		get channels() { return channels.size; },
		get pendingWrites() { return dirty; },
		get failedWrites() { return failedWrites; }
	};
}
