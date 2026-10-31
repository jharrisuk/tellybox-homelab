import test from 'node:test';
import assert from 'node:assert/strict';
import { createDownloadLimit, downloadOwner } from '../download-limit.mjs';

test('linked browsers and devices share one person limit; anonymous home browsers stay separate', () => {
	const key = viewer => downloadOwner({ jserverOwner: 'local', jserverViewer: viewer });
	assert.equal(key({ personId: 'a', deviceId: 'phone' }), key({ personId: 'a', browserId: 'browser' }));
	assert.notEqual(key({ browserId: 'a' }), key({ browserId: 'b' }));
	assert.notEqual(key({ deviceId: 'a' }), key({ deviceId: 'b' }));
	assert.notEqual(key({ ip: '192.168.0.1' }), key({ ip: '192.168.0.2' }));
	assert.notEqual(key({ personId: 'a' }), key({ personId: 'b' }));
});

test('atomic reservations block competing files, permit other users, and release once', () => {
	const limit = createDownloadLimit();
	const done = limit.enter('person:a', 'first');
	assert.throws(() => limit.enter('person:a', 'second'), { status: 409 });
	assert.throws(() => limit.check('person:a'), /Finish or cancel/);
	const other = limit.enter('person:b', 'second'); other();
	done(); const next = limit.enter('person:a', 'second'); done();
	assert.throws(() => limit.check('person:a'), { status: 409 });
	next(); assert.doesNotThrow(() => limit.check('person:a'));
});

test('HLS segments share a file reservation, idle abandoned jobs expire, active transfers never do', () => {
	let now = 0;
	const limit = createDownloadLimit({ clock: () => now, idleMs: 90000 });
	const first = limit.enter('user', 'hls'), parallel = limit.enter('user', 'hls');
	first(true); now = 200000;
	assert.throws(() => limit.enter('user', 'other'), { status: 409 });
	parallel(true); now += 89999;
	assert.throws(() => limit.check('user'), { status: 409 });
	now++; const next = limit.enter('user', 'other');
	limit.release('user', 'hls');
	assert.throws(() => limit.enter('user', 'hls'), { status: 409 });
	next(); assert.doesNotThrow(() => limit.check('user'));
});

test('completion or cancellation releases prepared jobs without an old callback clearing the new job', () => {
	const limit = createDownloadLimit();
	const old = limit.enter('user', 'hls'); limit.release('user', 'hls');
	const next = limit.enter('user', 'next'); old(true);
	assert.throws(() => limit.check('user'), { status: 409 });
	next(); assert.doesNotThrow(() => limit.check('user'));
});
