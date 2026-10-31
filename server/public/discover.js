const $ = selector => document.querySelector(selector);
const initial = new URLSearchParams(location.search);
const state = { genre:(initial.get('genre') || '').slice(0,50), sort:['rating','release'].includes(initial.get('sort')) ? initial.get('sort') : 'popular', mode: ['trending', 'uk-tv', 'for-you', 'services', 'movie', 'tv', 'requests'].includes(initial.get('type')) ? initial.get('type') : 'trending', query: (initial.get('q') || '').slice(0, 200), page: 1, pages: 1, generation: 0, detailGeneration: 0, loading: false };
const dialog = $('#requestDetails');
state.documentaryType = initial.get('format') === 'tv' ? 'tv' : 'movie';
if (initial.get('type') === 'documentaries') state.mode = 'documentaries';
if (state.genre === 'Documentary') { state.documentaryType = state.mode === 'tv' ? 'tv' : 'movie'; state.mode = 'documentaries'; state.genre = ''; }
function node(tag, text, className) {
	const el = document.createElement(tag);
	if (text !== undefined) el.textContent = text;
	if (className) el.className = className;
	return el;
}
async function api(route, body) {
	const response = await fetch(route, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
	if (response.status === 401) { location.assign('/login'); throw new Error('Please sign in again.'); }
	const data = await response.json();
	if (!response.ok) throw new Error(data.error || 'Please try again.');
	return data;
}
function poster(item) {
	const frame = node('span', undefined, 'discover-poster');
	if (item.poster || item.watchId) {
		const image = node('img'); image.src = item.poster ? 'https://image.tmdb.org/t/p/w342' + item.poster : '/images/' + encodeURIComponent(item.watchId) + '/Primary?width=342'; image.alt = ''; image.loading = 'lazy';
		image.onerror = () => frame.replaceChildren(node('span', item.type === 'tv' ? 'TV' : 'FILM'));
		frame.append(image);
	} else frame.append(node('span', item.type === 'tv' ? 'TV' : 'FILM'));
	return frame;
}
function card(item) {
	const button = node('button', undefined, 'discover-card');
	const ratings = jserverUI.ratings(item.ratings, { compact: true });
	if (!ratings.childElementCount) ratings.append(node('span', 'Not rated yet', 'discover-unrated'));
	button.append(poster(item), node('strong', item.title), node('span', `${item.type === 'tv' ? 'TV show' : 'Film'}${item.date ? ' · ' + item.date.slice(0, 4) : ''}`, 'discover-meta'), ratings, node('span', jserverUI.status(item.statusLabel), 'request-badge' + (item.statusLabel === 'Not requested' ? ' unrequested' : '')));
	if(item.vodAvailable)button.append(node('span','Stream now · '+item.vodProvider,'request-badge'));
	if (item.reason) button.append(node('span', item.reason, 'discover-reason'));
	if (item.requestedSeasons?.length) button.append(node('span', 'Seasons ' + item.requestedSeasons.join(', '), 'discover-meta'));
	if(item.rank)button.prepend(node('span',String(item.rank),'chart-rank'));
	if(item.chartSeason)button.append(node('span',item.chartSeason,'discover-meta'));
	button.onclick = () => item.id ? showDetails(item.type, item.id) : searchChart(item);
	return button;
}
async function load(more = false, silent = false) {
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
		$('#discoverStatus').textContent = data.items.length ? state.mode === 'requests' ? 'Everything we’ve added to the list. Look for “Ready to watch” when it arrives.' : '' : data.page < data.pages ? 'No matches on these pages. Choose Show more to keep looking.' : more ? 'No more titles to show.' : state.mode === 'requests' ? 'Nothing on the list yet. Discover something you’d like to watch.' : `No matching ${state.mode === 'tv' ? 'Series' : 'films'}. Try a different search.`;
		$('#discoverMore').hidden = data.page >= data.pages;
	} catch (error) {
		if (generation === state.generation) $('#discoverStatus').textContent = error.message;
	} finally {
		if (generation === state.generation) { state.loading = false; $('#discoverMore').disabled = false; $('#refreshRequests').disabled = false; }
	}
}
function switchMode(mode) {
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
	const heading = node('div', undefined, 'request-summary');
	const text = node('div');
	const title = node('h2', item.title); title.id = 'requestTitle';
	text.append(title, node('p', `${item.type === 'tv' ? 'TV show' : 'Film'}${item.date ? ' · ' + item.date.slice(0, 4) : ''}`, 'discover-meta'), node('span', item.vodAvailable?'Stream now · '+item.vodProvider:jserverUI.status(item.statusLabel), 'request-badge'), jserverUI.ratings(item.ratings, { links: true }));
	heading.append(poster(item), text);
	body.append(heading, node('p', item.overview || 'No description available yet.', 'request-overview'));
	if(item.vodId){const watch=node('div',undefined,'request-actions');const stream=node('a',item.type==='tv'?'▶ Browse streamed episodes':'▶ Stream now','button primary');stream.href='/?item='+encodeURIComponent(item.vodId);watch.append(stream);body.append(watch,node('p','Available through '+item.vodProvider+'. Prefer a local copy? Request it below.','request-feedback'));}
	body.append(TellyboxTaste.controls(item));
	const inputs = [];
	if (item.type === 'tv') {
		const fieldset = node('fieldset', undefined, 'season-picker');
		fieldset.append(node('legend', item.vodAvailable?'Request a local copy · choose seasons':'Choose seasons'));
		fieldset.append(node('p', 'Add it once. We keep watching for future episodes and new seasons automatically.'));
		if (item.seasons.some(s => s.requestable && s.number > 0)) {
			const all = node('button', 'Select all available to request', 'button quiet'); all.type = 'button';
			all.onclick = () => { for (const input of inputs) if (!input.disabled && Number(input.value) > 0) input.checked = true; updateButton(); };
			fieldset.append(all);
		}
		for (const season of item.seasons) {
			const label = node('label', undefined, 'season-choice');
			const input = node('input'); input.type = 'checkbox'; input.value = season.number; input.disabled = !season.requestable;
			input.onchange = () => updateButton(); inputs.push(input);
			const description = node('span', season.name + ' ');
			description.append(node('small', `· ${season.episodes} episodes · ${jserverUI.status(season.statusLabel).toLowerCase()}`));
			label.append(input, description); fieldset.append(label);
		}
		if (!item.seasons.length) fieldset.append(node('p', 'Season information is not available yet.'));
		body.append(fieldset);
	}
	const actions = node('div', undefined, 'request-actions');
	
	if (item.watchId) { const link = node('a', item.type === 'tv' ? 'Browse available episodes' : 'Watch in Tellybox', 'button primary'); link.href = '/?item=' + encodeURIComponent(item.watchId); actions.append(link); }
	const request = node('button', item.type === 'tv' ? 'Add seasons to local collection' : 'Add to local collection', 'button ' + (item.watchId ? 'secondary' : 'primary'));
	const canRequest = item.type === 'tv' ? item.seasons.some(s => s.requestable) : item.requestable;
	if (canRequest) actions.append(request);
	const refresh = node('button', 'Refresh status', 'button quiet'); refresh.onclick = () => showDetails(item.type, item.id); actions.append(refresh);
	const message = node('p', canRequest ? 'Downloads to your media server when a suitable release is found.' : item.watchId ? 'It’s here—ready when you are.' : 'Already on our list. It will appear in the collection once it’s ready.', 'request-feedback'); message.setAttribute('role', 'status');
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
		$('#activityLink').hidden = !access.local && !access.home;
		$('#activityLink').href = access.local ? '/activity' : new URL('/activity', access.localPlayback?.origin || location.origin).href;
		$('#remoteSettings').hidden = !access.local && !access.home;
		$('#remoteSettings').href = access.local ? '/settings' : new URL('/settings', access.localPlayback?.origin || location.origin).href;
		$('#signOut').hidden = access.local || access.home;
		$('#signOut').onclick = async () => { await api('/api/auth/logout', {}); location.replace('/login'); };
		await switchMode(state.mode);
		if (/^\d+$/.test(initial.get('title') || '') && ['movie', 'tv'].includes(state.mode)) await showDetails(state.mode, Number(initial.get('title')));
	} catch (error) { $('#discoverStatus').textContent = error.message; }
}
void init();

