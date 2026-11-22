// Q71 Phase 1 — UK televised-football rail (server only).
// Every test runs against the saved live-footballontv.com fixture or an
// injected fetcher/clock. No test makes a network request.
//
// Run with TZ=Europe/London so the local-day window matches the UK source:
//   TZ=Europe/London node --test test/sport-listings-q71.test.mjs
process.env.TZ = process.env.TZ || 'Europe/London';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
	parseFixtures, sportWindow, buildChannelIndex, matchChannels,
	normalizeChannelName, canonicalChannelName, londonInstant, decodeEntities,
	createSportListings
} from '../sport-listings.mjs';

const FIXTURE = readFileSync(new URL('./fixtures/live-footballontv.html', import.meta.url), 'utf8');
const DAY = 86400000;
// A fixed London noon in November (GMT, so London wall time == UTC).
const NOW = Date.parse('2026-11-21T12:00:00Z');
const fx = (kickoff, home, away, competition = 'Premier League', channels = ['Sky Sports Football']) =>
	({ kickoff, home, away, competition, channels });

// --- parser against the real fixture -----------------------------------
test('parser reads the saved page into fixtures with finite kick-offs', () => {
	const fixtures = parseFixtures(FIXTURE);
	assert.ok(fixtures.length > 1000, `expected a full page of fixtures, got ${fixtures.length}`);
	for (const f of fixtures) {
		assert.ok(Number.isFinite(f.kickoff), 'every kept fixture has a real kick-off');
		assert.ok(f.home && f.away, 'both teams are present');
		assert.ok(Array.isArray(f.channels), 'channels is always an array');
		assert.ok(!/^(?:tbc|tba)$/i.test(f.home) && !/^(?:tbc|tba)$/i.test(f.away), 'TBC teams are skipped');
	}
});

test('parser reads the first fixture exactly as the page lists it', () => {
	const [first] = parseFixtures(FIXTURE);
	assert.equal(first.home, 'Dundee');
	assert.equal(first.away, 'Hearts');
	assert.equal(first.competition, 'Scottish Premiership');
	assert.deepEqual(first.channels, ['Premier Sports 1']);
	assert.equal(new Date(first.kickoff).toISOString(), '2026-11-21T17:45:00.000Z');
});

test('parser decodes HTML entities in teams and competitions', () => {
	const fixtures = parseFixtures(FIXTURE);
	assert.ok(fixtures.some(f => f.home === 'Brighton & Hove Albion'), '&amp; decoded');
	assert.ok(fixtures.some(f => f.home === "King's Lynn Town"), '&#x27; decoded');
	assert.ok(fixtures.some(f => f.competition === 'MLS Cup Round 1'), '&nbsp; collapsed');
});

test('parser keeps every channel of a multi-channel fixture', () => {
	const fixtures = parseFixtures(FIXTURE);
	const multi = fixtures.find(f => f.channels.length >= 3);
	assert.ok(multi, 'the page has fixtures on three or more channels');
	assert.ok(multi.channels.every(c => typeof c === 'string' && c.length));
});

test('parser tolerates malformed HTML without throwing', () => {
	for (const bad of ['', '<html><body>nothing here', '<div class="fixture">', '<<<>>>', '<div class="fixture-date">nonsense</div><div class="fixture"><div class="fixture__time">99:99</div></div>']) {
		assert.doesNotThrow(() => parseFixtures(bad));
		assert.deepEqual(parseFixtures(bad), []);
	}
	assert.doesNotThrow(() => parseFixtures(null));
	assert.deepEqual(parseFixtures(undefined), []);
});

test('kick-off conversion handles GMT and BST', () => {
	assert.equal(new Date(londonInstant(2026, 11, 21, 17, 45)).toISOString(), '2026-11-21T17:45:00.000Z');
	assert.equal(new Date(londonInstant(2026, 7, 21, 17, 45)).toISOString(), '2026-07-21T16:45:00.000Z');
});

