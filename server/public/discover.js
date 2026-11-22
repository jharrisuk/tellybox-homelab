const $ = selector => document.querySelector(selector);
const sourceLabel = window.TellyboxSourceLabel || { streamed: item => 'Streamed', streamNow: item => 'Stream now', available: item => 'Available in the streamed catalogue.' };
const initial = new URLSearchParams(location.search);
const state = { genre:(initial.get('genre') || '').slice(0,50), sort:['rating','release'].includes(initial.get('sort')) ? initial.get('sort') : 'popular', mode: ['trending', 'uk-tv', 'for-you', 'services', 'movie', 'tv', 'requests'].includes(initial.get('type')) ? initial.get('type') : 'trending', query: (initial.get('q') || '').slice(0, 200), page: 1, pages: 1, generation: 0, detailGeneration: 0, loading: false, detailType: null, detailId: null };
const dialog = $('#requestDetails');
state.documentaryType = initial.get('format') === 'tv' ? 'tv' : 'movie';
if (initial.get('type') === 'documentaries') state.mode = 'documentaries';
if (state.genre === 'Documentary') { state.documentaryType = state.mode === 'tv' ? 'tv' : 'movie'; state.mode = 'documentaries'; state.genre = ''; }
function node(tag, text, className) {
function retryable(message, retry) {
	const status = $('#discoverStatus');
	status.textContent = message;
	let button = $('#discoverRetry');
	if (!button) {
		button = node('button', 'Try again', 'button secondary');
		button.id = 'discoverRetry';
		button.type = 'button';
		status.after(button);
	}
	button.hidden = false;
	button.onclick = () => { button.hidden = true; retry(); };
}
	const el = document.createElement(tag);
	if (text !== undefined) el.textContent = text;
	if (className) el.className = className;
	return el;
}
async function api(route, body, options = {}) {
	const init = body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {};
	if (options && options.signal) init.signal = options.signal;
	const response = await fetch(route, init);
	if (response.status === 401) { location.assign('/login'); throw new Error('Please sign in again.'); }
	const data = await response.json();
	if (!response.ok) throw new Error(data.error || 'Please try again.');
	return data;
}

// Shelves (discover services and charts) start together through a small worker
// pool instead of one serial `for ... await`. Holders are appended in display
// order before any request starts, so a slow provider cannot delay a later
// shelf and every shelf keeps its intended position. A mode change aborts the
// in-flight requests and bumps `state.generation`, which stops the pool from
// starting further jobs even if a response was already in transit.
const shelfConcurrency = 3;
let shelfController = null;
function startShelves() {
	stopShelves();
	shelfController = new AbortController();
	return shelfController.signal;
}
function stopShelves() {
	if (shelfController) { try { shelfController.abort(); } catch {} shelfController = null; }
}
function shelfSignal() {
	return shelfController ? shelfController.signal : undefined;
}
async function shelfPool(generation, jobs) {
	let next = 0;
	const workers = Math.max(1, Math.min(shelfConcurrency, jobs.length));
	const run = async () => {
		while (next < jobs.length && generation === state.generation) {
			const job = jobs[next++];
			try { await job(); } catch {}
		}
	};
	await Promise.all(Array.from({ length: workers }, run));
}

