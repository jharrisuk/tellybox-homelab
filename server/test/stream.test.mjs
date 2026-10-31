import test from 'node:test';
import assert from 'node:assert/strict';
process.env.NODE_ENV = 'test';
const { safeStreamUrl, rewritePlaylist } = await import('../server.mjs');
const id = '0123456789abcdef0123456789abcdef';
const base = `http://jellyfin:8096/Videos/${id}/master.m3u8`;

test('stream links remove authentication before being sent to a browser', () => {
	assert.equal(safeStreamUrl('main.m3u8?api_key=private&MediaSourceId=source', base, id), `/Videos/${id}/main.m3u8?MediaSourceId=source`);
	assert.equal(safeStreamUrl('/videos/01234567-89ab-cdef-0123-456789abcdef/master.m3u8', base, id), '/videos/01234567-89ab-cdef-0123-456789abcdef/master.m3u8');
});

test('stream proxy rejects other origins, admin paths, and other media items', () => {
	for (const value of ['http://outside.invalid/stream', '/Users', `/Videos/${'a'.repeat(32)}/stream.mp4`, '../../../Users']) {
		assert.throws(() => safeStreamUrl(value, base, id));
	}
});

test('HLS variants, segments, and URI attributes stay behind the guest proxy', () => {
	const session = { id: 'guest-session', itemId: id };
	const playlist = '#EXTM3U\n#EXT-X-MAP:URI="init.mp4?api_key=private"\n#EXTINF:6,\nhls1/main/0.ts?api_key=private\n';
	const output = rewritePlaylist(playlist, base, session);
	assert.ok(!output.includes('private'));
	assert.equal((output.match(/\/stream\/guest-session\//g) || []).length, 2);
	const segment = output.split('\n')[3];
	assert.equal(Buffer.from(segment.split('/').at(-1), 'base64url').toString(), `/Videos/${id}/hls1/main/0.ts`);
});
