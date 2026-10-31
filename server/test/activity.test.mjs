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
