import test from 'node:test';
import assert from 'node:assert/strict';
import { assembleGuide, createLiveGuide } from '../live-tv.mjs';

const now = Date.parse('2026-10-18T18:00:00Z');
const until = now + 6 * 3600000;
const programme = (name, start, end, extra = {}) => ({ ChannelId: 'a', Name: name, StartDate: `2026-10-18T${start}:00Z`, EndDate: `2026-10-18T${end}:00Z`, ...extra });

test('guide associates schedules with their channel, handles gaps and strips upstream fields', () => {
	const channels = [{ Id: 'a', Name: 'One', ChannelNumber: '1', CurrentProgram: programme('Now', '17:30', '18:30') }, { Id: 'b', Name: 'No listings' }];
	const result = assembleGuide(channels, [
		programme('Next', '19:00', '19:30', { ProviderIds: { secret: 'hidden' } }),
		programme('Expired', '17:00', '18:00'),
		programme('Now', '17:30', '18:30', { Overview: 'Full description' }),
		programme('Unrelated', '18:00', '19:00', { ChannelId: 'other' }),
		programme('Invalid', '19:30', '19:00'),
		programme('Outside window', '23:59', '23:59')
	], now, until);
	assert.deepEqual(result[0].programmes.map(p => p.Name), ['Now', 'Next']);
	assert.equal(result[0].programmes[0].Overview, 'Full description');
	assert.equal(result[0].programmes[1].ProviderIds, undefined);
	assert.deepEqual(result[1].programmes, []);
	assert.equal(result[0].ChannelNumber, '1');
});

test('guide survives missing EPG, expires cache and coalesces simultaneous requests', async () => {
	let clock = now;
	let calls = 0;
	let fail = true;
	const get = createLiveGuide(async route => {
		calls++;
		const url = new URL(route, 'http://test');
		assert.equal(url.searchParams.get('UserId'), 'viewer');
		if (url.pathname.endsWith('Channels')) return { Items: [{ Id: 'a', Name: 'One', CurrentProgram: programme('Now', '17:30', '18:30') }], TotalRecordCount: 1 };
		assert.equal(url.searchParams.get('MinEndDate'), new Date(clock).toISOString());
		if (fail) throw new Error('No guide provider');
		return { Items: [programme('Next', '18:30', '19:00')], TotalRecordCount: 1 };
	}, () => 'viewer', () => clock);
	const [one, two] = await Promise.all([get(), get()]);
	assert.equal(one, two);
	assert.equal(calls, 2);
	assert.equal(one.available, false);
	assert.equal(one.channels[0].programmes[0].Name, 'Now');
	await get();
	assert.equal(calls, 2);
	clock += 61000;
	fail = false;
	const fresh = await get();
	assert.equal(fresh.available, true);
	assert.equal(fresh.channels[0].programmes.length, 2);
	assert.equal(calls, 4);
});
