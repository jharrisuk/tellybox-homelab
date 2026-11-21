/* Release 133: owner-only shared-cache status and queued manual refresh.
 *
 * The queue itself lives on the server and is shared with the automatic jobs.
 * This file only displays phase counts and asks for a refresh; it never
 * computes a fake percentage. Errors/log lines come back already redacted.
 */
(() => {
	const box = document.querySelector('#cacheMaintenance');
	if (!box) return;
	const statusNode = document.querySelector('#cacheStatus');
	const scheduleNode = document.querySelector('#cacheSchedule');
	const logNode = document.querySelector('#cacheLog');
	const button = document.querySelector('#refreshCaches');
	const scopes = { discover: 'browse and provider rails', trending: 'default charts', index: 'series index' };
	const states = { queued: 'Queued', running: 'Refreshing', waiting: 'Waiting for playback to finish', idle: 'Up to date' };
	let timer = null;
	let last = null;
	let stopped = false;

	const time = value => {
		const at = Number(value);
		return Number.isFinite(at) && at > 0 ? new Date(at).toLocaleString() : 'not yet';
	};
	const scopeText = list => (Array.isArray(list) ? list : []).map(scope => scopes[scope] || scope).join(', ');
	const countText = result => {
		if (!result) return '';
		const parts = [];
		if (Number.isFinite(result.ran)) parts.push(result.ran + ' refreshed');
		if (Number.isFinite(result.skipped) && result.skipped) parts.push(result.skipped + ' already fresh');
		if (Number.isFinite(result.failed) && result.failed) parts.push(result.failed + ' failed');
		if (Number.isFinite(result.refreshed)) parts.push(result.refreshed + ' series checked');
		if (Number.isFinite(result.cached)) parts.push(result.cached + ' series saved');
		return parts.join(', ');
	};
	const schedule = delay => {
		if (timer) clearTimeout(timer);
		timer = setTimeout(refresh, delay);
	};
	const show = data => {
		last = data;
		if (data.state === 'waiting') {
			statusNode.textContent = 'Waiting for playback or downloads to finish. The refresh will start on its own.';
		} else if (data.state === 'running' || data.state === 'queued') {
			const phase = data.job?.phase ? scopeText([data.job.phase]) : 'starting';
			const count = data.job ? ' (' + data.job.completed + ' of ' + data.job.total + ')' : '';
			statusNode.textContent = (states[data.state] || 'Refreshing') + ' ' + phase + count + '.';
		} else {
			const recent = data.recent?.[data.recent.length - 1];
			if (recent?.state === 'failed') statusNode.textContent = 'The last refresh did not finish. ' + (recent.error || 'No series or charts were replaced.');
			else if (recent?.state === 'cancelled') statusNode.textContent = 'The last refresh was cancelled because the source changed.';
			else if (recent?.state === 'expired') statusNode.textContent = 'The last refresh waited too long for playback to become idle. Try again later.';
			else if (recent?.state === 'done') statusNode.textContent = 'Shared caches are up to date.' + (countText(recent.results) ? ' ' + countText(recent.results) + '.' : '');
			else statusNode.textContent = 'Ready. Fresh snapshots are skipped.';
		}
		const service = data.services || {};
		const details = [];
		if (service.discover) details.push(service.discover.entries + ' Discover snapshots');
		if (service.trending) details.push(service.trending.entries + ' chart rows');
		if (service.index) details.push(Number(service.index.cached || 0) + ' series saved');
		const lastSuccess = data.lastSuccess || {};
		const fresh = Object.entries(lastSuccess).filter(([, at]) => Number(at) > 0).map(([scope, at]) => scopes[scope] + ' ' + time(at));
		const nextExpected = data.nextExpected || {};
		const next = Object.entries(nextExpected).filter(([, at]) => Number(at) > 0).map(([scope, at]) => scopes[scope] + ' ' + time(at));
		scheduleNode.textContent = [details.join(' · '), fresh.length ? 'Last refreshed: ' + fresh.join('; ') + '.' : '',
			next.length ? 'Next expected (estimate): ' + next.join('; ') + '.' : '',
			'Automatic refresh: browse daily, charts and index hourly.'].filter(Boolean).join(' ');
		const entries = (data.recent || []).slice(-3).reverse();
		if (!entries.length) {
			logNode.hidden = true;
			logNode.replaceChildren();
		} else {
			logNode.hidden = false;
			logNode.replaceChildren(...entries.map(entry => {
				const item = document.createElement('li');
				const label = states[entry.state] || entry.state;
				const counts = countText(entry.results);
				item.textContent = time(entry.at) + ' · ' + scopeText(entry.scopes) + ' · ' + label + (counts ? ' · ' + counts : '') + (entry.error ? ' · ' + entry.error : '');
				return item;
			}));
		}
		button.disabled = data.running || data.state === 'waiting' || Number(data.cooldownMs) > 0;
		if (data.running || data.state === 'waiting') schedule(2000);
		else schedule(30000);
	};
	const fail = (message, retry = 30000, disable = false) => {
		statusNode.textContent = message;
		button.disabled = disable;
		schedule(retry);
	};
	const refresh = async () => {
		if (stopped || document.hidden) return;
		try {
			const response = await fetch('/api/admin/cache/status', { credentials: 'same-origin', cache: 'no-store' });
			if (response.status === 401) return fail('Sign in to the installation console to refresh shared caches.', 60000, true);
			if (response.status === 503) return fail('The installation sign-in service is unavailable. Status is not being shown.', 15000, true);
			if (!response.ok) return fail('Shared cache status is unavailable.', 15000);
			show(await response.json());
		} catch {
			fail('Shared cache status is unavailable.', 15000);
		}
	};
	button.onclick = async () => {
		button.disabled = true;
		statusNode.textContent = 'Asking to refresh shared caches...';
		try {
			const response = await fetch('/api/admin/cache/refresh', {
				method: 'POST', credentials: 'same-origin',
				headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scope: 'all' })
			});
			const result = await response.json().catch(() => ({}));
			if (response.status === 401) return fail('Sign in to the installation console to refresh shared caches.', 60000);
			if (response.status === 503) return fail('The installation sign-in service is unavailable. No refresh was started.', 15000);
			if (response.status === 429) {
				const seconds = Math.max(1, Math.ceil(Number(result.retryAfterMs || 0) / 1000));
				return fail('Just refreshed. Try again in ' + seconds + ' seconds.', Math.min(seconds, 60) * 1000);
			}
			if (!response.ok) return fail(result.error || 'The refresh could not be queued.', 15000);
			await refresh();
		} catch {
			fail('The refresh could not be queued.', 15000);
		}
	};
	document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
	refresh();
})();
