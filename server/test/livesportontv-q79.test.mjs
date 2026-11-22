// Q79 — all-sports rail from livesportontv.co.uk (server only).
// Every test runs against the saved livesportontv-home.html fixture or an
// injected fetcher/clock. No test makes a network request.
//
// Run with TZ=Europe/London so the local-day window matches the UK source:
//   TZ=Europe/London node --test test/livesportontv-q79.test.mjs
process.env.TZ = process.env.TZ || 'Europe/London';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
	parseEvents, allSportWindow, mergeSportRails, applySportSettings, dedupeKey,
	isUkCompetition, competitionKey, sportSlug, KNOWN_SPORTS, createLiveSportOntv,
	LIVESPORT_SOURCE_URL
} from '../livesportontv.mjs';
import { parseFixtures, sportWindow, buildChannelIndex, matchChannels, normalizeChannelName, canonicalChannelName } from '../sport-listings.mjs';

const FIXTURE = readFileSync(new URL('./fixtures/livesportontv-home.html', import.meta.url), 'utf8');
const FOOTBALL = readFileSync(new URL('./fixtures/live-footballontv.html', import.meta.url), 'utf8');
const DAY = 86400000;
// A fixed London noon in November (GMT, so London wall time == UTC). The sample
// guide covers 2026-11-21 .. 2026-11-27, so this sits inside the sampled week.
const NOW = Date.parse('2026-11-21T12:00:00Z');
const ev = (kickoff, sport, title, competition = '', channels = [], notes = '') =>
	({ kickoff, sport, title, competition, notes, channels });

// --- parser against the real fixture -----------------------------------
test('parser reads the saved page into a full week of events across 20 sports', () => {
	const events = parseEvents(FIXTURE);
	assert.ok(events.length > 600, `expected the whole guide, got ${events.length}`);
	const sports = new Set(events.map(e => e.sport));
	assert.equal(sports.size, 20, 'the source carries 20 sports');
	for (const slug of ['football', 'boxing', 'mma', 'rugby', 'formula-1', 'basketball', 'darts', 'snooker']) {
		assert.ok(sports.has(slug), `sport ${slug} is present`);
	}
	for (const e of events) {
		assert.ok(Number.isFinite(e.kickoff), 'every kept event has a real kick-off');
		assert.ok(e.title, 'every event has a title');
		assert.ok(Array.isArray(e.channels), 'channels is always an array');
		assert.ok(KNOWN_SPORTS.includes(e.sport), 'every sport maps to a known slug');
	}
});

test('the UK day window survives the process timezone at the BST edge', () => {
	const now = Date.parse('2026-07-01T23:30:00Z'); // 00:30 BST on 2 July
	const events = [
		{ kickoff: Date.parse('2026-07-05T10:00:00Z'), sport: 'boxing', title: 'Late card', competition: '', notes: '', channels: [] }
	];
	const items = allSportWindow(events, [], now);
	assert.equal(items.length, 1, 'a UK today+3 fixture survives after the UTC day has not rolled');
	assert.equal(items[0].dateLabel, 'Sunday');
	const tomorrow = allSportWindow([{ kickoff: Date.parse('2026-07-01T23:30:00Z'), sport: 'boxing', title: 'Midnight card', competition: '', notes: '', channels: [] }], [], Date.parse('2026-07-01T10:00:00Z'));
	assert.equal(tomorrow[0].dateLabel, 'Tomorrow', 'the label follows the UK day, not UTC');
});

test('parser reads a boxing event exactly as the page lists it', () => {
	const boxing = parseEvents(FIXTURE).find(e => e.sport === 'boxing' && e.competition === 'IBF Title Fights');
	assert.ok(boxing, 'the sampled week has an IBF title fight');
	assert.equal(boxing.title, 'Live Boxing');
	assert.equal(boxing.notes, 'Amari Jones vs DeAundre Pettus', 'the fighters live in the note');
	assert.deepEqual(boxing.channels, ['DAZN']);
	// 2026-11-21 01:00 London (GMT) == 01:00 UTC.
	assert.equal(new Date(boxing.kickoff).toISOString(), '2026-11-21T01:00:00.000Z');
});

