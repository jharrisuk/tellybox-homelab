// Available episodes in broadcast order; specials only follow other specials.
export function orderedEpisodes(items) {
	return items.filter(item => item.Type === 'Episode' && !item.IsVirtualItem && !item.IsMissing && Number.isInteger(item.IndexNumber) && Number.isInteger(item.ParentIndexNumber))
		.sort((a, b) => a.ParentIndexNumber - b.ParentIndexNumber || a.IndexNumber - b.IndexNumber || String(a.Id).localeCompare(String(b.Id)));
}
export function followingEpisode(items, current) {
	return orderedEpisodes(items).find(item => item.Id !== current.Id && (current.ParentIndexNumber === 0 ? item.ParentIndexNumber === 0 : item.ParentIndexNumber > 0)
		&& (item.ParentIndexNumber > current.ParentIndexNumber || item.ParentIndexNumber === current.ParentIndexNumber && item.IndexNumber > current.IndexNumber)) || null;
}
