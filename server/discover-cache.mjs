import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

// Durable, bounded, shared-public Discover snapshot cache.
//
// Only the allowlisted public catalogue fields below are ever written to disk.
// Raw Seerr responses, mediaInfo, request/workflow state, viewer identity,
// watchId/vodId, provider URLs/credentials, UserData, progress, favourites,
// signed CDN URLs and personalised ranking are never stored. A cache hit is
// metadata, never proof of playback or authorization: callers must reapply
// current enrichment/availability and their own request-status overlay.

const VERSION = 1;
const DAY = 86400000;
const MAX_KEY = 320;
const POSTER = /^\/[A-Za-z0-9_-]+\.(?:jpg|png|webp)$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const REGION = /^[A-Z]{2}$/;
const GENRE = /^[A-Za-z0-9][A-Za-z0-9 &'.-]{0,39}$/;
const RATING_SOURCES = new Set(['TMDB', 'IMDb', 'Rotten Tomatoes', 'Trakt']);
const RATING_HOSTS = new Set(['www.themoviedb.org', 'www.imdb.com']);
const CONTROL = /[\u0000-\u001f\u007f]/g;

const finite = (value, fallback) => Number.isFinite(value) && value >= 0 ? value : fallback;
const clamp = (value, min, max, fallback) => {
	const number = Number(value);
	return Number.isFinite(number) ? Math.max(min, Math.min(max, Math.round(number))) : fallback;
};
const text = (value, max) => typeof value === 'string' ? value.replace(CONTROL, ' ').slice(0, max) : null;
const publicPoster = value => typeof value === 'string' && POSTER.test(value) ? value : null;

function publicRatingUrl(value) {
	if (typeof value !== 'string' || value.length > 300) return null;
	try {
		const url = new URL(value);
		if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash) return null;
		if (!RATING_HOSTS.has(url.hostname)) return null;
		return url.href;
	} catch { return null; }
}

function publicRatings(value) {
	if (!Array.isArray(value)) return [];
	const rows = [];
	for (const rating of value.slice(0, 8)) {
		if (!rating || !RATING_SOURCES.has(rating.source)) continue;
		const max = Number(rating.max);
		const score = Number(rating.value);
		if (!Number.isFinite(max) || max <= 0 || max > 100) continue;
		if (!Number.isFinite(score) || score <= 0 || score > max) continue;
		const votes = Number.isSafeInteger(rating.votes) && rating.votes > 0 ? rating.votes : 0;
		const url = publicRatingUrl(rating.url);
		rows.push({ source: rating.source, value: Math.round(score * 10) / 10, max, votes, ...(url ? { url } : {}) });
	}
	return rows;
}

// Storage allowlist, not a delete-a-few-fields filter: anything that is not
// named here is dropped before the payload can reach memory or disk.
export function sanitizePublicItem(item) {
	if (!item || typeof item !== 'object') return null;
	const id = Number(item.id);
	if (!Number.isSafeInteger(id) || id < 1 || id > 2147483647) return null;
	const type = item.type === 'movie' || item.type === 'tv' ? item.type : null;
	if (!type) return null;
	const title = text(item.title, 500);
	if (!title) return null;
	const row = {
		id, type, title,
		overview: text(item.overview, 6000) || '',
		poster: publicPoster(item.poster),
		backdrop: publicPoster(item.backdrop),
		date: typeof item.date === 'string' && (item.date === '' || DATE.test(item.date)) ? item.date.slice(0, 10) : '',
		genres: Array.isArray(item.genres)
			? [...new Set(item.genres.filter(value => typeof value === 'string' && GENRE.test(value)))].slice(0, 24)
			: [],
		ratings: publicRatings(item.ratings)
	};
	const popularity = Number(item.popularity);
	if (Number.isFinite(popularity) && popularity >= 0 && popularity <= 1e9) row.popularity = Math.round(popularity * 10) / 10;
	const rank = Number(item.rank);
	if (Number.isInteger(rank) && rank >= 1 && rank <= 1000) row.rank = rank;
	for (const [key, max] of [['chartTitle', 500], ['chartSeason', 200], ['chartChannel', 100]]) {
		const value = text(item[key], max);
		if (value) row[key] = value;
	}
	return row;
}

