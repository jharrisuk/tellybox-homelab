import { readFile } from 'node:fs/promises';

const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const percent = value => number(value) === null ? null : Math.min(100, value);
export function sanitizeHost(value, now = Date.now()) {
	if (!value || number(value.sampledAt) === null || value.sampledAt > now + 30000) throw new Error('Invalid sample');
	const memory = value.memory || {};
	return {
		sampledAt: value.sampledAt, stale: now - value.sampledAt > 150000,
		sampleSeconds: number(value.sampleSeconds), cpuPercent: percent(value.cpuPercent), ioWaitPercent: percent(value.ioWaitPercent),
		cpuThreads: number(value.cpuThreads), load: Array.isArray(value.load) ? value.load.slice(0, 3).map(number) : [], uptimeSeconds: number(value.uptimeSeconds),
		memory: Object.fromEntries(['total', 'available', 'swapTotal', 'swapUsed'].map(key => [key, number(memory[key])])),
		disks: Array.isArray(value.disks) ? value.disks.slice(0, 16).map(disk => ({
			label: String(disk.label || 'Disk').slice(0, 60), available: disk.available === true,
			total: number(disk.total), used: number(disk.used), free: number(disk.free),
			reason: disk.available === true ? null : 'Disk unavailable or not mounted'
		})) : []
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
