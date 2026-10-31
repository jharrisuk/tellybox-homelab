(() => {
	const header = document.querySelector('.topbar');
	const toggle = document.querySelector('#menuToggle');
	const panel = document.querySelector('#siteNavigation');
	if (!header || !toggle || !panel) return;
	const nav=panel.querySelector('nav');
	if(nav&&!nav.querySelector('[href="/search"]')){const link=document.createElement('a');link.className='nav-item';link.href='/search';link.textContent='⌕ Search';link.setAttribute('aria-label','Search everywhere');if(location.pathname==='/search'){link.classList.add('active');link.setAttribute('aria-current','page');}nav.append(link);}
	const mobile = matchMedia('(max-width: 850px)');
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
