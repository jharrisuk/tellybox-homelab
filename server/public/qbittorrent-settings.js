/* Read-only qBittorrent download statistics for the Settings page.
 * Configuration, credentials and connection tests live in installation
 * settings on port 8990. This script never renders a form, never sends a
 * credential and never calls an owner-only route. */
(() => {
	'use strict';
	const root = document.querySelector('#qbittorrentSettings');
	if (!root) return;

	function el(tag, text, className) {
		const node = document.createElement(tag);
		if (text !== undefined && text !== null) node.textContent = String(text);
		if (className) node.className = className;
		return node;
	}

	function stateText(summary) {
		const state = String(summary?.state || '');
		if (summary?.configured !== true || state === 'unconfigured') return 'Not configured. Add the WebUI address and sign-in in installation settings on port 8990.';
		if (summary?.enabled !== true || state === 'disabled') return 'Switched off. No qBittorrent request is made.';
		if (state === 'idle') return 'Waiting for the first check.';
		if (state === 'ok') return 'Connected.';
		if (state === 'stale') return 'Showing the last good reading.';
		const failures = {
			unreachable: 'Could not reach qBittorrent.',
			timeout: 'qBittorrent did not answer in time.',
			'auth-failed': 'qBittorrent rejected the saved sign-in.',
			'auth-throttled': 'Sign-in paused after repeated failures.',
			banned: 'This address is paused after repeated sign-in failures.',
			invalid: 'qBittorrent returned an unreadable response.',
			'too-large': 'qBittorrent returned too much data.',
			backoff: 'Checks paused after a failure.'
		};
		return failures[state] || 'The last check did not complete.';
	}

	function rateText(value) {
		const number = Number(value);
		if (!Number.isFinite(number) || number < 0) return '0 B/s';
		const units = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
		let amount = number;
		let index = 0;
		while (amount >= 1000 && index < units.length - 1) { amount = amount / 1000; index += 1; }
		return (index === 0 ? String(Math.round(amount)) : amount.toFixed(1)) + ' ' + units[index];
	}

	function checkedSentence(value) {
		const number = Number(value);
		if (!Number.isFinite(number) || number <= 0) return null;
		let text = '';
		try { text = new Date(number).toLocaleTimeString(); } catch { text = ''; }
		return text ? 'Last checked ' + text + '.' : null;
	}

	function statCard(value, label, detail) {
		const card = el('div', null, 'activity-stat');
		card.append(el('strong', String(value), 'activity-stat-value'));
		card.append(el('span', label, 'activity-stat-label'));
		if (detail) card.append(el('span', detail, 'activity-stat-detail'));
		return card;
	}

	function summaryBlock(summary) {
		const wrap = el('div');
		wrap.append(el('p', stateText(summary), 'qb-status qb-status-' + String(summary.state || 'unknown')));
		// Only show counts when there is a usable reading. A failed check or a
		// first-run idle state must not look like an empty download queue.
		if (summary.configured !== true || summary.enabled !== true || !(summary.reachable === true || summary.stale === true)) return wrap;
		const counts = summary.counts || {};
		const lower = new Set(Array.isArray(summary.countsLowerBound) ? summary.countsLowerBound : []);
		const value = key => (Number.isFinite(Number(counts[key])) ? Math.max(0, Math.floor(Number(counts[key]))) : 0);
		const detail = key => lower.has(key) ? 'lower bound' : null;
		const grid = el('div', null, 'activity-stats');
		grid.append(statCard(value('downloading'), 'Downloading', detail('downloading')));
		grid.append(statCard(value('queued'), 'Queued', detail('queued')));
		grid.append(statCard(value('seeding'), 'Seeding', detail('seeding')));
		grid.append(statCard(value('attention'), 'Need attention', detail('attention')));
		wrap.append(grid);
		const transfer = summary.transfer;
		if (transfer && typeof transfer === 'object') {
			wrap.append(el('p', rateText(transfer.downloadSpeed) + ' down, ' + rateText(transfer.uploadSpeed) + ' up.', 'auth-note'));
		}
		const checked = checkedSentence(summary.checkedAt);
		if (checked) wrap.append(el('p', checked, 'auth-note'));
		return wrap;
	}

	function render(summary, notice) {
		root.replaceChildren();
		const block = el('div', null, 'settings-heading');
		const copy = el('div');
		const title = el('h2', 'Downloads');
		title.id = 'qbittorrentSettingsHeading';
		copy.append(el('p', 'OPTIONAL INTEGRATION', 'eyebrow'), title);
		copy.append(el('p', summary ? 'Read-only qBittorrent statistics.' : 'qBittorrent download statistics are unavailable.'));
		block.append(copy);
		root.append(block);
		if (summary) root.append(summaryBlock(summary));
		else if (notice) root.append(el('p', notice, 'auth-note'));
		root.append(el('p', 'Configuration and the full download list are in installation settings on port 8990. Completed downloads are not the same as imported or playable titles.', 'auth-note'));
	}

	async function load() {
		try {
			const response = await fetch('/api/qbittorrent/summary', {
				cache: 'no-store', credentials: 'same-origin', headers: { accept: 'application/json' }
			});
			if (response.status === 403) {
				render(null, 'Read-only download statistics are available at home or to an installation administrator.');
				return;
			}
			if (!response.ok) throw new Error('unavailable');
			const summary = await response.json();
			if (!summary || summary.readOnly !== true) throw new Error('unavailable');
			render(summary, null);
		} catch {
			render(null, 'The download statistics could not be read. This does not start a qBittorrent check.');
		}
	}

	load();
})();
