// UK televised-football rail for Coming Soon.
//
// Source: live-footballontv.com, which allows automated reading in its
// robots.txt. This matches the behaviour and politeness rules of the MIT
// uk-sport-on-tv Dispatcharr plugin without copying its code:
//   * one page, fetched at most every 6 hours;
//   * a conditional GET (If-None-Match / If-Modified-Since) so the reply is
//     usually an empty 304 Not Modified;
//   * an identifying User-Agent that links back to this project;
//   * a 10s timeout, a 2 MB response cap and no redirects;
//   * on 429/503 (or any failure) it keeps the previous listings and backs off
//     for at least an hour rather than retrying.
//
// The last good parse is persisted as small JSON under the same data/cache
// directory pattern the other server caches use, so a restart inside the 6h
// window does not refetch. Nothing here ever throws to the caller: a sport
// outage must never take the Coming Soon page down with it.
import { readFile, writeFile, rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';

export const SPORT_SOURCE_URL = 'https://www.live-footballontv.com/';
const SIX_HOURS = 6 * 3600000;
const MIN_BACKOFF = 3600000; // the reference waits at least an hour when refused
const FETCH_TIMEOUT_MS = 10000;
const RESPONSE_CAP = 2 * 1024 * 1024;
const DAY = 86400000;
// Persist a little beyond the 4-day rail so the window stays full between
// refreshes (and across a restart) without keeping the whole 90-day page.
const PERSIST_HORIZON_DAYS = 8;
const PERSIST_MAX_FIXTURES = 1500;
// Bounds on parser work so a hostile or broken page can never spin the server.
const PARSE_MAX_FIXTURES = 5000;
const PARSE_MAX_CHUNK = 6000;

const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

// --- small HTML helpers -------------------------------------------------
const NAMED_ENTITIES = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#x27': "'", '#39': "'" };
export function decodeEntities(value) {
	return String(value ?? '')
		.replace(/&#x([0-9a-f]+);/gi, (_, hex) => safeChar(parseInt(hex, 16)))
		.replace(/&#(\d+);/g, (_, dec) => safeChar(parseInt(dec, 10)))
		.replace(/&([a-z]+);/gi, (whole, name) => NAMED_ENTITIES[name.toLowerCase()] ?? whole);
}
function safeChar(code) {
	try { return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ''; } catch { return ''; }
}
const clean = value => decodeEntities(value).replace(/\s+/g, ' ').trim();

// --- kick-off instant ---------------------------------------------------
// The page lists UK wall-clock time. Convert it to a UTC instant using the
// Europe/London zone (GMT/BST) so the stored kick-off is correct year-round,
// independent of the host timezone. This mirrors the reference, which stores
// kick-offs as UTC milliseconds.
const londonFormatter = new Intl.DateTimeFormat('en-GB', {
	timeZone: 'Europe/London', hour12: false,
	year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit'
});
function londonOffsetMs(instant) {
	const parts = Object.fromEntries(londonFormatter.formatToParts(instant).map(p => [p.type, p.value]));
	const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour % 24, +parts.minute, +parts.second);
	return asUtc - instant;
}
export function londonInstant(year, month, day, hour, minute) {
	if (![year, month, day, hour, minute].every(Number.isFinite)) return NaN;
	if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return NaN;
	const wallAsUtc = Date.UTC(year, month - 1, day, hour, minute);
	let instant = wallAsUtc - londonOffsetMs(wallAsUtc);
	const corrected = wallAsUtc - londonOffsetMs(instant);
	if (corrected !== instant) instant = corrected;
	return instant;
}

// --- parser -------------------------------------------------------------
// The page groups matches by date. Each group opens with an anchor whose id is
// a machine-readable date (e.g. "2026Nov21") followed by a human date header
// ("Saturday 21st November 2026"), then a run of fixture rows:
//   <div class="fixture">
//     <div class="fixture__time">17:45</div>
//     <div class="fixture__teams">Dundee v Hearts</div>
//     <div class="fixture__competition">Scottish Premiership</div>
//     <div class="fixture__channel"><div class="span3 channels">
//        <span class="channel-pill" ...>Premier Sports 1</span> ... </div></div>
//   </div>
// The parser walks date headers and fixture rows in document order, attaches
// each row to the most recent date, and skips anything it cannot parse rather
// than throwing. It never guesses a layout it has not seen.
function parseDateHeader(anchorId, text) {
	// Prefer the machine-readable anchor id: YYYYMonDD.
	const a = /^(\d{4})([A-Za-z]{3})(\d{2})$/.exec(String(anchorId || '').trim());
	if (a && MONTHS[a[2].toLowerCase()]) return { year: +a[1], month: MONTHS[a[2].toLowerCase()], day: +a[3] };
	// Fall back to the human header: "Saturday 21st November 2026".
	const h = /(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+)\s+(\d{4})/.exec(clean(text));
	if (h) {
		const month = MONTHS[h[2].slice(0, 3).toLowerCase()];
		if (month) return { year: +h[3], month, day: +h[1] };
	}
	return null;
}

export function parseFixtures(html) {
	const source = String(html ?? '');
	const fixtures = [];
	// Ordered marks: date headers (with their optional preceding anchor) and
	// fixture-row openings. Walking them in order keeps each row with its date.
	const markRe = /(?:<a id="([^"]+)"><\/a><\/div>\s*)?<div class="fixture-date">([^<]*)<\/div>|<div class="fixture">/g;
	const marks = [];
	for (const m of source.matchAll(markRe)) {
		marks.push({ index: m.index, length: m[0].length, isDate: m[0].includes('fixture-date'), anchor: m[1], text: m[2] });
		if (marks.length > PARSE_MAX_FIXTURES * 2) break;
	}
	let current = null;
	let count = 0;
	for (let i = 0; i < marks.length && count < PARSE_MAX_FIXTURES; i++) {
		const mark = marks[i];
		if (mark.isDate) { current = parseDateHeader(mark.anchor, mark.text); continue; }
		if (!current) continue; // a row before any usable date is skipped
		const end = Math.min(i + 1 < marks.length ? marks[i + 1].index : source.length, mark.index + PARSE_MAX_CHUNK);
		const chunk = source.slice(mark.index, end);
		const fixture = parseFixtureRow(chunk, current);
		if (fixture) { fixtures.push(fixture); count++; }
	}
	return fixtures;
}

function parseFixtureRow(chunk, date) {
	const time = /<div class="fixture__time">([\s\S]*?)<\/div>/.exec(chunk);
	const teams = /<div class="fixture__teams">([\s\S]*?)<\/div>/.exec(chunk);
	if (!time || !teams) return null;
	const clock = /^(\d{1,2}):(\d{2})$/.exec(clean(time[1]));
	if (!clock) return null; // "TBC" kick-offs cannot be placed in time
	const sides = clean(teams[1]).split(/\s+v(?:s\.?)?\s+/i);
	if (sides.length !== 2) return null;
	const home = sides[0].trim(), away = sides[1].trim();
	if (!home || !away || /^(?:tbc|tba)$/i.test(home) || /^(?:tbc|tba)$/i.test(away)) return null;
	const kickoff = londonInstant(date.year, date.month, date.day, +clock[1], +clock[2]);
	if (!Number.isFinite(kickoff)) return null;
	const comp = /<div class="fixture__competition">([\s\S]*?)<\/div>/.exec(chunk);
	const competition = comp ? clean(comp[1]) : '';
	const channels = [];
	for (const pill of chunk.matchAll(/<span class="channel-pill"[^>]*>([\s\S]*?)<\/span>/g)) {
		const name = clean(pill[1]);
		// A bare "TBC" pill carries no channel identity; named placeholders such
		// as "Sky Sports TBC" are kept so the viewer still sees the broadcaster.
		if (name && !/^tbc$/i.test(name)) channels.push(name);
		if (channels.length >= 12) break;
	}
	return { kickoff, home, away, competition, channels };
}

// --- channel matching ---------------------------------------------------
// Normalise case, punctuation and whitespace, drop common quality/region
// suffixes, then apply a tiny explicit alias table. Matching is exact on the
// normalised name: numbered siblings are never fuzzy-matched, so "Premier
// Sports 1" can never match "Premier Sports 14" and "TNT Sports 1" can never
// match "TNT Sports 10".
const SUFFIX_TOKENS = new Set(['hd', 'fhd', 'uhd', 'uk']);
export function normalizeChannelName(name) {
	const tokens = clean(name).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(/\s+/).filter(Boolean);
	while (tokens.length && SUFFIX_TOKENS.has(tokens[tokens.length - 1])) tokens.pop();
	// Explicit synonym: the TNT brand is written both "TNT Sport" and "TNT
	// Sports". Canonicalise the singular to the plural for the TNT brand only.
	if (tokens[0] === 'tnt' && tokens[1] === 'sport') tokens[1] = 'sports';
	return tokens.join(' ');
}
// A small, explicit alias table on top of normalisation. Keys and values are
// already-normalised names. Kept deliberately tiny to avoid sibling matches.
const CHANNEL_ALIASES = new Map([
	['tnt sport', 'tnt sports'],
	['premier sports 1', 'premier sports 1']
]);
export function canonicalChannelName(name) {
	const normalized = normalizeChannelName(name);
	return CHANNEL_ALIASES.get(normalized) ?? normalized;
}

// Build an index from the installation's live lineup (the same channel list
// the live guide uses). When several channels normalise to one name, prefer a
// non-24/7 channel, then the lowest channel number, so the match is stable.
export function buildChannelIndex(lineup) {
	const index = new Map();
	for (const channel of Array.isArray(lineup) ? lineup : []) {
		if (!channel || typeof channel.name !== 'string' || !channel.id) continue;
		const key = canonicalChannelName(channel.name);
		if (!key) continue;
		const existing = index.get(key);
		if (!existing || betterChannel(channel, existing)) index.set(key, channel);
	}
	return index;
}
function betterChannel(a, b) {
	if (Boolean(a.nonstop) !== Boolean(b.nonstop)) return a.nonstop ? false : true;
	return (Number(a.number) || Infinity) < (Number(b.number) || Infinity);
}

export function matchChannels(names, index) {
	return (Array.isArray(names) ? names : []).map(name => {
		const hit = index.get(canonicalChannelName(name));
		return hit ? { name, channelId: hit.id } : { name };
	});
}

// --- window -------------------------------------------------------------
// Same local-day convention as the Coming Soon calendar (coming-calendar.js):
// a day key is the runtime-local YYYY-MM-DD. The rail covers today through
// today+3 (four day labels including today) and excludes past kick-offs.
const pad = n => String(n).padStart(2, '0');
const dayKey = date => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
const localDayKey = instant => dayKey(new Date(instant));
function windowKeys(now) {
	const base = new Date(now);
	const keys = new Set();
	for (let offset = 0; offset < 4; offset++) keys.add(dayKey(new Date(base.getFullYear(), base.getMonth(), base.getDate() + offset)));
	return keys;
}
function dayLabel(instant, now) {
	const key = localDayKey(instant);
	const base = new Date(now);
	if (key === dayKey(base)) return 'Today';
	if (key === dayKey(new Date(base.getFullYear(), base.getMonth(), base.getDate() + 1))) return 'Tomorrow';
	return new Date(instant).toLocaleDateString('en-GB', { weekday: 'long' });
}
function sportId(fixture) {
	return 'sport-' + createHash('sha1').update(`${fixture.kickoff}|${fixture.home}|${fixture.away}`).digest('hex').slice(0, 12);
}

// Window + match the raw fixtures into the API rail shape. Pure and synchronous
// so the window boundaries can be tested without any network or clock.
export function sportWindow(fixtures, lineup, now = Date.now()) {
	const index = buildChannelIndex(lineup);
	const keys = windowKeys(now);
	const items = [];
	for (const fixture of Array.isArray(fixtures) ? fixtures : []) {
		if (!fixture || !Number.isFinite(fixture.kickoff)) continue;
		if (fixture.kickoff < now) continue; // exclude past kick-offs
		if (!keys.has(localDayKey(fixture.kickoff))) continue;
		items.push({
			type: 'sport',
			id: sportId(fixture),
			title: `${fixture.home} v ${fixture.away}`,
			competition: fixture.competition || '',
			date: new Date(fixture.kickoff).toISOString(),
			dateLabel: dayLabel(fixture.kickoff, now),
			channels: matchChannels(fixture.channels, index)
		});
	}
	items.sort((a, b) => Date.parse(a.date) - Date.parse(b.date) || a.title.localeCompare(b.title));
	return items;
}

// --- cached, polite loader ---------------------------------------------
function userAgent(version) {
	return `Tellybox/${version || '0.0.0'} (+https://github.com/jharrisuk/tellybox-homelab)`;
}
function retryAfterMs(header, now) {
	if (!header) return null;
	const seconds = Number(header);
	if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
	const date = Date.parse(header);
	if (Number.isFinite(date)) return Math.max(0, date - now);
	return null;
}
async function readCapped(response, cap) {
	const body = response.body;
	if (body && typeof body[Symbol.asyncIterator] === 'function') {
		const decoder = new TextDecoder();
		let bytes = 0, out = '';
		for await (const chunk of body) {
			bytes += chunk?.byteLength ?? chunk?.length ?? 0;
			if (bytes > cap) { try { await body.cancel?.(); } catch {} throw new Error('Sport page is larger than supported.'); }
			out += decoder.decode(chunk, { stream: true });
		}
		return out + decoder.decode();
	}
	const text = await response.text();
	if (text.length > cap) throw new Error('Sport page is larger than supported.');
	return text;
}
function trimHorizon(fixtures, now) {
	const lo = now - DAY, hi = now + PERSIST_HORIZON_DAYS * DAY;
	return fixtures.filter(f => f.kickoff >= lo && f.kickoff <= hi).slice(0, PERSIST_MAX_FIXTURES);
}
function validState(value) {
	return value && typeof value === 'object' && Number.isFinite(value.fetchedAt) && Array.isArray(value.fixtures);
}

export function createSportListings({ fetcher = fetch, clock = Date.now, cachePath = '', channels = null, url = SPORT_SOURCE_URL, version = '0.0.0' } = {}) {
	let state = null;
	let lastAttempt = 0;
	let backoffUntil = 0;
	let pending = null;
	const ua = userAgent(version);
	const restored = cachePath
		? readFile(cachePath, 'utf8').then(text => {
			const value = JSON.parse(text);
			if (validState(value)) {
				state = value;
				lastAttempt = Number.isFinite(value.attemptedAt) ? value.attemptedAt : value.fetchedAt;
				backoffUntil = Number.isFinite(value.backoffUntil) ? value.backoffUntil : 0;
			}
		}).catch(() => {})
		: Promise.resolve();

	async function persist() {
		if (!cachePath || !state) return;
		try {
			await writeFile(cachePath + '.tmp', JSON.stringify(state), { mode: 0o600 });
			await rename(cachePath + '.tmp', cachePath);
		} catch { /* a cache write failure must never break the rail */ }
	}
	function emptyState(now) {
		return { loaded: false, fetchedAt: 0, attemptedAt: now, backoffUntil: 0, etag: null, lastModified: null, fixtures: [] };
	}
	const due = now => now - lastAttempt >= SIX_HOURS && now >= backoffUntil;

	async function runFetch(now) {
		try {
			if (!state) state = emptyState(now);
			state.attemptedAt = now;
			const headers = { 'User-Agent': ua, 'Accept': 'text/html', 'Accept-Encoding': 'identity' };
			if (state.etag) headers['If-None-Match'] = state.etag;
			if (state.lastModified) headers['If-Modified-Since'] = state.lastModified;
			const response = await fetcher(url, { headers, redirect: 'error', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
			if (response.status === 304) {
				try { await response.body?.cancel(); } catch {}
				state.fetchedAt = now; state.backoffUntil = 0; backoffUntil = 0;
				await persist();
				return;
			}
			if (response.status === 429 || response.status === 503) {
				try { await response.body?.cancel(); } catch {}
				const asked = retryAfterMs(response.headers?.get?.('retry-after'), now);
				backoffUntil = now + Math.max(asked ?? MIN_BACKOFF, MIN_BACKOFF);
				state.backoffUntil = backoffUntil;
				await persist();
				return; // keep the previous listings; no retry
			}
			if (!response.ok) {
				try { await response.body?.cancel(); } catch {}
				backoffUntil = now + MIN_BACKOFF; state.backoffUntil = backoffUntil;
				await persist();
				return;
			}
			const html = await readCapped(response, RESPONSE_CAP);
			const fixtures = parseFixtures(html);
			if (!fixtures.length) {
				// An unrecognised layout must never wipe good listings.
				backoffUntil = now + MIN_BACKOFF; state.backoffUntil = backoffUntil;
				await persist();
				return;
			}
			state = {
				loaded: true, fetchedAt: now, attemptedAt: now, backoffUntil: 0,
				etag: response.headers?.get?.('etag') ?? null,
				lastModified: response.headers?.get?.('last-modified') ?? null,
				fixtures: trimHorizon(fixtures, now)
			};
			backoffUntil = 0;
			await persist();
		} catch {
			// Timeout, redirect, network or parse failure: keep what we had.
			if (!state) state = emptyState(now);
			state.attemptedAt = now;
			backoffUntil = now + MIN_BACKOFF; state.backoffUntil = backoffUntil;
			await persist();
		} finally {
			pending = null;
		}
	}
	function ensureFresh(now) {
		if (pending) return pending;
		if (!due(now)) return Promise.resolve();
		lastAttempt = now;
		pending = runFetch(now);
		return pending;
	}

	// Returns the next-3-days rail. Never throws. The first ever load is awaited
	// so the rail can populate; later refreshes run in the background so a slow
	// or failing source never blocks or breaks the Coming Soon page.
	async function listings() {
		await restored;
		const now = clock();
		if (!state || !state.loaded) await ensureFresh(now);
		else if (due(now)) void ensureFresh(now);
		let lineup = [];
		if (channels) { try { lineup = await channels(); } catch { lineup = []; } }
		return sportWindow(state ? state.fixtures : [], lineup, now);
	}
	// True only before the first successful load. A later failure keeps the
	// previous listings and does not flip this back to true.
	const unavailable = () => !(state && state.loaded);
	async function refresh() { await restored; await ensureFresh(clock()); }
	return { listings, unavailable, refresh };
}