test('parser reads an MMA (UFC-style) event with its note and stream channel', () => {
	const mma = parseEvents(FIXTURE).find(e => e.sport === 'mma' && e.competition === 'Legacy Fighting Alliance');
	assert.ok(mma);
	assert.equal(mma.title, 'MMA');
	assert.equal(mma.notes, 'Marcos Breno vs Eduardo Torres');
	assert.deepEqual(mma.channels, ['YouTube']);
});

test('parser reads football with competition, multi-channel JSON and entity decoding', () => {
	const events = parseEvents(FIXTURE);
	const pl = events.find(e => e.sport === 'football' && e.competition === 'Premier League');
	assert.ok(pl, 'a Premier League fixture is present');
	assert.match(pl.title, / v /, 'football titles are two sides');
	assert.ok(pl.channels.length >= 1);
	// The source entity-encodes the apostrophe in Women's Super League.
	const wsl = events.find(e => e.competition === "Women's Super League");
	assert.ok(wsl, '&#039; is decoded in the competition');
	// A multi-channel football fixture keeps every name from the JSON array.
	const multi = events.find(e => e.sport === 'football' && e.channels.length >= 3);
	assert.ok(multi, 'some football fixtures are on three or more channels');
	assert.ok(multi.channels.every(c => typeof c === 'string' && c.length));
});

test('parser converts a summer panel date using BST, not GMT', () => {
	const summer = '<div class="lsotv-panel" data-date="2026-07-21">'
		+ '<article class="lsotv-event" data-sport="Boxing" data-channels="[&quot;DAZN&quot;]">'
		+ '<div class="lsotv-time">17:45</div><div class="lsotv-detail"><h4>Live Boxing</h4><p>Title Fight</p></div>'
		+ '</article></div>';
	const [event] = parseEvents(summer);
	assert.ok(event);
	// 17:45 BST == 16:45 UTC.
	assert.equal(new Date(event.kickoff).toISOString(), '2026-07-21T16:45:00.000Z');
});

test('parser tolerates malformed HTML without throwing', () => {
	for (const bad of ['', '<html><body>nothing here', '<article class="lsotv-event">', '<<<>>>',
		'<div class="lsotv-panel" data-date="nonsense"><article class="lsotv-event" data-sport="Boxing"><div class="lsotv-time">99:99</div><h4>x</h4></article></div>']) {
		assert.doesNotThrow(() => parseEvents(bad));
		assert.deepEqual(parseEvents(bad), []);
	}
	assert.doesNotThrow(() => parseEvents(null));
	assert.deepEqual(parseEvents(undefined), []);
});

test('parser skips events with no usable time, title or sport', () => {
	const panel = '<div class="lsotv-panel" data-date="2026-11-21">';
	const noTime = panel + '<article class="lsotv-event" data-sport="Boxing" data-channels="[]"><div class="lsotv-time">TBC</div><h4>Live Boxing</h4></article></div>';
	assert.deepEqual(parseEvents(noTime), [], 'a TBC kick-off cannot be placed in time');
	const noTitle = panel + '<article class="lsotv-event" data-sport="Boxing" data-channels="[]"><div class="lsotv-time">01:00</div></article></div>';
	assert.deepEqual(parseEvents(noTitle), [], 'no title is skipped');
	const noSport = panel + '<article class="lsotv-event" data-channels="[]"><div class="lsotv-time">01:00</div><h4>x</h4></article></div>';
	assert.deepEqual(parseEvents(noSport), [], 'no sport is skipped');
	const badChannels = panel + '<article class="lsotv-event" data-sport="Boxing" data-channels="not json"><div class="lsotv-time">01:00</div><h4>Live Boxing</h4></article></div>';
	const [kept] = parseEvents(badChannels);
	assert.ok(kept, 'a broken channels attribute keeps the event');
	assert.deepEqual(kept.channels, [], 'with no channels rather than throwing');
});

test('sportSlug maps the source enum and falls back deterministically', () => {
	assert.equal(sportSlug('Football'), 'football');
	assert.equal(sportSlug('Rugby Union'), 'rugby');
	assert.equal(sportSlug('Formula 1'), 'formula-1');
	assert.equal(sportSlug('MMA'), 'mma');
	assert.equal(sportSlug('Some New Sport'), 'some-new-sport');
	assert.equal(sportSlug(''), 'other');
	assert.equal(KNOWN_SPORTS.length, 20);
	assert.deepEqual([...KNOWN_SPORTS].sort(), KNOWN_SPORTS, 'the known list is sorted');
});

