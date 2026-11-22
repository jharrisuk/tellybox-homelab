window.jserverCalendar = {
	days(schedule, now = new Date(), { past = 0, upcoming = 7 } = {}) {
		const key = date => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
		const todayKey = key(now);
		const days = Array.from({ length: past + upcoming }, (_, index) => {
			const offset = index - past;
			const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offset);
			const dayKey = key(date);
			// Monday first, so every column is the same weekday on every row.
			return { key: dayKey, date, weekday: (date.getDay() + 6) % 7, past: offset < 0, today: dayKey === todayKey, items: [] };
		});
		for (const item of [...schedule.tv, ...schedule.movies]) {
			// Only the episode the card actually represents may keep the library
			// link. Spreading the item onto every row sent every aired episode to
			// the same id, which is the wrong-episode bug again by another road.
			const chosen = episode => Number(episode?.season) === Number(item.seasonNumber)
				&& Number(episode?.number) === Number(item.episodeNumber);
			const entries = item.type === 'tv' && item.episodes?.length ? item.episodes.map(episode => {
				const { library, ...base } = item;
				return { ...base, ...(chosen(episode) && library ? { library } : {}),
					date: episode.date, episodeTitle: episode.title, episode: `S${episode.season} · E${episode.number}` };
			}) : [item];
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
	},

	// Rows of seven, Monday..Sunday, with null for a cell the window does not
	// cover. Padding is what keeps a Monday above a Monday.
	weeks(days) {
		const rows = [];
		let row = [];
		for (const day of days) {
			if (row.length === 7) { rows.push(row); row = []; }
			while (row.length < day.weekday) row.push(null);
			if (row.length === 7) { rows.push(row); row = []; }
			row.push(day);
		}
		while (row.length && row.length < 7) row.push(null);
		if (row.length) rows.push(row);
		return rows;
	}
};
