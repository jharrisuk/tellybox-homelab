const $ = selector => document.querySelector(selector);
const state = { tv: [], movies: [], unavailable: [], type: 'tv', expanded: false, featured: 0, loaded: false };
const compact = matchMedia('(max-width: 850px)');

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
function pool() { return state.type === 'tv' ? state.tv : state.movies; }
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

function renderCalendar() {
	const days = jserverCalendar.days(state);
	$('#calendarDays').replaceChildren(...days.map((day, index) => {
		const section = element('section', 'calendar-day');
		section.setAttribute('aria-label', day.date.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' }));
		const date = element('div', 'calendar-date');
		date.append(element('strong', '', index === 0 ? 'Today' : day.date.toLocaleDateString(undefined, { weekday: 'short' })), element('span', '', day.date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })));
		const items = element('div', 'calendar-day-items');
		for (const item of day.items) {
			const button = element('button', 'calendar-item');
			button.type = 'button';
			button.append(element('strong', '', item.title), element('span', '', item.type === 'tv' ? item.episode : item.dateLabel));
			button.onclick = () => openDetails(item);
			items.append(button);
		}
		if (!day.items.length) items.append(element('span', 'calendar-empty', 'Nothing scheduled'));
		section.append(date, items);
		return section;
	}));
	$('#calendarSummary').textContent = state.unavailable.length ? 'Some listings are temporarily unavailable.' : 'Scheduled releases - arrival may vary';
}

function renderHero() {
	const items = pool(), hero = $('#comingHero');
	if (!items.length) { hero.hidden = true; return; }
	state.featured = ((state.featured % items.length) + items.length) % items.length;
	const item = items[state.featured];
	hero.hidden = false;
	const image = $('#comingHeroImage');
	image.hidden = !item.poster;
	if (item.poster) image.src = item.poster;
	image.onerror = () => { image.hidden = true; };
	$('#comingHeroEyebrow').textContent = item.type === 'tv' ? 'NEXT EPISODE' : 'A FILM TO LOOK FORWARD TO';
	$('#comingHeroTitle').textContent = item.title;
	$('#comingHeroDescription').textContent = item.overview || 'Already on our list. Keep an eye out for it here.';
	const meta = $('#comingHeroMeta'); meta.replaceChildren(element('strong', 'coming-date', `${item.dateLabel} - ${jserverUI.comingDate(item)}`));
	if (item.episode) meta.append(element('span', 'coming-episode', `${item.episode} - ${item.episodeTitle}`));
	if (item.ratings?.length) meta.append(jserverUI.ratings(item.ratings, { compact: true }));
	$('#comingHeroAction').onclick = () => openDetails(item);
	$('#comingHeroNext').hidden = items.length < 2;
	$('#comingHeroNext').onclick = () => { state.featured = (state.featured + 1) % items.length; renderHero(); };
}

function renderGrid() {
	const items = pool(), preview = compact.matches ? 4 : 8;
	$('#comingGrid').replaceChildren(...items.slice(0, state.expanded ? items.length : preview).map(item => {
		const button = element('button', 'coming-card');
		button.type = 'button';
		if (item.poster) { const image = element('img'); image.src = item.poster; image.alt = ''; image.loading = 'lazy'; image.onerror = () => image.remove(); button.append(image); }
		const text = element('div', 'coming-card-text');
		text.append(element('strong', '', item.title), element('span', 'coming-date', `${item.dateLabel} - ${jserverUI.comingDate(item)}`));
		if (item.episode) text.append(element('small', '', `${item.episode} - ${item.episodeTitle}`));
		if (item.type === 'movie') text.append(jserverUI.ratings(item.ratings, { compact: true }));
		button.append(text);
		button.onclick = () => openDetails(item);
		return button;
	}));
	const unavailable = state.unavailable.includes(state.type === 'tv' ? 'tv' : 'films');
	$('#comingStatus').textContent = unavailable ? 'This schedule is temporarily unavailable. Please check back shortly.' : !items.length ? 'Nothing scheduled in the next three months yet. More dates will appear as they are announced.' : '';
	$('#comingStatus').hidden = !$('#comingStatus').textContent;
	$('#comingMore').hidden = items.length <= preview;
	$('#comingMore').setAttribute('aria-expanded', String(state.expanded));
	$('#comingMore').textContent = state.expanded ? 'Show fewer' : `Show all ${items.length} upcoming ${state.type === 'tv' ? 'shows' : 'films'}`;
}

function render() {
	renderCalendar();
	renderHero();
	renderGrid();
}

function detailsMarkup(item) {
	const body = element('div', 'detail-content coming-details');
	const title = element('h2', '', item.title); title.id = 'comingDetailsTitle';
	body.append(element('p', 'eyebrow', 'COMING SOON'), title,
		element('p', 'coming-date', `${item.dateLabel} - ${jserverUI.comingDate(item)}`),
		element('p', 'overview', item.overview || 'Already on our list.'));
	if (item.type === 'movie') body.append(jserverUI.ratings(item.ratings, { links: true }));
	if (item.episodes?.length) {
		body.append(element('h3', '', 'Next episodes'));
		const schedule = element('div', 'upcoming-schedule');
		for (const episode of item.episodes) {
			const row = element('div', 'upcoming-episode');
			row.append(element('strong', '', `Season ${episode.season} - Episode ${episode.number}`), element('span', '', episode.title),
				element('span', 'coming-date', new Date(episode.date).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })));
			schedule.append(row);
		}
		body.append(schedule);
	}
	body.append(element('p', 'coming-note', item.type === 'tv'
		? 'Broadcast times use your time zone. Episodes appear here after they have been added to the collection.'
		: 'This is a release date, not a promise of when it will be watchable here. Cinema releases can arrive at home later.'));
	if (item.id) {
		const link = element('a', 'button secondary', item.type === 'tv' ? 'View show & available episodes' : 'View film & availability');
		link.href = `/discover?type=${encodeURIComponent(item.type)}&title=${encodeURIComponent(item.id)}`;
		body.append(link);
	}
	return body;
}

function openDetails(item, push = true) {
	if (!item) return;
	$('#comingDetailsBody').replaceChildren(detailsMarkup(item));
	if (push && !history.state?.comingDetail) history.pushState({ comingDetail: true }, '', urlFor(item));
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
			const item = [...state.tv, ...state.movies].find(entry => entry.id === requested);
			if (item) openDetails(item, false);
		}
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
$('#closeComingDetails').onclick = () => closeDetails();
$('#comingDetails').addEventListener('cancel', event => { event.preventDefault(); closeDetails(); });
window.addEventListener('popstate', () => {
	const query = new URLSearchParams(location.search), type = query.get('type');
	if (['tv', 'movie'].includes(type) && type !== state.type) setType(type, false);
	const title = query.get('title'), item = title ? [...state.tv, ...state.movies].find(entry => entry.id === title) : null;
	const dialog = $('#comingDetails');
	if (item) { if (!dialog.open) openDetails(item, false); }
	else if (dialog.open) dialog.close();
});
compact.addEventListener('change', () => { if (state.loaded) renderGrid(); });
void load();
