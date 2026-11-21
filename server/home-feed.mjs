import { canonical, preferences } from './discovery-feeds.mjs';

const MAX_ROWS = 12;
// The Continue row is bounded to one screen of resume cards, whether the
// progress belongs to a film, an exact episode or a series label.
export const CONTINUE_LIMIT = 8;
const WINDOW_MS = 6 * 60 * 60 * 1000;
// A bounded, relevance-first slice of the catalogue keeps recommendation work
// predictable even when the library is large.
const CANDIDATE_LIMIT = 360;
const ID = /^(?:[a-f0-9-]{32,36}|tmdb:(?:movie|tv):[1-9][0-9]{0,9})$/i;

export function homeItemKey(item) {
	const ids = item?.ProviderIds || {};
	if (ids.Tmdb) return item.Type + ':tmdb:' + ids.Tmdb;
	if (/^tt\d+$/.test(ids.Imdb || '')) return item.Type + ':imdb:' + ids.Imdb;
	const name = String(item?.Name || '').trim().toLowerCase();
	return item?.Type + ':name:' + name + ':' + (item?.ProductionYear || '');
}

/** Unique key for an exact Continue episode: series plus season/episode. */
function episodeContinueKey(item) {
	const series = String(item?._continueSeriesId || item?.SeriesId || '').toLowerCase();
	const season = Number.isInteger(item?.ParentIndexNumber) ? item.ParentIndexNumber : null;
	const number = Number.isInteger(item?.IndexNumber) ? item.IndexNumber : null;
	if (series && season !== null && number !== null) return series + '|s' + season + '|e' + number;
	if (series) return series + '|name:' + String(item?.Name || '').toLowerCase();
	return 'id:' + String(item?.Id || '').toLowerCase();
}

function ratingConfidence(item) {
	const rating = (item.Ratings || []).find(entry => Number.isFinite(Number(entry?.value)) && Number(entry?.max || 10) > 0);
	const value = rating ? Number(rating.value) / Number(rating.max || 10) * 10 : Number(item.CommunityRating) || 0;
	const votes = Number(rating?.votes) || 0;
	return ((value * votes) + 6 * 50) / (votes + 50);
}

function primaryGenre(item) {
	return (item._genres || [])[0] || '';
}

/** Pick a readable mixture of genres and media types without inventing titles. */
export function diverseHome(items, limit = MAX_ROWS) {
	const pool = items.map(item => ({ ...item,
		_key: item._key || homeItemKey(item),
		_genres: item._genres || (item.Genres || []).map(canonical).filter(Boolean) }));
	const out = [], used = new Set(), genreCount = new Map();
	for (const item of pool) {
		if (out.length >= limit) break;
		if (used.has(item._key)) continue;
		const genre = primaryGenre(item), count = genreCount.get(genre) || 0;
		if (genre && count >= 2) continue;
		out.push(item); used.add(item._key);
		if (genre) genreCount.set(genre, count + 1);
	}
	for (const item of pool) {
		if (out.length >= limit) break;
		if (!used.has(item._key)) { out.push(item); used.add(item._key); }
	}
	return out;
}

/** Stable 32-bit hash used only for server-side recommendation ordering. */
function hash32(value) {
	const text = String(value);
	let hash = 2166136261;
	for (let index = 0; index < text.length; index++) {
		hash ^= text.charCodeAt(index);
		hash = Math.imul(hash, 16777619);
	}
	hash ^= hash >>> 16;
	hash = Math.imul(hash, 0x7feb352d);
	hash ^= hash >>> 15;
	hash = Math.imul(hash, 0x846ca68b);
	hash ^= hash >>> 16;
	return hash >>> 0;
}

function explorationValue(seed, salt, key) {
	return hash32(seed + '|' + salt + '|' + key) / 4294967296;
}

function relevanceOrder(a, b) {
	return b._score - a._score || b._confidence - a._confidence
		|| String(a.Name || '').localeCompare(String(b.Name || ''))
		|| String(a._key || '').localeCompare(String(b._key || ''));
}

