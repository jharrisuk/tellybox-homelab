import path from 'node:path';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';

// Read-only status for the saved Dispatcharr settings. Nothing here changes
// configuration, touches provider playback, or proxies a caller supplied URL.
const CACHE_MS = 15000;
const TIMEOUT_MS = 10000;
const BODY_LIMIT = 64 * 1024;
const FILE_LIMIT = 64 * 1024 * 1024;
const SOURCES = ['onThisServer', 'relay', 'anotherServer'];
const NOTICE = {
	healthy: 'Dispatcharr answered this check.',
	auth: 'Dispatcharr did not accept the saved API key.',
	missingKey: 'Add a personal API key in installation settings to check Dispatcharr status.',
	unreachable: 'Dispatcharr could not be reached. Check the address from inside the Tellybox container.',
	timeout: 'Dispatcharr did not answer within 10 seconds.',
	invalid: 'Dispatcharr returned an unreadable status response.',
	tooLarge: 'Dispatcharr returned an unexpectedly large status response.',
	upstream: 'Dispatcharr is not available right now.',
	disabled: 'Dispatcharr is turned off in installation settings.',
	unconfigured: 'Dispatcharr is enabled but has no usable server address in installation settings.',
	staleSuffix: ' Showing the last successful check.',
	changed: 'Installation settings changed while Dispatcharr was being checked. Check again.'
};

const count = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
const time = value => {
	if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.round(value < 1e12 ? value * 1000 : value);
	if (typeof value === 'string' && value) { const parsed = Date.parse(value); return Number.isFinite(parsed) && parsed > 0 ? parsed : null; }
	return null;
};

function emptyStats() {
	return { liveChannels: null, liveChannelsAt: null, vodConnections: null, vodConnectionsAt: null, catchupConnections: null, catchupConnectionsAt: null };
}
function emptyCatalogue() {
	return { available: false, count: null, lastRefresh: null, indexing: null, error: null };
}
function emptyGuide() {
	return { available: false, fetchedAt: null, channels: null, withListings: null };
}

// Mirrors the read-only identity materialize() uses for CATALOGUE_CACHE_DIR.
// The value is internal and never returned to a caller.
export function catalogueCacheDirectory(directory, config) {
	const s = config?.services || {};
	const identity = createHash('sha256')
		.update(JSON.stringify([s.jellyfin?.url || '', s.jellyfin?.userId || '', s.dispatcharr?.url || '', s.dispatcharr?.key || '']))
		.digest('hex').slice(0, 24);
	return path.join(directory, 'catalogues', identity);
}

function locationOf(service) {
	if (SOURCES.includes(service.location)) return service.location;
	if (service.onThisServer === true) return 'onThisServer';
	if (service.onThisServer === false) return 'anotherServer';
	if (service.execution === 'relay') return 'relay';
	return service.url ? 'anotherServer' : 'onThisServer';
}

function targetOf(service, source) {
	const raw = service.url || (source === 'relay' ? service.relayMetadataUrl : '');
	try {
		const url = new URL(String(raw || ''));
		if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return '';
		return url.origin;
	} catch { return ''; }
}

export function readDispatcharrStatus(config) {
	const service = config?.services?.dispatcharr || {};
	const enabled = service.enabled === true;
	const source = enabled ? locationOf(service) : 'disabled';
	const target = targetOf(service, source);
	const key = typeof service.key === 'string' ? service.key : '';
	// A one-way fingerprint keys the cache and generation checks. It includes a
	// hash of the key so rotating it invalidates old results, but the value is
	// never written to a response or a log.
	const fingerprint = createHash('sha256').update(JSON.stringify([
		'dispatcharr-status-v1', enabled, source, target, key ? createHash('sha256').update(key).digest('hex') : '',
		config?.services?.jellyfin?.url || '', config?.services?.jellyfin?.userId || '',
		service.live === true, service.vod === true, service.recordings === true, service.catchup === true
	])).digest('hex');
	// configured means a usable target is saved, even while the toggle is off.
	// enabled stays separate so "saved but switched off" is not shown as zero use.
	return { config, enabled, source, target, key, fingerprint, configured: Boolean(target) };
}

async function discard(response) {
	try { await response.body?.cancel(); } catch { /* Nothing to release. */ }
}

