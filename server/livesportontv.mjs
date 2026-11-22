// All-sports rail for Coming Soon (Q79).
//
// Source: livesportontv.co.uk. The audit (outputs/q79-sports-sources/REPORT.md)
// found it the only viable single-source spine: one GET of the homepage returns
// the whole 7-day guide (7 day-panels, ~643 events, 20 sports including Boxing
// and MMA/UFC) in the initial HTML, robots only disallows /wp-admin/, an ETag is
// present for conditional GET, and the terms object only to "unreasonable load"
// (no automation ban). Each event's channels are a JSON array in a
// `data-channels` attribute.
//
// Politeness rules are identical to sport-listings.mjs (the football source):
//   * one page, fetched at most every 6 hours;
//   * a conditional GET (If-None-Match / If-Modified-Since) so the reply is
//     usually an empty 304 Not Modified;
//   * an identifying User-Agent that links back to this project;
//   * a 10s timeout, a 2 MB response cap and no redirects;
//   * on 429/503 (or any failure) it keeps the previous listings and backs off
//     for at least an hour rather than retrying.
//
// The last good parse is persisted as small JSON under the same data/cache
// directory the other server caches use, so a restart inside the 6h window does
// not refetch. Nothing here ever throws to the caller: a sport outage must never
// take the Coming Soon page down with it.
//
// This module is additive. The existing football rail (sport-listings.mjs) is
// left untouched; mergeSportRails() combines the two, deduping by kick-off +
// title, and applySportSettings() applies the Q80 admin settings.
import { readFile, writeFile, rename } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { londonInstant, decodeEntities, buildChannelIndex, matchChannels } from './sport-listings.mjs';

export const LIVESPORT_SOURCE_URL = 'https://livesportontv.co.uk/';
export const LIVESPORT_SOURCE_LABEL = 'livesportontv.co.uk';
const SIX_HOURS = 6 * 3600000;
const MIN_BACKOFF = 3600000; // wait at least an hour when refused
const FETCH_TIMEOUT_MS = 10000;
const RESPONSE_CAP = 2 * 1024 * 1024;
const DAY = 86400000;
// Persist a little beyond the 4-day rail so the window stays full between
// refreshes (and across a restart) without keeping the whole 7-day page forever.
const PERSIST_HORIZON_DAYS = 8;
const PERSIST_MAX_EVENTS = 2000;
// Bounds on parser work so a hostile or broken page can never spin the server.
const PARSE_MAX_EVENTS = 5000;
const PARSE_MAX_CHUNK = 8000;
const MAX_CHANNELS = 16;

const clean = value => decodeEntities(value).replace(/\s+/g, ' ').trim();

// --- sport slugs --------------------------------------------------------
// The source's `data-sport` attribute is a clean enum (the 20 values the audit
// found). Map each to a stable, lower-case slug used in the API and in the Q80
// settings allow-list. Rugby Union maps to 'rugby' to match the rail's naming.
const SPORT_SLUGS = {
	'American Football': 'american-football',
	'Australian Rules Football': 'australian-rules',
	'Basketball': 'basketball',
	'Boxing': 'boxing',
	'Cricket': 'cricket',
	'Cycling': 'cycling',
	'Darts': 'darts',
	'Football': 'football',
	'Formula 1': 'formula-1',
	'Golf': 'golf',
	'Horse Racing': 'horse-racing',
	'Ice Hockey': 'ice-hockey',
	'MMA': 'mma',
	'MotoGP': 'motogp',
	'Motorsport': 'motorsport',
	'Pool': 'pool',
	'Rugby Union': 'rugby',
	'Snooker': 'snooker',
	'Tennis': 'tennis',
	'Winter Sports': 'winter-sports'
};
// The known list the Q80 settings validate against. It mirrors the sports the
// source actually carries (per the audit); a future sport the source adds is
// still parsed (slugify fallback) but would need adding here to be selectable.
export const KNOWN_SPORTS = Object.values(SPORT_SLUGS).sort();
export function sportSlug(name) {
	const key = clean(name);
	if (SPORT_SLUGS[key]) return SPORT_SLUGS[key];
	// Deterministic fallback for an unknown sport: lower-case, punctuation to
	// single hyphens. Never throws and never returns an empty slug for a name.
	const slug = key.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
	return slug || 'other';
}

