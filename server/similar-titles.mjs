import { canonical, preferences } from './discovery-feeds.mjs';
import { homeItemKey } from './home-feed.mjs';

export const SIMILAR_MIN_LIMIT = 4;
export const SIMILAR_MAX_LIMIT = 12;
export const SIMILAR_DEFAULT_LIMIT = 12;

// Only fields a details card needs. UserData, Overview, provider ids and any
// internal scoring state stay on the server.
const SAFE_FIELDS = ['Id', 'Name', 'Type', 'MediaType', 'Source', 'Provider', 'ProductionYear', 'PremiereDate',
	'DateCreated', 'OfficialRating', 'CommunityRating', 'RunTimeTicks', 'Genres', 'IndexNumber', 'ParentIndexNumber',
	'SeriesName', 'SeriesId', 'ImageTags', 'BackdropImageTags', 'ParentBackdropItemId', 'ParentBackdropImageTags',
	'PrimaryImageAspectRatio', 'Artwork', 'Ratings'];

const STOP_WORDS = new Set(('the and for with from that this into over under after before about their there these those ' +
	'when where while who whom whose what which will would could should have has had they them his her its our your also ' +
	'more most some such only just than then very much many film movie movies series story stories life lives find finds ' +
	'one two three new old his hers').split(' '));

const WORD = /[a-z0-9]+/g;

/** Clamp a requested similar-titles limit to the documented 4-12 range. */
export function similarLimit(value) {
	const number = Number(value);
	if (!Number.isInteger(number)) return SIMILAR_DEFAULT_LIMIT;
	return Math.max(SIMILAR_MIN_LIMIT, Math.min(SIMILAR_MAX_LIMIT, number));
}

function cleanGenres(item) {
	const out = [];
	const seen = new Set();
	for (const value of Array.isArray(item?.Genres) ? item.Genres : []) {
		if (typeof value !== 'string') continue;
		const trimmed = value.trim();
		if (!trimmed) continue;
		const name = canonical(trimmed) || trimmed.slice(0, 40);
		const key = name.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(name);
		if (out.length >= 12) break;
	}
	return out;
}

function overviewTokens(value) {
	const tokens = new Set();
	if (typeof value !== 'string') return tokens;
	const matches = value.toLowerCase().match(WORD) || [];
	for (const word of matches) {
		if (word.length < 4 || STOP_WORDS.has(word)) continue;
		tokens.add(word);
		if (tokens.size >= 80) break;
	}
	return tokens;
}

function keywordTokens(item) {
	const tokens = new Set();
	for (const key of ['Keywords', 'Tags']) {
		const values = Array.isArray(item?.[key]) ? item[key] : typeof item?.[key] === 'string' ? [item[key]] : [];
		for (const value of values) {
			for (const token of overviewTokens(value)) {
				tokens.add(token);
				if (tokens.size >= 40) return tokens;
			}
		}
	}
	return tokens;
}

function ratingConfidence(item) {
	const rating = (item?.Ratings || []).find(entry => Number.isFinite(Number(entry?.value)) && Number(entry?.max || 10) > 0);
	const value = rating ? Number(rating.value) / Number(rating.max || 10) * 10 : Number(item?.CommunityRating) || 0;
	const votes = Number(rating?.votes) || 0;
	return ((value * votes) + 6 * 50) / (votes + 50);
}

function seriesIdFromDispatch(value) {
	const match = /^dispatch-episode-\d+-(\d+)$/.exec(String(value || ''));
	return match ? 'dispatch-series-' + match[1] : '';
}

function itemTmdbKey(item) {
	const tmdb = item?.ProviderIds?.Tmdb;
	if (!/^[1-9][0-9]{0,9}$/.test(String(tmdb || ''))) return '';
	return 'tmdb:' + (item.Type === 'Series' ? 'tv' : 'movie') + ':' + tmdb;
}

function resolveSubject(seed, items) {
	if (!seed || seed.Type !== 'Episode') return seed;
	const wanted = new Set([seed.SeriesId, seriesIdFromDispatch(seed.Id)].filter(value => typeof value === 'string' && value));
	if (wanted.size) {
		const subject = items.find(item => item?.Type === 'Series' && wanted.has(item.Id));
		if (subject) return subject;
	}
	return seed;
}

