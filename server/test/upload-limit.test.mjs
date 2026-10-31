import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { Readable } from 'node:stream';
import { createUploadLimit } from '../upload-limit.mjs';
import { installAuth } from '../auth.mjs';
import express from 'express';

function fixture(t) {
	const directory = mkdtempSync(path.join(tmpdir(), 'jserver-upload-'));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	return { directory, limit: createUploadLimit(directory) };
}
async function consume(stream) {
	const chunks = [];
	for await (const chunk of stream) chunks.push(chunk);
	return Buffer.concat(chunks);
}
test('upload setting defaults to 50 Mbps, validates and persists', t => {
	const { directory, limit } = fixture(t);
	assert.equal(limit.status().mbps, 50);
	for (const value of [-1, 1001, 0.5, NaN, '50', null, undefined]) assert.throws(() => limit.set(value));
	assert.equal(limit.status().mbps, 50);
	limit.set(30); assert.equal(createUploadLimit(directory).status().mbps, 30);
	limit.set(0); assert.equal(createUploadLimit(directory).status().mbps, 0);
});
test('simultaneous transfers share one bandwidth budget and retain every byte', async t => {
	const { limit } = fixture(t); limit.set(2);
	const payload = Buffer.alloc(128 * 1024, 57);
	const start = performance.now();
	const results = await Promise.all([consume(limit.stream(Readable.from([payload]))), consume(limit.stream(Readable.from([payload])))]);
	const elapsed = performance.now() - start;
	// 256 KiB minus the single 64 KiB burst at 2 Mbps requires at least 786 ms.
	assert.ok(elapsed >= 730, `Transfers exceeded the aggregate budget (${elapsed} ms)`);
	assert.ok(elapsed < 6000, `Scheduler stalled (${elapsed} ms)`);
	for (const result of results) assert.deepEqual(result, payload);
	assert.equal(limit.status().transferredBytes, payload.length * 2);
});
test('changing the limit releases existing queues and cancelled transfers do not stall others', async t => {
	const { limit } = fixture(t); limit.set(1);
	await consume(limit.stream(Readable.from([Buffer.alloc(64 * 1024)])));
	const controller = new AbortController();
	const cancelled = assert.rejects(consume(limit.stream(Readable.from([Buffer.alloc(128 * 1024)]), controller.signal)));
	const running = consume(limit.stream(Readable.from([Buffer.alloc(128 * 1024, 8)])));
	await new Promise(resolve => setTimeout(resolve, 25));
	controller.abort();
	const start = performance.now();
	limit.set(0);
	await cancelled;
	assert.equal((await running).length, 128 * 1024);
	assert.ok(performance.now() - start < 1000);
	limit.set(1);
	const started = performance.now();
	await consume(limit.stream(Readable.from([Buffer.alloc(128 * 1024)])));
	assert.ok(performance.now() - started >= 450, 'Re-enabling a cap must affect subsequent chunks');
});
test('only the trusted local settings entry can read or change the limit', async t => {
	const { directory, limit } = fixture(t);
	const app = express(); app.use(express.json());
	const listen = () => new Promise(resolve => { const server = app.listen(0, '127.0.0.1', () => resolve(server)); });
	const local = await listen(), remote = await listen();
	t.after(() => { for (const server of [local, remote]) { server.closeAllConnections(); server.close(); } });
	installAuth(app, { directory, publicDirectory: path.resolve('public'), localPort: local.address().port,
		localHosts: ['127.0.0.1'], localNetworks: ['127.0.0.0/8'], uploadLimit: limit });
	app.use((error, req, res, next) => res.status(error.status || 500).json({ error: error.message }));
	const request = (server, body, extra = {}) => {
		const base = `http://127.0.0.1:${server.address().port}`;
		return fetch(base + '/api/auth/upload-limit', { method: body ? 'POST' : 'GET',
			headers: { ...(body ? { 'Content-Type': 'application/json', Origin: base } : {}), ...extra }, body: body ? JSON.stringify(body) : undefined });
	};
	assert.equal((await request(local)).status, 200);
	assert.equal((await request(remote)).status, 403);
	assert.equal((await request(remote, { mbps: 0 })).status, 403);
	assert.equal((await request(local, { mbps: 0 }, { 'X-Forwarded-For': '127.0.0.1' })).status, 403);
	assert.equal((await request(local, { mbps: 0 }, { Origin: 'https://evil.invalid' })).status, 403);
	assert.equal((await request(local, { mbps: '50' })).status, 400);
	assert.equal((await request(local, { mbps: 40 })).status, 200);
	assert.equal((await (await request(local)).json()).mbps, 40);
});

test('parallel requests for one stream count once; idle devices never reserve bandwidth', async t => {
	const { limit } = fixture(t); limit.set(1);
	const controller = new AbortController();
	const payload = Buffer.alloc(128 * 1024);
	const jobs = ['one','one','two'].map(owner => consume(limit.stream(Readable.from([payload]), controller.signal, owner)).catch(() => null));
	await new Promise(resolve => setTimeout(resolve, 20));
	assert.equal(limit.status().activeTransfers, 2);
	assert.equal(limit.status().estimatedMbpsPerTransfer, 0.5);
	controller.abort(); await Promise.all(jobs);
	assert.equal(limit.status().activeTransfers, 0);
});

test('diagnostic transfer rate measures bytes and never divides by registered devices', async t => {
	const { limit } = fixture(t); limit.set(0);
	await consume(limit.stream(Readable.from([Buffer.alloc(1250000)]), undefined, 'one'));
	assert.equal(limit.measuredMbps('one'), 1);
	assert.equal(limit.measuredMbps('idle'), 0);
	assert.equal(limit.status().measuredMbps, 1);
	assert.equal(limit.status().activeTransfers, 0);
	assert.equal(limit.status().estimatedMbpsPerTransfer, null);
});
