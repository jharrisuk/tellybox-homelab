import test from 'node:test';
import assert from 'node:assert/strict';
import { newlyAvailableItems, newlyAvailableQuery, NEWLY_AVAILABLE_LIMIT } from '../newly-available.mjs';

test('newly available asks only for already-aired local files, newest first', () => {
	const params = newlyAvailableQuery('viewer-id');
	assert.equal(params.get('UserId'), 'viewer-id');
	assert.equal(params.get('IncludeItemTypes'), 'Movie,Episode');
	assert.equal(params.get('IsMissing'), 'false');
	assert.equal(params.get('IsUnaired'), 'false');
	assert.equal(params.get('LocationTypes'), 'FileSystem');
	assert.equal(params.get('SortBy'), 'DateCreated');
	assert.equal(params.get('SortOrder'), 'Descending');
	assert.equal(params.get('Limit'), String(NEWLY_AVAILABLE_LIMIT));
});

test('missing, unaired and virtual results are never labelled newly available', () => {
	const items = Array.from({ length: NEWLY_AVAILABLE_LIMIT + 5 }, (_, index) => ({ Id: `item-${index}`, Type: 'Movie' }));
	items.push({ Id: 'missing', IsMissing: true }, { Id: 'unaired', IsUnaired: true }, { Id: 'virtual', IsVirtualItem: true });
	const result = newlyAvailableItems({ Items: items });
	assert.equal(result.length, NEWLY_AVAILABLE_LIMIT);
	assert.equal(result.some(item => ['missing', 'unaired', 'virtual'].includes(item.Id)), false);
	assert.deepEqual(newlyAvailableItems({}), []);
	assert.deepEqual(newlyAvailableItems(null), []);
	assert.deepEqual(newlyAvailableItems({ Items: 'not-an-array' }), []);
});
