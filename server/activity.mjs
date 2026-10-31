import { createViewingTime } from './viewing-time.mjs';
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const retention = 30 * 86400000;
const limit = 5000;

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
		active.set(id, record('playback', identity, { title, itemId: item.Id, ...(item.Type === 'Episode' && item.SeriesId ? { seriesId: item.SeriesId } : {}), position: 0, state: 'requested', ...details }));
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
	function snapshot() {
		prune();
		const current = [...active.entries()].filter(([, entry]) => entry.state !== 'requested' && entry.updated > Date.now() - 120000)
			.map(([id, entry]) => ({ ...entry, remoteMbps: metrics.transfer?.(id) || 0 }));
		const currentIds = new Set(current.map(entry => entry.id));
		const currentDownloads = [...downloads.values(), ...current.filter(entry => entry.purpose === 'download').map(entry => ({ ...entry, bytes: entry.downloadBytes || 0, totalBytes: 0, state: 'downloading' }))];
		const recent = events.slice().reverse().map(entry => ({ ...entry, state: entry.type === 'playback' && !currentIds.has(entry.id) && entry.state !== 'ended' ? 'inactive' : entry.state }));
		const day = recent.filter(entry => entry.time > Date.now() - 86400000);
		return { viewing: viewing.snapshot(), active: current, downloads: currentDownloads, recent, bandwidth: metrics.bandwidth?.(), retentionDays: 30, recordLimit: limit, stats: {
			active: current.filter(entry => entry.purpose !== 'download').length,
			downloads: currentDownloads.length,
			plays: day.filter(entry => entry.type === 'playback' && entry.purpose !== 'download').length,
			failed: day.filter(entry => ['login_failed', 'login_throttled'].includes(entry.type)).length,
			remoteIps: new Set(day.filter(entry => !entry.local && ['login_success', 'playback'].includes(entry.type)).map(entry => entry.ip)).size
		} };
	}
	// Expire records on disk even when nobody opens the dashboard or starts another stream.
	setInterval(() => {
		if (events.some(entry => entry.updated <= Date.now() - retention)) save();
	}, 300000).unref();
	return { subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); }, record, begin, update, beginDownload, downloadProgress, endDownload, snapshot, flush: save };
}
