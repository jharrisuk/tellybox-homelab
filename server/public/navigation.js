(() => {
	const header = document.querySelector('.topbar');
	const toggle = document.querySelector('#menuToggle');
	const panel = document.querySelector('#siteNavigation');
	if (!header || !toggle || !panel) return;

	// One canonical primary navigation for every page. The markup is repeated for
	// no-JS use; this keeps older pages in the same order and removes dynamic
	// library buttons that used to grow the bar without limit.
	const canonical = [
		['Home', '/', ''],
		['Discover', '/discover', ''],
		['Coming soon', '/coming-soon', 'nav-coming'],
		['Films', '/?view=movies', ''],
		['Series', '/?view=tvshows', ''],
		['Live TV', '/?view=livetv', ''],
		['24/7', '/?view=nonstop', ''],
		['Recordings', '/?view=recordings', ''],
		['Search', '/search', ''],
		['Activity', '/activity', ''],
	];
	const nav = panel.querySelector('nav');
	if (nav) {
		const view = new URLSearchParams(location.search).get('view');
		const active = view === 'movies' ? '/?view=movies'
			: view === 'tvshows' ? '/?view=tvshows'
			: view === 'livetv' ? '/?view=livetv'
			: view === 'nonstop' ? '/?view=nonstop'
			: view === 'recordings' ? '/?view=recordings'
			: location.pathname === '/search' ? '/search'
			: location.pathname === '/activity' ? '/activity'
			: location.pathname === '/discover' ? '/discover'
			: location.pathname === '/coming-soon' ? '/coming-soon'
			: location.pathname === '/' ? '/' : '';
		const keep = new Set();
		for (const [label, href, extra] of canonical) {
			let link = [...nav.querySelectorAll('a.nav-item')].find(node => node.getAttribute('href') === href);
			if (!link && href === '/') link = nav.querySelector('[data-library="home"]');
			if (!link) {
				link = document.createElement('a');
				link.className = 'nav-item';
				link.href = href;
			}
			link.textContent = label;
			link.className = 'nav-item' + (extra ? ' ' + extra : '') + (href === active ? ' active' : '');
			if (href === active) link.setAttribute('aria-current', 'page');
			else link.removeAttribute('aria-current');
			keep.add(link);
			nav.append(link);
		}
		for (const node of [...nav.children]) if (!keep.has(node)) node.remove();
	}

	const account = panel.querySelector('.account-actions');
	if (account) {
		for (const old of account.querySelectorAll('[data-watching-settings]')) old.remove();
	}
	// Keep one Settings destination on every page. Local/home viewers reach the
	// full Settings page; a signed-in remote viewer reaches their own Watching
	// settings, never the admin surface.
	const settingsLink = document.querySelector('#remoteSettings');
	if (settingsLink) {
		fetch('/api/auth/status', { credentials: 'same-origin', headers: { Accept: 'application/json' } })
			.then(response => response.ok ? response.json() : null)
			.then(access => {
				if (!access) return;
				const atHome = Boolean(access.local || access.home);
				settingsLink.hidden = !(atHome || access.authenticated);
				settingsLink.textContent = 'Settings';
				if (atHome) settingsLink.href = access.local ? '/settings'
					: new URL('/settings', access.localPlayback?.origin || location.origin).href;
				else settingsLink.href = '/preferences.html';
			})
			.catch(() => {});
	}

	const mobile = matchMedia('(max-width: 1100px)');
	const routing = document.querySelector('#localRouting');
	const anchor = document.createComment('Streaming connection desktop position');
	if (routing) routing.before(anchor);
	function close(restoreFocus = false) {
		header.classList.remove('menu-open');
		toggle.setAttribute('aria-expanded', 'false');
		if (restoreFocus) toggle.focus();
	}
	function syncLayout() {
		const focusedInside = panel.contains(document.activeElement);
		close(mobile.matches && focusedInside);
		if (routing) {
			if (mobile.matches) panel.append(routing);
			else anchor.after(routing);
		}
	}
	toggle.onclick = () => {
		const open = toggle.getAttribute('aria-expanded') !== 'true';
		header.classList.toggle('menu-open', open);
		toggle.setAttribute('aria-expanded', String(open));
	};
	panel.addEventListener('click', event => {
		if (!mobile.matches) return;
		const selected = event.target.closest('nav a, nav button, .account-actions a, .account-actions button');
		if (selected) close(selected.tagName === 'BUTTON');
	});
	document.addEventListener('click', event => { if (!header.contains(event.target)) close(); });
	document.addEventListener('keydown', event => {
		if (event.key === 'Escape' && toggle.getAttribute('aria-expanded') === 'true') { event.preventDefault(); close(true); }
	});
	header.addEventListener('focusout', event => {
		if (event.relatedTarget && !header.contains(event.relatedTarget)) close();
	});
	mobile.addEventListener('change', syncLayout);
	syncLayout();
})();
