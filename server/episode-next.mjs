import { orderedEpisodes } from './episode-order.mjs';

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
		return { item: null, status: info.status === 'Ended' ? 'complete' : 'caught-up', message: info.status === 'Ended' ? 'You’ve finished this series.' : 'You’re up to date.' };
	}
	return { item: null, status: count > e ? 'gap' : 'unavailable', message: count > e ? 'The next episode is not available yet.' : 'No more episodes are available here yet.' };
}

export function createEpisodeNext({ library, metadata }) {
	return async (id, seriesId) => {
		const current = await library.item(id);
		if (current.Type !== 'Episode') return { item: null, status: 'not-episode' };
		const series = await library.item(current.SeriesId || seriesId);
		const episodes = await library.episodes(series.Id);
		let info = null;
		const immediate = chooseNext(current, episodes.items);
		if (immediate.item) return { ...immediate, seriesId: series.Id };
		try { if (series.ProviderIds?.Tmdb) info = await Promise.race([metadata('tv', series.ProviderIds.Tmdb), new Promise(resolve => { const timer = setTimeout(() => resolve(null), 7000); timer.unref?.(); })]); } catch {}
		const result = chooseNext(current, episodes.items, info, Boolean(episodes.notice));
		result.seriesId = series.Id;
		result.seriesName = series.Name;
		if (series.ProviderIds?.Tmdb) result.request = { type: 'tv', id: Number(series.ProviderIds.Tmdb) };
		if (!result.item) {
			try {
				const suggestions = await library.list({ type: 'tvshows', genre: series.Genres?.[0] || '', sort: 'rating' });
				const genre = series.Genres?.[0] || '';
				result.suggestions = suggestions.items.filter(i => i.Id !== series.Id && i.Type === 'Series' && (!genre || i.Genres?.includes(genre))).slice(0, 6);
				if (genre && result.suggestions.length) result.suggestionGenre = genre;
			} catch { result.suggestions = []; }
		}
		return result;
	};
}