// --- window boundaries --------------------------------------------------
test('window includes today and the next three days, excludes day four and the past', () => {
	const fixtures = [
		fx(NOW - 3 * 3600000, 'Past', 'Team'),          // earlier today -> excluded
		fx(NOW, 'Exact', 'Now'),                          // exactly now -> included
		fx(NOW + 5 * 3600000, 'Today', 'Later'),         // today future -> included
		fx(NOW + DAY + 2 * 3600000, 'Tomorrow', 'Game'), // +1 -> included
		fx(NOW + 3 * DAY + 2 * 3600000, 'Day', 'Three'), // +3 -> included
		fx(NOW + 4 * DAY + 2 * 3600000, 'Day', 'Four')   // +4 -> excluded
	];
	const rail = sportWindow(fixtures, [], NOW);
	const titles = rail.map(i => i.title);
	assert.ok(!titles.includes('Past v Team'), 'past kick-off excluded');
	assert.ok(titles.includes('Exact v Now'), 'kick-off equal to now is kept');
	assert.ok(titles.includes('Today v Later'));
	assert.ok(titles.includes('Tomorrow v Game'));
	assert.ok(titles.includes('Day v Three'), 'today+3 included');
	assert.ok(!titles.includes('Day v Four'), 'today+4 excluded');
	assert.equal(rail.length, 4);
});

test('window labels the four days Today, Tomorrow and weekday names', () => {
	const fixtures = [
		fx(NOW + 5 * 3600000, 'A', 'B'),
		fx(NOW + DAY + 2 * 3600000, 'C', 'D'),
		fx(NOW + 2 * DAY + 2 * 3600000, 'E', 'F'),
		fx(NOW + 3 * DAY + 2 * 3600000, 'G', 'H')
	];
	const rail = sportWindow(fixtures, [], NOW);
	assert.deepEqual(rail.map(i => i.dateLabel), ['Today', 'Tomorrow', 'Monday', 'Tuesday']);
});

test('window items carry the agreed API shape and sort by kick-off', () => {
	const rail = sportWindow([fx(NOW + 6 * 3600000, 'Late', 'Game'), fx(NOW + 3600000, 'Early', 'Game')], [], NOW);
	assert.deepEqual(Object.keys(rail[0]).sort(), ['channels', 'competition', 'date', 'dateLabel', 'id', 'title', 'type']);
	assert.equal(rail[0].type, 'sport');
	assert.equal(rail[0].title, 'Early v Game');
	assert.ok(rail[0].id.startsWith('sport-'));
	assert.equal(rail[0].date, new Date(NOW + 3600000).toISOString());
	assert.ok(Date.parse(rail[0].date) <= Date.parse(rail[1].date), 'sorted by kick-off');
});

test('the real fixture produces a four-day rail from today', () => {
	const rail = sportWindow(parseFixtures(FIXTURE), [], NOW);
	assert.ok(rail.length > 0);
	assert.deepEqual([...new Set(rail.map(i => i.dateLabel))], ['Today', 'Tomorrow', 'Monday', 'Tuesday']);
	assert.ok(rail.every(i => Date.parse(i.date) >= NOW), 'no past kick-offs in the rail');
});

// --- channel matching ---------------------------------------------------
const LINEUP = [
	{ id: 'ps1', name: 'Premier Sports 1 HD', number: '412' },
	{ id: 'ps14', name: 'Premier Sports 14', number: '425' },
	{ id: 'tnt1', name: 'TNT Sports 1', number: '401' },
	{ id: 'tnt10', name: 'TNT Sports 10', number: '410' },
	{ id: 'skyfb', name: 'Sky Sports Football', number: '405' },
	{ id: 'bbc1', name: 'BBC One UK', number: '101' },
	{ id: 'event', name: 'SKY SPORTS+ B 04', number: '900', nonstop: true }
];

test('owned channels get a channelId, unowned channels are name-only', () => {
	const index = buildChannelIndex(LINEUP);
	assert.deepEqual(matchChannels(['Sky Sports Football', 'NIFL TV'], index), [
		{ name: 'Sky Sports Football', channelId: 'skyfb' },
		{ name: 'NIFL TV' }
	]);
});

