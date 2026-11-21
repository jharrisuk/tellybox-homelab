/* Release 142: the Activity downloads list is readable by trusted local/home
 * viewers and installation administrators without an owner session, while every
 * destructive qBittorrent route keeps its owner boundary.
 *
 * The synthetic upstream includes hashes, magnets, tracker URLs, save paths,
 * categories, a WebUI address and credentials. None of those may reach the
 * read-only response. A denied caller must make zero upstream requests.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import express from 'express';
import { installAuth } from '../auth.mjs';
import { installQbittorrentRoutes } from '../qbittorrent.mjs';
import { createHomeNetwork } from '../home-network.mjs';

const HASH = '9f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c';
const NAME = 'Synthetic Download Epsilon';
const CATEGORY = 'Synthetic Category Epsilon';
const SAVE_PATH = '/srv/synthetic-epsilon-private-save';
const MAGNET = 'magnet:?xt=urn:btih:' + HASH + '&tr=https://tracker.synthetic.invalid/announce';
const TRACKER = 'https://tracker.synthetic.invalid/announce';
const QB_USER = 'synthetic-webui-user-142';
const QB_PASSWORD = 'synthetic-webui-secret-142';

const TOP_LEVEL_KEYS = [
	'readOnly', 'generatedAt', 'configured', 'enabled', 'state', 'reachable',
	'stale', 'checkedAt', 'filter', 'sampleSize', 'hasMore', 'counts',
	'countsLowerBound', 'rows'
].sort();
const ROW_KEYS = [
	'name', 'state', 'stateLabel', 'progress', 'size', 'dlspeed', 'upspeed', 'eta', 'ratio'
].sort();
const FORBIDDEN_KEYS = new Set([
	'hash', 'hashes', 'displayHash', 'id', 'category', 'savePath', 'save_path',
	'magnet', 'magnet_uri', 'magnetUri', 'tracker', 'trackers', 'trackerUrl',
	'url', 'username', 'password', 'credentials', 'generation', 'filters',
	'page', 'webapiVersion', 'applicationVersion', 'pollSeconds', 'stalledMinutes',
	'raw', 'payload', 'contentPath', 'downloadPath', 'rootPath'
]);

function temporaryDirectory(t, prefix) {
	const directory = mkdtempSync(path.join(tmpdir(), prefix));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	return directory;
}

function allKeys(value, found = new Set()) {
	if (!value || typeof value !== 'object') return found;
	for (const [key, child] of Object.entries(value)) {
		found.add(key);
		allKeys(child, found);
	}
	return found;
}

function assertAllowlisted(body, { rowCount = 1 } = {}) {
	assert.deepEqual(Object.keys(body).sort(), TOP_LEVEL_KEYS, 'the response has exactly the documented top-level fields');
	assert.equal(body.readOnly, true);
	assert.equal(body.rows.length, rowCount);
	if (rowCount > 0) {
		assert.deepEqual(Object.keys(body.rows[0]).sort(), ROW_KEYS, 'each row has exactly the documented fields');
	}
	const keys = allKeys(body);
	for (const key of FORBIDDEN_KEYS) assert.equal(keys.has(key), false, 'forbidden key is absent: ' + key);
	const text = JSON.stringify(body);
	for (const secret of [HASH, HASH.slice(0, 8), CATEGORY, SAVE_PATH, MAGNET, TRACKER, QB_USER, QB_PASSWORD]) {
		assert.equal(text.includes(secret), false, 'the read-only response must not contain ' + secret);
	}
}

async function startUpstream(t) {
	const state = { requests: [], infoReads: 0 };
	const server = http.createServer(async (req, res) => {
		for await (const chunk of req) { /* drain fixture request bodies */ }
		const url = new URL(req.url, 'http://127.0.0.1');
		state.requests.push({ method: req.method, path: url.pathname, url: req.url });
		const text = (status, value, headers = {}) => {
			res.writeHead(status, { 'content-type': 'text/plain', ...headers });
			res.end(value);
		};
		const json = (status, value) => {
			res.writeHead(status, { 'content-type': 'application/json' });
			res.end(JSON.stringify(value));
		};
		if (url.pathname === '/api/v2/auth/login') {
			return text(200, 'Ok.', { 'set-cookie': 'SID=synthetic-142; path=/' });
		}
		if (req.headers.cookie !== 'SID=synthetic-142') return text(401, '');
		if (url.pathname === '/api/v2/app/webapiVersion') return text(200, '2.11.2');
		if (url.pathname === '/api/v2/app/version') return text(200, 'v5.0.3');
		if (url.pathname === '/api/v2/torrents/categories') {
			return json(200, { [CATEGORY]: { name: CATEGORY, savePath: SAVE_PATH } });
		}
		if (url.pathname === '/api/v2/transfer/info') {
			return json(200, { dl_info_speed: 4500000, up_info_speed: 120000, connection_status: 'connected' });
		}
		if (url.pathname === '/api/v2/torrents/info') {
			state.infoReads += 1;
			return json(200, [{
				hash: HASH,
				name: NAME,
				state: 'downloading',
				progress: 0.375,
				completed: 375,
				size: 1000,
				total_size: 1200,
				dlspeed: 4500000,
				upspeed: 120000,
				eta: 900,
				ratio: 1.25,
				category: CATEGORY,
				save_path: SAVE_PATH,
				magnet_uri: MAGNET,
				tracker: TRACKER,
				num_seeds: 3,
				num_complete: 9,
				num_leechs: 1,
				num_incomplete: 4,
				added_on: 1700000000,
				last_activity: 1700000100
			}]);
		}
		return text(404, '');
	});
	server.listen(0, '127.0.0.1');
	await once(server, 'listening');
	t.after(() => { server.closeAllConnections?.(); server.close(); });
	return { base: 'http://127.0.0.1:' + server.address().port, state };
}

