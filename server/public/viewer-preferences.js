(() => {
	const preferences = [
		{ key: 'tellybox-english', input: '#englishSubtitles', server: 'englishSubtitles' },
		{ key: 'tellybox-autoplay', input: '#autoNext', server: 'autoNext' },
		{ key: 'tellybox-skip-intros', input: '#skipIntros', server: 'skipIntros' }
	];
	const server = { englishSubtitles: false, autoNext: false, skipIntros: false };
	function normalise(value) {
		const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
		return { englishSubtitles: source.englishSubtitles === true, autoNext: source.autoNext === true, skipIntros: source.skipIntros === true };
	}
	function localChoice(key) {
		try {
			const value = localStorage.getItem(key);
			return value === 'true' ? true : value === 'false' ? false : undefined;
		} catch { return undefined; }
	}
	function effective(key, serverKey) {
		const local = localChoice(key);
		return local === undefined ? server[serverKey] === true : local;
	}
	function update(spec) {
		const input = document.querySelector(spec.input);
		if (!input) return;
		const overridden = localChoice(spec.key) !== undefined;
		input.checked = effective(spec.key, spec.server);
		const state = document.querySelector(`[data-preference-state="${spec.server}"]`);
		if (state) state.textContent = overridden ? 'Saved for this browser.' : `Using the server default (${server[spec.server] ? 'on' : 'off'}).`;
		const reset = document.querySelector(`[data-preference-reset="${spec.server}"]`);
		if (reset) reset.hidden = !overridden;
	}
	function render() {
		for (const spec of preferences) update(spec);
	}
	function apply(value) {
		Object.assign(server, normalise(value));
		render();
	}
	for (const spec of preferences) {
		const input = document.querySelector(spec.input);
		if (input) {
			input.checked = effective(spec.key, spec.server);
			input.onchange = () => {
				try { localStorage.setItem(spec.key, String(input.checked)); } catch { /* Private browsing can block storage. */ }
				update(spec);
			};
		}
		const reset = document.querySelector(`[data-preference-reset="${spec.server}"]`);
		if (reset) reset.onclick = () => {
			try { localStorage.removeItem(spec.key); } catch { /* Private browsing can block storage. */ }
			update(spec);
		};
	}
	async function load() {
		try {
			if (typeof fetch !== 'function') return render();
			const response = await fetch('/api/capabilities', { cache: 'no-store' });
			if (!response.ok) throw Error('Playback defaults unavailable');
			apply((await response.json()).playbackDefaults);
		} catch {
			Object.assign(server, normalise(null));
			render();
		}
	}
	render();
	void load();
	const root = typeof window !== 'undefined' ? window : globalThis;
	root.TellyboxViewerPreferences = { effective, serverDefaults: () => ({ ...server }), apply, render, load };
})();