/** Keep recommendation work bounded to a relevant, high-confidence slice. */
function boundedRelevant(items, limit = CANDIDATE_LIMIT) {
	if (!Array.isArray(items) || !items.length || limit <= 0) return [];
	return items.slice().sort(relevanceOrder).slice(0, limit);
}

/**
 * Blend core relevance with a deterministic per-window exploration value.
 * Rank relevance keeps the pool sensible while the hash lets later windows
 * surface different titles from the same bounded candidate pool.
 */
function mixedOrder(items, seed, salt) {
	const ranked = boundedRelevant(items);
	const count = ranked.length;
	if (!count) return [];
	const best = ranked[0]._score;
	const worst = ranked[count - 1]._score;
	const span = best - worst;
	const ordered = ranked.map((item, index) => {
		const rank = count > 1 ? 1 - index / (count - 1) : 1;
		const magnitude = span > 1e-9 ? (item._score - worst) / span : rank;
		const relevance = rank * 0.7 + magnitude * 0.3;
		return { item, value: relevance * 0.6 + explorationValue(seed, salt, item._key) * 0.4 };
	});
	ordered.sort((a, b) => b.value - a.value || String(a.item._key).localeCompare(String(b.item._key)));
	return ordered.map(entry => entry.item);
}

/**
 * Choose a varied row from an explored order.
 *
 * Reserved titles and items already used by an earlier personalised rail are
 * skipped first. Genre repetition is capped, then remaining relevant items are
 * used, and only then are reserved/used titles repeated as a small-pool
 * fallback. Every row is still unique by item key.
 */
function selectExplored(items, limit, { seed, salt, avoid = new Set() } = {}) {
	const ordered = mixedOrder(items, seed, salt);
	const out = [], used = new Set(), genreCount = new Map();
	const canTake = (item, cap, allowAvoid) => {
		if (used.has(item._key)) return false;
		if (!allowAvoid && avoid.has(item._key)) return false;
		if (!cap) return true;
		const genre = primaryGenre(item);
		return !genre || (genreCount.get(genre) || 0) < 2;
	};
	const take = item => {
		out.push(item); used.add(item._key);
		const genre = primaryGenre(item);
		if (genre) genreCount.set(genre, (genreCount.get(genre) || 0) + 1);
	};
	for (const item of ordered) { if (out.length >= limit) break; if (canTake(item, true, false)) take(item); }
	for (const item of ordered) { if (out.length >= limit) break; if (canTake(item, false, false)) take(item); }
	for (const item of ordered) { if (out.length >= limit) break; if (canTake(item, false, true)) take(item); }
	return out;
}

/** Build a seed from the viewer context that produced this feed, never from the request alone. */
function viewerSeed(windowIndex, { weights, exclude, favouriteIds, watchedIds, history, progressById }) {
	const parts = ['w' + windowIndex];
	parts.push([...weights].sort((a, b) => a[0].localeCompare(b[0]) || a[1] - b[1])
		.map(([name, weight]) => name + ':' + weight).join(','));
	parts.push([...exclude].sort().join(','));
	parts.push([...favouriteIds].sort().join(','));
	parts.push([...watchedIds].sort().join(','));
	parts.push((Array.isArray(history) ? history : []).filter(entry => entry && typeof entry === 'object').map(entry => {
		const genres = (Array.isArray(entry.genres) ? entry.genres : []).map(canonical).filter(Boolean).sort();
		return String(entry.itemId || '') + ':' + String(entry.seriesId || '') + ':' + genres.join(',');
	}).sort().join('|'));
	parts.push(Object.keys(progressById).sort().join(','));
	return hash32(parts.join(';'));
}

/** Apply the caller's catalogue policy before any recommendation rows are built. */
export function homeVisibleItems(items = [], { shared = false, allowed = () => true } = {}) {
	return shared ? items : items.filter(item => allowed(item));
}

/** Latest in-progress episode for a series, chosen by the newest event.
 *
 * The newest rewind wins over an older later position, and completed episodes
 * are skipped. The returned itemId is the exact episode the viewer should
 * resume; a series-level position is never used to seek into an arbitrary
 * episode.
 */
