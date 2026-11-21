// Real episodes for explicitly liked series.
//
// Home asks for a small, explicit set of series ids and receives only episodes
// that exist in the local Jellyfin catalogue or the streamed catalogue. Nothing
// is inferred from a title, a calendar, another series or the viewer's history.
// The caller owns finish/watched filtering; this module only proves existence.

export const MAX_SERIES = 50;
export const MAX_EPISODES = 120;
export const PER_SERIES_LIMIT = 60;
// A targeted anchor lookup is allowed a wider (still finite) per-series read so
// an early unfinished episode of a long show is resolvable. It is bounded, one
// upstream read per explicitly requested series, never a catalogue fan-out.
export const ANCHOR_FETCH_LIMIT = 400;
export const MAX_ANCHORS = 50;
// Keep a few already-aired neighbours on each side of the anchor so Continue can
// verify the exact remembered episode and Next can compare against the furthest
// watched row without the newest-60 window hiding it.
export const ANCHOR_BEFORE = 3;
export const ANCHOR_AFTER = 12;
export const LOOKUP_TIMEOUT_MS = 4000;
// One deadline for the whole /api/web/releases/episodes answer, including the
// remote catalogue policy snapshot and the episode lookup. Partial results from
// series that finished in time are kept; nothing new may start afterwards.
export const REQUEST_TIMEOUT_MS = 2000;
// One process-wide upstream cap. Jellyfin and vod-library calls cannot be
// aborted, so this cap (plus the bounded queue) is the safety boundary rather
// than a bigger timeout.
export const ADMISSION_LIMIT = 4;
export const ADMISSION_QUEUE_LIMIT = 64;
const CONCURRENCY = 4;
const MAX_PARAM_LENGTH = 2048;
// Jellyfin ids and the streamed series ids minted by vod-library. No other
// shape is accepted, so a caller can never smuggle a URL or provider path here.
const SERIES_ID = /^(?:[a-f0-9-]{32,36}|dispatch-series-[1-9]\d*)$/i;

/**
 * Parse the `series` query value.
 *
 * `{ids: []}` means "no series asked for" and is a safe empty response, not an
 * error. A malformed member, an empty member between commas, an oversized list
 * or a non-string value is rejected so the route can answer 400.
 */
export function parseSeriesIds(value) {
	if (value === undefined || value === null || value === '') return { ids: [] };
	if (typeof value !== 'string') return { error: 'Invalid series list.' };
	if (value.length > MAX_PARAM_LENGTH) return { error: 'Too many series were requested.' };
	const ids = [], seen = new Set();
	for (const part of value.split(',')) {
		const id = part.trim();
		if (!id || !SERIES_ID.test(id)) return { error: 'Invalid series identifier.' };
		const key = id.toLowerCase();
		if (seen.has(key)) continue;
		if (ids.length >= MAX_SERIES) return { error: `At most ${MAX_SERIES} series can be requested.` };
		seen.add(key);
		ids.push(id);
	}
	return { ids };
}

/**
 * Parse the optional `anchors` query value: `seriesId:season:number`, comma
 * separated. An anchor is a bounded request for the neighbourhood of one
 * exact episode, so an old unfinished episode of a long show can be resolved
 * without asking for an unbounded catalogue. Season/number 0:0 means "from the
 * beginning of the series". Ids use the same strict shape as the series list.
 */
export function parseAnchors(value) {
	if (value === undefined || value === null || value === '') return { anchors: [] };
	if (typeof value !== 'string') return { error: 'Invalid episode anchors.' };
	if (value.length > MAX_PARAM_LENGTH) return { error: 'Too many episode anchors were requested.' };
	const anchors = [], seen = new Set();
	for (const part of value.split(',')) {
		const text = part.trim();
		if (!text) return { error: 'Invalid episode anchor.' };
		const fields = text.split(':');
		if (fields.length !== 3) return { error: 'Invalid episode anchor.' };
		const seriesId = fields[0].trim();
		if (!SERIES_ID.test(seriesId)) return { error: 'Invalid episode anchor series.' };
		const season = Number(fields[1]), number = Number(fields[2]);
		if (!Number.isInteger(season) || !Number.isInteger(number)
			|| season < 0 || season > 9999 || number < 0 || number > 9999) {
			return { error: 'Invalid episode anchor position.' };
		}
		const key = seriesId.toLowerCase() + ':' + season + ':' + number;
		if (seen.has(key)) continue;
		if (anchors.length >= MAX_ANCHORS) return { error: `At most ${MAX_ANCHORS} episode anchors can be requested.` };
		seen.add(key);
		anchors.push({ seriesId, season, number });
	}
	return { anchors };
}

