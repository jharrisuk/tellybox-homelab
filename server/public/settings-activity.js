/* Settings Watching panel summary. The Activity page and this panel both render
 * the same sanitized /api/activity/summary read model through
 * activity-summary.js, so the five metrics and the watching list cannot drift
 * apart. The full log and configuration stay behind administrator access. */
(function () {
	'use strict';
	const lib = globalThis.TellyboxActivitySummary;
	const stats = document.querySelector('#settingsActivityStats');
	const watching = document.querySelector('#settingsWatchingNow');
	const message = document.querySelector('#settingsActivityMessage');
	if (!lib || !stats || !watching || !message) return;
	const state = { snapshot: null, at: 0, loading: false };

	function panelOpen() {
		const panel = document.querySelector('[data-settings="watching"]');
		return Boolean(panel && !panel.hidden);
	}

	async function load(force) {
		if (state.loading) return;
		if (!force && state.snapshot && Date.now() - state.at < 30000) return;
		state.loading = true;
		try {
			const response = await fetch('/api/activity/summary', { cache: 'no-store' });
			if (!response.ok) throw new Error('Read-only activity statistics are available only at home or to an installation administrator.');
			const snapshot = await response.json();
			state.snapshot = snapshot;
			state.at = Date.now();
			lib.renderMetrics(stats, snapshot);
			const count = lib.renderWatching(watching, snapshot, { empty: 'No one is watching right now.' });
			message.textContent = 'Read-only statistics. '
				+ (count ? count + (count === 1 ? ' stream now. ' : ' streams now. ') : 'No one is watching right now. ')
				+ 'Updated ' + new Date().toLocaleTimeString() + '. Full logs, saved browsers and configuration need administrator access.';
		} catch (error) {
			message.textContent = error.message;
		} finally {
			state.loading = false;
		}
	}

	function openFromHash() {
		if (!location.hash || !['#activity', '#watching'].includes(location.hash)) return;
		const button = document.querySelector('[data-panel="watching"]');
		if (button) button.click();
		if (panelOpen()) {
			void load(false);
			if (typeof document.querySelector('#activity')?.scrollIntoView === 'function') {
				document.querySelector('#activity').scrollIntoView({ block: 'start' });
			}
		}
	}

	for (const button of document.querySelectorAll('[data-panel]')) {
		button.addEventListener('click', () => {
			if (button.dataset.panel !== 'watching') return;
			globalThis.setTimeout(() => { if (!document.hidden) void load(false); }, 0);
		});
	}
	globalThis.addEventListener('hashchange', openFromHash);
	openFromHash();
	if (panelOpen()) void load(false);
	setInterval(() => { if (!document.hidden && panelOpen()) void load(false); }, 30000);
})();