// --- parser -------------------------------------------------------------
// The page groups events into day-panels:
//   <div class="lsotv-panel" data-date="YYYY-MM-DD"> ... <article ...> ... </div>
// Each event is:
//   <article class="lsotv-event" data-sport="Boxing"
//            data-channels="[&quot;DAZN&quot;]">
//     <div class="lsotv-time">01:00</div>
//     <div class="lsotv-detail">
//       <div class="lsotv-sport">Boxing <img ...></div>
//       <h4>Live Boxing</h4>
//       <p>IBF Title Fights</p>
//       <p class="lsotv-notes">Amari Jones vs DeAundre Pettus</p>
//     </div>
//     <div class="lsotv-channels"> ...logo spans... </div>
//   </article>
// The parser walks panel openings and event openings in document order, attaches
// each event to the most recent panel date, and skips anything it cannot parse
// rather than throwing. It never guesses a layout it has not seen.
function parsePanelDate(value) {
	const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || '').trim());
	if (!m) return null;
	const year = +m[1], month = +m[2], day = +m[3];
	if (month < 1 || month > 12 || day < 1 || day > 31) return null;
	return { year, month, day };
}

export function parseEvents(html) {
	const source = String(html ?? '');
	const events = [];
	// Ordered marks: panel openings (with their ISO date) and event openings.
	const markRe = /<div class="lsotv-panel" data-date="([^"]+)"|<article class="lsotv-event"/g;
	const marks = [];
	for (const m of source.matchAll(markRe)) {
		marks.push({ index: m.index, isPanel: m[0].includes('lsotv-panel'), date: m[1] });
		if (marks.length > PARSE_MAX_EVENTS * 2) break;
	}
	let current = null;
	let count = 0;
	for (let i = 0; i < marks.length && count < PARSE_MAX_EVENTS; i++) {
		const mark = marks[i];
		if (mark.isPanel) { current = parsePanelDate(mark.date); continue; }
		if (!current) continue; // an event before any usable panel date is skipped
		const end = Math.min(i + 1 < marks.length ? marks[i + 1].index : source.length, mark.index + PARSE_MAX_CHUNK);
		const chunk = source.slice(mark.index, end);
		const event = parseEventRow(chunk, current);
		if (event) { events.push(event); count++; }
	}
	return events;
}

function parseEventRow(chunk, date) {
	const sportAttr = /data-sport="([^"]*)"/.exec(chunk);
	const sportName = sportAttr ? clean(sportAttr[1]) : '';
	if (!sportName) return null;
	const time = /<div class="lsotv-time">([\s\S]*?)<\/div>/.exec(chunk);
	const clock = time ? /^(\d{1,2}):(\d{2})$/.exec(clean(time[1])) : null;
	if (!clock) return null; // "TBC" kick-offs cannot be placed in time
	const titleMatch = /<h4>([\s\S]*?)<\/h4>/.exec(chunk);
	const title = titleMatch ? clean(titleMatch[1]) : '';
	if (!title) return null;
	const kickoff = londonInstant(date.year, date.month, date.day, +clock[1], +clock[2]);
	if (!Number.isFinite(kickoff)) return null;
	// Competition is the first plain <p>; the session/venue/fighters note is a
	// separate <p class="lsotv-notes">. Combat sports use generic titles ("Live
	// Boxing") with the actual fighters in the note, so the note is kept too.
	let competition = '', notes = '';
	for (const p of chunk.matchAll(/<p(?: class="([^"]*)")?>([\s\S]*?)<\/p>/g)) {
		const text = clean(p[2]);
		if ((p[1] || '').split(/\s+/).includes('lsotv-notes')) { if (!notes) notes = text; }
		else if (!competition) competition = text;
	}
	const channels = parseChannels(chunk);
	return { kickoff, sport: sportSlug(sportName), title, competition, notes, channels };
}