function identitiesOf(seed, subject) {
	const ids = new Set(), keys = new Set();
	for (const item of [seed, subject]) {
		if (!item) continue;
		if (typeof item.Id === 'string' && item.Id) ids.add(item.Id);
		if (typeof item.SeriesId === 'string' && item.SeriesId) ids.add(item.SeriesId);
		const dispatchSeries = seriesIdFromDispatch(item.Id);
		if (dispatchSeries) ids.add(dispatchSeries);
		try { keys.add(homeItemKey(item)); } catch { /* A malformed fixture cannot add an identity. */ }
		const tmdb = itemTmdbKey(item);
		if (tmdb) keys.add(tmdb);
	}
	return { ids, keys };
}

function matchesIdentity(item, identity) {
	if (!item) return false;
	if (identity.ids.has(item.Id)) return true;
	if (typeof item.SeriesId === 'string' && identity.ids.has(item.SeriesId)) return true;
	try { if (identity.keys.has(homeItemKey(item))) return true; } catch { /* Fall through to provider identity. */ }
	const tmdb = itemTmdbKey(item);
	return Boolean(tmdb && identity.keys.has(tmdb));
}

function normalizedTaste(taste) {
	if (!taste || typeof taste !== 'object') return { genres: [], exclude: [] };
	return {
		genres: Array.isArray(taste.genres) ? taste.genres : [],
		exclude: Array.isArray(taste.exclude) ? taste.exclude : []
	};
}

function safeIds(values, max) {
	if (!Array.isArray(values)) return [];
	return values.filter(value => typeof value === 'string' && value).slice(0, max);
}

/** Positive caller signals only. The seed, or history for the seed, is never
 * treated as evidence that the viewer likes the seed itself. */
function positiveSignals({ prefs, favourites, watched, history, byId, identity }) {
	const signal = new Map();
	const add = (genre, amount) => {
		if (!genre || !(amount > 0)) return;
		signal.set(genre, (signal.get(genre) || 0) + amount);
	};
	for (const [genre, weight] of prefs.weights) if (weight > 0) add(genre, weight);
	const addItem = (id, amount) => {
		const item = byId.get(id);
		if (!item || matchesIdentity(item, identity)) return;
		for (const genre of cleanGenres(item)) add(genre, amount);
	};
	for (const id of new Set(safeIds(favourites, 1000))) addItem(id, 1);
	for (const id of new Set(safeIds(watched, 5000))) addItem(id, 0.4);
	for (const entry of Array.isArray(history) ? history.slice(0, 500) : []) {
		if (!entry || typeof entry !== 'object') continue;
		if (identity.ids.has(entry.itemId) || identity.ids.has(entry.seriesId)) continue;
		for (const genre of Array.isArray(entry.genres) ? entry.genres : []) {
			const name = canonical(genre) || (typeof genre === 'string' ? genre.trim().slice(0, 40) : '');
			add(name, 0.5);
		}
	}
	return signal;
}

function chooseReason(genres, positive, ownSignal = 0) {
	let best = '', bestStrength = 0;
	for (const genre of genres) {
		const strength = Math.max(0, (positive.get(genre) || 0) - ownSignal);
		if (strength > bestStrength) { best = genre; bestStrength = strength; }
	}
	return best ? 'Because you like ' + best.toLowerCase() : 'More like this';
}

/**
 * Rank catalogue films and series against one seed title.
 *
 * One pass over the supplied catalogue. There are no provider calls and no
 * per-title metadata lookups: the score uses the seed genres, trusted Overview
 * tokens and keywords, the media type, and the caller's own positive taste,
 * favourites and activity history. Only titles with a seed genre/theme match
 * are returned, so the section stays about the title the viewer opened.
 */
