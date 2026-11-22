const $ = selector => document.querySelector(selector);
// UK football preference: default ON, remembered per browser. The list of
// recognised UK competitions lives in UK_COMPETITIONS below; anything not on
// the list is hidden while the toggle is on.
const UK_PREF_KEY = 'tellybox.coming.ukOnly';
function readUkOnly() {
	try { const stored = localStorage.getItem(UK_PREF_KEY); return stored === null ? true : stored !== '0'; }
	catch { return true; }
}
const state = { tv: [], movies: [], sport: [], unavailable: [], sportUnavailable: false, type: 'tv', expanded: false, sportExpanded: false, featured: 0, loaded: false, ukOnly: readUkOnly() };
const compact = matchMedia('(max-width: 850px)');
// Mirror of the server's recent window (insights.mjs RECENT_RELEASE_DAYS).
const RECENT_CALENDAR_DAYS = 7;

function element(tag, className = '', text = '') {
	const node = document.createElement(tag);
	if (className) node.className = className;
	if (text) node.textContent = text;
	return node;
}
async function api(url) {
	const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store' });
	if (response.status === 401) { location.replace('/login'); throw new Error('Please sign in again.'); }
	if (!response.ok) {
		const data = await response.json().catch(() => ({}));
		throw new Error(data.error || 'Coming soon is unavailable just now.');
	}
	return response.json();
}
function pool() {
	return state.type === 'tv' ? state.tv : state.movies;
}
// Items that are already in the library open there. Everything else keeps the
// existing details panel.
function libraryTarget(item) {
	const id = item?.library?.id;
	return id ? '/?item=' + encodeURIComponent(id) : null;
}
function isLibraryItem(item) { return Boolean(libraryTarget(item)); }
function activate(item) {
	const target = libraryTarget(item);
	if (target) { location.assign(target); return; }
	openDetails(item);
}
function urlFor(item = null, type = state.type) {
	const url = new URL(location.href);
	url.searchParams.set('type', type);
	if (item) url.searchParams.set('title', item.id); else url.searchParams.delete('title');
	return url;
}
function setType(type, replace = true) {
	if (!['tv', 'movie'].includes(type)) return;
	state.type = type; state.expanded = false; state.featured = 0;
	for (const tab of document.querySelectorAll('[data-coming]')) {
		const selected = tab.dataset.coming === type;
		tab.classList.toggle('active', selected);
		tab.setAttribute('aria-pressed', String(selected));
	}
	if (replace) history.replaceState(history.state, '', urlFor());
	render();
}

