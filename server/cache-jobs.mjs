/* Release 133: one bounded, owner-triggered shared-cache refresh queue.
 *
 * This is not a second periodic scheduler. Automatic refresh stays with the
 * existing Discover daily warmers, hourly chart preload and hourly series
 * index. This queue only lets the installation owner ask those same bounded
 * tasks to run now. It never overlaps itself, never bypasses the playback
 * check, never forces a full provider catalogue rebuild, and never touches
 * media sessions or streams.
 *
 * Status is phase-based. When a task cannot report item counts, `total` stays
 * null rather than inventing a percentage. Errors are redacted before they are
 * kept in the bounded recent log or written to disk.
 */
import { readFileSync, statSync } from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

export const CACHE_SCOPES = ['discover', 'trending', 'index'];
const MAX_LOG = 20;
const KEEP_LOG = 10;
const MAX_PERSIST = 16 * 1024;

const cleanText = value => String(value ?? '')
	.replace(/https?:\/\/\S+/gi, '[url]')
	.replace(/[A-Za-z0-9_-]{32,}/g, '[redacted]')
	.replace(/[\u0000-\u001f\u007f]+/g, ' ')
	.replace(/\s+/g, ' ')
	.trim()
	.slice(0, 180);

const cleanResult = value => {
	if (!value || typeof value !== 'object') return null;
	const out = {};
	for (const key of ['ran', 'skipped', 'failed', 'deferred', 'refreshed', 'total', 'cached', 'keys']) {
		const number = Number(value[key]);
		if (Number.isFinite(number) && number >= 0) out[key] = Math.min(1e9, Math.round(number));
	}
	if (typeof value.deferred === 'boolean') out.deferred = value.deferred;
	return Object.keys(out).length ? out : null;
};

const cleanResults = value => {
	if (!value || typeof value !== 'object') return null;
	const out = {};
	for (const scope of CACHE_SCOPES) {
		const clean = cleanResult(value[scope]);
		if (clean) out[scope] = clean;
	}
	return Object.keys(out).length ? out : null;
};

const normalizeScopes = input => {
	const list = Array.isArray(input) ? input : [input];
	if (!list.length || list.some(value => value === 'all')) return [...CACHE_SCOPES];
	const scopes = [...new Set(list.filter(value => CACHE_SCOPES.includes(value)))];
	return scopes.length ? scopes : null;
};

