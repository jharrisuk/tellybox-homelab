window.jserverCalendar = {
	days(schedule, now = new Date()) {
		const key = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
		const days = Array.from({ length: 7 }, (_, offset) => {
			const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
			return { key: key(date), date, items: [] };
		});
		for (const item of [...schedule.tv, ...schedule.movies]) {
			const entries = item.type === 'tv' && item.episodes?.length ? item.episodes.map(episode => ({
				...item, date: episode.date, episodeTitle: episode.title, episode: `S${episode.season} · E${episode.number}`
			})) : [item];
			for (const entry of entries) {
				if (!entry.date) continue;
				const date = new Date(entry.date);
				if (!Number.isFinite(date.getTime())) continue;
				// Films use their published calendar date; episode air times use the viewer's timezone.
				const dateKey = entry.type === 'movie' ? date.toISOString().slice(0, 10) : key(date);
				const day = days.find(day => day.key === dateKey);
				if (day) day.items.push(entry);
			}
		}
		for (const day of days) day.items.sort((a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title));
		return days;
	}
};
