import { createViewingTime } from './viewing-time.mjs';
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const retention = 30 * 86400000;
const limit = 5000;

function safeText(value, max = 240) {
	if (typeof value !== 'string') return '';
	return value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max);
}
function safeNumber(value) {
	const number = Number(value);
	return Number.isFinite(number) && number >= 0 ? number : 0;
}
// The read-only view never returns a raw user agent. It reports one coarse
// label, chosen from the validated client enum first and the agent shape only
// as a fallback.
function coarseDevice(entry) {
	const client = safeText(entry && entry.client, 32).toLowerCase();
	if (client === 'android-tv') return 'Android TV';
	if (client === 'android-phone') return 'Android app';
	const raw = safeText(entry && entry.browser, 500).toLowerCase();
	if (!raw) return 'Unknown device';
	if (/beyond\s*tv|smart-?tv|smarttv|hbbtv|tizen|web0s|webos|googletv|android ?tv|androidtv|appletv|apple ?tv|fire ?tv|firetv|crkey|bravia|roku|netcast|viera|opera ?tv|philips ?tv/.test(raw)) {
		if (/appletv|apple ?tv/.test(raw)) return 'Apple TV';
		if (/fire ?tv|firetv/.test(raw)) return 'Fire TV';
		if (/android ?tv|androidtv/.test(raw)) return 'Android TV';
		return 'Smart TV';
	}
	if (/iphone|ipod/.test(raw)) return 'iPhone';
	if (/ipad/.test(raw)) return 'iPad';
	if (/android/.test(raw)) return /mozilla|chrome|chromium|safari|firefox|edg\//.test(raw) ? 'Android browser' : 'Android app';
	if (/windows nt/.test(raw)) return 'Windows desktop';
	if (/macintosh|mac os x/.test(raw)) return 'Mac desktop';
	if (/x11|linux/.test(raw)) return 'Linux desktop';
	if (/cros/.test(raw)) return 'Desktop web';
	return 'Unknown device';
}
function safeRoute(value) {
	const route = safeText(value, 20);
	return ['local', 'relay', 'remote'].includes(route) ? route : null;
}