export function createCacheJobs({
	tasks = {},
	isBusy = () => false,
	generation = () => '',
	file = null,
	clock = Date.now,
	setTimer = setTimeout,
	clearTimer = clearTimeout,
	retryMs = 10 * 60000,
	cooldownMs = 60000,
	logLimit = MAX_LOG,
	maxDeferred = 288
} = {}) {
	if (!CACHE_SCOPES.every(scope => typeof tasks[scope] === 'function')) throw new TypeError('All cache tasks are required.');
	const limit = Math.max(1, Math.min(MAX_LOG, Number(logLimit) || MAX_LOG));
	const retry = Math.max(1000, Number(retryMs) || 10 * 60000);
	const cooldown = Math.max(0, Number(cooldownMs) || 0);
	const deferLimit = Math.max(1, Number(maxDeferred) || 288);

	let job = null, timer = null, stopped = false, lastManualAt = 0, sequence = 0;
	let recent = [], writing = Promise.resolve();
	const lastSuccess = Object.fromEntries(CACHE_SCOPES.map(scope => [scope, null]));

	// Size is checked before parsing, then every restored field is rebuilt rather
	// than trusted. A corrupt or oversized file leaves empty state.
	if (file) {
		try {
			if (statSync(file).size <= MAX_PERSIST) {
				const data = JSON.parse(readFileSync(file, 'utf8'));
				if (data?.version === 1) {
					for (const scope of CACHE_SCOPES) {
						const at = Number(data.lastSuccess?.[scope]);
						if (Number.isFinite(at) && at > 0) lastSuccess[scope] = at;
					}
					recent = (Array.isArray(data.recent) ? data.recent : []).slice(-limit).flatMap(entry => {
						if (!entry || typeof entry !== 'object') return [];
						const at = Number(entry.at);
						const scopes = (Array.isArray(entry.scopes) ? entry.scopes : []).filter(scope => CACHE_SCOPES.includes(scope));
						if (!Number.isFinite(at) || !scopes.length) return [];
						return [{
							at,
							scopes,
							state: ['done', 'failed', 'cancelled', 'expired'].includes(entry.state) ? entry.state : 'failed',
							durationMs: Number.isFinite(Number(entry.durationMs)) ? Math.max(0, Number(entry.durationMs)) : null,
							results: cleanResults(entry.results),
							error: entry.error ? cleanText(entry.error) : null
						}];
					});
				}
			}
		} catch {}
	}

	const persist = () => {
		if (!file) return;
		const data = JSON.stringify({ version: 1, lastSuccess, recent: recent.slice(-KEEP_LOG) });
		if (Buffer.byteLength(data) > MAX_PERSIST) return;
		writing = writing.catch(() => {}).then(async () => {
			try {
				await mkdir(dirname(file), { recursive: true, mode: 0o700 });
				await writeFile(file + '.part', data, { mode: 0o600 });
				await rename(file + '.part', file);
			} catch {}
		});
	};

	const busy = async () => {
		try { return Boolean(await isBusy()); } catch { return true; }
	};

	const view = entry => entry ? {
		id: entry.id,
		scopes: [...entry.scopes],
		state: entry.state,
		phase: entry.phase,
		completed: entry.completed,
		total: entry.total,
		waitingFor: entry.waitingFor || null,
		deferred: entry.deferred || 0,
		startedAt: entry.startedAt,
		results: { ...entry.results }
	} : null;

	const record = (entry, state, error = null) => {
		recent.push({
			at: clock(),
			scopes: [...entry.scopes],
			state,
			durationMs: Math.max(0, clock() - entry.startedAt),
			results: cleanResults(entry.results),
			error: error ? cleanText(error?.message || error) : null
		});
		if (recent.length > limit) recent = recent.slice(-limit);
		persist();
	};

	const finish = (state, error = null) => {
		if (!job) return;
		const entry = job;
		job = null;
		record(entry, state, error);
	};

	const schedule = delay => {
		if (stopped || timer || !job) return;
		timer = setTimer(() => { timer = null; return step(); }, Math.max(0, Number(delay) || 0));
		timer?.unref?.();
	};

	const defer = () => {
		job.state = 'waiting';
		job.waitingFor = 'playback';
		job.deferred = (job.deferred || 0) + 1;
		if (job.deferred > deferLimit) finish('expired', Error('Refresh waited too long for playback to become idle.'));
		else schedule(retry);
	};

	async function step() {
		if (stopped || !job) return;
		if (await busy()) return defer();
		job.state = 'running';
		job.waitingFor = null;
		for (let index = job.completed; index < job.scopes.length; index++) {
			if (await busy()) return defer();
			const scope = job.scopes[index];
			job.phase = scope;
			const startedGeneration = generation();
			let result;
			try {
				result = await tasks[scope]({ isBusy: busy });
			} catch (error) {
				return finish('failed', error);
			}
			if (generation() !== startedGeneration) return finish('cancelled', Error('Settings changed during the refresh.'));
			if (result?.deferred) return defer();
			job.results[scope] = cleanResult(result);
			job.completed = index + 1;
			// A phase that reports real per-item failures did not succeed just
			// because it returned; keep the honest last-success time unchanged.
			if (!Number(result?.failed)) lastSuccess[scope] = clock();
		}
		job.phase = null;
		finish('done');
	}

	return {
		request(input, { manual = false } = {}) {
			const scopes = normalizeScopes(input);
			if (stopped) return { accepted: false, reason: 'stopped', job: null };
			if (!scopes) return { accepted: false, reason: 'invalid-scope', job: null };
			if (job) return { accepted: false, reason: 'coalesced', job: view(job) };
			const now = Number(clock()) || Date.now();
			if (manual && lastManualAt && now - lastManualAt < cooldown) {
				return { accepted: false, reason: 'cooldown', retryAfterMs: cooldown - (now - lastManualAt), job: null };
			}
			if (manual) lastManualAt = now;
			job = {
				id: ++sequence, scopes, state: 'queued', phase: null, completed: 0,
				total: scopes.length, waitingFor: null, deferred: 0, startedAt: now, results: {}
			};
			schedule(0);
			return { accepted: true, reason: 'queued', job: view(job) };
		},
		stop() {
			stopped = true;
			if (timer) { clearTimer(timer); timer = null; }
			job = null;
		},
		resume() { stopped = false; },
		flush() { return writing; },
		status() {
			return {
				running: Boolean(job),
				state: job?.state || 'idle',
				job: view(job),
				cooldownMs: lastManualAt ? Math.max(0, cooldown - (Number(clock()) - lastManualAt)) : 0,
				lastSuccess: { ...lastSuccess },
				recent: recent.slice(-KEEP_LOG),
				automatic: { discover: 'daily', trending: 'hourly', index: 'hourly' }
			};
		}
	};
}
