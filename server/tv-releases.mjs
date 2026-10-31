// Fill gaps from an exact, unambiguous show/season/episode calendar match.
// File-added dates are not release dates, and must never masquerade as them.
export function episodeReleaseDates(items, airings = []) {
	const name = value => String(value || '').normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
	const key = (title, season, episode) => `${name(title)}|${season}|${episode}`;
	const index = new Map();
	for (const airing of airings) {
		if (!airing.series || !Number.isInteger(airing.season) || !Number.isInteger(airing.episode) || !Number.isFinite(Date.parse(airing.date))) continue;
		const id = key(airing.series, airing.season, airing.episode), rows = index.get(id) || [];
		rows.push(airing);index.set(id, rows);
	}
	return items.map(item => {
		const rows = index.get(key(item.SeriesName, item.ParentIndexNumber, item.IndexNumber)) || [];
		if (rows.length !== 1) return item;
		const match = rows[0];
		return { ...item, ReleaseSeriesKey: match.seriesId ? `calendar:${match.seriesId}` : item.SeriesId,
			...(!Number.isFinite(Date.parse(item.PremiereDate)) ? { PremiereDate: match.date } : {}) };
	});
}

export function recentTvEpisodes(items, now = new Date(), limit = 12) {
	const since = new Date(now);
	since.setUTCFullYear(since.getUTCFullYear() - 1);
	const episodes = items.filter(item => {
		const date = Date.parse(item.PremiereDate);
		return item.Type === 'Episode' && item.SeriesId && item.SeriesName && !item.IsVirtualItem && !item.IsMissing
			&& item.LocationType !== 'Virtual' && item.LocationType !== 'Offline'
			&& Number.isFinite(date) && date >= since.valueOf() && date <= now.valueOf();
	}).sort((a, b) => Date.parse(b.PremiereDate) - Date.parse(a.PremiereDate)
		|| (b.ParentIndexNumber || 0) - (a.ParentIndexNumber || 0) || (b.IndexNumber || 0) - (a.IndexNumber || 0)
		|| (a.Source==='streamed'?1:0)-(b.Source==='streamed'?1:0));
	const shows = new Map();
	for (const episode of episodes) { const key=episode.ReleaseSeriesKey||episode.SeriesId;if (!shows.has(key)) shows.set(key, episode); }
	return [...shows.values()].slice(0, limit).map(({ReleaseSeriesKey,...item})=>item);
}
