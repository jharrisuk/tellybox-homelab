/* Release 134: optional, owner-only qBittorrent WebUI monitoring.
 *
 * The integration is disabled on a fresh install. While disabled this module
 * never opens a network connection. It talks only to the single WebUI target
 * saved by the installation owner, never to a browser-supplied URL, and never
 * follows redirects. Credentials and torrent hashes stay on the server.
 *
 * Monitoring is read-only. The separate delete action accepts exactly one
 * server-resolved hash and is reachable only through a one-use confirmation
 * token bound to the owner session, the action and the configuration
 * generation. No bulk, empty or "all" hash can be produced here.
 */
import { mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { DOWNLOADS_PAGE } from './qbittorrent-page.mjs';

const DEFAULT_TIMEOUT_MS = 8000;
const MAX_BODY = 2 * 1024 * 1024;
const MAX_LOGIN_BODY = 4096;
const MAX_ROWS = 500;
const TOKEN_MS = 60000;

// The read-only list is paged in the browser. Counts are collected from one
// bounded query per qBittorrent state filter; the cap applies after the
// upstream filter, so a large seed library cannot hide an active download.
const VIEWER_ROW_LIMIT = 200;
const COUNT_LIMIT = 500;
// Progress samples exist only to measure a stall for torrents still being
// read. A sample that has not been seen for this window belongs to a torrent
// that left the queue, so it is dropped rather than kept forever; the hard cap
// bounds a very large churn of unique hashes between prunes.
const SAMPLE_TTL_MS = 6 * 60 * 60 * 1000;
const SAMPLE_LIMIT = 2000;
const SAMPLE_PRUNE_MS = 60000;
const VIEWER_FILTERS = Object.freeze(['downloading', 'seeding', 'all']);
const COUNT_KEYS = Object.freeze([
	'downloading', 'queued', 'seeding', 'paused', 'checking', 'moving', 'attention', 'other'
]);

const NOTICES = Object.freeze({
	unconfigured: 'qBittorrent is not configured. Add the WebUI address and sign-in in installation settings on port 8990.',
	disabled: 'qBittorrent monitoring is switched off. No request was made.',
	idle: 'No qBittorrent check has run yet.',
	unreachable: 'qBittorrent could not be reached. This is not the same as an empty download list.',
	timeout: 'qBittorrent did not answer in time.',
	'auth-failed': 'qBittorrent refused the saved WebUI sign-in. Update the credentials in installation settings on port 8990.',
	'auth-throttled': 'qBittorrent sign-in is paused briefly after repeated failures.',
	banned: 'qBittorrent has temporarily banned this address after failed sign-ins. Wait, then check the credentials.',
	invalid: 'qBittorrent returned a response this integration could not read.',
	'too-large': 'qBittorrent returned more data than this integration will read.',
	'not-found': 'That torrent is no longer in qBittorrent. Refresh the list.',
	changed: 'The torrent changed after it was reviewed. Refresh and review it again.',
	replay: 'That confirmation has expired or was already used. Review the torrent again.',
	'source-changed': 'The qBittorrent connection changed. Refresh the list before trying again.',
	'owner-required': 'The installation administrator session is no longer valid. Sign in again.',
	'backoff': 'qBittorrent checks are paused briefly after a failure.',
	'invalid-filter': 'Choose one of the supported download filters: downloading, seeding or all.',
	ok: 'qBittorrent answered this monitoring check.',
	stale: 'The last good qBittorrent reading is shown. It may be out of date.'
});

// The only state codes a read-only summary may carry to a browser. Anything
// else becomes 'unknown', so a future internal code cannot leak by accident.
const SUMMARY_STATES = Object.freeze([
	'idle', 'ok', 'stale', 'disabled', 'unconfigured', 'unreachable', 'timeout',
	'auth-failed', 'auth-throttled', 'banned', 'invalid', 'too-large', 'backoff',
	'not-found', 'changed', 'replay', 'source-changed', 'owner-required'
]);

const STATE_LABELS = Object.freeze({
	error: 'Error', missingFiles: 'Files missing', uploading: 'Seeding', pausedUP: 'Paused after download',
	stoppedUP: 'Paused after download', queuedUP: 'Queued to seed', stalledUP: 'Seeding, no peers',
	checkingUP: 'Checking after download', forcedUP: 'Seeding (forced)', allocating: 'Allocating space',
	downloading: 'Downloading', metaDL: 'Fetching metadata', forcedMetaDL: 'Fetching metadata (forced)',
	pausedDL: 'Paused', stoppedDL: 'Paused', queuedDL: 'Queued', stalledDL: 'Stalled download',
	checkingDL: 'Checking download', forcedDL: 'Downloading (forced)', checkingResumeData: 'Checking resume data',
	queuedForChecking: 'Queued to check', moving: 'Moving files', unknown: 'Unknown'
});

export class QbitError extends Error {
	constructor(code, message, status = 502) {
		super(message || NOTICES[code] || 'qBittorrent could not complete this request.');
		this.name = 'QbitError';
		this.code = code;
		this.status = status;
	}
}

function clamp(value, low, high, fallback) {
	const number = Number(value);
	return Number.isFinite(number) ? Math.min(high, Math.max(low, Math.floor(number))) : fallback;
}

function oneLine(value, limit = 300) {
	return String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit);
}

// Torrent names are shown, but never as links. Strip magnet URIs and any URL
// so a name cannot smuggle a tracker, passkey or save path into the page.
export function safeName(value, limit = 300) {
	return oneLine(value, limit)
		.replace(/magnet:\?[^\s]*/gi, '[magnet]')
		.replace(/\b(?:https?|udp|ftp):\/\/\S+/gi, '[link]');
}

export function normalizeWebUiUrl(raw) {
	if (typeof raw !== 'string') throw new QbitError('invalid-target', 'Enter the qBittorrent WebUI address.', 400);
	const value = raw.trim();
	if (!value || value.length > 2048) throw new QbitError('invalid-target', 'Enter the qBittorrent WebUI address.', 400);
	let url;
	try { url = new URL(value); }
	catch { throw new QbitError('invalid-target', 'Enter a complete http:// or https:// WebUI address.', 400); }
	if (!['http:', 'https:'].includes(url.protocol)) throw new QbitError('invalid-target', 'The WebUI address must start with http:// or https://.', 400);
	if (url.username || url.password) throw new QbitError('invalid-target', 'Do not put a username or password in the WebUI address.', 400);
	if (url.search || url.hash) throw new QbitError('invalid-target', 'The WebUI address must not include a query string or fragment.', 400);
	if (!url.hostname) throw new QbitError('invalid-target', 'Enter a complete http:// or https:// WebUI address.', 400);
	const pathname = url.pathname.replace(/\/+$/, '');
	return url.origin + (pathname === '/' ? '' : pathname);
}

// qBittorrent v1 info hashes are 40 lowercase hex characters and v2 hashes are
// 64. The documented single-hash form is exactly one value; this helper also
// accepts the 36-40 hex range requested for release 134 but rejects empty
// strings, 41-63 partial values, "all", wildcards, commas, pipes and every
// other bulk selector.
export function isExactHash(value) {
	return typeof value === 'string' && /^(?:[a-f0-9]{36,40}|[a-f0-9]{64})$/.test(value);
}

function exactHash(value) {
	const hash = typeof value === 'string' ? value.trim().toLowerCase() : '';
	if (!isExactHash(hash)) throw new QbitError('invalid', 'That torrent reference is not a single exact hash.', 400);
	return hash;
}

const DOWNLOADING_STATES = Object.freeze(['downloading', 'forcedDL', 'stalledDL', 'metaDL', 'forcedMetaDL']);
const SEEDING_STATES = Object.freeze(['uploading', 'forcedUP', 'stalledUP']);
const QUEUED_STATES = Object.freeze(['queuedDL', 'queuedUP']);
const PAUSED_STATES = Object.freeze(['pausedDL', 'pausedUP', 'stoppedDL', 'stoppedUP']);
const CHECKING_STATES = Object.freeze(['checkingDL', 'checkingUP', 'checkingResumeData', 'queuedForChecking']);
const OTHER_ERROR_STATES = Object.freeze(['error', 'missingFiles']);

function stateBucket(state, progress) {
	if (DOWNLOADING_STATES.includes(state)) return 'downloading';
	if (SEEDING_STATES.includes(state)) return 'seeding';
	if (QUEUED_STATES.includes(state)) return 'queued';
	if (PAUSED_STATES.includes(state)) return 'paused';
	if (CHECKING_STATES.includes(state)) return 'checking';
	if (state === 'moving') return 'moving';
	if (state === 'allocating' || OTHER_ERROR_STATES.includes(state)) return 'other';
	// A future state code with a complete payload is still finished. Anything
	// else stays in "other" instead of pretending to be a download.
	return progress >= 1 ? 'seeding' : 'other';
}

function endpoint(base, route) {
	return new URL(String(base).replace(/\/+$/, '') + '/' + String(route).replace(/^\/+/, ''));
}

async function readLimited(response, limit) {
	if (!response?.body) return '';
	const reader = response.body.getReader();
	const chunks = [];
	let total = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > limit) throw new QbitError('too-large', NOTICES['too-large']);
			chunks.push(Buffer.from(value));
		}
	} finally {
		try { await reader.cancel(); } catch {}
		try { reader.releaseLock(); } catch {}
	}
	return Buffer.concat(chunks).toString('utf8');
}