// Shared by every request handled by this process. A slot is only released
// when the upstream promise settles, never when the caller stops waiting, so
// timed-out calls stay inside the same cap instead of piling up behind it.
const admission = { active: 0, limit: ADMISSION_LIMIT, queue: [], queueLimit: ADMISSION_QUEUE_LIMIT };

/** Read-only view of the shared admission, for diagnostics and tests. */
export function homeEpisodeAdmissionState() {
	return { active: admission.active, queued: admission.queue.length, limit: admission.limit };
}

function releaseSlot() {
	admission.active = Math.max(0, admission.active - 1);
	drainAdmission();
}

/**
 * Take one shared admission slot, waiting in a bounded FIFO queue.
 *
 * Resolves a release function, or null when the caller's own deadline passes
 * while still queued. A queued waiter is dropped at its deadline, so work for a
 * request that has already been answered can never start later; a full queue
 * also sheds load instead of growing without bound.
 */
function acquireSlot(deadline) {
	return new Promise(resolve => {
		const waiter = { deadline, done: false, resolve, timer: null };
		const now = Date.now();
		if (now >= deadline) {
			waiter.done = true;
			return resolve(null);
		}
		if (admission.active < admission.limit) {
			waiter.done = true;
			admission.active++;
			return resolve(releaseSlot);
		}
		if (admission.queue.length >= admission.queueLimit) {
			waiter.done = true;
			return resolve(null);
		}
		admission.queue.push(waiter);
		waiter.timer = setTimeout(() => {
			if (waiter.done) return;
			waiter.done = true;
			const index = admission.queue.indexOf(waiter);
			if (index >= 0) admission.queue.splice(index, 1);
			resolve(null);
		}, Math.max(0, deadline - Date.now()));
		waiter.timer.unref?.();
	});
}

function drainAdmission(now = Date.now()) {
	while (admission.active < admission.limit && admission.queue.length) {
		const waiter = admission.queue.shift();
		if (waiter.done) continue;
		clearTimeout(waiter.timer);
		if (now >= waiter.deadline) {
			// The request is already answered: its remaining work must expire
			// rather than start a late upstream call.
			waiter.done = true;
			waiter.resolve(null);
			continue;
		}
		waiter.done = true;
		admission.active++;
		waiter.resolve(releaseSlot);
	}
}

/**
 * Run one upstream thunk inside the shared process-wide admission.
 *
 * The thunk is admitted before it starts. A queued thunk whose request
 * deadline passes is dropped and never contacts an upstream. The slot is held
 * until the thunk's promise actually settles, including after the caller has
 * stopped waiting; callers are expected to race this promise against their own
 * deadline and report a partial answer rather than release the slot early.
 *
 * Resolves `{ value }`, `{ error }`, or `{ admitted: false }` when the
 * deadline or a full queue prevented admission. It never throws for an
 * upstream rejection.
 */
export function runHomeUpstream(work, deadline) {
	if (typeof work !== 'function') return Promise.reject(new TypeError('An upstream thunk is required.'));
	const at = Number(deadline);
	const limit = Number.isFinite(at) ? at : Date.now();
	return acquireSlot(limit).then(release => {
		if (!release) return { admitted: false };
		const settled = Promise.resolve().then(async () => {
			if (Date.now() >= limit) return { admitted: false };
			try { return { value: await work() }; }
			catch (error) { return { error }; }
		});
		// The slot belongs to the upstream call, not to this caller's deadline.
		settled.then(release, release);
		return settled;
	});
}

/** Resolve to null at `ms`, leaving the underlying promise untouched. */
function within(promise, ms) {
	if (!(ms > 0)) return Promise.resolve(null);
	let timer;
	return Promise.race([
		promise,
		new Promise(resolve => {
			timer = setTimeout(() => resolve(null), ms);
			timer.unref?.();
		})
	]).finally(() => clearTimeout(timer));
}

/**
 * Await `promise` no later than the absolute `deadline`.
 *
 * Resolves null once the deadline passes. The underlying work is not aborted
 * (the provider clients have no abort), but the caller stops waiting; combined
 * with single-flight reads and the shared admission cap this cannot grow.
 */