export function seriesResumeTarget(history = [], seriesId = '') {
	if (typeof seriesId !== 'string' || !seriesId) return null;
	let best = null;
	for (const entry of Array.isArray(history) ? history : []) {
		if (!entry || entry.seriesId !== seriesId || entry.completed) continue;
		if (typeof entry.itemId !== 'string') continue;
		const position = Math.max(0, Number(entry.position) || 0);
		if (!position) continue;
		const updated = Number(entry.updated) || 0;
		if (!best || updated > best.updated) best = { itemId: entry.itemId, position, updated };
	}
	return best;
}

/** Apply only the caller's own history to the catalogue items.
 *
 * Jellyfin UserData belongs to the shared backend service account. It is kept
 * only for a local/home viewer. A remote person or device receives its own
 * activity history instead; no other caller's UserData is returned.
 *
 * A partially watched film keeps its own position. A series shows the latest
 * in-progress episode's place for the Resume label but is never marked watched
 * from episode history, and no episode position is copied onto a series id.
 * Only confirmed completions enter `watched`, so history cannot exclude every
 * title in a series.
 */
export function viewerHomeContext({ items = [], history = [], shared = false } = {}) {
	const entries = (Array.isArray(history) ? history : []).filter(entry => entry && typeof entry.itemId === 'string');
	const byId = new Map();
	for (const entry of entries) {
		const previous = byId.get(entry.itemId);
		if (!previous || (Number(entry.updated) || 0) >= (Number(previous.updated) || 0)) byId.set(entry.itemId, entry);
	}
	const resumeBySeries = new Map();
	for (const item of items) {
		if (item?.Type !== 'Series') continue;
		const target = seriesResumeTarget(entries, item.Id);
		if (target) resumeBySeries.set(item.Id, target);
	}
	const prepared = items.map(item => {
		if (shared) return item;
		const copy = { ...item };
		delete copy.UserData;
		if (item?.Type === 'Series') {
			const resume = resumeBySeries.get(item.Id);
			if (resume) {
				copy.UserData = { PlaybackPositionTicks: resume.position * 1e7, Played: false };
				copy._resumeItemId = resume.itemId;
			}
			return copy;
		}
		const own = byId.get(item?.Id);
		if (own) copy.UserData = { PlaybackPositionTicks: Math.max(0, Number(own.position) || 0) * 1e7, Played: own.completed === true };
		return copy;
	});
	const watched = [...new Set(entries.filter(entry => entry.completed === true).map(entry => entry.itemId))];
	const progress = {};
	const known = new Map(items.map(item => [item?.Id, item?.Type]));
	for (const entry of byId.values()) {
		if (entry.completed) continue;
		const position = Math.max(0, Number(entry.position) || 0);
		if (!position) continue;
		// Only exact playable film ids are sent as progress. Episodes are not in
		// the home catalogue; their exact Continue entries are resolved from this
		// same history by home-continue.mjs, and a series id never carries an
		// episode position.
		if (known.get(entry.itemId) === 'Movie') progress[entry.itemId] = position;
	}
	return { items: prepared, watched, progress };
}

