window.jserverUI = {
	ratings(values = [], { links = false, compact = false } = {}) {
		const group = document.createElement('div'); group.className = 'ratings' + (compact ? ' compact-ratings' : '');
		group.setAttribute('aria-label', 'Online ratings');
		for (const rating of values.slice(0, compact ? 2 : 4)) {
			const badge = document.createElement(links && rating.url ? 'a' : 'span'); badge.className = 'rating-score';
			if (badge.tagName === 'A') { badge.href = rating.url; badge.target = '_blank'; badge.rel = 'noopener'; }
			const source = document.createElement('span'); source.textContent = rating.source;
			const value = document.createElement('strong'); value.textContent = rating.max === 100 ? `${Math.round(rating.value)}%` : `${rating.value.toFixed(1)}/10`;
			badge.append(source, value);
			badge.title = rating.votes ? `${rating.votes.toLocaleString()} ratings` : rating.source;
			group.append(badge);
		}
		if (!values.length && !compact) { const empty = document.createElement('span'); empty.className = 'ratings-empty'; empty.textContent = 'No ratings available yet'; group.append(empty); }
		return group;
	},
	status(label) {
		return ({ 'Not requested': 'Add to the list', Requested: 'On the list', 'Partly available': 'Episodes available', Available: 'Ready to watch', 'Needs attention': 'Delayed', 'Not available': 'Not ready yet' })[label] || label;
	},
	comingDate(item) {
		if (!item.date) return 'Date to be announced';
		return new Date(item.date).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', ...(item.type === 'movie' ? { timeZone: 'UTC' } : {}) });
	}
};
