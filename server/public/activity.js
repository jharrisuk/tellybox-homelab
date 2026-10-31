const message = document.querySelector('#activityMessage');
let snapshot;
const date = value => new Date(value).toLocaleString();
const labels = { login_success: 'Signed in', login_failed: 'Sign-in failed', login_throttled: 'Login rate limited', login_limit_reset: 'Sign-in limit reset', logout: 'Signed out', password_changed: 'Password changed', sessions_revoked: 'All remote browsers signed out', browser_revoked: 'Remote browser signed out', playback: 'Viewing', media_request: 'Media requested', share_created: 'Viewing link created', share_revoked: 'Shared link stopped' };
labels.upload_limit_changed = 'Upload limit changed';
labels.browser_download = 'Episode download';
labels.app_download = 'App download';
function element(tag, text, className) {
	const node = document.createElement(tag);
	if (text !== undefined) node.textContent = text;
	if (className) node.className = className;
	return node;
}
function position(value) {
	const seconds = Math.floor(value || 0);
	return `${Math.floor(seconds / 3600)}:${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
}
function table(target, headings, rows) {
	const host = document.querySelector(target);
	host.replaceChildren();
	if (!rows.length) { host.append(element('p', 'No activity to show yet.', 'auth-note')); return; }
	const scroll = element('div', undefined, 'table-scroll');
	const output = element('table');
	const header = element('tr');
	for (const heading of headings) header.append(element('th', heading));
	const head = element('thead'); head.append(header); output.append(head);
	const body = element('tbody');
	for (const values of rows) {
		const row = element('tr');
		for (const value of values) { const cell = element('td'); cell.append(value instanceof Node ? value : document.createTextNode(String(value))); row.append(cell); }
		body.append(row);
	}
	output.append(body); scroll.append(output); host.append(scroll);
}
async function revoke(route, body) {
	try {
		const response = await fetch(route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
		if (!response.ok) throw new Error((await response.json()).error);
		await refresh();
		message.textContent = 'Remote access revoked. Already-buffered video may play briefly.';
	} catch (error) { message.textContent = error.message; }
}
function renderHistory() {
	if (!snapshot) return;
	const filter = document.querySelector('#filter').value;
	const ip = document.querySelector('#ipFilter').value.trim();
	const rows = snapshot.recent.filter(entry => (!ip || (entry.mediaIp || entry.ip).includes(ip)) && (filter === 'all' || filter === 'remote' && !entry.local || filter === 'login' && entry.type.startsWith('login_') || filter === 'playback' && entry.type === 'playback')).slice(0, 200);
	table('#history', ['Time', 'Connection', 'Activity', 'Details'], rows.map(entry => [date(entry.time), `${entry.mediaIp || entry.ip} · ${entry.local ? 'Local' : 'Remote'}`,
		entry.type === 'playback' && entry.shareId ? 'Viewing shared link' : labels[entry.type] || entry.type,
		entry.type === 'media_request' ? `${entry.title} · ${entry.seasons?.length ? 'Seasons ' + entry.seasons.join(', ') + ' · ' : ''}${entry.state}`
			: entry.type === 'playback' ? `${entry.title} · ${entry.state} · ${position(entry.position)}`
				: entry.type === 'upload_limit_changed' ? entry.mbps ? `${entry.mbps} Mbps total` : 'Unlimited' : entry.reason ? [entry.email,entry.reason].filter(Boolean).join(' · ') : entry.title || entry.browser]));
}
async function refresh() {
	try {
		const response = await fetch('/api/activity');
		if (!response.ok) throw new Error('Activity is available only from the local Tellybox address.');
		snapshot = await response.json();
		const stats = document.querySelector('#stats'); stats.replaceChildren();
		for (const [key, label] of [['active', 'Watching now'], ['plays', 'Play requests · 24h'], ['remoteIps', 'Remote IPs · 24h'], ['failed', 'Failed / limited logins · 24h']]) {
			const card = element('div'); card.append(element('strong', snapshot.stats[key]), element('span', label)); stats.append(card);
		}
		const bandwidth = snapshot.bandwidth;
		if (bandwidth) {
			const card = element('div'); card.append(element('strong', `${bandwidth.measuredMbps} Mbps`), element('span', `Remote upload · 10-second average · ${bandwidth.mbps ? bandwidth.mbps + ' Mbps cap' : 'uncapped'} · ${bandwidth.activeTransfers} transferring now`)); stats.append(card);
		}
		table('#watching', ['Viewer', 'Title', 'Media connection', 'Playback details', 'State', 'Position'], snapshot.active.filter(entry => entry.purpose !== 'download').map(entry => {
			const details = element('details'); details.append(element('summary', entry.method === 'DirectPlay' ? 'Original quality' : entry.method === 'Transcode' ? 'Converted for playback' : 'Preparing'));
			for (const text of [entry.conversionReason, [entry.videoCodec, entry.audioCodec, entry.resolution].filter(Boolean).join(' · '),
				entry.qualityMbps ? `Quality ceiling: ${entry.qualityMbps} Mbps · source: ${entry.sourceMbps || 'unknown'} Mbps` : '',
				`Remote transfer: ${entry.remoteMbps || 0} Mbps (10-second average)`, entry.localFallback ? 'App reports local fallback: ' + entry.localFallback : '']) if (text) details.append(element('p', text));
			return [entry.home || entry.local ? 'Local' : entry.personName || entry.deviceName || 'Guest', entry.title, entry.mediaRoute ? `${entry.mediaIp || entry.ip} · ${entry.mediaRoute === 'local' ? 'Home server directly' : 'Internet relay'}` : 'Waiting for media', details, entry.state, position(entry.position)];
		}));
		const downloads = snapshot.downloads || [];
		document.querySelector('#downloadingSection').hidden = downloads.length === 0;
		const bytes = value => value >= 1073741824 ? (value / 1073741824).toFixed(2) + ' GB' : (value / 1048576).toFixed(1) + ' MB';
		table('#downloading', ['Person / device','Title','Connection','Progress'], downloads.map(entry => {
			const amount = entry.totalBytes > 0 ? `${Math.min(100,Math.floor(entry.bytes / entry.totalBytes * 100))}% · ${bytes(entry.bytes)} of ${bytes(entry.totalBytes)}` : `${bytes(entry.bytes || 0)} transferred`;
			return [entry.personName || entry.deviceName || (entry.home || entry.local ? 'Local' : 'Guest'), entry.title,
				`${entry.mediaIp || entry.ip} · ${entry.mediaRoute === 'local' ? 'Home server directly' : 'Internet relay'}`,
				amount + (Date.now() - entry.updated > 30000 ? ' · Waiting for data' : '')];
		}));
		table('#browsers', ['Login IP', 'Browser', 'Signed in', 'Access'], snapshot.browsers.map(entry => {
			const button = element('button', 'Sign out', 'button secondary');
			button.onclick = () => revoke('/api/auth/revoke-browser', { id: entry.id });
			return [entry.ip, entry.browser, date(entry.created), button];
		}));
		table('#viewingTotals', ['Viewer', 'Watched'], (snapshot.viewing?.users || []).map(person => [person.name, `${Math.floor(person.minutes / 60)}h ${person.minutes % 60}m`]));
		document.querySelector('#viewingSince').textContent = snapshot.viewing ? 'Recorded since ' + date(snapshot.viewing.since) + '. Simultaneous streams count separately.' : '';
		renderHistory();
		message.textContent = `Updated ${new Date().toLocaleTimeString()}`;
	} catch (error) { message.textContent = error.message; }
}
document.querySelector('#filter').onchange = renderHistory;
document.querySelector('#ipFilter').oninput = renderHistory;
document.querySelector('#revokeAll').onclick = () => revoke('/api/auth/revoke', {});
void refresh();
setInterval(() => { if (!document.hidden) void refresh(); }, 15000);
