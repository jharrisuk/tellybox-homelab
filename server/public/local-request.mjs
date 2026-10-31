export const localRequestLabel = 'Add to local collection';

export function canRequestLocal(item) {
	return ['Movie', 'Series', 'Episode'].includes(item.Type)
		&& (item.Source === 'streamed' || (item.Type === 'Series' && item.VodIds?.length > 0));
}

export function localRequestUrl(item, parent = item) {
	const series = item.Type !== 'Movie';
	// An episode's TMDB ID must never be used to request a series.
	const id = parent.Type === (series ? 'Series' : 'Movie') ? String(parent.ProviderIds?.Tmdb || '') : '';
	const params = new URLSearchParams({ type: series ? 'tv' : 'movie' });
	if (/^[1-9]\d{0,9}$/.test(id) && Number(id) <= 2147483647) params.set('title', id);
	else params.set('q', item.Type === 'Episode' ? item.SeriesName || '' : item.Name || '');
	return '/discover?' + params;
}
