/* Which upstream stream did Dispatcharr pick?
 *
 * The queue asked for the selected stream (name + id) and, when recorded, the
 * last switch time/reason to be carried through the sanitized monitor. These
 * tests pin the extra allowlist fields and their refusal cases: no URLs, no
 * credential text, no unbounded ids, and no values invented when absent.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createDispatcharrStreams } from '../homelab/dispatcharr-streams.mjs';

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
const accounts = () => ({ results: [{ id: 1, name: 'Provider', profiles: [{ id: 4, name: 'Default live' }] }] });
const row = async (channel, options = {}) => {
	const body = await createDispatcharrStreams({ store: store(config()), ...options,
		fetcher: async url => String(url).includes('/api/m3u/accounts/')
			? response(accounts()) : response(payload([channel])) }).get();
	return body.streams[0];
};

test('a live row carries the picked stream name, id, profile and switch details', async () => {
	const live = await row({
		channel_name: 'BBC One', stream_name: 'BBC One HD', stream_id: 4281,
		m3u_profile_id: 4, state: 'running',
		stream_switch_time: 1763487720, stream_switch_reason: 'failover_to_backup'
	});
	assert.equal(live.streamName, 'BBC One HD');
	assert.equal(live.streamId, '4281');
	assert.equal(live.profile, 'Default live');
	assert.equal(live.switchAt, 1763487720 * 1000, 'epoch seconds are exposed as milliseconds');
	assert.equal(live.switchReason, 'failover to backup', 'an unknown token is humanised');
	assert.equal(live.title, 'BBC One', 'the channel title is unchanged');
});

test('the picked stream is added beside the source, never instead of it', async () => {
	const live = await row({ channel_name: 'BBC One', stream_name: 'BBC One HD', stream_id: '4281' }, {
		catalogue: async () => [{ Id: 'one', Name: 'BBC One', Provider: 'Dispatcharr' }]
	});
	assert.equal(live.source, null, 'Dispatcharr is never a source');
	assert.equal(live.streamName, 'BBC One HD');
	assert.equal(live.streamId, '4281');
});

test('absent stream and switch values stay absent instead of becoming text', async () => {
	const live = await row({ channel_name: 'No metadata' });
	assert.equal(live.streamName, null);
	assert.equal(live.streamId, null);
	assert.equal(live.switchAt, null);
	assert.equal(live.switchReason, null);
	assert.equal('streamName' in live, true, 'the shape is stable; only the value is unknown');
});

test('switch fields appear only when the upstream row records them', async () => {
	const timeOnly = await row({ channel_name: 'Time only', stream_switch_time: '2026-11-18T18:42:00Z' });
	assert.equal(timeOnly.switchAt, Date.parse('2026-11-18T18:42:00Z'));
	assert.equal(timeOnly.switchReason, null);

	const known = await row({ channel_name: 'Known', stream_switch_reason: 'buffering_timeout' });
	assert.equal(known.switchReason, 'buffering timeout');
	assert.equal(known.switchAt, null, 'a reason without a time does not invent one');

	for (const [token, label] of [['manual', 'manual switch'], ['health_monitor', 'health check'],
		['max_retries_exceeded', 'retries exhausted'], ['startup', 'startup']]) {
		assert.equal((await row({ channel_name: token, stream_switch_reason: token })).switchReason, label);
	}
	assert.equal((await row({ channel_name: 'Unknown reason', stream_switch_reason: 'unknown' })).switchReason, null,
		'an unknown reason token is omitted');
});

test('URL-like stream names, ids and reasons are rejected and never leak', async () => {
	const cases = [
		'https://provider.invalid/live/4281.m3u8',
		'http://user:pass@provider.invalid/live',
		'www.provider.invalid/live',
		'provider.invalid/live/4281',
		'rtsp://provider.invalid/stream'
	];
	for (const name of cases) {
		const live = await row({ channel_name: 'Channel', stream_name: name,
			stream_id: 'https://provider.invalid/4281',
			stream_switch_reason: 'see provider.invalid/failover' });
		assert.equal(live.streamName, null, name + ' must not become the stream name');
		assert.equal(live.streamId, null, name + ' must not become the stream id');
		assert.equal(live.switchReason, null, name + ' must not become the switch reason');
		assert.equal(JSON.stringify(live).includes('provider.invalid'), false, name + ' must not leak');
	}
	const noChannelName = await row({ stream_name: 'provider.invalid/live/4281' });
	assert.equal(noChannelName.title, 'Channel 1', 'a URL cannot leak through the title fallback');
	assert.equal(noChannelName.streamName, null);
});

test('credential-looking stream text is rejected', async () => {
	const live = await row({ channel_name: 'Channel', stream_name: 'backup token=abc123',
		stream_id: '4281', stream_switch_reason: 'password=hunter2' });
	assert.equal(live.streamName, null);
	assert.equal(live.switchReason, null);
	const serialized = JSON.stringify(live);
	for (const secret of ['abc123', 'hunter2', 'password', 'token']) {
		assert.equal(serialized.includes(secret), false, 'response must not contain ' + secret);
	}
});

test('stream ids are bounded to numbers or short opaque tokens', async () => {
	const accepted = [[4281, '4281'], [' 4281 ', '4281'], ['stream-4281', 'stream-4281'], ['A1_b2', 'A1_b2']];
	for (const [value, expected] of accepted) {
		assert.equal((await row({ channel_name: 'Id', stream_id: value })).streamId, expected);
	}
	const rejected = ['https://provider.invalid/1', '12/34', 'abc.def', 'x'.repeat(40), '', '   ', -1, 1.5, true, null];
	for (const value of rejected) {
		assert.equal((await row({ channel_name: 'Id', stream_id: value })).streamId, null, String(value) + ' is not an id');
	}
});

test('a metadata bag is accepted when the stats row nests the same fields', async () => {
	const live = await row({ channel_name: 'Nested', metadata: {
		stream_name: 'Nested feed', stream_id: '991', stream_switch_time: 1763487720,
		stream_switch_reason: 'health_monitor'
	} });
	assert.equal(live.streamName, 'Nested feed');
	assert.equal(live.streamId, '991');
	assert.equal(live.switchAt, 1763487720 * 1000);
	assert.equal(live.switchReason, 'health check');
});
