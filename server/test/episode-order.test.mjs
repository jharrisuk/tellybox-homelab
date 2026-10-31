import test from 'node:test';
import assert from 'node:assert/strict';
import { followingEpisode, orderedEpisodes } from '../episode-order.mjs';
const ep = (s, e, extra = {}) => ({ Id: s + '-' + e, Type: 'Episode', ParentIndexNumber: s, IndexNumber: e, ...extra });
test('next episode ignores input order, missing episodes and specials', () => {
	const items = [ep(3, 2), ep(0, 9), ep(1, 2, { IsVirtualItem: true }), ep(3, 1), ep(1, 1)];
	assert.equal(followingEpisode(items, ep(1, 1)).Id, '3-1');
	assert.equal(followingEpisode(items, ep(3, 2)), null);
	assert.equal(orderedEpisodes(items)[0].Id, '0-9');
});
test('specials never unexpectedly start the regular series', () => {
	assert.equal(followingEpisode([ep(1, 1)], ep(0, 1)), null);
	assert.equal(followingEpisode([ep(0, 3), ep(1, 1)], ep(0, 1)).Id, '0-3');
});
