/* Release 141: deferred web Home must not wait for Continue.
 *
 * The web client opts in with body.deferContinue. The route then builds every
 * other rail and answers before homeContinue starts; the complete (flag-less)
 * request keeps the existing single-response behaviour and still waits.
 *
 * The fixture makes one exact episode resolve very slowly through Jellyfin's
 * single-item reader. That id is the Continue work: the deferred request must
 * never touch it, while the flag-less request must wait for it. Timestamps are
 * recorded in the upstream handler, so the assertions do not depend on a
 * machine-speed threshold alone.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

const baseItem = (id, name, type, extra = {}) => ({ Id: id, Name: name, Type: type, Genres: ['Drama'], RunTimeTicks: 7200e7, ...extra });
const series = baseItem('11111111111111111111111111111111', 'Slow Continue Series', 'Series');
const episode = baseItem('66666666666666666666666666666666', 'Slow Exact Episode', 'Episode',
	{ SeriesId: series.Id, SeriesName: series.Name, ParentIndexNumber: 1, IndexNumber: 1, RunTimeTicks: 3000e7 });
const films = [
	baseItem('22222222222222222222222222222222', 'First Film', 'Movie'),
	baseItem('33333333333333333333333333333333', 'Second Film', 'Movie'),
	baseItem('44444444444444444444444444444444', 'Third Film', 'Movie')
];
const SLOW_ITEM_MS = 900;

test('deferContinue answers before a slow Continue lookup resolves, while the flag-less call still waits', { timeout: 45000 }, async t => {
	const directory = mkdtempSync(path.join(os.tmpdir(), 'home-defer-continue-141-'));
	const servers = [];
	const listen = handler => new Promise(resolve => {
		const server = http.createServer(handler);
		server.listen(0, '127.0.0.1', () => { servers.push(server); resolve(server); });
	});
	const itemById = new Map([...films, series, episode].map(item => [item.Id, item]));
	let slowItemRequests = 0;
	let slowResolvedAt = 0;
	const jellyfin = await listen((req, res) => {
		const url = new URL(req.url, 'http://127.0.0.1');
		res.setHeader('Content-Type', 'application/json');
		if (url.pathname === '/Items') return res.end(JSON.stringify({ Items: [...films, series], TotalRecordCount: films.length + 1 }));
		const itemMatch = url.pathname.match(/^\/Users\/[^/]+\/Items\/([^/]+)$/);
		if (itemMatch) {
			const id = decodeURIComponent(itemMatch[1]);
			// The exact Continue episode is the deliberately slow read. Nothing in
			// the deferred feed may need it.
			if (id === episode.Id) {
				slowItemRequests += 1;
				setTimeout(() => {
					slowResolvedAt = performance.now();
					try { res.end(JSON.stringify(episode)); } catch { /* client gone */ }
				}, SLOW_ITEM_MS);
				return;
			}
			const item = itemById.get(id);
			if (!item) { res.statusCode = 404; return res.end('{}'); }
			return res.end(JSON.stringify(item));
		}
		const showMatch = url.pathname.match(/^\/Shows\/([^/]+)\/Episodes$/);
		if (showMatch) return res.end(JSON.stringify({ Items: [episode], TotalRecordCount: 1 }));
		if (url.pathname.startsWith('/Users/')) return res.end(JSON.stringify({ Items: [] }));
		res.end('{}');
	});
	const local = await listen();
	Object.assign(process.env, {
		NODE_ENV: 'test', AUTH_DIR: directory, DATA_DIR: directory,
		JELLYFIN_URL: `http://127.0.0.1:${jellyfin.address().port}`,
		DISPATCHARR_URL: 'http://127.0.0.1:1', PORT: String(local.address().port),
		LOCAL_HOSTS: '127.0.0.1', LOCAL_NETWORKS: '127.0.0.0/8',
		PUBLIC_ORIGIN: 'https://remote.test', TELLYBOX_HOME_TIMING: '1'
	});
	writeFileSync(path.join(directory, 'connection.json'), JSON.stringify({ userId: 'test', token: 'fixture-only' }));
	writeFileSync(path.join(directory, 'apps.json'), JSON.stringify({}));
	writeFileSync(path.join(directory, 'account-limits.json'), JSON.stringify({ accounts: {} }));
	writeFileSync(path.join(directory, 'activity.json'), JSON.stringify([]));
	(await import('./enabled-fixture.mjs')).enableIntegrations();
	const { app } = await import('../server.mjs');
	local.on('request', app);
	const base = `http://127.0.0.1:${local.address().port}`;
	const request = body => fetch(base + '/api/web/home', {
		method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base },
		body: JSON.stringify(body)
	});
	t.after(() => {
		for (const server of servers) { server.closeAllConnections(); server.close(); }
		rmSync(directory, { recursive: true, force: true });
	});

	const context = { progress: { [episode.Id]: 240 } };
	const continueRow = feed => (feed.rows || []).find(row => row.id === 'continue');

	// 1. Deferred: every other row, no Continue, and the slow lookup never runs.
	const deferredResponse = await request({ ...context, deferContinue: true });
	const deferredText = await deferredResponse.clone().text();
	assert.equal(deferredResponse.status, 200, deferredText);
	const deferred = JSON.parse(deferredText);
	assert.equal(deferred.continuePending, true, 'the deferred response marks Continue as pending');
	assert.equal(continueRow(deferred), undefined, 'the deferred response contains no Continue row');
	assert.equal(deferred.availability?.continue?.status, 'pending', 'Continue availability is explicitly pending');
	assert.equal(deferred.availability?.continue?.complete, false, 'a deferred Continue is never complete');
	assert.equal(slowItemRequests, 0, 'the deferred request never starts the Continue lookup');
	assert.equal(slowResolvedAt, 0, 'the deferred request returned before Continue could resolve');
	assert.ok(Array.isArray(deferred.rows) && deferred.rows.length > 0, 'the other rails are present immediately');
	assert.equal(deferredResponse.headers.get('cache-control'), 'no-store');

	// 2. Flag-less: unchanged single complete response, still waits for Continue.
	const fullStarted = performance.now();
	const fullResponse = await request(context);
	const fullText = await fullResponse.clone().text();
	const fullAt = performance.now();
	assert.equal(fullResponse.status, 200, fullText);
	const full = JSON.parse(fullText);
	assert.ok(slowResolvedAt > 0, 'the complete response really waited for the slow Continue lookup');
	assert.ok(slowItemRequests >= 1, 'the complete response asked for the exact episode');
	assert.ok(fullAt >= slowResolvedAt, 'the complete response cannot arrive before Continue resolves');
	assert.ok(fullAt - fullStarted >= SLOW_ITEM_MS - 50,
		'the complete response is held for Continue, took ' + Math.round(fullAt - fullStarted) + 'ms');
	const fullRow = continueRow(full);
	assert.ok(fullRow, 'the complete response still contains Continue');
	assert.ok((fullRow.items || []).some(item => item.Id === episode.Id),
		'the complete response still contains the exact episode');
	assert.equal(full.continuePending, undefined, 'the flag-less response keeps its old shape');

	// 3. The complete build warmed the per-viewer Continue memo; the dedicated
	// route reuses it instead of resolving the episode again.
	const warmStart = performance.now();
	const warmResponse = await fetch(base + '/api/web/home/continue', {
		method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base },
		body: JSON.stringify(context)
	});
	const warmElapsed = performance.now() - warmStart;
	const warmText = await warmResponse.clone().text();
	assert.equal(warmResponse.status, 200, warmText);
	const warm = JSON.parse(warmText);
	assert.equal(JSON.parse(warmResponse.headers.get('x-tellybox-home-timing') || 'null')?.memoHit, true,
		'the Continue route reuses the row warmed by the complete feed');
	assert.ok(warmElapsed < SLOW_ITEM_MS, 'the warm Continue row does not repeat the slow lookup');
	const warmRow = (warm.rows || []).find(row => row.id === 'continue');
	assert.ok(warmRow, 'the dedicated route returns only the Continue row');
	assert.ok((warmRow.items || []).some(item => item.Id === episode.Id), 'the warm row keeps the exact episode');

	// 4. A repeat deferred Home reuses its own memo entry and still has no
	// Continue row; the two memo namespaces cannot answer for each other.
	const repeatResponse = await request({ ...context, deferContinue: true });
	const repeatText = await repeatResponse.clone().text();
	assert.equal(repeatResponse.status, 200, repeatText);
	const repeat = JSON.parse(repeatText);
	assert.equal(JSON.parse(repeatResponse.headers.get('x-tellybox-home-timing') || 'null')?.memoHit, true,
		'the deferred feed has its own memo hit');
	assert.equal(continueRow(repeat), undefined, 'a deferred memo never becomes a complete feed');
	assert.equal(repeat.continuePending, true);
});
