// Q80 — admin sport settings (store + server gate + Coming Soon filtering).
// The store tests are pure. The server tests mount the real server.mjs (as the
// release-137 activity mount test does) with the sport caches pre-seeded, so the
// rail is populated from disk and NO network request is made. A fetch guard
// rejects any attempt to reach the sport sources and records every call.
//
//   TZ=Europe/London node --test test/sport-settings-q80.test.mjs
process.env.TZ = process.env.TZ || 'Europe/London';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createSportSettings, normaliseSportSettings } from '../sport-settings.mjs';
import { KNOWN_SPORTS, isUkCompetition } from '../livesportontv.mjs';

// --- store unit tests ---------------------------------------------------
test('defaults: enabled, every known sport, football uk', () => {
	const dir = mkdtempSync(path.join(tmpdir(), 'q80-store-'));
	try {
		const store = createSportSettings(dir);
		const s = store.status();
		assert.equal(s.enabled, true);
		assert.equal(s.football, 'uk');
		assert.deepEqual(s.sports, [...KNOWN_SPORTS].sort());
		assert.equal(s.sports.length, 20);
		assert.deepEqual(s.knownSports, [...KNOWN_SPORTS].sort());
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test('normaliseSportSettings repairs malformed input and validates the shape', () => {
	assert.deepEqual(normaliseSportSettings(null), { enabled: true, sports: [...KNOWN_SPORTS].sort(), football: 'uk' });
	assert.deepEqual(normaliseSportSettings('nonsense'), { enabled: true, sports: [...KNOWN_SPORTS].sort(), football: 'uk' });
	assert.equal(normaliseSportSettings({ enabled: false }).enabled, false);
	assert.equal(normaliseSportSettings({ enabled: 'yes' }).enabled, true, 'a non-boolean falls back to the default');
	assert.equal(normaliseSportSettings({ football: 'all' }).football, 'all');
	assert.equal(normaliseSportSettings({ football: 'bogus' }).football, 'uk');
	// Unknown slugs are dropped, duplicates removed, order stabilised.
	assert.deepEqual(normaliseSportSettings({ sports: ['boxing', 'football', 'boxing', 'not-a-sport'] }).sports, ['boxing', 'football']);
	assert.deepEqual(normaliseSportSettings({ sports: [] }).sports, [], 'an explicit empty list is kept (show nothing)');
});

test('set validates against the known list and the football enum', () => {
	const dir = mkdtempSync(path.join(tmpdir(), 'q80-store-'));
	try {
		const store = createSportSettings(dir);
		assert.throws(() => store.set({ sports: ['not-a-sport'] }), e => e.status === 400);
		assert.throws(() => store.set({ sports: 'boxing' }), e => e.status === 400);
		assert.throws(() => store.set({ football: 'bogus' }), e => e.status === 400);
		assert.throws(() => store.set({ enabled: 'yes' }), e => e.status === 400);
		assert.throws(() => store.set(null), e => e.status === 400);
		assert.throws(() => store.set([]), e => e.status === 400);
		// A valid partial update merges with the current state.
		const next = store.set({ enabled: false, sports: ['boxing', 'football'] });
		assert.equal(next.enabled, false);
		assert.deepEqual(next.sports, ['boxing', 'football']);
		assert.equal(next.football, 'uk', 'untouched fields keep their value');
		const again = store.set({ football: 'all' });
		assert.equal(again.enabled, false);
		assert.equal(again.football, 'all');
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the store persists to sport-settings.json and survives a reload', () => {
	const dir = mkdtempSync(path.join(tmpdir(), 'q80-store-'));
	try {
		const store = createSportSettings(dir);
		store.set({ enabled: false, sports: ['boxing'], football: 'all' });
		const file = path.join(dir, 'sport-settings.json');
		assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { enabled: false, sports: ['boxing'], football: 'all' });
		const reloaded = createSportSettings(dir);
		assert.deepEqual(reloaded.status().sports, ['boxing']);
		assert.equal(reloaded.status().enabled, false);
		assert.equal(reloaded.status().football, 'all');
		// A malformed file falls back to defaults rather than throwing.
		writeFileSync(file, '{broken json');
		const repaired = createSportSettings(dir);
		assert.equal(repaired.status().enabled, true);
		assert.deepEqual(repaired.status().sports, [...KNOWN_SPORTS].sort());
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

// --- real server mount: gate + Coming Soon filtering --------------------
async function listen(handler) {
	const server = http.createServer(handler);
	server.listen(0, '127.0.0.1');
	await once(server, 'listening');
	return server;
}

test('the real server gates writes to a local admin and applies settings to /api/coming-soon', { timeout: 60000 }, async t => {
	const directory = mkdtempSync(path.join(tmpdir(), 'q80-mount-'));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const dead = await listen((req, res) => { res.writeHead(503); res.end('{}'); });
	const local = await listen(() => {});
	const remote = await listen(() => {});
	t.after(() => {
		dead.closeAllConnections?.(); dead.close();
		local.closeAllConnections?.(); local.close();
		remote.closeAllConnections?.(); remote.close();
	});

	// Guard the network: the sport sources must never be reached. Caches are
	// seeded below so the loaders restore from disk and do not fetch at all.
	const realFetch = globalThis.fetch;
	const fetchCalls = [];
	globalThis.fetch = (url, opts) => {
		const u = String(url);
		fetchCalls.push(u);
		if (/livesportontv\.co\.uk|live-footballontv\.com/.test(u)) return Promise.reject(new Error('network disabled in test'));
		return realFetch(url, opts);
	};
	t.after(() => { globalThis.fetch = realFetch; });

	Object.assign(process.env, {
		NODE_ENV: 'test', AUTH_DIR: directory, DATA_DIR: directory, CATALOGUE_CACHE_DIR: directory,
		JELLYFIN_URL: 'http://127.0.0.1:' + dead.address().port,
		DISPATCHARR_URL: 'http://127.0.0.1:' + dead.address().port,
		PORT: String(local.address().port), SETUP_PORT: '8990',
		LOCAL_HOSTS: '127.0.0.1', LOCAL_NETWORKS: '127.0.0.0/8', PUBLIC_ORIGIN: 'https://remote.test'
	});
	writeFileSync(path.join(directory, 'connection.json'), JSON.stringify({ userId: 'fixture', token: 'fixture-only' }));
	writeFileSync(path.join(directory, 'apps.json'), JSON.stringify({}));
	writeFileSync(path.join(directory, 'account-limits.json'), JSON.stringify({ accounts: {} }));
	writeFileSync(path.join(directory, 'dispatcharr.json'), JSON.stringify({ key: 'fixture-only' }));
	writeFileSync(path.join(directory, 'capabilities.json'), JSON.stringify({
		jellyfin: true, library: true, live: false, nonstop: false, vod: false, recordings: false,
		catchup: false, discover: false, comingSoon: false, introdb: false, subtitles: false
	}));

	// Seed both rail caches with events relative to the real clock so the window
	// (today..today+3, no past kick-offs) is populated without any fetch.
	const NOW = Date.now();
	const seedState = (key, rows) => writeFileSync(path.join(directory, key), JSON.stringify({
		loaded: true, fetchedAt: NOW, attemptedAt: NOW, backoffUntil: 0, etag: null, lastModified: null, ...rows
	}));
	seedState('livesportontv.json', { events: [
		{ kickoff: NOW + 3600000, sport: 'football', title: 'Arsenal v Chelsea', competition: 'Premier League', notes: '', channels: ['Sky Sports Football'] },
		{ kickoff: NOW + 7200000, sport: 'football', title: 'Real Madrid v Barcelona', competition: 'La Liga', notes: '', channels: ['Premier Sports 1'] },
		{ kickoff: NOW + 10800000, sport: 'boxing', title: 'Live Boxing', competition: 'IBF Title Fights', notes: 'A vs B', channels: ['DAZN'] },
		{ kickoff: NOW + 86400000, sport: 'mma', title: 'UFC Fight Night', competition: 'Ultimate Fighting Championship', notes: 'X vs Y', channels: ['TNT Sports 1'] }
	] });
	seedState('sport-listings.json', { fixtures: [
		{ kickoff: NOW + 3600000, home: 'Arsenal', away: 'Chelsea', competition: 'Premier League', channels: ['Sky Sports Football'] },
		{ kickoff: NOW + 14400000, home: 'Dundee', away: 'Hearts', competition: 'Scottish Premiership', channels: ['Premier Sports 1'] }
	] });

	const { app } = await import('../server.mjs');
	local.on('request', app);
	remote.on('request', app);
	const localBase = 'http://127.0.0.1:' + local.address().port;
	const remoteBase = 'http://127.0.0.1:' + remote.address().port;
	const call = (base, route, { method = 'GET', body, headers = {} } = {}) => realFetch(base + route, {
		method,
		headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json', Origin: base }), ...headers },
		body: body === undefined ? undefined : JSON.stringify(body)
	});
	const titles = sport => sport.map(i => i.title).sort();

	// --- read gate: any authenticated/local viewer may read ---
	const localRead = await call(localBase, '/api/sport-settings');
	assert.equal(localRead.status, 200);
	assert.equal(localRead.headers.get('cache-control'), 'no-store');
	const defaults = await localRead.json();
	assert.equal(defaults.enabled, true);
	assert.equal(defaults.football, 'uk');
	assert.equal(defaults.sports.length, 20);

	const anonRemote = await call(remoteBase, '/api/sport-settings');
	assert.equal(anonRemote.status, 401, 'an anonymous remote caller is stopped by the auth gate');

	const enrolled = await call(localBase, '/api/apps/enroll', { method: 'POST', body: { name: 'Synthetic remote viewer q80' } });
	assert.ok([200, 201].includes(enrolled.status), 'local enrolment succeeds: ' + enrolled.status);
	const viewer = await enrolled.json();
	assert.equal(viewer.role, 'viewer');
	const viewerRead = await call(remoteBase, '/api/sport-settings', { headers: { Authorization: 'Bearer ' + viewer.token } });
	assert.equal(viewerRead.status, 200, 'an authenticated remote viewer may read settings');

	// --- write gate: local admin only; a viewer cannot write ---
	const viewerWrite = await call(remoteBase, '/api/sport-settings', { method: 'POST', body: { enabled: false }, headers: { Authorization: 'Bearer ' + viewer.token } });
	assert.equal(viewerWrite.status, 403, 'a remote viewer cannot write');
	const localAppWrite = await call(localBase, '/api/sport-settings', { method: 'POST', body: { enabled: false }, headers: { Authorization: 'Bearer ' + viewer.token } });
	assert.equal(localAppWrite.status, 403, 'an app token cannot write even locally');
	const noOrigin = await call(localBase, '/api/sport-settings', { method: 'POST', body: { enabled: false }, headers: { Origin: '' } });
	assert.equal(noOrigin.status, 403, 'a same-origin JSON action is required');
	const badOrigin = await call(localBase, '/api/sport-settings', { method: 'POST', body: { enabled: false }, headers: { Origin: 'https://evil.test' } });
	assert.equal(badOrigin.status, 403, 'a cross-origin write is refused');
	const notJson = await realFetch(localBase + '/api/sport-settings', { method: 'POST', headers: { Origin: localBase, 'Content-Type': 'text/plain' }, body: 'enabled=false' });
	assert.equal(notJson.status, 403, 'a non-JSON write is refused');

	// --- validation ---
	for (const bad of [{ sports: ['not-a-sport'] }, { football: 'bogus' }, { enabled: 'yes' }]) {
		const r = await call(localBase, '/api/sport-settings', { method: 'POST', body: bad });
		assert.equal(r.status, 400, 'invalid settings are rejected: ' + JSON.stringify(bad));
	}

	// --- Coming Soon applies the settings (default: enabled, all sports, uk) ---
	const soon = async () => (await call(localBase, '/api/coming-soon')).json();
	let body = await soon();
	assert.ok(Array.isArray(body.tv) && Array.isArray(body.movies), 'tv/movies fields are unchanged');
	assert.ok(!body.sportUnavailable, 'both sources loaded from cache, so the rail is available');
	assert.deepEqual(titles(body.sport), ['Arsenal v Chelsea', 'Dundee v Hearts', 'Live Boxing', 'UFC Fight Night'],
		'boxing and MMA show; non-UK football (La Liga) is hidden; the duplicate Arsenal fixture is merged once');
	assert.ok(body.sport.every(i => i.sport !== 'football' || isUkCompetition(i.competition)), 'only UK football remains');
	assert.ok(body.sport.some(i => i.sport === 'boxing'), 'boxing is present');
	const arsenal = body.sport.find(i => i.title === 'Arsenal v Chelsea');
	assert.equal(arsenal.source, 'live-footballontv.com', 'the football rail wins the dedupe tie');

	// disabled hides the rail entirely (empty, not unavailable)
	let r = await call(localBase, '/api/sport-settings', { method: 'POST', body: { enabled: false } });
	assert.equal(r.status, 200);
	body = await soon();
	assert.deepEqual(body.sport, [], 'disabled hides the sport rail');
	assert.equal(body.sportDisabled, true, 'the client can tell a disabled rail from an empty one');
	assert.ok(!body.sportUnavailable, 'a disabled rail is not flagged unavailable');

	// sports allow-list
	r = await call(localBase, '/api/sport-settings', { method: 'POST', body: { enabled: true, sports: ['boxing'], football: 'all' } });
	assert.equal(r.status, 200);
	body = await soon();
	assert.deepEqual(titles(body.sport), ['Live Boxing'], 'only the chosen sport shows');

	// football all brings back non-UK football
	r = await call(localBase, '/api/sport-settings', { method: 'POST', body: { enabled: true, sports: KNOWN_SPORTS, football: 'all' } });
	assert.equal(r.status, 200);
	body = await soon();
	assert.ok(body.sport.some(i => i.title === 'Real Madrid v Barcelona'), 'football all shows La Liga');
	assert.equal(body.sport.length, 5);

	// football only + uk
	r = await call(localBase, '/api/sport-settings', { method: 'POST', body: { enabled: true, sports: ['football'], football: 'uk' } });
	assert.equal(r.status, 200);
	body = await soon();
	assert.deepEqual(titles(body.sport), ['Arsenal v Chelsea', 'Dundee v Hearts'], 'football uk only');

	// football only + all
	r = await call(localBase, '/api/sport-settings', { method: 'POST', body: { enabled: true, sports: ['football'], football: 'all' } });
	assert.equal(r.status, 200);
	body = await soon();
	assert.deepEqual(titles(body.sport), ['Arsenal v Chelsea', 'Dundee v Hearts', 'Real Madrid v Barcelona'], 'football all');

	// The settings write persisted to disk.
	assert.deepEqual(JSON.parse(readFileSync(path.join(directory, 'sport-settings.json'), 'utf8')),
		{ enabled: true, sports: ['football'], football: 'all' });

	// No request ever reached the sport sources.
	assert.ok(!fetchCalls.some(u => /livesportontv\.co\.uk|live-footballontv\.com/.test(u)),
		'the seeded caches were used; the sport sources were never fetched');
});