// --- window boundaries --------------------------------------------------
test('window includes today and the next three days, excludes day four and the past', () => {
	const events = [
		ev(NOW - 3 * 3600000, 'boxing', 'Past Fight'),
		ev(NOW, 'boxing', 'Exact Now'),
		ev(NOW + 5 * 3600000, 'boxing', 'Today Later'),
		ev(NOW + DAY + 2 * 3600000, 'mma', 'Tomorrow Game'),
		ev(NOW + 3 * DAY + 2 * 3600000, 'rugby', 'Day Three'),
		ev(NOW + 4 * DAY + 2 * 3600000, 'darts', 'Day Four')
	];
	const rail = allSportWindow(events, [], NOW);
	const titles = rail.map(i => i.title);
	assert.ok(!titles.includes('Past Fight'), 'past kick-off excluded');
	assert.ok(titles.includes('Exact Now'), 'kick-off equal to now is kept');
	assert.ok(titles.includes('Today Later'));
	assert.ok(titles.includes('Tomorrow Game'));
	assert.ok(titles.includes('Day Three'), 'today+3 included');
	assert.ok(!titles.includes('Day Four'), 'today+4 excluded');
	assert.equal(rail.length, 4);
});

test('window labels the four days Today, Tomorrow and weekday names', () => {
	const events = [
		ev(NOW + 5 * 3600000, 'football', 'A v B'),
		ev(NOW + DAY + 2 * 3600000, 'football', 'C v D'),
		ev(NOW + 2 * DAY + 2 * 3600000, 'football', 'E v F'),
		ev(NOW + 3 * DAY + 2 * 3600000, 'football', 'G v H')
	];
	const rail = allSportWindow(events, [], NOW);
	assert.deepEqual(rail.map(i => i.dateLabel), ['Today', 'Tomorrow', 'Monday', 'Tuesday']);
});

test('window items carry the agreed API shape and sort by kick-off', () => {
	const rail = allSportWindow([ev(NOW + 6 * 3600000, 'boxing', 'Late Fight', 'IBF Title', ['DAZN'], 'A vs B'), ev(NOW + 3600000, 'boxing', 'Early Fight')], [], NOW);
	assert.deepEqual(Object.keys(rail[0]).sort(), ['channels', 'competition', 'date', 'dateLabel', 'id', 'notes', 'source', 'sport', 'title', 'type']);
	assert.equal(rail[0].type, 'sport');
	assert.equal(rail[0].sport, 'boxing');
	assert.equal(rail[0].title, 'Early Fight');
	assert.ok(rail[0].id.startsWith('sport-'));
	assert.equal(rail[0].source, 'livesportontv.co.uk');
	assert.equal(rail[0].date, new Date(NOW + 3600000).toISOString());
	assert.ok(Date.parse(rail[0].date) <= Date.parse(rail[1].date), 'sorted by kick-off');
});

test('the real fixture produces a four-day all-sports rail from today', () => {
	const rail = allSportWindow(parseEvents(FIXTURE), [], NOW);
	assert.ok(rail.length > 100);
	assert.deepEqual([...new Set(rail.map(i => i.dateLabel))], ['Today', 'Tomorrow', 'Monday', 'Tuesday']);
	assert.ok(rail.every(i => Date.parse(i.date) >= NOW), 'no past kick-offs in the rail');
	assert.ok(new Set(rail.map(i => i.sport)).size > 10, 'many sports survive the window');
	assert.ok(rail.some(i => i.sport === 'boxing'), 'boxing is in the rail');
});

// --- channel matching (reuses the football normalisation) ---------------
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
	const rail = allSportWindow([ev(NOW + 3600000, 'boxing', 'Fight', '', ['Sky Sports Football', 'DAZN'])], LINEUP, NOW);
	assert.deepEqual(rail[0].channels, [
		{ name: 'Sky Sports Football', channelId: 'skyfb' },
		{ name: 'DAZN' }
	]);
});