export function createActivity(directory, metrics = {}) {
	const file = path.join(directory, 'activity.json');
	let events = [];
	try { events = JSON.parse(readFileSync(file, 'utf8')); }
	catch (error) { if (error.code !== 'ENOENT') throw error; }
	const active = new Map();
	const downloads = new Map();
	const viewing = createViewingTime(directory);
	const listeners = new Set();
	let timer;
	function prune() {
		events = events.filter(event => event.updated > Date.now() - retention).slice(-limit);
	}
	function save() {
		clearTimeout(timer);
		timer = null;
		prune();
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		writeFileSync(file + '.tmp', JSON.stringify(events), { mode: 0o600 });
		renameSync(file + '.tmp', file);
	}
	function record(type, identity, details = {}) {
		const event = { id: randomUUID(), type, ...identity, ...details, time: Date.now(), updated: Date.now() };
		events.push(event);
		for (const listener of listeners) { try { listener(event); } catch {} }
		save();
		return event;
	}
	function begin(id, identity, item, details = {}) {
		viewing.begin(id, identity, details.purpose);
		const title = item.SeriesName ? `${item.SeriesName} · ${item.Name}` : item.Name;
		const duration = Math.max(0, Number(item.RunTimeTicks) || Number(item.MediaSources?.[0]?.RunTimeTicks) || 0) / 1e7;
		const genres = Array.isArray(item.Genres) ? item.Genres.filter(genre => typeof genre === 'string').slice(0, 20) : [];
		active.set(id, record('playback', identity, { title, itemId: item.Id, ...(item.Type === 'Episode' && item.SeriesId ? { seriesId: item.SeriesId } : {}), duration, genres, position: 0, state: 'requested', ...details }));
	}
	function beginDownload(id, identity, item, details = {}) {
		const entry = record(details.type || 'app_download', identity, { itemId: item.Id, title: item.SeriesName ? `${item.SeriesName} · ${item.Name}` : item.Name, purpose: 'download', state: 'downloading', ...details });
		downloads.set(id, { ...entry, bytes: details.offset || 0, transferredBytes: 0, totalBytes: details.totalBytes || 0 });
	}
	function downloadProgress(id, bytes) {
		const entry = downloads.get(id);
		if (entry) { entry.bytes += bytes; entry.transferredBytes += bytes; entry.updated = Date.now(); }
	}
	function endDownload(id) { downloads.delete(id); }
	function update(id, values = {}) {
		const entry = active.get(id);
		if (!entry) return;
		if (values.heartbeat) {
			viewing.update(id, { position: values.position, playing: values.state === 'playing', rate: values.rate, ended: values.state === 'ended' });
			if (values.state === 'playing' && !entry.notified && entry.purpose !== 'download') { entry.notified = true; record('watch_started', { ...entry }, { id: randomUUID(), type: 'watch_started' }); }
		}
		if (values.state === 'ended') viewing.update(id, { playing: false, ended: true });
		Object.assign(entry, values, { updated: Date.now() });
		if (values.state === 'ended') { active.delete(id); save(); }
		else if (!timer) timer = setTimeout(save, 5000).unref();
	}
	// Return only the caller's confirmed playback history. A person key spans
	// devices; a device key is used only when no person is attached; local/home
	// deliberately uses the shared home context.
	//
	// Each item keeps its own latest event, so episodes inside one series are
	// never collapsed together. A newer rewind replaces an older later position.
	// Completion requires an ended event at the known duration; a partial stop
	// is resume progress, not a finished title.
	function history(identity = {}) {
		prune();
		const personId = typeof identity.personId === 'string' ? identity.personId : '';
		const deviceId = typeof identity.deviceId === 'string' ? identity.deviceId : '';
		const shared = Boolean(identity.local || identity.home);
		const wanted = event => {
			if (event.type !== 'playback' || event.purpose === 'download' || event.shareId) return false;
			if (shared) return Boolean(event.local || event.home);
			if (personId) return event.personId === personId;
			if (deviceId) return event.deviceId === deviceId;
			return false;
		};
		const latest = new Map();
		for (const event of events) {
			if (!wanted(event) || typeof event.itemId !== 'string') continue;
			const updated = Number(event.updated) || 0;
			const previous = latest.get(event.itemId);
			if (previous && updated < previous.updated) continue;
			const position = Math.max(0, Number(event.position) || 0);
			const duration = Math.max(0, Number(event.duration) || 0);
			const completed = event.completed === true
				|| event.state === 'ended' && duration > 0 && position >= Math.max(duration * 0.95, duration - 90);
			latest.set(event.itemId, { itemId: event.itemId, seriesId: typeof event.seriesId === 'string' && event.seriesId ? event.seriesId : null,
				title: typeof event.title === 'string' ? event.title : '', position, duration, completed,
				state: typeof event.state === 'string' ? event.state : '',
				genres: Array.isArray(event.genres) ? event.genres.filter(genre => typeof genre === 'string') : [],
				updated });
		}
		return [...latest.values()].sort((a, b) => b.updated - a.updated).slice(0, 500);
	}
	const localDate = at => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(at));

	function snapshot(options = {}) {
		prune();
		const now = Date.now();
		const current = [...active.entries()].filter(([, entry]) => entry.state !== 'requested' && entry.updated > now - 120000)
			.map(([id, entry]) => ({ ...entry, remoteMbps: metrics.transfer?.(id) || 0 }));
		const currentIds = new Set(current.map(entry => entry.id));
		const currentDownloads = [...downloads.values(), ...current.filter(entry => entry.purpose === 'download').map(entry => ({ ...entry, bytes: entry.downloadBytes || 0, totalBytes: 0, state: 'downloading' }))];
		// Stable newest-first order for the full log and the compact preview.
		// A missing/invalid time sorts last; equal times keep reverse insertion
		// order (the most recently written record first).
		const allRecent = events.map((entry, index) => ({ entry, index })).sort((left, right) => {
			const a = Number(left.entry.time), b = Number(right.entry.time);
			const validA = Number.isFinite(a) && a > 0, validB = Number.isFinite(b) && b > 0;
			if (validA && validB) return b - a || right.index - left.index;
			if (validA !== validB) return validA ? -1 : 1;
			return right.index - left.index;
		}).map(item => item.entry);
		const day = allRecent.filter(entry => entry.time > now - 86400000);
		const lastLogins = {};
		for (const event of events) {
			if (event.type !== 'login_success' || !Number.isFinite(Number(event.time))) continue;
			const at = Number(event.time);
			if (event.personId) lastLogins['person:' + event.personId] = Math.max(lastLogins['person:' + event.personId] || 0, at);
			if (event.deviceId) lastLogins['device:' + event.deviceId] = Math.max(lastLogins['device:' + event.deviceId] || 0, at);
			if (event.browserId) lastLogins['browser:' + event.browserId] = Math.max(lastLogins['browser:' + event.browserId] || 0, at);
		}
		const viewingSnapshot = viewing.snapshot();
		const users = (viewingSnapshot.users || []).map(person => {
			const daily = metrics.dailySeconds?.(person.id);
			const dailySeconds = Number.isFinite(daily) ? Math.max(0, Math.floor(daily)) : null;
			const dailyLimit = metrics.dailyLimitSeconds?.(person.id);
			return { ...person, dailySeconds, dailyMinutes: dailySeconds === null ? null : Math.floor(dailySeconds / 60),
				dailyLimitSeconds: Number.isFinite(dailyLimit) && dailyLimit > 0 ? Math.floor(dailyLimit) : null,
				dailyTimezone: dailySeconds === null ? null : (metrics.dailyTimezone || 'Europe/London'),
				dailyDay: dailySeconds === null ? null : (metrics.dailyDay?.() || localDate(now)),
				lastLogin: lastLogins[person.id] || null };
		});
		// Bounded filter facets from retained events only. This never reads a
		// separate user directory and never exposes a person who has no activity.
		const facetUsers = new Map(), facetDevices = new Map();
		for (const entry of events) {
			if (entry.personId) facetUsers.set('person:' + entry.personId, entry.personName || 'Known account');
			else if (entry.personName) facetUsers.set('person:name:' + entry.personName, entry.personName);
			if (entry.home || entry.local) facetUsers.set('local', 'Local access');
			const deviceKey = entry.deviceId ? 'device:' + entry.deviceId : entry.browserId ? 'browser:' + entry.browserId : '';
			if (deviceKey && facetDevices.size < 100) facetDevices.set(deviceKey, entry.deviceName || entry.browser || 'Unknown device');
			else if (!deviceKey && entry.browser && facetDevices.size < 100) facetDevices.set(String(entry.browser).slice(0, 160), entry.browser);
		}
		const historySince = events.reduce((lowest, entry) => Number.isFinite(Number(entry.time)) && (lowest === null || Number(entry.time) < lowest) ? Number(entry.time) : lowest, null);
		const q = String(options.q || '').trim().toLowerCase();
		const user = String(options.user || '').trim().toLowerCase();
		const device = String(options.device || '').trim().toLowerCase();
		const date = String(options.date || '').trim();
		const type = String(options.type || 'all').trim().toLowerCase();
		const textOf = entry => [entry.personName, entry.personId, entry.deviceName, entry.deviceId, entry.browserId,
			entry.browser, entry.ip, entry.mediaIp, entry.email, entry.title, entry.reason].filter(Boolean).join(' ').toLowerCase();
		const matchesType = entry => type === 'all'
			|| type === 'remote' && !entry.local
			|| type === 'login' && String(entry.type || '').startsWith('login_')
			|| type === 'playback' && entry.type === 'playback'
			|| type === 'download' && ['browser_download', 'app_download'].includes(entry.type)
			|| type === 'security' && ['password_changed', 'sessions_revoked', 'browser_revoked', 'login_limit_reset', 'upload_limit_changed'].includes(entry.type);
		const matchesUser = entry => !user || user === 'local' && (entry.local || entry.home)
			|| (entry.personId && ('person:' + entry.personId).toLowerCase() === user)
			|| (entry.personName && ('person:name:' + entry.personName).toLowerCase() === user)
			|| String(entry.personName || '').toLowerCase() === user;
		const matchesDevice = entry => !device || (entry.deviceId && ('device:' + entry.deviceId).toLowerCase() === device)
			|| (entry.browserId && ('browser:' + entry.browserId).toLowerCase() === device)
			|| (entry.browserId && String(entry.browserId).toLowerCase() === device)
			|| String(entry.deviceName || '').toLowerCase() === device
			|| String(entry.browser || '').toLowerCase() === device;
		const matchesDate = entry => !date || localDate(entry.time) === date;
		const filtered = allRecent.filter(entry => matchesType(entry) && matchesUser(entry) && matchesDevice(entry)
			&& matchesDate(entry) && (!q || textOf(entry).includes(q)));
		const requestedLimit = Number(options.recentLimit);
		const requestedOffset = Number(options.recentOffset);
		const pageLimit = Number.isSafeInteger(requestedLimit) ? Math.min(200, Math.max(1, requestedLimit)) : 200;
		const offset = Number.isSafeInteger(requestedOffset) ? Math.min(5000, Math.max(0, requestedOffset)) : 0;
		const recent = filtered.slice(offset, offset + pageLimit).map(entry => ({ ...entry,
			state: entry.type === 'playback' && !currentIds.has(entry.id) && entry.state !== 'ended' ? 'inactive' : entry.state }));
		return { viewing: { ...viewingSnapshot, users }, active: current, downloads: currentDownloads, recent,
			lastLogins,
			facets: { users: [...facetUsers.entries()].map(([id, name]) => ({ id, name })).slice(0, 100),
				devices: [...facetDevices.entries()].map(([id, name]) => ({ id, name })).slice(0, 100) },
			historySince,
			page: { limit: pageLimit, offset, total: filtered.length, hasMore: offset + recent.length < filtered.length,
				windowDays: 30, retentionDays: 30 },
			bandwidth: metrics.bandwidth?.(), retentionDays: 30, recordLimit: limit, stats: {
				active: current.filter(entry => entry.purpose !== 'download').length,
				downloads: currentDownloads.length,
				plays: day.filter(entry => entry.type === 'playback' && entry.purpose !== 'download').length,
				failed: day.filter(entry => ['login_failed', 'login_throttled'].includes(entry.type)).length,
				remoteIps: new Set(day.filter(entry => !entry.local && ['login_success', 'playback'].includes(entry.type)).map(entry => entry.ip)).size
			} };
	}
	// A deliberately sanitized read model for trusted home/LAN viewers. It is
	// built from snapshot() but never carries events, addresses, account ids,
	// browser sessions, raw user agents or login state.
	function summary() {
		const current = snapshot();
		const active = current.active.filter(entry => entry && entry.purpose !== 'download').map(entry => {
			const local = Boolean(entry.local || entry.home);
			const personName = safeText(entry.personName, 120);
			const view = {
				title: safeText(entry.title, 300) || 'Unknown title',
				state: safeText(entry.state, 40),
				purpose: safeText(entry.purpose, 40) || 'watch',
				position: safeNumber(entry.position),
				duration: safeNumber(entry.duration),
				updated: safeNumber(entry.updated),
				local,
				home: Boolean(entry.home),
				// The shared renderer uses this coarse label instead of a raw agent.
				deviceLabel: coarseDevice(entry),
				// A display label, never a fabrication from an address or agent.
				personName: personName || (local ? 'Local access' : 'Unknown viewer'),
				viewerKind: personName ? 'account' : local ? 'local' : 'unknown'
			};
			const route = safeRoute(entry.mediaRoute);
			if (route) view.mediaRoute = route;
			const method = safeText(entry.method, 60);
			if (method) view.method = method;
			return view;
		});
		const bandwidth = current.bandwidth && typeof current.bandwidth === 'object' ? {
			measuredMbps: safeNumber(current.bandwidth.measuredMbps),
			mbps: safeNumber(current.bandwidth.mbps),
			activeTransfers: safeNumber(current.bandwidth.activeTransfers)
		} : null;
		return {
			generatedAt: Date.now(),
			readOnly: true,
			stats: {
				active: safeNumber(current.stats?.active),
				downloads: safeNumber(current.stats?.downloads),
				plays: safeNumber(current.stats?.plays),
				failed: safeNumber(current.stats?.failed),
				remoteIps: safeNumber(current.stats?.remoteIps)
			},
			bandwidth,
			active,
			downloadCount: Array.isArray(current.downloads) ? current.downloads.length : safeNumber(current.stats?.downloads)
		};
	}
	// Expire records on disk even when nobody opens the dashboard or starts another stream.
	setInterval(() => {
		if (events.some(entry => entry.updated <= Date.now() - retention)) save();
	}, 300000).unref();
	return { subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); }, record, begin, update, beginDownload, downloadProgress, endDownload, history, snapshot, summary, flush: save };
}