export function sanitizeSnapshot(data) {
	if (!data || typeof data !== 'object' || !Array.isArray(data.items)) return null;
	const items = data.items.map(sanitizePublicItem).filter(Boolean);
	// An empty result is never allowed to replace good last-known data.
	if (!items.length) return null;
	const page = Number.isInteger(data.page) && data.page >= 1 && data.page <= 10000 ? data.page : 1;
	const pages = Number.isInteger(data.pages) && data.pages >= 1 && data.pages <= 10000 ? data.pages : 1;
	const payload = { page, pages, items };
	if (data.provider && typeof data.provider === 'object') {
		const id = Number(data.provider.id);
		const name = text(data.provider.name, 100);
		if (Number.isInteger(id) && id >= 1 && id <= 999999 && name) payload.provider = { id, name };
	}
	const note = text(data.note, 500);
	if (note) payload.note = note;
	if (typeof data.region === 'string' && REGION.test(data.region)) payload.region = data.region;
	const chart = text(data.chart, 200);
	if (chart) payload.chart = chart;
	return payload;
}

// Stable, date-independent query identity. Runtime filters such as
// releaseDate<=today are applied by the loader, never baked into the key.
export function stableQueryKey(kind, fields = {}) {
	if (typeof kind !== 'string' || !kind) throw Object.assign(Error('A discover cache key needs a kind.'), { status: 400 });
	const parts = Object.entries(fields)
		.filter(([, value]) => value !== undefined && value !== null && value !== '')
		.sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
		.map(([key, value]) => key + '=' + String(value).replace(/[|\u0000-\u001f]/g, ''));
	const key = parts.length ? kind + '|' + parts.join('|') : kind;
	if (key.length > MAX_KEY) throw Object.assign(Error('Discover cache key is too long.'), { status: 400 });
	return key;
}

const queueError = message => Object.assign(Error(message), { status: 503, code: 'discover_busy' });
const generationError = () => Object.assign(Error('Discovery settings changed. Please try again shortly.'), { status: 503, code: 'discover_source_changed' });