async function fetchLimited(fetcher, url, options, timeoutMs) {
	try {
		return await fetcher(url, { ...options, redirect: 'error', signal: AbortSignal.timeout(Math.max(250, Number(timeoutMs) || DEFAULT_TIMEOUT_MS)) });
	} catch (error) {
		if (error?.name === 'TimeoutError' || error?.name === 'AbortError') throw new QbitError('timeout', NOTICES.timeout, 504);
		throw new QbitError('unreachable', NOTICES.unreachable, 502);
	}
}

function defaultConfig() {
	return { enabled: false, pollSeconds: 20, stalledMinutes: 30 };
}

function readConfig(file) {
	try {
		const saved = JSON.parse(readFileSync(file, 'utf8'));
		if (!saved || typeof saved !== 'object') return defaultConfig();
		let url = typeof saved.url === 'string' ? saved.url : '';
		if (url) { try { url = normalizeWebUiUrl(url); } catch { url = ''; } }
		return {
			url,
			username: typeof saved.username === 'string' ? saved.username : '',
			password: typeof saved.password === 'string' ? saved.password : '',
			enabled: saved.enabled === true,
			pollSeconds: clamp(saved.pollSeconds, 15, 30, 20),
			stalledMinutes: clamp(saved.stalledMinutes, 10, 180, 30)
		};
	} catch { return defaultConfig(); }
}

function saveConfig(file, value) {
	mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	writeFileSync(file + '.tmp', JSON.stringify(value), { mode: 0o600 });
	renameSync(file + '.tmp', file);
}

function ready(value) {
	return Boolean(value?.url && value?.username && value?.password);
}

// The installation settings page and the media process must agree on exactly
// one file and one shape. These helpers are the only supported way for the
// setup service to write that file, so a saved value is read back on the next
// call without a restart.
export function readQbittorrentConfig(file) {
	return readConfig(file);
}

export function qbittorrentSettings(file) {
	const current = readConfig(file);
	return {
		configured: ready(current),
		url: current.url,
		username: current.username,
		enabled: current.enabled === true,
		pollSeconds: current.pollSeconds,
		stalledMinutes: current.stalledMinutes
	};
}

// Merge a form submission over the saved values. An empty URL, username or
// password means "keep the saved value"; the password is never returned.
export function mergeQbittorrentConfig(current, body = {}) {
	if (!body || typeof body !== 'object' || Array.isArray(body)) {
		throw new QbitError('invalid-target', 'Enter the qBittorrent connection details.', 400);
	}
	const saved = current && typeof current === 'object' ? current : defaultConfig();
	let url = typeof saved.url === 'string' ? saved.url : '';
	if (typeof body.url === 'string' && body.url.trim()) url = normalizeWebUiUrl(body.url);
	else if (!url) throw new QbitError('invalid-target', 'Enter the qBittorrent WebUI address.', 400);
	let username = typeof saved.username === 'string' ? saved.username : '';
	if (typeof body.username === 'string' && body.username.trim()) {
		const value = body.username.trim();
		if (value.length > 200 || /[\r\n\u0000]/.test(value)) throw new QbitError('invalid-target', 'Enter a valid WebUI username.', 400);
		username = value;
	}
	let password = typeof saved.password === 'string' ? saved.password : '';
	if (typeof body.password === 'string' && body.password) {
		if (body.password.length > 1000 || /[\r\n\u0000]/.test(body.password)) throw new QbitError('invalid-target', 'Enter a valid WebUI password.', 400);
		password = body.password;
	}
	const enabled = body.enabled === undefined ? saved.enabled === true : body.enabled === true;
	const pollSeconds = body.pollSeconds === undefined
		? clamp(saved.pollSeconds, 15, 30, 20) : clamp(body.pollSeconds, 15, 30, 20);
	const stalledMinutes = body.stalledMinutes === undefined
		? clamp(saved.stalledMinutes, 10, 180, 30) : clamp(body.stalledMinutes, 10, 180, 30);
	if (!username || !password) throw new QbitError('unconfigured', 'Enter the qBittorrent WebUI username and password.', 400);
	return { url, username, password, enabled, pollSeconds, stalledMinutes };
}

export function saveQbittorrentConfig(file, body = {}) {
	const next = mergeQbittorrentConfig(readConfig(file), body);
	saveConfig(file, next);
	return qbittorrentSettings(file);
}

export function removeQbittorrentConfig(file) {
	try { unlinkSync(file); }
	catch (error) {
		if (error?.code !== 'ENOENT') {
			throw new QbitError('unreachable', 'The saved qBittorrent connection could not be removed.', 500);
		}
	}
	return qbittorrentSettings(file);
}

// The WebUI login answer differs across qBittorrent versions: 4.x replies
// 200 "Ok." and 5.x replies 204 with no body. Both set the SID cookie, and the
// cookie alone is the session, so a success signal without a usable cookie is
// not something this integration may continue with unauthenticated.
function sessionCookie(response) {
	const values = typeof response?.headers?.getSetCookie === 'function'
		? response.headers.getSetCookie() : [response?.headers?.get?.('set-cookie') || ''];
	for (const value of values) {
		const match = String(value || '').match(/^\s*([^=;,\s]+)=([^;,\s]*)/);
		if (match) return match[1] + '=' + match[2];
	}
	return '';
}

const LOGIN_UNREADABLE = 'qBittorrent answered the WebUI sign-in, but the answer could not be read as a session. Check that the address is the qBittorrent WebUI, then try again.';

// Classify a login answer. Only 'auth-failed' means qBittorrent rejected the
// credentials, and only 'banned' means it banned this address. Every answer
// this integration cannot turn into a session is 'unreadable', so a version or
// proxy difference is never misreported as a wrong password.
function readLoginAnswer(response, text) {
	const status = Number(response?.status) || 0;
	const body = String(text ?? '').trim();
	if (status === 403) return { outcome: 'banned', cookie: '' };
	if (status === 401) return { outcome: 'auth-failed', cookie: '' };
	if (status === 200 && /^Fails\.?$/i.test(body)) return { outcome: 'auth-failed', cookie: '' };
	const cookie = sessionCookie(response);
	if (!cookie) return { outcome: 'unreadable', cookie: '' };
	if (status === 204) return { outcome: 'ok', cookie };
	if (status === 200 && /^Ok\.?$/i.test(body)) return { outcome: 'ok', cookie };
	return { outcome: 'unreadable', cookie: '' };
}

