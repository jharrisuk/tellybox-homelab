(() => {
	const input = document.querySelector('#serverPausedTimeout');
	const button = document.querySelector('#savePausedTimeout');
	const message = document.querySelector('#pausedTimeoutMessage');
	if (!input || !button) return;
	async function request(body) {
		const response = await fetch('/api/auth/paused-timeout', {
			method: body ? 'POST' : 'GET',
			cache: 'no-store',
			headers: body ? { 'Content-Type': 'application/json' } : {},
			body: body ? JSON.stringify(body) : undefined
		});
		const result = await response.json();
		if (!response.ok) throw Error(result.error || 'Paused-stream timeout could not be loaded.');
		return result;
	}
	button.disabled = true;
	request().then(value => {
		input.value = String(value.minutes);
		button.disabled = false;
	}).catch(error => { if (message) message.textContent = error.message; });
	button.onclick = async () => {
		const minutes = Number(input.value);
		if (!Number.isInteger(minutes) || minutes < 0 || minutes > 1440) {
			if (message) message.textContent = 'Use a whole number from 0 to 1440 minutes.';
			return;
		}
		button.disabled = true;
		if (message) message.textContent = 'Saving pause timeout...';
		try {
			const value = await request({ minutes });
			input.value = String(value.minutes);
			if (message) message.textContent = value.minutes === 0
				? 'Saved. Paused streams stay open until the viewer leaves.'
				: `Saved. Paused films, local titles and catch-up close after ${value.minutes} minutes.`;
		} catch (error) {
			if (message) message.textContent = error.message;
		} finally {
			button.disabled = false;
		}
	};
})();
