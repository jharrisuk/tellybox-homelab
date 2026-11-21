/* Activity page. Server-side paging and filtering keep the DOM and event scan
 * bounded; the shared activity-summary.js renderer keeps the overview identical
 * to the Settings Watching panel. */
const message = document.querySelector('#activityMessage');
const state = { offset: 0, limit: 50, snapshot: null, loading: false, searchTimer: null, readOnly: false };
const labels = {
	login_success: 'Signed in', login_failed: 'Sign-in failed', login_throttled: 'Sign-in rate limited',
	login_limit_reset: 'Sign-in limit reset', logout: 'Signed out', password_changed: 'Password changed',
	sessions_revoked: 'All remote browsers signed out', browser_revoked: 'Remote browser signed out',
	playback: 'Viewing', watch_started: 'Started watching', media_request: 'Media requested',
	share_created: 'Viewing link created', share_revoked: 'Shared link stopped',
	upload_limit_changed: 'Upload limit changed', browser_download: 'Episode download',
	app_download: 'App download', remote_controls_changed: 'Remote controls changed',
	playback_defaults_changed: 'Playback defaults changed', paused_timeout_changed: 'Paused timeout changed'
};
const stateLabels = { playing: 'Playing', paused: 'Paused', buffering: 'Buffering', ended: 'Ended', requested: 'Starting', downloading: 'Downloading', inactive: 'Inactive' };