// Cross-document handoff state. Following a /?item=... link leaves Discover for
// the home player; app.js arms a one-shot marker on the way back. Only that
// immediate return restores pagination depth, scroll and the open detail
// dialog. Filters (mode/query/genre/sort) are already encoded in the URL by
// switchMode, so they survive the handoff without being stored here.
const handoffMarkerKey = 'tellybox-handoff';
const handoffStateKey = 'tellybox-handoff-discover';
const handoffTtl = 5 * 60 * 1000;
function discoverScroll() {
	const host = document.scrollingElement || document.documentElement;
	return host && Number.isFinite(host.scrollTop) ? host.scrollTop : 0;
}
function openDetailContext() {
	if (state.detailType === 'movie' || state.detailType === 'tv') {
		if (Number.isInteger(state.detailId) && state.detailId > 0) return { type: state.detailType, id: state.detailId };
	}
	return null;
}
function saveHandoffState() {
	try {
		const detail = openDetailContext();
		const active = document.activeElement;
		const cardIndex = active && active.closest ? [...document.querySelectorAll('#discoverGrid .discover-card')].indexOf(active.closest('.discover-card')) : -1;
		const focus = active && active.closest && active.closest('#requestDetails') ? { kind: 'dialog' }
			: cardIndex >= 0 ? { kind: 'card', index: cardIndex } : null;
		const data = {
			mode: typeof state.mode === 'string' ? state.mode : 'trending',
			query: (typeof state.query === 'string' ? state.query : '').slice(0, 200),
			genre: (typeof state.genre === 'string' ? state.genre : '').slice(0, 50),
			sort: ['rating', 'release', 'popular'].includes(state.sort) ? state.sort : 'popular',
			page: Number.isInteger(state.page) && state.page > 0 && state.page <= 100 ? state.page : 1,
			scroll: discoverScroll(),
			detailType: detail ? detail.type : null,
			detailId: detail ? detail.id : null,
			path: location.pathname,
			at: Date.now(),
			expiresAt: Date.now() + handoffTtl,
			focus
		};
		const raw = JSON.stringify(data);
		if (raw.length > 4096) return;
		sessionStorage.setItem(handoffStateKey, raw);
	} catch {}
}
function arrivedViaBack() {
	try { const entries = performance.getEntriesByType('navigation'); if (entries && entries.length && entries[0].type) return entries[0].type === 'back_forward'; } catch {}
	return false;
}
function takeHandoffState() {
	try {
		const markerRaw = sessionStorage.getItem(handoffMarkerKey);
		if (!markerRaw) return null;
		let marker = null; try { marker = JSON.parse(markerRaw); } catch { marker = null; }
		if (!marker || marker.path !== location.pathname) return null;
		sessionStorage.removeItem(handoffMarkerKey);
		if (!Number.isFinite(marker.expiresAt) || Date.now() > marker.expiresAt) return null;
		if (!arrivedViaBack()) return null;
		const stateRaw = sessionStorage.getItem(handoffStateKey);
		if (!stateRaw) return null;
		let state = null; try { state = JSON.parse(stateRaw); } catch { state = null; }
		sessionStorage.removeItem(handoffStateKey);
		if (!state || typeof state !== 'object') return null;
		if (!Number.isFinite(state.expiresAt) || Date.now() > state.expiresAt) return null;
		return state;
	} catch { return null; }
}
async function restoreHandoffState(restored) {
	try {
		if (Number.isInteger(restored.page) && restored.page > 1 && ['movie', 'tv', 'documentaries', 'requests'].includes(state.mode)) {
			let guard = 0;
			while (state.page < restored.page && state.page < state.pages && guard < 100) {
				guard += 1;
				await load(true, true);
			}
		}
		const scroll = Number(restored.scroll);
		if (Number.isFinite(scroll)) {
			const host = document.scrollingElement || document.documentElement;
			if (host) host.scrollTop = Math.max(0, Math.min(Math.round(scroll), 1e9));
		}
		if (restored.detailType === 'movie' || restored.detailType === 'tv') {
			if (Number.isInteger(restored.detailId) && restored.detailId > 0) await showDetails(restored.detailType, restored.detailId);
		}
		// Focus restoration is best-effort and never scrolls the page again.
		if (restored.focus && restored.focus.kind === 'dialog') {
			const first = document.querySelector('#requestBody a.button, #requestBody button:not(.quiet)');
			if (first) try { first.focus({ preventScroll: true }); } catch {}
		} else if (restored.focus && restored.focus.kind === 'card' && Number.isInteger(restored.focus.index)) {
			const card = [...document.querySelectorAll('#discoverGrid .discover-card')][restored.focus.index];
			if (card) try { card.focus({ preventScroll: true }); } catch {}
		}
	} catch {}
}
function poster(item) {
	const frame = node('span', undefined, 'discover-poster');
	if (item.Artwork || item.poster || item.watchId) {
		const image = node('img');
		const source = item.Artwork || (item.poster ? 'https://image.tmdb.org/t/p/w342' + item.poster : '/images/' + encodeURIComponent(item.watchId) + '/Primary?width=342');
		if (item.ArtworkLocal) { image.dataset.tellyboxLocal = item.ArtworkLocal; image.dataset.tellyboxFallback = '1'; }
		if (/^\/[A-Za-z0-9_-]+\.(jpg|jpeg|png|webp)$/i.test(item.poster || '')) image.dataset.tellyboxPoster = 'https://image.tmdb.org/t/p/w342' + item.poster;
		image.src = source; image.alt = ''; image.loading = 'lazy';
		image.onerror = () => { if (!image.dataset.tellyboxFallback) frame.replaceChildren(node('span', item.type === 'tv' ? 'TV' : 'FILM')); };
		frame.append(image);
	} else frame.append(node('span', item.type === 'tv' ? 'TV' : 'FILM'));
	return frame;
}
function card(item) {
	const button = node('button', undefined, 'discover-card');
	const ratings = jserverUI.ratings(item.ratings, { compact: true });
	if (!ratings.childElementCount) ratings.append(node('span', 'Not rated yet', 'discover-unrated'));
	const parts = [poster(item), node('strong', item.title), node('span', `${item.type === 'tv' ? 'TV show' : 'Film'}${item.date ? ' · ' + item.date.slice(0, 4) : ''}`, 'discover-meta'), ratings];
	// A streamed copy already says where it plays; do not stack "not in your
	// library" above "Stream now". A title with neither says so plainly.
	if (item.watchId) parts.push(node('span', 'In your library', 'request-badge'));
	else if (!item.vodAvailable) parts.push(node('span', jserverUI.status(item.statusLabel), 'request-badge' + (item.statusLabel === 'Not requested' ? ' unrequested' : '')));
	button.append(...parts);
	// The TorrentDay audit confirmed a title can genuinely have both a local
	// copy and a streamed counterpart. The card must not double-label that
	// case: "In your library" already says the local copy wins, so the
	// Stream now CTA only appears when there is no local copy at all.
	if(item.vodAvailable && !item.watchId)button.append(node('span',sourceLabel.streamNow(item),'request-badge'));
	if (item.reason) button.append(node('span', item.reason, 'discover-reason'));
	if (item.requestedSeasons?.length) button.append(node('span', 'Seasons ' + item.requestedSeasons.join(', '), 'discover-meta'));
	if(item.rank)button.prepend(node('span',String(item.rank),'chart-rank'));
	if(item.chartSeason)button.append(node('span',item.chartSeason,'discover-meta'));
	button.onclick = () => item.id ? showDetails(item.type, item.id) : searchChart(item);
	return button;
}
async function load(more = false, silent = false) {
	const retry = $('#discoverRetry'); if (retry) retry.hidden = true;
	const generation = ++state.generation;
	const page = more ? state.page + 1 : 1;
	state.loading = true;
	$('#discoverMore').disabled = true;
	$('#refreshRequests').disabled = true;
	if (!silent) $('#discoverStatus').textContent = 'Loading…';
	try {
		const docs = state.mode === 'documentaries';
		const route = state.mode === 'services' ? `/api/discover/provider/${state.provider}?page=${page}` : state.mode === 'requests' ? `/api/discover/requests?page=${page}` : `/api/discover?type=${docs ? state.documentaryType : state.mode}&q=${encodeURIComponent(state.query)}&genre=${encodeURIComponent(docs ? 'Documentary' : state.genre)}&excludeDocumentaries=${!docs}&sort=${state.query ? 'popular' : state.sort}&page=${page}`;
		const data = await api(route);
		if (generation !== state.generation) return;
		state.page = data.page; state.pages = data.pages;
		if (!more) $('#discoverGrid').replaceChildren();
		$('#discoverGrid').append(...data.items.map(card));
		$('#discoverStatus').textContent = data.items.length ? state.mode === 'requests' ? 'Everything we’ve added to the list. Look for “Ready to watch” when it arrives.' : '' : data.page < data.pages ? 'No matches on these pages. Choose Show more to keep looking.' : more ? 'No more titles to show.' : state.mode === 'requests' ? 'Nothing on the list yet. Discover something you’d like to watch.' : `No matching ${state.mode === 'tv' ? 'series' : 'films'}. Try a different search.`;
		$('#discoverMore').hidden = data.page >= data.pages;
	} catch (error) {
		if (generation === state.generation) retryable(error.message, () => load(more));
	} finally {
		if (generation === state.generation) { state.loading = false; $('#discoverMore').disabled = false; $('#refreshRequests').disabled = false; }
	}
}
function switchMode(mode) {
	stopShelves();
	state.mode = mode;
	for (const [id, active] of [['trendingTab', mode === 'trending'], ['ukTvTab', mode === 'uk-tv'], ['forYouTab', mode === 'for-you'], ['servicesTab', mode === 'services'], ['filmsTab', mode === 'movie'], ['tvTab', mode === 'tv'], ['documentariesTab', mode === 'documentaries'], ['requestsTab', mode === 'requests']]) {
		$('#' + id).classList.toggle('active', active); $('#' + id).setAttribute('aria-pressed', String(active));
		if (active) requestAnimationFrame(() => { const tab=$('#'+id), row=tab.parentElement; row.scrollLeft=tab.offsetLeft-row.offsetLeft-(row.clientWidth-tab.offsetWidth)/2; });
	}
	$('#searchForm').hidden = false;
	renderGenres();
	$('#refreshRequests').hidden = mode !== 'requests';
	const category = mode === 'tv' ? 'Series' : 'films';
	$('#discoverTitle').textContent = 'Discover';
	$('#discoverSearch').placeholder = 'Search everything…';
	$('#discoverSearch').setAttribute('aria-label', 'Search films, series and channels');
	$('#discoverSearch').value = state.query;
	$('#listTitle').textContent = mode === 'requests' ? 'On the list' : state.genre ? (state.genre === 'Documentary' ? 'Documentaries' : state.genre) + ' · ' + category : state.query ? `${mode === 'tv' ? 'Series' : 'Film'} results for “${state.query}”` : `${mode === 'tv' ? 'Series' : 'Films'} to discover`;
	if (mode === 'documentaries') $('#listTitle').textContent = 'Documentaries · ' + (state.documentaryType === 'tv' ? 'Series' : 'Films');
	const browsing = ['movie','tv','documentaries'].includes(mode);
	$('#discoverSortLabel').hidden = !browsing || Boolean(state.query);
	$('#discoverSort').value = state.sort;
	$('#discoverOrderNote').hidden = !browsing || (!state.query && state.sort === 'popular');
	$('#discoverOrderNote').textContent = state.query ? 'Search results are ordered by relevance.' : state.sort === 'rating' ? 'TMDB ratings · at least 50 votes, so a single review cannot top the list.' : 'Original film release or series premiere date · latest first.';
	const params = new URLSearchParams({ type: mode });
	if (mode === 'documentaries') params.set('format', state.documentaryType);
	if (state.query) params.set('q', state.query);
	if (state.genre) params.set('genre', state.genre);
	if (state.sort !== 'popular') params.set('sort', state.sort);
	history.replaceState(null, '', '/discover?' + params);
	$('#discoverGrid').replaceChildren(); $('#discoverMore').hidden = true;
	$('#discoveryFeeds').replaceChildren();
	if (mode === 'trending') { $('#listTitle').textContent='Trending this week'; return loadTrending(); }
	if (mode === 'uk-tv') { $('#listTitle').textContent='UK TV'; return loadTrending('uk-tv',true); }
	if (mode === 'for-you' || mode === 'services') {
		$('#discoverTitle').textContent = 'Discover';
		$('#listTitle').textContent = mode === 'for-you' ? 'For you' : 'Streaming services';
		return loadFeeds();
	}
	return load();
}
async function showDetails(type, id) {
	const generation = ++state.detailGeneration;
	state.detailType = type;
	state.detailId = id;
	$('#requestBody').replaceChildren(node('h2', 'Loading title…'));
	if (!dialog.open) dialog.showModal();
	try {
		const item = await api(`/api/discover/${type}/${id}`);
		if (generation !== state.detailGeneration || !dialog.open) return;
		renderDetails(item);
	} catch (error) {
		if (generation !== state.detailGeneration) return;
		$('#requestBody').replaceChildren(node('p', error.message, 'request-feedback'));
	}
}
function renderDetails(item) {
	const body = $('#requestBody'); body.replaceChildren();
	const missingSeasons = item.type === 'tv' && Array.isArray(item.seasons) && item.seasons.some(season => season.requestable);
	const heading = node('div', undefined, 'request-summary');
	const text = node('div');
	const title = node('h2', item.title); title.id = 'requestTitle';
	text.append(title, node('p', `${item.type === 'tv' ? 'TV show' : 'Film'}${item.date ? ' · ' + item.date.slice(0, 4) : ''}`, 'discover-meta'), node('span', item.watchId ? 'In your library' : item.vodAvailable ? sourceLabel.streamNow(item) : jserverUI.status(item.statusLabel), 'request-badge'), jserverUI.ratings(item.ratings, { links: true }));
	if (item.watchId) text.append(node('p', 'Local · in your collection', 'discover-source'));
	else if (item.vodId) text.append(node('p', sourceLabel.streamed(item), 'discover-source'));
	heading.append(poster(item), text);
	body.append(heading, node('p', item.overview || 'No description available yet.', 'request-overview'));
	if (Array.isArray(item.cast) && item.cast.length) body.append(node('p', 'Starring ' + item.cast.map(person => person.name).join(', '), 'discover-cast'));
	if(item.vodId && !item.watchId){const watch=node('div',undefined,'request-actions');const stream=node('a',item.type==='tv'?'▶ Browse streamed episodes':'▶ Stream now','button primary');stream.href='/?item='+encodeURIComponent(item.vodId)+'&from=discover';stream.addEventListener('click',saveHandoffState);watch.append(stream);body.append(watch,node('p','Prefer a local copy? Request it below.','request-feedback'));}
	body.append(TellyboxTaste.controls(item));
	const inputs = [];
	if (item.type === 'tv') {
		const fieldset = node('fieldset', undefined, 'season-picker');
		// A title already in the library is not a request: show its seasons and
		// open links. Only genuinely missing seasons carry a request checkbox.
		fieldset.append(node('legend', item.watchId ? 'Seasons' : item.vodAvailable ? 'Request a local copy \u00b7 choose seasons' : 'Choose seasons'));
		if (!item.watchId && missingSeasons) fieldset.append(node('p', 'Add it once. We keep watching for future episodes and new seasons automatically.'));
		if (missingSeasons && item.seasons.some(season => season.requestable && season.number > 0)) {
			const all = node('button', 'Select all available to request', 'button quiet'); all.type = 'button';
			all.onclick = () => { for (const input of inputs) if (!input.disabled && Number(input.value) > 0) input.checked = true; updateButton(); };
			fieldset.append(all);
		}
		for (const season of item.seasons) {
			const description = node('span', season.name + ' ');
			description.append(node('small', `\u00b7 ${season.episodes} episodes \u00b7 ${jserverUI.status(season.statusLabel).toLowerCase()}`));
			if (item.watchId && season.status === 5) {
				const row = node('div', 'season-choice available-season');
				const open = node('a', 'Open season \u2192', 'season-open');
				open.href = '/?item=' + encodeURIComponent(item.watchId) + '&season=' + season.number + '&from=discover';
				open.addEventListener('click', saveHandoffState);
				description.append(open);
				row.append(description); fieldset.append(row);
				continue;
			}
			const label = node('label', undefined, 'season-choice');
			const input = node('input'); input.type = 'checkbox'; input.value = season.number; input.disabled = !season.requestable;
			input.onchange = () => updateButton(); inputs.push(input);
			label.append(input, description); fieldset.append(label);
		}
		if (!item.seasons.length) fieldset.append(node('p', 'Season information is not available yet.'));
		body.append(fieldset);
	}
	const actions = node('div', undefined, 'request-actions');
	
	const localSeasons = item.type === 'tv' && item.seasons.some(season => season.status === 5);
	if (item.watchId && (item.type === 'movie' || !localSeasons)) { const link = node('a', item.type === 'tv' ? 'Open series' : 'Watch in Tellybox', 'button primary'); link.href = '/?item=' + encodeURIComponent(item.watchId) + '&from=discover'; link.addEventListener('click', saveHandoffState); actions.append(link); }
	const request = node('button', item.watchId ? (item.type === 'tv' ? 'Add missing seasons' : 'Local copy available') : item.type === 'tv' ? 'Add seasons to local collection' : 'Add to local collection', 'button ' + (item.watchId ? 'secondary' : 'primary'));
	const canRequest = item.watchId ? item.type === 'tv' && item.seasons.some(s => s.requestable) : item.type === 'tv' ? item.seasons.some(s => s.requestable) : item.requestable;
	if (canRequest) actions.append(request);
	const refresh = node('button', 'Refresh status', 'button quiet'); refresh.onclick = () => showDetails(item.type, item.id); actions.append(refresh);
	const message = node('p', item.watchId ? (item.type === 'tv' ? 'Local episodes play first. Add any missing seasons above.' : 'Playing from your local library.') : canRequest ? 'We’ll download a copy to your media server when a suitable release is found.' : 'It’s on the list. When a copy arrives, it’ll be waiting in your collection.', 'request-feedback'); message.setAttribute('role', 'status');
	body.append(actions, message);
	function updateButton() { request.disabled = item.type === 'tv' && !inputs.some(i => i.checked && !i.disabled); }
	updateButton();
	request.onclick = async () => {
		request.disabled = true; refresh.disabled = true;
		const selected = inputs.filter(i => i.checked && !i.disabled).map(i => Number(i.value));
		for (const input of inputs) input.disabled = true;
		message.textContent = 'Sending your request…';
		try {
			const result = await api('/api/discover/request', { type: item.type, id: item.id, ...(item.type === 'tv' ? { seasons: selected } : {}) });
			message.textContent = result.message;
			request.textContent = result.created ? jserverUI.status(result.item.statusLabel) : 'Already on the list';
			request.disabled = true;
			if (state.mode === 'requests') void load(false, true);
		} catch (error) { message.textContent = error.message + ' Use Refresh status before trying again.'; }
		finally { refresh.disabled = false; }
	};
}
$('#closeRequest').onclick = () => { ++state.detailGeneration; dialog.close(); };
dialog.addEventListener('cancel', () => { ++state.detailGeneration; });
$('#forYouTab').onclick = () => switchMode('for-you');
$('#servicesTab').onclick = () => switchMode('services');
$('#filmsTab').onclick = () => switchMode('movie');
$('#documentariesTab').onclick = () => { state.query = ''; void switchMode('documentaries'); };
$('#ukTvTab').onclick = () => { state.query = ''; void switchMode('uk-tv'); };
$('#tvTab').onclick = () => switchMode('tv');
$('#requestsTab').onclick = () => switchMode('requests');
$('#searchForm').onsubmit = event => { event.preventDefault(); const query=$('#discoverSearch').value.trim();if(query){location.assign('/search?'+new URLSearchParams({q:query}));return;} };
$('#discoverSearch').onsearch = () => { if (!$('#discoverSearch').value) { state.query = ''; switchMode(state.mode); } };
$('#discoverMore').onclick = () => load(true);
$('#refreshRequests').onclick = () => load();
$('#discoverSort').onchange = () => { state.sort = $('#discoverSort').value; switchMode(state.mode); };
setInterval(() => { if (state.mode === 'requests' && state.page === 1 && !state.loading && !document.hidden && !dialog.open) void load(false, true); }, 30000);
async function init() {
	try {
		const access = await api('/api/auth/status');
		$('#localAdmin').hidden = !access.local && !access.home;

		$('#signOut').hidden = access.local || access.home;
		$('#signOut').onclick = async () => { await api('/api/auth/logout', {}); location.replace('/login'); };
		await switchMode(state.mode);
		const restored = takeHandoffState();
		if (restored) await restoreHandoffState(restored);
		else if (/^\d+$/.test(initial.get('title') || '') && ['movie', 'tv'].includes(state.mode)) await showDetails(state.mode, Number(initial.get('title')));
	} catch (error) { retryable(error.message, () => init()); }
}
void init();
window.addEventListener('pagehide', saveHandoffState);
// A back/forward-cache restore re-shows the page without re-running this script
// and the browser already restored the content and dialog, so just consume the
// one-shot marker/state so a later visit does not restore stale state.
window.addEventListener('pageshow', event => { if (event && event.persisted) { try { const raw = sessionStorage.getItem(handoffMarkerKey); if (raw) { let marker = null; try { marker = JSON.parse(raw); } catch { marker = null; } if (marker && marker.path === location.pathname) sessionStorage.removeItem(handoffMarkerKey); } sessionStorage.removeItem(handoffStateKey); } catch {} } });