test('numbered siblings never cross-match (TNT 1/10, Premier Sports 1/14)', () => {
	const index = buildChannelIndex(LINEUP);
	assert.equal(matchChannels(['TNT Sports 1'], index)[0].channelId, 'tnt1');
	assert.equal(matchChannels(['TNT Sports 10'], index)[0].channelId, 'tnt10');
	assert.equal(matchChannels(['Premier Sports 1'], index)[0].channelId, 'ps1');
	assert.equal(matchChannels(['Premier Sports 14'], index)[0].channelId, 'ps14');
	const only10 = buildChannelIndex([{ id: 'tnt10', name: 'TNT Sports 10', number: '410' }]);
	assert.deepEqual(matchChannels(['TNT Sports 1'], only10), [{ name: 'TNT Sports 1' }]);
});

test('quality/region suffixes and the TNT singular normalise away', () => {
	const index = buildChannelIndex(LINEUP);
	assert.equal(matchChannels(['Sky Sports Football HD'], index)[0].channelId, 'skyfb');
	assert.equal(matchChannels(['Premier Sports 1 (UK)'], index)[0].channelId, 'ps1');
	assert.equal(matchChannels(['TNT Sport 1'], index)[0].channelId, 'tnt1');
	assert.equal(normalizeChannelName('Sky Sports Football UHD'), 'sky sports football');
	assert.equal(canonicalChannelName('TNT Sport'), 'tnt sports');
	assert.equal(normalizeChannelName('  sky   SPORTS football+  '), 'sky sports football');
});

test('numbered event feeds are never matched; duplicates prefer non-24/7 lowest number', () => {
	const index = buildChannelIndex(LINEUP);
	assert.deepEqual(matchChannels(['Sky Sports+'], index), [{ name: 'Sky Sports+' }]);
	assert.deepEqual(matchChannels(['SKY SPORTS+ B 04'], index), [{ name: 'SKY SPORTS+ B 04', channelId: 'event' }]);
	const dup = buildChannelIndex([
		{ id: 'hd', name: 'Sky Sports Football HD', number: '406' },
		{ id: 'sd', name: 'Sky Sports Football', number: '405' },
		{ id: 'loop', name: 'Sky Sports Football', number: '900', nonstop: true }
	]);
	assert.equal(matchChannels(['Sky Sports Football'], dup)[0].channelId, 'sd');
});

test('the real fixture matches the live lineup and keeps unowned names', () => {
	const rail = allSportWindow(parseEvents(FIXTURE), LINEUP, NOW);
	const all = rail.flatMap(i => i.channels);
	assert.ok(all.some(c => c.channelId), 'some channels match the lineup');
	assert.ok(all.some(c => !c.channelId), 'unmatched channels stay name-only');
});

// --- merge / dedupe with the football source ----------------------------
test('merge dedupes by kick-off + title and keeps the football rail item on a tie', () => {
	const football = [{ type: 'sport', id: 'sport-foot', title: 'Dundee v Hearts', competition: 'Scottish Premiership', date: new Date(NOW + 3600000).toISOString(), dateLabel: 'Today', channels: [{ name: 'Premier Sports 1', channelId: 'ps1' }] }];
	const all = [
		ev(NOW + 3600000, 'football', 'Dundee v Hearts', 'Scottish Premiership', ['Premier Sports 1']),
		ev(NOW + 7200000, 'boxing', 'Live Boxing', 'IBF Title', ['DAZN'])
	];
	const allRail = allSportWindow(all, LINEUP, NOW);
	const merged = mergeSportRails(football, allRail);
	assert.equal(merged.length, 2, 'the duplicate football fixture is merged once');
	const dundee = merged.find(i => i.title === 'Dundee v Hearts');
	assert.equal(dundee.id, 'sport-foot', 'the football rail item wins the tie');
	assert.equal(dundee.sport, 'football', 'football items are tagged with a sport');
	assert.equal(dundee.source, 'live-footballontv.com');
	assert.ok(merged.some(i => i.sport === 'boxing'), 'other sports are added');
});

test('merge normalises the v/vs separator and case when deduping', () => {
	const football = [{ type: 'sport', id: 'sport-f', title: 'Arsenal v Chelsea', competition: 'Premier League', date: new Date(NOW + 3600000).toISOString(), dateLabel: 'Today', channels: [] }];
	const allRail = allSportWindow([ev(NOW + 3600000, 'football', 'Arsenal VS Chelsea', 'Premier League', ['Sky Sports Football'])], LINEUP, NOW);
	const merged = mergeSportRails(football, allRail);
	assert.equal(merged.length, 1, '"v" and "VS" are the same fixture');
	assert.equal(merged[0].id, 'sport-f');
});