export function createDiscoverCache(options = {}) {
	const file = typeof options.file === 'string' && options.file ? options.file : null;
	const clock = typeof options.now === 'function' ? options.now : Date.now;
	const dayMs = Math.max(10, finite(options.dayMs, DAY));
	const staleMs = finite(options.staleMs, 6 * 3600000);
	const maxStaleMs = Math.max(staleMs, finite(options.maxStaleMs, 7 * DAY));
	const maxEntries = clamp(options.maxEntries, 1, 5000, 200);
	const maxActive = clamp(options.maxActive, 1, 16, 2);
	const maxQueue = clamp(options.maxQueue, 0, 256, 8);
	const loadTimeoutMs = clamp(options.loadTimeoutMs, 10, 120000, 25000);
	const queueWaitMs = clamp(options.queueWaitMs, 10, 120000, 30000);
	const schema = String(options.schema || 'discover-128b');
	const sourceKey = options.sourceKey ?? '';
	// Heavy background work must never compete with live playback. The check can
	// be async; a throwing check is treated as busy (conservative).
	const isBusy = typeof options.isBusy === 'function' ? options.isBusy : () => false;

	const entries = new Map();
	const inflight = new Map();
	const queue = [];
	const idleWaiters = [];
	let active = 0;
	let writing = Promise.resolve();
	let stopped = false;
	let warmers = [];
	let dailyTimer = null;
	let dailyRunning = false;
	let lastDailyAt = null;
	let started = false;

	const nowMs = () => {
		const value = Number(clock());
		return Number.isFinite(value) ? value : Date.now();
	};

	function sourceFingerprint() {
		let raw = '';
		try { raw = typeof sourceKey === 'function' ? sourceKey() : sourceKey; } catch { raw = ''; }
		return createHash('sha256').update(schema + '\u0000' + String(raw ?? '')).digest('hex').slice(0, 32);
	}

	let currentFingerprint = sourceFingerprint();

	function refreshGeneration() {
		currentFingerprint = sourceFingerprint();
		return currentFingerprint;
	}

	// Startup re-reads the durable snapshot synchronously so the first visitor
	// sees last-known public catalogue data without an upstream fetch.
	if (file) {
		try {
			const raw = JSON.parse(readFileSync(file, 'utf8'));
			if (raw && raw.version === VERSION && raw.schema === schema && raw.fingerprint === currentFingerprint && raw.entries && typeof raw.entries === 'object') {
				for (const [key, entry] of Object.entries(raw.entries)) {
					if (typeof key !== 'string' || !key || key.length > MAX_KEY) continue;
					if (!entry || !Number.isFinite(entry.at) || entry.at > nowMs() + 300000) continue;
					const payload = sanitizeSnapshot(entry.payload);
					if (!payload) continue;
					entries.set(key, { at: entry.at, fp: currentFingerprint, payload });
					if (entries.size >= maxEntries) break;
				}
			}
		} catch { /* missing, unreadable or corrupt: start empty and recover on the next write */ }
	}

	function isIdle() {
		return active === 0 && queue.length === 0 && inflight.size === 0 && !dailyRunning;
	}

	function checkIdle() {
		if (!isIdle()) return;
		for (const resolve of idleWaiters.splice(0)) resolve();
	}

	function whenIdle() {
		if (isIdle()) return Promise.resolve();
		return new Promise(resolve => idleWaiters.push(resolve));
	}

	function serialize() {
		const data = { version: VERSION, schema, fingerprint: currentFingerprint, savedAt: nowMs(), entries: {} };
		for (const [key, entry] of entries) {
			if (entry.fp !== currentFingerprint) continue;
			data.entries[key] = { at: entry.at, payload: entry.payload };
		}
		return JSON.stringify(data);
	}

	// Writes are serialized and atomic (part file + rename) so a crash cannot
	// leave a half-written snapshot. Failures stay silent: the cache keeps
	// serving last-known data and the next write repairs the file.
	function persist() {
		if (!file) return writing;
		const body = serialize();
		writing = writing.catch(() => {}).then(async () => {
			await mkdir(dirname(file), { recursive: true, mode: 0o700 });
			await writeFile(file + '.part', body, { mode: 0o600 });
			await rename(file + '.part', file);
		}).catch(() => {});
		return writing;
	}

	function evictOne() {
		let staleKey = null;
		let oldestKey = null;
		let oldestAt = Infinity;
		for (const [key, entry] of entries) {
			if (entry.fp !== currentFingerprint) { staleKey = key; break; }
			if (entry.at < oldestAt) { oldestAt = entry.at; oldestKey = key; }
		}
		const victim = staleKey || oldestKey;
		if (victim) entries.delete(victim);
	}

	function commit(key, payload, fingerprint) {
		if (fingerprint !== refreshGeneration()) return false;
		if (!entries.has(key) && entries.size >= maxEntries) evictOne();
		entries.set(key, { at: nowMs(), fp: fingerprint, payload });
		persist();
		return true;
	}

	function acquire() {
		if (active < maxActive) {
			active++;
			return { promise: Promise.resolve(), cancel: () => {} };
		}
		if (queue.length >= maxQueue) return { promise: Promise.reject(queueError('Discovery is busy. Please try again shortly.')), cancel: () => {} };
		let waiter = null;
		const promise = new Promise((resolve, reject) => {
			waiter = { resolve, reject, timer: null };
			waiter.timer = setTimeout(() => {
				const index = queue.indexOf(waiter);
				if (index >= 0) queue.splice(index, 1);
				reject(queueError('Discovery is busy. Please try again shortly.'));
			}, queueWaitMs);
			waiter.timer.unref?.();
			queue.push(waiter);
		});
		return {
			promise,
			cancel: () => {
				const index = queue.indexOf(waiter);
				if (index < 0) return;
				queue.splice(index, 1);
				clearTimeout(waiter.timer);
				waiter.reject(queueError('Discovery is busy. Please try again shortly.'));
			}
		};
	}

	function release() {
		const waiter = queue.shift();
		if (waiter) {
			clearTimeout(waiter.timer);
			// The slot transfers directly, so maxActive is never exceeded.
			waiter.resolve();
		} else {
			active--;
		}
		checkIdle();
	}

	// One admitted task per key+source generation. The caller's wait timeout is
	// deliberately separate from the loader's lifetime: a timeout rejects that
	// caller but leaves the task deduped and its admission slot held until the
	// underlying loader really settles. This bounds noncooperative loaders to the
	// configured maxActive instead of replacing them on every timeout.
	function startTask(key, loader, fingerprint) {
		const inflightKey = key + '\u0000' + fingerprint;
		const controller = new AbortController();
		const task = {
			key, fingerprint, controller,
			admission: acquire(),
			subscribers: 0,
			admitted: false,
			settled: false,
			timedOut: false,
			cancelled: false,
			released: false,
			promise: null
		};
		task.promise = (async () => {
			let admitted = false;
			try {
				await task.admission.promise;
				admitted = true;
				task.admitted = true;
				if (task.timedOut || task.cancelled) throw queueError('Discovery took too long. Please try again shortly.');
				// Defer by one microtask so a stale read returns last-good before
				// the background refresh starts calling upstream.
				const raw = await Promise.resolve().then(() => loader(controller.signal));
				// A timed-out old generation must never publish a late result.
				if (task.timedOut || task.cancelled) throw queueError('Discovery took too long. Please try again shortly.');
				if (!raw || typeof raw !== 'object' || !Array.isArray(raw.items)) throw Object.assign(Error('Discovery returned an invalid response.'), { status: 502 });
				const payload = sanitizeSnapshot(raw);
				if (fingerprint !== refreshGeneration()) throw generationError();
				if (payload && !commit(key, payload, fingerprint)) throw generationError();
				else if (!payload && raw.items.length) throw Object.assign(Error('Discovery returned an invalid response.'), { status: 502 });
				return { raw, payload };
			} finally {
				// Exactly one release per successful admission, whatever happened.
				if (admitted && !task.released) {
					task.released = true;
					release();
				}
				task.settled = true;
				if (inflight.get(inflightKey) === task) inflight.delete(inflightKey);
				checkIdle();
			}
		})();
		// Callers that timed out no longer observe this promise. Keep its eventual
		// rejection handled while a noncooperative loader finishes.
		task.promise.catch(() => {});
		inflight.set(inflightKey, task);
		return task;
	}

	function waitForTask(task) {
		task.subscribers++;
		return new Promise((resolve, reject) => {
			let done = false;
			const timer = setTimeout(() => {
				if (done) return;
				done = true;
				task.subscribers = Math.max(0, task.subscribers - 1);
				const error = queueError('Discovery took too long. Please try again shortly.');
				if (task.subscribers === 0 && !task.settled) {
					// The last caller stopped waiting: signal cooperative loaders to
					// abort, while the slot stays held until it actually settles.
					task.timedOut = true;
					if (!task.admitted) task.admission.cancel();
					task.controller.abort(error);
				}
				reject(error);
			}, loadTimeoutMs);
			timer.unref?.();
			const finish = (error, value) => {
				if (done) return;
				done = true;
				clearTimeout(timer);
				task.subscribers = Math.max(0, task.subscribers - 1);
				if (error) reject(error); else resolve(value);
			};
			task.promise.then(value => finish(null, value), error => finish(error));
		});
	}

	async function execute(key, loader, fingerprint) {
		const inflightKey = key + '\u0000' + fingerprint;
		const task = inflight.get(inflightKey) || startTask(key, loader, fingerprint);
		return waitForTask(task);
	}

	async function background(key, loader, fingerprint) {
		const inflightKey = key + '\u0000' + fingerprint;
		// Duplicate refreshes (visitor + scheduled + timer) share one task.
		if (!inflight.has(inflightKey) && active >= maxActive && queue.length >= maxQueue) return null;
		try { return await execute(key, loader, fingerprint); }
		catch { return null; }
	}

	async function get(key, loader) {
		if (typeof key !== 'string' || !key || key.length > MAX_KEY) throw Object.assign(Error('Invalid discover cache key.'), { status: 400 });
		if (typeof loader !== 'function') throw Object.assign(Error('A discover loader is required.'), { status: 500 });
		const fingerprint = refreshGeneration();
		const entry = entries.get(key);
		if (entry && entry.fp === fingerprint) {
			const age = Math.max(0, nowMs() - entry.at);
			if (age < staleMs) return { ...structuredClone(entry.payload), cacheState: 'fresh', stale: false, cacheAge: age };
			if (age < maxStaleMs) {
				// Stale-while-revalidate: last-known public metadata immediately,
				// one deduped background refresh, never a blocked visitor.
				void background(key, loader, fingerprint);
				return { ...structuredClone(entry.payload), cacheState: 'stale', stale: true, cacheAge: age };
			}
		}
		try {
			const result = await execute(key, loader, fingerprint);
			// A miss returns the caller's fresh upstream view so current status
			// overlays can be applied; only the sanitized copy is persisted.
			return { ...result.raw, cacheState: 'miss', stale: false };
		} catch (error) {
			if (entry && entry.fp === fingerprint && refreshGeneration() === fingerprint) {
				return { ...structuredClone(entry.payload), cacheState: 'expired', stale: true, degraded: true, cacheAge: Math.max(0, nowMs() - entry.at) };
			}
			throw error;
		}
	}

	function overdue(key) {
		const entry = entries.get(key);
		if (!entry || entry.fp !== currentFingerprint) return true;
		return nowMs() - entry.at >= dayMs;
	}

	function normalizeWarmers(list) {
		return (Array.isArray(list) ? list : [])
			.filter(warmer => warmer && typeof warmer.key === 'string' && warmer.key && warmer.key.length <= MAX_KEY && typeof warmer.load === 'function')
			.slice(0, 64);
	}

	async function runWarm() {
		if (dailyRunning) return { skipped: true };
		dailyRunning = true;
		refreshGeneration();
		checkIdle();
		const result = { ran: 0, failed: 0, skipped: 0, deferred: false };
		const busy = async () => { try { return Boolean(await isBusy()); } catch { return true; } };
		try {
			for (const warmer of warmers) {
				if (stopped) break;
				if (!overdue(warmer.key)) { result.skipped++; continue; }
				// Stop before starting a new upstream load. Already admitted work is
				// allowed to settle; the next clock attempt retries the rest.
				if (await busy()) { result.deferred = true; break; }
				const fingerprint = refreshGeneration();
				try {
					await execute(warmer.key, warmer.load, fingerprint);
					result.ran++;
				} catch { result.failed++; }
			}
		} finally {
			dailyRunning = false;
			lastDailyAt = nowMs();
			checkIdle();
		}
		return result;
	}

	function scheduleDaily(delay) {
		if (stopped || dailyTimer) return;
		dailyTimer = setTimeout(() => {
			dailyTimer = null;
			void tick();
		}, Math.max(1, delay));
		dailyTimer.unref?.();
	}

	async function tick() {
		if (stopped || !started) return;
		if (dailyRunning) {
			// A batch that crossed the deadline must not overlap the next one.
			scheduleDaily(Math.min(dayMs, 60000));
			return;
		}
		const result = await runWarm();
		// A playback-deferred attempt retries soon rather than waiting a full day.
		if (dailyTimer) { clearTimeout(dailyTimer); dailyTimer = null; }
		scheduleDaily(result.deferred ? 10 * 60000 : dayMs);
	}

	function start(list = []) {
		warmers = normalizeWarmers(list);
		if (stopped) return status();
		if (started) {
			// A later source/config generation is picked up by overdue().
			return status();
		}
		started = true;
		// Startup catch-up: overdue entries refresh without waiting for a visit.
		// A provisional timer is visible immediately; tick() replaces it with the
		// retry interval when playback deferred the batch.
		scheduleDaily(dayMs);
		void tick();
		return status();
	}

	function stop() {
		stopped = true;
		started = false;
		warmers = [];
		if (dailyTimer) { clearTimeout(dailyTimer); dailyTimer = null; }
		for (const waiter of queue.splice(0)) { clearTimeout(waiter.timer); waiter.reject(queueError('Discovery is stopping.')); }
		for (const task of inflight.values()) {
			task.cancelled = true;
			task.controller.abort(queueError('Discovery is stopping.'));
		}
		checkIdle();
	}

	function status() {
		let loads = 0;
		let quarantined = 0;
		for (const task of inflight.values()) {
			if (task.admitted && !task.settled) loads++;
			if (task.admitted && task.timedOut && !task.settled) quarantined++;
		}
		return {
			entries: entries.size,
			active,
			queued: queue.length,
			inflight: loads,
			quarantined,
			scheduled: Boolean(dailyTimer),
			running: dailyRunning,
			lastDailyAt,
			warmers: warmers.length,
			schema
		};
	}

	return {
		get, start, stop, tick, status, whenIdle,
		// Manual owner refresh reuses the same TTL/admission path as the daily
		// clock. It never starts a second scheduler and never forces a rebuild.
		warmNow: async () => {
			if (!started || stopped) return { ran: 0, failed: 0, skipped: 0, deferred: false, notStarted: true };
			return runWarm();
		},
		flush: () => writing,
		generation: () => refreshGeneration(),
		// Test/diagnostic helper: the public payload as it would be stored.
		sanitize: sanitizeSnapshot
	};
}
