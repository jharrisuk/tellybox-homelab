import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createActivity } from '../activity.mjs';

test('active file and converted downloads stay separate from watching and disappear when closed',t=>{
	const directory=mkdtempSync(path.join(tmpdir(),'tellybox-download-activity-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
	const activity=createActivity(directory),viewer={ip:'192.0.2.1',deviceName:'Test phone',local:false},item={Id:'episode',Name:'First episode',SeriesName:'Example series'};
	activity.beginDownload('file',viewer,item,{totalBytes:100,offset:20,mediaRoute:'remote'});
	activity.downloadProgress('file',30);
	let data=activity.snapshot();assert.equal(data.downloads[0].bytes,50);assert.equal(data.downloads[0].transferredBytes,30);assert.equal(data.downloads[0].totalBytes,100);assert.equal(data.stats.active,0);assert.equal(data.stats.plays,0);
	activity.begin('offline',viewer,item,{purpose:'download'});activity.update('offline',{state:'playing',downloadBytes:42});
	data=activity.snapshot();assert.equal(data.downloads.length,2);assert.equal(data.downloads[1].bytes,42);assert.equal(data.stats.active,0);assert.equal(data.stats.plays,0);
	activity.begin('watch',viewer,item);activity.update('watch',{state:'playing'});assert.equal(activity.snapshot().stats.active,1);
	activity.endDownload('file');activity.update('offline',{state:'ended'});assert.equal(activity.snapshot().downloads.length,0);assert.equal(activity.snapshot().stats.active,1);
	activity.flush();assert.equal(createActivity(directory).snapshot().downloads.length,0);
});

test('per-account playback history never returns another person or device', t => {
	const directory = mkdtempSync(path.join(tmpdir(), 'jserver-history-'));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const activity = createActivity(directory);
	const film = (id, name) => ({ Id: id, Name: name, Type: 'Movie' });
	activity.begin('a', { personId: 'a'.repeat(32), personName: 'A', deviceId: 'phone-a' }, film('film-a', 'Film A'));
	activity.update('a', { heartbeat: true, state: 'playing', position: 120 });
	activity.begin('b', { personId: 'b'.repeat(32), personName: 'B', deviceId: 'phone-b' }, film('film-b', 'Film B'));
	activity.update('b', { heartbeat: true, state: 'playing', position: 90 });
	activity.begin('local', { local: true, deviceName: 'Living room' }, film('film-local', 'Film Local'));
	activity.update('local', { heartbeat: true, state: 'playing', position: 45 });
	assert.deepEqual(activity.history({ personId: 'a'.repeat(32) }).map(entry => entry.itemId), ['film-a']);
	assert.deepEqual(activity.history({ personId: 'b'.repeat(32) }).map(entry => entry.itemId), ['film-b']);
	assert.deepEqual(activity.history({ deviceId: 'phone-a' }).map(entry => entry.itemId), ['film-a']);
	assert.deepEqual(activity.history({ local: true }).map(entry => entry.itemId), ['film-local']);
	assert.deepEqual(activity.history({ personId: 'c'.repeat(32) }), []);
});

test('history keeps one latest record per item, reports completion, and never copies an episode onto a series', t => {
	const directory = mkdtempSync(path.join(tmpdir(), 'jserver-history-complete-'));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const now = Date.now();
	const playback = (id, details) => ({ id: 'event-' + Math.random(), type: 'playback', personId: 'a'.repeat(32), updated: now, time: now, ...details });
	writeFileSync(path.join(directory, 'activity.json'), JSON.stringify([
		playback('partial-film', { itemId: 'film-partial', state: 'ended', position: 600, duration: 7200 }),
		playback('finished-film', { itemId: 'film-finished', state: 'ended', position: 7150, duration: 7200 }),
		playback('episode-a', { itemId: 'episode-a', seriesId: 'series', state: 'ended', position: 900, duration: 3000, updated: now - 30000 }),
		playback('episode-a-rewind', { itemId: 'episode-a', seriesId: 'series', state: 'ended', position: 60, duration: 3000, updated: now - 10000 }),
		playback('episode-b', { itemId: 'episode-b', seriesId: 'series', state: 'ended', position: 1800, duration: 3000 }),
		playback('other-person', { itemId: 'episode-x', seriesId: 'series', state: 'ended', position: 100, duration: 3000, personId: 'b'.repeat(32) }),
	]));
	const activity = createActivity(directory);
	const history = activity.history({ personId: 'a'.repeat(32) });
	const byId = new Map(history.map(entry => [entry.itemId, entry]));
	assert.equal(byId.get('film-partial').completed, false, 'a partial stop is not completion');
	assert.equal(byId.get('film-partial').position, 600);
	assert.equal(byId.get('film-finished').completed, true);
	assert.equal(byId.get('episode-a').position, 60, 'the newer rewind wins over the older later position');
	assert.equal(byId.get('episode-b').completed, false);
	assert.ok(!byId.has('series'), 'an episode is never collapsed onto the series id');
	assert.ok(!byId.has('episode-x'), 'another person\'s episode is not returned');
	assert.equal(history.filter(entry => entry.seriesId === 'series').length, 2);
});

test('viewing history persists, stops accurately and expires old records', t => {
	const directory = mkdtempSync(path.join(tmpdir(), 'jserver-activity-'));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	writeFileSync(path.join(directory, 'activity.json'), JSON.stringify([{ type: 'login_success', time: 0, updated: 0 }]));
	const activity = createActivity(directory);
	const viewer = { ip: '203.0.113.5', local: false, browser: '<script>untrusted</script>' };
	activity.begin('test-stream', viewer, { Id: 'test-item', Name: 'Episode one', SeriesName: 'Test series' });
	assert.equal(activity.snapshot().active.length, 0);
	activity.update('test-stream', { state: 'playing', position: 123 });
	assert.equal(activity.snapshot().active[0].title, 'Test series · Episode one');
	assert.equal(activity.snapshot().stats.plays, 1);
	assert.equal(activity.snapshot().stats.remoteIps, 1);
	activity.update('test-stream', { state: 'paused', position: 130 });
	activity.flush();
	const restarted = createActivity(directory);
	assert.equal(restarted.snapshot().active.length, 0);
	assert.equal(restarted.snapshot().recent[0].state, 'inactive');
	activity.update('test-stream', { state: 'ended' });
	assert.equal(activity.snapshot().active.length, 0);
	assert.equal(activity.snapshot().recent[0].position, 130);
	assert.equal(JSON.parse(readFileSync(path.join(directory, 'activity.json'))).length, 1);
});
