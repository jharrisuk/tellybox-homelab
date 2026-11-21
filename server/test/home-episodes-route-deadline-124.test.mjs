// LATE-FALLBACK-PROOF, local half: an empty library answer that arrives after
// the route deadline must not start a Jellyfin fallback, and two concurrent
// four-series requests must share the process-wide admission cap while their
// slots stay tied to the real upstream lifetime.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { ADMISSION_LIMIT, homeEpisodeAdmissionState, REQUEST_TIMEOUT_MS } from '../home-episodes.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const hexId = value => (value.toString(16) + '0'.repeat(32)).slice(0, 32);
const liked = 'a'.repeat(32);
const volume = Array.from({ length: 8 }, (_, index) => hexId(index + 1));

test('the route deadline covers late misses and the shared cap stays tied to upstreams', { timeout: 30000 }, async t => {
	const requests = [];
	const servers = [];
	let showsActive = 0, showsPeak = 0, itemsActive = 0, itemsPeak = 0;
	let showsStarted = [];
	const listen = handler => new Promise(resolve => {
		const server = http.createServer(handler);
		server.listen(0, '127.0.0.1', () => { servers.push(server); resolve(server); });
	});
	const showDelay = id => (id === liked ? 2200 : 2600);
	const upstream = await listen((req, res) => {
		const url = new URL(req.url, 'http://127.0.0.1');
		requests.push({ pathname: url.pathname, parent: url.searchParams.get('ParentId'), at: Date.now() });
		res.setHeader('Content-Type', 'application/json');
		if (url.pathname === '/Items') {
			if (!url.searchParams.has('ParentId')) {
				const ids = [liked, ...volume];
				return res.end(JSON.stringify({ Items: ids.map(id => ({ Id: id, Name: 'Show ' + id.slice(0, 4), Type: 'Series', ChildCount: 2 })), TotalRecordCount: ids.length }));
			}
			return res.end(JSON.stringify({ Items: [] }));
		}
		const userItem = /^\/Users\/[^/]+\/Items\/([^/]+)$/.exec(url.pathname);
		if (userItem) {
			itemsActive++;
			itemsPeak = Math.max(itemsPeak, itemsActive);
			const id = decodeURIComponent(userItem[1]);
			setTimeout(() => {
				itemsActive--;
				res.end(JSON.stringify({ Id: id, Name: 'Show ' + id.slice(0, 4), Type: 'Series', ChildCount: 2 }));
			}, 20);
			return;
		}
		const episodes = /^\/Shows\/([^/]+)\/Episodes$/.exec(url.pathname);
		if (episodes) {
			const id = decodeURIComponent(episodes[1]);
			showsActive++;
			showsPeak = Math.max(showsPeak, showsActive);
			showsStarted.push({ id, at: Date.now() });
			setTimeout(() => {
				showsActive--;
				// An empty local list: the library reports a truthful miss late.
				res.end(JSON.stringify({ Items: [] }));
			}, showDelay(id));
			return;
		}
		return res.end('{}');
	});
	const local = await listen();
	const directory = mkdtempSync(path.join(os.tmpdir(), 'home-episodes-deadline-'));
	Object.assign(process.env, {
		NODE_ENV: 'test', AUTH_DIR: directory, DATA_DIR: directory,
		JELLYFIN_URL: `http://127.0.0.1:${upstream.address().port}`,
		DISPATCHARR_URL: 'http://127.0.0.1:1',
		LOCAL_HOSTS: '127.0.0.1', LOCAL_NETWORKS: '127.0.0.0/8',
		PUBLIC_ORIGIN: 'https://remote.test', PORT: String(local.address().port)
	});
	writeFileSync(path.join(directory, 'connection.json'), JSON.stringify({ userId: 'test', token: 'fixture-only' }));
	writeFileSync(path.join(directory, 'account-limits.json'), JSON.stringify({ accounts: {} }));
	writeFileSync(path.join(directory, 'remote-controls.json'), JSON.stringify({ enabled: true, vod: true, nonstop: true }));
	(await import('./enabled-fixture.mjs')).enableIntegrations();
	const { app } = await import('../server.mjs');
	local.on('request', app);
	const base = `http://127.0.0.1:${local.address().port}`;
	t.after(() => {
		for (const server of servers) { server.closeAllConnections(); server.close(); }
		rmSync(directory, { recursive: true, force: true });
	});
	const url = ids => base + '/api/web/releases/episodes?series=' + encodeURIComponent(ids);
	const parentCalls = () => requests.filter(entry => entry.pathname === '/Items' && entry.parent);

	// 1. A single local series whose library answer arrives after the deadline.
	const started = Date.now();
	const late = await fetch(url(liked));
	const lateBody = await late.json();
	const elapsed = Date.now() - started;
	assert.equal(late.status, 200);
	assert.deepEqual(lateBody, { items: [] }, 'the late miss is a truthful empty list');
	assert.ok(elapsed >= REQUEST_TIMEOUT_MS - 250 && elapsed < REQUEST_TIMEOUT_MS + 1500,
		'the response is bounded by the route deadline, took ' + elapsed + 'ms');
	assert.equal(homeEpisodeAdmissionState().active, 1, 'the slot is still tied to the late library read');
	assert.equal(parentCalls().length, 0, 'no fallback has started yet');
	await sleep(500);
	assert.equal(parentCalls().length, 0, 'the late library miss never starts a Jellyfin fallback');
	assert.equal(homeEpisodeAdmissionState().active, 0, 'the slot is released when the library read settles');

	// 2. Two concurrent four-series requests: one shared cap, no queued start
	// after either deadline, and slots held until the upstreams settle.
	const half = volume.slice(0, 4).join(',');
	const otherHalf = volume.slice(4).join(',');
	const showsBefore = showsStarted.length;
	const firstStart = Date.now();
	const [a, b] = await Promise.all([fetch(url(half)), fetch(url(otherHalf))]);
	const bothElapsed = Date.now() - firstStart;
	assert.deepEqual(await a.json(), { items: [] }, 'nothing finished before the deadline stays truthful');
	assert.deepEqual(await b.json(), { items: [] });
	assert.ok(bothElapsed >= REQUEST_TIMEOUT_MS - 250 && bothElapsed < REQUEST_TIMEOUT_MS + 1500,
		'both responses leave at the shared deadline, took ' + bothElapsed + 'ms');
	assert.ok(showsPeak <= ADMISSION_LIMIT, 'peak upstream concurrency stays within the shared cap, saw ' + showsPeak);
	assert.equal(showsStarted.length - showsBefore, 4, 'only the admitted four series reach Jellyfin');
	for (const call of showsStarted.slice(showsBefore)) {
		assert.ok(call.at <= firstStart + REQUEST_TIMEOUT_MS, 'the admitted work starts before the deadline');
	}
	assert.equal(homeEpisodeAdmissionState().active, 4, 'the admitted slots stay held until the upstreams settle');
	assert.equal(homeEpisodeAdmissionState().queued, 0, 'the queued half expired with its request');
	assert.ok(itemsPeak <= ADMISSION_LIMIT, 'the item reads stay within the shared cap too');
	assert.equal(parentCalls().length, 0, 'empty library answers at the deadline start no fallback');

	await sleep(1000);
	assert.equal(homeEpisodeAdmissionState().active, 0, 'every slot is released when the upstreams settle');
	assert.equal(showsActive, 0);
});
