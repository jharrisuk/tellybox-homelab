(() => {
	const fields = [
		['englishSubtitles', '#serverDefaultEnglish'],
		['autoNext', '#serverDefaultAutoNext'],
		['skipIntros', '#serverDefaultSkipIntros']
	];
	const button = document.querySelector('#savePlaybackDefaults');
	if (!button) return;
	const message = document.querySelector('#playbackDefaultsMessage');
	function fill(value) {
		const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
		for (const [key, selector] of fields) {
			const input = document.querySelector(selector);
			if (input) input.checked = source[key] === true;
		}
	}
	async function request(body) {
		const response = await fetch('/api/auth/playback-defaults', {
			method: body ? 'POST' : 'GET',
			cache: 'no-store',
			headers: body ? { 'Content-Type': 'application/json' } : {},
			body: body ? JSON.stringify(body) : undefined
		});
		const result = await response.json();
		if (!response.ok) throw Error(result.error || 'Playback defaults could not be loaded.');
		return result;
	}
	button.disabled = true;
	request().then(value => { fill(value); button.disabled = false; }).catch(error => { if (message) message.textContent = error.message; });
	button.onclick = async () => {
		button.disabled = true;
		if (message) message.textContent = 'Saving playback defaults...';
		try {
			const value = Object.fromEntries(fields.map(([key, selector]) => [key, document.querySelector(selector)?.checked === true]));
			fill(await request(value));
			if (message) message.textContent = 'Saved. Viewers without their own saved choice will use these defaults.';
			void window.TellyboxViewerPreferences?.load?.();
		} catch (error) {
			if (message) message.textContent = error.message;
		} finally {
			button.disabled = false;
		}
	};
})();
