import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { readDispatcharrStatus } from './dispatcharr-status.mjs';

// Read-only, sanitized upstream stream monitor for the Activity page.
//
// The upstream /proxy/stats/ document is never returned: it contains provider
// URLs, account details, raw session/client ids, IPs and user agents. This
// module selects a small allowlist, bounds every string/number/list, and keeps
// unknown separate from zero. It never starts playback or mutates Dispatcharr.
export const STREAMS_CACHE_MS = 15000;
export const STREAMS_TIMEOUT_MS = 10000;
export const STREAMS_BODY_LIMIT = 256 * 1024;
export const STREAMS_ROW_LIMIT = 100;
export const STREAMS_CLIENT_LIMIT = 10;
// The saved channel snapshot has no provider field of its own, so the stream
// monitor does not join it. Only an account name carried by the statistics
// document or resolved through the accounts endpoint is ever shown as a
// source. These bounds still apply to the read-only snapshot helper below.
export const STREAMS_CATALOGUE_CACHE_MS = 60000;
export const STREAMS_CATALOGUE_LIMIT = 20000;
// Dispatcharr names an M3U profile id in its statistics but not the account.
// The accounts read resolves both. It is bounded, runs at most once per
// interval (never per browser view), and a failed read is retried sooner than a
// successful one expires so a transient outage does not hide names for long.
export const STREAMS_PROFILE_CACHE_MS = 300000;
export const STREAMS_PROFILE_RETRY_MS = 30000;
// A live installation with six accounts returned ~1 MB because every account
// embeds its profiles and channel-group metadata. The bound is deliberately
// generous (4 MiB) but finite: the response is discarded except for account
// and profile id/name, and an over-limit read is reported rather than hidden.
// The /proxy/stats limit stays at STREAMS_BODY_LIMIT and is unrelated.
export const STREAMS_ACCOUNTS_BODY_LIMIT = 4 * 1024 * 1024;
export const STREAMS_ACCOUNT_LIMIT = 200;
export const STREAMS_ACCOUNT_PROFILE_LIMIT = 100;
// Local viewer attribution. The media process writes the same activity file the
// Activity page reads. It is re-read at most once every two seconds, bounded in
// size and rows, and only ever contributes coarse, sanitised labels.
export const STREAMS_LOCAL_CACHE_MS = 2000;
export const STREAMS_LOCAL_FILE_LIMIT = 4 * 1024 * 1024;
export const STREAMS_LOCAL_SESSION_LIMIT = 50;
export const STREAMS_LOCAL_ACTIVE_MS = 120000;
const DISPATCHARR_LABEL = /^dispatcharr$/i;

const NOTICE = {
	ok: 'Dispatcharr answered this monitoring check. Reported statistics may be incomplete.',
	stale: 'Dispatcharr could not be checked just now. Showing the last successful report.',
	disabled: 'Dispatcharr is turned off in installation settings.',
	unconfigured: 'Dispatcharr is enabled but has no usable server address in installation settings.',
	auth: 'Dispatcharr did not accept the saved API key.',
	missingKey: 'Add a personal API key in installation settings to monitor Dispatcharr.',
	unreachable: 'Dispatcharr could not be reached. Check the address from inside the Tellybox container.',
	timeout: 'Dispatcharr did not answer within 10 seconds.',
	invalid: 'Dispatcharr returned an unreadable monitoring response.',
	tooLarge: 'Dispatcharr returned an unexpectedly large monitoring response.',
	upstream: 'Dispatcharr is not available right now.',
	changed: 'Installation settings changed while Dispatcharr was being checked. Check again.',
	staleSuffix: ' Showing the last successful check.'
};

