import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// A Home Assistant token is a separate, revocable read-only credential. It is
// never accepted from a cookie, app token, local address or forwarded header.
export const STATS_PATH = '/api/integrations/home-assistant/stats';
export const STATS_SCHEMA = 'tellybox.home-assistant.stats';
export const STATS_VERSION = 1;

const tokenFile = 'home-assistant-token.json';
const installationFile = 'installation.json';
const tokenPattern = /^[a-f0-9]{64}$/;
const digest = value => createHash('sha256').update(value).digest('hex');

function readJson(file) {
	try { return JSON.parse(readFileSync(file, 'utf8')); }
	catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return null; throw error; }
}
function writeJson(file, value) {
	mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	const temporary = file + '.tmp';
	writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
	renameSync(temporary, file);
}
function publicToken(record) {
	if (!record || !tokenPattern.test(record.tokenHash || '') || typeof record.id !== 'string') return { configured: false };
	return { configured: true, id: record.id, createdAt: Number.isFinite(record.createdAt) ? record.createdAt : null, rotatedAt: Number.isFinite(record.rotatedAt) ? record.rotatedAt : null };
}

export function createHomeAssistantTokens(directory) {
	const file = path.join(directory, tokenFile);
	function status() {
		try { return publicToken(readJson(file)); }
		catch { return { configured: false }; }
	}
	function issue(previous) {
		const token = randomBytes(32).toString('hex'), now = Date.now();
		const record = { version: 1, id: randomBytes(8).toString('hex'), tokenHash: digest(token), createdAt: previous?.createdAt || now, updatedAt: now, ...(previous ? { rotatedAt: now } : {}) };
		writeJson(file, record);
		return { token, ...publicToken(record) };
	}
	return {
		status,
		verify(token) {
			if (typeof token !== 'string' || !tokenPattern.test(token)) return false;
			try {
				const saved = readJson(file);
				if (!publicToken(saved).configured) return false;
				return timingSafeEqual(Buffer.from(digest(token), 'hex'), Buffer.from(saved.tokenHash, 'hex'));
			} catch { return false; }
		},
		create() {
			const current = readJson(file);
			if (publicToken(current).configured) throw Object.assign(Error('A Home Assistant token already exists. Rotate it instead.'), { status: 409 });
			return issue(null);
		},
		rotate() {
			const current = readJson(file);
			if (!publicToken(current).configured) throw Object.assign(Error('Create a Home Assistant token first.'), { status: 409 });
			return issue(current);
		},
		revoke() {
			if (!existsSync(file)) return { revoked: false, configured: false };
			unlinkSync(file);
			return { revoked: true, configured: false };
		}
	};
}

export function createInstallationIdentity(directory) {
	const file = path.join(directory, installationFile);
	const saved = readJson(file);
	if (saved && typeof saved.id === 'string' && /^[a-f0-9-]{36}$/i.test(saved.id)) return saved;
	const value = { version: 1, id: randomUUID(), createdAt: Date.now() };
	writeJson(file, value);
	return value;
}

const count = value => Number.isInteger(value) && value >= 0 ? value : null;
const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
function percent(used, total) {
	if (used === null || total === null || total <= 0) return null;
	return Math.round(Math.max(0, Math.min(100, used / total * 100)) * 10) / 10;
}