test('merge keeps distinct kick-offs apart and sorts the combined rail', () => {
	const football = [{ type: 'sport', id: 'sport-f', title: 'Same Teams', competition: 'Premier League', date: new Date(NOW + 3600000).toISOString(), dateLabel: 'Today', channels: [] }];
	const allRail = allSportWindow([ev(NOW + 7200000, 'football', 'Same Teams', 'Premier League', [])], LINEUP, NOW);
	const merged = mergeSportRails(football, allRail);
	assert.equal(merged.length, 2, 'a different kick-off is a different event');
	assert.ok(Date.parse(merged[0].date) <= Date.parse(merged[1].date), 'sorted by kick-off');
});

test('merge against the two real fixtures removes overlapping football and adds breadth', () => {
	const footballRail = sportWindow(parseFixtures(FOOTBALL), LINEUP, NOW);
	const allRail = allSportWindow(parseEvents(FIXTURE), LINEUP, NOW);
	const merged = mergeSportRails(footballRail, allRail);
	assert.ok(merged.length < footballRail.length + allRail.length, 'overlapping football fixtures are deduped');
	assert.ok(merged.length >= Math.max(footballRail.length, allRail.length), 'nothing is lost');
	assert.ok(merged.some(i => i.sport === 'boxing'), 'boxing survives the merge');
	assert.ok(merged.every(i => i.sport), 'every merged item has a sport');
	// No two items share a dedupe key.
	const keys = merged.map(dedupeKey);
	assert.equal(new Set(keys).size, keys.length, 'the merged rail has no duplicate keys');
});

// --- Q80 settings filtering (pure) --------------------------------------
test('the curated UK competition list passes; unknown competitions do not', () => {
	const uk = ['Premier League', 'Championship', 'League One', 'League Two', 'FA Cup', 'EFL Cup', 'Carabao Cup',
		'Scottish Premiership', 'Scottish Championship', 'Scottish Cup', "Women's Super League", 'Community Shield', 'National League',
		'English Premier League', 'EFL Championship', 'Emirates FA Cup', "Barclays Women's Super League",
		'Premier Sports Cup Final', 'FA Cup Second Round', 'Carabao Cup Quarter-Final', 'cinch Premiership',
		'Sky Bet Championship', 'Viaplay Cup', 'SWPL1'];
	const other = ['La Liga', 'Bundesliga', 'UEFA Champions League', 'International Friendly', 'U18 Premier League', 'National League North', ''];
	for (const name of uk) assert.ok(isUkCompetition(name), `UK competition ${name} is kept`);
	for (const name of other) assert.ok(!isUkCompetition(name), `unknown competition ${JSON.stringify(name)} is excluded`);
	assert.equal(competitionKey("Women's Super League"), 'womens super league');
});

test('same-minute boxing cards with different fighters stay separate', () => {
	const date = new Date().toISOString();
	const a = dedupeKey({ date, sport: 'boxing', title: 'Live Boxing', notes: 'A vs B' });
	const b = dedupeKey({ date, sport: 'boxing', title: 'Live Boxing', notes: 'C vs D' });
	assert.notEqual(a, b, 'the fighters in notes keep two events apart');
});

test('applySportSettings: disabled hides the whole rail', () => {
	const items = [{ sport: 'football', competition: 'Premier League' }, { sport: 'boxing', competition: 'IBF' }];
	assert.deepEqual(applySportSettings(items, { enabled: false, sports: KNOWN_SPORTS, football: 'all' }), []);
});

test('applySportSettings: the sports allow-list filters by slug', () => {
	const items = [{ sport: 'football', competition: 'Premier League' }, { sport: 'boxing', competition: 'IBF' }, { sport: 'mma', competition: 'UFC' }];
	const onlyBoxing = applySportSettings(items, { enabled: true, sports: ['boxing'], football: 'all' });
	assert.deepEqual(onlyBoxing.map(i => i.sport), ['boxing']);
	assert.deepEqual(applySportSettings(items, { enabled: true, sports: [], football: 'all' }), [], 'an empty allow-list shows nothing');
	assert.deepEqual(applySportSettings(items, { enabled: true, sports: ['boxing', 'mma'], football: 'all' }).map(i => i.sport), ['boxing', 'mma']);
});