function parseChannels(chunk) {
	const attr = /data-channels="([^"]*)"/.exec(chunk);
	if (!attr) return [];
	let names;
	try { names = JSON.parse(decodeEntities(attr[1])); } catch { return []; }
	if (!Array.isArray(names)) return [];
	const channels = [];
	for (const name of names) {
		const value = clean(name);
		if (value) channels.push(value);
		if (channels.length >= MAX_CHANNELS) break;
	}
	return channels;
}

// --- window -------------------------------------------------------------
// Same local-day convention as the football rail (sport-listings.mjs) and the
// Coming Soon calendar: a day key is the runtime-local YYYY-MM-DD. The rail
// covers today through today+3 (four day labels including today) and excludes
// past kick-offs. Kept identical so the two sources line up day-for-day.
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
function eventId(event) {
	return 'sport-' + createHash('sha1').update(`${event.kickoff}|${event.sport}|${event.title}`).digest('hex').slice(0, 12);
}

// Window + match raw events into the API rail shape. Pure and synchronous so the
// window boundaries can be tested without any network or clock. Channel matching
// reuses the football rail's normalisation and the live lineup; every channel
// name is returned (own-channel-only filtering is a client concern).
export function allSportWindow(events, lineup, now = Date.now()) {
	const index = buildChannelIndex(lineup);
	const keys = windowKeys(now);
	const items = [];
	for (const event of Array.isArray(events) ? events : []) {
		if (!event || !Number.isFinite(event.kickoff)) continue;
		if (event.kickoff < now) continue; // exclude past kick-offs
		if (!keys.has(localDayKey(event.kickoff))) continue;
		items.push({
			type: 'sport',
			sport: event.sport,
			id: eventId(event),
			title: event.title,
			competition: event.competition || '',
			date: new Date(event.kickoff).toISOString(),
			dateLabel: dayLabel(event.kickoff, now),
			channels: matchChannels(event.channels, index),
			notes: event.notes || '',
			source: LIVESPORT_SOURCE_LABEL
		});
	}
	items.sort((a, b) => Date.parse(a.date) - Date.parse(b.date) || a.title.localeCompare(b.title));
	return items;
}

