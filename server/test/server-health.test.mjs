import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServerHealth, sanitizeHost } from '../server-health.mjs';

test('host readings distinguish fresh, stale, missing and malformed snapshots', async t => {
	const directory = await mkdtemp(path.join(tmpdir(), 'tellybox-health-'));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const file = path.join(directory, 'health.json');
	const read = createServerHealth(file, { bandwidth: () => ({ mbps: 50 }), streaming: () => 2 });
	assert.equal((await read()).host, null);
	await writeFile(file, '{broken'); assert.equal((await read()).host, null);
	await writeFile(file, JSON.stringify({ sampledAt: Date.now() - 200000, cpuPercent: 0, memory: { total: 100, available: 70 }, disks: [] }));
	const stale = await read(); assert.equal(stale.host.stale, true); assert.equal(stale.host.cpuPercent, 0);
	assert.equal(stale.service.watching, 2); assert.equal(stale.bandwidth.mbps, 50); assert.ok(stale.service.memoryBytes > 0);
	await writeFile(file, JSON.stringify({ sampledAt: Date.now(), cpuPercent: 42 }));
	assert.equal((await read()).host.stale, false);
});
test('health response exposes only intended counters and keeps unavailable disks distinct', () => {
	const result = sanitizeHost({ sampledAt: 1000, secret: 'do-not-expose', cpuPercent: -1, memory: { total: 'invalid', available: 8, secret: 'do-not-expose' }, disks: [{ label: 'Media disk', available: false, source: '/private/path' }], load: [1, 2, 3, 4] }, 2000);
	assert.equal(result.cpuPercent, null); assert.equal(result.memory.total, null);
	assert.equal(result.disks[0].available, false); assert.equal(result.disks[0].free, null);
	assert.deepEqual(result.load, [1, 2, 3]);
	assert.ok(!JSON.stringify(result).includes('do-not-expose')); assert.ok(!JSON.stringify(result).includes('/private/path'));
	assert.throws(() => sanitizeHost({ sampledAt: 100000 }, 0));
});
