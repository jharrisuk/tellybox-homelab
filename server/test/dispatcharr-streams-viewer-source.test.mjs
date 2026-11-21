/* Source/profile resolution and local viewer attribution for the Streams page.
 *
 * Dispatcharr only ever sees the Tellybox Node server as the playback client,
 * so its user agent cannot identify a phone, TV or browser. The app label is
 * attributed from Tellybox's own active playback entry instead. The owning
 * account and profile name come from a bounded, cached accounts read keyed by
 * the M3U profile id in the statistics document.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDispatcharrStreams, createCachedLocalSessions, STREAMS_CACHE_MS,
	STREAMS_PROFILE_CACHE_MS, STREAMS_PROFILE_RETRY_MS,
	STREAMS_ACCOUNTS_BODY_LIMIT } from '../homelab/dispatcharr-streams.mjs';

const config = (overrides = {}) => ({
	services: {
		dispatcharr: { enabled: true, location: 'anotherServer', url: 'http://dispatcharr.test:9191', key: 'test-key',
			live: true, vod: true, catchup: true, ...overrides }
	}
});
const store = value => ({ get: () => value });
const response = body => new Response(JSON.stringify(body), {
	status: 200, headers: { 'content-type': 'application/json' }
});
const live = channels => ({ live: { count: channels.length, channels },
	vod: { vod_connections: [] }, catchup: { timeshift_sessions: [] } });
// The accounts endpoint used by Dispatcharr embeds profiles per account. The
// fixture covers the live profile 10 and the four accounts proven on site.
const accounts = () => ({ results: [
	{ id: 1, name: 'custom', profiles: [{ id: 1, name: 'custom Default' }] },
	{ id: 7, name: 'TorrentDay2', profiles: [{ id: 7, name: 'TorrentDay2 Default' }] },
	{ id: 10, name: 'Maxiums', profiles: [{ id: 10, name: 'Maxiums Default' }] },
	{ id: 11, name: 'Digital (Maxiumus)', profiles: [{ id: 11, name: 'Digital (Maxiumus) Default' }] }
] });
function harness({ stats, sessions = [], accountsBody = accounts(), failAccounts = false, clock = () => 1_000_000 } = {}) {
	let accountsCalls = 0, statsCalls = 0;
	const streams = createDispatcharrStreams({
		store: store(config()),
		clock,
		sessions: () => sessions,
		fetcher: async url => {
			if (String(url).includes('/api/m3u/accounts/')) {
				accountsCalls += 1;
				if (failAccounts) throw Error('accounts unavailable');
				return response(accountsBody);
			}
			statsCalls += 1;
			return response(stats);
		}
	});
	return { streams, calls: () => ({ accountsCalls, statsCalls }) };
}

test('profile id 10 resolves to Maxiums Default and its owning account Maxiums', async () => {
	const stats = live([{ channel_name: 'ITV', m3u_profile_id: 10, client_count: 1,
		clients: [{ profile_id: 10, user_agent: 'node', output_format: 'mpegts' }] }]);
	const { streams } = harness({ stats });
	const body = await streams.get();
	const row = body.streams[0];
	assert.equal(row.profile, 'Maxiums Default');
	assert.equal(row.source, 'Maxiums');
	assert.equal(row.connections.items[0].profile, 'Maxiums Default');
	assert.equal(row.connections.items[0].source, 'Maxiums');
	assert.equal(JSON.stringify(body).includes('"source":"Dispatcharr"'), false);
});

test('an unresolved profile id is shown as the id rather than a fabricated name', async () => {
	const stats = live([{ channel_name: 'Unknown profile', m3u_profile_id: 99 }]);
	const { streams } = harness({ stats, accountsBody: { results: [] } });
	const row = (await streams.get()).streams[0];
	assert.equal(row.profile, '99');
	assert.equal(row.source, null);
});

test('a stats profile name is kept when the id cannot be resolved', async () => {
	const stats = live([{ channel_name: 'Named profile', m3u_profile_id: 99, m3u_profile_name: 'Mystery Default' }]);
	const { streams } = harness({ stats, accountsBody: { results: [] } });
	const row = (await streams.get()).streams[0];
	assert.equal(row.profile, 'Mystery Default');
	assert.equal(row.source, null);
});

test('the literal Dispatcharr is never rendered as a source', async () => {
	const stats = live([{ channel_name: 'Tautology', provider: 'Dispatcharr', m3u_profile_id: 1,
		clients: [{ provider: 'Dispatcharr' }] }]);
	const { streams } = harness({ stats });
	const body = await streams.get();
	assert.equal(body.streams[0].source, 'custom');
	assert.equal(JSON.stringify(body).includes('"source":"Dispatcharr"'), false);

	const noProfile = await createDispatcharrStreams({ store: store(config()), catalogue: async () => [
		{ Id: 'one', Name: 'Tautology', Provider: 'Dispatcharr' }
	], fetcher: async url => String(url).includes('/api/m3u/accounts/')
		? response({ results: [] }) : response(live([{ channel_name: 'Tautology' }])) }).get();
	assert.equal(noProfile.streams[0].source, null);
	assert.equal(JSON.stringify(noProfile).includes('"source":"Dispatcharr"'), false);
});

test('a channel catalogue cannot invent a provider for a live row', async () => {
	let catalogueCalls = 0;
	const body = await createDispatcharrStreams({ store: store(config()),
		catalogue: async () => {
			catalogueCalls += 1;
			return [{ Id: 'one', Name: 'BBC One', Provider: 'Provider One' }];
		},
		fetcher: async url => String(url).includes('/api/m3u/accounts/')
			? response({ results: [] }) : response(live([{ channel_name: 'BBC One' }])) }).get();
	assert.equal(catalogueCalls, 0, 'the stream monitor no longer reads a catalogue it cannot use');
	assert.equal(body.streams[0].source, null, 'no genuine account name means unknown, never an invented provider');
});

test('the app label comes from the local session, never from the Dispatcharr agent', async () => {
	const sessions = [
		{ title: 'ITV', client: 'android-tv', deviceName: 'BRAVIA 4K VH21 · TV', browser: 'Dalvik/2.1.0', personName: 'James' },
		{ title: 'BBC Two', client: 'android-phone', deviceName: 'Pixel 9', browser: 'Dalvik/2.1.0' },
		{ title: 'Channel 4', client: 'web', deviceName: 'Windows desktop', browser: 'Mozilla/5.0 Chrome/131.0' },
		{ title: 'Five', browser: 'Dalvik/2.1.0 (Linux; U; Android 12)' },
		{ title: 'E4', client: 'android-tv', deviceName: 'TV one' },
		{ title: 'E4', client: 'android-phone', deviceName: 'Phone two' }
	];
	const stats = live([
		'ITV', 'BBC Two', 'Channel 4', 'Five', 'Dave', 'E4'].map(title => ({ channel_name: title, m3u_profile_id: 10,
			client_count: 1, clients: [{ profile_id: 10, user_agent: 'node' }] })));
	const { streams } = harness({ stats, sessions });
	const body = await streams.get();
	const byTitle = Object.fromEntries(body.streams.map(row => [row.title, row]));
	assert.equal(byTitle.ITV.app, 'Android TV - BRAVIA 4K VH21');
	assert.equal(byTitle.ITV.viewer, 'James');
	assert.equal(byTitle['BBC Two'].app, 'Android phone - Pixel 9');
	assert.equal(byTitle['Channel 4'].app, 'Browser - Windows desktop');
	assert.equal(byTitle.Five.app, 'Android app', 'a missing client falls back to the local agent family');
	assert.equal(byTitle.Dave.app, 'Tellybox server', 'no local session is attributed honestly');
	assert.equal(byTitle.E4.app, 'Multiple viewers', 'two possible viewers are never guessed');
	for (const row of body.streams) {
		assert.equal(row.connections.items[0].app, row.app, 'the connection table uses the same label');
	}
	const serialized = JSON.stringify(body);
	assert.equal(serialized.includes('"node"'), false, 'the Dispatcharr agent never appears');
	assert.equal(serialized.includes('user_agent'), false);
	assert.equal(serialized.includes('Dalvik'), false, 'no raw agent is echoed');
});

test('an unknown declared client is humanised; an unknown agent stays Tellybox server', async () => {
	const sessions = [
		{ title: 'One', client: 'steam_deck' },
		{ title: 'Two', browser: 'SyntheticPlayer/9.0' }
	];
	const stats = live([{ channel_name: 'One' }, { channel_name: 'Two' }]);
	const body = await harness({ stats, sessions }).streams.get();
	assert.equal(body.streams[0].app, 'Steam deck');
	assert.equal(body.streams[1].app, 'Tellybox server');
});

test('the accounts read is cached, bounded and retried after a failure', async () => {
	let now = 1_000_000;
	const stats = live([{ channel_name: 'ITV', m3u_profile_id: 10 }]);
	const first = harness({ stats, clock: () => now });
	await first.streams.get();
	assert.equal(first.calls().accountsCalls, 1);
	now += STREAMS_CACHE_MS + 1;
	await first.streams.get();
	assert.equal(first.calls().statsCalls, 2, 'a new stats probe ran');
	assert.equal(first.calls().accountsCalls, 1, 'the profile cache outlives the stats cache');
	now += STREAMS_PROFILE_CACHE_MS + 1;
	await first.streams.get();
	assert.equal(first.calls().accountsCalls, 2, 'the profile cache expires on its own TTL');

	let retryNow = 2_000_000;
	const failing = harness({ stats, failAccounts: true, clock: () => retryNow });
	const fallback = await failing.streams.get();
	assert.equal(fallback.state, 'ok', 'an accounts failure does not fail the stream report');
	assert.equal(fallback.streams[0].profile, '10', 'the id is shown while names are unavailable');
	assert.equal(fallback.streams[0].source, null);
	assert.equal(failing.calls().accountsCalls, 1);
	retryNow += 1000;
	await failing.streams.get();
	assert.equal(failing.calls().accountsCalls, 1, 'the stats cache governs the next probe');
	retryNow += STREAMS_CACHE_MS + 1;
	await failing.streams.get();
	assert.equal(failing.calls().accountsCalls, 1, 'a failed read is not retried inside its short cooldown');
	assert.equal(failing.calls().statsCalls, 2);
	retryNow += STREAMS_PROFILE_RETRY_MS + 1;
	await failing.streams.get();
	assert.equal(failing.calls().accountsCalls, 2, 'the failed read is retried after its short cooldown');
});

test('createCachedLocalSessions reads recent playback only, bounded and sanitised', () => {
	const directory = mkdtempSync(path.join(tmpdir(), 'tellybox-streams-sessions-'));
	try {
		let now = 1_000_000;
		const file = path.join(directory, 'activity.json');
		writeFileSync(file, JSON.stringify([
			{ type: 'playback', state: 'playing', updated: now - 1000, title: 'ITV', client: 'android-tv',
				deviceName: 'BRAVIA 4K VH21 · TV', browser: 'Dalvik/2.1.0', personName: 'James' },
			{ type: 'playback', state: 'ended', updated: now - 500, title: 'Ended' },
			{ type: 'playback', purpose: 'download', state: 'downloading', updated: now, title: 'Download' },
			{ type: 'playback', state: 'playing', updated: now - 200000, title: 'Stale' },
			{ type: 'login_success', updated: now, title: 'Login' },
			{ type: 'playback', state: 'playing', updated: now, title: 'https://private.invalid/channel' }
		]));
		const read = createCachedLocalSessions({ directory, clock: () => now });
		const sessions = read();
		assert.equal(sessions.length, 2, 'only recent, non-download playback entries are candidates');
		assert.equal(sessions[0].title, 'ITV');
		assert.equal(sessions[0].client, 'android-tv');
		assert.equal(sessions[0].deviceName, 'BRAVIA 4K VH21 · TV');
		assert.equal(sessions[1].title, null, 'a URL-like title is dropped');
		writeFileSync(file, JSON.stringify([{ type: 'playback', state: 'playing', updated: now, title: 'Renamed' }]));
		assert.equal(read()[0].title, 'ITV', 'the session read is briefly cached');
		now += 2000;
		assert.equal(read()[0].title, 'Renamed');
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test('the cached local activity reader drives the same attribution end to end', async () => {
	const directory = mkdtempSync(path.join(tmpdir(), 'tellybox-streams-e2e-'));
	try {
		const now = 1_000_000;
		mkdirSync(path.join(directory, 'access'), { recursive: true });
		writeFileSync(path.join(directory, 'access', 'activity.json'), JSON.stringify([{
			type: 'playback', state: 'playing', updated: now, title: 'ITV', client: 'android-tv',
			deviceName: 'BRAVIA 4K VH21 · TV', browser: 'Dalvik/2.1.0', personName: 'James'
		}]));
		const stats = live([{ channel_name: 'ITV', m3u_profile_id: 10,
			clients: [{ profile_id: 10, user_agent: 'node' }] }]);
		const streams = createDispatcharrStreams({ store: store(config()), clock: () => now,
			sessions: createCachedLocalSessions({ directory: path.join(directory, 'access'), clock: () => now }),
			fetcher: async url => String(url).includes('/api/m3u/accounts/')
				? response(accounts()) : response(stats) });
		const row = (await streams.get()).streams[0];
		assert.equal(row.app, 'Android TV - BRAVIA 4K VH21');
		assert.equal(row.viewer, 'James');
		assert.equal(row.connections.items[0].app, 'Android TV - BRAVIA 4K VH21');
		assert.equal(JSON.stringify(row).includes('node'), false);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test('a realistic 1 MB accounts payload still resolves names and reports ok', async () => {
	const stats = live([{ channel_name: 'ITV', m3u_profile_id: 10, client_count: 1,
		clients: [{ profile_id: 10, user_agent: 'node' }] }]);
	const padded = { results: accounts().results.map(account => ({ ...account,
		padding: 'x'.repeat(700000), password: 'account-password-abc',
		server_url: 'https://private.invalid/provider-account' })) };
	assert.ok(JSON.stringify(padded).length > 512 * 1024, 'the fixture is larger than the old 512 KiB limit');
	assert.ok(JSON.stringify(padded).length < STREAMS_ACCOUNTS_BODY_LIMIT);
	const body = await harness({ stats, accountsBody: padded }).streams.get();
	const row = body.streams[0];
	assert.equal(body.profileResolution, 'ok');
	assert.equal(body.profileAccounts, 4);
	assert.equal(row.profile, 'Maxiums Default');
	assert.equal(row.source, 'Maxiums');
	const serialized = JSON.stringify(body);
	assert.equal(serialized.includes('account-password-abc'), false, 'account passwords are discarded');
	assert.equal(serialized.includes('private.invalid'), false, 'provider URLs are discarded');
});

test('an accounts payload over the new limit reports too-large and falls back to the id', async () => {
	const stats = live([{ channel_name: 'ITV', m3u_profile_id: 10, client_count: 0 }]);
	const oversized = { results: [{ ...accounts().results[2], padding: 'x'.repeat(STREAMS_ACCOUNTS_BODY_LIMIT) }] };
	const { streams, calls } = harness({ stats, accountsBody: oversized });
	const body = await streams.get();
	assert.equal(calls().accountsCalls, 1);
	assert.equal(body.state, 'ok', 'the stream report itself still succeeds');
	assert.equal(body.profileResolution, 'too-large');
	assert.equal(body.profileAccounts, null);
	assert.equal(body.streams[0].profile, '10', 'an unresolved id is shown rather than a name');
	assert.equal(body.streams[0].source, null);
	assert.equal(JSON.stringify(body).includes('xxxxx'), false, 'no part of the accounts body is returned');
});

test('a channel-level profile id triggers the read with no client connections', async () => {
	const stats = live([{ channel_name: 'ITV', m3u_profile_id: 10, client_count: 0, clients: [] }]);
	const { streams, calls } = harness({ stats });
	const body = await streams.get();
	assert.equal(body.reported.liveClients, 0, 'the channel is genuinely idle');
	assert.equal(calls().accountsCalls, 1, 'the channel id alone is enough');
	assert.equal(body.profileResolution, 'ok');
	assert.equal(body.profileAccounts, 4);
	assert.equal(body.streams[0].profile, 'Maxiums Default');
	assert.equal(body.streams[0].source, 'Maxiums');
});

test('profile ids are collected from live, VOD and catch-up connections', async () => {
	const stats = {
		live: { count: 0, channels: [] },
		vod: { vod_connections: [{ content_name: 'Film', connections: [{ profile_id: 7 }] }] },
		catchup: { timeshift_sessions: [{ channel_name: 'ITV', connections: [{ profile_id: 11 }] }] }
	};
	const { streams, calls } = harness({ stats });
	const body = await streams.get();
	const vod = body.streams.find(row => row.kind === 'vod');
	const catchup = body.streams.find(row => row.kind === 'catchup');
	assert.equal(vod.profile, 'TorrentDay2 Default');
	assert.equal(vod.source, 'TorrentDay2');
	assert.equal(catchup.profile, 'Digital (Maxiumus) Default');
	assert.equal(catchup.source, 'Digital (Maxiumus)');
	assert.equal(calls().accountsCalls, 1, 'one accounts read resolves every id in the report');
});
