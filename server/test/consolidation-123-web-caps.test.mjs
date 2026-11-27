import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import path from 'node:path';

const root=path.resolve(import.meta.dirname,'../public');

test('main browser player detects real decode support and sends sanitized capabilities',()=>{
	const app=readFileSync(path.join(root,'app.js'),'utf8');
	assert.match(app,/MediaSource\.isTypeSupported/,'browser capability detection must use MediaSource, not a user-agent guess');
	assert.match(app,/function playbackCapabilities\(\)/);
	assert.match(app,/const hlsJs = !nativePreferred && hlsJsSupported\(\);/,'probe the pipeline actually selected');
	assert.match(app,/function nativeHlsPreferred\(\)/,'Safari prefers its native HLS pipeline');
	assert.match(app,/navigator\.vendor === 'Apple Computer, Inc\.'/);
	assert.match(app,/playback\.kind === 'hls' && !nativeHlsPreferred\(\)/,'the chosen playback branch matches the capability probe');
	assert.match(app,/function hlsJsSupported\(\) \{/,'the same probe works before the on-demand bundle has loaded');
	assert.match(app,/typeof Hls !== 'undefined' && typeof Hls\.isSupported === 'function'/);
	assert.match(app,/audio\/mp4; codecs="mp4a\.40\.2"/,'AAC must be probed');
	assert.match(app,/capabilities \? \{ capabilities \} : \{\}/,'the main /api/play body must carry the detected capabilities when available');
	assert.match(app,/compatibilityRequiredFailure/);
	assert.match(app,/compatibilityRetried/);
	assert.match(app,/await startPlayback\(state\.playing, position, true\)/,'one automatic 409 replacement keeps position/settings');
	assert.doesNotMatch(app,/userAgent[^\n]*hevc/i);
});

test('shared browser player negotiates once and keeps a compatibility retry',()=>{
	const share=readFileSync(path.join(root,'share-player.js'),'utf8');
	assert.match(share,/MediaSource\.isTypeSupported/);
	assert.match(share,/const hlsJs = !nativePreferred && typeof Hls/);
	assert.match(share,/function nativeHlsPreferred\(\)/);
	assert.match(share,/data\.kind === 'hls' && !nativeHlsPreferred\(\)/);
	assert.match(share,/audio\/mp4; codecs="mp4a\.40\.2"/);
	assert.match(share,/capabilities \? \{ capabilities \} : \{\}/);
	assert.match(share,/compatibility: live \? false : compatibility/,'VOD no longer forces compatibility in the shared player');
	assert.match(share,/compatibilityRequiredFailure/);
	assert.match(share,/pendingCompatibilityRetry/);
	assert.match(share,/play\(true, pending\.position\)/,'the shared player queues one 409 retry after the busy guard clears');
	assert.match(share,/compatibilityRetried/);
	assert.doesNotMatch(share,/userAgent[^\n]*hevc/i);
});
