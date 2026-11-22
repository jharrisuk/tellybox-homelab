import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

/* Release 132 coverage for the read-only Activity -> Streams tab and the
 * removal of the duplicate Dispatcharr monitor from installation settings.
 * These are static/DOM-level checks only: no browser, network or backend. */

const activityHtml = readFileSync(new URL('../public/activity.html', import.meta.url), 'utf8');
const activityJs = readFileSync(new URL('../public/activity.js', import.meta.url), 'utf8');
const settingsHtml = readFileSync(new URL('../homelab/public/index.html', import.meta.url), 'utf8');
const setupJs = readFileSync(new URL('../homelab/public/setup.js', import.meta.url), 'utf8');

function slice(source, startText, endText) {
	const start = source.indexOf(startText), end = source.indexOf(endText);
	assert.ok(start >= 0 && end > start, `expected ${startText} before ${endText}`);
	return source.slice(start, end);
}
const streamsJs = slice(activityJs, '// #region streams-monitor', '// #endregion streams-monitor');
const streamsPanel = slice(activityHtml, '<section id="streamsPanel"', '<section id="downloadsPanel"');
const hideStreams = slice(streamsJs, 'function hideStreamsPanel()', 'function renderStreamsStatus(');

test('Activity gains a third Streams tab and panel after Activity and Logs', () => {
	assert.match(activityHtml, /role="tablist"/);
	assert.match(activityHtml, /id="tabActivity"[^>]*role="tab"[^>]*aria-selected="true"[^>]*aria-controls="activityPanel"[^>]*tabindex="0"/);
	assert.match(activityHtml, /id="tabLogs"[^>]*role="tab"[^>]*aria-selected="false"[^>]*aria-controls="logsPanel"[^>]*tabindex="-1"/);
	assert.match(activityHtml, /id="tabStreams"[^>]*role="tab"[^>]*aria-selected="false"[^>]*aria-controls="streamsPanel"[^>]*tabindex="-1"[^>]*>Streams<\/button>/);
	assert.match(activityHtml, /id="streamsPanel"[^>]*role="tabpanel"[^>]*aria-labelledby="tabStreams"[^>]*tabindex="0"[^>]*hidden/);
	const activityTab = activityHtml.indexOf('id="tabActivity"'), logsTab = activityHtml.indexOf('id="tabLogs"');
	const streamsTab = activityHtml.indexOf('id="tabStreams"'), logsPanel = activityHtml.indexOf('id="logsPanel"');
	const panel = activityHtml.indexOf('id="streamsPanel"');
	assert.ok(activityTab < logsTab && logsTab < streamsTab, 'Streams is the third tab');
	assert.ok(logsPanel < panel, 'the Streams panel follows the Logs panel');
	assert.match(streamsPanel, /<h2 id="streamsHeading">Dispatcharr streams<\/h2>/);
	assert.match(streamsPanel, /not Tellybox viewers or unique people/);
	assert.match(streamsPanel, /may be incomplete/);
	assert.match(streamsPanel, /id="streamsStatus"[^>]*role="status"[^>]*aria-live="polite"/);
	assert.match(streamsPanel, /<button[^>]*id="streamsRefresh"[^>]*>Refresh streams<\/button>/);
	assert.equal((streamsPanel.match(/<button\b/g) || []).length, 1, 'no stop, source-change or playback controls');
	assert.doesNotMatch(streamsPanel, /Watching now|watchingCount|viewingTotals|activity-stats/, 'Streams never merges with the Tellybox viewer sections');
});