export function buildHomeFeed({ items = [], taste = null, favourites = [], watched = [], progress = {}, history = [], episodeContinue = [], episodeSeriesIds = [], continueUpdated = {}, continueWatched = null, now = Date.now() } = {}) {
	const prefs = preferences(taste || { genres: [], exclude: [] });
	// Confirmed completions and explicit dislikes are separate signals. A dislike
	// excludes a title everywhere, including Continue watching; a completion only
	// marks that exact title finished.
	const watchedIds = new Set((Array.isArray(watched) ? watched : []).filter(value => typeof value === 'string'));
	// Continue decisions can use a stricter completion set than the browse rows.
	// The route passes server-derived completions for a remote caller and the
	// full local set for local/home, so a client-supplied watched id can never
	// create or remove a remote Continue card.
	const continueWatchedIds = new Set((Array.isArray(continueWatched) ? continueWatched : watched)
		.filter(value => typeof value === 'string'));
	const dislikedIds = new Set(prefs.exclude);
	const favouriteIds = new Set((Array.isArray(favourites) ? favourites : []).filter(value => typeof value === 'string' && ID.test(value)));
	const historyWeights = new Map();
	for (const entry of Array.isArray(history) ? history : []) {
		for (const genre of Array.isArray(entry?.genres) ? entry.genres : []) {
			const name = canonical(genre);
			if (name) historyWeights.set(name, (historyWeights.get(name) || 0) + 1);
		}
	}
	for (const [name, count] of [...historyWeights].sort((a, b) => b[1] - a[1]).slice(0, 40)) {
		prefs.weights.set(name, Math.max(-50, Math.min(50, (prefs.weights.get(name) || 0) + Math.min(5, count))));
	}
	// Browser progress is accepted for any exact id, not only catalogue ids.
	// The Continue builder decides whether an id is a film, an episode or
	// unknown; a progress key alone never creates a title.
	const progressById = progress && typeof progress === 'object' && !Array.isArray(progress)
		? Object.fromEntries(Object.entries(progress).filter(([, value]) => Number.isFinite(Number(value))
			&& Number(value) > 0 && Number(value) <= 86400).map(([id, value]) => [id, Number(value)]))
		: {};
	// The viewer's own history and the scoped home evidence supply the recency
	// of each unfinished title. `continueUpdated` is used for local/home where
	// the taste history intentionally stays empty.
	const updatedById = new Map(), updatedBySeries = new Map();
	for (const entry of Array.isArray(history) ? history : []) {
		if (!entry || typeof entry.itemId !== 'string') continue;
		const updated = Number(entry.updated) || 0;
		if (updated > (updatedById.get(entry.itemId) || 0)) updatedById.set(entry.itemId, updated);
		if (entry.completed !== true && typeof entry.seriesId === 'string' && entry.seriesId
			&& updated > (updatedBySeries.get(entry.seriesId) || 0)) updatedBySeries.set(entry.seriesId, updated);
	}
	if (continueUpdated && typeof continueUpdated === 'object' && !Array.isArray(continueUpdated)) {
		for (const [id, value] of Object.entries(continueUpdated)) {
			const updated = Number(value) || 0;
			if (typeof id === 'string' && updated > (updatedById.get(id) || 0)) updatedById.set(id, updated);
		}
	}
	const seen = new Set(), candidates = [];
	for (const item of items) {
		if (!item || !item.Id || !['Movie', 'Series'].includes(item.Type)) continue;
		if (!['local', 'streamed'].includes(item.Source)) continue;
		const key = homeItemKey(item);
		if (seen.has(key)) continue;
		seen.add(key);
		const genres = (item.Genres || []).map(canonical).filter(Boolean);
		const tmdb = item.ProviderIds?.Tmdb ? 'tmdb:' + (item.Type === 'Series' ? 'tv' : 'movie') + ':' + item.ProviderIds.Tmdb : '';
		const disliked = dislikedIds.has(item.Id) || (tmdb && dislikedIds.has(tmdb));
		const genreScore = genres.reduce((sum, genre) => sum + (prefs.weights.get(genre) || 0), 0);
		const user = item.UserData || {};
		const userResume = Math.max(0, Math.round(Number(user.PlaybackPositionTicks || 0) / 1e7));
		const storedResume = Number(progressById[item.Id]) || 0;
		// Latest source, not the largest position: the browser's own exact
		// progress is the state the player would resume from, so a newer rewind
		// beats an older, larger shared Jellyfin position.
		const resume = storedResume > 0 ? storedResume : userResume;
		const played = user.Played === true || watchedIds.has(item.Id);
		const continuePlayed = user.Played === true || continueWatchedIds.has(item.Id);
		const favourite = favouriteIds.has(item.Id);
		const excluded = disliked || played || genreScore <= -3;
		const continueExcluded = disliked || continuePlayed || genreScore <= -3;
		candidates.push({ ...item, _key: key, _tmdb: tmdb, _genres: genres, _genreScore: genreScore, _resume: resume,
			_updated: item.Type === 'Series' ? updatedBySeries.get(item.Id) || 0 : updatedById.get(item.Id) || 0,
			_played: played, _continuePlayed: continuePlayed, _continueExcluded: continueExcluded,
			_favourite: favourite, _excluded: excluded, _confidence: ratingConfidence(item),
			_score: genreScore * 2 + (favourite ? 2.5 : 0) + (resume > 30 ? 3 : 0) + Math.min(0.8, ratingConfidence(item) / 12) });
	}
	// Exact unfinished episodes can arrive two ways: already resolved by
	// home-continue.mjs, or as a real Episode item supplied by the caller (the
	// shared Jellyfin/merged view). Both are used only by Continue.
	const seriesInItems = new Set(items.filter(item => item?.Type === 'Series' && typeof item.Id === 'string')
		.map(item => item.Id.toLowerCase()));
	const suppressedSeries = new Set((Array.isArray(episodeSeriesIds) ? episodeSeriesIds : [])
		.filter(id => typeof id === 'string' && id).map(id => id.toLowerCase()));
	const episodeSeen = new Set(), episodeCandidates = [];
	const addEpisode = item => {
		if (!item || item.Type !== 'Episode' || typeof item.Id !== 'string' || !item.Id) return;
		if (!['local', 'streamed'].includes(item.Source)) return;
		if (continueWatchedIds.has(item.Id) || item.UserData?.Played === true) return;
		const key = episodeContinueKey(item);
		if (episodeSeen.has(key)) return;
		const ticks = Math.max(0, Number(item.UserData?.PlaybackPositionTicks) || 0);
		const resume = ticks / 1e7;
		if (!(resume > 0)) return;
		const seriesId = String(item._continueSeriesId || item.SeriesId || '');
		// An episode is never admitted without its parent series in the
		// caller's permitted catalogue.
		if (!seriesId || !seriesInItems.has(seriesId.toLowerCase())) return;
		episodeSeen.add(key);
		const genres = (item.Genres || []).map(canonical).filter(Boolean);
		suppressedSeries.add(seriesId.toLowerCase());
		episodeCandidates.push({ ...item, _key: 'continue:' + key, _genres: genres, _genreScore: 0,
			_resume: resume, _updated: Math.max(Number(item._continueUpdated) || 0, updatedById.get(item.Id) || 0),
			_played: false, _favourite: false, _excluded: false, _confidence: ratingConfidence(item),
			_score: 3 + Math.min(0.8, ratingConfidence(item) / 12) });
	};
	for (const item of Array.isArray(episodeContinue) ? episodeContinue : []) addEpisode(item);
	// A real Episode item supplied directly gets the browser's own exact-id
	// progress when present, because that is what the player would resume from.
	for (const item of items) {
		if (item?.Type !== 'Episode' || typeof item.Id !== 'string') continue;
		const browser = Number(progressById[item.Id]) || 0;
		addEpisode(browser > 0 ? { ...item, UserData: { ...(item.UserData || {}),
			PlaybackPositionTicks: browser * 1e7, Played: item.UserData?.Played === true } } : item);
	}
	const playable = candidates.filter(item => !item._excluded);
	// One bounded row: films and exact episodes ordered by the most recent
	// unfinished progress, then by position. A series card is kept out of
	// Continue whenever its episode-level progress is represented here (even if
	// that exact episode turned out to be unavailable), so a series is never
	// substituted for an episode.
	const continueWatching = candidates.filter(item => item._resume > 30 && !item._continuePlayed && !item._continueExcluded
		&& !(item.Type === 'Series' && suppressedSeries.has(String(item.Id).toLowerCase())))
		.concat(episodeCandidates)
		.sort((a, b) => b._updated - a._updated || b._resume - a._resume || String(a._key).localeCompare(String(b._key)))
		.slice(0, CONTINUE_LIMIT);
	const favouriteItems = candidates.filter(item => item._favourite && !item._excluded).slice(0, MAX_ROWS);
	// Keep the browse rows varied: do not repeat an item already shown in the
	// continue/favourites rails unless there are too few candidates to fill them.
	const reserved = new Set([...continueWatching, ...favouriteItems].map(item => item._key));
	let recommendationPool = playable.filter(item => !reserved.has(item._key));
	if (recommendationPool.length < 4) recommendationPool = playable;

	const nowMs = Number.isFinite(Number(now)) ? Number(now) : Date.now();
	const windowIndex = Math.floor(nowMs / WINDOW_MS);
	const seed = viewerSeed(windowIndex, { weights: prefs.weights, exclude: dislikedIds, favouriteIds, watchedIds, history, progressById });
	const relevantPool = boundedRelevant(recommendationPool);
	const positivePool = relevantPool.filter(item => item._score > 0);
	const forYouPool = positivePool.length ? positivePool : relevantPool;
	// Films and series normally come from the shared bounded pool. When a large
	// catalogue leans heavily to one media type, supplement just enough to keep a
	// useful row without scanning the whole library per rail.
	const railCandidates = type => {
		const direct = relevantPool.filter(item => item.Type === type);
		if (direct.length >= MAX_ROWS) return direct;
		const directKeys = new Set(direct.map(item => item._key));
		return direct.concat(boundedRelevant(recommendationPool.filter(item => item.Type === type && !directKeys.has(item._key))));
	};
	const railUsed = new Set(reserved);
	// Personalised rails are chosen in display-independent order: for-you, then
	// films, then series, then genre, each avoiding earlier picks when possible.
	const topPicks = selectExplored(forYouPool, MAX_ROWS, { seed, salt: 'for-you', avoid: railUsed });
	for (const item of topPicks) railUsed.add(item._key);
	const films = selectExplored(railCandidates('Movie'), MAX_ROWS, { seed, salt: 'films', avoid: railUsed });
	for (const item of films) railUsed.add(item._key);
	const series = selectExplored(railCandidates('Series'), MAX_ROWS, { seed, salt: 'series', avoid: railUsed });
	for (const item of series) railUsed.add(item._key);
	const recent = recommendationPool.slice().sort((a, b) => (Date.parse(b.DateCreated || b.PremiereDate) || 0) - (Date.parse(a.DateCreated || a.PremiereDate) || 0) || a.Name.localeCompare(b.Name)).slice(0, MAX_ROWS);
	const topRated = recommendationPool.slice().sort((a, b) => b._confidence - a._confidence || a.Name.localeCompare(b.Name)).slice(0, MAX_ROWS);
	const topGenre = [...prefs.weights].filter(([, weight]) => weight > 0).sort((a, b) => b[1] - a[1])[0]?.[0] || '';
	const genreRows = topGenre
		? selectExplored(boundedRelevant(recommendationPool.filter(item => item._genres.includes(topGenre))), MAX_ROWS,
			{ seed, salt: 'genre:' + topGenre, avoid: railUsed })
		: [];
	const rows = [];
	const add = (id, title, items, note = '') => { if (items.length) rows.push({ id, title, note, items }); };
	add('continue', 'Continue watching', continueWatching);
	add('favourites', 'Your favourites', favouriteItems, 'Ready when you are');
	add('for-you', topGenre ? 'Because you like ' + topGenre.toLowerCase() : 'Picked for you', topPicks,
		topGenre ? 'A mix of familiar and new titles' : 'A varied start from the collection');
	add('genre', topGenre ? 'More ' + topGenre.toLowerCase() : '', genreRows);
	add('films', 'Films for you', films);
	add('series', 'Series for you', series);
	add('new', 'Recently added', recent, 'New in the collection and streamed catalogue');
	add('top', 'Top rated in your collection', topRated);
	const featuredPool = [...continueWatching, ...topPicks, ...recent, ...topRated];
	const featured = [];
	const featuredSeen = new Set();
	for (const item of featuredPool) {
		if (featured.length >= 5) break;
		if (featuredSeen.has(item._key) || (!item.Artwork && !item.Id)) continue;
		featuredSeen.add(item._key);
		featured.push({ ...item, _reason: item._resume > 30 ? 'Continue watching' : item._favourite ? 'From your favourites'
			: item._genres.some(genre => (prefs.weights.get(genre) || 0) > 0) ? 'Because you like ' + item._genres.find(genre => (prefs.weights.get(genre) || 0) > 0).toLowerCase()
			: 'Picked for you' });
	}
	return { personalized: Boolean(topGenre || favouriteIds.size || continueWatching.length), coldStart: !topGenre && !favouriteIds.size && !continueWatching.length,
		generatedAt: new Date(nowMs).toISOString(), rows, featured };
}
