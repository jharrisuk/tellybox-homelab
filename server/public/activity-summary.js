/* Shared Activity overview used by the Activity page and the Settings
 * Watching panel. Keeping one renderer means the same snapshot produces the
 * same five metrics, badges and watching list in both places.
 *
 * Identity and connection are deliberately separate: a known account stays an
 * account even when it arrives over the home LAN, and an IP address never
 * guesses a person.
 */
(function (root) {
	'use strict';

	var DEVICE_FALLBACK = { key: 'unknown', label: 'Unknown device', detail: 'No browser or device name was recorded.' };

	function element(tag, text, className) {
		var node = root.document.createElement(tag);
		if (text !== undefined && text !== null) node.textContent = String(text);
		if (className) node.className = className;
		return node;
	}
	function setAttr(node, name, value) {
		if (value === undefined || value === null) return;
		if (typeof node.setAttribute === 'function') node.setAttribute(name, String(value));
		else node[name] = String(value);
	}
	function finiteNumber(value) {
		var number = Number(value);
		return Number.isFinite(number) ? number : 0;
	}
	function formatDuration(seconds) {
		var total = Math.max(0, Math.floor(finiteNumber(seconds)));
		var hours = Math.floor(total / 3600), minutes = Math.floor(total / 60) % 60, rest = total % 60;
		return hours ? hours + ':' + String(minutes).padStart(2, '0') + ':' + String(rest).padStart(2, '0')
			: minutes + ':' + String(rest).padStart(2, '0');
	}
	function formatMinutes(minutes) {
		var total = Math.max(0, Math.floor(finiteNumber(minutes)));
		var hours = Math.floor(total / 60), rest = total % 60;
		if (!hours) return rest + 'm';
		return rest ? hours + 'h ' + rest + 'm' : hours + 'h';
	}
	function relativeTime(at, now) {
		var time = Number(at);
		if (!Number.isFinite(time)) return '';
		var seconds = Math.max(0, Math.round(((Number(now) || Date.now()) - time) / 1000));
		if (seconds < 10) return 'just now';
		if (seconds < 60) return seconds + 's ago';
		if (seconds < 3600) return Math.floor(seconds / 60) + 'm ago';
		if (seconds < 86400) return Math.floor(seconds / 3600) + 'h ago';
		return Math.floor(seconds / 86400) + 'd ago';
	}
	function formatTime(at) {
		var time = Number(at);
		if (!Number.isFinite(time)) return 'Time not recorded';
		return new Date(time).toLocaleString();
	}
	// Newest first by a real timestamp. Missing/invalid timestamps sort last,
	// equal timestamps keep their source order, and the input is never mutated.
	function newestFirst(entries, at) {
		return (Array.isArray(entries) ? entries : []).map(function (entry, index) {
			return { entry: entry, index: index };
		}).sort(function (left, right) {
			var a = Number(at(left.entry)), b = Number(at(right.entry));
			var validA = Number.isFinite(a) && a > 0, validB = Number.isFinite(b) && b > 0;
			if (validA && validB) return b - a || left.index - right.index;
			if (validA !== validB) return validA ? -1 : 1;
			return left.index - right.index;
		}).map(function (item) { return item.entry; });
	}

	function browserAgent(text) {
		return /mozilla|chrome|chromium|safari|firefox|edg\//.test(text);
	}

	function deviceOf(entry) {
		// A read-only summary supplies a coarse label and no raw agent at all.
		var coarse = String((entry && entry.deviceLabel) || '').trim();
		if (coarse) {
			var coarseKeys = {
				'Android TV': 'tv', 'Apple TV': 'tv', 'Fire TV': 'tv', 'Smart TV': 'tv',
				'Android app': 'android', 'Android browser': 'android', 'iPhone': 'iphone', 'iPad': 'iphone',
				'Windows desktop': 'desktop', 'Mac desktop': 'desktop', 'Linux desktop': 'desktop', 'Desktop web': 'desktop'
			};
			if (coarseKeys[coarse]) return { key: coarseKeys[coarse], label: coarse, detail: coarse };
			return DEVICE_FALLBACK;
		}
		var raw = String((entry && (entry.browser || entry.userAgent)) || '').trim();
		var client = String((entry && entry.client) || '').trim().toLowerCase();
		// A validated client enum from the request wins. A friendly device name
		// is never used here, because a name such as "Kitchen TV" may belong to
		// a phone or a tablet.
		if (client === 'android-tv') return { key: 'tv', label: 'Android TV', detail: raw || 'Tellybox Android TV app' };
		if (client === 'android-phone') return { key: 'android', label: 'Android app', detail: raw || 'Tellybox Android app' };
		if (!raw) return DEVICE_FALLBACK;
		var text = raw.toLowerCase();
		// TV user agents often also contain "Android" or "Linux", so classify
		// television surfaces first. BeyondTV is a legacy TV client.
		if (/beyond\s*tv|smart-?tv|smarttv|hbbtv|tizen|web0s|webos|googletv|android ?tv|androidtv|appletv|apple ?tv|fire ?tv|firetv|crkey|bravia|roku|netcast|viera|opera ?tv|philips ?tv/.test(text)) {
			var tvLabel = /appletv|apple ?tv/.test(text) ? 'Apple TV' : /fire ?tv|firetv/.test(text) ? 'Fire TV' : 'TV';
			return { key: 'tv', label: tvLabel, detail: raw };
		}
		if (/iphone|ipod/.test(text)) return { key: 'iphone', label: 'iPhone', detail: raw };
		if (/ipad/.test(text)) return { key: 'iphone', label: 'iPad', detail: raw };
		if (/android/.test(text)) {
			// A web client on Android is a browser, never the app, even when its
			// user agent looks like a native Dalvik client. A missing/unknown
			// client still uses the agent shape.
			var isBrowser = client === 'web' || browserAgent(text);
			return isBrowser
				? { key: 'android', label: 'Android browser', detail: raw }
				: { key: 'android', label: 'Android app', detail: raw };
		}
		if (/windows nt|macintosh|mac os x|x11|cros|linux/.test(text)) return { key: 'desktop', label: 'Desktop web', detail: raw };
		return { key: 'unknown', label: 'Unknown device', detail: raw };
	}

	function identityOf(entry) {
		var value = entry || {};
		// The sanitized read-only view marks anonymous labels explicitly so a
		// fallback such as "Local access" is never shown as an account.
		if (value.viewerKind === 'local') return { kind: 'local', label: 'Local access', text: 'Local access' };
		if (value.viewerKind === 'unknown') return { kind: 'unknown', label: 'Unknown viewer', text: 'Unknown viewer' };
		if (value.personName) return { kind: 'account', label: value.personName, text: 'Account: ' + value.personName };
		if (value.home || value.local) return { kind: 'local', label: 'Local access', text: 'Local access' };
		if (value.email) return { kind: 'account', label: value.email, text: 'Account: ' + value.email };
		if (value.deviceName) return { kind: 'device', label: value.deviceName, text: 'Device: ' + value.deviceName };
		return { kind: 'unknown', label: 'Unknown viewer', text: 'Unknown viewer' };
	}

	function accessOf(entry) {
		var local = Boolean(entry && (entry.local || entry.home));
		return local ? { kind: 'local', label: 'Local', detail: 'Request arrived on the home network.' }
			: { kind: 'remote', label: 'Remote', detail: 'Request arrived from outside the home network.' };
	}

	function routeOf(entry) {
		var route = entry && entry.mediaRoute;
		if (route === 'local') return { kind: 'lan', label: 'LAN direct', detail: 'Video travelled over the home network, not the relay.' };
		if (route === 'relay') return { kind: 'relay', label: 'Internet relay', detail: 'Video travelled through the relay.' };
		if (route === 'remote') return { kind: 'remote', label: 'Internet direct', detail: 'Video came straight from the origin over the internet.' };
		return null;
	}

	function badge(text, className, detail) {
		var node = element('span', text, 'activity-badge ' + className);
		if (detail) node.title = detail;
		setAttr(node, 'aria-label', detail ? text + '. ' + detail : text);
		return node;
	}

	function identityBadge(entry) {
		var info = identityOf(entry);
		// No IP is ever turned into a person; unknown stays unknown.
		return badge(info.text, 'identity-' + info.kind, info.kind === 'account'
			? 'Signed-in account identity'
			: info.kind === 'local' ? 'Local access without an account identity'
				: info.kind === 'device' ? 'Device name only; no account identity' : 'No account or device identity was recorded');
	}

	function accessBadge(entry) {
		var info = accessOf(entry);
		return badge(info.label, 'access-' + info.kind, info.detail);
	}

	function deviceBadge(entry) {
		var info = deviceOf(entry);
		var host = element('span', undefined, 'device-badge');
		var icon = element('span', undefined, 'device-icon is-' + info.key);
		setAttr(icon, 'aria-hidden', 'true');
		host.append(icon, element('span', info.label, 'device-label'));
		var detail = info.detail === info.label ? info.label : info.label + ' - ' + info.detail.slice(0, 180);
		host.title = detail;
		setAttr(host, 'aria-label', 'Device: ' + detail);
		return host;
	}

	const STATUS = { playing: 'Playing', paused: 'Paused', buffering: 'Buffering', ended: 'Ended', requested: 'Starting', downloading: 'Downloading', inactive: 'Inactive' };
	function statusBadge(state) {
		var key = String(state || '').toLowerCase() || 'unknown';
		return badge(STATUS[key] || key.replace(/_/g, ' '), 'status-' + (STATUS[key] ? key : 'unknown'));
	}

	function metricList(snapshot) {
		var stats = (snapshot && snapshot.stats) || {};
		var bandwidth = snapshot && snapshot.bandwidth;
		var list = [
			{ key: 'active', value: finiteNumber(stats.active), label: 'Watching now', detail: 'Playback seen in the last two minutes.' },
			{ key: 'plays', value: finiteNumber(stats.plays), label: 'Play requests - 24h', detail: 'One per playback session, never per relay hop.' },
			{ key: 'remoteIps', value: finiteNumber(stats.remoteIps), label: 'Remote IPs - 24h', detail: 'Connections, not people. A household or mobile network can share one address.' },
			{ key: 'failed', value: finiteNumber(stats.failed), label: 'Failed / limited logins - 24h', detail: 'Failed or rate-limited sign-in attempts.' }
		];
		if (bandwidth) {
			list.push({ key: 'upload', value: finiteNumber(bandwidth.measuredMbps) + ' Mbps', label: 'Remote upload - 10s average',
				detail: (bandwidth.mbps ? finiteNumber(bandwidth.mbps) + ' Mbps cap' : 'Uncapped') + ' - '
					+ finiteNumber(bandwidth.activeTransfers) + ' transferring now. Home/LAN direct playback does not use it.' });
		} else {
			list.push({ key: 'upload', value: '-', label: 'Remote upload', detail: 'Remote upload measurement is unavailable.' });
		}
		return list;
	}

	function renderMetrics(container, snapshot) {
		if (!container) return;
		container.replaceChildren();
		for (var metric of metricList(snapshot)) {
			var card = element('div', undefined, 'activity-stat');
			card.append(element('strong', metric.value, 'activity-stat-value'), element('span', metric.label, 'activity-stat-label'));
			if (metric.detail) card.append(element('span', metric.detail, 'activity-stat-detail'));
			card.title = metric.label + '. ' + (metric.detail || '');
			setAttr(card, 'aria-label', metric.label + ': ' + metric.value + (metric.detail ? '. ' + metric.detail : ''));
			container.append(card);
		}
	}

	function detailBlock(title, lines) {
		var details = element('details', undefined, 'activity-details');
		details.append(element('summary', title));
		var list = element('dl', undefined, 'activity-detail-list');
		for (var line of lines) {
			if (!line || line.value === undefined || line.value === null || line.value === '') continue;
			list.append(element('dt', line.label), element('dd', line.value));
		}
		details.append(list);
		if (!list.children.length) details.append(element('p', 'No further diagnostics were recorded.', 'activity-empty'));
		return details;
	}

	function elapsedLine(entry) {
		var wrap = element('div', undefined, 'activity-elapsed');
		var position = Number(entry.position);
		var duration = Number(entry.duration);
		if (Number.isFinite(position) && position > 0) {
			var percent = Number.isFinite(duration) && duration > 0 ? Math.min(100, Math.round(position / duration * 100)) : null;
			wrap.append(element('span', percent === null ? 'At ' + formatDuration(position)
				: 'Watched ' + formatDuration(position) + ' of ' + formatDuration(duration) + ' (' + percent + '%)', 'activity-elapsed-text'));
			if (percent !== null) {
				var bar = element('span', undefined, 'activity-progress');
				setAttr(bar, 'role', 'progressbar');
				setAttr(bar, 'aria-valuemin', 0);
				setAttr(bar, 'aria-valuemax', 100);
				setAttr(bar, 'aria-valuenow', percent);
				var fill = element('span', undefined, 'activity-progress-fill');
				if (fill.style) fill.style.width = percent + '%';
				bar.append(fill);
				wrap.append(bar);
			}
		}
		if (Number.isFinite(Number(entry.updated))) wrap.append(element('span', 'Updated ' + relativeTime(entry.updated), 'activity-heartbeat'));
		return wrap.children.length ? wrap : null;
	}

	function playbackDiagnostics(entry) {
		var route = routeOf(entry);
		return [
			{ label: 'IP address', value: entry.ip },
			{ label: 'IP source', value: entry.ipSource },
			{ label: 'Media address', value: entry.mediaIp },
			{ label: 'Media route', value: route ? route.label + ' - ' + route.detail : '' },
			{ label: 'Playback method', value: entry.method },
			{ label: 'Conversion reason', value: entry.conversionReason },
			{ label: 'Codecs', value: [entry.videoCodec, entry.audioCodec, entry.resolution].filter(Boolean).join(' - ') },
			{ label: 'Quality', value: entry.qualityMbps ? finiteNumber(entry.qualityMbps) + ' Mbps ceiling; source ' + (entry.sourceMbps || 'unknown') + ' Mbps' : '' },
			{ label: 'Remote transfer', value: entry.remoteMbps !== undefined ? finiteNumber(entry.remoteMbps) + ' Mbps (10-second average)' : '' },
			{ label: 'Local fallback', value: entry.localFallback },
			{ label: 'Last update', value: Number.isFinite(Number(entry.updated)) ? formatTime(entry.updated) + ' (' + relativeTime(entry.updated) + ')' : '' },
			{ label: 'Client', value: entry.client },
			{ label: 'Device name', value: entry.deviceName },
			{ label: 'Browser', value: entry.browser }
		];
	}

	function watchingCard(entry) {
		var card = element('article', undefined, 'activity-entry watching-entry');
		var main = element('div', undefined, 'activity-entry-main');
		var meta = element('div', undefined, 'activity-meta');
		meta.append(identityBadge(entry), accessBadge(entry));
		var route = routeOf(entry);
		if (route) meta.append(badge(route.label, 'route-' + route.kind, route.detail));
		meta.append(deviceBadge(entry), statusBadge(entry.state));
		main.append(element('strong', entry.title || 'Unknown title', 'activity-entry-title'), meta);
		var elapsed = elapsedLine(entry);
		if (elapsed) main.append(elapsed);
		card.append(main, detailBlock('Playback details', playbackDiagnostics(entry)));
		return card;
	}

	function renderWatching(container, snapshot, options) {
		if (!container) return 0;
		var entries = ((snapshot && snapshot.active) || []).filter(function (entry) { return entry && entry.purpose !== 'download'; });
		container.replaceChildren();
		if (!entries.length) {
			container.append(element('p', (options && options.empty) || 'No one is watching right now.', 'activity-empty'));
			return 0;
		}
		for (var entry of entries) container.append(watchingCard(entry));
		return entries.length;
	}

	function dailyText(person) {
		if (!person || person.dailySeconds === null || person.dailySeconds === undefined) return 'No daily account window';
		var used = Math.max(0, Math.floor(finiteNumber(person.dailySeconds)));
		var limit = Number(person.dailyLimitSeconds);
		var text = formatMinutes(Math.floor(used / 60));
		if (Number.isFinite(limit) && limit > 0) text += ' of ' + formatMinutes(Math.floor(limit / 60));
		return text + ' today' + (person.dailyTimezone ? ' (' + person.dailyTimezone + ')' : '');
	}

	function loginText(person) {
		var time = Number(person && person.lastLogin);
		if (!Number.isFinite(time) || time <= 0) return 'No successful sign-in recorded';
		return formatTime(time) + ' (' + relativeTime(time) + ')';
	}

	function renderViewingTotals(container, snapshot, options) {
		if (!container) return;
		var users = ((snapshot && snapshot.viewing && snapshot.viewing.users) || []).slice(0, 100);
		container.replaceChildren();
		if (!users.length) {
			container.append(element('p', 'No viewing time has been recorded yet.', 'activity-empty'));
			return;
		}
		var scroll = element('div', undefined, 'table-scroll');
		var table = element('table', undefined, 'activity-table');
		var head = element('thead'), headRow = element('tr');
		for (var heading of ['Viewer', 'Total watched', 'Today', 'Last successful sign-in']) headRow.append(element('th', heading));
		head.append(headRow);
		var body = element('tbody');
		for (var person of users) {
			var row = element('tr');
			row.append(element('td', person.name || 'Unknown viewer'), element('td', formatMinutes(person.minutes)),
				element('td', dailyText(person)), element('td', loginText(person)));
			body.append(row);
		}
		table.append(head, body);
		scroll.append(table);
		container.append(scroll);
		if (((snapshot.viewing.users || []).length) > 100) container.append(element('p', 'Showing the first 100 viewers.', 'auth-note'));
	}

	function renderBrowsers(container, snapshot, options) {
		if (!container) return;
		var browsers = newestFirst((snapshot && snapshot.browsers) || [], function (entry) { return entry && entry.created; }).slice(0, 100);
		container.replaceChildren();
		if (!browsers.length) {
			container.append(element('p', 'No saved remote browsers.', 'activity-empty'));
			return;
		}
		var scroll = element('div', undefined, 'table-scroll');
		var table = element('table', undefined, 'activity-table');
		var head = element('thead'), headRow = element('tr');
		for (var heading of ['Viewer', 'Device', 'Signed in', 'Last seen', '']) headRow.append(element('th', heading));
		head.append(headRow);
		var body = element('tbody');
		for (const browser of browsers) {
			var local = Boolean(browser.localBrowser);
			var view = Object.assign({}, browser, { local: local, home: local, personName: browser.personName || '' });
			var row = element('tr');
			if (typeof row.setAttribute === 'function') row.setAttribute('data-browser-id', String(browser.id || ''));
			var who = element('td'); who.append(identityBadge(view), document.createTextNode(' '), accessBadge(view));
			var device = element('td'); device.append(deviceBadge(view));
			var action = element('td');
			var button = element('button', 'Sign out', 'button secondary');
			if (button.dataset) button.dataset.browserId = String(browser.id || '');
			button.onclick = (options && options.onSignOut) ? () => options.onSignOut(browser) : () => {};
			action.append(button);
			row.append(who, device, element('td', formatTime(browser.created)),
				element('td', Number.isFinite(Number(browser.lastSeen)) ? formatTime(browser.lastSeen) : 'Not recorded'), action);
			body.append(row);
		}
		table.append(head, body);
		scroll.append(table);
		container.append(scroll);
		if (((snapshot.browsers || []).length) > 100) container.append(element('p', 'Showing the first 100 saved browsers.', 'auth-note'));
	}

	root.TellyboxActivitySummary = {
		element: element,
		deviceOf: deviceOf,
		identityOf: identityOf,
		accessOf: accessOf,
		routeOf: routeOf,
		deviceBadge: deviceBadge,
		identityBadge: identityBadge,
		accessBadge: accessBadge,
		statusBadge: statusBadge,
		metrics: metricList,
		renderMetrics: renderMetrics,
		renderWatching: renderWatching,
		renderViewingTotals: renderViewingTotals,
		renderBrowsers: renderBrowsers,
		formatDuration: formatDuration,
		formatMinutes: formatMinutes,
		relativeTime: relativeTime,
		formatTime: formatTime,
		newestFirst: newestFirst
	};
})(typeof globalThis !== 'undefined' ? globalThis : this);
