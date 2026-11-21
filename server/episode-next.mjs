import { orderedEpisodes } from './episode-order.mjs';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Keep TMDB date-only values as date-only strings. Never convert them to an instant. */
export function dateOnly(value) {
	const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || ''));
	if (!match) return '';
	const year = Number(match[1]), month = Number(match[2]), day = Number(match[3]);
	const date = new Date(Date.UTC(year, month - 1, day));
	if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return '';
	return match[1] + '-' + match[2] + '-' + match[3];
}

export function dateOnlyPhase(value, now = Date.now()) {
	const date = dateOnly(value);
	if (!date) return 'unknown';
	const target = Date.parse(date + 'T00:00:00Z');
	const current = new Date(now);
	const today = Date.UTC(current.getUTCFullYear(), current.getUTCMonth(), current.getUTCDate());
	const difference = Math.round((target - today) / DAY_MS);
	return difference < 0 ? 'past' : difference === 0 ? 'today' : 'future';
}

export function chooseNext(current, items, info = null, incomplete = false) {
	if (current.Type !== 'Episode') return { item: null, status: 'not-episode' };
	const s = current.ParentIndexNumber, e = current.IndexNumber;
	if (!Number.isInteger(s) || !Number.isInteger(e)) return { item: null, status: 'unknown' };
	const candidates = orderedEpisodes(items).filter(i => (s === 0 ? i.ParentIndexNumber === 0 : i.ParentIndexNumber > 0)
		&& (i.ParentIndexNumber > s || i.ParentIndexNumber === s && i.IndexNumber > e));
	const next = candidates[0];
	if (next && next.ParentIndexNumber === s && next.IndexNumber === e + 1) return { item: next, status: 'next' };
	const season = info?.seasons?.find(i => Number(i.seasonNumber ?? i.season_number) === s);
	const count = Number(season?.episodeCount ?? season?.episode_count);
	if (next?.ParentIndexNumber === s + 1 && next.IndexNumber === 1 && count === e) return { item: next, status: 'next' };
	if (next) return { item: null, status: 'gap', availableLater: next, message: 'The next episode is not available yet.' };
	if (incomplete) return { item: null, status: 'unknown', message: 'The episode list could not be fully checked.' };
	const last = info?.lastEpisodeToAir || info?.last_episode_to_air;
	if (Number(last?.seasonNumber ?? last?.season_number) === s && Number(last?.episodeNumber ?? last?.episode_number) === e) {
		return { item: null, status: info.status === 'Ended' ? 'complete' : 'caught-up', message: info.status === 'Ended' ? "You've finished this series." : "You're up to date." };
	}
	return { item: null, status: count > e ? 'gap' : 'unavailable', message: count > e ? 'The next episode is not available yet.' : 'No more episodes are available here yet.' };
}

/**
 * Resolve the next *scheduled* episode from trusted show metadata when no
 * playable episode exists. Dates remain date-only strings; availability is not
 * inferred from the broadcast date.
 */
export function nextSchedule(current, items, info = null, { incomplete = false, now = Date.now(), expectedTmdb = '' } = {}) {
	if (current.Type !== 'Episode') return { status: 'not-episode' };
	const s = current.ParentIndexNumber, e = current.IndexNumber;
	if (!Number.isInteger(s) || !Number.isInteger(e)) return { status: 'unknown', message: 'The episode position is unknown.' };
	if (!info) return { status: 'unknown', message: "The next scheduled episode couldn't be checked." };
	if (expectedTmdb && Number(info.id) !== Number(expectedTmdb)) return { status: 'unknown', message: 'The scheduled episode data did not match this show.' };
	const raw = info.next_episode_to_air || info.nextEpisodeToAir;
	const season = Number(raw?.season_number ?? raw?.seasonNumber);
	const episode = Number(raw?.episode_number ?? raw?.episodeNumber);
	const airDate = dateOnly(raw?.air_date ?? raw?.airDate);
	if (Number.isSafeInteger(season) && season >= 0 && Number.isSafeInteger(episode) && episode > 0
		&& (season > s || season === s && episode > e)) {
		const phase = dateOnlyPhase(airDate, now);
		const status = phase === 'past' ? 'aired-missing' : 'scheduled';
		return {
			status,
			seriesStatus: String(info.status || ''),
			next: { season, episode, title: String(raw?.name || raw?.title || '').slice(0, 200), airDate, phase },
			message: phase === 'past' ? 'This episode has aired but is not available in Tellybox yet.'
				: airDate ? 'The next episode is scheduled; it is not available in Tellybox yet.' : 'The next episode is scheduled; its air date has not been announced.'
		};
	}
	if (incomplete) return { status: 'unknown', seriesStatus: String(info.status || ''), message: 'The episode list could not be fully checked.' };
	const seriesStatus = String(info.status || '');
	if (/^ended$/i.test(seriesStatus)) return { status: 'complete', seriesStatus, message: "You've finished this series." };
	if (/^canceled$/i.test(seriesStatus)) return { status: 'complete', seriesStatus, message: 'This series ended without further episodes.' };
	return { status: 'caught-up', seriesStatus, message: 'No next episode is scheduled yet. Check back for more.' };
}