test('streams endpoint, refresh flag, visibility/tab gating and abort lifecycle are wired', () => {
	assert.match(streamsJs, /\/api\/activity\/streams/);
	assert.doesNotMatch(streamsJs, /\/api\/admin\/dispatcharr\/streams/, 'the read-only view never asks for the owner route');
	assert.match(streamsJs, /\?refresh=1/);
	assert.match(streamsJs, /cache: 'no-store'/);
	assert.match(streamsJs, /credentials: 'same-origin'/);
	assert.match(streamsJs, /document\.visibilityState === 'visible'/);
	assert.match(streamsJs, /streamsSelected\(\)/);
	assert.match(streamsJs, /function streamsPollable\(\)/);
	assert.match(streamsJs, /new AbortController\(\)/);
	assert.match(streamsJs, /signal: controller \? controller\.signal : undefined/);
	assert.match(streamsJs, /streams\.inFlight\.abort\(\)/);
	assert.match(streamsJs, /addEventListener\('visibilitychange'/);
	assert.match(streamsJs, /addEventListener\('pagehide'/);
	assert.match(streamsJs, /STREAM_POLL_MS = 30000/);
	assert.match(streamsJs, /STREAM_POLL_MAX_MS = 120000/);
	assert.match(streamsJs, /Math\.min\(streams\.failures, 2\)/, 'backoff is capped at 30/60/120 seconds');
	assert.match(streamsJs, /streams\.failures = 0;[\s\S]*?renderStreams\(data\)/, 'success resets backoff');
	assert.match(streamsJs, /if \(streams\.inFlight \|\| streams\.denied/, 'overlapping requests are refused');
	assert.match(streamsJs, /setStreamsLoading\(true\)/, 'manual refresh joins the loading state');
	assert.doesNotMatch(streamsJs, /method: 'POST'|method: "POST"/, 'the monitor is read-only');
	assert.doesNotMatch(streamsJs, /setInterval/, 'streams polling uses the backoff timer, not the activity interval');
});

test('an unauthorized caller gets no panel, no locked teaser and no sign-in prompt', () => {
	assert.match(streamsJs, /response\.status === 401 \|\| response\.status === 403/);
	assert.match(streamsJs, /hideStreamsPanel\(\)/);
	assert.match(streamsJs, /streams\.denied = true/);
	assert.match(hideStreams, /streams\.last = null/, 'cached data is dropped');
	assert.match(hideStreams, /replaceChildren\(\)/, 'the connection list and summary are cleared');
	assert.match(hideStreams, /tab\.hidden = true/, 'the tab is removed');
	assert.match(hideStreams, /panel\.hidden = true/, 'the panel is removed');
	assert.doesNotMatch(streamsJs, /Sign in as installation administrator|Retry after sign-in/, 'no administrator prompt is rendered');
	assert.match(streamsJs, /streams\.denied &&|streams\.denied \|\|/, 'polling is gated on an allowed caller');
});

test('state wording stays distinct and uses reported, non-instantaneous values', () => {
	for (const state of ['ok', 'stale', 'disabled', 'unconfigured', 'auth-failed', 'unreachable', 'timeout', 'invalid', 'too-large']) {
		assert.match(streamsJs, new RegExp(`['"]?${state}['"]?:`), `state ${state} has a label or note`);
	}
	assert.match(streamsJs, /'Checked ' \+ checked/);
	assert.match(streamsJs, /parts\.push\('upstream ' \+ upstream\)/);
	assert.match(streamsJs, /upstream \$\{channels === 1 \? 'channel' : 'channels'\}/);
	assert.match(streamsJs, /'No connections reported'/);
	assert.doesNotMatch(streamsJs, /all clear|all-clear|\bhealthy\b/i);
	assert.match(streamsJs, /\['Average bitrate', streamBitrate\(stream\.averageBitrateKbps\), ' avg'\]/);
	assert.doesNotMatch(streamsJs, /Instantaneous|Current bitrate/i);
	assert.match(streamsJs, /Not reported/);
	assert.match(streamsJs, /Showing first \$\{streamCountText\(first\)\} of \$\{streamCountText\(reported\)\} reported connections\./);
	assert.match(streamsJs, /PROFILE_RESOLUTION_NOTES\[data\?\.profileResolution\]/, 'a bounded profile-resolution failure is surfaced');
	assert.match(streamsJs, /Profile names are unavailable: the accounts response was too large\./);
});

test('cards render only approved fields with textContent and no identifiers or addresses', () => {
	for (const field of ['streamSource(stream.source ?? stream.provider)', 'streamMetric(stream.profile)', 'streamMetric(stream.app)',
		'streamMetric(stream.viewer)', 'streamMetric(stream.format)', 'streamMetric(stream.codec)',
		'streamMetric(stream.resolution)', 'streamFps(stream.fps)', 'streamMetric(stream.audio)',
		'streamBitrate(stream.averageBitrateKbps)', 'streamDuration(stream.durationSeconds)',
		'streamBytes(stream.bytes)', 'connections.reported']) {
		assert.ok(streamsJs.includes(field), `card renders ${field}`);
	}
	assert.equal(streamsJs.includes(`['Provider',`), false, 'the tautological Provider row is gone');
	for (const heading of ['Connection', 'App', 'Source', 'Profile', 'Format', 'Connected', 'Duration'])
		assert.ok(streamsJs.includes(`label: '${heading}'`), `connection column includes ${heading}`);
	assert.match(streamsJs, /'Connection ' \+ \(index \+ 1\)/, 'rows use a positional connection label');
	assert.match(streamsJs, /knownCell\(cells\[rowIndex\]\[index\]\) \|\| '—'/, 'missing cells use one dash');
	assert.match(streamsJs, /cells\.some\(row => knownCell\(row\[index\]\) !== null\)/, 'an all-unknown column is omitted');
	assert.doesNotMatch(streamsJs, /item\.id|\.userId\b|\.user_id\b|\bclientIp\b|\bremoteIp\b|\bipAddress\b|\bconnectionId\b/i);
	assert.doesNotMatch(streamsJs, /\bIP\b/);
	assert.doesNotMatch(streamsJs, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
	assert.doesNotMatch(streamsJs, /Stop stream|Restart stream|Change source|Switch source|Start stream|Play stream/i);
	assert.match(streamsJs, /stream\.note/, 'a server-provided note is surfaced');
	assert.match(streamsJs, /streamsList[\s\S]*?replaceChildren/, 'the list is rebuilt through DOM nodes only');
});

test('installation Settings drops the duplicate status panel and the stale monitor link', () => {
	assert.doesNotMatch(settingsHtml, /dispatcharrStatusPanel|dispatcharrStatusRefresh|id="dispatcharrStatus"/);
	assert.doesNotMatch(settingsHtml, /Dispatcharr status/);
	assert.doesNotMatch(settingsHtml, /href="\/activity#streams"/);
	assert.doesNotMatch(settingsHtml, /Open Activity .* Streams/);
	assert.doesNotMatch(setupJs, /createDispatcharrStatusController|dispatcharrStatus|dispatcharr-status-controller/);
	assert.doesNotMatch(setupJs, /\/api\/setup\/dispatcharr\/status/);
	assert.doesNotMatch(setupJs, /dispatcharrStatus\.start|dispatcharrStatus\.cancel/);
	assert.match(setupJs, /function applyDispatcharrLocation\(/, 'connection location fields remain');
	assert.match(setupJs, /function dispatcharrLocation\(/);
	assert.match(setupJs, /'Test saved connection'/);
	assert.match(setupJs, /data-location/);
	assert.match(setupJs, /service\.location=location/);
	assert.match(setupJs, /service\.relayMetadataUrl=metadata/);
});

test('three-tab roving tabindex, arrow keys, Home/End and deep links are preserved', () => {
	assert.match(activityJs, /\{ tab: '#tabActivity', panel: '#activityPanel' \}/);
	assert.match(activityJs, /\{ tab: '#tabLogs', panel: '#logsPanel' \}/);
	assert.match(activityJs, /\{ tab: '#tabStreams', panel: '#streamsPanel' \}/);
	assert.match(activityJs, /const keys = \['ArrowLeft', 'ArrowRight', 'Home', 'End'\]/);
	assert.match(activityJs, /\(index \+ 1\) % targets\.length/);
	assert.match(activityJs, /\(index - 1 \+ targets\.length\) % targets\.length/);
	assert.match(activityJs, /targets\.length - 1/);
	assert.match(activityJs, /tab\.setAttribute\('tabindex', selected \? '0' : '-1'\)/);
	assert.match(activityJs, /hash === '#streams'/);
	assert.match(activityJs, /hash === '#logs'/);
	assert.match(activityJs, /return '#tabDownloads'/, 'Downloads is the landing tab when it is available');
	assert.match(activityJs, /targets\.find\(entry => entry\.tab === requestedTab\(\)\) \|\| targets\[0\]/, 'a missing Downloads tab falls back to the first tab');
	assert.match(activityJs, /activateTab\(initial\.node, false\)/);
	assert.doesNotMatch(activityJs, /location\.hash\s*=/, 'in-session tab switches do not rewrite the hash');
	// Existing Activity and Logs behaviour must still be present.
	assert.match(activityJs, /\/api\/activity/);
	assert.match(activityJs, /state\.limit/);
	assert.match(activityJs, /renderPaging\(snapshot\)/);
	assert.match(activityHtml, /id="filter"/);
	assert.match(activityHtml, /id="history"/);
});

/* Minimal DOM used by the behaviour test below. */
class Element {
	constructor(tag = 'div', document = null) {
		this.tag = tag;
		this.document = document;
		this.children = [];
		this.textContent = '';
		this.className = '';
		this.hidden = false;
		this.dataset = {};
		this.style = {};
		this.value = '';
		this.disabled = false;
		this.listeners = {};
		this.tabIndex = 0;
	}
	append(...items) { this.children.push(...items); }
	replaceChildren(...items) { this.children = items; }
	setAttribute(name, value) { this[name] = String(value); }
	getAttribute(name) { return this[name] === undefined ? null : String(this[name]); }
	addEventListener(name, handler) { (this.listeners[name] ||= []).push(handler); }
	focus() { if (this.document) this.document.activeElement = this; }
}
function fakeDocument() {
	const nodes = {};
	const document = {
		hidden: false, visibilityState: 'visible', activeElement: null, nodes,
		listeners: {},
		createElement(tag) { return new Element(tag, document); },
		createTextNode(text) { return Object.assign(new Element('text', document), { textContent: text }); },
		querySelector(key) { return nodes[key] ||= new Element('div', document); },
		addEventListener(name, handler) { this.listeners[name] = handler; }
	};
	return document;
}
function walk(root, output = []) {
	output.push(root);
	for (const child of root.children || []) walk(child, output);
	return output;
}
function textOf(root) { return walk(root).map(node => node.textContent).filter(Boolean).join(' | '); }
async function settle() {
	await new Promise(resolve => setImmediate(resolve));
	await new Promise(resolve => setImmediate(resolve));
}
function activitySnapshot() {
	const now = Date.now();
	return {
		active: [], downloads: [],
		recent: [{ id: 'e1', type: 'playback', time: now, title: 'Recent', state: 'ended', position: 60, local: false, browser: 'Browser' }],
		browsers: [], stats: { active: 0, plays: 0, remoteIps: 0, failed: 0 }, bandwidth: null,
		viewing: { since: now, users: [] }, page: { limit: 7, offset: 0, total: 1, hasMore: false, retentionDays: 30 },
		facets: { users: [], devices: [] }, historySince: now, lastLogins: {}
	};
}
function streamsSnapshot() {
	return {
		configured: true, enabled: true, source: 'onThisServer', state: 'ok', reachable: true,
		checkedAt: '2026-11-18T12:00:00.000Z', upstreamAt: '2026-11-18T11:59:30.000Z', stale: false,
		notice: '', reported: { liveChannels: 2, liveClients: 1, vodConnections: 0, catchupConnections: 0 },
		truncated: false, rowsReported: 1, rowsShown: 1,
		streams: [{
			kind: 'live', key: 'upstream-key', title: 'Test channel', typeLabel: 'Live', state: 'running',
			source: 'custom', profile: 'custom Default', app: 'Android TV', format: 'HLS', codec: 'H.264', resolution: '1920x1080',
			fps: 25, audio: 'AAC', averageBitrateKbps: 4500, bytes: null, durationSeconds: 90,
			connections: { reported: 1, shown: 1, truncated: false, items: [{
				id: 'secret-connection-id', app: 'App', format: 'HLS', connectedAt: '2026-11-18T11:58:00.000Z', durationSeconds: 60
			}] },
			note: 'Reported by upstream.'
		}]
	};
}

test('DOM behaviour: End/Home and arrow keys move across all four tabs and the Streams fetch is gated', async () => {
	const document = fakeDocument();
	const calls = [];
	document.querySelector('#filter').value = 'all';
	const context = {
		document, Node: Element, location: { hash: '' }, AbortController,
		fetch: async (url, options) => {
			calls.push({ url: String(url), options });
			return { ok: true, status: 200, json: async () => String(url).startsWith('/api/activity/streams') ? streamsSnapshot() : activitySnapshot() };
		},
		setInterval() {}, setTimeout() { return 1; }, clearTimeout() {}
	};
	vm.runInNewContext(readFileSync(new URL('../public/activity-summary.js', import.meta.url), 'utf8'), context);
	vm.runInNewContext(activityJs, context);
	await settle();

	const activityTab = document.querySelector('#tabActivity');
	const logsTab = document.querySelector('#tabLogs');
	const streamsTab = document.querySelector('#tabStreams');
	const downloadsTab = document.querySelector('#tabDownloads');
	const activityPanel = document.querySelector('#activityPanel');
	const logsPanel = document.querySelector('#logsPanel');
	const streamsPanelNode = document.querySelector('#streamsPanel');
	const downloadsPanelNode = document.querySelector('#downloadsPanel');
	assert.equal(activityTab.getAttribute('aria-selected'), 'true', 'Activity is the landing tab');
	assert.equal(activityPanel.hidden, false);
	assert.equal(downloadsTab.getAttribute('aria-selected'), 'false');
	assert.equal(downloadsPanelNode.hidden, true);
	assert.equal(streamsPanelNode.hidden, true);
	await settle();
	assert.equal(calls.filter(call => String(call.url).startsWith('/api/activity/downloads')).length, 0, 'the landing view does not read downloads');
	assert.equal(calls.some(call => call.url.includes('/api/activity/streams')), false, 'no upstream request while Activity is selected');

	// Activity is still one click away. Returning to Downloads starts one fresh
	// read through the same timer.
	activityTab.onclick();
	assert.equal(activityTab.getAttribute('aria-selected'), 'true');
	assert.equal(activityPanel.hidden, false);
	assert.equal(downloadsPanelNode.hidden, true);

	activityTab.focus();
	activityTab.listeners.keydown[0]({ key: 'End', preventDefault() {} });
	assert.equal(downloadsTab.getAttribute('aria-selected'), 'true');
	assert.equal(downloadsTab.getAttribute('tabindex'), '0');
	assert.equal(activityTab.getAttribute('tabindex'), '-1');
	assert.equal(downloadsPanelNode.hidden, false);
	assert.equal(activityPanel.hidden, true);
	assert.equal(document.activeElement, downloadsTab, 'End focuses the last tab');
	// Downloads starts one read-only request when selected, then stops when the
	// viewer moves to another tab.
	await settle();
	assert.equal(calls.filter(call => String(call.url).startsWith('/api/activity/downloads')).length, 1, 'selecting Downloads reads the sanitized list once');
	downloadsTab.listeners.keydown[0]({ key: 'ArrowLeft', preventDefault() {} });
	assert.equal(streamsTab.getAttribute('aria-selected'), 'true');
	assert.equal(streamsTab.getAttribute('tabindex'), '0');
	assert.equal(streamsPanelNode.hidden, false);
	assert.equal(downloadsPanelNode.hidden, true);
	assert.equal(document.activeElement, streamsTab, 'ArrowLeft from Downloads focuses Streams');
	await settle();

	const streamCalls = calls.filter(call => call.url === '/api/activity/streams');
	assert.equal(streamCalls.length, 1, 'selecting Streams starts one request without the manual flag');
	const rendered = textOf(document.querySelector('#streamsStatus')) + ' | ' + textOf(document.querySelector('#streamsList'));
	assert.match(rendered, /4.5 Mbps avg/);
	assert.match(rendered, /4.5 Mbps/);
	assert.match(rendered, /Test channel/);
	assert.match(rendered, /2 upstream channels · 1 connection/);
	assert.match(rendered, /Connection 1/);
	assert.match(rendered, /Reported by upstream/);
	assert.doesNotMatch(rendered, /secret-connection-id|upstream-key/, 'raw upstream identifiers are never rendered');

	streamsTab.listeners.keydown[0]({ key: 'Home', preventDefault() {} });
	assert.equal(activityTab.getAttribute('aria-selected'), 'true');
	assert.equal(streamsPanelNode.hidden, true);
	assert.equal(document.activeElement, activityTab);

	activityTab.listeners.keydown[0]({ key: 'ArrowRight', preventDefault() {} });
	assert.equal(logsTab.getAttribute('aria-selected'), 'true');
	assert.equal(logsPanel.hidden, false);
	assert.equal(document.activeElement, logsTab);
	logsTab.listeners.keydown[0]({ key: 'ArrowRight', preventDefault() {} });
	assert.equal(streamsTab.getAttribute('aria-selected'), 'true', 'ArrowRight wraps through all three tabs');
	assert.equal(streamsPanelNode.hidden, false);
});

function pickedStreamSnapshot() {
	const switchAt = Date.parse('2026-11-18T18:42:00Z');
	const base = { typeLabel: 'Live', state: 'running', source: 'custom', profile: 'custom Default',
		format: 'HLS', codec: 'H.264', resolution: '1920x1080', fps: 25, audio: 'AAC',
		averageBitrateKbps: 4500, bytes: null, durationSeconds: 90,
		connections: { reported: 0, shown: 0, truncated: false, items: [] } };
	return {
		configured: true, enabled: true, source: 'onThisServer', state: 'ok', reachable: true,
		checkedAt: '2026-11-18T12:00:00.000Z', upstreamAt: '2026-11-18T11:59:30.000Z', stale: false,
		notice: '', reported: { liveChannels: 3, liveClients: 0, vodConnections: 0, catchupConnections: 0 },
		truncated: false, rowsReported: 3, rowsShown: 3,
		streams: [
			{ ...base, kind: 'live', key: 'one', title: 'BBC One', streamName: 'BBC One HD',
				streamId: '4281', switchAt, switchReason: 'failover to backup source' },
			{ ...base, kind: 'live', key: 'two', title: 'No picked stream', source: 'Dispatcharr' },
			{ ...base, kind: 'live', key: 'three', title: 'Unsafe picked stream',
				streamName: 'https://private.invalid/live.m3u8', streamId: 'https://private.invalid/9',
				switchReason: 'see private.invalid/failover' }
		]
	};
}

test('DOM behaviour: the picked stream and last switch render only when reported', async () => {
	const document = fakeDocument();
	document.querySelector('#filter').value = 'all';
	const context = {
		document, Node: Element, location: { hash: '#streams' }, AbortController,
		fetch: async url => ({ ok: true, status: 200,
			json: async () => String(url).startsWith('/api/activity/streams') ? pickedStreamSnapshot() : activitySnapshot() }),
		setInterval() {}, setTimeout() { return 1; }, clearTimeout() {}
	};
	vm.runInNewContext(readFileSync(new URL('../public/activity-summary.js', import.meta.url), 'utf8'), context);
	vm.runInNewContext(activityJs, context);
	await settle();

	const rendered = textOf(document.querySelector('#streamsList'));
	const expectedTime = new Date(Date.parse('2026-11-18T18:42:00Z'))
		.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
	assert.match(rendered, /BBC One HD \(stream 4281\)/);
	assert.match(rendered, new RegExp(expectedTime + ', failover to backup source'));
	assert.match(rendered, /custom/, 'the source is the owning account');
	assert.equal(rendered.includes('Dispatcharr'), false, 'Dispatcharr is never a source, even from a stale payload');
	assert.equal((rendered.match(/BBC One HD \(stream 4281\)/g) || []).length, 1, 'absent or rejected stream values add no line');
	assert.equal((rendered.match(/failover to backup source/g) || []).length, 1, 'a rejected reason does not render a switch line');
	assert.doesNotMatch(rendered, /private\.invalid|Not reported/, 'rejected text and filler are never shown');
});

test('the old Dispatcharr monitor sentence is gone and no setup copy points at the old location', () => {
	assert.doesNotMatch(settingsHtml, /Dispatcharr connection settings stay here/);
	assert.doesNotMatch(settingsHtml, /Upstream channel and connection monitoring/);
	assert.doesNotMatch(settingsHtml, /streamsActivityLink/);
	assert.doesNotMatch(setupJs, /streamsActivityLink/);
	assert.doesNotMatch(setupJs, /dispatcharrStreamsLink/);
});

test('read-only Activity keeps the Streams and Downloads tabs and hides only the admin-only views', () => {
	const markReadOnly = slice(activityJs, 'function markReadOnly()', 'function renderReadOnly(');
	assert.doesNotMatch(markReadOnly, /#tabStreams|#streamsPanel/, 'Streams stays available to a local/home viewer');
	assert.doesNotMatch(markReadOnly, /'#tabDownloads'|'#downloadsPanel'/, 'the read-only Downloads list stays available');
	assert.match(markReadOnly, /#tabLogs/, 'the full log stays administrator-only');
	assert.match(markReadOnly, /#downloadsOwnerLink|#downloadsOwnerNote/, 'owner-only download controls stay hidden');
});

test('main navigation exposes Activity from Home, not only Settings', () => {
	const index = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
	const nav = index.slice(index.indexOf('<nav'), index.indexOf('</nav>') + 6);
	assert.match(nav, /class="nav-item" href="\/activity"/);
	assert.match(nav, />Activity<\/a>/);
	const navigation = readFileSync(new URL('../public/navigation.js', import.meta.url), 'utf8');
	assert.match(navigation, /\['Activity', '\/activity', ''\]/);
	for (const page of ['discover.html', 'search.html']) {
		const html = readFileSync(new URL('../public/' + page, import.meta.url), 'utf8');
		assert.match(html, /href="\/activity"/, page + ' links Activity');
	}
});