function element(tag, text, className) {
	const node = document.createElement(tag);
	if (text !== undefined && text !== null) node.textContent = String(text);
	if (className) node.className = className;
	return node;
}
function shared() { return globalThis.TellyboxActivitySummary; }
function position(value) {
	const seconds = Math.floor(Number(value) || 0);
	return `${Math.floor(seconds / 3600)}:${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}
function textInput(selector) {
	const node = document.querySelector(selector);
	return node && typeof node.value === 'string' ? node.value : '';
}
function setIf(node, property, value) { if (node) node[property] = value; }

function setTabState(tab, panel, selected) {
	if (!tab) return;
	if (typeof tab.setAttribute === 'function') {
		tab.setAttribute('aria-selected', String(selected));
		tab.setAttribute('tabindex', selected ? '0' : '-1');
	} else {
		tab['aria-selected'] = String(selected);
		tab.tabIndex = selected ? 0 : -1;
	}
	if (panel) panel.hidden = !selected;
}
const tabTargets = () => [
	{ tab: '#tabActivity', panel: '#activityPanel' },
	{ tab: '#tabLogs', panel: '#logsPanel' },
	{ tab: '#tabStreams', panel: '#streamsPanel' },
	{ tab: '#tabDownloads', panel: '#downloadsPanel' }
].map(target => ({ ...target, node: document.querySelector(target.tab), panelNode: document.querySelector(target.panel) }))
	.filter(target => target.node && target.node.hidden !== true);
function selectedTab(tab) {
	return typeof tab.getAttribute === 'function' ? tab.getAttribute('aria-selected') === 'true' : tab['aria-selected'] === 'true';
}
function requestedTab() {
	const hash = typeof location !== 'undefined' && location ? String(location.hash || '') : '';
	if (hash === '#streams') return '#tabStreams';
	if (hash === '#downloads') return '#tabDownloads';
	if (hash === '#logs') return '#tabLogs';
	// Activity leads. Downloads stays one click away, and a viewer who is
	// refused never lands on it: hideDownloadsPanel removes the tab and
	// returns to Activity.
	return '#tabActivity';
}
function activateTab(tab, focus) {
	const targets = tabTargets();
	const target = targets.find(entry => entry.node === tab);
	if (!target) return;
	const streamsTab = targets.find(entry => entry.tab === '#tabStreams');
	const wasStreams = streamsTab ? selectedTab(streamsTab.node) : false;
	const downloadsTab = targets.find(entry => entry.tab === '#tabDownloads');
	const wasDownloads = downloadsTab ? selectedTab(downloadsTab.node) : false;
	for (const entry of targets) setTabState(entry.node, entry.panelNode, entry.node === tab);
	if (focus && typeof tab.focus === 'function') tab.focus();
	const isStreams = target.tab === '#tabStreams';
	if (isStreams && !wasStreams) startStreamsPanel();
	if (!isStreams && wasStreams) stopStreams();
	const isDownloads = target.tab === '#tabDownloads';
	if (isDownloads && !wasDownloads) startDownloadsPanel();
	if (!isDownloads && wasDownloads) stopDownloads();
}
function bindTabs() {
	const targets = tabTargets();
	if (!targets.length) return;
	const initial = targets.find(entry => entry.tab === requestedTab()) || targets[0];
	// A #streams, #downloads or #logs deep link picks that tab. Without a hash,
	// Downloads is the landing view when it is present; otherwise Activity is
	// the first tab. Switching tabs in-session never rewrites the hash.
	activateTab(initial.node, false);
	const onKey = event => {
		const keys = ['ArrowLeft', 'ArrowRight', 'Home', 'End'];
		if (!keys.includes(event.key)) return;
		if (typeof event.preventDefault === 'function') event.preventDefault();
		const focused = targets.findIndex(entry => entry.node === document.activeElement);
		const active = targets.findIndex(entry => selectedTab(entry.node));
		let index = focused >= 0 ? focused : active >= 0 ? active : 0;
		if (event.key === 'ArrowRight') index = (index + 1) % targets.length;
		else if (event.key === 'ArrowLeft') index = (index - 1 + targets.length) % targets.length;
		else if (event.key === 'Home') index = 0;
		else if (event.key === 'End') index = targets.length - 1;
		activateTab(targets[index].node, true);
	};
	for (const entry of targets) {
		if (typeof entry.node.addEventListener === 'function') entry.node.addEventListener('keydown', onKey);
		entry.node.onclick = () => activateTab(entry.node, false);
	}
	setIf(document.querySelector('#openLogs'), 'onclick', () => activateTab(document.querySelector('#tabLogs'), true));
}

// #region streams-monitor
const STREAM_POLL_MS = 30000;
const STREAM_POLL_MAX_MS = 120000;
const STREAM_STATE_LABELS = Object.freeze({
	ok: 'Connected', stale: 'Connected · stale', disabled: 'Switched off', unconfigured: 'Not configured',
	'auth-failed': 'Dispatcharr sign-in failed', unreachable: 'Unreachable', timeout: 'Timed out',
	invalid: 'Invalid response', 'too-large': 'Response too large'
});
const STREAM_STATE_NOTES = Object.freeze({
	stale: 'The last successful Dispatcharr check is older than expected, so these numbers may be out of date.',
	disabled: 'Dispatcharr is saved but switched off. Enable it in installation settings to see upstream streams.',
	unconfigured: 'Dispatcharr is not configured for this installation. Connection fields are on the setup page.',
	'auth-failed': 'Dispatcharr refused the saved API credentials. Update them in installation settings.',
	unreachable: 'Dispatcharr could not be reached. This is not the same as no connections.',
	timeout: 'Dispatcharr did not answer in time. No counts are shown.',
	invalid: 'Dispatcharr returned a response this page could not read. No counts are shown.',
	'too-large': 'Dispatcharr returned more data than this page will read. No counts are shown.'
});
// Why a profile name is unavailable while the stream counts still work. The
// server reports one bounded reason; this page never receives the accounts body.
const PROFILE_RESOLUTION_NOTES = Object.freeze({
	'too-large': 'Profile names are unavailable: the accounts response was too large.',
	invalid: 'Profile names are unavailable: the accounts response could not be read.',
	'http-error': 'Profile names are unavailable: Dispatcharr did not answer the accounts request.',
	'missing-key': 'Profile names are unavailable: no API key is saved.'
});
const streams = { timer: null, inFlight: null, requestId: 0, failures: 0, last: null, denied: false };

function streamCount(value) {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}
function streamCountText(value) {
	const count = streamCount(value);
	return count === null ? 'Not reported' : count.toLocaleString('en-GB');
}
function streamMetric(value) {
	return typeof value === 'string' && value.trim() ? value.trim() : 'Not reported';
}
// Every row on this page arrives via Dispatcharr, so it is never a source.
// The server already filters it; this keeps an older or unexpected payload
// from rendering the tautology as a value.
function streamSource(value) {
	const text = streamMetric(value);
	return /^dispatcharr$/i.test(text) ? 'Not reported' : text;
}
// The picked-stream line repeats the server's allowlist defensively. Bounded
// text only: a URL, an address or credential-looking text is dropped.
const STREAM_URL_LIKE = /(?:\bwww\.[a-z0-9-]+)|(?:\b[a-z0-9-]+\.(?:com|net|org|io|tv|xyz|info|biz|invalid|example|test)(?:\/|\b))|^(?:https?|rtsp|rtmps?|udp|rtp|ftp|file|mms):/i;
const STREAM_CREDENTIAL_LIKE = /(?:password|passwd|token|secret|api[_-]?key|username)\s*[:=]/i;
function streamSafeText(value, max) {
	if (typeof value !== 'string') return null;
	const text = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
	if (!text || STREAM_URL_LIKE.test(text) || STREAM_CREDENTIAL_LIKE.test(text)) return null;
	return text.slice(0, max);
}
function streamIdLabel(value) {
	const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : '';
	return /^(?:\d{1,12}|[A-Za-z0-9][A-Za-z0-9_-]{0,31})$/.test(text) ? text : null;
}
function streamLabel(stream) {
	const name = streamSafeText(stream?.streamName, 120);
	const id = streamIdLabel(stream?.streamId);
	if (name && id) return `${name} (stream ${id})`;
	return name || (id ? `stream ${id}` : null);
}
function streamSwitchLabel(stream) {
	const raw = stream?.switchAt;
	const at = typeof raw === 'number' ? raw : typeof raw === 'string' ? Date.parse(raw) : NaN;
	if (!Number.isFinite(at)) return null;
	const time = new Date(at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
	const reason = streamSafeText(stream?.switchReason, 60);
	return reason ? `${time}, ${reason}` : time;
}
function reportedConnectionCount(reported) {
	const parts = [reported.liveClients, reported.vodConnections, reported.catchupConnections].map(streamCount);
	return parts.every(value => value !== null) ? parts.reduce((total, value) => total + value, 0) : null;
}
function streamFps(value) {
	const fps = streamCount(value);
	return fps === null ? 'Not reported' : fps.toLocaleString('en-GB', { maximumFractionDigits: 2 });
}
function streamBitrate(value) {
	const kbps = streamCount(value);
	if (kbps === null) return 'Not reported';
	if (kbps < 1000) return kbps.toLocaleString('en-GB') + ' kbps';
	const mbps = Math.round(kbps / 10) / 100;
	return mbps.toLocaleString('en-GB', { maximumFractionDigits: 2 }) + ' Mbps';
}
function streamDuration(value) {
	const seconds = streamCount(value);
	if (seconds === null) return 'Not reported';
	const whole = Math.floor(seconds);
	return `${Math.floor(whole / 3600)}:${String(Math.floor(whole / 60) % 60).padStart(2, '0')}:${String(whole % 60).padStart(2, '0')}`;
}
function streamBytes(value) {
	const bytes = streamCount(value);
	if (bytes === null) return 'Not reported';
	if (bytes < 1024) return bytes.toLocaleString('en-GB') + ' B';
	if (bytes < 1048576) return (bytes / 1024).toLocaleString('en-GB', { maximumFractionDigits: 1 }) + ' KB';
	if (bytes < 1073741824) return (bytes / 1048576).toLocaleString('en-GB', { maximumFractionDigits: 1 }) + ' MB';
	return (bytes / 1073741824).toLocaleString('en-GB', { maximumFractionDigits: 2 }) + ' GB';
}
function streamTime(value) {
	const time = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
	return Number.isFinite(time) ? new Date(time).toLocaleString() : null;
}
function streamState(data) {
	const raw = typeof data?.state === 'string' ? data.state.trim().toLowerCase() : '';
	const known = Object.prototype.hasOwnProperty.call(STREAM_STATE_LABELS, raw);
	if (raw === 'ok' && data?.reachable === false) return 'unreachable';
	if (raw === 'ok' && data?.stale === true) return 'stale';
	if (known) return raw;
	if (raw) return 'invalid';
	return data?.reachable === true ? 'ok' : 'invalid';
}
function streamsTabNode() { return document.querySelector('#tabStreams'); }
function streamsSelected() {
	const tab = streamsTabNode();
	return Boolean(tab) && selectedTab(tab);
}
function streamsPollable() {
	return streamsSelected() && !streams.denied && typeof document.visibilityState === 'string' && document.visibilityState === 'visible';
}
function clearStreamsTimer() {
	if (streams.timer !== null) {
		globalThis.clearTimeout(streams.timer);
		streams.timer = null;
	}
}
function setStreamsLoading(loading) {
	const button = document.querySelector('#streamsRefresh'), status = document.querySelector('#streamsStatus');
	if (button) button.disabled = loading;
	if (status && typeof status.setAttribute === 'function') status.setAttribute('aria-busy', String(loading));
}
function abortStreams() {
	clearStreamsTimer();
	if (streams.inFlight) {
		try { streams.inFlight.abort(); } catch { /* already settled */ }
	}
	streams.inFlight = null;
	streams.requestId += 1;
	setStreamsLoading(false);
}
function stopStreams() { abortStreams(); }
function scheduleStreams() {
	clearStreamsTimer();
	if (!streamsPollable()) return;
	const delay = Math.min(STREAM_POLL_MS * 2 ** Math.min(streams.failures, 2), STREAM_POLL_MAX_MS);
	streams.timer = globalThis.setTimeout(() => { streams.timer = null; void refreshStreams(); }, delay);
}
// An unauthorized caller gets no panel, no locked teaser and no prompt. The
// server's route guard is authoritative; this only removes the tab from view.
function hideStreamsPanel() {
	streams.denied = true;
	streams.last = null;
	clearStreamsTimer();
	if (streams.inFlight) {
		try { streams.inFlight.abort(); } catch { /* already settled */ }
	}
	streams.inFlight = null;
	streams.requestId += 1;
	const tab = streamsTabNode();
	if (tab) tab.hidden = true;
	const panel = document.querySelector('#streamsPanel');
	if (panel) panel.hidden = true;
	const list = document.querySelector('#streamsList');
	if (list) list.replaceChildren();
	const pill = document.querySelector('#streamsStatusPill');
	if (pill) { pill.hidden = true; pill.textContent = ''; }
	const status = document.querySelector('#streamsStatus');
	if (status) { status.replaceChildren(); status.dataset.state = ''; }
	setStreamsLoading(false);
}
function renderStreamsStatus(data, options = {}) {
	const status = document.querySelector('#streamsStatus');
	if (!status) return;
	const state = streamState(data);
	status.dataset.state = state;
	status.replaceChildren();
	const head = element('div', undefined, 'activity-entry-head');
	head.append(element('strong', STREAM_STATE_LABELS[state] || 'Status unavailable', 'activity-entry-title'));
	status.append(head);
	const custom = typeof data?.notice === 'string' ? data.notice.trim() : '';
	if (state === 'ok' || state === 'stale') {
		const rows = Array.isArray(data?.streams) ? data.streams : [];
		const reported = data?.reported && typeof data.reported === 'object' ? data.reported : {};
		const channels = streamCount(reported.liveChannels), connections = reportedConnectionCount(reported);
		const parts = [];
		const checked = streamTime(data?.checkedAt);
		if (checked) parts.push('Checked ' + checked);
		if (!rows.length && (connections === null || connections === 0)) parts.push('No connections reported');
		else {
			parts.push(`${channels === null ? 'Not reported' : streamCountText(channels)} upstream ${channels === 1 ? 'channel' : 'channels'}`);
			parts.push(`${connections === null ? 'Not reported' : streamCountText(connections)} ${connections === 1 ? 'connection' : 'connections'}`);
		}
		if (data?.truncated === true) {
			const shown = streamCount(data.rowsShown), total = streamCount(data.rowsReported);
			if (shown !== null && total !== null) parts.push(`showing first ${streamCountText(shown)} of ${streamCountText(total)}`);
		}
		const upstream = streamTime(data?.upstreamAt);
		if (upstream && upstream !== checked && state === 'ok') parts.push('upstream ' + upstream);
		const profileNote = PROFILE_RESOLUTION_NOTES[data?.profileResolution];
		if (profileNote) parts.push(profileNote);
		if (state === 'stale') parts.push(custom || STREAM_STATE_NOTES.stale);
		status.append(element('p', parts.filter(Boolean).join(' · '), 'auth-note'));
	} else {
		const note = custom || STREAM_STATE_NOTES[state] || '';
		if (note) status.append(element('p', note, 'auth-note'));
	}
	if (options.refreshFailed) status.append(element('p', 'The latest refresh failed. Showing the last successful reported status.', 'auth-note'));
}
const CONNECTION_COLUMNS = [
	{ label: 'Connection', value: (item, index) => 'Connection ' + (index + 1) },
	{ label: 'App', value: item => streamMetric(item.app) },
	{ label: 'Source', value: item => streamSource(item.source ?? item.provider) },
	{ label: 'Profile', value: item => streamMetric(item.profile) },
	{ label: 'Format', value: item => streamMetric(item.format) },
	{ label: 'Connected', value: item => streamTime(item.connectedAt) },
	{ label: 'Duration', value: item => streamDuration(item.durationSeconds) }
];
const knownCell = value => value === null || value === undefined || value === '' || value === 'Not reported' ? null : value;
function connectionTable(connections, cardValues = {}) {
	const items = Array.isArray(connections.items) ? connections.items.filter(item => item && typeof item === 'object') : [];
	if (!items.length) return null;
	const cells = items.map((item, index) => CONNECTION_COLUMNS.map(column => column.value(item, index)));
	// Keep the positional Connection column. A detail column that is unknown for
	// every row is omitted rather than repeating "Not reported"; a partially
	// unknown column uses one dash for the missing cells. A detail column that
	// only repeats the card-level value is dropped too, so a single-viewer
	// connection row does not restate App/Source/Profile/Format.
	const repeatsCard = (column, index) => {
		const key = String(column.label || '').toLowerCase();
		if (!Object.hasOwn(cardValues, key)) return false;
		const card = knownCell(cardValues[key]);
		if (card === null) return false;
		const known = cells.map(row => knownCell(row[index]));
		return known.length > 0 && known.every(value => value !== null && String(value) === String(card));
	};
	const columns = CONNECTION_COLUMNS.filter((column, index) => index === 0
		|| (cells.some(row => knownCell(row[index]) !== null) && !repeatsCard(column, index)));
	const scroll = element('div', undefined, 'table-scroll'), output = element('table', undefined, 'activity-table');
	const head = element('thead'), headRow = element('tr');
	for (const column of columns) headRow.append(element('th', column.label));
	head.append(headRow);
	const body = element('tbody');
	items.forEach((item, rowIndex) => {
		const row = element('tr');
		// A positional label only: the upstream connection id, request ids and
		// addresses are deliberately not shown.
		for (const column of columns) {
			const index = CONNECTION_COLUMNS.indexOf(column);
			row.append(element('td', knownCell(cells[rowIndex][index]) || '—'));
		}
		body.append(row);
	});
	output.append(head, body); scroll.append(output);
	return scroll;
}
function streamCard(stream) {
	const card = element('article', undefined, 'activity-entry stream-entry');
	const main = element('div', undefined, 'activity-entry-main');
	const head = element('div', undefined, 'activity-entry-head');
	const kinds = { Live: 'Live', VOD: 'VOD', Catchup: 'Catchup' };
	const kind = kinds[stream.typeLabel] || 'Stream';
	// One badge carries kind and the only meaningful state. "Live · active" said
	// the same thing twice; a real change (paused, error) is appended instead.
	const state = streamMetric(stream.state);
	const tautology = /^(active|running|playing|ok)$/i.test(state) || state === 'Not reported';
	const label = state && !tautology ? kind + ' · ' + state.charAt(0).toUpperCase() + state.slice(1) : kind;
	head.append(
		element('strong', streamMetric(stream.title) === 'Not reported' ? 'Untitled stream' : stream.title.trim(), 'activity-entry-title'),
		element('span', label, 'activity-badge stream-kind' + (tautology ? '' : ' status-paused'))
	);
	main.append(head);
	const connections = stream.connections && typeof stream.connections === 'object' ? stream.connections : {};
	// Facts that describe where the stream came from collapse to one line. Each
	// remains reported-only; nothing is invented to fill a gap.
	const origin = [streamSource(stream.source ?? stream.provider), streamMetric(stream.profile), streamMetric(stream.app), streamMetric(stream.viewer)]
		.filter(value => value && value !== 'Not reported');
	if (origin.length) main.append(element('p', origin.join(' · '), 'stream-subline'));
	const picked = [streamLabel(stream), streamSwitchLabel(stream)].filter(value => value && value !== 'Not reported');
	if (picked.length) main.append(element('p', picked.join(' · '), 'stream-subline stream-picked'));
	// Media facts become chips, in the order the reference card uses.
	const chips = [
		['Resolution', streamMetric(stream.resolution), ''],
		['Frame rate', streamFps(stream.fps), streamFps(stream.fps) === 'Not reported' ? '' : ' fps'],
		['Video codec', streamMetric(stream.codec), ''],
		['Audio', streamMetric(stream.audio), ''],
		['Format', streamMetric(stream.format), ''],
		['Average bitrate', streamBitrate(stream.averageBitrateKbps), ' avg']
	].filter(([, value]) => value && value !== 'Not reported');
	if (chips.length) {
		const meta = element('div', undefined, 'activity-meta stream-chips');
		for (const [name, value, suffix] of chips) {
			const chip = element('span', value + suffix, 'activity-badge');
			chip.setAttribute('aria-label', name + ': ' + value + suffix);
			meta.append(chip);
		}
		main.append(meta);
	}
	const metrics = [streamBytes(stream.bytes), streamDuration(stream.durationSeconds), streamCountText(connections.reported) === null || streamCount(connections.reported) === null ? '' : streamCountText(connections.reported) + (streamCount(connections.reported) === 1 ? ' connection' : ' connections')]
		.filter(value => value && value !== 'Not reported');
	if (metrics.length) main.append(element('p', metrics.join(' · '), 'stream-metrics'));
	if (typeof stream.note === 'string' && stream.note.trim()) main.append(element('p', stream.note.trim(), 'auth-note'));
	const shown = streamCount(connections.shown), reported = streamCount(connections.reported);
	if (connections.truncated === true) {
		const first = shown === null ? (Array.isArray(connections.items) ? connections.items.length : 0) : shown;
		main.append(element('p', reported === null
			? `Showing first ${streamCountText(first)} reported connections; the total is not reported.`
			: `Showing first ${streamCountText(first)} of ${streamCountText(reported)} reported connections.`, 'auth-note'));
	}
	const table = connectionTable(connections, { app: streamMetric(stream.app), source: streamSource(stream.source ?? stream.provider), profile: streamMetric(stream.profile), format: streamMetric(stream.format) });
	if (table) main.append(table);
	else if (streamCount(connections.reported) > 0) main.append(element('p', 'Connection details were not reported.', 'auth-note'));
	card.append(main);
	return card;
}
function renderStreamsList(data) {
	const host = document.querySelector('#streamsList');
	if (!host) return;
	host.replaceChildren();
	const state = streamState(data);
	if (!['ok', 'stale'].includes(state)) return;
	const rows = Array.isArray(data?.streams) ? data.streams.filter(row => row && typeof row === 'object') : [];
	if (!rows.length) {
		host.append(element('p', 'No connections reported.', 'activity-empty'));
		return;
	}
	for (const row of rows) host.append(streamCard(row));
}
function renderStreams(data, options = {}) {
	renderStreamsStatus(data, options);
	renderStreamsList(data);
	const pill = document.querySelector('#streamsStatusPill');
	if (pill) {
		const count = Array.isArray(data?.streams) ? data.streams.length : 0;
		pill.hidden = count === 0;
		pill.textContent = count === 1 ? '1 upstream stream' : count + ' upstream streams';
	}
}
function renderStreamsFailure(error) {
	if (streams.last) { renderStreams(streams.last, { refreshFailed: true }); return; }
	const status = document.querySelector('#streamsStatus'), list = document.querySelector('#streamsList');
	if (status) {
		status.dataset.state = 'unreachable';
		status.replaceChildren(
			element('strong', 'Status unavailable', 'activity-entry-title'),
			element('p', error && typeof error.message === 'string' && error.message ? error.message : 'Dispatcharr stream status is unavailable.', 'auth-note')
		);
	}
	if (list) list.replaceChildren();
	const pill = document.querySelector('#streamsStatusPill');
	if (pill) { pill.hidden = true; pill.textContent = ''; }
}
async function refreshStreams(options = {}) {
	const manual = options.manual === true;
	if (streams.inFlight || streams.denied || typeof fetch !== 'function' || !streamsPollable()) return;
	clearStreamsTimer();
	const id = ++streams.requestId;
	const controller = typeof AbortController === 'function' ? new AbortController() : null;
	streams.inFlight = controller || true;
	setStreamsLoading(true);
	const status = document.querySelector('#streamsStatus');
	if (status && !streams.last) status.replaceChildren(element('p', 'Loading upstream streams...', 'auth-note'));
	try {
		const response = await fetch('/api/activity/streams' + (manual ? '?refresh=1' : ''), {
			method: 'GET', headers: { Accept: 'application/json' }, cache: 'no-store',
			credentials: 'same-origin', signal: controller ? controller.signal : undefined
		});
		if (id !== streams.requestId) return;
		// The server decides who may see streams. A caller outside local/home/admin
		// gets no tab, no panel and no sign-in prompt.
		if (response.status === 401 || response.status === 403) {
			hideStreamsPanel();
			return;
		}
		if (response.status === 503) {
			let reason = 'The installation monitoring service is unavailable right now.';
			try {
				const body = await response.json();
				if (body && typeof body.error === 'string' && body.error.trim()) reason = body.error.trim();
			} catch { /* keep the default message */ }
			throw new Error(reason);
		}
		if (!response.ok) throw new Error('Dispatcharr stream status is unavailable.');
		const data = await response.json();
		if (id !== streams.requestId) return;
		streams.failures = 0;
		streams.last = data;
		renderStreams(data);
		scheduleStreams();
	} catch (error) {
		if (id !== streams.requestId || error?.name === 'AbortError') return;
		streams.failures += 1; renderStreamsFailure(error); scheduleStreams();
	} finally {
		if (id === streams.requestId) {
			streams.inFlight = null;
			setStreamsLoading(false);
		}
	}
}
function startStreamsPanel() {
	if (streams.denied || !streamsPollable()) return;
	void refreshStreams();
}
function onStreamsVisibility() {
	if (typeof document.visibilityState === 'string' && document.visibilityState !== 'visible') { stopStreams(); return; }
	if (streamsSelected()) startStreamsPanel();
}
function bindStreams() {
	const button = document.querySelector('#streamsRefresh');
	if (button) button.onclick = () => { void refreshStreams({ manual: true }); };
	if (typeof document.addEventListener === 'function') document.addEventListener('visibilitychange', onStreamsVisibility);
	if (typeof globalThis.addEventListener === 'function') globalThis.addEventListener('pagehide', stopStreams);
}
// #endregion streams-monitor

// #region downloads-monitor
const DOWNLOAD_POLL_MS = 20000;
const DOWNLOAD_POLL_MAX_MS = 120000;
const DOWNLOAD_STATE_LABELS = Object.freeze({
	ok: 'Connected', stale: 'Connected - stale', disabled: 'Switched off', unconfigured: 'Not configured',
	'auth-failed': 'qBittorrent sign-in failed', 'auth-throttled': 'Sign-in paused',
	banned: 'Address temporarily banned', unreachable: 'Unreachable', timeout: 'Timed out',
	invalid: 'Invalid response', 'too-large': 'Response too large', backoff: 'Checks paused',
	idle: 'No check yet'
});
const DOWNLOAD_STATE_NOTES = Object.freeze({
	stale: 'The last successful qBittorrent check is older than expected, so these figures may be out of date.',
	disabled: 'qBittorrent monitoring is switched off. No request was made.',
	unconfigured: 'qBittorrent is not configured for this installation.',
	'auth-failed': 'qBittorrent refused the saved WebUI sign-in. Update it in installation settings.',
	'auth-throttled': 'qBittorrent sign-in is paused briefly after repeated failures.',
	banned: 'qBittorrent has temporarily banned this address after failed sign-ins.',
	unreachable: 'qBittorrent could not be reached. This is not the same as an empty download list.',
	timeout: 'qBittorrent did not answer in time.',
	invalid: 'qBittorrent returned a response this page could not read.',
	'too-large': 'qBittorrent returned more data than this page will read.',
	backoff: 'Checks are paused briefly after a failure.'
});
const qbDownloads = { timer: null, inFlight: null, probe: null, requestId: 0, failures: 0, last: null, lastFilter: null, denied: false, filter: 'downloading', probing: false, probed: false };
// The read-only route filters in qBittorrent before it applies the row limit,
// so the panel renders exactly the rows the server returned for the selected
// filter. These buckets only mirror the server's classification for honest
// counts and for older payloads that predate the server counts.
const DOWNLOAD_FILTER_LABELS = Object.freeze({ downloading: 'Downloading', seeding: 'Seeding', all: 'Everything' });
const DOWNLOAD_COUNT_KEYS = Object.freeze(['downloading', 'queued', 'seeding', 'paused', 'checking', 'moving', 'other']);
const DOWNLOAD_ACTIVE_STATES = Object.freeze(['downloading', 'forcedDL', 'stalledDL', 'metaDL', 'forcedMetaDL']);
const DOWNLOAD_SEEDING_STATES = Object.freeze(['uploading', 'forcedUP', 'stalledUP']);
const DOWNLOAD_QUEUED_STATES = Object.freeze(['queuedDL', 'queuedUP']);
const DOWNLOAD_PAUSED_STATES = Object.freeze(['pausedDL', 'pausedUP', 'stoppedDL', 'stoppedUP']);
const DOWNLOAD_CHECKING_STATES = Object.freeze(['checkingDL', 'checkingUP', 'checkingResumeData', 'queuedForChecking']);

function downloadCount(value) {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}
function downloadBytes(value) {
	const bytes = downloadCount(value);
	if (bytes === null) return 'Not reported';
	if (bytes < 1024) return bytes.toLocaleString('en-GB') + ' B';
	if (bytes < 1048576) return (bytes / 1024).toLocaleString('en-GB', { maximumFractionDigits: 1 }) + ' KB';
	if (bytes < 1073741824) return (bytes / 1048576).toLocaleString('en-GB', { maximumFractionDigits: 1 }) + ' MB';
	return (bytes / 1073741824).toLocaleString('en-GB', { maximumFractionDigits: 2 }) + ' GB';
}
function downloadSpeed(value) {
	const bytes = downloadCount(value);
	return bytes === null ? 'Not reported' : downloadBytes(bytes) + '/s';
}
function downloadEta(value) {
	const seconds = downloadCount(value);
	if (seconds === null) return 'Not reported';
	if (seconds < 60) return Math.max(1, Math.floor(seconds)) + ' sec';
	if (seconds < 3600) return Math.floor(seconds / 60) + ' min';
	return Math.floor(seconds / 3600) + ' hr ' + Math.floor(seconds % 3600 / 60) + ' min';
}
function downloadRatio(value) {
	const ratio = typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
	return ratio === null ? 'Not reported' : ratio.toLocaleString('en-GB', { maximumFractionDigits: 2 });
}
function downloadRows(data) {
	return Array.isArray(data?.rows) ? data.rows.filter(row => row && typeof row === 'object') : [];
}
function downloadBucket(row) {
	const stateName = typeof row?.state === 'string' ? row.state : '';
	if (DOWNLOAD_ACTIVE_STATES.includes(stateName)) return 'downloading';
	if (DOWNLOAD_SEEDING_STATES.includes(stateName)) return 'seeding';
	if (DOWNLOAD_QUEUED_STATES.includes(stateName)) return 'queued';
	if (DOWNLOAD_PAUSED_STATES.includes(stateName)) return 'paused';
	if (DOWNLOAD_CHECKING_STATES.includes(stateName)) return 'checking';
	if (stateName === 'moving') return 'moving';
	return 'other';
}
// Server counts are authoritative and are not limited by the 200 rendered
// rows. An older payload without counts falls back to the rendered rows.
function downloadCounts(data) {
	const rows = downloadRows(data);
	const server = data?.counts && typeof data.counts === 'object' ? data.counts : null;
	const lower = new Set(Array.isArray(data?.countsLowerBound) ? data.countsLowerBound : []);
	const counts = { lower };
	for (const key of DOWNLOAD_COUNT_KEYS) {
		const value = Number(server?.[key]);
		counts[key] = Number.isFinite(value) && value >= 0
			? Math.floor(value)
			: rows.filter(row => downloadBucket(row) === key).length;
	}
	counts.attention = Number.isFinite(Number(server?.attention)) && Number(server?.attention) >= 0
		? Math.floor(Number(server.attention)) : 0;
	counts.total = DOWNLOAD_COUNT_KEYS.reduce((sum, key) => sum + counts[key], 0);
	return counts;
}
function downloadCountText(value, lowerBound) {
	return Number(value).toLocaleString('en-GB') + (lowerBound ? '+' : '');
}
function downloadIsLowerBound(counts, key) {
	return counts.lower instanceof Set && counts.lower.has(key);
}
function downloadTotalIsLowerBound(counts) {
	return counts.lower instanceof Set && DOWNLOAD_COUNT_KEYS.some(key => counts.lower.has(key));
}
function downloadTorrentCount(value, lowerBound) {
	return downloadCountText(value, lowerBound) + (value === 1 && !lowerBound ? ' torrent' : ' torrents');
}
function downloadTime(value) {
	const time = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN;
	return Number.isFinite(time) && time > 0 ? new Date(time).toLocaleString() : null;
}
function qbDownloadState(data) {
	const raw = typeof data?.state === 'string' ? data.state.trim().toLowerCase() : '';
	if (raw === 'ok' && data?.reachable === false) return 'unreachable';
	if (raw === 'ok' && data?.stale === true) return 'stale';
	if (Object.prototype.hasOwnProperty.call(DOWNLOAD_STATE_LABELS, raw)) return raw;
	return raw ? 'invalid' : data?.reachable === true ? 'ok' : 'invalid';
}
function downloadsTabNode() { return document.querySelector('#tabDownloads'); }
function downloadsSelected() {
	const tab = downloadsTabNode();
	return Boolean(tab) && selectedTab(tab);
}
function downloadsPollable() {
	return downloadsSelected() && !qbDownloads.denied && typeof document.visibilityState === 'string' && document.visibilityState === 'visible';
}
function clearDownloadsTimer() {
	if (qbDownloads.timer !== null) {
		globalThis.clearTimeout(qbDownloads.timer);
		qbDownloads.timer = null;
	}
}
function setDownloadsLoading(loading) {
	const button = document.querySelector('#downloadsRefresh'), status = document.querySelector('#downloadsStatus');
	if (button) button.disabled = loading;
	if (status && typeof status.setAttribute === 'function') status.setAttribute('aria-busy', String(loading));
}
function abortDownloads() {
	clearDownloadsTimer();
	if (qbDownloads.inFlight) {
		try { qbDownloads.inFlight.abort(); } catch { /* already settled */ }
	}
	qbDownloads.inFlight = null;
	// A visibility probe is not the poll, but a filter change or a refused
	// viewer must not leave it running to cache an answer for the old filter.
	if (qbDownloads.probe) {
		try { qbDownloads.probe.abort(); } catch { /* already settled */ }
	}
	qbDownloads.probe = null;
	qbDownloads.requestId += 1;
	setDownloadsLoading(false);
}
function stopDownloads() { abortDownloads(); }
function scheduleDownloads() {
	clearDownloadsTimer();
	if (!downloadsPollable()) return;
	const delay = Math.min(DOWNLOAD_POLL_MS * 2 ** Math.min(qbDownloads.failures, 2), DOWNLOAD_POLL_MAX_MS);
	qbDownloads.timer = globalThis.setTimeout(() => { qbDownloads.timer = null; void refreshDownloads(); }, delay);
}
// A refusal removes the section completely: no locked teaser and no sign-in
// prompt. The server guard is authoritative; this only mirrors its decision.
function hideDownloadsPanel() {
	qbDownloads.denied = true;
	qbDownloads.last = null;
	clearDownloadsTimer();
	if (qbDownloads.inFlight) {
		try { qbDownloads.inFlight.abort(); } catch { /* already settled */ }
	}
	qbDownloads.inFlight = null;
	qbDownloads.requestId += 1;
	const tab = downloadsTabNode();
	const wasSelected = tab ? selectedTab(tab) : false;
	if (tab) {
		if (typeof tab.setAttribute === 'function') {
			tab.setAttribute('aria-selected', 'false');
			tab.setAttribute('tabindex', '-1');
		}
		tab.hidden = true;
	}
	const panel = document.querySelector('#downloadsPanel');
	if (panel) panel.hidden = true;
	const list = document.querySelector('#downloadsList');
	if (list) list.replaceChildren();
	const pill = document.querySelector('#downloadsStatusPill');
	if (pill) { pill.hidden = true; pill.textContent = ''; }
	const status = document.querySelector('#downloadsStatus');
	if (status) { status.replaceChildren(); status.dataset.state = ''; }
	const link = document.querySelector('#downloadsOwnerLink');
	if (link) link.hidden = true;
	const note = document.querySelector('#downloadsOwnerNote');
	if (note) note.hidden = true;
	setDownloadsLoading(false);
	// A refused viewer lands on Activity with the Downloads tab gone, never on
	// an empty Downloads view or a locked teaser.
	if (wasSelected) {
		const activityTab = document.querySelector('#tabActivity');
		if (activityTab) activateTab(activityTab, false);
	}
}
function showDownloadsOwnerControls() {
	if (state.readOnly) return;
	const link = document.querySelector('#downloadsOwnerLink');
	if (link) link.hidden = false;
	const note = document.querySelector('#downloadsOwnerNote');
	if (note) note.hidden = false;
}
function renderDownloadsStatus(data, options = {}) {
	const status = document.querySelector('#downloadsStatus');
	if (!status) return;
	const stateName = qbDownloadState(data);
	status.dataset.state = stateName;
	status.replaceChildren();
	if (stateName === 'ok' || stateName === 'stale') {
		const counts = downloadCounts(data);
		const parts = [];
		const checked = downloadTime(data?.checkedAt);
		if (checked) parts.push('Checked ' + checked);
		// The pill already owns the active filter's count. Repeating it here was
		// the same number twice in two places.
		if (qbDownloads.filter !== 'downloading') {
			parts.push(downloadCountText(counts.downloading, downloadIsLowerBound(counts, 'downloading')) + ' downloading');
		}
		if (qbDownloads.filter !== 'seeding') {
			parts.push(downloadCountText(counts.seeding, downloadIsLowerBound(counts, 'seeding')) + ' seeding');
		}
		// Under Everything the pill already shows the queue total, so repeating it
		// here would print the same number twice. Bucket filters keep the total.
		if (qbDownloads.filter !== 'all') {
			parts.push(downloadTorrentCount(counts.total, downloadTotalIsLowerBound(counts)) + ' in the queue');
		}
		if (data?.hasMore === true) parts.push('more rows available');
		if (counts.lower.size) parts.push('Counts marked + are lower bounds');
		if (stateName === 'stale') parts.push(DOWNLOAD_STATE_NOTES.stale);
		const line = element('p', undefined, 'auth-note');
		line.append(element('strong', 'Connected'), document.createTextNode(' · ' + parts.filter(Boolean).join(' · ')));
		status.append(line);
	} else {
		const head = element('div', undefined, 'activity-entry-head');
		head.append(element('strong', DOWNLOAD_STATE_LABELS[stateName] || 'Status unavailable', 'activity-entry-title'));
		status.append(head);
		const note = DOWNLOAD_STATE_NOTES[stateName] || '';
		if (note) status.append(element('p', note, 'auth-note'));
	}
	if (options.refreshFailed) status.append(element('p', 'The latest refresh failed. Showing the last successful reading.', 'auth-note'));
}
function downloadCard(item) {
	const card = element('article', undefined, 'activity-entry qb-line');
	const progressValue = Math.min(1, Math.max(0, Number(item?.progress) || 0));
	const percent = Math.round(progressValue * 1000) / 10;
	const title = element('strong', item?.name || 'Unnamed torrent', 'activity-entry-title qb-line-title');
	title.title = item?.name || '';
	const badge = element('span', item?.stateLabel || 'Unknown state', 'activity-badge qb-line-state'
		+ (/stall|error|missing|fail/i.test(item?.stateLabel || '') ? ' status-paused' : ''));
	const bar = element('span', undefined, 'qb-line-bar');
	bar.setAttribute('role', 'progressbar');
	bar.setAttribute('aria-valuemin', '0');
	bar.setAttribute('aria-valuemax', '100');
	bar.setAttribute('aria-valuenow', String(percent));
	bar.setAttribute('aria-label', (item?.name || 'Download') + ' — download progress');
	const fill = element('span', undefined, 'qb-line-bar-fill');
	fill.style.width = percent + '%';
	bar.append(fill);
	const pct = element('span', percent.toFixed(1) + '%', 'qb-line-pct');
	const metrics = element('p', undefined, 'qb-line-metrics');
	const add = value => { if (value && value !== 'Not reported') metrics.append(element('span', value)); };
	const size = downloadBytes(item?.size);
	add(size === '0 B' ? '' : size);
	const down = downloadSpeed(item?.dlspeed);
	if (down !== 'Not reported') add('↓ ' + down);
	const up = downloadSpeed(item?.upspeed);
	if (up !== 'Not reported') add('↑ ' + up);
	const eta = downloadEta(item?.eta);
	if (eta && eta !== 'Not reported') add('ETA ' + eta);
	const ratio = downloadRatio(item?.ratio);
	if (ratio && ratio !== 'Not reported') add('ratio ' + ratio);
	card.append(title, badge, bar, pct, metrics);
	return card;
}
function downloadEmptyMessage(data) {
	const counts = downloadCounts(data);
	const queue = downloadTorrentCount(counts.total, downloadTotalIsLowerBound(counts)) + ' in the queue';
	if (counts.total === 0) return 'No torrents are in this qBittorrent queue.';
	if (qbDownloads.filter === 'downloading') {
		const seeding = counts.seeding > 0
			? ', ' + downloadCountText(counts.seeding, downloadIsLowerBound(counts, 'seeding')) + ' seeding' : '';
		return 'Nothing is downloading right now. ' + queue + seeding + '. Choose Seeding or Everything to see the rest.';
	}
	if (qbDownloads.filter === 'seeding') {
		const downloading = counts.downloading > 0
			? ', ' + downloadCountText(counts.downloading, downloadIsLowerBound(counts, 'downloading')) + ' downloading' : '';
		return 'Nothing is seeding right now. ' + queue + downloading + '.';
	}
	return 'No torrents match this filter.';
}
function renderDownloadsList(data) {
	const host = document.querySelector('#downloadsList');
	if (!host) return;
	host.replaceChildren();
	const stateName = qbDownloadState(data);
	if (!['ok', 'stale'].includes(stateName)) return;
	// The server has already applied the selected qBittorrent filter. Rendering
	// its rows directly keeps a row that is outside any all-sample visible.
	const rows = downloadRows(data);
	if (!rows.length) {
		host.append(element('p', downloadEmptyMessage(data), 'activity-empty'));
		return;
	}
	for (const row of rows) host.append(downloadCard(row));
}
function renderQbDownloads(data, options = {}) {
	renderDownloadsStatus(data, options);
	renderDownloadsList(data);
	const pill = document.querySelector('#downloadsStatusPill');
	if (!pill) return;
	const stateName = qbDownloadState(data);
	if (!['ok', 'stale'].includes(stateName)) {
		pill.hidden = true;
		pill.textContent = '';
		return;
	}
	const counts = downloadCounts(data);
	const key = qbDownloads.filter === 'all' ? null : qbDownloads.filter;
	const value = key === null || key === 'other' ? counts.total : counts[key] || 0;
	const lower = key === null || key === 'other'
		? downloadTotalIsLowerBound(counts) : downloadIsLowerBound(counts, key);
	pill.hidden = value === 0;
	if (value === 0) { pill.textContent = ''; return; }
	pill.textContent = key === null
		? downloadTorrentCount(value, lower)
		: downloadCountText(value, lower) + ' ' + (key === 'seeding' ? 'seeding' : key === 'downloading' ? 'downloading' : key);
}
function renderDownloadsFailure(error) {
	if (qbDownloads.last) { renderQbDownloads(qbDownloads.last, { refreshFailed: true }); return; }
	const status = document.querySelector('#downloadsStatus'), list = document.querySelector('#downloadsList');
	if (status) {
		status.dataset.state = 'unreachable';
		status.replaceChildren(
			element('strong', 'Status unavailable', 'activity-entry-title'),
			element('p', error && typeof error.message === 'string' && error.message ? error.message : 'The qBittorrent download list is unavailable.', 'auth-note')
		);
	}
	if (list) list.replaceChildren();
	const pill = document.querySelector('#downloadsStatusPill');
	if (pill) { pill.hidden = true; pill.textContent = ''; }
}
function downloadsUrl(filter = qbDownloads.filter) {
	return '/api/activity/downloads?filter=' + encodeURIComponent(filter);
}
async function refreshDownloads() {
	if (qbDownloads.inFlight || qbDownloads.denied || typeof fetch !== 'function' || !downloadsPollable()) return;
	clearDownloadsTimer();
	const id = ++qbDownloads.requestId;
	// The response is cached under the filter it was actually requested for.
	const filter = qbDownloads.filter;
	const controller = typeof AbortController === 'function' ? new AbortController() : null;
	qbDownloads.inFlight = controller || true;
	setDownloadsLoading(true);
	const status = document.querySelector('#downloadsStatus');
	if (status && !qbDownloads.last) status.replaceChildren(element('p', 'Loading qBittorrent downloads...', 'auth-note'));
	try {
		const response = await fetch(downloadsUrl(filter), {
			method: 'GET', headers: { Accept: 'application/json' }, cache: 'no-store',
			credentials: 'same-origin', signal: controller ? controller.signal : undefined
		});
		if (id !== qbDownloads.requestId) return;
		// The server decides who may see downloads. Any refusal removes the tab
		// and panel rather than showing a locked or sign-in prompt.
		if (response.status === 401 || response.status === 403) {
			hideDownloadsPanel();
			return;
		}
		if (!response.ok) throw new Error('The qBittorrent download list is unavailable.');
		const data = await response.json();
		if (id !== qbDownloads.requestId) return;
		qbDownloads.failures = 0;
		qbDownloads.last = data;
		qbDownloads.lastFilter = filter;
		renderQbDownloads(data);
		scheduleDownloads();
	} catch (error) {
		if (id !== qbDownloads.requestId || error?.name === 'AbortError') return;
		qbDownloads.failures += 1; renderDownloadsFailure(error); scheduleDownloads();
	} finally {
		if (id === qbDownloads.requestId) {
			qbDownloads.inFlight = null;
			setDownloadsLoading(false);
		}
	}
}
function startDownloadsPanel() {
	if (qbDownloads.denied || !downloadsPollable()) return;
	// A cached reading from the visibility probe renders immediately; the poll
	// only starts now that the tab is actually open. A cached reading for a
	// different filter is never shown under the selected label.
	if (qbDownloads.probing) return;
	if (qbDownloads.last && qbDownloads.lastFilter === qbDownloads.filter) {
		renderQbDownloads(qbDownloads.last);
		scheduleDownloads();
		return;
	}
	void refreshDownloads();
}
// One read-only probe on page load decides whether a viewer may see the tab at
// all. An explicit refusal hides it exactly like the click path; a network
// failure stays silent so the tab remains and the click path can report it.
async function probeDownloadsVisibility() {
	if (qbDownloads.probed || qbDownloads.denied || qbDownloads.last || qbDownloads.inFlight || qbDownloads.probing) return;
	if (downloadsSelected() || typeof fetch !== 'function') return;
	qbDownloads.probed = true;
	qbDownloads.probing = true;
	// Capture the filter this probe actually asks for. A filter change aborts
	// the request, and any late answer is discarded rather than cached under a
	// label it was not fetched for.
	const filter = qbDownloads.filter;
	const id = ++qbDownloads.requestId;
	const controller = typeof AbortController === 'function' ? new AbortController() : null;
	qbDownloads.probe = controller || true;
	try {
		const response = await fetch(downloadsUrl(filter), {
			method: 'GET', headers: { Accept: 'application/json' }, cache: 'no-store', credentials: 'same-origin',
			signal: controller ? controller.signal : undefined
		});
		if (id !== qbDownloads.requestId || qbDownloads.denied) return;
		if (response.status === 401 || response.status === 403) { hideDownloadsPanel(); return; }
		if (!response.ok) {
			// If the viewer already opened Downloads while this probe was in
			// flight, a silent failure would leave an empty panel. Fall through
			// to exactly one refresh instead of probing again.
			if (downloadsSelected()) void refreshDownloads();
			return;
		}
		const data = await response.json();
		if (id !== qbDownloads.requestId || qbDownloads.denied || qbDownloads.filter !== filter) return;
		// Cache for the first click. No poll and no render until the tab opens.
		qbDownloads.last = data;
		qbDownloads.lastFilter = filter;
		if (downloadsSelected()) {
			renderQbDownloads(data);
			scheduleDownloads();
		}
	} catch (error) {
		if (error?.name === 'AbortError') return;
		// Silent on the landing view; if Downloads is already selected, one
		// refresh gives the click path a chance rather than an empty panel.
		if (downloadsSelected()) void refreshDownloads();
	} finally {
		if (qbDownloads.probe === (controller || true)) qbDownloads.probe = null;
		qbDownloads.probing = false;
	}
}
function syncDownloadsFilter() {
	const select = document.querySelector('#downloadsFilter');
	if (select && select.value !== qbDownloads.filter) select.value = qbDownloads.filter;
}
// The server filters in qBittorrent before it limits rows, so changing the
// selector is one new read for the selected filter. It replaces any queued or
// in-flight reading and reuses the existing single poll timer.
function setDownloadsFilter(value) {
	const selected = Object.prototype.hasOwnProperty.call(DOWNLOAD_FILTER_LABELS, value) ? value : 'downloading';
	const changed = selected !== qbDownloads.filter;
	qbDownloads.filter = selected;
	syncDownloadsFilter();
	if (!changed) return;
	abortDownloads();
	qbDownloads.last = null;
	qbDownloads.lastFilter = null;
	if (downloadsSelected()) void refreshDownloads();
}
function onDownloadsVisibility() {
	if (typeof document.visibilityState === 'string' && document.visibilityState !== 'visible') { stopDownloads(); return; }
	if (downloadsSelected()) startDownloadsPanel();
}
function bindDownloads() {
	const button = document.querySelector('#downloadsRefresh');
	if (button) button.onclick = () => { void refreshDownloads(); };
	const filter = document.querySelector('#downloadsFilter');
	if (filter) {
		filter.onchange = () => setDownloadsFilter(filter.value);
		syncDownloadsFilter();
	}
	if (typeof document.addEventListener === 'function') document.addEventListener('visibilitychange', onDownloadsVisibility);
	if (typeof globalThis.addEventListener === 'function') globalThis.addEventListener('pagehide', stopDownloads);
}
// #endregion downloads-monitor

function table(target, headings, rows, emptyText) {
	const host = document.querySelector(target);
	host.replaceChildren();
	if (!rows.length) { host.append(element('p', emptyText || 'No activity to show yet.', 'auth-note')); return; }
	const scroll = element('div', undefined, 'table-scroll');
	const output = element('table', undefined, 'activity-table');
	const header = element('tr');
	for (const heading of headings) header.append(element('th', heading));
	const head = element('thead'); head.append(header); output.append(head);
	const body = element('tbody');
	for (const values of rows) {
		const row = element('tr');
		for (const value of values) {
			const cell = element('td');
			cell.append(value instanceof Node ? value : document.createTextNode(String(value)));
			row.append(cell);
		}
		body.append(row);
	}
	output.append(body); scroll.append(output); host.append(scroll);
}

function eventLabel(type) { return labels[type] || String(type || 'Activity'); }
function recentTitle(entry) {
	if (['playback', 'watch_started', 'browser_download', 'app_download'].includes(entry.type)) return entry.title || 'Unknown title';
	if (entry.type === 'login_success' || entry.type === 'logout' || String(entry.type || '').startsWith('login_')) return eventLabel(entry.type);
	return eventLabel(entry.type);
}
function eventSummary(entry) {
	const lib = shared();
	switch (entry.type) {
		case 'playback':
		case 'watch_started':
			return [stateLabels[entry.state] || entry.state,
				Number.isFinite(Number(entry.position)) && Number(entry.position) > 0 ? 'at ' + lib.formatDuration(entry.position) : '',
				entry.shareId ? 'shared link' : ''].filter(Boolean).join(' - ') || 'Playback event';
		case 'media_request':
			return [entry.seasons?.length ? 'Seasons ' + entry.seasons.join(', ') : '', entry.state].filter(Boolean).join(' - ') || 'Media request';
		case 'login_failed':
		case 'login_throttled':
		case 'login_success':
		case 'login_limit_reset':
			return [entry.email, entry.method ? entry.method + ' sign-in' : '', entry.reason].filter(Boolean).join(' - ') || 'Sign-in event';
		case 'upload_limit_changed':
			return entry.mbps ? entry.mbps + ' Mbps total' : 'Unlimited';
		default:
			return entry.reason || entry.browser || 'Activity';
	}
}

function recentDiagnostics(entry) {
	return [
		{ label: 'Time', value: shared().formatTime(entry.time) },
		{ label: 'IP address', value: entry.ip },
		{ label: 'IP source', value: entry.ipSource },
		{ label: 'Target IP', value: entry.targetIp },
		{ label: 'Media address', value: entry.mediaIp },
		{ label: 'Media route', value: entry.mediaRoute },
		{ label: 'Playback method', value: entry.method },
		{ label: 'State', value: entry.state },
		{ label: 'Position', value: entry.position !== undefined ? position(entry.position) : '' },
		{ label: 'Email', value: entry.email },
		{ label: 'Reason', value: entry.reason },
		{ label: 'Seasons', value: entry.seasons?.length ? entry.seasons.join(', ') : '' },
		{ label: 'Client', value: entry.client },
		{ label: 'Device name', value: entry.deviceName },
		{ label: 'Browser', value: entry.browser },
		{ label: 'Shared link', value: entry.shareId ? 'Yes' : '' }
	];
}

function recentCard(entry) {
	const lib = shared();
	const card = element('article', undefined, 'activity-entry recent-entry');
	const main = element('div', undefined, 'activity-entry-main');
	const head = element('div', undefined, 'activity-entry-head');
	const timeNode = element('time', lib.formatTime(entry.time) + ' (' + lib.relativeTime(entry.time) + ')', 'activity-time');
	if (Number.isFinite(Number(entry.time)) && typeof timeNode.setAttribute === 'function') timeNode.setAttribute('datetime', new Date(Number(entry.time)).toISOString());
	head.append(element('strong', recentTitle(entry), 'activity-entry-title'), timeNode);
	main.append(head, element('p', eventSummary(entry), 'activity-summary-text'));
	const meta = element('div', undefined, 'activity-meta');
	meta.append(element('span', eventLabel(entry.type), 'activity-badge event-' + String(entry.type || 'activity').replace(/[^a-z0-9_]/gi, '-')));
	meta.append(lib.identityBadge(entry), lib.accessBadge(entry));
	const route = lib.routeOf(entry);
	if (route) meta.append(lib.element('span', route.label, 'activity-badge route-' + route.kind));
	meta.append(lib.deviceBadge(entry));
	if (entry.state && ['playback', 'watch_started', 'browser_download', 'app_download'].includes(entry.type)) meta.append(lib.statusBadge(entry.state));
	main.append(meta);
	const details = lib.element('details', undefined, 'activity-details');
	details.append(lib.element('summary', 'Diagnostics'));
	const list = document.createElement('dl'); list.className = 'activity-detail-list';
	for (const line of recentDiagnostics(entry)) {
		if (!line.value) continue;
		list.append(element('dt', line.label), element('dd', line.value));
	}
	details.append(list);
	card.append(main, details);
	return card;
}

function previewCard(entry) {
	const lib = shared();
	const card = element('article', undefined, 'activity-entry preview-entry');
	if (typeof card.setAttribute === 'function') card.setAttribute('data-event-id', String(entry.id || ''));
	const main = element('div', undefined, 'activity-entry-main');
	const head = element('div', undefined, 'activity-entry-head');
	head.append(element('strong', recentTitle(entry), 'activity-entry-title'),
		element('time', lib.formatTime(entry.time) + ' (' + lib.relativeTime(entry.time) + ')', 'activity-time'));
	main.append(head, element('p', eventSummary(entry), 'activity-summary-text'));
	const meta = element('div', undefined, 'activity-meta');
	meta.append(lib.identityBadge(entry), lib.accessBadge(entry));
	const device = lib.deviceBadge(entry);
	if (device) meta.append(device);
	main.append(meta);
	card.append(main);
	return card;
}

function renderRecentPreview(snapshot) {
	const host = document.querySelector('#recentPreview');
	if (!host) return 0;
	const lib = shared();
	const recent = lib && typeof lib.newestFirst === 'function'
		? lib.newestFirst(Array.isArray(snapshot.recent) ? snapshot.recent : [], entry => entry.time).slice(0, 5)
		: (Array.isArray(snapshot.recent) ? snapshot.recent.slice(0, 5) : []);
	host.replaceChildren();
	if (!recent.length) {
		host.append(element('p', 'No activity matches these filters.', 'activity-empty'));
		return 0;
	}
	for (const entry of recent) host.append(previewCard(entry));
	return recent.length;
}

function renderRecent(snapshot) {
	const host = document.querySelector('#history');
	const lib = shared();
	const recent = lib && typeof lib.newestFirst === 'function'
		? lib.newestFirst(Array.isArray(snapshot.recent) ? snapshot.recent : [], entry => entry.time)
		: (Array.isArray(snapshot.recent) ? snapshot.recent : []);
	host.replaceChildren();
	if (!recent.length) {
		host.append(element('p', 'No activity matches these filters.', 'activity-empty'));
		return;
	}
	for (const entry of recent) host.append(recentCard(entry));
}

function renderPaging(snapshot) {
	const page = snapshot.page || {};
	const total = Number(page.total) || 0;
	const offset = Number(page.offset) || 0;
	const shown = Array.isArray(snapshot.recent) ? snapshot.recent.length : 0;
	const status = document.querySelector('#pageStatus');
	if (status) {
		status.hidden = total === 0;
		status.textContent = total ? `Showing ${offset + 1}-${offset + shown} of ${total}` : '';
	}
	setIf(document.querySelector('#historyPrev'), 'disabled', offset <= 0);
	setIf(document.querySelector('#historyNext'), 'disabled', page.hasMore === true ? false : offset + shown >= total);
}

function renderFacets(snapshot) {
	const facets = snapshot.facets || { users: [], devices: [] };
	for (const [selector, placeholder, items, current] of [
		['#userFilter', 'Anyone', facets.users || [], textInput('#userFilter')],
		['#deviceFilter', 'Any device', facets.devices || [], textInput('#deviceFilter')]
	]) {
		const node = document.querySelector(selector);
		if (!node) continue;
		const signature = JSON.stringify(items);
		if (node.dataset && node.dataset.signature === signature) continue;
		node.replaceChildren();
		const anyone = document.createElement('option');
		anyone.value = ''; anyone.textContent = placeholder; node.append(anyone);
		for (const item of items) {
			const option = document.createElement('option');
			option.value = item.id; option.textContent = item.name; node.append(option);
		}
		if (node.dataset) node.dataset.signature = signature;
		node.value = current;
	}
}

function renderDownloads(snapshot) {
	const downloads = (snapshot.downloads || []).filter(Boolean);
	document.querySelector('#downloadingSection').hidden = downloads.length === 0;
	const bytes = value => value >= 1073741824 ? (value / 1073741824).toFixed(2) + ' GB' : (value / 1048576).toFixed(1) + ' MB';
	table('#downloading', ['Person / device', 'Title', 'Connection', 'Progress'], downloads.map(entry => {
		const amount = entry.totalBytes > 0 ? `${Math.min(100, Math.floor(entry.bytes / entry.totalBytes * 100))}% - ${bytes(entry.bytes)} of ${bytes(entry.totalBytes)}` : `${bytes(entry.bytes || 0)} transferred`;
		return [entry.personName || entry.deviceName || (entry.home || entry.local ? 'Local access' : 'Unknown viewer'), entry.title,
			`${entry.mediaIp || entry.ip || 'Address not recorded'} - ${entry.mediaRoute === 'local' ? 'LAN direct' : entry.mediaRoute === 'relay' ? 'Internet relay' : 'Internet'}`,
			amount + (Date.now() - entry.updated > 30000 ? ' - Waiting for data' : '')];
	}), 'No downloads are running.');
}

/* A trusted home/LAN viewer without an installation-administrator session gets
 * the sanitized summary only. Every admin-only control and section is hidden
 * rather than disabled silently, and the page is marked read-only. */
function hideForReadOnly(selector) {
	const node = document.querySelector(selector);
	if (!node) return;
	node.hidden = true;
	if (selector === '#revokeAll' || selector === '#openLogs') {
		node.disabled = true;
		node.onclick = null;
	}
}
// Activity sections wrap their heading, explanatory note and list together. The
// note must disappear with the data, not remain as a leftover paragraph.
function hideReadOnlySection(selector) {
	const node = document.querySelector(selector);
	if (!node) return;
	const section = typeof node.closest === 'function' ? node.closest('section') : null;
	if (section) section.hidden = true;
	else node.hidden = true;
}
function markReadOnly() {
	state.readOnly = true;
	// A trusted home viewer may still read the downloads list, so a Downloads
	// landing is kept. Everything else falls back to Activity.
	if (!downloadsSelected()) {
		const activityTab = document.querySelector('#tabActivity');
		if (activityTab) activateTab(activityTab, false);
	}
	for (const selector of ['#tabLogs', '#logsPanel',
		'#revokeAll', '.settings-actions', '#openLogs', '#downloadingSection', '#downloadingHeading', '#downloading',
		'#downloadsOwnerLink', '#downloadsOwnerNote',
		'#recentPreviewHeading', '#recentPreview', '#browsersHeading', '#browsers',
		'#totalsHeading', '#viewingTotals', '#viewingSince']) hideForReadOnly(selector);
	for (const selector of ['#recentPreviewHeading', '#browsersHeading', '#totalsHeading']) hideReadOnlySection(selector);
	const eyebrow = document.querySelector('.eyebrow');
	if (eyebrow) eyebrow.textContent = 'READ-ONLY STATISTICS';
}
function renderReadOnly(snapshot) {
	markReadOnly();
	state.snapshot = snapshot;
	const lib = shared();
	if (!lib) throw new Error('Activity renderer is unavailable.');
	lib.renderMetrics(document.querySelector('#stats'), snapshot);
	const watching = lib.renderWatching(document.querySelector('#watching'), snapshot, { empty: 'No one is watching right now.' });
	const count = document.querySelector('#watchingCount');
	if (count) { count.hidden = watching === 0; count.textContent = watching + (watching === 1 ? ' stream' : ' streams'); }
	message.textContent = 'Read-only statistics. Updated ' + new Date().toLocaleTimeString()
		+ '. Full logs, saved browsers and configuration need administrator access.';
}
async function readOnlySummary() {
	const response = await fetch('/api/activity/summary', { cache: 'no-store' });
	if (!response.ok) throw new Error('Read-only activity statistics are available only at home or to an installation administrator.');
	return response.json();
}

async function revoke(route, body) {
	try {
		const response = await fetch(route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
		if (!response.ok) throw new Error((await response.json()).error);
		await refresh();
		message.textContent = 'Remote access revoked. Already-buffered video may play briefly.';
	} catch (error) { message.textContent = error.message; }
}

function queryString() {
	const parts = [];
	const add = (name, value) => {
		if (value === undefined || value === null || value === '') return;
		parts.push(encodeURIComponent(name) + '=' + encodeURIComponent(value));
	};
	add('limit', state.limit);
	add('offset', state.offset);
	add('type', textInput('#filter') || 'all');
	add('q', textInput('#ipFilter').trim());
	add('user', textInput('#userFilter'));
	add('device', textInput('#deviceFilter'));
	add('date', textInput('#dateFilter'));
	return parts.join('&');
}

async function refresh() {
	if (state.loading) return;
	state.loading = true;
	try {
		if (state.readOnly) {
			renderReadOnly(await readOnlySummary());
			return;
		}
		const query = queryString();
		const response = await fetch('/api/activity' + (query ? '?' + query : ''), { cache: 'no-store' });
		if (response.status === 403) {
			// Trusted home/LAN viewers get aggregate statistics only; the full
			// log, account and browser details remain administrator-only.
			renderReadOnly(await readOnlySummary());
			return;
		}
		if (!response.ok) throw new Error('Activity is available only from the local Tellybox address.');
		const snapshot = await response.json();
		state.snapshot = snapshot;
		const lib = shared();
		lib.renderMetrics(document.querySelector('#stats'), snapshot);
		const watching = lib.renderWatching(document.querySelector('#watching'), snapshot, { empty: 'No one is watching right now.' });
		const count = document.querySelector('#watchingCount');
		if (count) { count.hidden = watching === 0; count.textContent = watching + (watching === 1 ? ' stream' : ' streams'); }
		renderDownloads(snapshot);
		showDownloadsOwnerControls();
		renderRecentPreview(snapshot);
		lib.renderViewingTotals(document.querySelector('#viewingTotals'), snapshot);
		const since = document.querySelector('#viewingSince');
		if (since) {
			const parts = [];
			if (snapshot.viewing) parts.push('Recorded since ' + lib.formatTime(snapshot.viewing.since) + '. Simultaneous streams count separately.');
			if (Number.isFinite(Number(snapshot.historySince))) parts.push('Sign-in history begins ' + lib.formatTime(snapshot.historySince) + '; earlier successful sign-ins are unknown, not guessed.');
			since.textContent = parts.join(' ');
		}
		lib.renderBrowsers(document.querySelector('#browsers'), snapshot, { onSignOut: entry => revoke('/api/auth/revoke-browser', { id: entry.id }) });
		renderFacets(snapshot);
		renderRecent(snapshot);
		renderPaging(snapshot);
		message.textContent = 'Updated ' + new Date().toLocaleTimeString();
	} catch (error) { message.textContent = error.message; }
	finally { state.loading = false; }
}

function resetAndRefresh() { state.offset = 0; void refresh(); }
function bind() {
	bindStreams();
	bindDownloads();
	bindTabs();
	for (const selector of ['#filter', '#userFilter', '#deviceFilter', '#dateFilter']) {
		const node = document.querySelector(selector);
		if (node) node.onchange = resetAndRefresh;
	}
	const search = document.querySelector('#ipFilter');
	if (search) search.oninput = () => {
		if (state.searchTimer !== null) globalThis.clearTimeout(state.searchTimer);
		state.searchTimer = globalThis.setTimeout(resetAndRefresh, 300);
	};
	const clear = document.querySelector('#clearFilters');
	if (clear) clear.onclick = () => {
		for (const selector of ['#filter', '#userFilter', '#deviceFilter', '#dateFilter', '#ipFilter']) {
			const node = document.querySelector(selector);
			if (node) node.value = selector === '#filter' ? 'all' : '';
		}
		resetAndRefresh();
	};
	setIf(document.querySelector('#historyPrev'), 'onclick', () => {
		state.offset = Math.max(0, state.offset - state.limit);
		void refresh();
	});
	setIf(document.querySelector('#historyNext'), 'onclick', () => {
		state.offset += state.limit;
		void refresh();
	});
	setIf(document.querySelector('#revokeAll'), 'onclick', () => revoke('/api/auth/revoke', {}));
}
bind();
void refresh().then(() => {
	// The owner already received the full activity snapshot; only a viewer who
	// did not needs one lightweight probe to decide whether Downloads exists.
	if (state.readOnly || !state.snapshot) void probeDownloadsVisibility();
});
setInterval(() => { if (!document.hidden) void refresh(); }, 15000);