async function readLimited(response, limit) {
	const reader = response.body?.getReader();
	if (!reader) return '';
	const chunks = [];
	let total = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > limit) throw Object.assign(Error('Response is too large.'), { code: 'too-large' });
			chunks.push(Buffer.from(value));
		}
	} finally {
		try { await reader.cancel(); } catch { /* Already closed. */ }
		try { reader.releaseLock(); } catch { /* Already detached. */ }
	}
	return Buffer.concat(chunks).toString('utf8');
}

// The upstream figures are channels and connections only. They are not viewer
// or account counts, so neither the field names nor the copy claim people.
function extractStats(data, observedAt) {
	const live = data?.live, vod = data?.vod, catchup = data?.catchup;
	// The aggregate document carries a top-level timestamp as well as section
	// timestamps. Live has no section timestamp of its own.
	const observed = time(data?.timestamp) ?? observedAt;
	const liveChannels = count(live?.channels) ?? count(live?.count);
	const vodConnections = count(vod?.vod_connections) ?? count(vod?.total_connections);
	const catchupConnections = count(catchup?.timeshift_sessions) ?? count(catchup?.total_connections);
	return {
		liveChannels, liveChannelsAt: liveChannels === null ? null : (time(live?.timestamp) ?? observed),
		vodConnections, vodConnectionsAt: vodConnections === null ? null : (time(vod?.timestamp) ?? observed),
		catchupConnections, catchupConnectionsAt: catchupConnections === null ? null : (time(catchup?.timestamp) ?? observed)
	};
}

async function readJson(file) {
	try {
		const info = await stat(file);
		if (!info.isFile() || info.size > FILE_LIMIT) return { ok: false, tooLarge: info.size > FILE_LIMIT };
		return { ok: true, value: JSON.parse(await readFile(file, 'utf8')) };
	} catch (error) {
		return { ok: false, missing: error?.code === 'ENOENT' };
	}
}

async function readCatalogue(directory, config) {
	const result = emptyCatalogue();
	const read = await readJson(path.join(catalogueCacheDirectory(directory, config), 'vod-catalogue.json'));
	if (!read.ok) {
		if (read.tooLarge) result.error = 'The saved catalogue is too large to read.';
		return result;
	}
	if (!Array.isArray(read.value?.items)) {
		result.error = 'The saved catalogue could not be read.';
		return result;
	}
	result.available = read.value.items.length > 0;
	result.count = read.value.items.length;
	result.lastRefresh = time(read.value?.time);
	// A read-only cache cannot observe a live indexer. Unknown is null, never a
	// claim that indexing is idle.
	result.indexing = null;
	return result;
}

async function readGuide(directory, config) {
	const result = emptyGuide();
	const read = await readJson(path.join(catalogueCacheDirectory(directory, config), 'dispatcharr-guide.json'));
	if (!read.ok) return result;
	const channels = Array.isArray(read.value?.channels) ? read.value.channels : null;
	if (!channels) return result;
	result.available = typeof read.value?.available === 'boolean' ? read.value.available : channels.length > 0;
	result.fetchedAt = time(read.value?.fetchedAt);
	result.channels = channels.length;
	result.withListings = channels.filter(channel => Array.isArray(channel?.programmes) && channel.programmes.length > 0).length;
	return result;
}

