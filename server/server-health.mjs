import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const percent = value => number(value) === null ? null : Math.min(100, value);
// Disk identity is a one-way token, so a collector path or device name is never published.
const diskId = value => createHash('sha256').update('tellybox-disk:' + String(value)).digest('hex').slice(0, 16);
function diskName(value) {
	let text = String(value ?? 'Disk').replace(/[\x00-\x1f]/g, ' ').trim();
	if (/:\/\//.test(text) || /[?@]/.test(text)) return 'Disk';
	if (/[\\/]/.test(text)) text = text.split(/[\\/]/).filter(Boolean).pop() || 'Disk';
	return text.slice(0, 60) || 'Disk';
}
export function sanitizeHost(value, now = Date.now()) {
	if (!value || number(value.sampledAt) === null || value.sampledAt > now + 30000) throw new Error('Invalid sample');
	const memory = value.memory || {}, seen = new Map();
	return {
		sampledAt: value.sampledAt, stale: now - value.sampledAt > 150000,
		sampleSeconds: number(value.sampleSeconds), cpuPercent: percent(value.cpuPercent), ioWaitPercent: percent(value.ioWaitPercent),
		cpuThreads: number(value.cpuThreads), load: Array.isArray(value.load) ? value.load.slice(0, 3).map(number) : [], uptimeSeconds: number(value.uptimeSeconds),
		memory: Object.fromEntries(['total', 'available', 'swapTotal', 'swapUsed'].map(key => [key, number(memory[key])])),
		disks: Array.isArray(value.disks) ? value.disks.slice(0, 16).map(disk => {
			const base = diskId(disk.id || disk.device || disk.label || 'Disk'), ordinal = seen.get(base) || 0;
			seen.set(base, ordinal + 1);
			return {
				id: ordinal ? `${base}-${ordinal}` : base,
				label: diskName(disk.label), available: disk.available === true,
				total: number(disk.total), used: number(disk.used), free: number(disk.free),
				reason: disk.available === true ? null : 'Disk unavailable or not mounted'
			};
		}) : []
	};
}
export function createServerHealth(file, { bandwidth = () => ({}), streaming = () => 0 } = {}) {
	return async () => {
		let host = null;
		try { host = sanitizeHost(JSON.parse(await readFile(file, 'utf8'))); } catch { /* Missing readings are not zero usage. */ }
		const usage = process.memoryUsage();
		return { host, service: { uptimeSeconds: process.uptime(), memoryBytes: usage.rss, watching: streaming() }, bandwidth: bandwidth() };
	};
}
