// Coming soon links an announcement back to the copy already in the library.
// A television card represents one dated episode, so its library link must open
// that episode. If that exact episode is not in the library there is no honest
// link to offer: opening the series would start at episode one, which is a
// different episode from the card. In that case the item gets no library link
// and the client keeps its details panel.
//
// `availability` is the existing catalogue match (vodLibrary.availability) and
// `episodes` is the existing Jellyfin-backed series episode lookup
// (seriesEpisodes in server.mjs). Neither is queried by this module itself, and
// no provider request is made here.
export async function resolveComingMatches(items, { availability, episodes } = {}) {
	const list = Array.isArray(items) ? items : [];
	if (!list.length || typeof availability !== 'function') return null;
	const matched = await availability(list);
	const index = new Map();
	const seriesIds = new Map();
	for (const item of Array.isArray(matched) ? matched : []) {
		if (!item || typeof item.watchId !== 'string' || !item.watchId) continue;
		const key = `${item.type === 'tv' ? 'tv' : 'movie'}:${item.id}`;
		if (item.type === 'tv') seriesIds.set(key, item.watchId);
		else index.set(key, { id: item.watchId, type: 'movie' });
	}
	for (const item of list) {
		if (item?.type !== 'tv') continue;
		const key = `tv:${item.id}`;
		const seriesId = seriesIds.get(key);
		if (!seriesId || typeof episodes !== 'function') continue;
		const season = Number(item.seasonNumber), number = Number(item.episodeNumber);
		if (!Number.isInteger(season) || !Number.isInteger(number)) continue;
		try {
			const rows = await episodes(seriesId);
			const found = (Array.isArray(rows) ? rows : []).find(row =>
				Number(row?.ParentIndexNumber) === season && Number(row?.IndexNumber) === number);
			if (found?.Id) index.set(key, { id: String(found.Id), type: 'episode' });
		} catch {
			// A failed lookup leaves the item without a link; the page must never
			// send someone to a different episode than the one on the card.
		}
	}
	return index;
}