export function createDispatcharrStatus({ store, directory, fetcher = fetch, clock = Date.now }) {
	const cache = new Map();
	const inflight = new Map();
	let lastGood = null, generation = '';

	const snapshot = () => readDispatcharrStatus(store.get());

	async function probe(state, key) {
		const checkedAt = clock();
		if (!state.configured) return { ok: false, state: 'invalid', reachable: null, checkedAt, stats: emptyStats(), notice: NOTICE.unconfigured };
		if (!key) return { ok: false, state: 'auth-failed', reachable: null, checkedAt, stats: emptyStats(), notice: NOTICE.missingKey };
		let response;
		try {
			response = await fetcher(new URL('/proxy/stats/', state.target), {
				headers: { 'X-API-Key': key, Authorization: 'ApiKey ' + key },
				redirect: 'error',
				signal: AbortSignal.timeout(TIMEOUT_MS)
			});
		} catch (error) {
			const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
			return { ok: false, state: 'unreachable', reachable: false, checkedAt, stats: emptyStats(), notice: timedOut ? NOTICE.timeout : NOTICE.unreachable };
		}
		const reachable = true;
		if (response.status === 401 || response.status === 403) {
			await discard(response);
			return { ok: false, state: 'auth-failed', reachable, checkedAt, stats: emptyStats(), notice: NOTICE.auth };
		}
		if (!response.ok) {
			await discard(response);
			return { ok: false, state: 'unreachable', reachable, checkedAt, stats: emptyStats(), notice: NOTICE.upstream };
		}
		let text;
		try { text = await readLimited(response, BODY_LIMIT); }
		catch (error) {
			return { ok: false, state: 'invalid', reachable, checkedAt, stats: emptyStats(), notice: error?.code === 'too-large' ? NOTICE.tooLarge : NOTICE.invalid };
		}
		let data;
		try { data = JSON.parse(text); } catch {
			return { ok: false, state: 'invalid', reachable, checkedAt, stats: emptyStats(), notice: NOTICE.invalid };
		}
		const sections = [data?.live, data?.vod, data?.catchup].filter(section => section && typeof section === 'object' && !Array.isArray(section));
		if (!data || typeof data !== 'object' || Array.isArray(data) || !sections.length) {
			return { ok: false, state: 'invalid', reachable, checkedAt, stats: emptyStats(), notice: NOTICE.invalid };
		}
		const stats = extractStats(data, checkedAt);
		if (stats.liveChannels === null && stats.vodConnections === null && stats.catchupConnections === null) {
			return { ok: false, state: 'invalid', reachable, checkedAt, stats: emptyStats(), notice: NOTICE.invalid };
		}
		return { ok: true, state: 'healthy', reachable, checkedAt, stats, notice: NOTICE.healthy };
	}

	function payload(state, fields) {
		return {
			configured: state.configured,
			enabled: state.enabled,
			source: state.source,
			state: fields.state,
			reachable: fields.reachable,
			checkedAt: fields.checkedAt,
			stale: fields.stale,
			notice: fields.notice,
			stats: fields.stats,
			catalogue: fields.catalogue,
			guide: fields.guide
		};
	}

	async function finish(outcome, depth) {
		if (!outcome.superseded) return outcome.value;
		const current = snapshot();
		return depth < 1 ? build(current, true, depth + 1) : payload(current, {
			state: 'unreachable', reachable: null, checkedAt: clock(), stale: false, notice: NOTICE.changed,
			stats: emptyStats(), catalogue: emptyCatalogue(), guide: emptyGuide()
		});
	}

	async function build(state, refresh, depth) {
		// Any settings or source change starts a new generation. Old cached and
		// last-good values are dropped rather than reused if settings return to an
		// earlier shape.
		if (generation !== state.fingerprint) {
			generation = state.fingerprint;
			cache.clear();
			lastGood = null;
		}
		if (!state.enabled) {
			return payload(state, {
				state: 'disabled', reachable: null, checkedAt: null, stale: false, notice: NOTICE.disabled,
				stats: emptyStats(), catalogue: emptyCatalogue(), guide: emptyGuide()
			});
		}
		const now = clock();
		const hit = cache.get(state.fingerprint);
		if (!refresh && hit && now - hit.at < CACHE_MS) return hit.value;
		if (inflight.has(state.fingerprint)) return finish(await inflight.get(state.fingerprint), depth);

		const running = (async () => {
			const checked = await probe(state, state.key);
			if (snapshot().fingerprint !== state.fingerprint) return { superseded: true };
			const [catalogue, guide] = await Promise.all([readCatalogue(directory, state.config), readGuide(directory, state.config)]);
			if (snapshot().fingerprint !== state.fingerprint) return { superseded: true };
			let value;
			if (checked.ok) {
				lastGood = { fingerprint: state.fingerprint, stats: checked.stats, checkedAt: checked.checkedAt };
				value = payload(state, { ...checked, stale: false, catalogue, guide });
			} else if (lastGood?.fingerprint === state.fingerprint) {
				value = payload(state, {
					state: 'stale', reachable: checked.reachable, checkedAt: checked.checkedAt, stale: true,
					notice: checked.notice + NOTICE.staleSuffix,
					stats: lastGood.stats, catalogue, guide
				});
			} else {
				value = payload(state, { ...checked, stale: false, catalogue, guide });
			}
			cache.set(state.fingerprint, { at: clock(), value });
			for (const [key] of cache) if (key !== state.fingerprint && cache.size > 4) cache.delete(key);
			return { value };
		})();

		inflight.set(state.fingerprint, running);
		try {
			return await finish(await running, depth);
		} finally {
			if (inflight.get(state.fingerprint) === running) inflight.delete(state.fingerprint);
		}
	}

	return {
		get: ({ refresh = false } = {}) => build(snapshot(), refresh === true, 0)
	};
}