async function listen(app) {
	const server = app.listen(0, '127.0.0.1');
	await once(server, 'listening');
	return server;
}

function configFor(base, overrides = {}) {
	return {
		url: base + '/', username: QB_USER, password: QB_PASSWORD,
		enabled: true, pollSeconds: 20, stalledMinutes: 30, ...overrides
	};
}

test('local and admin read the allowlisted list; a remote non-admin is refused with zero upstream calls', { timeout: 45000 }, async t => {
	const qbDirectory = temporaryDirectory(t, 'tellybox-qb-readonly-142-');
	const authDirectory = temporaryDirectory(t, 'tellybox-qb-readonly-auth-142-');
	const upstream = await startUpstream(t);
	writeFileSync(path.join(qbDirectory, 'qbittorrent.json'), JSON.stringify(configFor(upstream.base)));

	const app = express();
	app.use(express.json());
	const local = await listen(app);
	const remote = await listen(app);
	t.after(() => {
		local.closeAllConnections?.(); remote.closeAllConnections?.();
		local.close(); remote.close();
	});

	const auth = installAuth(app, {
		directory: authDirectory,
		publicDirectory: fileURLToPath(new URL('../public', import.meta.url)),
		localPort: local.address().port,
		localHosts: ['127.0.0.1'],
		localNetworks: ['127.0.0.0/8'],
		publicOrigin: 'https://remote.test',
		setupPort: 8990
	});
	installQbittorrentRoutes(app, {
		requireOwner: (req, res) => {
			res.status(401).json({ error: 'Sign in as installation administrator.', signInRequired: true });
			return false;
		},
		directory: qbDirectory,
		sameOrigin: () => true,
		allowDownloads: req => auth.isOwnerAdmin(req)
	});

	const localBase = 'http://127.0.0.1:' + local.address().port;
	const remoteBase = 'http://127.0.0.1:' + remote.address().port;
	const call = (base, route, { method = 'GET', body, headers = {} } = {}) => fetch(base + route, {
		method,
		headers: {
			...(body === undefined ? {} : { 'Content-Type': 'application/json', Origin: base }),
			...headers
		},
		body: body === undefined ? undefined : JSON.stringify(body)
	});

	const localResponse = await call(localBase, '/api/activity/downloads');
	assert.equal(localResponse.status, 200);
	assert.equal(localResponse.headers.get('cache-control'), 'no-store');
	const localBody = await localResponse.json();
	assertAllowlisted(localBody);
	assert.equal(localBody.state, 'ok');
	assert.equal(localBody.filter, 'all');
	assert.equal(localBody.sampleSize, 1);
	assert.equal(localBody.hasMore, false);
	assert.deepEqual(localBody.counts, {
		downloading: 1, queued: 0, seeding: 0, paused: 0,
		checking: 0, moving: 0, attention: 0, other: 0
	});
	assert.deepEqual(localBody.countsLowerBound, []);
	assert.deepEqual(localBody.rows[0], {
		name: NAME,
		state: 'downloading',
		stateLabel: 'Downloading',
		progress: 0.375,
		size: 1000,
		dlspeed: 4500000,
		upspeed: 120000,
		eta: 900,
		ratio: 1.25
	});
	const afterLocal = upstream.state.requests.length;
	assert.ok(afterLocal > 0, 'the local read proves the synthetic upstream is reachable');
	// Six bounded filtered count queries plus the one bounded "Everything" page.
	assert.equal(upstream.state.infoReads, 7, 'counts use filtered queries, not one all-sample');

	// A real approved viewer then admin app token. The viewer is refused before
	// any qBittorrent contact; the admin is allowed by the same predicate.
	const enrolled = await call(localBase, '/api/apps/enroll', { method: 'POST', body: { name: 'Remote read-only 142' } });
	assert.ok([200, 201].includes(enrolled.status), 'local enrolment should succeed: ' + enrolled.status);
	const viewer = await enrolled.json();
	const viewerDenied = await call(remoteBase, '/api/activity/downloads', { headers: { Authorization: 'Bearer ' + viewer.token } });
	assert.equal(viewerDenied.status, 403);
	assert.equal(viewerDenied.headers.get('cache-control'), 'no-store');
	assert.match((await viewerDenied.json()).error, /only at home/i);
	assert.equal(upstream.state.requests.length, afterLocal, 'a denied viewer makes no upstream request');

	const promoted = await call(localBase, '/api/apps/' + viewer.id, { method: 'POST', body: { action: 'role', role: 'admin' } });
	assert.equal(promoted.status, 200);
	const adminResponse = await call(remoteBase, '/api/activity/downloads', { headers: { Authorization: 'Bearer ' + viewer.token } });
	assert.equal(adminResponse.status, 200, 'an installation administrator may read the list without an owner session');
	assert.equal(adminResponse.headers.get('cache-control'), 'no-store');
	assertAllowlisted(await adminResponse.json());

	const anonymous = await call(remoteBase, '/api/activity/downloads');
	assert.equal(anonymous.status, 401, 'an anonymous remote caller is stopped by the auth gate');

	// Every destructive or owner-only route still refuses the admin app token.
	const beforeDestructive = upstream.state.requests.length;
	for (const route of ['/api/qbittorrent/status', '/api/qbittorrent/downloads', '/activity/downloads']) {
		const response = await call(remoteBase, route, { headers: { Authorization: 'Bearer ' + viewer.token } });
		assert.equal(response.status, 401, route + ' stays owner-only');
	}
	for (const route of ['/api/qbittorrent/config', '/api/qbittorrent/disconnect', '/api/qbittorrent/confirm', '/api/qbittorrent/delete']) {
		const response = await call(remoteBase, route, {
			method: 'POST', body: { id: 'a'.repeat(32), token: 'b'.repeat(64), enabled: false },
			headers: { Authorization: 'Bearer ' + viewer.token }
		});
		assert.equal(response.status, 401, route + ' stays owner-only');
	}
	assert.equal(upstream.state.requests.length, beforeDestructive, 'refused owner routes make no upstream request');
});