const valueNumber = value => {
	// Number(null/false/''/whitespace) is 0; that would turn an unknown upstream
	// field into a confident zero. Accept only real numbers and strict numeric
	// strings.
	if (typeof value === 'number') return Number.isFinite(value) && value >= 0 ? value : null;
	if (typeof value === 'string' && value.trim() !== '') {
		const number = Number(value);
		return Number.isFinite(number) && number >= 0 ? number : null;
	}
	return null;
};
const valueInteger = value => {
	const number = valueNumber(value);
	return number === null ? null : Math.floor(number);
};
const cleanText = (value, max = 200) => {
	if (typeof value !== 'string') return null;
	const text = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
	if (!text) return null;
	// Never echo a URL or something that looks like a credential.
	if (/:\/\//.test(text) || /(?:password|passwd|token|secret|api[_-]?key)\s*=/i.test(text)) return null;
	return text.slice(0, max);
};
// A stream name is added to the channel card beside the provider, so it gets a
// stricter filter than a generic label: URLs and credential-looking text are
// dropped rather than shortened, and the result is bounded.
const URL_LIKE = /(?:\bwww\.[a-z0-9-]+)|(?:\b[a-z0-9-]+\.(?:com|net|org|io|tv|xyz|info|biz|invalid|example|test)(?:\/|\b))|^(?:https?|rtsp|rtmps?|udp|rtp|ftp|file|mms):/i;
const CREDENTIAL_LIKE = /(?:password|passwd|token|secret|api[_-]?key|username)\s*[:=]/i;
const streamNameText = value => {
	const text = cleanText(value, 120);
	if (!text || URL_LIKE.test(text) || CREDENTIAL_LIKE.test(text)) return null;
	return text;
};
// Stream ids in the upstream metadata are normally integers, but a short
// opaque token is accepted. Paths, addresses, long strings and punctuation are
// rejected so an id can never become a URL or an arbitrary metadata echo.
const streamIdText = value => {
	if (typeof value === 'number') {
		return Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
	}
	if (typeof value !== 'string') return null;
	const text = value.trim();
	if (/^\d{1,12}$/.test(text)) return text;
	return /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/.test(text) ? text : null;
};
// Reasons recorded by the installed Dispatcharr build are short machine tokens.
// Known tokens are made readable; an unknown token is humanised, never echoed
// as arbitrary markup, and "unknown" is omitted altogether.
const SWITCH_REASON_LABELS = Object.freeze({
	manual: 'manual switch',
	health_monitor: 'health check',
	buffering_timeout: 'buffering timeout',
	max_retries_exceeded: 'retries exhausted',
	startup: 'startup',
	unknown: null
});
const switchReasonText = value => {
	const text = cleanText(value, 80);
	if (!text || URL_LIKE.test(text) || CREDENTIAL_LIKE.test(text)) return null;
	const key = text.toLowerCase().replace(/[\s-]+/g, '_');
	if (Object.prototype.hasOwnProperty.call(SWITCH_REASON_LABELS, key)) return SWITCH_REASON_LABELS[key];
	return text.replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 60).toLowerCase() || null;
};
// The stats row normally carries these keys directly. A metadata bag is also
// accepted so a build that nests the same ChannelMetadataField values still
// resolves, without trusting any other shape.
const metadataField = (source, key) => {
	if (!source || typeof source !== 'object') return null;
	if (source[key] !== undefined && source[key] !== null && source[key] !== '') return source[key];
	const bag = source.metadata;
	return bag && typeof bag === 'object' && !Array.isArray(bag) ? bag[key] ?? null : null;
};
const timeMs = value => {
	if (typeof value === 'number' && Number.isFinite(value) && value > 0) return Math.round(value < 1e12 ? value * 1000 : value);
	if (typeof value === 'string' && value) {
		const parsed = Date.parse(value);
		if (Number.isFinite(parsed) && parsed > 0) return parsed;
	}
	return null;
};
const durationSeconds = (start, checkedAt) => {
	if (!start || start > checkedAt) return null;
	return Math.max(0, Math.round((checkedAt - start) / 1000));
};
// Tellybox proxies playback server-side, so Dispatcharr only ever sees the
// Tellybox Node server as the client. Its user agent says nothing about the
// real phone, TV or browser and is never used for an app label. The only
// trustworthy source is Tellybox's own active playback entry, whose `client`
// field is authoritative for the app kind.
const clientLabel = value => {
	const text = cleanText(value, 40);
	if (!text) return null;
	const key = text.toLowerCase().replace(/[\s_]+/g, '-');
	if (key === 'android-tv') return 'Android TV';
	if (key === 'android-phone') return 'Android phone';
	if (key === 'web' || key === 'browser' || key === 'web-browser' || key === 'browser-web') return 'Browser';
	// An unknown declared kind is humanised rather than replaced by a guess.
	const words = text.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim();
	if (!words) return null;
	return words.charAt(0).toUpperCase() + words.slice(1).toLowerCase();
};
// A declared client kind is authoritative. Only when it is absent do we fall
// back to the local agent shape, and then only to a coarse family: never to a
// phone/TV distinction, which the agent cannot prove.
const agentLabel = value => {
	const text = cleanText(value, 500);
	if (!text) return null;
	if (/(?:^|[\s(])(?:dalvik|okhttp|exoplayerlib)\//i.test(text)) return 'Android app';
	if (/edg\//i.test(text)) return 'Edge';
	if (/chrome|crios/i.test(text)) return 'Chrome';
	if (/firefox|fxios/i.test(text)) return 'Firefox';
	if (/applecoremedia|safari/i.test(text)) return 'Safari';
	return null;
};
// A short device context is appended when the local entry names one. The
// device name is a display label from Tellybox, not an agent or an address; it
// is bounded and never repeats the app label.
const deviceContext = (value, label) => {
	const text = cleanText(value, 120);
	if (!text) return null;
	const short = text.split(/\s+[·|]\s+/)[0].trim().slice(0, 48);
	if (!short) return null;
	const key = short.toLowerCase();
	if (key === String(label || '').toLowerCase()) return null;
	if (['unknown device', 'local access', 'unknown viewer', 'tellybox server'].includes(key)) return null;
	return short;
};
const sessionTitle = value => {
	const text = cleanText(value, 300);
	return text ? text.replace(/\s+/g, ' ').trim().toLowerCase() : null;
};
// One exact, sanitised title match is attributed. Two matches stay ambiguous
// and are reported as multiple viewers rather than picking one.
function localAttribution(title, sessions) {
	const key = sessionTitle(title);
	const list = Array.isArray(sessions) ? sessions : [];
	const matches = key ? list.filter(entry => sessionTitle(entry?.title) === key) : [];
	if (matches.length > 1) return { app: 'Multiple viewers', viewer: null };
	if (matches.length !== 1) return { app: 'Tellybox server', viewer: null };
	const entry = matches[0];
	const base = clientLabel(entry?.client) || agentLabel(entry?.browser) || 'Tellybox server';
	const context = deviceContext(entry?.deviceName, base);
	return {
		app: context ? base + ' - ' + context : base,
		viewer: cleanText(entry?.personName, 120)
	};
}
const audioLabel = (codec, channels) => {
	const name = cleanText(codec, 40);
	const count = valueInteger(channels);
	if (!name && count === null) return null;
	return [name, count !== null && count > 0 ? count + 'ch' : ''].filter(Boolean).join(' ');
};
const firstText = (...values) => {
	for (const value of values) {
		const text = cleanText(value, 120);
		if (text) return text;
	}
	return null;
};
// "Dispatcharr" is the transport for every row on this page, so it is never a
// meaningful source. A source is a genuine owning account name or nothing.
const sourceText = value => {
	const text = cleanText(value, 120);
	return !text || DISPATCHARR_LABEL.test(text) ? null : text;
};
// A profile id is an integer in Dispatcharr. Short opaque tokens are accepted
// for resilience, but paths and long strings are rejected.
const profileIdText = value => {
	if (typeof value === 'number') return Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
	if (typeof value !== 'string') return null;
	const text = value.trim();
	if (/^\d{1,12}$/.test(text)) return text;
	return /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/.test(text) ? text : null;
};
const channelProfileId = value => {
	for (const candidate of [value?.m3u_profile_id, value?.m3u_profile?.id, value?.m3u_profile?.profile_id]) {
		const id = profileIdText(candidate);
		if (id) return id;
	}
	return null;
};
// The statistics client record has been observed to carry `profile_id` for the
// M3U profile. `output_profile_id` is a different concept and is ignored.
const clientProfileId = value => {
	for (const candidate of [value?.m3u_profile_id, value?.profile_id, value?.m3u_profile?.id,
		value?.m3u_profile?.profile_id]) {
		const id = profileIdText(candidate);
		if (id) return id;
	}
	return null;
};
// Only fields the upstream document actually supplies are used for the stats
// provider. A provider is never inferred from an address, a profile id or the
// local app name. The literal "Dispatcharr" is filtered by sourceText().
const providerText = value => sourceText(firstText(value?.provider, value?.provider_name,
	value?.account_name, value?.m3u_account_name, value?.m3u_profile?.account_name,
	value?.m3u_account?.name));
const statsProfileName = value => firstText(value?.m3u_profile_name, value?.profile_name,
	value?.m3u_profile?.profile_name, value?.m3u_profile?.name);
// Resolve a profile id through the cached accounts index. A successful
// resolution wins over any stats-supplied name; an unresolved id keeps its
// name if the stats supplied one, otherwise it is shown as the id itself.
function resolvedProfile(value, profiles, id) {
	const entry = id && profiles ? profiles.get(id) : null;
	return {
		id: id || null,
		name: cleanText(entry?.profile, 120) || statsProfileName(value) || id || null,
		account: sourceText(entry?.account) || providerText(value)
	};
}
// A stats document may provide an account name but no profile name (or vice
// versa). Each is resolved independently and never fabricated.
function resolvedSource(value, profiles, id, fallback = null) {
	const entry = id && profiles ? profiles.get(id) : null;
	return sourceText(entry?.account) || providerText(value) || fallback;
}
// A VOD/catch-up group can contain connections through different M3U accounts.
// Label the group only when every connection is known; otherwise retain uncertainty.
function groupLabel(connections, read, multiple) {
	const values = (Array.isArray(connections) ? connections : []).map(read);
	if (!values.length || values.some(value => !value)) return null;
	const unique = [...new Set(values)];
	if (!unique.length) return null;
	return unique.length === 1 ? unique[0] : multiple;
}

function connectionsBlock(list, reported, checkedAt, context = {}) {
	const { profiles = null, fallbackSource = null, fallbackProfile = null, app = null, viewer = null } = context;
	const source = Array.isArray(list) ? list : [];
	const items = source.slice(0, STREAMS_CLIENT_LIMIT).map((client, index) => {
		const connected = timeMs(client?.connected_at);
		const id = clientProfileId(client);
		const resolved = resolvedProfile(client, profiles, id);
		return {
			id: 'Connection ' + (index + 1),
			// Viewer attribution is per matched channel, not per upstream row: a
			// local viewer can hold one or more upstream connections.
			app,
			viewer,
			format: cleanText(client?.output_format, 40),
			// A genuine account name on the connection wins. Otherwise use the
			// channel-level source rather than "Not reported" on every row.
			source: resolved.account || fallbackSource,
			profile: resolved.name || fallbackProfile,
			connectedAt: connected,
			durationSeconds: valueInteger(client?.duration) ?? durationSeconds(connected, checkedAt)
		};
	});
	// A missing upstream count is unknown unless the provided detail list is a
	// non-empty complete-enough sample; an empty list with no count is not proof
	// of zero connections.
	const provided = valueInteger(reported);
	const total = provided !== null ? provided : (source.length ? source.length : null);
	return { reported: total, shown: items.length, truncated: total !== null && total > items.length, items };
}

function liveRow(channel, index, checkedAt, context = {}) {
	const { profiles = null, sessions = [] } = context;
	const started = timeMs(channel?.started_at);
	const uptime = valueNumber(channel?.uptime);
	const duration = durationSeconds(started, checkedAt) ?? (uptime === null ? null : Math.round(uptime));
	const reported = valueInteger(channel?.client_count);
	// The owning account comes from the M3U profile resolution, or from a real
	// account name in the statistics row. A channel catalogue cannot supply a
	// provider, so it is never consulted here.
	const id = channelProfileId(channel);
	const resolved = resolvedProfile(channel, profiles, id);
	const channelSource = resolved.account;
	const clientSources = groupLabel(channel?.clients,
		client => resolvedSource(client, profiles, clientProfileId(client)), 'Multiple sources');
	// Which upstream stream Dispatcharr actually picked. Kept separate from the
	// source so the account label still answers "whose stream" while this line
	// answers "which stream". The same sanitised value is the title fallback,
	// so a URL-like stream name cannot leak through either path.
	const pickedStreamName = streamNameText(metadataField(channel, 'stream_name'));
	const title = cleanText(channel?.channel_name) || pickedStreamName || 'Channel ' + (index + 1);
	const attribution = localAttribution(title, sessions);
	const source = channelSource || clientSources;
	return {
		kind: 'live', key: 'live:' + (index + 1),
		title, typeLabel: 'Live', state: cleanText(channel?.state, 40),
		source,
		profile: resolved.name,
		app: attribution.app,
		viewer: attribution.viewer,
		streamName: pickedStreamName,
		streamId: streamIdText(metadataField(channel, 'stream_id')),
		switchAt: timeMs(metadataField(channel, 'stream_switch_time')),
		switchReason: switchReasonText(metadataField(channel, 'stream_switch_reason')),
		format: cleanText(channel?.stream_type, 40),
		codec: cleanText(channel?.video_codec, 40),
		resolution: cleanText(channel?.resolution, 40),
		fps: valueNumber(channel?.source_fps),
		audio: audioLabel(channel?.audio_codec, channel?.audio_channels),
		averageBitrateKbps: valueNumber(channel?.avg_bitrate_kbps),
		bytes: valueNumber(channel?.total_bytes),
		durationSeconds: duration,
		connections: connectionsBlock(channel?.clients, reported, checkedAt,
			{ profiles, fallbackSource: source, fallbackProfile: resolved.name,
				app: attribution.app, viewer: attribution.viewer }),
		note: null
	};
}

function vodRow(group, index, checkedAt, context = {}) {
	const { profiles = null, sessions = [] } = context;
	const connections = Array.isArray(group?.connections) ? group.connections : [];
	const durations = connections.map(connection => valueInteger(connection?.duration)).filter(value => value !== null);
	const title = cleanText(group?.content_name) || 'VOD title ' + (index + 1);
	const attribution = localAttribution(title, sessions);
	const source = groupLabel(connections,
		connection => resolvedSource(connection, profiles, clientProfileId(connection)), 'Multiple sources');
	const profile = groupLabel(connections,
		connection => resolvedProfile(connection, profiles, clientProfileId(connection)).name, 'Multiple profiles');
	return {
		kind: 'vod', key: 'vod:' + (index + 1),
		title, typeLabel: 'VOD', state: null,
		source, profile,
		app: attribution.app,
		viewer: attribution.viewer,
		format: null, codec: null, resolution: null, fps: null, audio: null,
		averageBitrateKbps: null, bytes: null,
		durationSeconds: durations.length ? Math.max(...durations) : null,
		connections: connectionsBlock(connections, connections.length, checkedAt,
			{ profiles, app: attribution.app, viewer: attribution.viewer }),
		note: 'VOD statistics do not report codec, resolution, bitrate or bytes in this response.'
	};
}

function catchupRow(session, index, checkedAt, context = {}) {
	const { profiles = null, sessions: localSessions = [] } = context;
	const connections = Array.isArray(session?.connections) ? session.connections : [];
	const first = connections[0] || {};
	const paused = typeof session?.paused === 'boolean' ? (session.paused ? 'paused' : 'playing') : null;
	const title = cleanText(session?.channel_name) || 'Catch-up session ' + (index + 1);
	const attribution = localAttribution(title, localSessions);
	const source = groupLabel(connections,
		connection => resolvedSource(connection, profiles, clientProfileId(connection)), 'Multiple sources');
	const profile = groupLabel(connections,
		connection => resolvedProfile(connection, profiles, clientProfileId(connection)).name, 'Multiple profiles');
	return {
		kind: 'catchup', key: 'catchup:' + (index + 1),
		title, typeLabel: 'Catchup', state: paused,
		source, profile,
		app: attribution.app,
		viewer: attribution.viewer,
		format: cleanText(session?.stream_type, 40),
		codec: cleanText(session?.video_codec, 40),
		resolution: cleanText(session?.resolution, 40),
		fps: valueNumber(session?.source_fps),
		audio: audioLabel(session?.audio_codec, session?.audio_channels),
		averageBitrateKbps: valueNumber(first?.avg_bitrate_kbps),
		bytes: valueNumber(first?.bytes_streamed),
		durationSeconds: valueInteger(first?.duration),
		connections: connectionsBlock(connections, connections.length, checkedAt,
			{ profiles, app: attribution.app, viewer: attribution.viewer }),
		note: 'Catch-up bitrate and bytes are reported per session and repeated on its connections; they are not summed here.'
	};
}

function sanitize(data, checkedAt, context = {}) {
	const { profiles = null, sessions = [] } = context;
	const live = data?.live, vod = data?.vod, catchup = data?.catchup;
	const liveChannels = Array.isArray(live?.channels) ? live.channels : null;
	const vodGroups = Array.isArray(vod?.vod_connections) ? vod.vod_connections : [];
	const catchupSessions = Array.isArray(catchup?.timeshift_sessions) ? catchup.timeshift_sessions : [];
	const rowsReported = (liveChannels?.length || 0) + vodGroups.length + catchupSessions.length;
	const streams = [
		...(liveChannels || []).slice(0, STREAMS_ROW_LIMIT).map((channel, index) =>
			liveRow(channel, index, checkedAt, { profiles, sessions })),
		...vodGroups.slice(0, STREAMS_ROW_LIMIT).map((group, index) =>
			vodRow(group, index, checkedAt, { profiles, sessions })),
		...catchupSessions.slice(0, STREAMS_ROW_LIMIT).map((session, index) =>
			catchupRow(session, index, checkedAt, { profiles, sessions }))
	].slice(0, STREAMS_ROW_LIMIT);
	const liveCounts = (liveChannels || []).map(channel => valueInteger(channel?.client_count));
	// An absent live section or channel list is unknown, never zero. Only a real
	// empty live channel list with a zero count is a confirmed zero.
	const liveClients = liveChannels === null ? null
		: liveChannels.length === 0 ? ((valueInteger(live?.count) ?? 0) === 0 ? 0 : null)
			: liveCounts.every(count => count !== null) ? liveCounts.reduce((total, count) => total + count, 0)
				: null;
	const connectionTotal = (value, groups) => {
		const supplied = valueInteger(value);
		if (supplied !== null) return supplied;
		if (!Array.isArray(groups) || !groups.length) return null;
		return groups.reduce((total, group) => total + (Array.isArray(group?.connections) ? group.connections.length : 0), 0);
	};
	return {
		reported: {
			liveChannels: valueInteger(live?.count) ?? (liveChannels === null ? null : liveChannels.length),
			liveClients,
			vodConnections: connectionTotal(vod?.total_connections, vodGroups),
			catchupConnections: connectionTotal(catchup?.total_connections, catchupSessions)
		},
		truncated: rowsReported > streams.length,
		rowsReported, rowsShown: streams.length,
		streams
	};
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

// The Dispatcharr accounts endpoint embeds each account's M3U profiles. Only
// the id, profile name and owning account name are kept; URLs, credentials and
// every other field are discarded before anything leaves this function.
export function profileIndex(data) {
	const map = new Map();
	const accounts = Array.isArray(data) ? data
		: Array.isArray(data?.results) ? data.results : [];
	for (const account of accounts.slice(0, STREAMS_ACCOUNT_LIMIT)) {
		if (!account || typeof account !== 'object') continue;
		const accountName = sourceText(account?.name ?? account?.account_name);
		const profiles = Array.isArray(account?.profiles) ? account.profiles : [];
		for (const profile of profiles.slice(0, STREAMS_ACCOUNT_PROFILE_LIMIT)) {
			if (!profile || typeof profile !== 'object') continue;
			const id = profileIdText(profile?.id ?? profile?.profile_id);
			if (!id) continue;
			const name = cleanText(profile?.name ?? profile?.profile_name, 120);
			const owner = accountName
				|| sourceText(profile?.account?.name)
				|| sourceText(profile?.account_name)
				|| sourceText(profile?.m3u_account?.name);
			if (!name && !owner) continue;
			map.set(id, { profile: name, account: owner });
		}
	}
	return map;
}

// The media process persists active playback in `<AUTH_DIR>/activity.json`; the
// setup process reads the same file as `<HOMELAB_DATA>/access/activity.json`.
// Only a bounded, recent, non-download playback entry becomes a candidate. The
// returned shape is deliberately narrow: title, declared client kind, display
// device name, agent (for the coarse fallback only) and person name.
export function createCachedLocalSessions({ directory, clock = Date.now, limit = STREAMS_LOCAL_FILE_LIMIT } = {}) {
	let cached = [], at = -Infinity;
	const file = directory ? path.join(directory, 'activity.json') : '';
	return () => {
		if (!file) return cached;
		if (clock() - at < STREAMS_LOCAL_CACHE_MS) return cached;
		at = clock();
		cached = [];
		let data;
		try {
			const info = statSync(file);
			if (!info.isFile() || info.size > limit) return cached;
			data = JSON.parse(readFileSync(file, 'utf8'));
		} catch { return cached; }
		if (!Array.isArray(data)) return cached;
		const now = clock();
		cached = data.filter(entry => entry && typeof entry === 'object'
			&& (entry.type === undefined || entry.type === 'playback')
			&& entry.purpose !== 'download'
			&& entry.state !== 'ended' && entry.state !== 'requested'
			&& (!Number.isFinite(Number(entry.updated)) || Number(entry.updated) > now - STREAMS_LOCAL_ACTIVE_MS))
			.slice(-STREAMS_LOCAL_SESSION_LIMIT)
			.map(entry => ({
				title: cleanText(entry.title, 300),
				client: cleanText(entry.client, 40),
				deviceName: cleanText(entry.deviceName, 120),
				browser: cleanText(entry.browser, 500),
				personName: cleanText(entry.personName, 120)
			}));
		return cached;
	};
}

function emptyPayload(state, fields) {
	return {
		configured: Boolean(state.configured), enabled: Boolean(state.enabled), source: state.source,
		state: fields.state, reachable: fields.reachable ?? null, checkedAt: fields.checkedAt ?? null,
		upstreamAt: fields.upstreamAt ?? null, stale: Boolean(fields.stale), notice: fields.notice,
		// A bounded diagnostic for the accounts read. It never carries the body,
		// an account password, a URL or an address: only a reason and a count.
		profileResolution: fields.profileResolution ?? null,
		profileAccounts: fields.profileAccounts ?? null,
		reported: { liveChannels: null, liveClients: null, vodConnections: null, catchupConnections: null },
		truncated: false, rowsReported: 0, rowsShown: 0, streams: []
	};
}

// The media process keeps the playlist channels the channel list serves in
// `<HOMELAB_DATA>/access/dispatcharr.json.channels-cache.json`. This helper
// still reads that bounded snapshot for callers that need it, but it invents
// no provider: the snapshot has no provider field, and the streams monitor
// never used the fabricated literal anyway.
const CATALOGUE_FILE_LIMIT = 8 * 1024 * 1024;
export function createCachedCatalogue({ directory, clock = Date.now } = {}) {
	let cached = [], at = -Infinity;
	const file = directory ? path.join(directory, 'access', 'dispatcharr.json.channels-cache.json') : '';
	return () => {
		if (clock() - at < STREAMS_CATALOGUE_CACHE_MS) return cached;
		at = clock();
		cached = [];
		if (!file) return cached;
		let data;
		try {
			const info = statSync(file);
			if (!info.isFile() || info.size > CATALOGUE_FILE_LIMIT) return cached;
			data = JSON.parse(readFileSync(file, 'utf8'));
		} catch { return cached; }
		if (!Array.isArray(data?.items)) return cached;
		cached = data.items.slice(0, STREAMS_CATALOGUE_LIMIT)
			.filter(item => item && typeof item === 'object'
				&& typeof item.name === 'string' && item.name.trim()
				&& typeof item.id === 'string' && /^[a-f0-9-]{36}$/i.test(item.id))
			.map(item => ({ Id: 'dispatch-live-' + item.id, Name: item.name }));
		return cached;
	};
}

export function createDispatcharrStreams({ store, fetcher = fetch, clock = Date.now, sessions = null }) {
	const cache = new Map();
	const inflight = new Map();
	let lastGood = null, generation = '';
	let profiles = new Map(), profilesAt = -Infinity, profileFailureAt = -Infinity,
		profileFingerprint = '', profileResolution = null, profileAccounts = null;
	const snapshot = () => readDispatcharrStatus(store.get());
	const profileResult = () => ({ profiles, resolution: profileResolution, accounts: profileAccounts });

	// Resolve the ids the stats document reports through one bounded accounts
	// read. The result is cached for STREAMS_PROFILE_CACHE_MS. A failure keeps
	// the last successful index and is retried after STREAMS_PROFILE_RETRY_MS,
	// so a transient outage neither hides known names nor hammers the API. The
	// reason is carried in a bounded diagnostic instead of failing silently.
	async function readProfiles(state, ids) {
		const now = clock();
		if (profileFingerprint !== state.fingerprint) {
			profileFingerprint = state.fingerprint;
			profiles = new Map();
			profilesAt = -Infinity;
			profileFailureAt = -Infinity;
			profileResolution = null;
			profileAccounts = null;
		}
		if (profilesAt > -Infinity && now - profilesAt < STREAMS_PROFILE_CACHE_MS) return profileResult();
		if (now - profileFailureAt < STREAMS_PROFILE_RETRY_MS) return profileResult();
		if (!state.key) {
			profileResolution = 'missing-key';
			profileAccounts = null;
			profileFailureAt = clock();
			return profileResult();
		}
		let response;
		try {
			response = await fetcher(new URL('/api/m3u/accounts/', state.target), {
				headers: { 'X-API-Key': state.key, Authorization: 'ApiKey ' + state.key },
				redirect: 'error',
				signal: AbortSignal.timeout(STREAMS_TIMEOUT_MS)
			});
		} catch {
			profileResolution = 'http-error';
			profileAccounts = null;
			profileFailureAt = clock();
			return profileResult();
		}
		if (!response.ok) {
			await discard(response);
			profileResolution = 'http-error';
			profileAccounts = null;
			profileFailureAt = clock();
			return profileResult();
		}
		let text;
		try { text = await readLimited(response, STREAMS_ACCOUNTS_BODY_LIMIT); }
		catch (error) {
			profileResolution = error?.code === 'too-large' ? 'too-large' : 'invalid';
			profileAccounts = null;
			profileFailureAt = clock();
			return profileResult();
		}
		let data;
		try { data = JSON.parse(text); }
		catch {
			profileResolution = 'invalid';
			profileAccounts = null;
			profileFailureAt = clock();
			return profileResult();
		}
		// A settings change while the accounts read was in flight invalidates it.
		if (snapshot().fingerprint !== state.fingerprint) return profileResult();
		const accountsSeen = Array.isArray(data) ? data.length
			: Array.isArray(data?.results) ? data.results.length : 0;
		if (!Array.isArray(data) && !Array.isArray(data?.results)) {
			profileResolution = 'invalid';
			profileAccounts = null;
			profileFailureAt = clock();
			return profileResult();
		}
		const next = profileIndex(data);
		// Accounts without embedded profiles usually mean an older upstream
		// shape. Keep any last-good names and retry on the failure schedule
		// rather than treating the empty result as authoritative for 5 minutes.
		if (!next.size && accountsSeen > 0) {
			profileResolution = 'invalid';
			profileAccounts = accountsSeen;
			profileFailureAt = clock();
			return profileResult();
		}
		profiles = next;
		profilesAt = clock();
		profileFailureAt = -Infinity;
		profileResolution = 'ok';
		profileAccounts = accountsSeen;
		return profileResult();
	}

	async function readSessions() {
		if (!sessions) return [];
		try {
			const value = typeof sessions === 'function' ? await sessions() : sessions;
			return Array.isArray(value) ? value.slice(0, STREAMS_LOCAL_SESSION_LIMIT) : [];
		} catch { return []; }
	}

	async function probe(state) {
		const checkedAt = clock();
		if (!state.configured) return { ok: false, state: 'unconfigured', reachable: null, checkedAt,
			notice: NOTICE.unconfigured, profileResolution: null, profileAccounts: null };
		if (!state.key) return { ok: false, state: 'auth-failed', reachable: null, checkedAt,
			notice: NOTICE.missingKey, profileResolution: 'missing-key', profileAccounts: null };
		let response;
		try {
			response = await fetcher(new URL('/proxy/stats/', state.target), {
				headers: { 'X-API-Key': state.key, Authorization: 'ApiKey ' + state.key },
				redirect: 'error',
				signal: AbortSignal.timeout(STREAMS_TIMEOUT_MS)
			});
		} catch (error) {
			const timedOut = error?.name === 'TimeoutError' || error?.name === 'AbortError';
			return { ok: false, state: timedOut ? 'timeout' : 'unreachable', reachable: false, checkedAt,
				notice: timedOut ? NOTICE.timeout : NOTICE.unreachable };
		}
		if (response.status === 401 || response.status === 403) {
			await discard(response);
			return { ok: false, state: 'auth-failed', reachable: true, checkedAt, notice: NOTICE.auth };
		}
		if (!response.ok) {
			await discard(response);
			return { ok: false, state: 'unreachable', reachable: true, checkedAt, notice: NOTICE.upstream };
		}
		let text;
		try { text = await readLimited(response, STREAMS_BODY_LIMIT); }
		catch (error) {
			return { ok: false, state: error?.code === 'too-large' ? 'too-large' : 'invalid', reachable: true, checkedAt,
				notice: error?.code === 'too-large' ? NOTICE.tooLarge : NOTICE.invalid };
		}
		let data;
		try { data = JSON.parse(text); } catch {
			return { ok: false, state: 'invalid', reachable: true, checkedAt, notice: NOTICE.invalid };
		}
		const sections = [data?.live, data?.vod, data?.catchup].filter(section => section && typeof section === 'object' && !Array.isArray(section));
		if (!data || typeof data !== 'object' || Array.isArray(data) || !sections.length) {
			return { ok: false, state: 'invalid', reachable: true, checkedAt, notice: NOTICE.invalid };
		}
		// Collect every M3U profile id the document reports, then resolve them in
		// one cached accounts read. Only ids that are actually present trigger it.
		const ids = new Set();
		for (const channel of Array.isArray(data?.live?.channels) ? data.live.channels : []) {
			const id = channelProfileId(channel);
			if (id) ids.add(id);
			for (const client of Array.isArray(channel?.clients) ? channel.clients : []) {
				const clientId = clientProfileId(client);
				if (clientId) ids.add(clientId);
			}
		}
		for (const group of Array.isArray(data?.vod?.vod_connections) ? data.vod.vod_connections : []) {
			for (const connection of Array.isArray(group?.connections) ? group.connections : []) {
				const id = clientProfileId(connection);
				if (id) ids.add(id);
			}
		}
		for (const session of Array.isArray(data?.catchup?.timeshift_sessions) ? data.catchup.timeshift_sessions : []) {
			for (const connection of Array.isArray(session?.connections) ? session.connections : []) {
				const id = clientProfileId(connection);
				if (id) ids.add(id);
			}
		}
		const [profileRead, localSessions] = await Promise.all([
			ids.size ? readProfiles(state, ids) : { profiles, resolution: null, accounts: null },
			readSessions()
		]);
		const sanitized = sanitize(data, checkedAt,
			{ profiles: profileRead.profiles, sessions: localSessions });
		return { ok: true, state: 'ok', reachable: true, checkedAt,
			upstreamAt: timeMs(data?.timestamp) ?? checkedAt, notice: NOTICE.ok,
			profileResolution: profileRead.resolution, profileAccounts: profileRead.accounts, ...sanitized };
	}

	async function finish(outcome) {
		if (!outcome.superseded) return outcome.value;
		return emptyPayload(snapshot(), { state: 'unreachable', reachable: null, notice: NOTICE.changed });
	}

	async function build(state, refresh) {
		if (generation !== state.fingerprint) {
			generation = state.fingerprint;
			cache.clear();
			lastGood = null;
		}
		if (!state.enabled) return emptyPayload(state, { state: 'disabled', notice: NOTICE.disabled });
		const now = clock();
		const hit = cache.get(state.fingerprint);
		// ?refresh=1 bypasses the cached reading but never bypasses the
		// single-flight rule: an overlapping call still joins the probe that is
		// already running, exactly like the status monitor.
		if (!refresh && hit && now - hit.at < STREAMS_CACHE_MS) return hit.value;
		if (inflight.has(state.fingerprint)) return finish(await inflight.get(state.fingerprint));

		const running = (async () => {
			const checked = await probe(state);
			if (snapshot().fingerprint !== state.fingerprint) return { superseded: true };
			let value;
			if (checked.ok) {
				lastGood = { fingerprint: state.fingerprint, value: checked };
				value = checked;
			} else if (lastGood?.fingerprint === state.fingerprint) {
				value = { ...lastGood.value, state: 'stale', stale: true, reachable: checked.reachable,
					notice: checked.notice + NOTICE.staleSuffix };
			} else {
				value = emptyPayload(state, { state: checked.state, reachable: checked.reachable,
					checkedAt: checked.checkedAt, notice: checked.notice });
			}
			cache.set(state.fingerprint, { at: clock(), value });
			for (const [key] of cache) if (key !== state.fingerprint && cache.size > 4) cache.delete(key);
			return { value };
		})();

		inflight.set(state.fingerprint, running);
		try { return await finish(await running); }
		finally { if (inflight.get(state.fingerprint) === running) inflight.delete(state.fingerprint); }
	}

	return {
		get: ({ refresh = false } = {}) => build(snapshot(), refresh === true)
	};
}