function shelf(title, items, parent, action) {
	const section=node('section',undefined,'discovery-shelf'), heading=node('div',undefined,'shelf-heading'); heading.append(node('h2',title));
	if(action) { const button=node('button','See all','button quiet'); button.onclick=action; heading.append(button); }
	const row=node('div',undefined,'discovery-row'); row.append(...items.map(card)); section.append(heading,row); parent.append(section);
	if(!items.length) row.append(node('p','Nothing to show here just now.','discover-meta'));
}
async function loadFeeds() {
	const generation=++state.generation, mode=state.mode, parent=$('#discoveryFeeds');
	$('#discoverStatus').textContent='Finding something good…';
	try {
		const options=await api('/api/discover/options'); if(generation!==state.generation)return;
		if(mode==='for-you') {
			const intro=node('div',undefined,'taste-intro');
			intro.append(node('p','Like a few titles or choose your interests. Suggestions stay personal to this browser; watched and disliked titles are left out.'));
			const change=node('button','Choose your interests','button secondary'); change.onclick=()=>chooseInterests(options.interests); intro.append(change); parent.append(intro);
			const data=await api('/api/discover/for-you',TellyboxTaste.payload()); if(generation!==state.generation)return;
			$('#discoverStatus').textContent=!data.personalized ? 'Start with a few things you enjoy. Documentaries? Crime? A good comedy?' : data.partial ? 'Some suggestions are temporarily unavailable. Here’s what we found.' : '';
			for(const section of data.sections) if(section.items.length) shelf(section.title,section.items,parent);
			if(data.personalized&&!data.sections.some(s=>s.items.length)) $('#discoverStatus').textContent='No fresh matches yet. Try another interest or like a few more titles.';
		} else {
			parent.append(node('p',options.note,'discover-note')); $('#discoverStatus').textContent='';
			// One service at a time keeps browsing responsive on the home server.
			for(const provider of options.providers) {
				if(generation!==state.generation)return;
				const holder=node('div'); parent.append(holder); holder.append(node('p','Finding recent '+provider.name+' releases…','discover-meta'));
				try { const data=await api('/api/discover/provider/'+provider.id); if(generation!==state.generation)return; holder.replaceChildren(); shelf(provider.name,data.items.slice(0,12),holder,()=>openProvider(provider,options.note)); }
				catch(error) { holder.replaceChildren(node('p',provider.name+': '+error.message,'status')); const retry=node('button','Try again','button quiet'); retry.onclick=()=>switchMode('services'); holder.append(retry); }
			}
		}
	} catch(error) { if(generation===state.generation) { $('#discoverStatus').textContent=error.message; const retry=node('button','Try again','button secondary'); retry.onclick=()=>switchMode(mode); parent.append(retry); } }
}
function openProvider(provider,note) {
	state.provider=provider.id; ++state.generation;
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
dialog.addEventListener('close',()=>{if(state.mode==='for-you')void switchMode('for-you');});

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
	const generation=++state.generation,parent=$('#discoveryFeeds');parent.replaceChildren();$('#discoverStatus').textContent='Loading charts…';
	try {
		const options=await api('/api/discover/trending');if(generation!==state.generation)return;
		const filters=node('div',undefined,'genre-filters');filters.setAttribute('aria-label','Trending categories');parent.append(filters);
		if(onlyGroup)filters.hidden=true;
		else for(const group of options.groups){const selected=group.id===groupId,button=node('button',group.name,'chip'+(selected?' active':''));button.setAttribute('aria-pressed',String(selected));button.onclick=()=>loadTrending(group.id);filters.append(button);if(selected)requestAnimationFrame(()=>{filters.scrollLeft=button.offsetLeft-filters.offsetLeft-16;});}
		$('#discoverStatus').textContent='';
		const group=options.groups.find(g=>g.id===groupId)||(onlyGroup?null:options.groups[0]);
		if(!group)throw Error('This chart is temporarily unavailable.');
		// Each shelf can load or retry independently, retaining the intended order.
		for(const key of group.rows){const holder=node('section',undefined,'trending-section');parent.append(holder);void row(key,holder);}
		async function row(key,holder){
			holder.replaceChildren(node('p','Finding the latest chart…','discover-meta'));
			try{const data=await api('/api/discover/trending/'+key);if(generation!==state.generation)return;holder.replaceChildren();
				const heading=node('div',undefined,'shelf-heading');heading.append(node('h2',data.title));holder.append(heading);
				if(data.week)holder.append(node('p','Week ending '+new Date(data.week+'T12:00:00Z').toLocaleDateString('en-GB',{day:'numeric',month:'short'}),'discover-note'));
				if(data.stale)holder.append(node('p','Showing the last available chart while we refresh.','discover-meta'));
				const list=node('div',undefined,'discovery-row');list.append(...data.items.map(card));holder.append(list);
				if(!data.items.length)holder.append(node('p','No titles are available in this chart yet.','discover-meta'));
				
			}catch(error){if(generation!==state.generation)return;holder.replaceChildren(node('p',error.message,'discover-meta'));const retry=node('button','Retry chart','button secondary');retry.onclick=()=>row(key,holder);holder.append(retry);}
		}
	}catch(error){if(generation!==state.generation)return;$('#discoverStatus').textContent=error.message;const retry=node('button','Retry charts','button secondary');retry.onclick=()=>loadTrending(groupId,onlyGroup);parent.append(retry);}
}