function shelf(title, items, parent, action) {
	const section=node('section',undefined,'discovery-shelf'), heading=node('div',undefined,'shelf-heading'); heading.append(node('h2',title));
	if(action) { const button=node('button','See all','button quiet'); button.onclick=action; heading.append(button); }
	const row=node('div',undefined,'discovery-row'); row.append(...items.map(card)); section.append(heading,row); parent.append(section);
	if(!items.length) row.append(node('p','Nothing to show here just now.','discover-meta'));
}
async function loadFeeds() {
	const generation=++state.generation, mode=state.mode, parent=$('#discoveryFeeds');
	startShelves();
	$('#discoverStatus').textContent='Finding something good…';
	try {
		const options=await api('/api/discover/options',undefined,{signal:shelfSignal()}); if(generation!==state.generation)return;
		if(mode==='for-you') {
			const intro=node('div',undefined,'taste-intro');
			intro.append(node('p','Like a few titles or choose your interests. Suggestions stay personal to this browser; watched and disliked titles are left out.'));
			const change=node('button','Choose your interests','button secondary'); change.onclick=()=>chooseInterests(options.interests); intro.append(change); parent.append(intro);
			const data=await api('/api/discover/for-you',TellyboxTaste.payload(),{signal:shelfSignal()}); if(generation!==state.generation)return;
			$('#discoverStatus').textContent=!data.personalized ? 'Start with a few things you enjoy. Documentaries? Crime? A good comedy?' : data.partial ? 'Some suggestions are temporarily unavailable. Here’s what we found.' : '';
			// One holder per returned section, in the server's order. The
			// personalized request itself stays a single POST.
			for(const section of data.sections) if(section.items.length) shelf(section.title,section.items,parent);
			if(data.personalized&&!data.sections.some(s=>s.items.length)) $('#discoverStatus').textContent='No fresh matches yet. Try another interest or like a few more titles.';
		} else {
			parent.append(node('p',options.note,'discover-note')); $('#discoverStatus').textContent='';
			// Create every service holder up front, in the intended order, then
			// let the pool fetch at most three at a time. A slow provider
			// therefore cannot hold back the providers below it.
			const jobs=options.providers.map(provider=>{
				const holder=node('div'); parent.append(holder);
				holder.append(node('p','Finding recent '+provider.name+' releases…','discover-meta'));
				return()=>loadProviderShelf(provider,holder,generation,options.note);
			});
			await shelfPool(generation,jobs);
		}
	} catch(error) { if(generation===state.generation&&error.name!=='AbortError') { $('#discoverStatus').textContent=error.message; const retry=node('button','Try again','button secondary'); retry.onclick=()=>switchMode(mode); parent.append(retry); } }
}
async function loadProviderShelf(provider,holder,generation,note) {
	if(generation!==state.generation)return;
	holder.replaceChildren(node('p','Finding recent '+provider.name+' releases…','discover-meta'));
	try {
		const data=await api('/api/discover/provider/'+provider.id,undefined,{signal:shelfSignal()}); if(generation!==state.generation)return;
		holder.replaceChildren(); shelf(provider.name,data.items.slice(0,12),holder,()=>openProvider(provider,note));
	} catch(error) {
		if(generation!==state.generation||error.name==='AbortError')return;
		holder.replaceChildren(node('p',provider.name+': '+error.message,'status'));
		const retry=node('button','Try again','button quiet'); retry.onclick=()=>{void loadProviderShelf(provider,holder,state.generation,note);}; holder.append(retry);
	}
}
function openProvider(provider,note) {
	state.provider=provider.id; ++state.generation; stopShelves();
	$('#discoveryFeeds').replaceChildren(node('p',note,'discover-note'));
	const back=node('button','← All streaming services','button quiet'); back.onclick=()=>switchMode('services'); $('#discoveryFeeds').prepend(back);
	$('#listTitle').textContent=provider.name; $('#discoverGrid').replaceChildren(); $('#discoverMore').hidden=true; void load();
}
function chooseInterests(interests) {
	const picker=document.createElement('dialog'); picker.className='interest-dialog';
	const title=node('h2','What do you enjoy?'); picker.setAttribute('aria-label','Choose your interests');
	picker.append(title,node('p','Pick a few favourites. Your likes and dislikes will fine-tune these suggestions.'));
	const choices=node('div',undefined,'interest-choices'), selected=new Set(TellyboxTaste.selected());
	for(const name of interests) { const label=node('label'); const input=node('input'); input.type='checkbox'; input.checked=selected.has(name); input.onchange=()=>input.checked?selected.add(name):selected.delete(name); label.append(input,document.createTextNode(name)); choices.append(label); }
	picker.append(choices); const actions=node('div',undefined,'request-actions');
	const cancel=node('button','Cancel','button quiet'); cancel.onclick=()=>picker.close(); const save=node('button','Save interests','button primary'); save.onclick=()=>{try{TellyboxTaste.select([...selected]);picker.close();void switchMode('for-you');}catch{save.textContent='Browser storage is unavailable';}};
	actions.append(cancel,save); picker.append(actions); picker.addEventListener('close',()=>picker.remove()); document.body.append(picker); picker.showModal();
}
dialog.addEventListener('close',()=>{state.detailType=null;state.detailId=null;if(state.mode==='for-you')void switchMode('for-you');});