test('a disabled integration answers with no rows and makes no upstream call', { timeout: 45000 }, async t => {
	const qbDirectory = temporaryDirectory(t, 'tellybox-qb-readonly-disabled-142-');
	const upstream = await startUpstream(t);
	writeFileSync(path.join(qbDirectory, 'qbittorrent.json'), JSON.stringify(configFor(upstream.base, { enabled: false })));

	const app = express();
	app.use((req, res, next) => { req.jserverLocal = true; next(); });
	installQbittorrentRoutes(app, {
		requireOwner: () => false,
		directory: qbDirectory,
		sameOrigin: () => true,
		allowDownloads: req => req.jserverLocal === true
	});
	const server = await listen(app);
	t.after(() => { server.closeAllConnections?.(); server.close(); });

	const response = await fetch('http://127.0.0.1:' + server.address().port + '/api/activity/downloads');
	assert.equal(response.status, 200);
	assert.equal(response.headers.get('cache-control'), 'no-store');
	const body = await response.json();
	assertAllowlisted(body, { rowCount: 0 });
	assert.equal(body.state, 'disabled');
	assert.equal(body.configured, true);
	assert.equal(body.enabled, false);
	assert.equal(body.sampleSize, 0);
	assert.deepEqual(body.rows, [], 'a disabled integration has no torrent rows');
	assert.equal(upstream.state.requests.length, 0, 'a disabled integration never opens a connection');
});

/* A read-only local viewer keeps the Downloads tab, sees names and progress,
 * and gets no removal controls. A refusal removes the section entirely. */