export function untilDeadline(promise, deadline) {
	return within(promise, Number(deadline) - Date.now());
}

function timeValue(item) {
	const value = Date.parse(item?.PremiereDate || '');
	return Number.isFinite(value) ? value : -Infinity;
}

function numberValue(value) {
	return Number.isInteger(value) ? value : -1;
}

/** Newest premiere first, then newest season/episode, then id for stability. */
export function episodeOrder(a, b) {
	return timeValue(b) - timeValue(a)
		|| numberValue(b?.ParentIndexNumber) - numberValue(a?.ParentIndexNumber)
		|| numberValue(b?.IndexNumber) - numberValue(a?.IndexNumber)
		|| String(a?.Id || '').localeCompare(String(b?.Id || ''));
}

function episodeAvailable(item, seriesId, now, scope) {
	if (!item || item.Type !== 'Episode') return false;
	if (typeof item.Id !== 'string' || !item.Id) return false;
	if (item.IsVirtualItem === true || item.IsMissing === true || item.IsUnaired === true) return false;
	// A Jellyfin ParentId query must only return that parent's episodes. The
	// library path may resolve a local canonical id to its merged local+VOD
	// series, so those items keep their real SeriesId instead of being forced
	// back onto the requested id.
	if (scope === 'parent' && item.SeriesId !== undefined && item.SeriesId !== null
		&& String(item.SeriesId).toLowerCase() !== String(seriesId).toLowerCase()) return false;
	const premiere = Date.parse(item.PremiereDate || '');
	if (Number.isFinite(premiere) && premiere > now) return false;
	return true;
}

/**
 * Merge per-series episode groups into a bounded, deduplicated, newest-first
 * list. A group without a real SeriesName is skipped rather than inventing one.
 */
export function selectHomeEpisodes(groups, { now = Date.now(), limit = MAX_EPISODES, perSeries = PER_SERIES_LIMIT } = {}) {
	const requested = Number(limit);
	const cap = Math.max(0, Math.min(MAX_EPISODES, Number.isSafeInteger(requested) ? requested : MAX_EPISODES));
	const perRequested = Number(perSeries);
	const per = Math.max(1, Math.min(PER_SERIES_LIMIT, Number.isSafeInteger(perRequested) ? perRequested : PER_SERIES_LIMIT));
	const seen = new Set(), selected = [];
	for (const group of Array.isArray(groups) ? groups : []) {
		const seriesId = typeof group?.seriesId === 'string' ? group.seriesId : '';
		if (!seriesId) continue;
		const fallbackName = String(group?.seriesName || '').trim();
		const real = (Array.isArray(group?.items) ? group.items : [])
			.filter(item => episodeAvailable(item, seriesId, now, group?.scope === 'series' ? 'series' : 'parent')).sort(episodeOrder);
		let kept = 0;
		for (const item of real) {
			if (kept >= per) break;
			const id = String(item.Id);
			if (seen.has(id)) continue;
			const seriesName = String(item.SeriesName || fallbackName).trim();
			if (!seriesName) continue;
			seen.add(id);
			selected.push({ ...item, SeriesId: String(item.SeriesId || seriesId), SeriesName: seriesName });
			kept++;
		}
	}
	selected.sort(episodeOrder);
	return selected.slice(0, cap);
}

/** Oldest regular episode first; unnumbered rows last so they never become a next anchor. */
function episodeOrderAscending(a, b) {
	const as = numberValue(a?.ParentIndexNumber), bs = numberValue(b?.ParentIndexNumber);
	if (as !== bs) return as - bs;
	const an = numberValue(a?.IndexNumber), bn = numberValue(b?.IndexNumber);
	if (an !== bn) return an - bn;
	return timeValue(a) - timeValue(b)
		|| String(a?.Id || '').localeCompare(String(b?.Id || ''));
}

function anchorKey(seriesId, season, number) {
	return String(seriesId).toLowerCase() + ':' + season + ':' + number;
}

/**
 * Resolve each requested anchor to a bounded window of already-aired episodes
 * around that exact season/number. This keeps the newest-60 homepage window
 * from hiding an early unfinished episode or the true next episode.
 *
 * Returns `{items, anchors, series}`:
 *  - anchors: one record per requested anchor with found/before/after facts;
 *  - series: one record per fetched show with completeness for the request.
 * A show whose upstream group is missing never appears in `series` and is left
 * unknown by the caller rather than being claimed all-caught-up.
 */
