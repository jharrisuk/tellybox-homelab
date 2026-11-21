/**
 * Legacy bounded playability sampler retained for its focused tests and older
 * callers. The live Home route no longer uses this module: normal watch surfaces
 * now verify series through vod-library's persisted availability index, rebuild
 * rails with checked replacements, and exclude unknown as well as confirmed
 * empty series. Do not wire this helper back into a normal watch surface
 * without applying that playable-only policy.
 *
 * Bounded, cached playability checks for the series that are about to appear on
 * the personalised Home feed. Provider episodes are expensive, so this never
 * scans the whole catalogue: callers pass the ids already selected for each row,
 * and a bounded fair sample is checked per request.
 */
export function createHomePlayability({
	episodes,
	clock = Date.now,
	cachedMs = 10 * 60 * 1000,
	unknownMs = 60 * 1000,
	limit = 12,
	concurrency = 4,
	maxCache = 500,
	maxPending = 64,
	timeoutMs = 1200,
	overallMs = 2500
} = {}) {
	const cache = new Map();
	const pending = new Map();
	let active = 0;

	const fresh = entry => entry && entry.until > clock();
	const prune = () => {
		for (const [id, entry] of cache) if (!fresh(entry)) cache.delete(id);
		while (cache.size > maxCache) cache.delete(cache.keys().next().value);
	};
	const withSlot = async (work, deadline) => {
		if (active >= concurrency || clock() >= deadline) return null;
		active++;
		try {
			return { value: await work() };
		} finally {
			active--;
		}
	};
	const episodesNow = (id, deadline) => {
		const cached = cache.get(id);
		if (fresh(cached)) return Promise.resolve(cached.state);
		if (pending.has(id)) return pending.get(id);
		if (pending.size >= maxPending) return Promise.resolve('unknown');
		const work = withSlot(() => Promise.resolve().then(() => episodes(id)), deadline).then(result => {
			if (!result) return 'unknown';
			const value = result.value;
			const items = value && Array.isArray(value.items) ? value.items : null;
			const now = clock();
			const playable = items ? items.filter(episode => {
				const date = Date.parse(episode?.PremiereDate || '');
				return !Number.isFinite(date) || date <= now;
			}) : null;
			const state = !playable ? 'unknown' : value.notice ? 'unknown' : playable.length === 0 ? 'empty' : 'available';
			const until = clock() + (state === 'unknown' ? unknownMs : cachedMs);
			cache.set(id, { state, until });
			prune();
			return state;
		}, () => {
			cache.set(id, { state: 'unknown', until: clock() + unknownMs });
			prune();
			return 'unknown';
		}).finally(() => pending.delete(id));
		pending.set(id, work);
		return work;
	};

	const assessOne = async (id, now, deadline) => {
		const remaining = Math.max(1, Math.min(timeoutMs, deadline - clock()));
		let timer;
		let state;
		try {
			state = await Promise.race([
				episodesNow(id, deadline),
				new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('timeout')), remaining); })
			]);
		} catch {
			return false;
		} finally {
			if (timer) clearTimeout(timer);
		}
		if (state === 'empty') return true;
		if (state === 'unknown') return false;
		return false;
	};

	const normalize = input => {
		if (!Array.isArray(input)) return [];
		if (!input.length) return [];
		if (Array.isArray(input[0])) return input.map(ids => [...new Set(ids.filter(id => typeof id === 'string' && id))]);
		return [input.filter(id => typeof id === 'string' && id)];
	};

	async function assess(input = [], { priority = [] } = {}) {
		const groups = normalize(input);
		const all = [...new Set([...groups.flat(), ...priority.filter(id => typeof id === 'string' && id)])];
		if (!all.length) return new Set();
		prune();
		// Cached confirmed-empty entries apply even when they are outside the
		// per-request sampling budget.
		const unavailable = new Set();
		for (const id of all) {
			const entry = cache.get(id);
			if (fresh(entry) && entry.state === 'empty') unavailable.add(id);
		}
		const chosen = [];
		const seen = new Set();
		const add = id => {
			if (!id || seen.has(id) || unavailable.has(id) || chosen.length >= limit) return;
			const known = cache.get(id);
			if (fresh(known)) return;
			seen.add(id); chosen.push(id);
		};
		for (const id of priority) add(id);
		for (let round = 0; chosen.length < limit; round++) {
			let added = false;
			for (const group of groups) {
				if (group[round]) { add(group[round]); added = true; }
				if (chosen.length >= limit) break;
			}
			if (!added) break;
		}
		const deadline = clock() + overallMs;
		let index = 0;
		const worker = async () => {
			while (index < chosen.length && clock() < deadline) {
				const id = chosen[index++];
				if (await assessOne(id, clock(), deadline)) unavailable.add(id);
			}
		};
		let overallTimer;
		const overall = new Promise(resolve => { overallTimer = setTimeout(resolve, overallMs); overallTimer.unref?.(); });
		try {
			await Promise.race([
				Promise.all(Array.from({ length: Math.min(concurrency, chosen.length) }, worker)),
				overall
			]);
		} finally {
			clearTimeout(overallTimer);
		}
		return unavailable;
	}

	return { assess, cache, stats: () => ({ active, pending: pending.size }) };
}
