// Exact unfinished episodes for the Home Continue row.
//
// The Home catalogue carries films and series only. An exact unfinished episode
// exists in the viewer's own evidence: a remote person's activity history, or
// for local/home, the genuinely scoped home activity plus the browser's own
// exact-id progress. This module takes a bounded slice of that evidence,
// resolves the parent series through the existing per-series episode lookup
// (merged local + streamed library, shared admission and one absolute
// deadline), and returns only episodes that really exist and that the caller is
// allowed to see.
//
// It never enumerates the episode library, never scans the catalogue once per
// episode, never maps a series id onto an arbitrary episode, and never returns
// another account's UserData. A series id is returned in `seriesIds` whenever
// the viewer has episode-level progress for it, so the caller can keep the
// series card out of Continue instead of substituting it for the episode.

// Shared process-wide admission for the per-series lookup and the bounded
// single-episode resolver. It is deliberately the same gate so a resolver call
// can never outnumber the upstream cap.
import { runHomeUpstream } from './home-episodes.mjs';

export const HOME_CONTINUE_LIMIT = 8;
export const MAX_CONTINUE_SERIES = 12;
// A duplicate local+streamed copy of one episode is detected after resolution,
// so keep at most two entries per series before the single lookup.
export const MAX_CONTINUE_CANDIDATES = MAX_CONTINUE_SERIES * 2;
export const CONTINUE_LOOKUP_TIMEOUT_MS = 2000;
export const MAX_CLIENT_PROGRESS = 1000;

const SERIES_ALIAS = /^dispatch-series-(\d+)$/i;
const STREAMED_EPISODE = /^dispatch-episode-(\d+)-(\d+)$/i;
// Only fields the Continue card needs, so a shared Jellyfin UserData object or
// a future private field can never ride along from the merged library view.
const EPISODE_FIELDS = ['Name', 'MediaType', 'PremiereDate', 'DateCreated', 'RunTimeTicks', 'Genres',
	'ParentIndexNumber', 'IndexNumber', 'ImageTags', 'BackdropImageTags', 'ParentBackdropItemId',
	'PrimaryImageAspectRatio', 'Artwork', 'BackdropArtwork', 'Source', 'Provider', 'VodIds', 'Overview', 'OfficialRating',
	'CommunityRating', 'ProductionYear', 'ProviderIds'];