test('the Activity page renders a read-only downloads list without destructive controls', async () => {
	class Element {
		constructor(tag = 'div') {
			this.tag = tag; this.children = []; this.textContent = ''; this.className = '';
			this.hidden = false; this.disabled = false; this.dataset = {}; this.style = {};
			this.value = ''; this.tabIndex = 0;
		}
		append(...items) { this.children.push(...items); }
		replaceChildren(...items) { this.children = items; }
		setAttribute(name, value) { this[name] = String(value); }
		getAttribute(name) { return this[name] === undefined ? null : String(this[name]); }
		addEventListener() {}
		focus() {}
	}
	const nodes = {}, sections = {};
	const document = {
		hidden: false, visibilityState: 'visible', activeElement: null,
		createElement: tag => new Element(tag),
		createTextNode: text => Object.assign(new Element('text'), { textContent: text }),
		querySelector: key => {
			if (!nodes[key]) {
				const node = new Element();
				node.closest = selector => selector === 'section' && ['#recentPreviewHeading', '#browsersHeading', '#totalsHeading'].includes(key)
					? (sections[key] ||= new Element('section')) : null;
				nodes[key] = node;
			}
			return nodes[key];
		},
		addEventListener() {}
	};
	const calls = [];
	const summary = {
		generatedAt: Date.now(), readOnly: true,
		stats: { active: 0, downloads: 0, plays: 0, failed: 0, remoteIps: 0 },
		bandwidth: null, active: [], downloadCount: 0
	};
	const downloads = {
		readOnly: true, generatedAt: Date.now(), configured: true, enabled: true, state: 'ok',
		reachable: true, stale: false, checkedAt: Date.now(), filter: 'downloading', sampleSize: 1, hasMore: false,
		counts: { downloading: 1, queued: 0, seeding: 0, paused: 0, checking: 0, moving: 0, attention: 0, other: 0 },
		countsLowerBound: [],
		rows: [{ name: NAME, state: 'downloading', stateLabel: 'Downloading', progress: 0.375,
			size: 1000, dlspeed: 4500000, upspeed: 120000, eta: 900, ratio: 1.25 }]
	};
	const context = {
		document, Node: Element, setInterval() {}, setTimeout() { return 1; }, clearTimeout() {},
		fetch: async url => {
			calls.push(String(url));
			if (String(url).startsWith('/api/activity/downloads')) return { ok: true, status: 200, json: async () => downloads };
			if (url === '/api/activity/summary') return { ok: true, status: 200, json: async () => summary };
			return { ok: false, status: 403, json: async () => ({ error: 'Administrator access required.' }) };
		}
	};
	vm.runInNewContext(readFileSync(new URL('../public/activity-summary.js', import.meta.url), 'utf8'), context);
	vm.runInNewContext(readFileSync(new URL('../public/activity.js', import.meta.url), 'utf8'), context);
	await new Promise(resolve => setImmediate(resolve));
	await new Promise(resolve => setImmediate(resolve));

	assert.equal(nodes['#tabDownloads'].hidden, false, 'the read-only viewer keeps the Downloads tab');
	assert.equal(nodes['#downloadsOwnerLink'].hidden, true, 'owner controls are not offered');
	assert.equal(nodes['#downloadsOwnerNote'].hidden, true);

	nodes['#tabDownloads'].onclick();
	for (let index = 0; index < 4; index += 1) await new Promise(resolve => setImmediate(resolve));
	assert.ok(calls.some(url => url.startsWith('/api/activity/downloads')), 'selecting Downloads reads only the sanitized route');
	assert.equal(calls.some(url => url.startsWith('/api/qbittorrent/downloads')), false, 'the owner list is never requested');
	assert.equal(nodes['#tabDownloads'].getAttribute('aria-selected'), 'true', 'the Downloads tab is selected');
	assert.equal(nodes['#downloadsPanel'].hidden, false, 'the Downloads panel is visible');
	assert.equal(nodes['#downloadsStatus'].dataset.state, 'ok', 'the allowed status is rendered');
	const list = nodes['#downloadsList'];
	const listChildren = list.children.length;
	const textOf = node => [node.textContent, ...(node.children || []).map(textOf)].filter(Boolean).join(' | ');
	const text = textOf(list);
	assert.ok(listChildren > 0, 'the downloads list has rows');
	assert.match(text, new RegExp(NAME));
	assert.match(text, /37\.5%/);
	assert.match(text, /1\.25/);
	const collect = node => [node, ...(node.children || []).flatMap(child => collect(child))];
	const buttons = collect(list).filter(node => node.tag === 'button');
	assert.equal(buttons.length, 0, 'no destructive or pause control is rendered in the read-only list');
	assert.doesNotMatch(text, /Remove torrent|Delete torrent|cannot be recovered/i);
});