// Only aggregate counters and sanitised host readings leave the server. Titles,
// account identities, addresses, paths and provider URLs are never selected.
export function createHomeAssistantIntegration({ directory, activity, serverHealth, uploadLimit, version, clock = Date.now }) {
	const tokens = createHomeAssistantTokens(directory);
	let installation = null;
	function installationId() {
		if (!installation) installation = createInstallationIdentity(directory);
		return installation.id;
	}
	async function stats() {
		const snapshot = activity.snapshot();
		const health = await serverHealth();
		const upload = uploadLimit.status();
		const host = health?.host || null;
		const hostStatus = !host ? 'missing' : host.stale === true ? 'stale' : 'ok';
		const fresh = hostStatus === 'ok';
		const memory = host?.memory || {};
		const totalMemory = fresh ? number(memory.total) : null;
		const availableMemory = fresh ? number(memory.available) : null;
		const disks = Array.isArray(host?.disks) ? host.disks.map(disk => {
			const label = typeof disk.label === 'string' ? disk.label.trim() : '';
			return {
				id: typeof disk.id === 'string' && /^[a-zA-Z0-9._-]{1,64}$/.test(disk.id) ? disk.id : null,
				name: /^[\p{L}\p{N} _().-]{1,60}$/u.test(label) ? label : 'Disk',
				availableBytes: fresh && disk.available === true ? number(disk.free) : null,
				totalBytes: fresh ? number(disk.total) : null,
				usedBytes: fresh ? number(disk.used) : null
			};
		}).filter(disk => disk.id).slice(0, 16) : [];
		const hasStreams = Array.isArray(snapshot?.active), hasDownloads = Array.isArray(snapshot?.downloads);
		// A missing array is not an empty installation. Counts stay null so HA
		// marks the sensors unavailable instead of showing a fabricated zero.
		const current = hasStreams ? snapshot.active.filter(entry => entry && entry.purpose !== 'download') : [];
		const playing = hasStreams ? current.filter(entry => entry.state === 'playing').length : null;
		const streams = hasStreams ? {
			active: playing,
			connected: current.length,
			paused: current.filter(entry => entry.state === 'paused').length,
			local: current.filter(entry => entry.mediaRoute === 'local').length,
			remote: current.filter(entry => entry.mediaRoute === 'remote').length
		} : { active: null, connected: null, paused: null, local: null, remote: null };
		const downloads = hasDownloads ? snapshot.downloads.filter(entry => entry && !['ended', 'failed'].includes(entry.state)).length : null;
		return {
			schema: STATS_SCHEMA,
			schemaVersion: STATS_VERSION,
			generatedAt: clock(),
			installationId: installationId(),
			server: {
				version: typeof version === 'string' ? version : null,
				hostStatus,
				sampledAt: fresh ? number(host.sampledAt) : null,
				uptimeSeconds: number(health?.service?.uptimeSeconds),
				hostUptimeSeconds: fresh ? number(host.uptimeSeconds) : null,
				cpuPercent: fresh ? number(host.cpuPercent) : null,
				memoryPercent: fresh ? percent(totalMemory === null || availableMemory === null ? null : totalMemory - availableMemory, totalMemory) : null,
				memoryTotalBytes: totalMemory,
				memoryAvailableBytes: availableMemory,
				disks
			},
			streams,
			downloads: { active: downloads },
			upload: {
				configuredMbps: number(upload?.mbps),
				unlimited: number(upload?.mbps) === null ? null : upload.mbps === 0,
				measuredMbps: number(upload?.measuredMbps),
				measurementSeconds: number(upload?.measurementSeconds)
			}
		};
	}
	return { tokens, stats };
}

export function installHomeAssistantStats(app, { integration, path: route = STATS_PATH }) {
	app.get(route, async (req, res) => {
		res.set({ 'Cache-Control': 'no-store', Pragma: 'no-cache', Vary: 'Authorization', 'X-Content-Type-Options': 'nosniff' });
		const authorization = req.get('authorization') || '';
		// Bound the header before hashing and never inspect cookies or app tokens.
		const match = authorization.length <= 96 ? /^Bearer ([a-f0-9]{64})$/.exec(authorization) : null;
		if (!match || !integration.tokens.verify(match[1])) return res.status(401).json({ error: 'A valid Home Assistant read-only token is required.' });
		try {
			res.json(await integration.stats());
		} catch {
			res.status(503).json({ error: 'Tellybox statistics are temporarily unavailable.' });
		}
	});
	app.all(route, (req, res) => {
		res.set({ 'Cache-Control': 'no-store', Allow: 'GET' }).status(405).json({ error: 'Use GET for Tellybox statistics.' });
	});
}