const LOCAL_SERIES_ID = /^[a-f0-9-]{32,36}$/i;
const VOD_SERIES_ARTWORK = /^\/api\/web\/art\/series\/[1-9]\d{0,9}(?:\?[^#]*)?$/;
const TMDB_BACKDROP = /^\/api\/web\/tmdb-art\/tv\/\d+\/backdrop$/;

function text(value) {
	return typeof value === 'string' ? value : '';
}

function integer(value) {
	return Number.isInteger(value) ? value : null;
}

function identifier(value) {
	return typeof value === 'string' ? value.toLowerCase() : '';
}

/** Catalogue-only series index. `items` is the caller's already-permitted list. */
function permittedSeries(items) {
	const byId = new Map(), aliases = new Map();
	for (const item of Array.isArray(items) ? items : []) {
		if (item?.Type !== 'Series' || typeof item.Id !== 'string' || !item.Id) continue;
		const id = item.Id;
		const artwork = text(item.Artwork), backdrop = text(item.BackdropArtwork);
		byId.set(id.toLowerCase(), { Id: id, Name: text(item.Name), Artwork: artwork, BackdropArtwork: backdrop,
			// Evidence that the show really has an image. Missing tags/routes stay
			// unknown and must not become invented image URLs.
			hasPrimary: Boolean(item.ImageTags?.Primary) || /^\/images\//i.test(artwork),
			hasBackdrop: Boolean(Array.isArray(item.BackdropImageTags) && item.BackdropImageTags.length) || /^\/images\//i.test(backdrop) });
		aliases.set(id.toLowerCase(), id);
		for (const vodId of Array.isArray(item.VodIds) ? item.VodIds : []) {
			if (/^\d+$/.test(String(vodId))) aliases.set('dispatch-series-' + Number(vodId), id);
		}
	}
	return { byId, aliases };
}

function canonicalSeriesId(seriesId, aliases) {
	if (typeof seriesId !== 'string' || !seriesId) return '';
	const direct = aliases.get(seriesId.toLowerCase());
	if (direct) return direct;
	if (SERIES_ALIAS.test(seriesId)) return aliases.get(seriesId.toLowerCase()) || '';
	return '';
}

function isFinished(entry) {
	if (!entry || entry.completed === true) return true;
	const duration = Math.max(0, Number(entry.duration) || 0);
	const position = Math.max(0, Number(entry.position) || 0);
	if (duration > 0 && position >= Math.max(duration * 0.95, duration - 90)) return true;
	if (entry.state === 'ended' && !(duration > 0)) return true;
	return false;
}

/**
 * True for a genuinely unfinished playback. A completion is excluded, as is an
 * `ended` event without a duration and a position at or beyond the known
 * runtime even when the upstream event did not set `completed`.
 */
function unfinished(entry, watched) {
	if (!entry || typeof entry.itemId !== 'string' || !entry.itemId) return null;
	if (watched.has(entry.itemId.toLowerCase())) return null;
	if (isFinished(entry)) return null;
	const position = Math.max(0, Number(entry.position) || 0);
	if (!(position > 0)) return null;
	return {
		itemId: entry.itemId,
		seriesId: text(entry.seriesId),
		title: text(entry.title),
		position,
		updated: Number(entry.updated) || 0
	};
}

/**
 * Latest event per item id from one trusted history source.
 *
 * `activity.history()` already does this, but tests and future callers may hand
 * raw events. Equal timestamps keep the later entry, matching activity.mjs.
 */
function historyState(history, watched) {
	const latest = new Map(), updates = new Map(), positions = new Map(), seriesIds = new Set();
	for (const entry of Array.isArray(history) ? history : []) {
		if (!entry || typeof entry.itemId !== 'string' || !entry.itemId) continue;
		const key = entry.itemId.toLowerCase();
		const updated = Number(entry.updated) || 0;
		const previous = latest.get(key);
		if (previous && updated < previous.updated) continue;
		latest.set(key, { ...entry, updated });
	}
	const candidates = [], finished = new Map();
	for (const entry of latest.values()) {
		updates.set(entry.itemId, entry.updated);
		if (typeof entry.seriesId === 'string' && entry.seriesId) seriesIds.add(entry.seriesId);
		if (isFinished(entry)) { finished.set(identifier(entry.itemId), entry); continue; }
		const position = Math.max(0, Number(entry.position) || 0);
		if (position > 0) positions.set(entry.itemId, position);
		const candidate = unfinished(entry, watched);
		if (candidate && candidate.seriesId) candidates.push(candidate);
	}
	return { candidates, finished, updates, positions, seriesIds };
}

/** Browser progress has no event timestamp. It is the current local state
 * only when the item has no trusted server event; otherwise the server event
 * timestamp stays authoritative for ordering and completion. */
function clientState(progress, watched, clientUpdated, now, serverUpdated = new Map()) {
	const updates = new Map(), positions = new Map(), candidates = [];
	const entries = progress && typeof progress === 'object' && !Array.isArray(progress)
		? Object.entries(progress).slice(0, MAX_CLIENT_PROGRESS) : [];
	for (const [id, value] of entries) {
		if (typeof id !== 'string' || !id) continue;
		const position = Math.max(0, Number(value) || 0);
		if (!(position > 0)) continue;
		const requested = Number(clientUpdated?.[id]);
		const explicit = Number.isFinite(requested) && requested > 0 ? requested : 0;
		const serverTime = Number(serverUpdated.get(id.toLowerCase())) || 0;
		// A browser entry for an item the server already recorded keeps the
		// server event time. Only a browser-only id is stamped "now", because
		// only then is it the sole evidence of current local state.
		const time = explicit || serverTime || now;
		updates.set(id, Math.max(updates.get(id) || 0, time));
		if (watched.has(id.toLowerCase())) continue;
		positions.set(id, position);
		candidates.push({ itemId: id, seriesId: '', title: '', position, updated: time, explicit, client: true });
	}
	return { candidates, updates, positions };
}

function sameSeries(seriesId, canonical, aliases) {
	if (typeof seriesId !== 'string' || !seriesId) return true;
	const lower = seriesId.toLowerCase();
	if (lower === canonical.toLowerCase()) return true;
	return (aliases.get(lower) || '').toLowerCase() === canonical.toLowerCase();
}

function findEpisode(answer, candidate) {
	for (const item of answer) {
		if (item?.Type === 'Episode' && typeof item.Id === 'string'
			&& item.Id.toLowerCase() === candidate.itemId.toLowerCase()) return item;
	}
	const streamed = STREAMED_EPISODE.exec(candidate.itemId);
	if (!streamed) return null;
	const vodId = Number(streamed[1]);
	for (const item of answer) {
		if (item?.Type !== 'Episode') continue;
		for (const value of Array.isArray(item.VodIds) ? item.VodIds : []) {
			if (Number(value) === vodId) return item;
		}
	}
	return null;
}

/** Build the small episode view the Continue card consumes. */
function episodeView(found, candidate, series) {
	const view = {};
	for (const key of EPISODE_FIELDS) if (found[key] !== undefined) view[key] = found[key];
	const position = Math.max(0, Number(candidate.position) || 0);
	const season = integer(found.ParentIndexNumber);
	const number = integer(found.IndexNumber);
	view.Id = String(found.Id);
	view.Type = 'Episode';
	view.Name = text(found.Name) || text(candidate.title);
	view.SeriesId = series?.Id || candidate.canonicalSeriesId;
	view.SeriesName = text(series?.Name) || text(found.SeriesName);
	if (season !== null) view.ParentIndexNumber = season;
	if (number !== null) view.IndexNumber = number;
	view.Source = found.Source === 'streamed' || found.Source === 'local'
		? found.Source : STREAMED_EPISODE.test(view.Id) ? 'streamed' : 'local';
	view.Artwork = text(found.Artwork);
	view.BackdropArtwork = text(found.BackdropArtwork);
	// The Continue card is titled by the show and paints a backdrop. A local
	// library episode merged with a streamed duplicate inherits that provider's
	// `/api/web/art/series/<vodId>` alias, which answered 404 for the reported
	// local titles and left the card blank. Use the show's working local image
	// routes instead. A streamed parent keeps the episode/series provider routes
	// it already had (the permitted-series index carries no backdrop route).
	const seriesId = series?.Id || candidate.canonicalSeriesId;
	const localParent = LOCAL_SERIES_ID.test(String(seriesId || ''));
	if (localParent) {
		const ownPrimary = text(found.ImageTags?.Primary) && LOCAL_SERIES_ID.test(view.Id) ? view.Id : '';
		if (!view.Artwork || VOD_SERIES_ARTWORK.test(view.Artwork)) {
			// A real episode still or a parent with a known Primary image. If
			// neither exists, keep any working provider route rather than inventing
			// a local URL that may 404.
			if (ownPrimary) view.Artwork = '/images/' + ownPrimary + '/Primary?width=400';
			else if (series?.hasPrimary) view.Artwork = '/images/' + seriesId + '/Primary?width=400';
		}
	}
	if (!view.BackdropArtwork) {
		const knownBackdrop = text(series?.BackdropArtwork);
		if (TMDB_BACKDROP.test(knownBackdrop)) view.BackdropArtwork = knownBackdrop;
		else if (localParent && series?.hasBackdrop) view.BackdropArtwork = '/images/' + seriesId + '/Backdrop?width=1280';
	}
	view._seriesArtwork = text(series?.Artwork);
	view.VodIds = [...new Set((Array.isArray(found.VodIds) ? found.VodIds : []).filter(value => Number.isFinite(Number(value))))];
	// The exact viewer position, never the series position and never a rounded
	// minute. The id above is the exact id used for playback and resume.
	view.UserData = { PlaybackPositionTicks: Math.round(position * 1e7), Played: false };
	view._continueSeriesId = series?.Id || candidate.canonicalSeriesId;
	view._continueUpdated = Math.max(Number(candidate.updated) || 0, Number(candidate.clientUpdated) || 0);
	view._resume = position;
	return view;
}

function episodeKey(episode) {
	const series = String(episode._continueSeriesId || episode.SeriesId || '').toLowerCase();
	const season = integer(episode.ParentIndexNumber);
	const number = integer(episode.IndexNumber);
	if (series && season !== null && number !== null) return series + '|s' + season + '|e' + number;
	if (series) return series + '|name:' + String(episode.Name || '').toLowerCase();
	return 'id:' + String(episode.Id || '').toLowerCase();
}

/** One record per canonical episode. A playable local copy supplies the position. */
function reconcile(records) {
	const merged = new Map();
	for (const record of records) {
		const key = episodeKey(record.episode);
		const previous = merged.get(key);
		if (!previous) { merged.set(key, record); continue; }
		const previousLocal = previous.episode.Source === 'local';
		const currentLocal = record.episode.Source === 'local';
		// A local copy of the same season/episode is preferred over a streamed
		// duplicate. Otherwise the newest event wins, never the largest position.
		const primary = previousLocal ? previous : currentLocal ? record
			: (record.episode._continueUpdated || 0) > (previous.episode._continueUpdated || 0) ? record : previous;
		const other = primary === record ? previous : record;
		const episode = {
			...primary.episode,
			Artwork: primary.episode.Artwork || other.episode.Artwork || primary.episode._seriesArtwork || '',
			Genres: (primary.episode.Genres && primary.episode.Genres.length ? primary.episode.Genres : other.episode.Genres) || [],
			RunTimeTicks: primary.episode.RunTimeTicks || other.episode.RunTimeTicks,
			VodIds: [...new Set([...(primary.episode.VodIds || []), ...(other.episode.VodIds || [])])]
		};
		delete episode._seriesArtwork;
		episode._continueUpdated = Math.max(previous.episode._continueUpdated || 0, record.episode._continueUpdated || 0);
		merged.set(key, { episode, candidate: primary.candidate });
	}
	// One Continue entry per series: the most recent unfinished episode. Two
	// episodes with the same number in different seasons keep their own keys
	// above and are still one card for that series, newest first.
	const bySeries = new Map();
	for (const record of merged.values()) {
		const key = identifier(record.episode._continueSeriesId || record.episode.SeriesId);
		const previous = bySeries.get(key);
		if (!previous || (record.episode._continueUpdated || 0) > (previous.episode._continueUpdated || 0)
			|| (record.episode._continueUpdated === previous.episode._continueUpdated
				&& (record.episode._resume || 0) > (previous.episode._resume || 0))) bySeries.set(key, record);
	}
	return [...bySeries.values()].map(record => {
		const episode = { ...record.episode };
		episode.Artwork = episode.Artwork || episode._seriesArtwork || '';
		delete episode._seriesArtwork;
		return episode;
	})
		.sort((a, b) => (b._continueUpdated || 0) - (a._continueUpdated || 0)
			|| (b._resume || 0) - (a._resume || 0)
			|| String(a.Id).localeCompare(String(b.Id)));
}

/**
 * Race the lookup against the caller's absolute deadline.
 *
 * The underlying lookup is not aborted (its own shared admission keeps it
 * bounded); this caller stops waiting at the deadline and reports a truthful
 * partial status instead of an empty completed answer.
 */
async function boundedCall(work, deadline, now) {
	const remaining = Number(deadline) - now();
	if (!(remaining > 0)) return { timedOut: true, reason: 'deadline' };
	let timer;
	try {
		return await Promise.race([
			Promise.resolve().then(work).then(value => ({ value }), error => ({ error })),
			new Promise(resolve => {
				timer = setTimeout(() => resolve({ timedOut: true, reason: 'timeout' }), remaining);
				timer.unref?.();
			})
		]);
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Resolve episode ids that only the browser named, so the parent series can be
 * discovered. This is bounded to 24 ids, four at a time, all inside the same
 * deadline. It never scans a library and never guesses a series.
 */
async function resolveIds(candidates, resolve, deadline, now, limit) {
	const list = candidates.slice(0, limit), found = [];
	let cursor = 0, errors = 0, timedOut = false;
	if (!resolve) return { found, errors, timedOut: false, unresolved: list.length };
	async function worker() {
		while (cursor < list.length) {
			if (!(deadline - now() > 0)) { timedOut = true; return; }
			const entry = list[cursor++];
			const id = typeof entry === 'string' ? entry : entry.itemId;
			// Admit before starting the real reader. The thunk is not invoked
			// until a process-wide slot is free, and its slot is held until the
			// underlying promise settles, even after this caller has stopped
			// waiting at its deadline.
			const admitted = runHomeUpstream(() => resolve(id), deadline);
			const outcome = await boundedCall(() => admitted, deadline, now);
			if (outcome.timedOut) { timedOut = true; continue; }
			if (outcome.error) { errors++; continue; }
			const result = outcome.value;
			if (!result || result.admitted === false) { timedOut = true; continue; }
			if (result.error) { errors++; continue; }
			if (result.value) found.push({ id, item: result.value });
		}
	}
	await Promise.all(Array.from({ length: Math.min(4, list.length) }, () => worker()));
	return { found, errors, timedOut, unresolved: Math.max(0, list.length - found.length - errors) };
}

function availability(status, reason, fields = {}) {
	const requested = Math.max(0, Number(fields.requested) || 0);
	return {
		status,
		reason,
		requested,
		queried: Math.max(0, Number(fields.queried) || 0),
		resolved: Math.max(0, Number(fields.resolved) || 0),
		missing: Math.max(0, Number(fields.missing) || 0),
		denied: Math.max(0, Number(fields.denied) || 0),
		omitted: Math.max(0, Number(fields.omitted) || 0),
		unresolved: Math.max(0, Number(fields.unresolved) || 0),
		complete: status === 'empty' || status === 'complete'
	};
}

function status(episodes, seriesIds, updates, progress, fields) {
	return { episodes, seriesIds, updates, progress, availability: fields };
}

/**
 * Create the Home Continue helper.
 *
 * `lookup(seriesIds, { deadline })` is the existing bounded per-series episode
 * lookup. `resolve(id, { deadline })` is an optional bounded single-item reader
 * used only for browser progress ids that are not already identified by scoped
 * home activity; it never enumerates a library.
 *
 * Request sources:
 * - remote: `history` (the caller's own activity.history) only. Browser
 *   `clientProgress` and `clientWatched` are deliberately ignored.
 * - local/home: `homeHistory` (activity.history({ local: true, home: true })),
 *   `clientProgress` and `clientWatched`, all scoped to this home browser.
 */
export function createHomeContinue({ lookup, resolve = null, limit = HOME_CONTINUE_LIMIT,
	maxSeries = MAX_CONTINUE_SERIES, timeoutMs = CONTINUE_LOOKUP_TIMEOUT_MS, now = Date.now } = {}) {
	if (typeof lookup !== 'function') throw new TypeError('A series episode lookup is required.');
	const requested = Number(limit);
	const rowLimit = Math.max(1, Math.min(HOME_CONTINUE_LIMIT, Number.isSafeInteger(requested) ? requested : HOME_CONTINUE_LIMIT));
	const requestedSeries = Number(maxSeries);
	const seriesCap = Math.max(1, Math.min(MAX_CONTINUE_SERIES,
		Number.isSafeInteger(requestedSeries) ? requestedSeries : MAX_CONTINUE_SERIES));
	const timeout = Number(timeoutMs) > 0 ? Number(timeoutMs) : CONTINUE_LOOKUP_TIMEOUT_MS;

	return async function continueEpisodes({ items = [], history = [], homeHistory = [], shared = false,
		allowed = () => true, watched = [], clientProgress = {}, clientWatched = [], clientUpdated = {},
		resolve: requestResolve, deadline } = {}) {
		const itemIds = new Set((Array.isArray(items) ? items : [])
			.filter(item => item && typeof item.Id === 'string').map(item => item.Id.toLowerCase()));
		const index = permittedSeries(items);
		const serverWatched = new Set((Array.isArray(watched) ? watched : [])
			.filter(value => typeof value === 'string').map(value => value.toLowerCase()));
		const browserWatched = shared ? new Set((Array.isArray(clientWatched) ? clientWatched : [])
			.filter(value => typeof value === 'string').map(value => value.toLowerCase())) : new Set();
		const filtered = new Set([...serverWatched, ...browserWatched]);
		const absolute = Number(deadline);
		const requestDeadline = Number.isFinite(absolute) ? absolute : now() + timeout;
		const current = now();
		const updates = new Map(), catalogueProgress = new Map(), suppressed = new Set();
		let candidates = [], finished = new Map();
		let unresolvedIds = [], resolveErrors = 0, resolveTimedOut = false;
		const suppressSeries = seriesIds => {
			for (const id of seriesIds) {
				const canonical = canonicalSeriesId(id, index.aliases);
				if (canonical) suppressed.add(canonical);
			}
		};

		if (shared) {
			// Only genuinely scoped home/local history. Never all-person history.
			const home = historyState(homeHistory, filtered);
			for (const [id, value] of home.updates) updates.set(id, Math.max(updates.get(id) || 0, value));
			for (const [id, value] of home.positions) {
				if (itemIds.has(id.toLowerCase())) catalogueProgress.set(id, value);
			}
			suppressSeries(home.seriesIds);
			candidates = home.candidates;
			finished = home.finished;
			const serverTimes = new Map();
			for (const [id, value] of home.updates) serverTimes.set(id.toLowerCase(), value);
			const client = clientState(clientProgress, filtered, clientUpdated, current, serverTimes);
			for (const [id, value] of client.updates) updates.set(id, Math.max(updates.get(id) || 0, value));
			const byId = new Map(candidates.map(candidate => [identifier(candidate.itemId), candidate]));
			for (const candidate of client.candidates) {
				const key = identifier(candidate.itemId);
				const previous = byId.get(key);
				if (previous) {
					// Latest event wins. Browser progress has no timestamp, so it is
					// the current local state unless the caller supplies clientUpdated.
					if (candidate.updated >= previous.updated) byId.set(key, { ...previous, ...candidate,
						seriesId: previous.seriesId, title: previous.title, clientUpdated: candidate.updated });
					else updates.set(candidate.itemId, Math.max(updates.get(candidate.itemId) || 0, previous.updated));
					continue;
				}
				const completed = finished.get(key);
				// Server completion is authoritative unless the caller supplies an
				// explicitly newer browser timestamp (a deliberate rewatch).
				if (completed && !(candidate.explicit > completed.updated)) continue;
				if (itemIds.has(key)) { catalogueProgress.set(candidate.itemId, candidate.position); continue; }
				unresolvedIds.push(candidate);
			}
			candidates = [...byId.values()];
		} else {
			const own = historyState(history, serverWatched);
			for (const [id, value] of own.updates) updates.set(id, Math.max(updates.get(id) || 0, value));
			for (const [id, value] of own.positions) {
				if (itemIds.has(id.toLowerCase())) catalogueProgress.set(id, value);
			}
			suppressSeries(own.seriesIds);
			candidates = own.candidates;
		}
		const progressOut = Object.fromEntries(catalogueProgress);

		if (unresolvedIds.length) {
			const outcome = await resolveIds(unresolvedIds, requestResolve ?? resolve, requestDeadline, now,
				MAX_CONTINUE_CANDIDATES);
			resolveErrors = outcome.errors;
			resolveTimedOut = outcome.timedOut;
			if (outcome.unresolved > 0) resolveErrors += outcome.unresolved;
			const ambiguous = new Map();
			for (const candidate of unresolvedIds.slice(0, MAX_CONTINUE_CANDIDATES)) ambiguous.set(identifier(candidate.itemId), candidate);
			for (const entry of outcome.found) {
				const candidate = ambiguous.get(identifier(entry.id));
				const found = entry.item;
				if (!candidate || found?.Type !== 'Episode' || typeof found.Id !== 'string') continue;
				const canonical = canonicalSeriesId(found.SeriesId, index.aliases);
				if (!canonical) continue; // hidden parent or not an episode of a permitted series
				suppressed.add(canonical);
				candidates.push({ ...candidate, seriesId: canonical });
			}
		}

		// Group by the permitted canonical series, newest evidence first. Keep at
		// most two entries per series so a duplicate local+streamed copy can be
		// reconciled after the lookup.
		const groups = new Map();
		for (const candidate of candidates) {
			const canonical = canonicalSeriesId(candidate.seriesId, index.aliases);
			if (!canonical) continue;
			suppressed.add(canonical);
			const key = canonical.toLowerCase();
			const group = groups.get(key) || { canonical, entries: [] };
			group.entries.push({ ...candidate, canonicalSeriesId: canonical });
			groups.set(key, group);
		}
		const ordered = [...groups.values()].sort((a, b) => {
			const newest = group => group.entries.reduce((value, entry) => Math.max(value, entry.updated), 0);
			return newest(b) - newest(a) || a.canonical.localeCompare(b.canonical);
		});
		const bounded = [];
		for (const group of ordered.slice(0, seriesCap)) {
			group.entries.sort((a, b) => b.updated - a.updated || b.position - a.position
				|| a.itemId.localeCompare(b.itemId));
			bounded.push(...group.entries.slice(0, 2));
		}
		const selected = bounded.slice(0, MAX_CONTINUE_CANDIDATES);
		const omitted = Math.max(0, ordered.length - seriesCap);
		const counts = { requested: selected.length, queried: 0, omitted,
			unresolved: resolveErrors };
		if (!selected.length) {
			if (resolveTimedOut) return status([], [...suppressed], Object.fromEntries(updates), progressOut, availability('partial', 'timeout', counts));
			if (resolveErrors > 0) return status([], [...suppressed], Object.fromEntries(updates), progressOut,
				availability('partial', 'unresolved-progress', counts));
			return status([], [...suppressed], Object.fromEntries(updates), progressOut, availability('empty', '', counts));
		}
		const seriesIds = [...new Map(selected
			.map(candidate => [candidate.canonicalSeriesId.toLowerCase(), candidate.canonicalSeriesId])).values()];
		counts.queried = seriesIds.length;
		const permitted = item => {
			try { return allowed(item) !== false; } catch { return false; }
		};
		if (!(requestDeadline - now() > 0)) {
			return status([], [...suppressed], Object.fromEntries(updates), progressOut, availability('partial', 'deadline', counts));
		}
		const outcome = await boundedCall(() => lookup(seriesIds, { deadline: requestDeadline }), requestDeadline, now);
		if (outcome.error) return status([], [...suppressed], Object.fromEntries(updates), progressOut, availability('failed', 'lookup-error', counts));
		if (outcome.timedOut) return status([], [...suppressed], Object.fromEntries(updates), progressOut,
			availability('partial', outcome.reason || 'timeout', counts));
		const answer = Array.isArray(outcome.value) ? outcome.value
			: Array.isArray(outcome.value?.items) ? outcome.value.items : null;
		if (!answer) return status([], [...suppressed], Object.fromEntries(updates), progressOut, availability('failed', 'lookup-shape', counts));
		const usable = answer.filter(item => item?.Type === 'Episode' && typeof item.Id === 'string' && item.Id);
		const records = [];
		let missing = 0, denied = 0;
		for (const candidate of selected) {
			const found = findEpisode(usable, candidate);
			if (!found || !sameSeries(found.SeriesId, candidate.canonicalSeriesId, index.aliases)) { missing++; continue; }
			const series = index.byId.get(candidate.canonicalSeriesId.toLowerCase()) || null;
			const episode = episodeView(found, candidate, series);
			if (!permitted({ Id: episode.Id, Type: 'Episode', SeriesId: episode.SeriesId })) { denied++; continue; }
			records.push({ episode, candidate });
		}
		const episodes = reconcile(records).slice(0, rowLimit);
		// Even an unresolved or denied candidate keeps its series out of
		// Continue: a series card must never stand in for the exact episode.
		const incomplete = resolveTimedOut ? 'timeout' : resolveErrors > 0 ? 'unresolved-progress' : '';
		return status(episodes, [...suppressed], Object.fromEntries(updates), progressOut,
			availability(incomplete ? 'partial' : 'complete', incomplete,
				{ ...counts, resolved: episodes.length, missing, denied }));
	};
}
