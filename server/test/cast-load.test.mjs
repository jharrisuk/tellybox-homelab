import test from 'node:test';
import assert from 'node:assert/strict';
import { loadCastMedia } from '../public/cast-load.mjs';

const request = { media: { contentId: 'http://lan/unique-session' } };
const media = (contentId = request.media.contentId, playerState = 'PLAYING') => ({ media: { contentId }, playerState });

test('Cast detects this stream playing even when the SDK load promise never settles', async () => {
	let receiver = null;
	const target = {
		loadMedia: () => { receiver = media(); return new Promise(() => {}); },
		getMediaSession: () => receiver
	};
	await loadCastMedia(target, request, { timeoutMs: 100, pollMs: 5 });
});

test('Cast waits for receiver confirmation after the load acknowledgement', async () => {
	let polls = 0;
	await loadCastMedia({
		loadMedia: async () => null,
		getMediaSession: () => ++polls > 3 ? media(request.media.contentId, 'BUFFERING') : null
	}, request, { timeoutMs: 200, pollMs: 5 });
	assert.ok(polls > 3);
});

test('Cast does not mistake another video or an idle receiver for a successful load', async () => {
	for (const status of [media('http://lan/old-session'), media(request.media.contentId, 'IDLE')]) {
		await assert.rejects(loadCastMedia({ loadMedia: () => new Promise(() => {}), getMediaSession: () => status }, request, { timeoutMs: 30, pollMs: 5 }), { code: 'timeout' });
	}
});

test('Cast cancellation and receiver rejection settle the wait', async () => {
	await assert.rejects(loadCastMedia({ loadMedia: () => new Promise(() => {}), getMediaSession: () => null }, request, { isCurrent: () => false }), { code: 'cancel' });
	await assert.rejects(loadCastMedia({ loadMedia: async () => { throw new Error('receiver rejected'); }, getMediaSession: () => null }, request), /receiver rejected/);
	await assert.rejects(loadCastMedia({ loadMedia: async () => 'LOAD_FAILED', getMediaSession: () => null }, request), { code: 'LOAD_FAILED' });
});

test('A late SDK error cannot override confirmed receiver playback', async () => {
	await loadCastMedia({ loadMedia: async () => { throw new Error('late acknowledgement'); }, getMediaSession: () => media() }, request);
});