test('Premier Sports 1 never matches Premier Sports 14', () => {
	const index = buildChannelIndex(LINEUP);
	assert.equal(matchChannels(['Premier Sports 1'], index)[0].channelId, 'ps1');
	assert.equal(matchChannels(['Premier Sports 14'], index)[0].channelId, 'ps14');
	// A lineup with only the sibling must not match the requested number.
	const only14 = buildChannelIndex([{ id: 'ps14', name: 'Premier Sports 14', number: '425' }]);
	assert.deepEqual(matchChannels(['Premier Sports 1'], only14), [{ name: 'Premier Sports 1' }]);
});

test('TNT Sports 1 never matches TNT Sports 10', () => {
	const index = buildChannelIndex(LINEUP);
	assert.equal(matchChannels(['TNT Sports 1'], index)[0].channelId, 'tnt1');
	assert.equal(matchChannels(['TNT Sports 10'], index)[0].channelId, 'tnt10');
	const only10 = buildChannelIndex([{ id: 'tnt10', name: 'TNT Sports 10', number: '410' }]);
	assert.deepEqual(matchChannels(['TNT Sports 1'], only10), [{ name: 'TNT Sports 1' }]);
});

test('(UK) and HD/FHD/UHD suffixes normalise away', () => {
	const index = buildChannelIndex(LINEUP);
	assert.equal(matchChannels(['Premier Sports 1 (UK)'], index)[0].channelId, 'ps1');
	assert.equal(matchChannels(['Sky Sports Football HD'], index)[0].channelId, 'skyfb');
	assert.equal(matchChannels(['BBC One UK'], index)[0].channelId, 'bbc1');
	assert.equal(normalizeChannelName('Sky Sports Football FHD'), 'sky sports football');
	assert.equal(normalizeChannelName('Sky Sports Football UHD'), 'sky sports football');
	assert.equal(normalizeChannelName('Premier Sports 1 (UK)'), 'premier sports 1');
});

test('TNT Sport and TNT Sports are the same brand', () => {
	const index = buildChannelIndex(LINEUP);
	assert.equal(matchChannels(['TNT Sport 1'], index)[0].channelId, 'tnt1');
	assert.equal(canonicalChannelName('TNT Sport'), 'tnt sports');
	assert.equal(canonicalChannelName('TNT Sports'), 'tnt sports');
});

test('case, punctuation and whitespace are normalised', () => {
	assert.equal(normalizeChannelName('  sky   SPORTS football+  '), 'sky sports football');
	const index = buildChannelIndex([{ id: 'x', name: 'Sky Sports Football', number: '1' }]);
	assert.equal(matchChannels(['SKY SPORTS FOOTBALL'], index)[0].channelId, 'x');
});

test('numbered event feeds are never matched', () => {
	const index = buildChannelIndex(LINEUP);
	assert.deepEqual(matchChannels(['Sky Sports+'], index), [{ name: 'Sky Sports+' }]);
	assert.deepEqual(matchChannels(['SKY SPORTS+ B 04'], index), [{ name: 'SKY SPORTS+ B 04', channelId: 'event' }]);
});

test('a duplicate normalised name prefers the non-24/7, lowest-number channel', () => {
	const index = buildChannelIndex([
		{ id: 'hd', name: 'Sky Sports Football HD', number: '406' },
		{ id: 'sd', name: 'Sky Sports Football', number: '405' },
		{ id: 'loop', name: 'Sky Sports Football', number: '900', nonstop: true }
	]);
	assert.equal(matchChannels(['Sky Sports Football'], index)[0].channelId, 'sd');
});

