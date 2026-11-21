/* No provider join for the sanitized Dispatcharr stream monitor.
 *
 * Live /proxy/stats/ rows name the channel but the saved channel snapshot has
 * no provider field. The streams view previously joined that snapshot and
 * could only ever produce the fabricated literal "Dispatcharr", which the
 * source filter then discarded. The join is gone: a source is a genuine
 * account name from the statistics document or the accounts endpoint, and
 * anything else stays unknown.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createDispatcharrStreams, createCachedCatalogue,
	STREAMS_CATALOGUE_CACHE_MS } from '../homelab/dispatcharr-streams.mjs';

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
const live = channels => ({ live: { count: channels.length, channels }, vod: { vod_connections: [] },
	catchup: { timeshift_sessions: [] } });

test('the stream monitor never reads a channel catalogue for a provider', async () => {
	let catalogueCalls = 0, statsCalls = 0;
	const body = await createDispatcharrStreams({ store: store(config()),
		catalogue: async () => {
			catalogueCalls += 1;
			return [{ Id: 'one', Name: 'BBC One', Provider: 'Provider One' }];
		},
		fetcher: async url => {
			if (String(url).includes('/api/m3u/accounts/')) return response({ results: [] });
			statsCalls += 1;
			return response(live([{ channel_name: 'BBC One', clients: [{}] }]));
		} }).get();
	assert.equal(statsCalls, 1);
	assert.equal(catalogueCalls, 0, 'a catalogue it cannot use is not read at all');
	const row = body.streams[0];
	assert.equal(row.source, null, 'a live row without an account name stays unknown');
	assert.equal(row.connections.items[0].source, null);
	assert.equal(JSON.stringify(body).includes('Provider One'), false, 'a catalogue provider never reaches the response');
});

test('the saved channel snapshot does not invent a Dispatcharr provider', () => {
	const directory = mkdtempSync(path.join(tmpdir(), 'tellybox-streams-catalogue-'));
	try {
		mkdirSync(path.join(directory, 'access'), { recursive: true });
		const file = path.join(directory, 'access', 'dispatcharr.json.channels-cache.json');
		const uuid = '01234567-89ab-cdef-0123-456789abcdef';
		writeFileSync(file, JSON.stringify({ origin: 'http://dispatcharr.test:9191', time: 1,
			items: [
				{ id: uuid, name: 'BBC One', number: '1', group: '24/7' },
				{ id: 'not-a-stream-id', name: 'Ignored' }
			] }));
		let now = 1_000_000;
		const read = createCachedCatalogue({ directory, clock: () => now });
		const first = read();
		assert.deepEqual(first, [{ Id: 'dispatch-live-' + uuid, Name: 'BBC One' }],
			'only a usable id and the snapshot name are kept');
		assert.equal(Object.hasOwn(first[0], 'Provider'), false, 'no provider is fabricated for the snapshot');

		writeFileSync(file, JSON.stringify({ items: [{ id: uuid, name: 'Renamed', group: '24/7' }] }));
		assert.equal(read()[0].Name, 'BBC One', 'the snapshot is reused inside the bounded interval');
		now += STREAMS_CATALOGUE_CACHE_MS + 1;
		assert.equal(read()[0].Name, 'Renamed', 'the next interval reads the refreshed snapshot');

		const missing = createCachedCatalogue({ directory: path.join(directory, 'absent'), clock: () => now });
		assert.deepEqual(missing(), [], 'a missing cache is an empty catalogue, not an error');
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
});

test('a genuine statistics account name is still shown as the source', async () => {
	const body = await createDispatcharrStreams({ store: store(config()),
		fetcher: async url => String(url).includes('/api/m3u/accounts/')
			? response({ results: [] })
			: response(live([{ channel_name: 'ITV', m3u_account_name: 'Real Account' }])) }).get();
	assert.equal(body.streams[0].source, 'Real Account');
});
