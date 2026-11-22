/* Admin sport settings: choose which sports appear in Coming Soon.
 * The server enforces the local-admin gate; this panel only edits the stored
 * settings and shows how many fixtures each sport currently contributes. */
(() => {
	'use strict';
	const grid = document.querySelector('#sportChoices');
	const button = document.querySelector('#saveSportSettings');
	if (!grid || !button) return;
	const enabled = document.querySelector('#sportListingsEnabled');
	const football = document.querySelector('#sportFootballScope');
	const message = document.querySelector('#sportSettingsMessage');
	const status = document.querySelector('#sportSettingsStatus');
	const labels = {
		'american-football': 'American Football', 'australian-rules': 'Australian Rules', basketball: 'Basketball',
		boxing: 'Boxing', cricket: 'Cricket', cycling: 'Cycling', darts: 'Darts', football: 'Football',
		'formula-1': 'Formula 1', golf: 'Golf', 'horse-racing': 'Horse Racing', 'ice-hockey': 'Ice Hockey',
		mma: 'MMA', motogp: 'MotoGP', motorsport: 'Motorsport', pool: 'Pool', rugby: 'Rugby',
		snooker: 'Snooker', tennis: 'Tennis', 'winter-sports': 'Winter Sports'
	};
	const glyphs = {
		'american-football': '\u{1F3C8}', 'australian-rules': '\u{1F3C9}', basketball: '\u{1F3C0}',
		boxing: '\u{1F94A}', cricket: '\u{1F3CF}', cycling: '\u{1F6B4}', darts: '\u{1F3AF}',
		football: '\u26BD', 'formula-1': '\u{1F3CE}\uFE0F', golf: '\u26F3', 'horse-racing': '\u{1F40E}',
		'ice-hockey': '\u{1F3D2}', mma: '\u{1F94B}', motogp: '\u{1F3CD}\uFE0F', motorsport: '\u{1F3C1}',
		pool: '\u{1F3B1}', rugby: '\u{1F3C9}', snooker: '\u{1F3B1}', tennis: '\u{1F3BE}',
		'winter-sports': '\u26F7\uFE0F'
	};
	const label = slug => labels[slug] || String(slug || '').replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

	async function request(body) {
		const response = await fetch('/api/sport-settings', {
			method: body ? 'POST' : 'GET',
			cache: 'no-store',
			headers: body ? { 'Content-Type': 'application/json' } : {},
			body: body ? JSON.stringify(body) : undefined
		});
		const result = await response.json().catch(() => ({}));
		if (!response.ok) throw Error(result.error || 'Sport settings could not be loaded.');
		return result;
	}
	async function counts() {
		try {
			const response = await fetch('/api/coming-soon', { cache: 'no-store' });
			if (!response.ok) return new Map();
			const data = await response.json();
			const result = new Map();
			for (const item of data.sport || []) result.set(item.sport, (result.get(item.sport) || 0) + 1);
			return result;
		} catch { return new Map(); }
	}
	function render(value, now) {
		const known = Array.isArray(value.knownSports) ? value.knownSports : [];
		const chosen = new Set(Array.isArray(value.sports) ? value.sports : known);
		if (enabled) enabled.checked = value.enabled !== false;
		if (football) football.value = value.football === 'all' ? 'all' : 'uk';
		grid.replaceChildren(...known.map(slug => {
			const row = document.createElement('label');
			row.className = 'sport-choice';
			const input = document.createElement('input');
			input.type = 'checkbox';
			input.value = slug;
			input.checked = chosen.has(slug);
			const text = document.createElement('span');
			text.textContent = `${glyphs[slug] || '\u25CF'} ${label(slug)}`;
			const count = document.createElement('small');
			count.textContent = now?.get(slug) ? `${now.get(slug)} now` : '';
			row.append(input, text, count);
			return row;
		}));
		if (status) status.textContent = `${known.length} sports available from the listing source.`;
	}
	async function load() {
		button.disabled = true;
		try {
			if (status) status.textContent = 'Checking sport listings...';
			const [value, now] = await Promise.all([request(), counts()]);
			render(value, now);
			if (message) message.textContent = '';
			button.disabled = false;
		} catch (error) {
			if (status) status.textContent = 'Sport settings are unavailable.';
			if (message) message.textContent = error.message;
		}
	}
	button.onclick = async () => {
		button.disabled = true;
		if (message) message.textContent = 'Saving sport listings...';
		try {
			const sports = [...grid.querySelectorAll('input[type=checkbox]')].filter(input => input.checked).map(input => input.value);
			const value = await request({
				enabled: enabled ? enabled.checked : true,
				sports,
				football: football ? football.value : 'uk'
			});
			render(value, await counts());
			if (message) message.textContent = 'Saved. The Coming Soon board updates on the next refresh.';
			button.disabled = false;
		} catch (error) {
			if (message) message.textContent = error.message;
			button.disabled = false;
		}
	};
	void load();
})();
