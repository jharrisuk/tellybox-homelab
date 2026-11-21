import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, writeFile, stat, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { vodPrune } from '../vod-player.mjs';

// Exercise the real pruner and filesystem at a controlled producer boundary.
// Periodic pruning cannot promise a fixed number of concurrent arrivals; the
// next completed pass after writes cease must restore the configured budget.
test('three post-snapshot arrivals are accounted for and the next quiescent prune restores the exact budget', { timeout: 10000 }, async t => {
	const directory = await mkdtemp(path.join(os.tmpdir(), 'vod-prune-boundary-126-'));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const mib = 1024 * 1024;
	const budget = 8 * mib;
	const filename = index => path.join(directory, `segment${String(index).padStart(9, '0')}.ts`);
	const requestedBytes = Buffer.alloc(mib, 0x5a);
	await writeFile(filename(0), requestedBytes);
	for (let index = 1; index < 8; index++) await writeFile(filename(index), Buffer.alloc(mib));
	await writeFile(filename(111), Buffer.alloc(mib));

	let announceSnapshot, resumeSnapshot;
	const snapshotReady = new Promise(resolve => { announceSnapshot = resolve; });
	const resume = new Promise(resolve => { resumeSnapshot = resolve; });
	const job = {
		directory, generation: 1, requested: 0,
		windowStart: 0, windowEnd: 29, windowSegments: 30, captionFiles: []
	};
	const totalBytes = async () => {
		const names = await readdir(directory);
		return (await Promise.all(names.map(name => stat(path.join(directory, name)))))
			.reduce((sum, entry) => sum + entry.size, 0);
	};
	const pruning = vodPrune(job, {
		stat, rm,
		readdir: async dir => {
			const snapshot = await readdir(dir);
			announceSnapshot();
			await resume;
			return snapshot;
		}
	}, budget);
	try {
		await Promise.race([snapshotReady, pruning.then(() => { throw Error('Prune returned before taking its snapshot.'); })]);
		// These real files arrive after the pass captured its directory listing.
		for (let index = 8; index < 11; index++) await writeFile(filename(index), Buffer.alloc(mib));
	} finally {
		resumeSnapshot();
		await pruning;
	}
	await assert.rejects(readFile(filename(111)), { code: 'ENOENT' }, 'stale future data must be removed');
	assert.equal(await totalBytes(), budget + 3 * mib, 'only the three known arrivals may remain above budget');
	assert.deepEqual(await readFile(filename(0)), requestedBytes, 'the requested segment must survive unchanged');

	// No producer writes occur during this pass, so no arrival allowance applies.
	await vodPrune(job, { readdir, stat, rm }, budget);
	assert.equal(await totalBytes(), budget, 'the quiescent pass must restore the exact configured budget');
	assert.deepEqual(await readFile(filename(0)), requestedBytes, 'quiescent eviction must preserve the requested bytes');
	assert.equal(job.pruning, false, 'the completed pass must release its pruning guard');
});