export function rankSimilarCandidates({ seed, items = [], taste = null, favourites = [], watched = [], history = [] } = {}) {
	if (!seed || !Array.isArray(items) || !items.length) return [];
	const prefs = preferences(normalizedTaste(taste));
	const subject = resolveSubject(seed, items);
	const identity = identitiesOf(seed, subject);
	const seedGenres = new Set([...cleanGenres(seed), ...cleanGenres(subject)]);
	// An episode borrows its series identity (and therefore its series synopsis)
	// rather than anchoring the section to one episode's plot.
	const overviewText = subject && subject !== seed && subject.Type === 'Series'
		? subject.Overview
		: [seed?.Overview, subject?.Overview].filter(Boolean).join(' ');
	const seedOverview = overviewTokens(overviewText);
	const seedKeywords = keywordTokens(seed);
	for (const token of keywordTokens(subject)) seedKeywords.add(token);
	const seedTheme = new Set([...seedOverview, ...seedKeywords]);
	const seedType = subject?.Type === 'Episode' ? 'Series' : subject?.Type || seed.Type;
	const byId = new Map();
	for (const item of items) if (item && typeof item.Id === 'string') byId.set(item.Id, item);
	const positive = positiveSignals({ prefs, favourites, watched, history, byId, identity });
	const favouriteIds = new Set(safeIds(favourites, 1000));
	const watchedIds = new Set(safeIds(watched, 5000));

	const ranked = [];
	const seenKeys = new Set();
	const seenIds = new Set();
	for (const item of items) {
		if (!item || typeof item.Id !== 'string' || !item.Name) continue;
		if (!['Movie', 'Series'].includes(item.Type)) continue;
		if (seenIds.has(item.Id) || matchesIdentity(item, identity)) continue;
		let key;
		try { key = homeItemKey(item); } catch { key = item.Type + ':id:' + item.Id; }
		if (seenKeys.has(key)) continue;
		const genres = cleanGenres(item);
		const tmdb = itemTmdbKey(item);
		if (prefs.exclude.has(item.Id) || (tmdb && prefs.exclude.has(tmdb))) continue;
		const genreScore = genres.reduce((sum, genre) => sum + (prefs.weights.get(genre) || 0), 0);
		if (genreScore <= -3) continue;
		if (genres.some(genre => (prefs.weights.get(genre) || 0) <= -3)) continue;

		const genreHits = genres.filter(genre => seedGenres.has(genre));
		let overviewHits = 0, keywordHits = 0;
		if (seedTheme.size) {
			for (const token of overviewTokens(item.Overview)) if (seedTheme.has(token)) overviewHits++;
			for (const token of keywordTokens(item)) if (seedTheme.has(token)) keywordHits++;
		}
		// The section is anchored to the opened title. Type alone is too weak to
		// count as a match, so a catalogue of unrelated films does not fill it.
		if (!genreHits.length && !overviewHits && !keywordHits) continue;

		const seedScore = genreHits.length * 3.2 + Math.min(4, overviewHits) * 0.7 + Math.min(4, keywordHits) * 1.8;
		const ownSignal = (favouriteIds.has(item.Id) ? 1 : 0) + (watchedIds.has(item.Id) ? 0.4 : 0);
		const callerStrength = genres.reduce((sum, genre) => sum + Math.max(0, positive.get(genre) || 0), 0);
		const callerScore = Math.min(6, callerStrength) * 0.45;
		const typeScore = seedType === item.Type ? 0.5 : 0;
		const score = seedScore + callerScore + typeScore + Math.min(0.6, ratingConfidence(item) / 12);
		seenIds.add(item.Id);
		seenKeys.add(key);
		ranked.push({ item, score, reason: chooseReason(genres, positive, ownSignal) });
	}

	ranked.sort((left, right) => right.score - left.score
		|| ratingConfidence(right.item) - ratingConfidence(left.item)
		|| String(left.item.Name).localeCompare(String(right.item.Name))
		|| String(left.item.Id).localeCompare(String(right.item.Id)));
	return ranked;
}

/** Build the wire-safe response for a details page. `unavailable` is a set of
 * series ids confirmed empty by the caller's bounded playability cache. */
export function buildSimilarTitles({ seed, items = [], taste = null, favourites = [], watched = [], history = [], limit = SIMILAR_DEFAULT_LIMIT, unavailable = new Set() } = {}) {
	const bounded = similarLimit(limit);
	return rankSimilarCandidates({ seed, items, taste, favourites, watched, history })
		.filter(entry => !(entry.item.Type === 'Series' && unavailable.has(entry.item.Id)))
		.slice(0, bounded)
		.map(entry => similarView(entry.item, entry.reason));
}

/** A small allowlist for display. UserData, Overview and internal scores never
 * reach the browser from this route. */
export function similarView(item, reason = 'More like this') {
	const view = {};
	for (const key of SAFE_FIELDS) if (item?.[key] !== undefined) view[key] = item[key];
	if (Array.isArray(view.Genres)) view.Genres = view.Genres.filter(value => typeof value === 'string').slice(0, 12);
	if (Array.isArray(view.Ratings)) {
		view.Ratings = view.Ratings.map(rating => Object.fromEntries(
			['source', 'value', 'max', 'votes', 'url'].filter(key => rating?.[key] !== undefined).map(key => [key, rating[key]])
		));
	}
	view.reason = reason === 'More like this' || /^Because you like [^<>]{1,60}$/i.test(reason) ? reason : 'More like this';
	return view;
}