// --- sport ---------------------------------------------------------------
// Only channels the installation actually carries (matched channelId) are
// shown. A fixture with no owned channel says so plainly instead of naming
// broadcasters we cannot play.
function ownedChannels(item) {
	return (item.channels || []).filter(channel => channel && channel.channelId);
}
// UK competitions, normalised (lower case, apostrophes dropped, punctuation
// collapsed to spaces). Exact match only: an unknown competition is excluded
// while "UK football only" is on. Aliases cover the sponsored/alternative
// names the source uses for the same competition.
const UK_COMPETITIONS = new Set([
	'premier league',
	'championship',
	'league one',
	'league two',
	'fa cup',
	'efl cup',
	'carabao cup',
	'scottish premiership',
	'scottish championship',
	'scottish cup',
	'scottish league cup',
	'womens super league',
	'community shield',
	'national league'
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
function competitionKey(name) {
	return String(name || '').toLowerCase().replace(/['\u2019]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}
function isUkCompetition(name) {
	const key = competitionKey(name);
	return UK_COMPETITIONS.has(UK_COMPETITION_ALIASES.get(key) ?? key);
}
function visibleSport() {
	return state.ukOnly ? state.sport.filter(item => isUkCompetition(item.competition)) : state.sport;
}
function sportTime(item) {
	const date = new Date(item.date);
	return Number.isFinite(date.getTime()) ? date.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : '';
}
function sportCard(item) {
	const button = element('button', 'sport-fixture');
	button.type = 'button';
	const when = element('span', 'sport-when');
	when.append(element('strong', '', sportTime(item)), element('span', '', item.dateLabel));
	button.append(when, element('strong', 'sport-title', item.title));
	if (item.competition) button.append(element('span', 'sport-comp', item.competition));
	const owned = ownedChannels(item);
	if (owned.length) {
		const line = element('span', 'coming-channels');
		for (const channel of owned) line.append(element('span', 'coming-channel', channel.name));
		button.append(line);
	} else {
		button.append(element('span', 'sport-unowned', 'Not on your channels'));
	}
	button.onclick = () => activate(item);
	return button;
}
function renderSport() {
	const toggle = $('#ukOnlyToggle');
	toggle.setAttribute('aria-pressed', String(state.ukOnly));
	toggle.classList.toggle('active', state.ukOnly);
	const items = visibleSport(), preview = compact.matches ? 4 : 6;
	$('#sportList').replaceChildren(...items.slice(0, state.sportExpanded ? items.length : preview).map(sportCard));
	$('#sportCount').textContent = items.length ? `${items.length} match${items.length === 1 ? '' : 'es'} · next 3 days` : '';
	const unavailable = state.sportUnavailable || state.unavailable.includes('sport');
	$('#sportStatus').textContent = unavailable ? 'Football listings are temporarily unavailable. Please check back shortly.'
		: items.length ? ''
		: state.sport.length ? 'No UK football in the next three days. Turn off “UK football only” to see every televised match.'
		: 'No televised football in the next three days.';
	$('#sportStatus').hidden = !$('#sportStatus').textContent;
	$('#sportMore').hidden = items.length <= preview;
	$('#sportMore').setAttribute('aria-expanded', String(state.sportExpanded));
	$('#sportMore').textContent = state.sportExpanded ? 'Show fewer' : `Show all ${items.length} matches`;
}
function focusSport() {
	const panel = $('#comingSport');
	if (typeof panel.scrollIntoView === 'function') panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
	panel.focus();
}
// Local-day keys, the same convention coming-calendar.js uses for episodes.
function sportDayCounts(items) {
	const counts = new Map();
	for (const item of items) {
		const date = new Date(item.date);
		if (!Number.isFinite(date.getTime())) continue;
		const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
		counts.set(key, (counts.get(key) || 0) + 1);
	}
	return counts;
}

// --- calendar ------------------------------------------------------------
function calendarDay(day, sportCount) {
	const quiet = day.past && !day.items.length;
	const section = element('section', 'calendar-day' + (day.past ? ' recent' : '') + (quiet ? ' quiet' : ''));
	section.setAttribute('aria-label', day.date.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' }));
	const date = element('div', 'calendar-date');
	date.append(element('strong', '', day.today ? 'Today' : day.date.toLocaleDateString(undefined, { weekday: 'short' })), element('span', '', day.date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })));
	section.append(date);
	// A past day with nothing on it keeps its column but stays out of the way.
	if (quiet) return section;
	const items = element('div', 'calendar-day-items');
	for (const item of day.items) {
		const button = element('button', 'calendar-item');
		button.type = 'button';
		if (isLibraryItem(item)) button.setAttribute('aria-label', `${item.title} - open in library`);
		button.append(element('strong', '', item.title), element('span', '', item.type === 'tv' ? item.episode : item.dateLabel));
		button.onclick = () => activate(item);
		items.append(button);
	}
	// A small marker, not a second fixture list: icon + count, jumping to the
	// sport panel. It follows the UK toggle so the count always matches it.
	if (sportCount) {
		const marker = element('button', 'calendar-sport');
		marker.type = 'button';
		marker.setAttribute('aria-label', `${sportCount} football match${sportCount === 1 ? '' : 'es'} — view football`);
		const glyph = element('span', 'calendar-sport-glyph', '⚽');
		glyph.setAttribute('aria-hidden', 'true');
		marker.append(glyph, element('span', '', String(sportCount)));
		marker.onclick = () => focusSport();
		items.append(marker);
	} else if (!day.items.length) {
		items.append(element('span', 'calendar-empty', 'Nothing scheduled'));
	}
	section.append(items);
	return section;
}

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function calendarGrid(days, sportCounts) {
	const grid = element('div', 'calendar-days');
	const cells = WEEKDAYS.map(name => {
		const heading = element('div', 'calendar-weekday', name);
		heading.setAttribute('aria-hidden', 'true');
		return heading;
	});
	for (const row of jserverCalendar.weeks(days)) {
		for (const day of row) {
			if (day) { cells.push(calendarDay(day, sportCounts.get(day.key) || 0)); continue; }
			const gap = element('div', 'calendar-day empty');
			gap.setAttribute('aria-hidden', 'true');
			cells.push(gap);
		}
	}
	grid.replaceChildren(...cells);
	return grid;
}

function renderCalendar() {
	const days = jserverCalendar.days(state, new Date(), { past: RECENT_CALENDAR_DAYS });
	$('#calendarDays').replaceChildren(calendarGrid(days, sportDayCounts(visibleSport())));
	$('#calendarSummary').textContent = state.unavailable.length ? 'Some listings are temporarily unavailable.' : 'Scheduled releases · arrival may vary';
}

function renderHero() {
	const hero = $('#comingHero');
	const items = pool();
	if (!items.length) { hero.hidden = true; return; }
	state.featured = ((state.featured % items.length) + items.length) % items.length;
	const item = items[state.featured];
	hero.hidden = false;
	const image = $('#comingHeroImage');
	image.hidden = !item.poster;
	if (item.poster) image.src = item.poster;
	image.onerror = () => { image.hidden = true; };
	$('#comingHeroEyebrow').textContent = item.released ? 'RECENTLY RELEASED' : item.type === 'tv' ? 'NEXT EPISODE' : 'A FILM TO LOOK FORWARD TO';
	$('#comingHeroTitle').textContent = item.title;
	$('#comingHeroDescription').textContent = item.overview || 'Already on our list. Keep an eye out for it here.';
	const meta = $('#comingHeroMeta'); meta.replaceChildren(element('strong', 'coming-date', `${item.dateLabel} · ${jserverUI.comingDate(item)}`));
	if (item.episode) meta.append(element('span', 'coming-episode', `${item.episode} · ${item.episodeTitle}`));
	if (item.ratings?.length) meta.append(jserverUI.ratings(item.ratings, { compact: true }));
	$('#comingHeroAction').textContent = isLibraryItem(item) ? 'Open in library' : 'View details';
	$('#comingHeroAction').onclick = () => activate(item);
	$('#comingHeroNext').hidden = items.length < 2;
	$('#comingHeroNext').onclick = () => { state.featured = (state.featured + 1) % items.length; renderHero(); };
}

function renderGrid() {
	const items = pool(), preview = compact.matches ? 4 : 8;
	$('#comingGrid').replaceChildren(...items.slice(0, state.expanded ? items.length : preview).map(item => {
		const button = element('button', 'coming-card' + (isLibraryItem(item) ? ' in-library' : ''));
		button.type = 'button';
		if (isLibraryItem(item)) button.setAttribute('aria-label', `${item.title} - open in library`);
		if (item.poster) { const image = element('img'); image.src = item.poster; image.alt = ''; image.loading = 'lazy'; image.onerror = () => image.remove(); button.append(image); }
		const text = element('div', 'coming-card-text');
		text.append(element('strong', '', item.title), element('span', 'coming-date', `${item.dateLabel} · ${jserverUI.comingDate(item)}`));
		if (item.episode) text.append(element('small', '', `${item.episode} · ${item.episodeTitle}`));
		if (item.type === 'movie') text.append(jserverUI.ratings(item.ratings, { compact: true }));
		button.append(text);
		button.onclick = () => activate(item);
		return button;
	}));
	const unavailable = state.unavailable.includes(state.type === 'tv' ? 'tv' : 'films');
	$('#comingStatus').textContent = unavailable ? 'This schedule is temporarily unavailable. Please check back shortly.'
		: !items.length ? 'Nothing dated yet. As soon as a release is announced, it’ll appear here.'
		: '';
	$('#comingStatus').hidden = !$('#comingStatus').textContent;
	$('#comingMore').hidden = items.length <= preview;
	$('#comingMore').setAttribute('aria-expanded', String(state.expanded));
	$('#comingMore').textContent = state.expanded ? 'Show fewer'
		: `Show all ${items.length} upcoming ${state.type === 'tv' ? 'episodes' : 'films'}`;
}

function render() {
	renderSport();
	renderCalendar();
	renderHero();
	renderGrid();
}

function detailsMarkup(item) {
	const body = element('div', 'detail-content coming-details');
	const title = element('h2', '', item.title); title.id = 'comingDetailsTitle';
	if (item.type === 'sport') {
		body.append(element('p', 'eyebrow', 'FOOTBALL ON TV'), title,
			element('p', 'coming-date', `${item.dateLabel} · ${jserverUI.comingDate(item)}`),
			...(item.competition ? [element('p', 'overview', item.competition)] : []));
		const owned = ownedChannels(item);
		if (owned.length) {
			body.append(element('h3', '', 'Where to watch'));
			const list = element('div', 'upcoming-schedule');
			for (const channel of owned) {
				const row = element('div', 'upcoming-episode');
				row.append(element('strong', '', channel.name), element('span', 'coming-date', 'In your lineup'));
				list.append(row);
			}
			body.append(list);
		} else {
			body.append(element('p', 'overview', 'This match is not on a channel in your lineup.'));
		}
		body.append(element('p', 'coming-note', 'Fixtures from live-footballontv.com. Kick-off times use your device time zone.'));
		const guide = element('a', 'button secondary', 'Open the TV guide');
		guide.href = '/?view=livetv';
		body.append(guide);
		return body;
	}
	body.append(element('p', 'eyebrow', item.released ? 'RECENTLY RELEASED' : 'COMING SOON'), title,
		element('p', 'coming-date', `${item.dateLabel} · ${jserverUI.comingDate(item)}`),
		element('p', 'overview', item.overview || 'Already on our list.'));
	if (item.type === 'movie') body.append(jserverUI.ratings(item.ratings, { links: true }));
	if (item.episodes?.length) {
		body.append(element('h3', '', item.released ? 'Recent episodes' : 'Episodes'));
		const schedule = element('div', 'upcoming-schedule');
		for (const episode of item.episodes) {
			const row = element('div', 'upcoming-episode');
			row.append(element('strong', '', `Season ${episode.season} · Episode ${episode.number}`), element('span', '', episode.title),
				element('span', 'coming-date', new Date(episode.date).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })));
			schedule.append(row);
		}
		body.append(schedule);
	}
	body.append(element('p', 'coming-note', item.type === 'tv'
		? 'Broadcast times use your time zone. Episodes appear here after they have been added to the collection.'
		: 'This is a release date, not a promise of when it will be watchable here. Cinema releases can arrive at home later.'));
	if (item.id) {
		const library = libraryTarget(item);
		const link = element('a', 'button secondary', library ? 'Open in library' : item.type === 'tv' ? 'View show & available episodes' : 'View film & availability');
		link.href = library || `/discover?type=${encodeURIComponent(item.type)}&title=${encodeURIComponent(item.id)}`;
		body.append(link);
	}
	return body;
}

function openDetails(item, push = true) {
	if (!item) return;
	$('#comingDetailsBody').replaceChildren(detailsMarkup(item));
	if (push && !history.state?.comingDetail) history.pushState({ comingDetail: true }, '', urlFor(item, item.type === 'sport' ? 'sport' : state.type));
	const dialog = $('#comingDetails');
	if (!dialog.open) dialog.showModal();
}
function closeDetails(fromPop = false) {
	const dialog = $('#comingDetails');
	if (dialog.open) dialog.close();
	if (!fromPop && history.state?.comingDetail) history.back();
}

async function load() {
	try {
		Object.assign(state, await api('/api/coming-soon'), { loaded: true });
		const query = new URLSearchParams(location.search);
		const requestedType = query.get('type');
		if (['tv', 'movie'].includes(requestedType)) state.type = requestedType;
		else if (!state.tv.length && state.movies.length) state.type = 'movie';
		for (const tab of document.querySelectorAll('[data-coming]')) { const selected = tab.dataset.coming === state.type; tab.classList.toggle('active', selected); tab.setAttribute('aria-pressed', String(selected)); }
		render();
		const requested = query.get('title');
		if (requested) {
			const item = [...state.tv, ...state.movies, ...state.sport].find(entry => String(entry.id) === String(requested));
			if (item) openDetails(item, false);
		}
		// A sport deep link lands on the always-visible sport panel.
		if (requestedType === 'sport' && !$('#comingDetails').open) focusSport();
	} catch (error) {
		$('#comingStatus').hidden = false;
		$('#comingStatus').textContent = error.message;
		$('#calendarSummary').textContent = error.message;
	}
}

$('#comingFilters').onclick = event => {
	const button = event.target.closest('[data-coming]');
	if (button) setType(button.dataset.coming);
};
$('#comingMore').onclick = () => { state.expanded = !state.expanded; renderGrid(); };
$('#ukOnlyToggle').onclick = () => {
	state.ukOnly = !state.ukOnly;
	state.sportExpanded = false;
	try { localStorage.setItem(UK_PREF_KEY, state.ukOnly ? '1' : '0'); } catch { /* private mode etc. */ }
	renderSport();
	renderCalendar();
};
$('#sportMore').onclick = () => { state.sportExpanded = !state.sportExpanded; renderSport(); };
$('#closeComingDetails').onclick = () => closeDetails();
$('#comingDetails').addEventListener('cancel', event => { event.preventDefault(); closeDetails(); });
window.addEventListener('popstate', () => {
	const query = new URLSearchParams(location.search), type = query.get('type');
	if (['tv', 'movie'].includes(type) && type !== state.type) setType(type, false);
	const title = query.get('title'), item = title ? [...state.tv, ...state.movies, ...state.sport].find(entry => String(entry.id) === String(title)) : null;
	const dialog = $('#comingDetails');
	if (item) { if (!dialog.open) openDetails(item, false); }
	else if (dialog.open) dialog.close();
	if (type === 'sport' && !item) focusSport();
});
compact.addEventListener('change', () => { if (state.loaded) { renderSport(); renderGrid(); } });
void load();