export function createEpisodeNext({ library, metadata, clock = Date.now }) {
	const next = async (id, seriesId) => {
		const current = await library.item(id);
		if (current.Type !== 'Episode') return { item: null, status: 'not-episode' };
		const series = await library.item(current.SeriesId || seriesId);
		const episodes = await library.episodes(series.Id);
		let info = null;
		const immediate = chooseNext(current, episodes.items);
		if (immediate.item) return { ...immediate, seriesId: series.Id };
		// A cached metadata result may refine complete/caught-up immediately, but a
		// slow upstream must never hold the finished screen. The schedule endpoint
		// continues the bounded lookup after the screen is visible.
		try {
			if (series.ProviderIds?.Tmdb) info = await Promise.race([
				metadata('tv', series.ProviderIds.Tmdb),
				new Promise(resolve => { const timer = setTimeout(() => resolve(null), 250); timer.unref?.(); })
			]);
		} catch {}
		const result = chooseNext(current, episodes.items, info, Boolean(episodes.notice));
		if (!result.item && !info && result.status === 'unavailable') {
			result.status = 'caught-up';
			result.message = "You're up to date.";
		}
		result.seriesId = series.Id;
		result.seriesName = series.Name;
		if (series.ProviderIds?.Tmdb) result.request = { type: 'tv', id: Number(series.ProviderIds.Tmdb) };
		if (!result.item) {
			result.schedulePending = true;
			result.scheduleUrl = '/api/web/items/' + encodeURIComponent(id) + '/schedule?series=' + encodeURIComponent(series.Id);
			try {
				const suggestions = await library.list({ type: 'tvshows', genre: series.Genres?.[0] || '', sort: 'rating' });
				const genre = series.Genres?.[0] || '';
				result.suggestions = suggestions.items.filter(i => i.Id !== series.Id && i.Type === 'Series' && (!genre || i.Genres?.includes(genre))).slice(0, 6);
				if (genre && result.suggestions.length) result.suggestionGenre = genre;
			} catch { result.suggestions = []; }
		}
		return result;
	};
	next.schedule = async (id, seriesId) => {
		const current = await library.item(id);
		if (current.Type !== 'Episode') return { status: 'not-episode' };
		const series = await library.item(current.SeriesId || seriesId);
		const episodes = await library.episodes(series.Id);
		const immediate = chooseNext(current, episodes.items);
		if (immediate.item) return { ...immediate, seriesId: series.Id, seriesName: series.Name };
		let info = null;
		try {
			if (series.ProviderIds?.Tmdb) info = await Promise.race([
				metadata('tv', series.ProviderIds.Tmdb),
				new Promise(resolve => { const timer = setTimeout(() => resolve(null), 5000); timer.unref?.(); })
			]);
		} catch {}
		const result = nextSchedule(current, episodes.items, info, {
			incomplete: Boolean(episodes.notice), expectedTmdb: series.ProviderIds?.Tmdb || '', now: clock()
		});
		result.seriesId = series.Id;
		result.seriesName = series.Name;
		if (series.ProviderIds?.Tmdb) result.request = { type: 'tv', id: Number(series.ProviderIds.Tmdb) };
		return result;
	};
	return next;
}
