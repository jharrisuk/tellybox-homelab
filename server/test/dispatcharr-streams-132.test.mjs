/* Release 132: sanitized Dispatcharr stream monitor.
 *
 * The upstream /proxy/stats/ document contains provider URLs, credentials,
 * raw session/client ids, IPs and user agents. These tests assert the small
 * allowlisted response and the transport/cache semantics that make it safe.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDispatcharrStreams, STREAMS_BODY_LIMIT, STREAMS_CACHE_MS } from '../homelab/dispatcharr-streams.mjs';

const config = (overrides = {}) => ({
	services: {
		dispatcharr: { enabled: true, location: 'anotherServer', url: 'http://dispatcharr.test:9191', key: 'secret-key',
			live: true, vod: true, catchup: true, ...overrides }
	}
});
const store = value => ({ get: () => value });

const response = body => new Response(typeof body === 'string' ? body : JSON.stringify(body), {
	status: 200, headers: { 'content-type': 'application/json' }
});

const payload = () => ({
	timestamp: 1763500000,
	live: {
		count: 2,
		channels: [
			{ channel_id: 123, channel_name: 'BBC One', state: 'running', started_at: 1763499000,
				stream_profile: 'Default live', video_codec: 'h264', audio_codec: 'aac', audio_channels: 2,
				resolution: '1920x1080', source_fps: 25, stream_type: 'hls', avg_bitrate_kbps: 4200.5,
				total_bytes: 999999, client_count: 12, m3u_profile_id: 42,
				url: 'http://user:pass@provider.example/stream?token=abc',
				clients: Array.from({ length: 11 }, (_, index) => ({ user_agent: 'Mozilla/5.0 Chrome/120',
					output_format: 'mpegts', connected_at: 1763499100 + index, output_profile_id: 7,
					client_id: 'raw-client-' + index, client_ip: '10.1.2.3' })) },
			{ channel_name: 'Unknown channel', client_count: 0 }
		]
	},
	vod: {
		total_connections: 3,
		timestamp: 1763500000,
		vod_connections: [
			{ content_name: 'Film A', content_type: 'movie', connections: [
				{ m3u_profile: { profile_name: 'Default VOD', account_name: 'Provider X' }, duration: 120,
					connected_at: 1763499000, bytes_sent: 10, client_id: 'sess-1', user_id: 'u1', client_ip: '10.1.2.3' },
				{ m3u_profile: { profile_name: 'Default VOD', account_name: 'Provider X' }, duration: 90,
					connected_at: 1763499500, bytes_sent: 20, client_id: 'sess-2' }
			] },
			{ content_name: 'Show B', content_type: 'episode', connections: [
				{ m3u_profile: { profile_name: 'Second', account_name: 'Provider X' }, duration: 30, connected_at: 1763499600 }
			] }
		]
	},
	catchup: {
		total_connections: 2,
		timestamp: 1763500000,
		timeshift_sessions: [
			{ session_id: 'sess-x', stats_channel_id: 99, channel_uuid: 'uuid', channel_name: 'ITV', paused: true,
				programme_start: '2026-11-18T18:00:00Z', video_codec: 'h264', audio_codec: 'aac', audio_channels: 2,
				resolution: '1280x720', source_fps: 50, stream_type: 'hls',
				connections: [
					{ duration: 60, connected_at: 1763499700, bytes_streamed: 500000, avg_bitrate_kbps: 2500,
						m3u_profile: { profile_name: 'Catchup', account_name: 'Provider Y' }, client_id: 'c1', client_ip: '10.0.0.9' },
					{ duration: 40, connected_at: 1763499750, bytes_streamed: 500000, avg_bitrate_kbps: 2500,
						m3u_profile: { profile_name: 'Catchup', account_name: 'Provider Y' }, client_id: 'c2' }
				] }
		]
	}
});

test('sanitized rows keep supported fields and never leak upstream secrets', async () => {
	let calls = 0;
	const streams = createDispatcharrStreams({ store: store(config()), fetcher: async (url, options) => {
		assert.equal(options.headers['X-API-Key'], 'secret-key');
		assert.equal(options.headers.Authorization, 'ApiKey secret-key');
		assert.equal(options.redirect, 'error');
		if (String(url) === 'http://dispatcharr.test:9191/api/m3u/accounts/') {
			return response({ results: [{ id: 1, name: 'custom', profiles: [{ id: 42, name: 'custom Default' }] }] });
		}
		calls += 1;
		assert.equal(String(url), 'http://dispatcharr.test:9191/proxy/stats/');
		return response(payload());
	} });
	const body = await streams.get();
	assert.equal(calls, 1);
	assert.equal(body.state, 'ok');
	assert.equal(body.reported.liveChannels, 2);
	assert.equal(body.reported.liveClients, 12);
	assert.equal(body.reported.vodConnections, 3);
	assert.equal(body.reported.catchupConnections, 2);
	assert.equal(body.rowsReported, 5);
	assert.equal(body.rowsShown, 5);

	const serialized = JSON.stringify(body);
	for (const secret of ['provider.example', 'user:pass', '10.1.2.3', '10.0.0.9', 'secret-key', 'sess-1', 'sess-x',
		'raw-client', 'client_id', 'channel_id', 'm3u_profile_id', 'output_profile_id', 'user_agent', 'Mozilla', 'uuid',
		'stats_channel_id']) {
		assert.equal(serialized.includes(secret), false, 'response must not contain ' + secret);
	}

	const live = body.streams.find(row => row.kind === 'live');
	assert.equal(live.title, 'BBC One');
	assert.equal(live.source, 'custom', 'the M3U profile id resolves its owning account');
	assert.equal(live.profile, 'custom Default', 'the profile id resolves its name');
	assert.equal(live.connections.items[0].app, 'Tellybox server', 'the Dispatcharr agent is never an app label');
	assert.equal(live.codec, 'h264');
	assert.equal(live.resolution, '1920x1080');
	assert.equal(live.fps, 25);
	assert.equal(live.audio, 'aac 2ch');
	assert.equal(live.averageBitrateKbps, 4200.5);
	assert.equal(live.bytes, 999999);
	assert.equal(live.connections.reported, 12);
	assert.equal(live.connections.shown, 10);
	assert.equal(live.connections.truncated, true);
	assert.equal(live.connections.items[0].id, 'Connection 1');
	assert.equal(live.connections.items[0].source, 'custom');
	assert.equal(live.connections.items[0].profile, 'custom Default');
	assert.equal(live.connections.items[0].format, 'mpegts');

	const unknown = body.streams.filter(row => row.kind === 'live')[1];
	assert.equal(unknown.title, 'Unknown channel');
	assert.equal(unknown.codec, null, 'a missing codec stays unknown, never invented');
	assert.equal(unknown.connections.reported, 0);

	const vod = body.streams.find(row => row.kind === 'vod');
	assert.equal(vod.title, 'Film A');
	assert.equal(vod.typeLabel, 'VOD');
	assert.equal(vod.source, 'Provider X');
	assert.equal(vod.profile, 'Default VOD');
	assert.equal(vod.codec, null, 'VOD codec is unsupported in this payload');
	assert.equal(vod.averageBitrateKbps, null);
	assert.match(vod.note, /do not report codec/i);

	const catchup = body.streams.find(row => row.kind === 'catchup');
	assert.equal(catchup.title, 'ITV');
	assert.equal(catchup.state, 'paused');
	assert.equal(catchup.bytes, 500000, 'catch-up bytes are shown once, not summed across connections');
	assert.equal(catchup.averageBitrateKbps, 2500);
	assert.match(catchup.note, /not summed/i);
	assert.equal(catchup.connections.reported, 2);
});

test('empty successful payload is ok/zero, not a health claim', async () => {
	const streams = createDispatcharrStreams({ store: store(config()),
		fetcher: async () => response({ live: { channels: [], count: 0 }, vod: { vod_connections: [], total_connections: 0 }, catchup: { timeshift_sessions: [], total_connections: 0 } }) });
	const body = await streams.get();
	assert.equal(body.state, 'ok');
	assert.equal(body.rowsShown, 0);
	assert.equal(body.reported.liveChannels, 0);
	assert.equal(body.reported.vodConnections, 0);
	assert.match(body.notice, /may be incomplete/i);
});

test('auth, timeout, malformed, oversize and upstream errors are distinct', async () => {
	const states = [];
	states.push(await createDispatcharrStreams({ store: store(config()), fetcher: async () => new Response('{}', { status: 401 }) }).get());
	states.push(await createDispatcharrStreams({ store: store(config()), fetcher: async () => { throw Object.assign(Error('timeout'), { name: 'TimeoutError' }); } }).get());
	states.push(await createDispatcharrStreams({ store: store(config()), fetcher: async () => response('{not json') }).get());
	states.push(await createDispatcharrStreams({ store: store(config()), fetcher: async () => response('x'.repeat(STREAMS_BODY_LIMIT + 10)) }).get());
	states.push(await createDispatcharrStreams({ store: store(config()), fetcher: async () => new Response('{}', { status: 500 }) }).get());
	assert.deepEqual(states.map(value => value.state), ['auth-failed', 'timeout', 'invalid', 'too-large', 'unreachable']);
	for (const value of states) {
		assert.equal(value.streams.length, 0);
		assert.equal(value.reported.liveChannels, null, 'an error is never zero');
	}
});

test('partial payloads keep unknown separate from zero', async () => {
	const vodOnly = await createDispatcharrStreams({ store: store(config()),
		fetcher: async () => response({ vod: { vod_connections: [], total_connections: 0 } }) }).get();
	assert.equal(vodOnly.reported.liveChannels, null);
	assert.equal(vodOnly.reported.liveClients, null, 'an absent live section is unknown, never zero');

	const countOnly = await createDispatcharrStreams({ store: store(config()),
		fetcher: async () => response({ live: { count: 5 } }) }).get();
	assert.equal(countOnly.reported.liveChannels, 5);
	assert.equal(countOnly.reported.liveClients, null, 'a count without channel details does not prove zero clients');

	const emptyLive = await createDispatcharrStreams({ store: store(config()),
		fetcher: async () => response({ live: { channels: [], count: 0 } }) }).get();
	assert.equal(emptyLive.reported.liveChannels, 0);
	assert.equal(emptyLive.reported.liveClients, 0, 'a confirmed empty live section is a real zero');
});

test('cache, refresh, single-flight and stale-last-good', async () => {
	let now = 1_000_000, calls = 0, fail = false;
	const streams = createDispatcharrStreams({ store: store(config()), clock: () => now, fetcher: async url => {
		if (String(url).includes('/api/m3u/accounts/')) return response({ results: [] });
		calls += 1;
		await new Promise(resolve => setTimeout(resolve, 5));
		if (fail) throw Object.assign(Error('down'), { name: 'Error' });
		return response(payload());
	} });
	const first = await streams.get();
	await streams.get();
	assert.equal(calls, 1, 'the 15 s cache serves the second call');
	await streams.get({ refresh: true });
	assert.equal(calls, 2, 'manual refresh performs a new check inside the 15 s window');
	for (let index = 0; index < 5; index += 1) await streams.get({ refresh: true });
	assert.equal(calls, 7, 'each sequential refresh performs one upstream check');
	now += STREAMS_CACHE_MS + 1;
	await streams.get({ refresh: true });
	assert.equal(calls, 8, 'a refresh after the interval performs one new check');
	now += STREAMS_CACHE_MS + 1;
	fail = true;
	const stale = await streams.get();
	assert.equal(stale.state, 'stale');
	assert.equal(stale.stale, true);
	assert.equal(stale.streams.length, first.streams.length, 'the last good sanitized report is retained');
	assert.match(stale.notice, /last successful/i);

	fail = false; calls = 0; now += STREAMS_CACHE_MS + 1;
	const [a, b] = await Promise.all([streams.get({ refresh: true }), streams.get({ refresh: true })]);
	assert.equal(calls, 1, 'concurrent admins join one in-flight request');
	assert.equal(a.state, 'ok');
	assert.equal(b.state, 'ok');
});

test('null, false and blank fields stay unknown instead of becoming zero', async () => {
	const data = {
		live: { count: null, channels: [{ channel_name: 'Null values', client_count: null,
			source_fps: null, avg_bitrate_kbps: null, total_bytes: null, source_fps_text: ' ',
			clients: [{ duration: null, output_format: '' }] }] },
		vod: { total_connections: null, vod_connections: [{ content_name: 'Unknown VOD',
			connections: [{ duration: null }] }] },
		catchup: { total_connections: null, timeshift_sessions: [] }
	};
	const body = await createDispatcharrStreams({ store: store(config()),
		fetcher: async () => response(data) }).get();
	const live = body.streams[0];
	assert.equal(body.reported.liveChannels, 1, 'the listed channel is known');
	assert.equal(body.reported.liveClients, null, 'a null channel count is unknown, not zero');
	assert.equal(body.reported.vodConnections, 1, 'the listed VOD connection is counted, not zero');
	assert.equal(body.reported.catchupConnections, null);
	assert.equal(live.fps, null);
	assert.equal(live.averageBitrateKbps, null);
	assert.equal(live.bytes, null);
	assert.equal(live.connections.reported, 1, 'a shown connection is not reported as zero');
	assert.equal(live.connections.items[0].format, null, 'a blank format is unknown');
	assert.equal(live.connections.items[0].durationSeconds, null);

	const empty = await createDispatcharrStreams({ store: store(config()),
		fetcher: async () => response({ live: { channels: [{ channel_name: 'No details' }] } }) }).get();
	assert.equal(empty.streams[0].connections.reported, null, 'no count and no details is unknown');

	const zero = await createDispatcharrStreams({ store: store(config()),
		fetcher: async () => response({ live: { count: 0, channels: [] } }) }).get();
	assert.equal(zero.reported.liveClients, 0, 'a confirmed empty live section is zero');
});

test('mixed VOD providers are not labelled with the first connection', async () => {
	const data = {
		live: { channels: [], count: 0 },
		vod: { total_connections: 2, vod_connections: [{ content_name: 'Shared title', connections: [
			{ m3u_profile: { account_name: 'Provider A', profile_name: 'A' }, duration: 10 },
			{ m3u_profile: { account_name: 'Provider B', profile_name: 'B' }, duration: 20 }
		] }] },
		catchup: { total_connections: 2, timeshift_sessions: [{ channel_name: 'Shared catchup', connections: [
			{ m3u_profile: { account_name: 'Provider A', profile_name: 'A' }, duration: 10 },
			{ m3u_profile: { account_name: 'Provider B', profile_name: 'B' }, duration: 20 }
		] }] }
	};
	const body = await createDispatcharrStreams({ store: store(config()), fetcher: async () => response(data) }).get();
	const vod = body.streams.find(row => row.kind === 'vod');
	assert.equal(vod.source, 'Multiple sources');
	assert.equal(vod.profile, 'Multiple profiles');
	assert.deepEqual(vod.connections.items.map(item => [item.source, item.profile]),
		[['Provider A', 'A'], ['Provider B', 'B']], 'per-connection labels are preserved');
	const catchup = body.streams.find(row => row.kind === 'catchup');
	assert.equal(catchup.source, 'Multiple sources');
	assert.equal(catchup.connections.items[1].profile, 'B');

	const agreed = await createDispatcharrStreams({ store: store(config()), fetcher: async () => response({
		live: { channels: [], count: 0 },
		vod: { total_connections: 2, vod_connections: [{ content_name: 'Same', connections: [
			{ m3u_profile: { account_name: 'Provider A', profile_name: 'A' } },
			{ m3u_profile: { account_name: 'Provider A', profile_name: 'A' } }] }] }
	}) }).get();
	assert.equal(agreed.streams[0].source, 'Provider A', 'an agreeing group keeps its label');
});

test('VOD and catchup group labels preserve partially unknown provider and profile information', async () => {
	const known = { m3u_profile: { account_name: 'Provider A', profile_name: 'Profile A' } };
	const cases = [
		['missing', {}, null, null],
		['null', { m3u_profile: { account_name: null, profile_name: null } }, null, null],
		['blank', { m3u_profile: { account_name: '  ', profile_name: '' } }, null, null],
		['rejected URL', { m3u_profile: { account_name: 'https://provider.invalid/private', profile_name: 'http://profile.invalid/private' } }, null, null],
		['all known A', known, 'Provider A', 'Profile A'],
		['all known A+B', { m3u_profile: { account_name: 'Provider B', profile_name: 'Profile B' } }, 'Multiple sources', 'Multiple profiles'],
		['unknown provider only', { m3u_profile: { profile_name: 'Profile A' } }, null, 'Profile A'],
		['unknown profile only', { m3u_profile: { account_name: 'Provider A' } }, 'Provider A', null]
	];
	for (const kind of ['vod', 'catchup']) {
		for (const [name, second, provider, profile] of cases) {
			const group = { content_name: 'Title', channel_name: 'Channel', connections: [known, second] };
			const data = kind === 'vod' ? { vod: { vod_connections: [group] } } : { catchup: { timeshift_sessions: [group] } };
			const body = await createDispatcharrStreams({ store: store(config()), fetcher: async () => response(data) }).get();
			const row = body.streams.find(item => item.kind === kind);
			assert.equal(row.source, provider, `${kind}: ${name} group source`);
			assert.equal(row.profile, profile, `${kind}: ${name} group profile`);
			assert.equal(row.connections.items[0].source, 'Provider A', `${kind}: ${name} known connection source retained`);
			assert.equal(row.connections.items[0].profile, 'Profile A', `${kind}: ${name} known connection profile retained`);
			if (provider === null) assert.equal(row.connections.items[1].source, null);
			if (profile === null) assert.equal(row.connections.items[1].profile, null);
			assert.equal(JSON.stringify(row).includes('.invalid/private'), false, 'rejected URLs must not leak');
		}
	}
});

test('a genuine account name is used as the source, but Dispatcharr is never echoed', async () => {
	const data = {
		live: { channels: [
			{ channel_name: 'Named channel', provider: 'Dispatcharr', client_count: 1,
				clients: [{ user_agent: 'Dalvik/2.1.0', provider: 'Provider A' }] },
			{ channel_name: 'Client account', client_count: 2,
				clients: [{ account_name: 'Provider B' }, { account_name: 'Provider B' }] },
			{ channel_name: 'Mixed clients', client_count: 2,
				clients: [{ provider: 'Provider A' }, { provider: 'Provider B' }] },
			{ channel_name: 'Private provider', provider: 'https://private.invalid/account', client_count: 0, clients: [] },
			{ channel_name: 'Unknown provider', client_count: 0, clients: [] }
		] },
		vod: { total_connections: 0, vod_connections: [] },
		catchup: { total_connections: 0, timeshift_sessions: [] }
	};
	const body = await createDispatcharrStreams({ store: store(config()), fetcher: async () => response(data) }).get();
	const rows = body.streams.filter(row => row.kind === 'live');
	assert.equal(rows[0].source, 'Provider A', 'a genuine connection account is used');
	assert.equal(rows[0].connections.items[0].source, 'Provider A');
	assert.equal(rows[0].connections.items[0].app, 'Tellybox server', 'the Dispatcharr agent is never an app label');
	assert.equal(rows[1].source, 'Provider B', 'agreeing client account names identify the source');
	assert.equal(rows[2].source, 'Multiple sources', 'mixed client accounts stay explicitly mixed');
	assert.equal(rows[3].source, null, 'a provider URL is not echoed');
	assert.equal(rows[4].source, null, 'a genuinely absent source stays unknown');
	assert.equal(rows[0].source === 'Dispatcharr', false, 'the literal Dispatcharr is never a source');
	const serialized = JSON.stringify(body);
	assert.equal(serialized.includes('private.invalid'), false);
});

test('Dispatcharr client agents never become app labels', async () => {
	const agents = [
		'Dalvik/2.1.0 (Linux; U; Android 17; SM-F966B Build/TP1A.220624.014)',
		'okhttp/4.12.0',
		'ExoPlayerLib/2.19.1',
		'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36',
		'node',
		'SyntheticPlayer/9.0'
	];
	const data = { live: { channels: [{ channel_name: 'Agents', client_count: agents.length,
		clients: agents.map((user_agent, index) => ({ user_agent, profile_id: index + 1 })) }] },
		vod: { vod_connections: [] }, catchup: { timeshift_sessions: [] } };
	const body = await createDispatcharrStreams({ store: store(config()), fetcher: async url =>
		String(url).includes('/api/m3u/accounts/') ? response({ results: [] }) : response(data) }).get();
	const items = body.streams.find(row => row.kind === 'live').connections.items;
	assert.deepEqual(items.map(item => item.app), agents.map(() => 'Tellybox server'),
		'a Dispatcharr agent is never used to claim a phone, TV or browser');
	assert.equal(JSON.stringify(body).includes('Dalvik'), false, 'raw agents are never returned');
	assert.equal(JSON.stringify(body).includes('"node"'), false, 'the node agent is never returned');
});

test('a source/key change invalidates cached and last-good data', async () => {
	let current = config(), calls = 0;
	const streams = createDispatcharrStreams({ store: { get: () => current }, fetcher: async url => {
		if (String(url).includes('/api/m3u/accounts/')) return response({ results: [] });
		calls += 1;
		return response(calls === 1 ? payload() : { live: { channels: [], count: 0 }, vod: {}, catchup: {} });
	} });
	await streams.get();
	current = config({ key: 'rotated-key' });
	const next = await streams.get();
	assert.equal(calls, 2, 'a rotated key starts a new generation');
	assert.equal(next.reported.liveChannels, 0);
});

test('disabled and unconfigured never call upstream', async () => {
	for (const [value, state] of [[config({ enabled: false }), 'disabled'], [config({ url: '' }), 'unconfigured']]) {
		let calls = 0;
		const streams = createDispatcharrStreams({ store: store(value), fetcher: async () => { calls += 1; return response(payload()); } });
		const body = await streams.get();
		assert.equal(calls, 0);
		assert.equal(body.state, state);
		assert.equal(body.reported.liveChannels, null);
	}
});

