// "Newly available" is the verified counterpart to the Coming soon calendar.
// Every item here must be a real, already-aired local file, so a card can
// safely open or play it. Missing, unaired and virtual entries are never
// reported as available, and the list is bounded because it is a browse rail.
export const NEWLY_AVAILABLE_LIMIT = 24;

export function newlyAvailableItems(payload) {
	const items = Array.isArray(payload?.Items) ? payload.Items : [];
	return items
		.filter(item => item && !item.IsVirtualItem && !item.IsMissing && !item.IsUnaired)
		.slice(0, NEWLY_AVAILABLE_LIMIT);
}

export function newlyAvailableQuery(userId) {
	return new URLSearchParams({
		UserId: String(userId || ''), Recursive: 'true', IncludeItemTypes: 'Movie,Episode',
		IsMissing: 'false', IsUnaired: 'false', LocationTypes: 'FileSystem',
		Fields: 'Overview,Genres,PrimaryImageAspectRatio,ProviderIds,DateCreated,PremiereDate,SeriesId,SeriesName,ParentIndexNumber,IndexNumber',
		SortBy: 'DateCreated', SortOrder: 'Descending', Limit: String(NEWLY_AVAILABLE_LIMIT), EnableImages: 'true'
	});
}
