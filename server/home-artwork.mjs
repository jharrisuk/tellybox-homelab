/**
 * Bounded artwork warming for the Home feed.
 *
 * Home rows are built from the shared catalogue, which applies only cached VOD
 * metadata. A streamed card that has never been opened therefore falls back to
 * the provider artwork route even when TMDB has a usable poster. This module
 * selects a bounded sample of the cards that are about to be displayed, asks the
 * existing metadata service to warm them once, and merges only the resolved
 * presentation copies back into the feed that was just built. A second, request
 * free pass applies metadata that has become cached since the previous call, and
 * the returned `remaining` counts only cards that are still unresolved.
 *
 * It never fetches metadata itself, never mutates the shared catalogue or a
 * metadata cache entry, and never returns identifiers: the caller only gets
 * plain counts for the availability payload.
 */
export const HOME_ARTWORK_LIMIT = 24;

// Recently added is checked first so that row can never be starved by earlier,
// larger rails. Unlisted rows keep their display order after the known ones.
const ROW_PRIORITY = new Map(['new', 'for-you', 'continue', 'favourites', 'genre', 'films', 'series', 'top']
	.map((id, index) => [id, index]));
// The kind segment is the home artwork route the card already uses. Local
// `/images/...` artwork and existing `/api/web/tmdb-art/...` copies are not
// provider routes, so they are excluded by the same test.
const PROVIDER_ARTWORK = /^\/api\/web\/art\/(movie|series)\//i;

function normalizeLimit(value, fallback = HOME_ARTWORK_LIMIT) {
	if (value === undefined) return fallback;
	const number = Number(value);
	return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

function boundedWait(value) {
	const number = Number(value);
	if (!Number.isFinite(number)) return 150;
	return Math.min(1500, Math.max(0, Math.round(number)));
}

function isCandidate(item, permitted) {
	if (!item || (item.Type !== 'Movie' && item.Type !== 'Series')) return false;
	if (!item.Id) return false;
	const tmdb = Number(item.ProviderIds?.Tmdb);
	if (!Number.isSafeInteger(tmdb) || tmdb <= 0) return false;
	const artwork = typeof item.Artwork === 'string' ? item.Artwork : '';
	if (artwork && !PROVIDER_ARTWORK.test(artwork)) return false;
	try {
		return Boolean(permitted(item));
	} catch {
		return false;
	}
}

/**
 * Select the displayed cards whose artwork can still be improved, in the order
 * the warmer should spend its bounded budget. Pure: never mutates the feed.
 */
export function homeArtworkCandidates(feed, { limit = HOME_ARTWORK_LIMIT, permitted = () => true } = {}) {
	const max = normalizeLimit(limit);
	if (!max) return [];
	const rows = (Array.isArray(feed?.rows) ? feed.rows : [])
		.map((row, index) => ({ row, index }))
		.sort((a, b) => (ROW_PRIORITY.get(a.row?.id) ?? 99) - (ROW_PRIORITY.get(b.row?.id) ?? 99) || a.index - b.index);
	const seen = new Set();
	const out = [];
	const take = item => {
		if (out.length >= max) return;
		if (!isCandidate(item, permitted)) return;
		const id = String(item.Id);
		if (seen.has(id)) return;
		seen.add(id);
		out.push(item);
	};
	for (const { row } of rows) {
		for (const item of Array.isArray(row?.items) ? row.items : []) {
			if (out.length >= max) return out;
			take(item);
		}
	}
	for (const item of Array.isArray(feed?.featured) ? feed.featured : []) {
		if (out.length >= max) break;
		take(item);
	}
	return out;
}

/** Replace feed entries by Id with the copies the metadata service returned. */
function mergeFeed(feed, enriched) {
	if (!feed || !Array.isArray(enriched) || !enriched.length) return;
	const resolved = new Map();
	for (const item of enriched) {
		if (item?.Id) resolved.set(String(item.Id), item);
	}
	if (!resolved.size) return;
	const replace = (items, index) => {
		const item = items[index];
		if (!item?.Id) return;
		const copy = resolved.get(String(item.Id));
		if (copy && copy !== item) items[index] = copy;
	};
	for (const row of Array.isArray(feed.rows) ? feed.rows : []) {
		if (!Array.isArray(row?.items)) continue;
		for (let index = 0; index < row.items.length; index++) replace(row.items, index);
	}
	if (Array.isArray(feed.featured)) {
		for (let index = 0; index < feed.featured.length; index++) replace(feed.featured, index);
	}
}

export function createHomeArtwork({ metadata, limit = HOME_ARTWORK_LIMIT, waitMs = 150 } = {}) {
	if (!metadata || typeof metadata.state !== 'function' || typeof metadata.enrich !== 'function') {
		throw new TypeError('createHomeArtwork requires a metadata service with state and enrich.');
	}
	const max = normalizeLimit(limit);
	const wait = boundedWait(waitMs);
	// A metadata service is trusted, but one unusual item must never break Home.
	const stateOf = item => {
		try {
			const value = metadata.state(item);
			return typeof value === 'string' ? value : '';
		} catch {
			return '';
		}
	};
	async function enrich(feed, { permitted, waitMs } = {}) {
		const visible = homeArtworkCandidates(feed, { limit: max * 4, permitted });
		const counts = { pending: 0, requested: 0, resolved: 0, failed: 0, visible: visible.length, remaining: 0, limit: max };
		if (!visible.length) return counts;
		const selected = [];
		for (const item of visible) {
			if (selected.length >= max) break;
			if (stateOf(item) === 'missing') selected.push(item);
		}
		counts.requested = selected.length;
		// A per-call override lets the initial Home route skip metadata waiting
		// while an on-demand artwork check may still spend a small bounded wait.
		const waitFor = waitMs === undefined ? wait : boundedWait(waitMs);
		if (selected.length) {
			try {
				const enriched = await metadata.enrich(selected, { waitMs: waitFor });
				mergeFeed(feed, enriched);
			} catch {
				// Availability is advisory: Home still renders the provider route.
			}
		}
		// Apply already-cached metadata to every visible card without requesting
		// anything. A lookup still in flight on an earlier call settles into the
		// cache here, so its TMDB artwork reaches the feed even though it is no
		// longer selected and no further enrichment is requested.
		if (typeof metadata.cached === 'function') {
			try {
				mergeFeed(feed, await metadata.cached(visible));
			} catch {
				// Cached application is advisory too: keep the provider route.
			}
		}
		for (const item of visible) {
			const state = stateOf(item);
			if (state === 'pending') counts.pending += 1;
			else if (state === 'cached') counts.resolved += 1;
			else if (state === 'failed') counts.failed += 1;
			// Missing work and in-flight work both keep the bounded continuation
			// alive; settled failures and settled cache entries do not.
			if (state === 'missing' || state === 'pending') counts.remaining += 1;
		}
		return counts;
	}
	return { enrich };
}