function renderGenres() {
	const parent = $('#genreFilters'); parent.hidden = !['movie','tv','documentaries'].includes(state.mode); parent.replaceChildren();
	if (state.mode === 'documentaries') {
		for (const type of ['movie','tv']) {
			const active = state.documentaryType === type, button = node('button', type === 'tv' ? 'Series' : 'Films', 'chip' + (active ? ' active' : ''));
			button.setAttribute('aria-pressed', String(active)); button.onclick = () => { state.documentaryType = type; void switchMode('documentaries'); }; parent.append(button);
		}
		return;
	}
	for (const genre of ['', 'Crime','Comedy','Drama','Action','Science Fiction','Family','Animation','History','Mystery','Thriller','Horror','Romance','Music']) {
		const button = node('button', genre === '' ? 'All genres' : genre === 'Documentary' ? 'Documentaries' : genre, 'chip' + (state.genre === genre ? ' active' : ''));
		button.setAttribute('aria-pressed', String(state.genre === genre)); button.onclick = () => { state.genre = genre; state.query = ''; void switchMode(state.mode); }; parent.append(button);
	}
}

$('#trendingTab').onclick=()=>switchMode('trending');
function searchChart(item) {
	location.assign('/search?'+new URLSearchParams({q:item.chartTitle||item.title}));
}
async function loadTrending(groupId='highlights',onlyGroup=false) {
	const generation=++state.generation,parent=$('#discoveryFeeds');startShelves();parent.replaceChildren();$('#discoverStatus').textContent='Loading charts…';
	try {
		const options=await api('/api/discover/trending',undefined,{signal:shelfSignal()});if(generation!==state.generation)return;
		const filters=node('div',undefined,'genre-filters');filters.setAttribute('aria-label','Trending categories');parent.append(filters);
		if(onlyGroup)filters.hidden=true;
		else for(const group of options.groups){const selected=group.id===groupId,button=node('button',group.name,'chip'+(selected?' active':''));button.setAttribute('aria-pressed',String(selected));button.onclick=()=>loadTrending(group.id);filters.append(button);if(selected)requestAnimationFrame(()=>{filters.scrollLeft=button.offsetLeft-filters.offsetLeft-16;});}
		$('#discoverStatus').textContent='';
		const group=options.groups.find(g=>g.id===groupId)||(onlyGroup?null:options.groups[0]);
		if(!group)throw Error('This chart is temporarily unavailable.');
		// Holders keep the chart order while the same small pool bounds how many
		// chart requests are in flight; each shelf can still retry on its own.
		const jobs=group.rows.map(key=>{const holder=node('section',undefined,'trending-section');parent.append(holder);return()=>row(key,holder,generation);});
		await shelfPool(generation,jobs);
		async function row(key,holder,generation){
			holder.replaceChildren(node('p','Finding the latest chart…','discover-meta'));
			try{const data=await api('/api/discover/trending/'+key,undefined,{signal:shelfSignal()});if(generation!==state.generation)return;holder.replaceChildren();
				const heading=node('div',undefined,'shelf-heading');heading.append(node('h2',data.title));holder.append(heading);
				if(data.week)holder.append(node('p','Week ending '+new Date(data.week+'T12:00:00Z').toLocaleDateString('en-GB',{day:'numeric',month:'short'}),'discover-note'));
				if(data.stale)holder.append(node('p','Showing the last available chart while we refresh.','discover-meta'));
				const list=node('div',undefined,'discovery-row');list.append(...data.items.map(card));holder.append(list);
				if(!data.items.length)holder.append(node('p','No titles are available in this chart yet.','discover-meta'));
				
			}catch(error){if(generation!==state.generation||error.name==='AbortError')return;holder.replaceChildren(node('p',error.message,'discover-meta'));const retry=node('button','Retry chart','button secondary');retry.onclick=()=>{void row(key,holder,generation);};holder.append(retry);}
		}
	}catch(error){if(generation!==state.generation||error.name==='AbortError')return;$('#discoverStatus').textContent=error.message;const retry=node('button','Retry charts','button secondary');retry.onclick=()=>loadTrending(groupId,onlyGroup);parent.append(retry);}
}
