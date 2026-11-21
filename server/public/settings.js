/* Settings section tabs. One selected tab, one visible panel, and the active
 * tab is scrolled into view so a narrow tab strip never hides the choice. */
(() => {
	'use strict';
	const tabs = [...document.querySelectorAll('[data-panel]')];
	const panels = [...document.querySelectorAll('[data-settings]')];
	if (!tabs.length) return;

	function selected(tab) {
		return tab.getAttribute('aria-selected') === 'true';
	}

	function activate(tab, focus) {
		for (const item of tabs) {
			const active = item === tab;
			item.classList.toggle('active', active);
			item.setAttribute('aria-selected', String(active));
			item.setAttribute('tabindex', active ? '0' : '-1');
		}
		for (const panel of panels) panel.hidden = panel.dataset.settings !== tab.dataset.panel;
		if (focus && typeof tab.focus === 'function') tab.focus();
		// The tab strip is horizontally scrollable on phones. Bring the selected
		// tab fully into view instead of leaving it clipped at the edge.
		if (typeof tab.scrollIntoView === 'function') {
			tab.scrollIntoView({ block: 'nearest', inline: 'nearest' });
		}
	}

	function onKey(event) {
		const keys = ['ArrowLeft', 'ArrowRight', 'Home', 'End'];
		if (!keys.includes(event.key)) return;
		if (typeof event.preventDefault === 'function') event.preventDefault();
		const focused = tabs.findIndex(tab => tab === document.activeElement);
		const current = tabs.findIndex(selected);
		let index = focused >= 0 ? focused : current >= 0 ? current : 0;
		if (event.key === 'ArrowRight') index = (index + 1) % tabs.length;
		else if (event.key === 'ArrowLeft') index = (index - 1 + tabs.length) % tabs.length;
		else if (event.key === 'Home') index = 0;
		else if (event.key === 'End') index = tabs.length - 1;
		activate(tabs[index], true);
	}

	for (const tab of tabs) {
		tab.onclick = () => activate(tab, false);
		tab.addEventListener('keydown', onKey);
	}
	for (const button of document.querySelectorAll('[data-open-panel]')) {
		button.onclick = () => {
			const tab = tabs.find(item => item.dataset.panel === button.dataset.openPanel);
			if (tab) activate(tab, true);
		};
	}
	// Keep the markup's initial selection authoritative, but normalise the
	// matching panel and tabindex in case the page was restored or edited.
	const initial = tabs.find(selected) || tabs[0];
	if (initial) activate(initial, false);
})();