test('applySportSettings: football uk keeps curated competitions, all keeps everything; other sports untouched', () => {
	const items = [
		{ sport: 'football', competition: 'Premier League' },
		{ sport: 'football', competition: 'La Liga' },
		{ sport: 'football', competition: "Women's Super League" },
		{ sport: 'boxing', competition: 'IBF Title Fights' },
		{ sport: 'mma', competition: 'UFC' }
	];
	const uk = applySportSettings(items, { enabled: true, sports: KNOWN_SPORTS, football: 'uk' });
	assert.deepEqual(uk.map(i => i.competition), ['Premier League', "Women's Super League", 'IBF Title Fights', 'UFC'], 'non-UK football dropped, other sports kept');
	const all = applySportSettings(items, { enabled: true, sports: KNOWN_SPORTS, football: 'all' });
	assert.equal(all.length, 5, 'football all keeps La Liga too');
	// The football setting never hides a non-football sport.
	const boxingOnlyUk = applySportSettings(items, { enabled: true, sports: ['boxing', 'mma'], football: 'uk' });
	assert.deepEqual(boxingOnlyUk.map(i => i.sport), ['boxing', 'mma']);
});

test('applySportSettings over the real merged rail behaves end to end', () => {
	const merged = mergeSportRails(sportWindow(parseFixtures(FOOTBALL), LINEUP, NOW), allSportWindow(parseEvents(FIXTURE), LINEUP, NOW));
	const uk = applySportSettings(merged, { enabled: true, sports: KNOWN_SPORTS, football: 'uk' });
	assert.ok(uk.some(i => i.sport === 'boxing'), 'boxing is shown under the default settings');
	assert.ok(uk.filter(i => i.sport === 'football').every(i => isUkCompetition(i.competition)), 'only UK football remains');
	const all = applySportSettings(merged, { enabled: true, sports: KNOWN_SPORTS, football: 'all' });
	assert.ok(all.length > uk.length, 'football all shows more than uk');
	assert.deepEqual(applySportSettings(merged, { enabled: false, sports: KNOWN_SPORTS, football: 'all' }), []);
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
	const loader = createLiveSportOntv({ fetcher, clock: () => current, channels, cachePath, version: '0.26.68' });
	return { loader, calls, advance: ms => { current += ms; }, now: () => current };
}

test('first load fetches once with an identifying UA and no redirects', async () => {
	const h = harness([response(FIXTURE, { etag: '"6713-1795304840;;;"' })]);
	const rail = await h.loader.listings();
	assert.ok(rail.length > 0);
	assert.equal(h.calls.length, 1);
	assert.equal(h.calls[0].url, LIVESPORT_SOURCE_URL);
	const opts = h.calls[0].opts;
	assert.match(opts.headers['User-Agent'], /^Tellybox\/0\.26\.68 \(\+https:\/\/github\.com\/jharrisuk\/tellybox-homelab\)$/);
	assert.equal(opts.redirect, 'error');
	assert.ok(opts.signal, 'a timeout signal is set');
	assert.equal(opts.headers['Accept-Encoding'], 'identity');
	assert.equal(opts.headers['If-None-Match'], undefined, 'no conditional header on the first request');
	assert.equal(h.loader.unavailable(), false);
});

test('at most one request per six hours', async () => {
	const h = harness([response(FIXTURE, { etag: '"v1"' }), response(null, { status: 304 })]);
	await h.loader.listings();
	for (let i = 0; i < 5; i++) { h.advance(3600000); await h.loader.listings(); }
	assert.equal(h.calls.length, 1, 'no refetch inside the six-hour window');
	h.advance(2 * 3600000);
	await h.loader.listings();
	await h.loader.refresh();
	assert.equal(h.calls.length, 2, 'one refetch once six hours have passed');
});

test('the second request is conditional and a 304 keeps the listings', async () => {
	const h = harness([response(FIXTURE, { etag: '"v1"', lastModified: 'Sat, 21 Nov 2026 08:58:07 GMT' }), response(null, { status: 304 })]);
	await h.loader.listings();
	h.advance(7 * 3600000);
	await h.loader.listings();
	await h.loader.refresh();
	assert.equal(h.calls.length, 2);
	assert.equal(h.calls[1].opts.headers['If-None-Match'], '"v1"');
	assert.equal(h.calls[1].opts.headers['If-Modified-Since'], 'Sat, 21 Nov 2026 08:58:07 GMT');
	assert.deepEqual(await h.loader.listings(), allSportWindow(parseEvents(FIXTURE), [], h.now()), 'a 304 leaves the kept listings intact');
	assert.equal(h.loader.unavailable(), false);
});

test('a 503 keeps the previous listings and backs off without retrying', async () => {
	const h = harness([response(FIXTURE, { etag: '"v1"' }), response(null, { status: 503 }), response(FIXTURE)]);
	await h.loader.listings();
	h.advance(7 * 3600000);
	await h.loader.listings();
	await h.loader.refresh();
	assert.equal(h.calls.length, 2);
	assert.deepEqual(await h.loader.listings(), allSportWindow(parseEvents(FIXTURE), [], h.now()), 'previous listings are kept on 503');
	assert.equal(h.loader.unavailable(), false);
	await h.loader.refresh();
	assert.equal(h.calls.length, 2, 'no immediate retry after a 503');
});

test('a 429 honours Retry-After and waits at least an hour', async () => {
	const h = harness([response(FIXTURE), response(null, { status: 429, retryAfter: 7200 })]);
	await h.loader.listings();
	h.advance(7 * 3600000);
	await h.loader.listings();
	await h.loader.refresh();
	assert.equal(h.calls.length, 2);
	h.advance(3600000);
	await h.loader.refresh();
	assert.equal(h.calls.length, 2, 'back-off blocks an early retry');
	assert.equal(h.loader.unavailable(), false);
});

test('a first-load failure yields an empty rail flagged unavailable', async () => {
	const h = harness([response(null, { status: 500 })]);
	assert.deepEqual(await h.loader.listings(), []);
	assert.equal(h.loader.unavailable(), true);
});

test('a network error keeps the previous listings', async () => {
	const h = harness([response(FIXTURE), () => { throw new Error('offline'); }]);
	await h.loader.listings();
	h.advance(7 * 3600000);
	await h.loader.listings();
	await h.loader.refresh();
	assert.deepEqual(await h.loader.listings(), allSportWindow(parseEvents(FIXTURE), [], h.now()));
	assert.equal(h.loader.unavailable(), false);
});

test('an unrecognised layout never wipes good listings', async () => {
	const h = harness([response(FIXTURE), response('<html><body>a redesign with no events</body></html>')]);
	await h.loader.listings();
	h.advance(7 * 3600000);
	await h.loader.listings();
	await h.loader.refresh();
	assert.deepEqual(await h.loader.listings(), allSportWindow(parseEvents(FIXTURE), [], h.now()));
	assert.equal(h.loader.unavailable(), false);
});

test('an over-cap response is rejected without crashing', async () => {
	const big = '<article class="lsotv-event">' + 'x'.repeat(3 * 1024 * 1024) + '</article>';
	const h = harness([response(FIXTURE), response(big)]);
	await h.loader.listings();
	h.advance(7 * 3600000);
	await h.loader.listings();
	await h.loader.refresh();
	assert.deepEqual(await h.loader.listings(), allSportWindow(parseEvents(FIXTURE), [], h.now()), 'the 2 MB cap keeps the previous listings');
});

test('a restart inside six hours does not refetch', async () => {
	const dir = mkdtempSync(path.join(tmpdir(), 'q79-livesport-'));
	const cachePath = path.join(dir, 'livesportontv.json');
	try {
		const first = harness([response(FIXTURE, { etag: '"v1"' })], { cachePath });
		const rail = await first.loader.listings();
		assert.equal(first.calls.length, 1);
		let refetched = 0;
		const restarted = createLiveSportOntv({
			fetcher: async () => { refetched++; return response(FIXTURE); },
			clock: () => NOW, cachePath, version: '0.26.68'
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
	assert.ok(rail.flatMap(i => i.channels).some(c => c.channelId), 'some channels match the lineup');
	assert.ok(rail.flatMap(i => i.channels).some(c => !c.channelId), 'unmatched channels stay name-only');
	const broken = harness([response(FIXTURE)], { channels: async () => { throw new Error('Dispatcharr not connected'); } });
	const stillWorks = await broken.loader.listings();
	assert.ok(stillWorks.length > 0, 'a lineup failure never breaks the rail');
	assert.ok(stillWorks.every(i => i.channels.every(c => !c.channelId)), 'all channels fall back to name-only');
});