// --- merge with the football rail ---------------------------------------
// Dedupe by kick-off (to the minute) + normalised title + sport. The existing
// football rail wins a tie so established football items keep their ids and
// channel matching; livesportontv adds every other sport plus any football the
// football source does not carry. Title normalisation unifies case, punctuation
// and the "v"/"vs" separator so the two sources' wording of the same fixture merges.
function normalisedTitle(title) {
	return String(title || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim().replace(/\bvs\b/g, 'v');
}
export function dedupeKey(item) {
	const minute = Math.floor(Date.parse(item.date) / 60000);
	return `${minute}|${item.sport || 'football'}|${normalisedTitle(item.title)}`;
}
export function mergeSportRails(footballItems, allSportItems) {
	const byKey = new Map();
	for (const item of Array.isArray(footballItems) ? footballItems : []) {
		if (!item) continue;
		const tagged = { ...item, sport: item.sport || 'football', source: item.source || 'live-footballontv.com' };
		const key = dedupeKey(tagged);
		if (!byKey.has(key)) byKey.set(key, tagged);
	}
	for (const item of Array.isArray(allSportItems) ? allSportItems : []) {
		if (!item) continue;
		const key = dedupeKey(item);
		if (!byKey.has(key)) byKey.set(key, item);
	}
	return [...byKey.values()].sort((a, b) => Date.parse(a.date) - Date.parse(b.date) || a.title.localeCompare(b.title));
}

// --- UK football competition filter (Q80) --------------------------------
// Mirrors public/coming-soon.js UK_COMPETITIONS so the server-side football:'uk'
// setting and the client's "UK football only" toggle agree. Normalised: lower
// case, apostrophes dropped, punctuation collapsed to spaces; exact match only,
// with a tiny alias table for sponsored/alternative names.
const UK_COMPETITIONS = new Set([
	'premier league', 'championship', 'league one', 'league two', 'fa cup', 'efl cup', 'carabao cup',
	'scottish premiership', 'scottish championship', 'scottish cup', 'scottish league cup',
	'womens super league', 'community shield', 'national league'
]);
const UK_COMPETITION_ALIASES = new Map([
	['english premier league', 'premier league'],
	['efl championship', 'championship'],
	['efl league one', 'league one'],
	['efl league two', 'league two'],
	['the fa cup', 'fa cup'],
	['emirates fa cup', 'fa cup'],
	['barclays womens super league', 'womens super league'],
	['vanarama national league', 'national league']
]);
export function competitionKey(name) {
	return String(name || '').toLowerCase().replace(/['\u2019]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}
export function isUkCompetition(name) {
	const key = competitionKey(name);
	return UK_COMPETITIONS.has(UK_COMPETITION_ALIASES.get(key) ?? key);
}

// Apply the Q80 admin settings to a merged rail. Pure so the filtering can be
// tested without a server. disabled -> empty rail; sports allow-list filters by
// slug; football:'uk' keeps only curated UK competitions for football items
// (other sports are never touched by the football setting).
export function applySportSettings(items, settings) {
	if (!settings || settings.enabled === false) return [];
	const allow = new Set(Array.isArray(settings.sports) ? settings.sports : []);
	let out = (Array.isArray(items) ? items : []).filter(item => item && allow.has(item.sport));
	if (settings.football === 'uk') out = out.filter(item => item.sport !== 'football' || isUkCompetition(item.competition));
	return out;
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
function trimHorizon(events, now) {
	const lo = now - DAY, hi = now + PERSIST_HORIZON_DAYS * DAY;
	return events.filter(e => e.kickoff >= lo && e.kickoff <= hi).slice(0, PERSIST_MAX_EVENTS);
}
function validState(value) {
	return value && typeof value === 'object' && Number.isFinite(value.fetchedAt) && Array.isArray(value.events);
}

export function createLiveSportOntv({ fetcher = fetch, clock = Date.now, cachePath = '', channels = null, url = LIVESPORT_SOURCE_URL, version = '0.0.0' } = {}) {
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
		return { loaded: false, fetchedAt: 0, attemptedAt: now, backoffUntil: 0, etag: null, lastModified: null, events: [] };
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
			const events = parseEvents(html);
			if (!events.length) {
				// An unrecognised layout must never wipe good listings.
				backoffUntil = now + MIN_BACKOFF; state.backoffUntil = backoffUntil;
				await persist();
				return;
			}
			state = {
				loaded: true, fetchedAt: now, attemptedAt: now, backoffUntil: 0,
				etag: response.headers?.get?.('etag') ?? null,
				lastModified: response.headers?.get?.('last-modified') ?? null,
				events: trimHorizon(events, now)
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

	// Returns the next-3-days all-sports rail. Never throws. The first ever load
	// is awaited so the rail can populate; later refreshes run in the background
	// so a slow or failing source never blocks or breaks the Coming Soon page.
	async function listings() {
		await restored;
		const now = clock();
		if (!state || !state.loaded) await ensureFresh(now);
		else if (due(now)) void ensureFresh(now);
		let lineup = [];
		if (channels) { try { lineup = await channels(); } catch { lineup = []; } }
		return allSportWindow(state ? state.events : [], lineup, now);
	}
	// True only before the first successful load. A later failure keeps the
	// previous listings and does not flip this back to true.
	const unavailable = () => !(state && state.loaded);
	async function refresh() { await restored; await ensureFresh(clock()); }
	return { listings, unavailable, refresh };
}