export function selectHomeEpisodeWindow(groups, { now = Date.now(), limit = MAX_EPISODES, anchors = [] } = {}) {
	const requested = Number(limit);
	const cap = Math.max(0, Math.min(MAX_EPISODES, Number.isSafeInteger(requested) ? requested : MAX_EPISODES));
	const wanted = new Map();
	for (const anchor of Array.isArray(anchors) ? anchors : []) {
		const key = String(anchor?.seriesId || '').toLowerCase();
		if (!key) continue;
		if (!wanted.has(key)) wanted.set(key, []);
		wanted.get(key).push(anchor);
	}
	const anchorResults = new Map(), seriesResults = new Map(), seen = new Set();
	// Exact requested targets are collected first. The final display cap may only
	// trim optional neighbours; it must never remove a target the metadata calls
	// found. With the bounded anchor cap (50) every core target fits.
	const core = [], near = [], legacy = [];
	const add = (bucket, item, seriesId, fallbackName) => {
		const id = String(item?.Id || '');
		if (!id || seen.has(id)) return;
		const seriesName = String(item.SeriesName || fallbackName || '').trim();
		if (!seriesName) return;
		seen.add(id);
		bucket.push({ ...item, SeriesId: String(item.SeriesId || seriesId), SeriesName: seriesName });
	};
	for (const group of Array.isArray(groups) ? groups : []) {
		const seriesId = typeof group?.seriesId === 'string' ? group.seriesId : '';
		if (!seriesId) continue;
		const fallbackName = String(group?.seriesName || '').trim();
		const real = (Array.isArray(group?.items) ? group.items : [])
			.filter(item => episodeAvailable(item, seriesId, now, group?.scope === 'series' ? 'series' : 'parent'))
			.sort(episodeOrderAscending);
		const seriesAnchors = wanted.get(seriesId.toLowerCase());
		if (!seriesAnchors) {
			// Unanchored series keep the existing newest-window semantics; this is
			// the web Home path and must not change.
			for (const item of [...real].sort(episodeOrder).slice(0, PER_SERIES_LIMIT)) add(legacy, item, seriesId, fallbackName);
			continue;
		}
		const picked = new Set(), exact = new Set();
		for (const anchor of seriesAnchors) {
			const season = Number(anchor.season) || 0, number = Number(anchor.number) || 0;
			let index = 0;
			if (season > 0 && number > 0) {
				index = real.findIndex(item => {
					const s = numberValue(item.ParentIndexNumber), n = numberValue(item.IndexNumber);
					return s > season || (s === season && n >= number);
				});
				if (index < 0) index = real.length;
			}
			const target = season > 0 && number > 0
				? real.find(item => numberValue(item.ParentIndexNumber) === season && numberValue(item.IndexNumber) === number)
				: null;
			const found = Boolean(target);
			// The authoritative immediate successor is protected with the resume
			// target. Without it a display cap could drop E31..E35 and Android
			// would legitimately pick the next surviving row (E36).
			let successor = null;
			if (season > 0 && number > 0) {
				for (const item of real) {
					const s = numberValue(item.ParentIndexNumber), n = numberValue(item.IndexNumber);
					if (s < season || (s === season && n <= number)) continue;
					if (successor === null || s < numberValue(successor.ParentIndexNumber)
						|| (s === numberValue(successor.ParentIndexNumber) && n < numberValue(successor.IndexNumber))) successor = item;
				}
			}
			const start = Math.max(0, index - ANCHOR_BEFORE);
			const end = Math.min(real.length, index + ANCHOR_AFTER + (found ? 1 : 0));
			for (let i = start; i < end; i += 1) {
				picked.add(real[i]);
				if (real[i] === target) exact.add(real[i]);
			}
			if (successor) exact.add(successor);
			anchorResults.set(anchorKey(seriesId, season, number), {
				seriesId, season, number, found,
				hasBefore: index > 0,
				hasAfter: found ? index + 1 < real.length : index < real.length
			});
		}
		// Core target first, then the surrounding context.
		for (const item of exact) add(core, item, seriesId, fallbackName);
		for (const item of picked) if (!exact.has(item)) add(near, item, seriesId, fallbackName);
		// Completeness is upstream fact, never inferred from "group exists".
		// A notice, a partial/failed marker, or a capped ParentId read is unknown.
		const complete = group?.complete !== false && group?.incomplete !== true
			&& group?.truncated !== true && !group?.notice;
		seriesResults.set(seriesId.toLowerCase(), {
			seriesId, complete,
			...(group?.truncated === true || group?.incomplete === true ? { truncated: true } : {})
		});
	}
	const outputAnchors = [];
	for (const anchor of Array.isArray(anchors) ? anchors : []) {
		const key = anchorKey(anchor.seriesId, anchor.season, anchor.number);
		const found = anchorResults.get(key);
		outputAnchors.push(found || {
			seriesId: anchor.seriesId, season: anchor.season, number: anchor.number,
			found: false, hasBefore: false, hasAfter: false
		});
	}
	// Optional context is newest-first; core targets keep their request order.
	const items = [...core];
	for (const item of [...near, ...legacy].sort(episodeOrder)) {
		if (items.length >= cap) break;
		items.push(item);
	}
	return { items, anchors: outputAnchors, series: [...seriesResults.values()] };
}