test('the Downloads panel is read-only, uses the new route and disappears on refusal', () => {
	const html = readFileSync(new URL('../public/activity.html', import.meta.url), 'utf8');
	const js = readFileSync(new URL('../public/activity.js', import.meta.url), 'utf8');
	const panel = html.slice(html.indexOf('<section id="downloadsPanel"'), html.indexOf('<p class="auth-note">Updates automatically'));
	assert.match(panel, /id="downloadsStatus"/);
	assert.match(panel, /id="downloadsList"/);
	assert.match(panel, /id="downloadsRefresh"/);
	assert.match(panel, /id="downloadsOwnerLink"[^>]*hidden/, 'the owner control link is hidden until the owner path is known');
	assert.doesNotMatch(panel, />\s*(?:Remove torrent|Delete torrent|Pause|Resume)[^<]*<\/button>/i, 'no destructive control lives in the Activity panel');
	assert.equal((panel.match(/<button\b/g) || []).length, 1, 'only the non-destructive refresh button is present');

	assert.match(js, /\/api\/activity\/downloads/);
	assert.doesNotMatch(js, /\/api\/qbittorrent\/(?:downloads|confirm|delete|config|disconnect)/, 'the read-only page never calls owner routes');
	assert.match(js, /response\.status === 401 \|\| response\.status === 403/);
	assert.match(js, /hideDownloadsPanel\(\)/);
	const hide = js.slice(js.indexOf('function hideDownloadsPanel()'), js.indexOf('function showDownloadsOwnerControls()'));
	assert.match(hide, /tab\.hidden = true/, 'a refused caller loses the tab');
	assert.match(hide, /panel\.hidden = true/, 'a refused caller loses the panel');
	assert.match(hide, /replaceChildren\(\)/, 'cached rows are cleared');
	assert.doesNotMatch(hide, /Sign in as installation administrator|Retry after sign-in/i, 'no sign-in prompt or locked teaser');
});

test('home presence alone no longer reads the allowlisted list', { timeout: 45000 }, async t => {
	const qbDirectory = temporaryDirectory(t, 'tellybox-qb-readonly-home-142-');
	const authDirectory = temporaryDirectory(t, 'tellybox-qb-readonly-home-auth-142-');
	const upstream = await startUpstream(t);
	writeFileSync(path.join(qbDirectory, 'qbittorrent.json'), JSON.stringify(configFor(upstream.base)));
	const HOME_IP = '203.0.113.142';

	const app = express();
	app.use(express.json());
	const server = await listen(app);
	t.after(() => { server.closeAllConnections?.(); server.close(); });

	const homeNetwork = createHomeNetwork('https://relay.example.test/relay-client-ip', {
		fetcher: async () => new Response(HOME_IP)
	});
	await homeNetwork.refresh();
	assert.equal(homeNetwork.matches(HOME_IP), true);
	const auth = installAuth(app, {
		directory: authDirectory,
		publicDirectory: fileURLToPath(new URL('../public', import.meta.url)),
		localPort: server.address().port,
		localHosts: ['127.0.0.1'],
		localNetworks: ['127.0.0.0/8'],
		publicOrigin: 'https://remote.test',
		trustedProxies: ['127.0.0.1'],
		homeTrustedProxy: '127.0.0.1',
		homeNetwork,
		setupPort: 8990
	});
	installQbittorrentRoutes(app, {
		requireOwner: (req, res) => { res.status(401).end(); return false; },
		directory: qbDirectory,
		sameOrigin: () => true,
		allowDownloads: req => auth.isOwnerAdmin(req)
	});

	const get = (headers) => new Promise((resolve, reject) => {
		const request = http.request({ host: '127.0.0.1', port: server.address().port,
			path: '/api/activity/downloads', method: 'GET', headers }, response => {
			const chunks = [];
			response.on('data', chunk => chunks.push(chunk));
			response.on('end', () => resolve({
				status: response.statusCode, headers: response.headers,
				text: Buffer.concat(chunks).toString('utf8')
			}));
		});
		request.on('error', reject);
		request.end();
	});

	const homeHeaders = { Host: 'remote.test', 'X-Forwarded-Proto': 'https', 'CF-Connecting-IP': HOME_IP };
	const status = await get({ ...homeHeaders, Host: 'remote.test' });
	assert.equal(status.status, 403, 'being at home is not an administrator role');
	assert.equal(status.headers['cache-control'], 'no-store');
	assert.deepEqual(JSON.parse(status.text), {
		error: 'Read-only qBittorrent downloads are available only at home or to an installation administrator.'
	});

	// Without the relay-verified address the same proxy request is remote and
	// unauthenticated, so the auth gate refuses it.
	const notHome = await get({ Host: 'remote.test', 'X-Forwarded-Proto': 'https' });
	assert.equal(notHome.status, 401);
});