// --- polite cached loader ----------------------------------------------
function response(html, { status = 200, etag = null, lastModified = null, retryAfter = null } = {}) {
	const headers = new Map();
	if (etag != null) headers.set('etag', etag);
	if (lastModified != null) headers.set('last-modified', lastModified);
	if (retryAfter != null) headers.set('retry-after', String(retryAfter));
	const bytes = Buffer.from(html ?? '', 'utf8');
	return {
		status, ok: status >= 200 && status < 300,
		headers: { get: name => headers.get(String(name).toLowerCase()) ?? null },
		body: (async function* () { if (bytes.length) yield bytes; })(),
		async text() { return html ?? ''; }
	};
}
function harness(responses, { now = NOW, channels = null, cachePath = '' } = {}) {
	const calls = [];
	let current = now;
	const queue = [...responses];
	const fetcher = async (url, opts) => {
		calls.push({ url, opts });
		const next = queue.length ? queue.shift() : responses[responses.length - 1];
		return typeof next === 'function' ? next() : next;
	};
	const loader = createSportListings({ fetcher, clock: () => current, channels, cachePath, version: '0.26.63' });
	return { loader, calls, advance: ms => { current += ms; }, now: () => current };
}

test('first load fetches once with an identifying UA and no redirects', async () => {
	const h = harness([response(FIXTURE, { etag: '"v1"', lastModified: 'Sat, 21 Nov 2026 20:37:41 GMT' })]);
	const rail = await h.loader.listings();
	assert.ok(rail.length > 0);
	assert.equal(h.calls.length, 1);
	const opts = h.calls[0].opts;
	assert.match(opts.headers['User-Agent'], /^Tellybox\/0\.26\.63 \(\+https:\/\/github\.com\/jharrisuk\/tellybox-homelab\)$/);
	assert.equal(opts.redirect, 'error');
	assert.ok(opts.signal, 'a timeout signal is set');
	assert.equal(opts.headers['Accept-Encoding'], 'identity');
	assert.equal(opts.headers['If-None-Match'], undefined, 'no conditional header on the first request');
	assert.equal(h.loader.unavailable(), false);
});

test('at most one request per six hours', async () => {
	const h = harness([response(FIXTURE, { etag: '"v1"' }), response(null, { status: 304 })]);
	await h.loader.listings();
	for (let i = 0; i < 5; i++) { h.advance(3600000); await h.loader.listings(); } // +5h, still < 6h
	assert.equal(h.calls.length, 1, 'no refetch inside the six-hour window');
	h.advance(2 * 3600000); // now +7h
	await h.loader.listings();
	await h.loader.refresh();
	assert.equal(h.calls.length, 2, 'one refetch once six hours have passed');
});

test('the second request is conditional and a 304 keeps the listings', async () => {
	const h = harness([
		response(FIXTURE, { etag: '"v1"', lastModified: 'Sat, 21 Nov 2026 20:37:41 GMT' }),
		response(null, { status: 304 })
	]);
	const first = await h.loader.listings();
	h.advance(7 * 3600000);
	await h.loader.listings();
	await h.loader.refresh();
	assert.equal(h.calls.length, 2);
	assert.equal(h.calls[1].opts.headers['If-None-Match'], '"v1"');
	assert.equal(h.calls[1].opts.headers['If-Modified-Since'], 'Sat, 21 Nov 2026 20:37:41 GMT');
	const second = await h.loader.listings();
	assert.deepEqual(second, sportWindow(parseFixtures(FIXTURE), [], h.now()), 'a 304 leaves the kept listings intact');
	assert.equal(h.loader.unavailable(), false);
});

test('a 503 keeps the previous listings and backs off without retrying', async () => {
	const h = harness([response(FIXTURE, { etag: '"v1"' }), response(null, { status: 503 }), response(FIXTURE)]);
	const first = await h.loader.listings();
	h.advance(7 * 3600000);
	await h.loader.listings();
	await h.loader.refresh();
	assert.equal(h.calls.length, 2);
	const after = await h.loader.listings();
	assert.deepEqual(after, sportWindow(parseFixtures(FIXTURE), [], h.now()), 'previous listings are kept on 503');
	assert.equal(h.loader.unavailable(), false, 'no false empty state after a failure');
	await h.loader.refresh(); // still inside the back-off
	assert.equal(h.calls.length, 2, 'no immediate retry after a 503');
});

test('a 429 honours Retry-After and waits at least an hour', async () => {
	const h = harness([response(FIXTURE), response(null, { status: 429, retryAfter: 7200 })]);
	await h.loader.listings();
	h.advance(7 * 3600000);
	await h.loader.listings();
	await h.loader.refresh();
	assert.equal(h.calls.length, 2);
	h.advance(3600000); // +1h, inside the 2h Retry-After back-off
	await h.loader.refresh();
	assert.equal(h.calls.length, 2, 'back-off blocks an early retry');
	assert.equal(h.loader.unavailable(), false);
});

