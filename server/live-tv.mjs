function programmeView(item) {
	const start = Date.parse(item.StartDate);
	const end = Date.parse(item.EndDate);
	if (!item.Name || !Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
	return {
		Id: item.Id, Name: item.Name, Overview: item.Overview || '',
		StartDate: new Date(start).toISOString(), EndDate: new Date(end).toISOString()
	};
}

export function assembleGuide(channels, programmes, now, until) {
	const grouped = new Map(channels.map(channel => [channel.Id, new Map()]));
	for (const item of programmes) {
		const programme = programmeView(item);
		if (programme && Date.parse(programme.EndDate) > now && Date.parse(programme.StartDate) < until) {
			grouped.get(item.ChannelId)?.set(`${programme.StartDate}:${programme.Name}`, programme);
		}
	}
	return channels.map(channel => {
		const entries = grouped.get(channel.Id);
		const current = channel.CurrentProgram && programmeView(channel.CurrentProgram);
		if (current && Date.parse(current.StartDate) <= now && Date.parse(current.EndDate) > now) {
			const key = `${current.StartDate}:${current.Name}`;
			if (!entries.has(key)) entries.set(key, current);
		}
		return {
			Id: channel.Id, Name: channel.Name, Type: 'TvChannel', ChannelNumber: channel.ChannelNumber || '',
			ImageTags: channel.ImageTags?.Primary ? { Primary: channel.ImageTags.Primary } : {},
			programmes: [...entries.values()].sort((a, b) => Date.parse(a.StartDate) - Date.parse(b.StartDate))
		};
	});
}

export function createLiveGuide(jelly, userId, clock = Date.now) {
	let cached;
	let pending;
	async function pages(route, params) {
		const items = [];
		for (let start = 0; start < 20000; start += 1000) {
			const data = await jelly(`${route}?${new URLSearchParams({ ...params, StartIndex: String(start), Limit: '1000', EnableTotalRecordCount: 'true' })}`);
			items.push(...(data.Items || []));
			if (!data.Items?.length || items.length >= (data.TotalRecordCount ?? Infinity) || data.Items.length < 1000) break;
		}
		return items;
	}
	return async () => {
		if (cached && clock() - cached.fetchedAt < 60000) return cached;
		if (pending) return pending;
		pending = (async () => {
			const now = clock();
			const until = now + 6 * 60 * 60 * 1000;
			const params = { UserId: userId() };
			const [channels, listing] = await Promise.all([
				pages('/LiveTv/Channels', { ...params, AddCurrentProgram: 'true', SortBy: 'ChannelNumber,SortName', SortOrder: 'Ascending' }),
				pages('/LiveTv/Programs', { ...params, MinEndDate: new Date(now).toISOString(), MaxStartDate: new Date(until).toISOString(), SortBy: 'StartDate', SortOrder: 'Ascending', Fields: 'Overview', EnableImages: 'false' })
					.then(items => ({ items, available: true })).catch(() => ({ items: [], available: false }))
			]);
			cached = { fetchedAt: now, until, available: listing.available, channels: assembleGuide(channels, listing.items, now, until) };
			return cached;
		})();
		try { return await pending; } finally { pending = null; }
	};
}