// Explicit user-triggered connection check for installation settings. It
// returns a sanitized state and message only; the target, username, password
// and response body never leave this function.
export async function probeQbittorrent(target = {}, { fetcher = fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
	if (!ready(target)) {
		return { ok: false, state: 'unconfigured', message: 'Enter the WebUI address, username and password first.' };
	}
	let url;
	try { url = normalizeWebUiUrl(target.url); }
	catch {
		return { ok: false, state: 'invalid-target', message: 'Enter a complete http:// or https:// WebUI address without a username or password.' };
	}
	const body = new URLSearchParams({ username: target.username, password: target.password }).toString();
	let response;
	try {
		response = await fetchLimited(fetcher, endpoint(url, '/api/v2/auth/login'), {
			method: 'POST',
			headers: {
				accept: 'text/plain',
				referer: new URL(url).origin + '/',
				'content-type': 'application/x-www-form-urlencoded'
			},
			body
		}, timeoutMs);
	} catch (error) {
		if (error?.code === 'timeout') {
			return { ok: false, state: 'timeout', message: 'qBittorrent did not answer in time. Check the address and network, then try again.' };
		}
		return { ok: false, state: 'unreachable', message: 'qBittorrent could not be reached. Check the WebUI address and that it is reachable from this server.' };
	}
	let text = '';
	try { text = (await readLimited(response, MAX_LOGIN_BODY)).trim(); }
	catch { /* A login answer has no useful body beyond Ok. or Fails. */ }
	const answer = readLoginAnswer(response, text);
	if (answer.outcome === 'banned') {
		return { ok: false, state: 'banned', message: 'qBittorrent has temporarily banned this address after failed sign-ins. Wait, then try again.' };
	}
	if (answer.outcome === 'auth-failed') {
		return { ok: false, state: 'auth-failed', message: 'qBittorrent was reached, but it refused this WebUI sign-in. Check the username and password.' };
	}
	if (answer.outcome !== 'ok') {
		return { ok: false, state: 'invalid', message: LOGIN_UNREADABLE };
	}
	return { ok: true, state: 'ok', message: 'Connection accepted.' };
}

function sameText(a, b) {
	return typeof a === 'string' && typeof b === 'string' && a.length === b.length
		&& timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

function cookieToken(req) {
	return req?.get?.('cookie')?.match(/(?:^|;\s*)tellybox_setup=([a-f0-9]{64})(?:;|$)/)?.[1] || '';
}

export function createQbittorrent({ file, fetcher = fetch, clock = Date.now, timeoutMs = DEFAULT_TIMEOUT_MS, maxBody = MAX_BODY } = {}) {
	let generation = 1;
	// The installation settings service writes the same file while the media
	// process is running. Comparing the normalized config on each read makes
	// that an out-of-band change: caches, the SID and version data from the old
	// target are discarded before the next request. Internal saves update this
	// signature so they do not cause a second generation bump.
	let configSignature = JSON.stringify(readConfig(file));
	// Incremented when a configuration change starts or a disconnect occurs.
	// A confirmation records this alongside the generation so an in-flight
	// configuration request cannot be overtaken by a stale delete.
	let configureSeq = 0;
	let sidCookie = '';
	let sidGeneration = 0;
	let loginPromise = null;
	let reauthPromise = null;
	let loginFailures = 0;
	let loginBlockedUntil = 0;
	let webapiVersion = '';
	let applicationVersion = '';
	let lastResult = { state: 'idle', checkedAt: 0, upstreamAt: 0, notice: NOTICES.idle };
	const cache = new Map();
	const inflight = new Map();
	const backoff = new Map();
	const samples = new Map();
	let samplesPrunedAt = -Infinity;
	const tokens = new Map();
	const idMap = new Map();
	const idSecret = randomBytes(32);

	function config() {
		const current = readConfig(file);
		const signature = JSON.stringify(current);
		if (signature !== configSignature) {
			configSignature = signature;
			generation += 1;
			resetRuntime();
		}
		return current;
	}
	const configured = value => ready(value);

	// A snapshot is the exact target and configuration revision reviewed by the
	// owner. Destructive work must use the captured target, never config() again.
	function snapshot() {
		const current = config();
		return {
			generation,
			configureSeq,
			enabled: current.enabled === true,
			target: { url: current.url, username: current.username, password: current.password }
		};
	}

	function sameTarget(current, target) {
		return Boolean(target) && current.url === target.url
			&& current.username === target.username
			&& current.password === target.password;
	}

	// Synchronous fail-closed check. Call this after every await and immediately
	// before a destructive transmission. It also rejects a configuration request
	// that has started but not yet finished (configureSeq).
	function assertReviewed(entry) {
		if (generation !== entry.generation || configureSeq !== entry.configureSeq) {
			throw new QbitError('source-changed', NOTICES['source-changed'], 409);
		}
		const current = config();
		if (current.enabled !== true || !sameTarget(current, entry.target)) {
			throw new QbitError('source-changed', NOTICES['source-changed'], 409);
		}
	}

	function resetRuntime({ keepVersions = false } = {}) {
		cache.clear();
		inflight.clear();
		backoff.clear();
		samples.clear();
		samplesPrunedAt = -Infinity;
		// Tokens stay until their short expiry. Every token is checked against
		// this generation, so a source change makes it a clean 409, not a replay
		// that might be retried against the previous target.
		idMap.clear();
		sidCookie = '';
		sidGeneration = 0;
		loginPromise = null;
		loginFailures = 0;
		loginBlockedUntil = 0;
		if (!keepVersions) { webapiVersion = ''; applicationVersion = ''; }
		lastResult = { state: 'idle', checkedAt: 0, upstreamAt: 0, notice: NOTICES.idle };
	}

	function opaqueId(hash) {
		return createHmac('sha256', idSecret).update(hash).digest('hex').slice(0, 32);
	}

	function remember(item) {
		const id = opaqueId(item.hash);
		idMap.set(id, { hash: item.hash, at: clock() });
		while (idMap.size > 5000) idMap.delete(idMap.keys().next().value);
		return id;
	}

	// An unknown WebUI API version is treated as legacy. Defaulting to a very
	// new version would make filterFor() send 5.x filter names such as
	// "stopped" to a 4.x WebUI that only understands "paused"/"resumed".
	function versionTuple() {
		const match = String(webapiVersion || '').match(/^(\d+)\.(\d+)(?:\.(\d+))?/);
		return match ? [Number(match[1]), Number(match[2]), Number(match[3] || 0)] : [0, 0, 0];
	}

	function apiAtLeast(major, minor, patch = 0) {
		const [a, b, c] = versionTuple();
		return a > major || a === major && (b > minor || b === minor && c >= patch);
	}

	function filterFor(name) {
		const value = String(name || 'all').toLowerCase();
		const modern = apiAtLeast(2, 11, 0);
		const map = {
			all: 'all', downloading: 'downloading', completed: 'completed', seeding: 'seeding',
			stalled: 'stalled', stalled_downloading: 'stalled_downloading', stalled_uploading: 'stalled_uploading',
			paused: modern ? 'stopped' : 'paused', running: modern ? 'running' : 'resumed',
			errored: 'errored', checking: 'checking', moving: 'moving'
		};
		if (!Object.hasOwn(map, value)) throw new QbitError('invalid', 'Choose a supported download filter.', 400);
		return map[value];
	}

	// The read-only Activity surface accepts only the three filters the viewer
	// selector offers. It never forwards an arbitrary caller string upstream.
	function viewerFilter(value) {
		if (Array.isArray(value)) throw new QbitError('invalid-filter', NOTICES['invalid-filter'], 400);
		const chosen = value === undefined || value === null || value === ''
			? 'all' : String(value).trim().toLowerCase();
		if (!VIEWER_FILTERS.includes(chosen)) throw new QbitError('invalid-filter', NOTICES['invalid-filter'], 400);
		return chosen;
	}

	function emptyCounts() {
		return { downloading: 0, queued: 0, seeding: 0, paused: 0, checking: 0, moving: 0, attention: 0, other: 0 };
	}

	function normalizeCounts(value) {
		const counts = emptyCounts();
		if (!value || typeof value !== 'object') return counts;
		for (const key of COUNT_KEYS) {
			const number = Number(value[key]);
			counts[key] = Number.isFinite(number) && number >= 0 ? Math.floor(number) : 0;
		}
		return counts;
	}

	function normalizeLowerBounds(value) {
		const found = new Set(Array.isArray(value) ? value : []);
		return COUNT_KEYS.filter(key => found.has(key));
	}

	// One bounded filtered read. The extra row only detects that more rows exist;
	// it never becomes a full-catalogue scan.
	async function fetchInfoRows(filter, limit) {
		const params = new URLSearchParams({
			filter, sort: 'added_on', reverse: 'true', limit: String(limit + 1), offset: '0'
		});
		const raw = await authedJson('/api/v2/torrents/info?' + params.toString());
		if (!Array.isArray(raw)) throw new QbitError('invalid', NOTICES.invalid, 502);
		if (raw.length > MAX_ROWS + 1) throw new QbitError('too-large', NOTICES['too-large'], 502);
		return raw;
	}

	// The authoritative torrent count appeared in WebUI API 2.9.3, not 5.2.
	// Older WebUIs do not have it, so this is always best-effort and never
	// fails a reading.
	async function readTotalCount() {
		if (!webapiVersion || !apiAtLeast(2, 9, 3)) return null;
		try {
			const text = await authedText('/api/v2/torrents/count');
			const total = Number.parseInt(String(text).trim(), 10);
			return Number.isFinite(total) && total >= 0 ? total : null;
		} catch { return null; }
	}

	function buildCatalog(results, now, total) {
		const byHash = new Map();
		const byQuery = new Map();
		for (const result of results) {
			const items = [];
			for (const raw of result.raw.slice(0, COUNT_LIMIT)) {
				const item = mapTorrent(raw, now);
				if (!item) continue;
				items.push(item);
				if (!byHash.has(item.hash)) byHash.set(item.hash, item);
			}
			byQuery.set(result.key, { complete: result.complete, items });
		}
		const counts = emptyCounts();
		for (const item of byHash.values()) {
			const bucket = item.stateBucket;
			if (Object.hasOwn(counts, bucket) && bucket !== 'attention') counts[bucket] += 1;
			else counts.other += 1;
		}
		// "Needs attention" is measured from the downloading filter's rows, not
		// from whatever happened to be in one truncated all-sample.
		let attention = 0;
		for (const item of byQuery.get('downloading')?.items || []) {
			if (!item.attentionEligible) continue;
			if (sampleFor(item).needsAttention) attention += 1;
		}
		counts.attention = attention;
		const complete = key => byQuery.get(key)?.complete === true;
		const lower = new Set();
		if (!complete('downloading')) { lower.add('downloading'); lower.add('attention'); }
		if (!complete('seeding')) lower.add('seeding');
		if (!complete('downloading') || !complete('seeding')) lower.add('queued');
		if (!complete('paused')) lower.add('paused');
		if (!complete('checking')) lower.add('checking');
		if (!complete('moving')) lower.add('moving');
		if (!complete('errored')) lower.add('other');
		// With an authoritative total, "other" can be the residual of exact
		// buckets even when one filter query hit its cap.
		if (total !== null && ![...lower].some(bucket => bucket !== 'other')) {
			const known = counts.downloading + counts.queued + counts.seeding
				+ counts.paused + counts.checking + counts.moving;
			const residual = total - known;
			if (residual >= counts.other) { counts.other = residual; lower.delete('other'); }
		}
		const lowerBounds = COUNT_KEYS.filter(key => lower.has(key));
		return {
			counts,
			lowerBounds,
			sampleSize: byHash.size,
			// A complete set of filtered queries can still carry more deduplicated
			// rows than the viewer renders. In that case the page must be honest
			// that it is showing only the first VIEWER_ROW_LIMIT rows.
			hasMore: lowerBounds.length > 0 || byHash.size > VIEWER_ROW_LIMIT,
			rows: byHash,
			byFilter: {
				downloading: byQuery.get('downloading')?.items || [],
				seeding: byQuery.get('seeding')?.items || []
			},
			truncated: {
				downloading: !complete('downloading'),
				seeding: !complete('seeding')
			},
			total
		};
	}

	function catalogFailure(key, code, cached) {
		const failures = (backoff.get(key)?.failures || 0) + 1;
		const pollMs = config().pollSeconds * 1000;
		backoff.set(key, { until: clock() + Math.min(300000, pollMs * 2 ** Math.min(failures, 4)), failures });
		if (cached?.lastGood) return stalePayload(cached.lastGood, code);
		return {
			...errorPayload(code),
			counts: emptyCounts(), countsLowerBound: COUNT_KEYS.slice(), sampleSize: 0, hasMore: false, _catalog: null
		};
	}

	// One bounded filtered query per qBittorrent state group. Results are
	// deduplicated by hash and classified locally, so overlapping qBittorrent
	// filters (for example checking-download is also a downloading state) do
	// not inflate a bucket. Each query is capped independently; a bucket is
	// reported as a lower bound only when a query that can supply it hit the cap.
	async function catalogPayload() {
		const current = config();
		if (!configured(current)) {
			return {
				...unconfiguredPayload(current),
				counts: emptyCounts(), countsLowerBound: [], sampleSize: 0, hasMore: false, _catalog: null
			};
		}
		if (!current.enabled) {
			return {
				...disabledPayload(current),
				counts: emptyCounts(), countsLowerBound: [], sampleSize: 0, hasMore: false, _catalog: null
			};
		}
		const key = 'catalog';
		const now = clock();
		const cached = cache.get(key);
		if (cached && now - cached.at < current.pollSeconds * 1000) return { ...cached.value, cached: true };
		if (inflight.has(key)) return inflight.get(key);
		const blocked = backoff.get(key);
		if (blocked && now < blocked.until) {
			if (cached?.lastGood) return stalePayload(cached.lastGood, 'backoff');
			return {
				...errorPayload('backoff'),
				counts: emptyCounts(), countsLowerBound: COUNT_KEYS.slice(), sampleSize: 0, hasMore: false, _catalog: null
			};
		}
		try { await login(); }
		catch (error) { return catalogFailure(key, error?.code || 'auth-failed', cached); }
		// Concurrent callers share one login promise, so they can all arrive
		// here together. Recheck the cache and the in-flight read once more so a
		// burst produces one bounded set of queries, not one set per caller.
		const afterLogin = cache.get(key);
		if (afterLogin && clock() - afterLogin.at < current.pollSeconds * 1000) {
			return { ...afterLogin.value, cached: true };
		}
		if (inflight.has(key)) return inflight.get(key);
		const before = generation;
		const defs = [
			{ key: 'downloading', filter: 'downloading' },
			{ key: 'seeding', filter: 'seeding' },
			{ key: 'paused', filter: 'paused' },
			{ key: 'checking', filter: 'checking' },
			{ key: 'moving', filter: 'moving' },
			{ key: 'errored', filter: 'errored' }
		];
		const run = (async () => {
			try {
				const [settled, total] = await Promise.all([
					Promise.allSettled(defs.map(async def => {
						const raw = await fetchInfoRows(filterFor(def.filter), COUNT_LIMIT);
						return { key: def.key, raw, complete: raw.length <= COUNT_LIMIT };
					})),
					readTotalCount()
				]);
				const rejected = settled.find(result => result.status === 'rejected');
				if (rejected) throw rejected.reason;
				if (generation !== before) throw new QbitError('source-changed', NOTICES['source-changed'], 409);
				const readAt = clock();
				const built = buildCatalog(settled.map(result => result.value), readAt, total);
				const value = {
					configured: true, enabled: true, reachable: true, stale: false,
					state: 'ok', notice: NOTICES.ok, generation,
					checkedAt: readAt, upstreamAt: readAt,
					webapiVersion: webapiVersion || null, applicationVersion: applicationVersion || null,
					filters: { categories: [], applied: { filter: 'all', category: null } },
					page: {
						limit: COUNT_LIMIT, offset: 0, count: built.sampleSize, hasMore: built.hasMore,
						nextOffset: null, previousOffset: null
					},
					global: null, rows: [],
					counts: built.counts,
					countsLowerBound: built.lowerBounds,
					sampleSize: built.sampleSize,
					hasMore: built.hasMore,
					_catalog: built
				};
				cache.set(key, { at: readAt, value, lastGood: value });
				while (cache.size > 60) cache.delete(cache.keys().next().value);
				backoff.delete(key);
				lastResult = { state: 'ok', checkedAt: readAt, upstreamAt: readAt, notice: NOTICES.ok };
				return value;
			} catch (error) {
				if (error?.code === 'source-changed') {
					lastResult = { state: 'source-changed', checkedAt: clock(), upstreamAt: 0, notice: NOTICES['source-changed'] };
					throw error;
				}
				return catalogFailure(key, error?.code || 'unreachable', cached);
			}
		})();
		inflight.set(key, run);
		try { return await run; }
		finally { inflight.delete(key); }
	}

	// "Everything" is a real bounded filtered page. The default page never
	// reaches beyond the 200 rows the Activity panel renders.
	async function viewerAllRows() {
		const key = 'viewer-all';
		const current = config();
		const now = clock();
		const cached = cache.get(key);
		if (cached && now - cached.at < current.pollSeconds * 1000) return cached.value;
		if (inflight.has(key)) return inflight.get(key);
		const before = generation;
		const run = (async () => {
			const raw = await fetchInfoRows(filterFor('all'), VIEWER_ROW_LIMIT);
			if (generation !== before) throw new QbitError('source-changed', NOTICES['source-changed'], 409);
			const readAt = clock();
			// qBittorrent may repeat a hash across the boundary rows. Deduplicate
			// before applying the 200-row view limit, otherwise one duplicate is
			// enough to claim "more rows" while rendering exactly 200 unique rows.
			const byHash = new Map();
			for (const row of raw) {
				const item = mapTorrent(row, readAt);
				if (item && !byHash.has(item.hash)) byHash.set(item.hash, item);
			}
			const unique = [...byHash.values()];
			const items = unique.slice(0, VIEWER_ROW_LIMIT);
			const value = { items, hasMore: unique.length > VIEWER_ROW_LIMIT };
			cache.set(key, { at: readAt, value, lastGood: value });
			while (cache.size > 60) cache.delete(cache.keys().next().value);
			return value;
		})();
		inflight.set(key, run);
		try { return await run; }
		finally { inflight.delete(key); }
	}

	async function loginTarget(target) {
		if (!configured(target)) throw new QbitError('unconfigured', NOTICES.unconfigured, 409);
		// Cookie SID login is the documented baseline for the qBittorrent 4.1 to
		// 5.x WebUI. API keys are not assumed; the installed WebUI decides which
		// cookie name it returns and this module reuses it.
		const body = new URLSearchParams({ username: target.username, password: target.password }).toString();
		const response = await fetchLimited(fetcher, endpoint(target.url, '/api/v2/auth/login'), {
			method: 'POST',
			headers: {
				accept: 'text/plain',
				'referer': new URL(target.url).origin + '/',
				'content-type': 'application/x-www-form-urlencoded'
			},
			body
		}, timeoutMs);
		let text = '';
		try { text = (await readLimited(response, MAX_LOGIN_BODY)).trim(); }
		catch { /* A login answer has no useful body beyond Ok./Fails. */ }
		const answer = readLoginAnswer(response, text);
		if (answer.outcome === 'banned') throw new QbitError('banned', NOTICES.banned, 503);
		if (answer.outcome === 'auth-failed') throw new QbitError('auth-failed', NOTICES['auth-failed'], 503);
		if (answer.outcome !== 'ok') throw new QbitError('invalid', LOGIN_UNREADABLE, 502);
		// 4.x ("Ok.") and 5.x (204, empty body) both resolve to the captured
		// SID here, so every answered version continues with a real session.
		const cookie = answer.cookie;
		const api = await readVersion(target, cookie, '/api/v2/app/webapiVersion');
		const application = await readVersion(target, cookie, '/api/v2/app/version');
		return { cookie, webapiVersion: api, applicationVersion: application };
	}

	async function readVersion(target, cookie, route) {
		try {
			const response = await fetchLimited(fetcher, endpoint(target.url, route), {
				headers: { accept: 'text/plain', cookie, referer: new URL(target.url).origin + '/' }
			}, Math.min(timeoutMs, 4000));
			if (!response.ok) { try { await response.body?.cancel(); } catch {} return ''; }
			return (await readLimited(response, 128)).trim().replace(/[^0-9A-Za-z.+_-]/g, '').slice(0, 32);
		} catch { return ''; }
	}

	async function login(force = false) {
		if (sidCookie && !force && sidGeneration === generation) return;
		if (loginPromise) return loginPromise;
		if (clock() < loginBlockedUntil) throw new QbitError('auth-throttled', NOTICES['auth-throttled'], 503);
		const current = config();
		const loginGeneration = generation;
		if (!configured(current)) throw new QbitError('unconfigured', NOTICES.unconfigured, 409);
		const pending = (async () => {
			try {
				const result = await loginTarget(current);
				// A login that finishes after a newer configuration or disconnect
				// must not install its stale SID or version data.
				if (loginGeneration !== generation) throw new QbitError('source-changed', NOTICES['source-changed'], 409);
				sidCookie = result.cookie;
				sidGeneration = loginGeneration;
				webapiVersion = result.webapiVersion || '';
				applicationVersion = result.applicationVersion || '';
				loginFailures = 0;
			} catch (error) {
				if (loginGeneration !== generation) throw new QbitError('source-changed', NOTICES['source-changed'], 409);
				loginFailures += 1;
				if (loginFailures >= 3) loginBlockedUntil = clock() + 60000;
				sidCookie = '';
				sidGeneration = 0;
				throw error;
			}
		})();
		loginPromise = pending;
		try { await pending; }
		finally { if (loginPromise === pending) loginPromise = null; }
	}

	async function rawRequest(target, route, options = {}, cookie = sidCookie) {
		const headers = {
			accept: options.accept || 'application/json',
			referer: new URL(target.url).origin + '/',
			...(cookie ? { cookie } : {}),
			...(options.form ? { 'content-type': 'application/x-www-form-urlencoded' } : {})
		};
		return fetchLimited(fetcher, endpoint(target.url, route), {
			method: options.method || 'GET',
			headers,
			...(options.form ? { body: new URLSearchParams(options.form).toString() } : {})
		}, options.timeoutMs || timeoutMs);
	}

	// Establish (or reuse) a SID for the reviewed target only. A stale login
	// completion is discarded when the configuration revision changed.
	async function cookieFor(entry, { fresh = false } = {}) {
		assertReviewed(entry);
		if (!fresh && sidCookie && sidGeneration === entry.generation) return sidCookie;
		const result = await loginTarget(entry.target);
		assertReviewed(entry);
		sidCookie = result.cookie;
		sidGeneration = entry.generation;
		webapiVersion = result.webapiVersion || '';
		applicationVersion = result.applicationVersion || '';
		return sidCookie;
	}

	async function authedText(route, options = {}) {
		await login();
		const current = config();
		let response = await rawRequest(current, route, options);
		if ([401, 403].includes(response.status) && options.retryAuth !== false) {
			try { await response.body?.cancel(); } catch {}
			const reauthGeneration = generation;
			// Concurrent expired requests share one re-authentication. A burst
			// cannot turn into several logins and a qBittorrent address ban.
			if (!reauthPromise) {
				const pending = (async () => {
					if (reauthGeneration !== generation) throw new QbitError('source-changed', NOTICES['source-changed'], 409);
					sidCookie = '';
					sidGeneration = 0;
					await login(true);
				})().finally(() => { if (reauthPromise === pending) reauthPromise = null; });
				reauthPromise = pending;
			}
			await reauthPromise;
			// A configuration change during re-authentication invalidates this
			// read rather than retrying it against a different target.
			if (reauthGeneration !== generation) throw new QbitError('source-changed', NOTICES['source-changed'], 409);
			response = await rawRequest(config(), route, options);
		}
		if (!response.ok) {
			try { await response.body?.cancel(); } catch {}
			if (response.status === 401 || response.status === 403) throw new QbitError('auth-failed', NOTICES['auth-failed'], 503);
			if (response.status === 404) throw new QbitError('not-found', NOTICES['not-found'], 404);
			throw new QbitError('unreachable', NOTICES.unreachable, 502);
		}
		return readLimited(response, maxBody);
	}

	async function authedJson(route, options = {}) {
		const text = await authedText(route, options);
		try { return JSON.parse(text); }
		catch { throw new QbitError('invalid', NOTICES.invalid, 502); }
	}

	async function categories() {
		try {
			const data = await authedJson('/api/v2/torrents/categories');
			if (!data || typeof data !== 'object' || Array.isArray(data)) return [];
			return Object.keys(data).filter(name => typeof name === 'string' && name.length <= 100)
				.sort((a, b) => a.localeCompare(b)).slice(0, 200);
		} catch { return []; }
	}

	async function globalTransfer() {
		try {
			const data = await authedJson('/api/v2/transfer/info');
			if (!data || typeof data !== 'object') return null;
			const connection = ['connected', 'firewalled', 'disconnected'].includes(data.connection_status) ? data.connection_status : null;
			return {
				downloadSpeed: Math.max(0, Number(data.dl_info_speed) || 0),
				uploadSpeed: Math.max(0, Number(data.up_info_speed) || 0),
				connection
			};
		} catch { return null; }
	}

	function mapTorrent(raw, now) {
		const hash = String(raw?.hash || '').trim().toLowerCase();
		if (!isExactHash(hash)) return null;
		const state = oneLine(raw.state || 'unknown', 40) || 'unknown';
		const progress = Math.min(1, Math.max(0, Number(raw.progress) || 0));
		const completedBytes = Math.max(0, Number(raw.completed) || 0);
		const dlspeed = Math.max(0, Number(raw.dlspeed) || 0);
		const eta = Number(raw.eta);
		// A completed torrent has no transfer ETA, and a zero-speed torrent has
		// no meaningful estimate. qBittorrent's infinity marker must never be
		// rendered as a real duration.
		const etaUsable = progress < 1 && dlspeed > 0
			&& Number.isFinite(eta) && eta >= 0 && eta < 8640000;
		const seeds = Number(raw.num_seeds);
		const seedsTotal = Number(raw.num_complete);
		const peers = Number(raw.num_leechs);
		const peersTotal = Number(raw.num_incomplete);
		const lastActivity = Number(raw.last_activity);
		const ratio = Number(raw.ratio);
		const bucket = stateBucket(state, progress);
		const seeding = bucket === 'seeding';
		const paused = bucket === 'paused';
		const queued = bucket === 'queued';
		const checking = bucket === 'checking';
		const moving = bucket === 'moving';
		const activeDownload = ['downloading', 'forcedDL', 'stalledDL'].includes(state);
		return {
			hash,
			name: safeName(raw.name) || 'Unnamed torrent',
			state,
			stateLabel: STATE_LABELS[state] || 'Unknown',
			stateBucket: bucket,
			progress,
			completedBytes,
			dlspeed,
			upspeed: Math.max(0, Number(raw.upspeed) || 0),
			eta: etaUsable ? Math.floor(eta) : null,
			size: Math.max(0, Number(raw.size) || 0),
			totalSize: Math.max(0, Number(raw.total_size) || 0),
			category: oneLine(raw.category, 100),
			seeds: Number.isFinite(seeds) ? Math.max(0, Math.floor(seeds)) : null,
			seedsTotal: Number.isFinite(seedsTotal) ? Math.max(0, Math.floor(seedsTotal)) : null,
			peers: Number.isFinite(peers) ? Math.max(0, Math.floor(peers)) : null,
			peersTotal: Number.isFinite(peersTotal) ? Math.max(0, Math.floor(peersTotal)) : null,
			ratio: Number.isFinite(ratio) && ratio >= 0 ? ratio : null,
			addedOn: Number(raw.added_on) > 0 ? Number(raw.added_on) * 1000 : null,
			lastActivityAt: lastActivity > 0 ? lastActivity * 1000 : null,
			completed: progress >= 1 || seeding,
			paused,
			queued,
			checking,
			moving,
			seeding,
			stalledHint: state === 'stalledDL' || state === 'stalledUP',
			// Metadata is not proof of a stall, and neither is zero seeders.
			attentionEligible: activeDownload && state !== 'metaDL' && progress < 1,
			now
		};
	}

	// Drop samples for torrents that have not appeared in a reading for longer
	// than the measurement window, then enforce the cap. Pruning is amortised:
	// it runs at most once a minute unless the cap is reached, so a large
	// catalogue does not walk the whole map for every row.
	function pruneSamples(now) {
		samplesPrunedAt = now;
		for (const [hash, sample] of samples) {
			if (now - sample.lastSeen > SAMPLE_TTL_MS) samples.delete(hash);
		}
		while (samples.size > SAMPLE_LIMIT) samples.delete(samples.keys().next().value);
	}

	function sampleFor(item) {
		const now = item.now;
		if (samples.size >= SAMPLE_LIMIT || now - samplesPrunedAt >= SAMPLE_PRUNE_MS) pruneSamples(now);
		let sample = samples.get(item.hash);
		if (!sample) sample = { firstSeen: now, lastProgressAt: now, completedBytes: item.completedBytes, lastSeen: now };
		else {
			if (item.completedBytes > sample.completedBytes + 0.5 || item.completedBytes < sample.completedBytes - 0.5) sample.lastProgressAt = now;
			sample.completedBytes = item.completedBytes;
			sample.lastSeen = now;
		}
		samples.set(item.hash, sample);
		const noProgressSeconds = Math.max(0, Math.floor((now - sample.lastProgressAt) / 1000));
		return {
			needsAttention: item.attentionEligible && noProgressSeconds >= config().stalledMinutes * 60,
			noProgressSeconds,
			lastProgressAt: sample.lastProgressAt
		};
	}

	function publicRow(item) {
		const sample = sampleFor(item);
		return {
			id: remember(item),
			displayHash: item.hash.slice(0, 8),
			name: item.name,
			state: item.state,
			stateLabel: item.stateLabel,
			stateBucket: item.stateBucket,
			progress: Math.round(item.progress * 10000) / 10000,
			dlspeed: item.dlspeed,
			upspeed: item.upspeed,
			eta: item.eta,
			size: item.size,
			totalSize: item.totalSize,
			category: item.category,
			seeds: item.seeds,
			seedsTotal: item.seedsTotal,
			peers: item.peers,
			peersTotal: item.peersTotal,
			ratio: item.ratio,
			completed: item.completed,
			paused: item.paused,
			queued: item.queued,
			checking: item.checking,
			moving: item.moving,
			seeding: item.seeding,
			stalledHint: item.stalledHint,
			needsAttention: sample.needsAttention,
			measuredNoProgressSeconds: sample.noProgressSeconds,
			lastProgressAt: sample.lastProgressAt,
			addedOn: item.addedOn,
			lastActivityAt: item.lastActivityAt,
			note: item.completed ? 'Download complete in qBittorrent. That does not prove the file was imported or is playable in Tellybox.' : null
		};
	}

	function unconfiguredPayload(current) {
		return {
			configured: false, enabled: current.enabled, reachable: false, stale: false,
			state: 'unconfigured', notice: NOTICES.unconfigured, generation,
			checkedAt: 0, upstreamAt: 0, webapiVersion: webapiVersion || null, applicationVersion: applicationVersion || null,
			filters: { categories: [], applied: { filter: 'all', category: null } },
			page: { limit: 50, offset: 0, count: 0, hasMore: false, nextOffset: null, previousOffset: null },
			global: null, rows: [], summary: { rows: 0, attention: 0, downloading: 0 }
		};
	}

	function disabledPayload(current) {
		return {
			configured: configured(current), enabled: false, reachable: false, stale: false,
			state: 'disabled', notice: NOTICES.disabled, generation,
			checkedAt: 0, upstreamAt: 0, webapiVersion: webapiVersion || null, applicationVersion: applicationVersion || null,
			filters: { categories: [], applied: { filter: 'all', category: null } },
			page: { limit: 50, offset: 0, count: 0, hasMore: false, nextOffset: null, previousOffset: null },
			global: null, rows: [], summary: { rows: 0, attention: 0, downloading: 0 }
		};
	}

	function errorPayload(code, extra = {}) {
		const notice = NOTICES[code] || NOTICES.unreachable;
		lastResult = { state: code, checkedAt: clock(), upstreamAt: 0, notice };
		return {
			configured: true, enabled: true, reachable: false, stale: false,
			state: code, notice, generation,
			checkedAt: lastResult.checkedAt, upstreamAt: 0,
			webapiVersion: webapiVersion || null, applicationVersion: applicationVersion || null,
			filters: { categories: [], applied: extra.applied || { filter: 'all', category: null } },
			page: extra.page || { limit: 50, offset: 0, count: 0, hasMore: false, nextOffset: null, previousOffset: null },
			global: null, rows: [], summary: { rows: 0, attention: 0, downloading: 0 }
		};
	}

	function stalePayload(lastGood, code, extra = {}) {
		lastResult = { state: 'stale', checkedAt: clock(), upstreamAt: lastGood.upstreamAt, notice: NOTICES.stale + ' ' + (NOTICES[code] || '') };
		return {
			...lastGood,
			state: 'stale', reachable: false, stale: true, cached: true,
			notice: lastResult.notice,
			checkedAt: lastResult.checkedAt,
			generation,
			errorState: code,
			filters: { ...lastGood.filters, applied: extra.applied || lastGood.filters.applied }
		};
	}

	function markFailure(key, code, cached, applied) {
		const failures = (backoff.get(key)?.failures || 0) + 1;
		const pollMs = config().pollSeconds * 1000;
		backoff.set(key, { until: clock() + Math.min(300000, pollMs * 2 ** Math.min(failures, 4)), failures });
		if (cached?.lastGood) return stalePayload(cached.lastGood, code, { applied });
		return errorPayload(code, { applied });
	}

	async function list(options = {}) {
		const current = config();
		if (!configured(current)) return unconfiguredPayload(current);
		if (!current.enabled) return disabledPayload(current);
		const limit = clamp(options.limit, 1, 200, 50);
		const offset = clamp(options.offset, 0, 1000000, 0);
		const category = options.category === undefined || options.category === null ? null : oneLine(options.category, 100);
		const requested = String(options.filter || 'all').toLowerCase();
		const applied = { filter: options.filter || 'all', category };
		const key = [requested, category === null ? '\u0000' : category, limit, offset].join('|');
		const now = clock();
		const cached = cache.get(key);
		if (cached && now - cached.at < current.pollSeconds * 1000) return { ...cached.value, cached: true };
		if (inflight.has(key)) return inflight.get(key);
		const blocked = backoff.get(key);
		if (blocked && now < blocked.until) {
			if (cached?.lastGood) return stalePayload(cached.lastGood, 'backoff', { applied });
			return errorPayload('backoff', { applied });
		}
		try {
			// Detect the WebUI API version before choosing 4.1 or 5.x filter
			// names. With an existing SID this is a local no-op.
			await login();
		} catch (error) {
			return markFailure(key, error?.code || 'auth-failed', cached, applied);
		}
		// Concurrent callers share the login promise. Recheck so they also
		// share the one bounded upstream read instead of each starting one.
		const afterLogin = cache.get(key);
		if (afterLogin && clock() - afterLogin.at < current.pollSeconds * 1000) return { ...afterLogin.value, cached: true };
		if (inflight.has(key)) return inflight.get(key);
		const filter = filterFor(options.filter);
		const before = generation;
		const run = (async () => {
			try {
				const params = new URLSearchParams({ filter, sort: 'added_on', reverse: 'true', limit: String(limit + 1), offset: String(offset) });
				if (category !== null) params.set('category', category);
				const [infoResult, categoryResult, transferResult] = await Promise.allSettled([
					authedJson('/api/v2/torrents/info?' + params.toString()),
					categories(),
					globalTransfer()
				]);
				if (infoResult.status === 'rejected') throw infoResult.reason;
				if (generation !== before) throw new QbitError('source-changed', NOTICES['source-changed'], 409);
				const rawRows = infoResult.value;
				if (!Array.isArray(rawRows)) throw new QbitError('invalid', NOTICES.invalid, 502);
				if (rawRows.length > MAX_ROWS + 1) throw new QbitError('too-large', NOTICES['too-large'], 502);
				const readAt = clock();
				const mapped = rawRows.map(raw => mapTorrent(raw, readAt)).filter(Boolean);
				const hasMore = mapped.length > limit;
				const rows = mapped.slice(0, limit).map(publicRow);
				const value = {
					configured: true, enabled: true, reachable: true, stale: false,
					state: 'ok', notice: NOTICES.ok, generation,
					checkedAt: readAt, upstreamAt: readAt,
					webapiVersion: webapiVersion || null, applicationVersion: applicationVersion || null,
					filters: {
						categories: categoryResult.status === 'fulfilled' ? categoryResult.value : [],
						applied
					},
					page: {
						limit, offset, count: rows.length, hasMore,
						nextOffset: hasMore ? offset + rows.length : null,
						previousOffset: offset > 0 ? Math.max(0, offset - limit) : null
					},
					global: transferResult.status === 'fulfilled' ? transferResult.value : null,
					rows,
					summary: {
						rows: rows.length,
						attention: rows.filter(row => row.needsAttention).length,
						downloading: rows.filter(row => row.stateBucket === 'downloading').length
					}
				};
				cache.set(key, { at: readAt, value, lastGood: value });
				while (cache.size > 60) cache.delete(cache.keys().next().value);
				backoff.delete(key);
				lastResult = { state: 'ok', checkedAt: readAt, upstreamAt: readAt, notice: NOTICES.ok };
				return value;
			} catch (error) {
				if (error?.code === 'source-changed') { lastResult = { state: 'source-changed', checkedAt: clock(), upstreamAt: 0, notice: NOTICES['source-changed'] }; throw error; }
				return markFailure(key, error?.code || 'unreachable', cached, applied);
			}
		})();
		inflight.set(key, run);
		try { return await run; }
		finally { inflight.delete(key); }
	}

	function status() {
		const current = config();
		const ready = configured(current);
		let state = 'unconfigured';
		if (ready) state = current.enabled ? (lastResult.state || 'idle') : 'disabled';
		return {
			configured: ready,
			enabled: current.enabled === true,
			state,
			notice: ready && !current.enabled ? NOTICES.disabled : (lastResult.notice || NOTICES.idle),
			webapiVersion: webapiVersion || null,
			applicationVersion: applicationVersion || null,
			pollSeconds: current.pollSeconds,
			stalledMinutes: current.stalledMinutes,
			lastCheckedAt: lastResult.checkedAt || null,
			upstreamAt: lastResult.upstreamAt || null,
			generation
		};
	}

	// Bounded, sanitized statistics for the trusted local/home read-only panel.
	// Counts come from independent filtered qBittorrent queries and are never
	// derived from one truncated all-sample. It deliberately carries no names,
	// hashes, categories, save paths, addresses or configuration values.
	async function summary() {
		const data = await catalogPayload();
		const counts = normalizeCounts(data?.counts);
		const countsLowerBound = normalizeLowerBounds(data?.countsLowerBound);
		let transfer = null;
		if (data?.state === 'ok' || data?.stale === true) {
			const global = await globalTransfer();
			if (global && typeof global === 'object') {
				const downloadSpeed = Number(global.downloadSpeed);
				const uploadSpeed = Number(global.uploadSpeed);
				if (Number.isFinite(downloadSpeed) && downloadSpeed >= 0
					&& Number.isFinite(uploadSpeed) && uploadSpeed >= 0) {
					transfer = {
						downloadSpeed, uploadSpeed,
						connection: ['connected', 'firewalled', 'disconnected'].includes(global.connection) ? global.connection : null
					};
				}
			}
		}
		const checked = Number(data?.checkedAt);
		const sampleSize = Number(data?.sampleSize);
		return {
			readOnly: true,
			generatedAt: clock(),
			configured: data?.configured === true,
			enabled: data?.enabled === true,
			state: SUMMARY_STATES.includes(data?.state) ? data.state : 'unknown',
			reachable: data?.reachable === true,
			stale: data?.stale === true,
			checkedAt: Number.isFinite(checked) && checked > 0 ? checked : null,
			sampleSize: Number.isFinite(sampleSize) && sampleSize > 0 ? Math.floor(sampleSize) : 0,
			hasMore: data?.hasMore === true,
			counts,
			countsLowerBound,
			transfer
		};
	}

	function readOnlyRow(row) {
		const eta = row?.eta === null || row?.eta === undefined ? null : Number(row.eta);
		const ratio = row?.ratio === null || row?.ratio === undefined ? null : Number(row.ratio);
		return {
			name: row.name,
			state: Object.hasOwn(STATE_LABELS, row.state) ? row.state : 'unknown',
			stateLabel: Object.hasOwn(STATE_LABELS, row.state) ? STATE_LABELS[row.state] : 'Unknown',
			progress: Math.round((Number(row.progress) || 0) * 10000) / 10000,
			size: Math.max(0, Number(row.size) || 0),
			dlspeed: Math.max(0, Number(row.dlspeed) || 0),
			upspeed: Math.max(0, Number(row.upspeed) || 0),
			eta: Number.isFinite(eta) && eta >= 0 ? Math.floor(eta) : null,
			ratio: Number.isFinite(ratio) && ratio >= 0 ? ratio : null
		};
	}

	// The Activity downloads panel is a read-only view for trusted local/home
	// viewers and installation administrators. The selected filter is requested
	// from qBittorrent itself, so the 200-row view limit applies after filtering
	// and an active download can never be hidden behind a large seed queue. Each
	// row is rebuilt from an explicit allowlist so hashes, magnets, trackers,
	// save paths, categories, the WebUI address, credentials and raw payload
	// fields cannot pass through.
	async function readOnlyDownloads(options = {}) {
		const chosen = viewerFilter(options?.filter);
		const data = await catalogPayload();
		const counts = normalizeCounts(data?.counts);
		const countsLowerBound = normalizeLowerBounds(data?.countsLowerBound);
		const catalog = data?._catalog || null;
		let items = [];
		let hasMore = false;
		if ((data?.state === 'ok' || data?.state === 'stale') && catalog) {
			if (chosen === 'all') {
				try {
					const page = await viewerAllRows();
					items = page.items;
					hasMore = page.hasMore;
				} catch (error) {
					if (error?.code === 'source-changed') throw error;
					// Keep the bounded filtered rows already read for the counts
					// rather than showing an empty queue after one page failure.
					items = [...catalog.rows.values()];
					hasMore = catalog.hasMore;
				}
			} else {
				items = catalog.byFilter[chosen] || [];
				hasMore = catalog.truncated[chosen] === true || items.length > VIEWER_ROW_LIMIT;
			}
		}
		const rows = items.slice(0, VIEWER_ROW_LIMIT).map(publicRow).map(readOnlyRow);
		const checked = Number(data?.checkedAt);
		return {
			readOnly: true,
			generatedAt: clock(),
			configured: data?.configured === true,
			enabled: data?.enabled === true,
			state: SUMMARY_STATES.includes(data?.state) ? data.state : 'unknown',
			reachable: data?.reachable === true,
			stale: data?.stale === true,
			checkedAt: Number.isFinite(checked) && checked > 0 ? checked : null,
			filter: chosen,
			sampleSize: rows.length,
			hasMore,
			counts,
			countsLowerBound,
			rows
		};
	}

	async function revalidateOwner(verifyOwner) {
		if (typeof verifyOwner !== 'function') return;
		let allowed = false;
		try { allowed = await verifyOwner(); } catch { allowed = false; }
		if (!allowed) throw new QbitError('owner-required', NOTICES['owner-required'], 401);
	}

	async function configure(body = {}, { verifyOwner } = {}) {
		if (!body || typeof body !== 'object' || Array.isArray(body)) throw new QbitError('invalid-target', 'Enter the qBittorrent connection details.', 400);
		const current = config();
		let url = current.url;
		if (typeof body.url === 'string' && body.url.trim()) url = normalizeWebUiUrl(body.url);
		else if (!url) throw new QbitError('invalid-target', 'Enter the qBittorrent WebUI address.', 400);
		let username = current.username;
		if (typeof body.username === 'string' && body.username.trim()) {
			const value = body.username.trim();
			if (value.length > 200 || /[\r\n\u0000]/.test(value)) throw new QbitError('invalid-target', 'Enter a valid WebUI username.', 400);
			username = value;
		}
		let password = current.password;
		if (typeof body.password === 'string' && body.password) {
			if (body.password.length > 1000 || /[\r\n\u0000]/.test(body.password)) throw new QbitError('invalid-target', 'Enter a valid WebUI password.', 400);
			password = body.password;
		}
		const enabled = body.enabled === undefined ? Boolean(current.enabled) : body.enabled === true;
		const pollSeconds = body.pollSeconds === undefined ? current.pollSeconds : clamp(body.pollSeconds, 15, 30, current.pollSeconds);
		const stalledMinutes = body.stalledMinutes === undefined ? current.stalledMinutes : clamp(body.stalledMinutes, 10, 180, current.stalledMinutes);
		if (!username || !password) throw new QbitError('unconfigured', 'Enter the qBittorrent WebUI username and password.', 400);
		const next = { url, username, password, enabled, pollSeconds, stalledMinutes };
		const seq = ++configureSeq;
		let tested = null;
		if (enabled) {
			if (clock() < loginBlockedUntil) throw new QbitError('auth-throttled', NOTICES['auth-throttled'], 503);
			try {
				tested = await loginTarget(next);
			} catch (error) {
				// A newer request already owns the configuration; do not let this
				// older failure update shared throttle state.
				if (seq !== configureSeq) throw new QbitError('source-changed', NOTICES['source-changed'], 409);
				loginFailures += 1;
				if (loginFailures >= 3) loginBlockedUntil = clock() + 60000;
				throw error;
			}
		}
		// An older configure/login must never persist over a newer request or a
		// disconnect that started while it was awaiting the upstream login.
		if (seq !== configureSeq) throw new QbitError('source-changed', NOTICES['source-changed'], 409);
		await revalidateOwner(verifyOwner);
		if (seq !== configureSeq) throw new QbitError('source-changed', NOTICES['source-changed'], 409);
		saveConfig(file, next);
		configSignature = JSON.stringify(next);
		generation += 1;
		resetRuntime({ keepVersions: false });
		if (tested) {
			sidCookie = tested.cookie;
			sidGeneration = generation;
			webapiVersion = tested.webapiVersion || '';
			applicationVersion = tested.applicationVersion || '';
			loginFailures = 0;
		}
		return status();
	}

	function disconnect() {
		// Starting a disconnect invalidates any configure or commit that is still
		// awaiting upstream work.
		configureSeq += 1;
		try { unlinkSync(file); } catch {}
		configSignature = JSON.stringify(readConfig(file));
		generation += 1;
		resetRuntime();
		return status();
	}

	async function findByHash(hash, entry = null) {
		let rows;
		if (entry) {
			// Pin every read to the reviewed target. authedText() would reread
			// config() and could follow a changed target.
			const cookie = await cookieFor(entry);
			assertReviewed(entry);
			const response = await rawRequest(entry.target, '/api/v2/torrents/info?hashes=' + encodeURIComponent(hash), {}, cookie);
			if (!response.ok) {
				try { await response.body?.cancel(); } catch {}
				if (response.status === 401 || response.status === 403) throw new QbitError('auth-failed', NOTICES['auth-failed'], 503);
				if (response.status === 404) throw new QbitError('not-found', NOTICES['not-found'], 404);
				throw new QbitError('unreachable', NOTICES.unreachable, 502);
			}
			const text = await readLimited(response, maxBody);
			try { rows = JSON.parse(text); }
			catch { throw new QbitError('invalid', NOTICES.invalid, 502); }
			assertReviewed(entry);
		} else {
			rows = await authedJson('/api/v2/torrents/info?hashes=' + encodeURIComponent(hash));
		}
		if (!Array.isArray(rows)) throw new QbitError('invalid', NOTICES.invalid, 502);
		const raw = rows.find(row => String(row?.hash || '').toLowerCase() === hash);
		if (!raw) return null;
		return mapTorrent(raw, clock());
	}

	function fingerprint(item) {
		return [item.hash, item.addedOn || 0, item.size || 0, item.totalSize || 0, item.stateBucket].join('|');
	}

	function pruneTokens() {
		const now = clock();
		for (const [token, entry] of tokens) if (entry.expiresAt <= now) tokens.delete(token);
		while (tokens.size > 50) tokens.delete(tokens.keys().next().value);
	}

	function refused(entry, outcome, message, status = 409) {
		return {
			ok: false, outcome, status, deleteFiles: entry.deleteFiles,
			message, needsRecheck: true
		};
	}

	async function confirmation({ id, action, sessionToken, verifyOwner } = {}) {
		// Capture the exact generation, in-flight configure sequence and target
		// BEFORE the awaited lookup. The token is bound to this snapshot.
		const reviewed = snapshot();
		if (!configured(reviewed.target)) throw new QbitError('unconfigured', NOTICES.unconfigured, 409);
		if (!reviewed.enabled) throw new QbitError('disabled', NOTICES.disabled, 409);
		const deleteFiles = action === 'remove' ? false : action === 'delete-files' ? true : null;
		if (deleteFiles === null) throw new QbitError('invalid', 'Choose either remove or delete files.', 400);
		if (typeof id !== 'string' || !/^[a-f0-9]{32}$/.test(id)) throw new QbitError('not-found', NOTICES['not-found'], 404);
		const known = idMap.get(id);
		if (!known) throw new QbitError('not-found', NOTICES['not-found'], 404);
		const item = await findByHash(known.hash, reviewed);
		// Do not hand out a fresh one-use token after the owner session ended or
		// the configuration changed while the lookup was in flight.
		await revalidateOwner(verifyOwner);
		assertReviewed(reviewed);
		if (!item) throw new QbitError('not-found', NOTICES['not-found'], 404);
		pruneTokens();
		const token = randomBytes(32).toString('hex');
		const expiresAt = clock() + TOKEN_MS;
		tokens.set(token, {
			hash: item.hash, action, deleteFiles,
			session: sessionToken ? createHash('sha256').update(String(sessionToken)).digest('hex') : '',
			generation: reviewed.generation, configureSeq: reviewed.configureSeq,
			target: reviewed.target, fingerprint: fingerprint(item), expiresAt
		});
		return {
			token, action, deleteFiles, expiresAt, generation: reviewed.generation,
			item: publicRow(item)
		};
	}

	async function commit({ token, sessionToken, verifyOwner } = {}) {
		if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) throw new QbitError('replay', NOTICES.replay, 409);
		const entry = tokens.get(token);
		if (!entry) throw new QbitError('replay', NOTICES.replay, 409);
		// Consume before any work, so a timeout, replay or change can never turn
		// into a second destructive request.
		tokens.delete(token);
		if (clock() > entry.expiresAt) throw new QbitError('replay', NOTICES.replay, 409);
		const session = sessionToken ? createHash('sha256').update(String(sessionToken)).digest('hex') : '';
		if (!entry.session || !session || !sameText(entry.session, session)) throw new QbitError('replay', NOTICES.replay, 409);
		// Synchronous pre-check. Anything that changed before this point is a
		// plain 409 and no upstream work is started.
		if (entry.generation !== generation || entry.configureSeq !== configureSeq) {
			throw new QbitError('source-changed', NOTICES['source-changed'], 409);
		}
		exactHash(entry.hash);
		let current;
		try {
			current = await findByHash(entry.hash, entry);
		} catch (error) {
			if (error?.code === 'source-changed') return refused(entry, 'source-changed', NOTICES['source-changed']);
			throw error;
		}
		// A confirmation can expire while its commit is awaiting the lookup.
		if (clock() > entry.expiresAt) throw new QbitError('replay', NOTICES.replay, 409);
		if (!current) return refused(entry, 'not-found', NOTICES['not-found']);
		if (fingerprint(current) !== entry.fingerprint) throw new QbitError('changed', NOTICES.changed, 409);
		// Revalidate the live owner before doing any further upstream work, then
		// recheck the captured revision after that awaited check.
		await revalidateOwner(verifyOwner);
		try { assertReviewed(entry); }
		catch (error) {
			if (error?.code === 'source-changed') return refused(entry, 'source-changed', NOTICES['source-changed']);
			throw error;
		}
		let cookie;
		try {
			// A destructive request uses a fresh login for the captured target,
			// never a global SID that may belong to a different revision.
			cookie = await cookieFor(entry, { fresh: true });
		} catch (error) {
			if (error?.code === 'source-changed') return refused(entry, 'source-changed', NOTICES['source-changed']);
			throw error;
		}
		// Owner and revision can both change during the awaited login. These are
		// the final asynchronous checks before transmission.
		await revalidateOwner(verifyOwner);
		try { assertReviewed(entry); }
		catch (error) {
			if (error?.code === 'source-changed') return refused(entry, 'source-changed', NOTICES['source-changed']);
			throw error;
		}
		if (clock() > entry.expiresAt) throw new QbitError('replay', NOTICES.replay, 409);
		let response;
		try {
			// The only destructive request. It goes to entry.target, not config().
			// There is deliberately no automatic re-authentication retry.
			response = await rawRequest(entry.target, '/api/v2/torrents/delete', {
				method: 'POST',
				form: { hashes: entry.hash, deleteFiles: entry.deleteFiles ? 'true' : 'false' }
			}, cookie);
		} catch (error) {
			if (error?.code === 'source-changed') return refused(entry, 'source-changed', NOTICES['source-changed']);
			if (error?.code === 'timeout' || error?.code === 'unreachable') return {
				ok: false, outcome: 'unknown', status: 502, deleteFiles: entry.deleteFiles,
				message: 'The delete request may have reached qBittorrent, but no answer arrived. Check qBittorrent before trying again. Tellybox will not repeat this request automatically.',
				needsRecheck: true
			};
			throw error;
		}
		if (!response.ok) {
			try { await response.body?.cancel(); } catch {}
			if (response.status === 401 || response.status === 403) throw new QbitError('auth-failed', NOTICES['auth-failed'], 503);
			if (response.status === 404) throw new QbitError('not-found', NOTICES['not-found'], 404);
			throw new QbitError('unreachable', NOTICES.unreachable, 502);
		}
		try { await readLimited(response, maxBody); } catch {}
		let verification = 'unknown';
		try {
			const after = await findByHash(entry.hash, entry);
			verification = after ? 'still-listed' : 'removed';
		} catch { verification = 'unknown'; }
		return {
			ok: true,
			outcome: verification === 'removed' ? 'removed' : verification === 'still-listed' ? 'submitted' : 'unknown',
			removed: verification === 'removed',
			deleteFiles: entry.deleteFiles,
			files: entry.deleteFiles ? 'delete-requested' : 'kept',
			needsRecheck: verification !== 'removed',
			verifiedAt: clock(),
			message: entry.deleteFiles
				? 'qBittorrent accepted the request to remove the torrent and delete its downloaded files. File deletion cannot be undone and may affect shared or hardlinked library files. Check qBittorrent and the filesystem before assuming the files are gone.'
				: 'qBittorrent accepted the request to remove the torrent. Downloaded files were kept.'
		};
	}

	return { list, status, summary, readOnlyDownloads, configure, disconnect, confirmation, commit, filterFor, generation: () => generation };
}

export function installQbittorrentRoutes(app, { requireOwner, directory, sameOrigin, allowSummary, allowDownloads } = {}) {
	const qb = createQbittorrent({ file: path.join(directory, 'qbittorrent.json') });
	const fail = (res, error) => {
		if (res.headersSent) return;
		const status = Number(error?.status);
		res.status(Number.isInteger(status) && status >= 400 && status < 600 ? status : 502)
			.json({ error: error?.code && NOTICES[error.code] ? NOTICES[error.code] : 'qBittorrent could not complete this request.', code: error?.code || 'unknown' });
	};
	// A second owner check at an awaited boundary. requireOwner may already
	// have written a 401/503 response, so callers must not write another one.
	const checkOwner = async (req, res) => {
		try {
			if (res.headersSent) return false;
			return (await requireOwner(req, res)) === true;
		} catch { return false; }
	};
	const denyOwner = res => {
		if (res.headersSent) return;
		res.status(401).json({ error: 'Sign in as installation administrator.', signInRequired: true });
	};
	// Read-only, sanitized statistics for the trusted local/home settings panel.
	// This route is deliberately not owner-only, but it never accepts input,
	// never returns per-torrent data and reads only from the cached list()
	// snapshot. Every other qBittorrent route below stays owner-only.
	app.get('/api/qbittorrent/summary', async (req, res) => {
		res.set('Cache-Control', 'no-store');
		if (allowSummary?.(req) !== true) {
			return res.status(403).json({ error: 'Read-only qBittorrent statistics are available only at home or to an installation administrator.' });
		}
		try { res.json(await qb.summary()); }
		catch (error) { fail(res, error); }
	});
	// The sanitized torrent list for the read-only Activity downloads panel.
	// The guard runs synchronously before any qBittorrent contact, so a denied
	// caller makes no upstream request. The only accepted input is the viewer
	// filter allowlist, and it is validated before the upstream read begins.
	app.get('/api/activity/downloads', async (req, res) => {
		res.set('Cache-Control', 'no-store');
		if (allowDownloads?.(req) !== true) {
			return res.status(403).json({ error: 'Read-only qBittorrent downloads are available only at home or to an installation administrator.' });
		}
		try { res.json(await qb.readOnlyDownloads({ filter: req.query?.filter })); }
		catch (error) { fail(res, error); }
	});
	app.get('/api/qbittorrent/status', async (req, res) => {
		res.set('Cache-Control', 'no-store');
		if (!await requireOwner(req, res)) return;
		res.json(qb.status());
	});
	app.get('/api/qbittorrent/downloads', async (req, res) => {
		res.set('Cache-Control', 'no-store');
		if (!await requireOwner(req, res)) return;
		try {
			const data = await qb.list(req.query || {});
			// The read itself awaited upstream work. Do not return owner-only
			// data if the owner session ended in the meantime.
			if (!await checkOwner(req, res)) { denyOwner(res); return; }
			res.json(data);
		}
		catch (error) { fail(res, error); }
	});
	app.post('/api/qbittorrent/config', async (req, res) => {
		res.set('Cache-Control', 'no-store');
		if (!await requireOwner(req, res)) return;
		if (!req.is('application/json') || !sameOrigin?.(req)) return res.sendStatus(403);
		try { res.json(await qb.configure(req.body, { verifyOwner: () => checkOwner(req, res) })); }
		catch (error) { fail(res, error); }
	});
	app.post('/api/qbittorrent/disconnect', async (req, res) => {
		res.set('Cache-Control', 'no-store');
		if (!await requireOwner(req, res)) return;
		if (!req.is('application/json') || !sameOrigin?.(req)) return res.sendStatus(403);
		res.json(qb.disconnect());
	});
	app.post('/api/qbittorrent/confirm', async (req, res) => {
		res.set('Cache-Control', 'no-store');
		if (!await requireOwner(req, res)) return;
		if (!req.is('application/json') || !sameOrigin?.(req)) return res.sendStatus(403);
		try { res.json(await qb.confirmation({ id: req.body?.id, action: req.body?.action, sessionToken: cookieToken(req), verifyOwner: () => checkOwner(req, res) })); }
		catch (error) { fail(res, error); }
	});
	app.post('/api/qbittorrent/delete', async (req, res) => {
		res.set('Cache-Control', 'no-store');
		if (!await requireOwner(req, res)) return;
		if (!req.is('application/json') || !sameOrigin?.(req)) return res.sendStatus(403);
		try { res.json(await qb.commit({ token: req.body?.token, sessionToken: cookieToken(req), verifyOwner: () => checkOwner(req, res) })); }
		catch (error) { fail(res, error); }
	});
	app.get('/activity/downloads', async (req, res) => {
		res.set('Cache-Control', 'no-store');
		if (!await requireOwner(req, res)) return;
		res.type('text/html').send(DOWNLOADS_PAGE);
	});
	return qb;
}

export { NOTICES, STATE_LABELS, cookieToken, SAMPLE_TTL_MS, SAMPLE_LIMIT };