test('a first-load failure yields an empty rail flagged unavailable', async () => {
	const h = harness([response(null, { status: 500 })]);
	const rail = await h.loader.listings();
	assert.deepEqual(rail, []);
	assert.equal(h.loader.unavailable(), true, 'unavailable only before the first successful load');
});

test('a network error keeps the previous listings', async () => {
	const h = harness([response(FIXTURE), () => { throw new Error('offline'); }]);
	const first = await h.loader.listings();
	h.advance(7 * 3600000);
	await h.loader.listings();
	await h.loader.refresh();
	assert.deepEqual(await h.loader.listings(), sportWindow(parseFixtures(FIXTURE), [], h.now()));
	assert.equal(h.loader.unavailable(), false);
});

test('an unrecognised layout never wipes good listings', async () => {
	const h = harness([response(FIXTURE), response('<html><body>a redesign with no fixtures</body></html>')]);
	const first = await h.loader.listings();
	h.advance(7 * 3600000);
	await h.loader.listings();
	await h.loader.refresh();
	assert.deepEqual(await h.loader.listings(), sportWindow(parseFixtures(FIXTURE), [], h.now()), 'a layout it cannot parse keeps the old rail');
	assert.equal(h.loader.unavailable(), false);
});

test('an over-cap response is rejected without crashing', async () => {
	const big = '<div class="fixture">' + 'x'.repeat(3 * 1024 * 1024) + '</div>';
	const h = harness([response(FIXTURE), response(big)]);
	const first = await h.loader.listings();
	h.advance(7 * 3600000);
	await h.loader.listings();
	await h.loader.refresh();
	assert.deepEqual(await h.loader.listings(), sportWindow(parseFixtures(FIXTURE), [], h.now()), 'the 2 MB cap keeps the previous listings');
});

test('a restart inside six hours does not refetch', async () => {
	const dir = mkdtempSync(path.join(tmpdir(), 'q71-sport-'));
	const cachePath = path.join(dir, 'sport-listings.json');
	try {
		const first = harness([response(FIXTURE, { etag: '"v1"' })], { cachePath });
		const rail = await first.loader.listings();
		assert.equal(first.calls.length, 1);
		// A brand-new loader (a restart) with a fetcher that must never be called.
		let refetched = 0;
		const restarted = createSportListings({
			fetcher: async () => { refetched++; return response(FIXTURE); },
			clock: () => NOW + 3600000, cachePath, version: '0.26.63'
		});
		const again = await restarted.listings();
		assert.equal(refetched, 0, 'the persisted parse is reused; no refetch on restart');
		assert.deepEqual(again, rail);
		assert.equal(restarted.unavailable(), false);
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test('channel matching uses the injected live lineup and survives its failure', async () => {
	const ok = harness([response(FIXTURE)], { channels: async () => LINEUP });
	const rail = await ok.loader.listings();
	const matched = rail.flatMap(i => i.channels).filter(c => c.channelId);
	assert.ok(matched.length > 0, 'some fixture channels match the lineup');
	assert.ok(rail.flatMap(i => i.channels).some(c => !c.channelId), 'unmatched channels stay name-only');

	const broken = harness([response(FIXTURE)], { channels: async () => { throw new Error('Dispatcharr not connected'); } });
	const stillWorks = await broken.loader.listings();
	assert.ok(stillWorks.length > 0, 'a lineup failure never breaks the rail');
	assert.ok(stillWorks.every(i => i.channels.every(c => !c.channelId)), 'all channels fall back to name-only');
});

test('decodeEntities handles named and numeric references safely', () => {
	assert.equal(decodeEntities('A &amp; B &#x27;C&#x27; &nbsp;D'), "A & B 'C'  D");
	assert.doesNotThrow(() => decodeEntities('&#xFFFFFFFF; &#0;'));
});
