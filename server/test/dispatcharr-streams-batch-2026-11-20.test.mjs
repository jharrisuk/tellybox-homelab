/* NIGHT BATCH 2026-11-20: Dispatcharr stream monitor refresh and provider join.
 *
 * ?refresh=1 previously did nothing because get() ignored its options. It now
 * bypasses the 15 s cache while still sharing the in-flight probe. The dead
 * channel-catalogue provider join is removed: the saved snapshot carries no
 * provider, so it can never contribute a real source.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDispatcharrStreams,
	STREAMS_CACHE_MS } from '../homelab/dispatcharr-streams.mjs';

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
const payload = channels => ({ live: { count: channels.length, channels },
	vod: { vod_connections: [] }, catchup: { timeshift_sessions: [] } });

test('refresh bypasses the 15 s cache but joins an in-flight probe', async () => {
	let now = 1_000_000, statsCalls = 0, holdFirst = true;
	let release;
	const gate = new Promise(resolve => { release = resolve; });
	const streams = createDispatcharrStreams({ store: store(config()), clock: () => now,
		fetcher: async url => {
			if (String(url).includes('/api/m3u/accounts/')) return response({ results: [] });
			statsCalls += 1;
			if (holdFirst) { holdFirst = false; await gate; }
			return response(payload([{ channel_name: 'BBC One' }]));
		} });

	const first = streams.get();
	assert.equal(statsCalls, 1, 'the first read starts one probe');
	const overlapping = streams.get({ refresh: true });
	release();
	const [a, b] = await Promise.all([first, overlapping]);
	assert.equal(statsCalls, 1, 'an overlapping refresh joins the probe instead of starting a second one');
	assert.equal(a.state, 'ok');
	assert.equal(b.state, 'ok');

	await streams.get();
	assert.equal(statsCalls, 1, 'a normal read still uses the 15 s cache');

	await streams.get({ refresh: true });
	assert.equal(statsCalls, 2, 'refresh starts a new upstream probe inside the 15 s window');

	now += STREAMS_CACHE_MS + 1;
	await streams.get();
	assert.equal(statsCalls, 3, 'the cache expires on its own interval as before');
});

test('a supplied catalogue is neither read nor used as a provider', async () => {
	let catalogueCalls = 0;
	const body = await createDispatcharrStreams({ store: store(config()),
		catalogue: async () => {
			catalogueCalls += 1;
			return [{ Id: 'one', Name: 'BBC One', Provider: 'Provider One' }];
		},
		fetcher: async url => String(url).includes('/api/m3u/accounts/')
			? response({ results: [] })
			: response(payload([{ channel_name: 'BBC One' }])) }).get();

	assert.equal(catalogueCalls, 0, 'the monitor does not read a catalogue it cannot use');
	assert.equal(body.streams[0].source, null, 'without a real account the source stays unknown');
	assert.equal(JSON.stringify(body).includes('Provider One'), false);
});

test('a real account field on the statistics row is still accepted as the source', async () => {
	const body = await createDispatcharrStreams({ store: store(config()),
		fetcher: async url => String(url).includes('/api/m3u/accounts/')
			? response({ results: [] })
			: response(payload([{ channel_name: 'ITV', provider: 'Real Provider' }])) }).get();
	assert.equal(body.streams[0].source, 'Real Provider');
});
