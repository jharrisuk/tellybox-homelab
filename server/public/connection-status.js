(() => {
	const brand = document.querySelector('.brand');
	if (!brand) return;
	const group = document.createElement('div');
	group.className = 'brand-connection';
	brand.before(group); group.append(brand);
	const button = document.createElement('button');
	button.type = 'button'; button.className = 'connection-badge';
	button.setAttribute('aria-expanded', 'false');
	const note = document.createElement('span');
	note.className = 'connection-note'; note.id = 'connectionNote'; note.hidden = true;
	button.setAttribute('aria-controls', note.id);
	group.append(button, note);
	const icons = {
		local: '<path d="m3 10 9-7 9 7v11h-6v-7H9v7H3z"/>',
		relay: '<path d="M5 18C-1 18 0 9 6 10C6 1 18 1 19 10C25 10 25 18 19 18Z"/>',
		unknown: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10v.1"/>'
	};
	function render(route, text) {
		button.dataset.route = route;
		button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' + icons[route] + '</svg>';
		button.title = text; button.setAttribute('aria-label', text); note.textContent = text;
	}
	function close() { note.hidden = true; button.setAttribute('aria-expanded', 'false'); }
	button.onclick = () => { note.hidden = !note.hidden; button.setAttribute('aria-expanded', String(!note.hidden)); };
	document.addEventListener('click', event => { if (!group.contains(event.target)) close(); });
	group.addEventListener('focusout', event => { if (!group.contains(event.relatedTarget)) close(); });
	group.addEventListener('keydown', event => { if (event.key === 'Escape') close(); });
	let media = null, generation = 0;
	function show() {
		if (!navigator.onLine) { render('unknown', 'You’re offline. Reconnect to check the streaming route.'); return; }
		if (media) render(media.route, media.text);
	}
	window.addEventListener('tellybox-route', event => {
		if (!icons[event.detail?.route] || typeof event.detail.text !== 'string') return;
		media = event.detail; generation++; show();
	});
	async function check() {
		if (document.hidden) return;
		if (media) { show(); return; }
		const request = ++generation;
		try {
			const response = await fetch('/api/auth/status', { cache: 'no-store', signal: AbortSignal.timeout(5000) });
			if (!response.ok) throw new Error('Unavailable');
			const access = await response.json();
			if (request !== generation) return;
			render(access.local ? 'local' : 'relay', access.local ? 'Local connection · connected directly to your home server.' : 'Relay connection · this page is using the internet relay. Playback can switch to your home server when available.');
		} catch { if (request === generation) render('unknown', 'Connection unavailable · unable to check your server.'); }
	}
	window.addEventListener('offline', () => { generation++; show(); });
	window.addEventListener('online', () => { if (media) show(); else void check(); });
	document.addEventListener('visibilitychange', () => { if (!document.hidden) void check(); });
	render('unknown', 'Checking connection…');
	void check();
	setInterval(check, 30000);
})();