/**
 * Create the bounded lookup used by GET /api/web/releases/episodes.
 *
 * Each requested id costs one bounded library lookup. A local canonical id uses
 * the library episode path so the merged local+VOD list is preserved (the
 * Jellyfin ParentId query cannot see a VOD-only episode); a scoped ParentId
 * query remains as a fallback for a local series the library cannot resolve,
 * and only while this request still has time left. There is no whole-library
 * episode query and no fabricated relationship. A slow or missing source yields
 * no episodes for that show.
 *
 * `lookup(ids, {deadline})` accepts an absolute deadline so the route can keep
 * its catalogue policy snapshot and this lookup inside one budget.
 */
export function createHomeEpisodeLookup({ jelly, userId, library, timeoutMs = LOOKUP_TIMEOUT_MS, concurrency = CONCURRENCY, perSeries = PER_SERIES_LIMIT } = {}) {
	async function queryParent(seriesId, limit = perSeries, ascending = false) {
		const id = typeof userId === 'function' ? userId() : userId;
		const query = new URLSearchParams({
			UserId: id || '', ParentId: seriesId, Recursive: 'true', IncludeItemTypes: 'Episode',
			IsMissing: 'false', IsUnaired: 'false', Fields: 'Overview,Genres,PrimaryImageAspectRatio',
			SortBy: ascending ? 'ParentIndexNumber,IndexNumber' : 'PremiereDate',
			SortOrder: ascending ? 'Ascending' : 'Descending', Limit: String(limit)
		});
		const data = await jelly('/Items?' + query);
		const items = Array.isArray(data?.Items) ? data.Items : [];
		// A capped read is not a complete inventory. 501+ episode shows must stay
		// unknown rather than being called complete from the fixed fetch bound.
		return { seriesId, scope: 'parent', seriesName: '', items,
			...(ascending && items.length >= limit ? { truncated: true } : {}) };
	}
	async function querySeries(seriesId, deadline, limit = perSeries, ascending = false) {
		if (/^dispatch-series-/i.test(seriesId)) {
			// The streamed catalogue owns this id. A failure here is one skipped
			// show, never a failed Home response.
			const value = await library.episodes(seriesId);
			const notice = typeof value?.notice === 'string' ? value.notice : '';
			return { seriesId, scope: 'series', seriesName: '',
				items: Array.isArray(value?.items) ? value.items : [], ...(notice ? { notice } : {}) };
		}
		// A local canonical id may be merged with a streamed series. The library
		// returns that merged list with each item's real SeriesId/SeriesName and
		// local copies keeping Source 'local' (and local wins a shared episode
		// number). Only a library miss falls back to the scoped Jellyfin query.
		let items = [], notice = '';
		let libraryFailed = false;
		try {
			const merged = await library.episodes(seriesId);
			if (Array.isArray(merged?.items)) items = merged.items;
			if (typeof merged?.notice === 'string') notice = merged.notice;
		} catch { libraryFailed = true; }
		if (items.length) return { seriesId, scope: 'series', seriesName: '', items, ...(notice ? { notice } : {}) };
		// A library miss that settles after this request was answered must not
		// start a new Jellyfin query: the late miss is a truthful empty group.
		if (!(deadline - Date.now() > 0)) return { seriesId, scope: 'parent', seriesName: '', items: [], incomplete: libraryFailed };
		const fallback = await queryParent(seriesId, limit, ascending);
		// An empty answer after the library itself failed is unknown, not proof
		// that the show has no episodes. The caller must not mark it all-caught-up.
		if (libraryFailed && !fallback.items.length) fallback.incomplete = true;
		return fallback;
	}
	async function fetchOne(seriesId, deadline, limit, ascending) {
		const remaining = () => deadline - Date.now();
		if (remaining() <= 0) return null;
		// Start the upstream work only after admission so a queued request that
		// expires never contacts Jellyfin or the streamed catalogue.
		const outcome = await within(runHomeUpstream(() => querySeries(seriesId, deadline, limit, ascending), deadline), remaining());
		if (!outcome || outcome.admitted === false) return null;
		if (outcome.error) throw outcome.error;
		return outcome.value;
	}
	return async function lookup(seriesIds, options = {}) {
		const ids = [...new Set((Array.isArray(seriesIds) ? seriesIds : [])
			.filter(id => typeof id === 'string' && id))].slice(0, MAX_SERIES);
		if (!ids.length) return options?.anchors?.length ? { items: [], anchors: [], series: [] } : [];
		// An absolute deadline lets the route put the catalogue policy snapshot
		// and this lookup inside one budget; otherwise a per-request timeout is
		// used.
		const absolute = Number(options?.deadline);
		const deadline = Number.isFinite(absolute)
			? absolute
			: Date.now() + Math.max(250, Number(timeoutMs) || LOOKUP_TIMEOUT_MS);
		const anchors = Array.isArray(options?.anchors) ? options.anchors.slice(0, MAX_ANCHORS) : [];
		const anchored = new Set(anchors.map(anchor => String(anchor?.seriesId || '').toLowerCase()).filter(Boolean));
		const groups = new Array(ids.length);
		let cursor = 0;
		async function worker() {
			while (cursor < ids.length && Date.now() < deadline) {
				const index = cursor++;
				const id = ids[index];
				const targeted = anchored.has(id.toLowerCase());
				try {
					const group = await fetchOne(id, deadline, targeted ? ANCHOR_FETCH_LIMIT : perSeries, targeted);
					if (group) groups[index] = group;
				} catch {}
			}
		}
		const workers = Math.max(1, Math.min(8, ids.length, Number.isSafeInteger(concurrency) && concurrency > 0 ? concurrency : CONCURRENCY));
		await Promise.all(Array.from({ length: workers }, () => worker()));
		// Series that completed before the deadline keep their episodes; the
		// rest are simply absent from this truthful, partial answer.
		if (anchors.length) {
			const result = selectHomeEpisodeWindow(groups.filter(Boolean), { now: Date.now(), anchors, limit: options?.limit });
			const known = new Map(result.series.map(group => [group.seriesId.toLowerCase(), group]));
			// Never rewrite an upstream partial/unknown group into complete. A
			// series that produced no group at all is unknown, not complete.
			result.series = ids.map(id => known.get(id.toLowerCase()) || { seriesId: id, complete: false });
			return result;
		}
		return selectHomeEpisodes(groups.filter(Boolean), { now: Date.now(), perSeries });
	};
}

/**
 * A short-TTL, single-flight snapshot of the shared catalogue.
 *
 * Only catalogue data is cached. A viewer's permission decision is always
 * re-evaluated per request and per episode, so one viewer's allowance can never
 * be reused for another. A failed read is not cached.
 */
export function createCatalogueSnapshot({ read, ttlMs = 5000, now = Date.now } = {}) {
	if (typeof read !== 'function') throw new TypeError('A catalogue reader is required.');
	const ttl = Number.isFinite(Number(ttlMs)) && Number(ttlMs) > 0 ? Number(ttlMs) : 5000;
	let value, time = 0, pending;
	return function snapshot() {
		if (value !== undefined && now() - time < ttl) return Promise.resolve(value);
		if (pending) return pending;
		// Call the reader synchronously so simultaneous callers join one
		// read-in-progress rather than scheduling two enumerations.
		let started;
		try {
			started = Promise.resolve(read());
		} catch (error) {
			// A failed read is not cached: the next caller retries.
			return Promise.reject(error);
		}
		pending = started.then(result => {
			value = result;
			time = now();
			return result;
		}).finally(() => { pending = null; });
		return pending;
	};
}
