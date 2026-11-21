/* Release 134: owner-only Activity downloads view.
 *
 * Polls only while this tab is visible. A qBittorrent hash never reaches this
 * script: rows carry an opaque per-process id, and a separate one-use review
 * token is requested for exactly one row and one action before any delete.
 */
(() => {
	'use strict';
	const nodes = {
		filter: document.querySelector('#qbFilter'),
		category: document.querySelector('#qbCategory'),
		refresh: document.querySelector('#qbRefresh'),
		count: document.querySelector('#qbCount'),
		status: document.querySelector('#qbStatus'),
		global: document.querySelector('#qbGlobal'),
		rows: document.querySelector('#qbRows'),
		empty: document.querySelector('#qbEmpty'),
		previous: document.querySelector('#qbPrevious'),
		next: document.querySelector('#qbNext'),
		dialog: document.querySelector('#qbReview'),
		reviewSummary: document.querySelector('#qbReviewSummary'),
		reviewWarning: document.querySelector('#qbReviewWarning'),
		ackRow: document.querySelector('#qbAckRow'),
		ack: document.querySelector('#qbDeleteAck'),
		reviewMessage: document.querySelector('#qbReviewMessage'),
		reviewExpiry: document.querySelector('#qbReviewExpiry'),
		cancel: document.querySelector('#qbCancel'),
		remove: document.querySelector('#qbRemove'),
		deleteFiles: document.querySelector('#qbDeleteFiles')
	};
	if (!nodes.rows) return;

	const state = {
		timer: null, inFlight: null, abort: null, failures: 0,
		filter: 'downloading', category: null, offset: 0, limit: 50,
		generation: null, stopped: false, status: null, review: null, expiryTimer: null,
		queue: null, queueAt: 0, queuePending: false
	};

	function el(tag, text, className) {
		const node = document.createElement(tag);
		if (text !== undefined && text !== null) node.textContent = String(text);
		if (className) node.className = className;
		return node;
	}

	function formatBytes(value) {
		const bytes = Number(value);
		if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
		const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
		let size = bytes, unit = 0;
		while (size >= 1024 && unit < units.length - 1) { size /= 1024; unit += 1; }
		return (unit === 0 ? Math.round(size) : size.toFixed(size >= 100 ? 0 : size >= 10 ? 1 : 2)) + ' ' + units[unit];
	}

	function formatSpeed(value) {
		const bytes = Number(value);
		if (!Number.isFinite(bytes) || bytes <= 0) return '0 B/s';
		return formatBytes(bytes) + '/s';
	}

	function formatEta(value) {
		const seconds = Number(value);
		if (!Number.isFinite(seconds) || seconds < 0) return null;
		if (seconds < 60) return Math.max(1, Math.floor(seconds)) + ' sec';
		if (seconds < 3600) return Math.floor(seconds / 60) + ' min';
		return Math.floor(seconds / 3600) + ' hr ' + Math.floor(seconds % 3600 / 60) + ' min';
	}

	function formatWhen(value) {
		const at = Number(value);
		if (!Number.isFinite(at) || at <= 0) return 'unknown time';
		try { return new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(at)); }
		catch { return 'unknown time'; }
	}

	function statusMessage(data) {
		const base = {
			unconfigured: 'qBittorrent is not configured. Add the WebUI address and sign-in in installation settings on port 8990.',
			disabled: 'qBittorrent monitoring is switched off. No request was made, and polling has stopped.',
			ok: 'Connected. This reading is read-only.',
			stale: 'qBittorrent could not be reached for the latest check. The last good reading is shown.',
			unreachable: 'qBittorrent could not be reached. This is not the same as an empty download list.',
			timeout: 'qBittorrent did not answer in time.',
			'auth-failed': 'qBittorrent refused the saved sign-in. Update the WebUI credentials in installation settings on port 8990.',
			'auth-throttled': 'Sign-in is paused briefly after repeated failures.',
			banned: 'qBittorrent has temporarily banned this address after failed sign-ins. Wait, then check the credentials.',
			invalid: 'qBittorrent returned a response this page could not read.',
			'too-large': 'qBittorrent returned more data than this page will read.',
			backoff: 'Checks are paused briefly after a failure.',
			idle: 'No qBittorrent check has run yet.'
		}[data.state] || 'The qBittorrent check did not complete.';
		if (data.state === 'stale') return base + ' Last good reading: ' + formatWhen(data.upstreamAt) + '.';
		if (data.state === 'ok' && data.upstreamAt) return base + ' Updated ' + formatWhen(data.upstreamAt) + '.';
		return base;
	}

	function renderStatus(data) {
		state.status = data;
		nodes.status.textContent = statusMessage(data);
		nodes.status.dataset.state = String(data.state || '');
		nodes.status.setAttribute('aria-busy', 'false');
		const global = data.global;
		nodes.global.textContent = global
			? 'Global speed: ' + formatSpeed(global.downloadSpeed) + ' down · ' + formatSpeed(global.uploadSpeed) + ' up' + (global.connection ? ' · ' + global.connection : '')
			: '';
	}

	function badge(text, className) {
		return el('span', text, 'qb-badge ' + (className || ''));
	}

	function statsRow(label, value) {
		const node = el('div', null, 'qb-stat');
		node.append(el('span', label, 'qb-stat-label'), el('strong', value, 'qb-stat-value'));
		return node;
	}

	function renderRow(item) {
		const article = el('article', null, 'qb-row' + (item.needsAttention ? ' qb-attention' : ''));
		const head = el('div', null, 'qb-row-head');
		const title = el('div', null, 'qb-row-title');
		title.append(el('h2', item.name));
		const badges = el('div', null, 'qb-badges');
		badges.append(badge(item.stateLabel, 'qb-state'));
		if (item.category) badges.append(badge(item.category, 'qb-category'));
		if (item.needsAttention) badges.append(badge('Needs attention', 'qb-needs-attention'));
		else if (item.stalledHint) badges.append(badge('qBittorrent reports stalled', 'qb-hint'));
		if (item.paused) badges.append(badge('Paused', 'qb-muted'));
		if (item.queued) badges.append(badge('Queued', 'qb-muted'));
		if (item.checking) badges.append(badge('Checking', 'qb-muted'));
		if (item.moving) badges.append(badge('Moving files', 'qb-muted'));
		if (item.completed) badges.append(badge('Download complete', 'qb-complete'));
		title.append(badges);
		head.append(title, el('span', item.displayHash, 'qb-display-hash'));

		const progress = document.createElement('progress');
		progress.className = 'qb-progress';
		progress.max = 100;
		progress.value = Math.round(item.progress * 1000) / 10;
		progress.setAttribute('aria-label', 'Download progress');

		const stats = el('div', null, 'qb-stats');
		stats.append(
			statsRow('Progress', (item.progress * 100).toFixed(1) + '%'),
			statsRow('Size', formatBytes(item.size)),
			statsRow('Download', formatSpeed(item.dlspeed)),
			statsRow('Upload', formatSpeed(item.upspeed))
		);
		const eta = formatEta(item.eta);
		if (eta) stats.append(statsRow('ETA', eta));
		if (Number.isFinite(item.seeds)) stats.append(statsRow('Seeds', String(item.seeds) + (Number.isFinite(item.seedsTotal) ? ' / ' + item.seedsTotal : '')));
		if (item.needsAttention) stats.append(statsRow('No progress', formatDuration(item.measuredNoProgressSeconds)));

		article.append(head, progress, stats);
		if (item.note) article.append(el('p', item.note, 'auth-note qb-note'));
		if (item.needsAttention) article.append(el('p', 'Needs attention only. This is a measured lack of progress, not proof that the release is broken. Metadata and seed counts alone are never treated as proof.', 'auth-note qb-note'));

		const actions = el('div', null, 'qb-row-actions');
		const keep = el('button', 'Remove torrent, keep files', 'button secondary');
		keep.type = 'button';
		keep.onclick = () => startReview(item, 'remove');
		const files = el('button', 'Delete torrent and files...', 'button quiet qb-danger-text');
		files.type = 'button';
		files.onclick = () => startReview(item, 'delete-files');
		actions.append(keep, files);
		article.append(actions);
		return article;
	}

	function formatDuration(seconds) {
		const value = Math.max(0, Math.floor(Number(seconds) || 0));
		if (value < 60) return value + ' sec';
		if (value < 3600) return Math.floor(value / 60) + ' min';
		return Math.floor(value / 3600) + ' hr ' + Math.floor(value % 3600 / 60) + ' min';
	}

	// The queue counts come from the existing cached read-only summary. They are
	// requested only while the downloading view is empty, so the normal poll
	// still uses one timer and one list request.
	function queueTotal(counts) {
		return ['downloading', 'queued', 'seeding', 'paused', 'checking', 'moving', 'other']
			.reduce((sum, key) => sum + (Number(counts?.[key]) || 0), 0);
	}

	function emptyMessage(data) {
		if (data.state === 'ok' || data.state === 'stale') {
			if (state.filter === 'downloading') {
				const counts = state.queue;
				if (counts && Number.isFinite(Number(counts.seeding))) {
					const total = queueTotal(counts);
					const seeding = Number(counts.seeding) || 0;
					return 'Nothing is downloading right now. ' + total + (total === 1 ? ' torrent' : ' torrents')
						+ ' in the queue' + (seeding > 0 ? ', ' + seeding + ' seeding' : '')
						+ '. Choose Seeding or Everything to see the rest.';
				}
				return 'Nothing is downloading right now. Choose Seeding or Everything to see the rest of the queue.';
			}
			if (state.filter === 'all' && state.category === null) return 'No torrents are in this qBittorrent queue.';
			return 'No torrents match this filter.';
		}
		return statusMessage(data);
	}

	async function loadQueueCounts() {
		if (state.queuePending) return;
		if (state.queueAt && Date.now() - state.queueAt < 60000) return;
		state.queuePending = true;
		try {
			const response = await fetch('/api/qbittorrent/summary', {
				credentials: 'same-origin', headers: { accept: 'application/json' }
			});
			if (!response.ok) return;
			const data = await response.json().catch(() => null);
			if (!data?.counts || !Number.isFinite(Number(data.counts.seeding))) return;
			state.queue = data.counts;
			state.queueAt = Date.now();
			if (state.status && (state.status.rows?.length || 0) === 0 && state.filter === 'downloading') {
				nodes.empty.textContent = emptyMessage(state.status);
			}
		} catch {
			// The empty state keeps its filter wording when counts are unavailable.
		} finally {
			state.queuePending = false;
		}
	}

	function renderCategories(data) {
		const categories = data.filters?.categories || [];
		const selected = state.category === null ? '' : state.category;
		nodes.category.replaceChildren();
		const all = el('option', 'All categories');
		all.value = '';
		nodes.category.append(all);
		for (const name of categories) {
			const option = el('option', name);
			option.value = name;
			nodes.category.append(option);
		}
		const uncategorised = el('option', 'Uncategorised');
		uncategorised.value = '\u0000uncategorised';
		nodes.category.append(uncategorised);
		nodes.category.value = selected === '\u0000uncategorised' ? '\u0000uncategorised' : categories.includes(selected) ? selected : '';
	}

	function render(data) {
		renderStatus(data);
		if (Array.isArray(data.filters?.categories)) renderCategories(data);
		nodes.rows.replaceChildren();
		for (const item of data.rows || []) nodes.rows.append(renderRow(item));
		const count = data.rows?.length || 0;
		const more = data.page?.hasMore ? ' - more available' : '';
		nodes.count.hidden = !['ok', 'stale'].includes(data.state);
		if (!nodes.count.hidden) {
			nodes.count.textContent = state.filter === 'downloading'
				? String(count) + ' downloading' + more
				: String(count) + (count === 1 ? ' torrent' : ' torrents') + ' shown' + more;
		}
		nodes.empty.hidden = count > 0;
		if (count === 0) {
			nodes.empty.textContent = emptyMessage(data);
			if (data.state === 'ok' && state.filter === 'downloading') void loadQueueCounts();
		}
		nodes.previous.disabled = data.page?.previousOffset === null || data.page?.previousOffset === undefined;
		nodes.next.disabled = !data.page?.hasMore;
	}

	function pollDelay(ok) {
		const seconds = Math.min(30, Math.max(15, Number(state.status?.pollSeconds) || 20));
		if (ok) return seconds * 1000;
		return Math.min(60000, seconds * 1000 * 2 ** Math.min(state.failures, 3));
	}

	function schedule(ok) {
		clearTimeout(state.timer);
		state.timer = null;
		if (state.stopped || document.hidden) return;
		state.timer = setTimeout(() => { load(); }, pollDelay(ok));
	}

	function hardStop(message) {
		state.stopped = true;
		clearTimeout(state.timer);
		state.timer = null;
		nodes.status.textContent = message;
		nodes.status.setAttribute('aria-busy', 'false');
		nodes.previous.disabled = true;
		nodes.next.disabled = true;
	}

	function resetPosition() {
		state.offset = 0;
		state.generation = null;
		state.failures = 0;
	}

	async function load() {
		if (state.stopped || document.hidden || state.inFlight) return;
		state.inFlight = true;
		state.abort = new AbortController();
		nodes.status.setAttribute('aria-busy', 'true');
		const query = new URLSearchParams({ filter: state.filter, offset: String(state.offset), limit: String(state.limit) });
		if (state.category !== null) query.set('category', state.category === '\u0000uncategorised' ? '' : state.category);
		try {
			const response = await fetch('/api/qbittorrent/downloads?' + query.toString(), {
				credentials: 'same-origin', headers: { accept: 'application/json' }, signal: state.abort.signal
			});
			if (response.status === 401) { hardStop('Sign in as the installation administrator. Polling has stopped.'); return; }
			if (response.status === 409) {
				const data = await response.json().catch(() => ({}));
				hardStop(data.error || 'The qBittorrent connection changed. Refresh the page.');
				return;
			}
			if (!response.ok) {
				const data = await response.json().catch(() => ({}));
				state.failures += 1;
				nodes.status.textContent = data.error || 'The qBittorrent download list could not be read.';
				nodes.status.setAttribute('aria-busy', 'false');
				nodes.rows.replaceChildren();
				schedule(false);
				return;
			}
			const data = await response.json();
			if (state.generation !== null && data.generation !== state.generation) {
				resetPosition();
				state.generation = data.generation;
				render(data);
				hardStop('The qBittorrent connection changed. Polling has stopped. Refresh to load the new source.');
				return;
			}
			if (state.generation === null) state.generation = data.generation;
			state.failures = data.state === 'ok' || data.state === 'stale' ? 0 : state.failures + 1;
			render(data);
			if (['unconfigured', 'disabled'].includes(data.state)) { hardStop(statusMessage(data)); return; }
			schedule(data.state === 'ok');
		} catch (error) {
			if (error?.name === 'AbortError') return;
			state.failures += 1;
			nodes.status.textContent = 'The qBittorrent download list could not be read. This does not mean the queue is empty.';
			nodes.status.setAttribute('aria-busy', 'false');
			schedule(false);
		} finally {
			state.inFlight = null;
			state.abort = null;
		}
	}

	// #region review-and-delete
	function reviewClose() {
		clearInterval(state.expiryTimer);
		state.expiryTimer = null;
		state.review = null;
		try { nodes.dialog.close(); } catch {}
	}

	function updateExpiry() {
		if (!state.review) return;
		const left = Math.max(0, Math.ceil((state.review.expiresAt - Date.now()) / 1000));
		if (left <= 0) {
			clearInterval(state.expiryTimer);
			state.expiryTimer = null;
			nodes.reviewExpiry.textContent = 'This review expired. Close it and start again.';
			nodes.remove.disabled = true;
			nodes.deleteFiles.disabled = true;
			return;
		}
		nodes.reviewExpiry.textContent = 'This review expires in ' + left + ' seconds. The confirmation can be used once.';
	}

	function renderReview() {
		const review = state.review;
		if (!review) return;
		const item = review.item;
		nodes.reviewSummary.replaceChildren();
		const name = el('h3', item.name);
		const badges = el('div', null, 'qb-badges');
		badges.append(badge(item.stateLabel || item.state, 'qb-state'));
		if (item.category) badges.append(badge(item.category, 'qb-category'));
		const stats = el('div', null, 'qb-stats');
		stats.append(statsRow('Progress', (Number(item.progress || 0) * 100).toFixed(1) + '%'), statsRow('Size', formatBytes(item.size)), statsRow('Short reference', item.displayHash || ''));
		nodes.reviewSummary.append(name, badges, stats);

		nodes.ackRow.hidden = review.action !== 'delete-files';
		nodes.ack.checked = false;
		nodes.remove.hidden = review.action !== 'remove';
		nodes.deleteFiles.hidden = review.action !== 'delete-files';
		nodes.remove.disabled = false;
		nodes.deleteFiles.disabled = true;
		nodes.reviewMessage.textContent = review.action === 'remove'
			? 'This removes the selected torrent from qBittorrent and keeps its downloaded files. It cannot be undone from Tellybox.'
			: 'This removes the selected torrent and asks qBittorrent to delete its downloaded files. File deletion cannot be undone. Files may be shared or hardlinked with library files used elsewhere, so other titles could be affected.';
		nodes.reviewWarning.textContent = review.action === 'delete-files'
			? 'WARNING: downloaded files cannot be undone and may affect shared or hardlinked library files. Tellybox cannot verify what the filesystem removes.'
			: 'Downloaded files are kept. No file is deleted by this action.';
		nodes.reviewWarning.className = 'qb-review-warning' + (review.action === 'delete-files' ? ' qb-warning-destructive' : '');
		updateExpiry();
		clearInterval(state.expiryTimer);
		state.expiryTimer = setInterval(updateExpiry, 1000);
	}

	async function startReview(item, action) {
		state.review = { item, action, token: null, expiresAt: 0, submitting: false };
		nodes.reviewSummary.replaceChildren(el('p', 'Preparing a one-use confirmation...', 'auth-note'));
		nodes.reviewWarning.textContent = '';
		nodes.reviewMessage.textContent = '';
		nodes.reviewExpiry.textContent = '';
		nodes.ackRow.hidden = true;
		nodes.remove.hidden = action !== 'remove';
		nodes.deleteFiles.hidden = action !== 'delete-files';
		nodes.remove.disabled = true;
		nodes.deleteFiles.disabled = true;
		try { nodes.dialog.showModal(); } catch { nodes.dialog.setAttribute('open', ''); }
		try {
			const response = await fetch('/api/qbittorrent/confirm', {
				method: 'POST', credentials: 'same-origin',
				headers: { 'content-type': 'application/json', accept: 'application/json' },
				body: JSON.stringify({ id: item.id, action })
			});
			if (response.status === 401) { reviewClose(); hardStop('Sign in as the installation administrator. Polling has stopped.'); return; }
			const data = await response.json().catch(() => ({}));
			if (!response.ok) {
				nodes.reviewWarning.textContent = data.error || 'This torrent could not be reviewed. Refresh the list.';
				nodes.reviewMessage.textContent = 'No delete request was sent.';
				return;
			}
			state.review = {
				item: data.item || item, action, token: data.token, expiresAt: data.expiresAt,
				submitting: false, generation: data.generation
			};
			renderReview();
		} catch {
			nodes.reviewWarning.textContent = 'The one-use confirmation could not be prepared. No delete request was sent.';
		}
	}

	async function submitReview(action) {
		const review = state.review;
		if (!review || review.submitting || !review.token) return;
		if (action === 'delete-files' && !nodes.ack.checked) return;
		review.submitting = true;
		nodes.remove.disabled = true;
		nodes.deleteFiles.disabled = true;
		nodes.reviewMessage.textContent = 'Sending one confirmed request to qBittorrent...';
		try {
			const response = await fetch('/api/qbittorrent/delete', {
				method: 'POST', credentials: 'same-origin',
				headers: { 'content-type': 'application/json', accept: 'application/json' },
				body: JSON.stringify({ token: review.token })
			});
			if (response.status === 401) { reviewClose(); hardStop('Sign in as the installation administrator. Polling has stopped.'); return; }
			const data = await response.json().catch(() => ({}));
			if (!response.ok) {
				nodes.reviewMessage.textContent = data.error || 'The delete request was not accepted. Check qBittorrent before trying again.';
				nodes.reviewMessage.className = 'auth-note qb-error';
				return;
			}
			if (data.outcome === 'unknown' || data.needsRecheck && data.outcome !== 'removed') {
				nodes.reviewMessage.textContent = data.message || 'The result is unknown. Check qBittorrent before trying again. Tellybox will not repeat this request automatically.';
				nodes.reviewMessage.className = 'auth-note qb-error';
				return;
			}
			nodes.reviewMessage.textContent = data.message || 'qBittorrent accepted the request.';
			nodes.reviewMessage.className = 'auth-note';
			const done = data.outcome === 'removed' || data.outcome === 'submitted';
			if (done) {
				setTimeout(() => { reviewClose(); state.failures = 0; load(); }, 900);
			}
		} catch {
			nodes.reviewMessage.textContent = 'The result is unknown. Check qBittorrent before trying again. Tellybox will not repeat this request automatically.';
			nodes.reviewMessage.className = 'auth-note qb-error';
		}
	}
	// #endregion

	nodes.filter.value = state.filter;
	nodes.filter.onchange = () => { state.filter = nodes.filter.value; resetPosition(); load(); };
	nodes.category.onchange = () => { state.category = nodes.category.value || null; resetPosition(); load(); };
	nodes.refresh.onclick = () => { state.stopped = false; state.failures = 0; resetPosition(); load(); };
	nodes.previous.onclick = () => { const value = state.status?.page?.previousOffset; if (Number.isFinite(value)) { state.offset = value; load(); } };
	nodes.next.onclick = () => { const value = state.status?.page?.nextOffset; if (Number.isFinite(value)) { state.offset = value; load(); } };
	nodes.ack.onchange = () => { if (state.review?.action === 'delete-files') nodes.deleteFiles.disabled = !nodes.ack.checked || !state.review.token; };
	nodes.cancel.onclick = () => reviewClose();
	nodes.remove.onclick = () => submitReview('remove');
	nodes.deleteFiles.onclick = () => submitReview('delete-files');
	nodes.dialog.addEventListener('close', () => { clearInterval(state.expiryTimer); state.expiryTimer = null; state.review = null; });
	document.addEventListener('visibilitychange', () => {
		if (document.hidden) { clearTimeout(state.timer); state.timer = null; try { state.abort?.abort(); } catch {} }
		else if (!state.stopped) load();
	});
	window.addEventListener('pagehide', () => { state.stopped = true; clearTimeout(state.timer); try { state.abort?.abort(); } catch {} });
	load();
})();
