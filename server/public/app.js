const $ = selector => document.querySelector(selector);
const state = { libraries: [], library: null, type: 'all', items: [], total: 0, generation: 0, playing: null, session: null, hls: null, compatibility: false, loading: false, live: false };
const video = $('#video');
const details = $('#details');
const player = $('#player');
let searchTimer;
let playGeneration = 0;
let reporting = false;
let started = false;
let viewingStarted = false;
let viewingWarningShown = false;
let viewingBlocked = false;
const casting = { context: null, remote: null, controller: null, active: false, busy: false, lastPosition: 0, route: '', pendingTarget: null };
const routing = { origin: '', instance: '', direct: false, home: false, checked: false, enabled: false, preferLocal: true, pending: null };
const coming = { tv: [], movies: [], unavailable: [], type: 'tv', expanded: false, featured: null, loaded: false };
let guideData = null;
let recordingData = [], recordingFilter = 'all';

function updateRouting(message = '') {
	const local = casting.active ? casting.route === 'local' : state.session ? Boolean(routing.direct || state.sessionBase) : routing.direct || routing.enabled;
	const active = Boolean(casting.active || state.session);
	const route = local ? 'local' : 'relay';
	const text = active ? (local ? 'Streaming locally · video is travelling directly from your home server.' : 'Streaming through the relay · video is using your internet connection.')
		: local ? (routing.direct ? 'Local connection · connected directly to your home server.' : 'Local streaming available · your home server was reached directly. This page uses the relay.')
		: 'Relay connection · this page is using the internet relay. Local playback is checked when you press play.';
	window.dispatchEvent(new CustomEvent('tellybox-route', { detail: { route, text } }));
	$('#localRouting').hidden = !routing.home && !routing.direct;
	$('#localRoutingButton').hidden = routing.direct;
	$('#localRoutingButton').disabled = Boolean(routing.pending) || casting.active || casting.busy;
	$('#localRoutingButton').textContent = routing.enabled ? 'Use relay instead' : 'Use local streaming';
	$('#localRoutingStatus').textContent = message || (routing.direct || routing.enabled
		? 'Local streaming · video stays on your home network'
		: routing.checked ? 'Using the relay · local connection unavailable or disabled' : 'At home · local streaming will be checked when you press play');
	$('#streamRoute').textContent = casting.active ? (casting.route === 'local' ? 'TV streaming locally · direct from your home server' : 'TV streaming through the relay')
		: state.session ? (routing.direct || state.sessionBase ? 'Streaming locally · direct from your home server' : 'Streaming through the relay') : '';
}

async function playbackBase() {
	if (routing.direct || !routing.home || !routing.origin || !routing.preferLocal) return '';
	if(routing.checked&&(routing.enabled||Date.now()-(routing.checkedAt||0)<60000))return routing.enabled?routing.origin:'';
	if (!routing.pending) {
		routing.pending = (async () => {
			try {
				const response = await fetch(new URL('/api/local-playback', routing.origin), { credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(15000), targetAddressSpace: 'local' });
				const data = response.ok ? await response.json() : null;
				if (!data || data.instance !== routing.instance) throw new Error('Different local server');
				routing.enabled = true;
			} catch { routing.enabled = false; }
			finally { routing.checked = true;routing.checkedAt=Date.now(); }
		})();
		updateRouting('Connecting to your home server… Allow local network access if your browser asks.');
	}
	await routing.pending;
	routing.pending = null;
	updateRouting(routing.enabled ? '' : 'Local connection unavailable in this browser. Using the relay; you can also open the local site.');
	return routing.enabled ? routing.origin : '';
}

$('#localRoutingButton').onclick = async () => {
	if (casting.active || casting.busy || routing.pending) return;
	routing.preferLocal = !routing.enabled;
	routing.enabled = false;
	routing.checked = !routing.preferLocal;
	try { localStorage.setItem('jserver-prefer-local', String(routing.preferLocal)); } catch {}
	await playbackBase();
	updateRouting();
	if (state.session && state.playing) void startPlayback(state.playing, playbackPosition(), true);
};

function playbackPosition() { return casting.active ? (Number.isFinite(casting.remote.currentTime) ? casting.remote.currentTime : casting.lastPosition) : video.currentTime || 0; }

function updateCastControls() {
	$('#castButton').disabled = !state.session || casting.busy || casting.active;
	$('#castControls').hidden = !casting.active;
	updateRouting();
	video.hidden = casting.active;
	updateLiveControls();
	const locked = !state.session || casting.active || casting.busy || viewingBlocked;
	$('#quality').disabled = locked || state.playbackKind === 'audio';
	$('#retryPlayer').disabled = locked || state.playbackKind === 'audio';
	$('#audioTrack').disabled = locked || $('#audioTrack').options.length < 2;
	$('#subtitleTrack').disabled = locked || $('#subtitleTrack').options.length < 2;
	$('#castPause').hidden = state.live;
	$('#castSeek').closest('label').hidden = state.live;
	if (!casting.active) return;
	const remote = casting.remote;
	$('#playerStatus').textContent = remote.playerState === 'BUFFERING' ? 'Buffering on your TV…' : state.live ? 'Live on your TV' : remote.isPaused ? 'Paused on your TV' : 'Playing on your TV';
	if (Number.isFinite(remote.currentTime)) casting.lastPosition = remote.currentTime;
	$('#castPause').textContent = remote.isPaused ? 'Play TV' : 'Pause TV';
	$('#castPause').disabled = state.live || !remote.canPause;
	$('#castSeek').disabled = state.live || !remote.canSeek || !Number.isFinite(remote.duration) || remote.duration <= 0;
	$('#castSeek').max = String(Number.isFinite(remote.duration) ? remote.duration : 0);
	if (!state.live && document.activeElement !== $('#castSeek')) $('#castSeek').value = String(remote.currentTime || 0);
	const minutes = Math.floor((remote.currentTime || 0) / 60);
	$('#castTime').textContent = `${minutes}:${String(Math.floor((remote.currentTime || 0) % 60)).padStart(2, '0')}`;
}

function updateLiveControls() {
	const show = Boolean(state.live) && !casting.active && player.open;
	$('#liveControls').hidden = !show;
	if (show) {
		$('#livePlay').hidden = !video.paused || !video.currentSrc;
		$('#liveMute').textContent = video.muted ? 'Unmute' : 'Mute';
		$('#liveMute').setAttribute('aria-pressed', String(video.muted));
		$('#liveFullscreen').textContent = document.fullscreenElement ? 'Exit fullscreen' : 'Fullscreen';
	}
}

// Native media keys and keyboard shortcuts can still pause or seek a video
// without on-screen controls. Live playback is pulled back to the live edge.
function keepLivePlayback() {
	if (!state.live || casting.active || !player.open || viewingBlocked) return false;
	video.play().catch(() => {});
	return true;
}

function keepLiveEdge() {
	if (!state.live || casting.active || !player.open || viewingBlocked) return;
	const seekable = video.seekable;
	if (!seekable?.length) return;
	const edge = seekable.end(seekable.length - 1);
	if (Number.isFinite(edge) && Math.abs(video.currentTime - edge) > 2) video.currentTime = edge;
}

// Actual playback mode decides this, not the channel or item identity.
function setLiveMode(live) {
	state.live = Boolean(live);
	video.controls = !state.live;
	video.disablePictureInPicture = state.live;
	updateLiveControls();
	updateCastControls();
}

function setupCast() {
	if (!window.isSecureContext || location.protocol !== 'https:') {
		$('#castStatus').textContent = 'To cast, open the secure Tellybox address in Chrome and sign in. Keep your phone and TV on the same Wi-Fi.';
		void api('/api/auth/tunnel').then(value => {
			if (value.url?.startsWith('https://')) { $('#castSecureLink').href = value.url; $('#castSecureLink').hidden = false; }
		}).catch(() => {});
		return;
	}
	window.__onGCastApiAvailable = available => {
		if (!available) { $('#castStatus').textContent = 'Casting needs Google Chrome on Android or a computer, and a TV with Google Cast.'; return; }
		casting.context = cast.framework.CastContext.getInstance();
		casting.context.setOptions({ receiverApplicationId: chrome.cast.media.DEFAULT_MEDIA_RECEIVER_APP_ID, autoJoinPolicy: chrome.cast.AutoJoinPolicy.TAB_AND_ORIGIN_SCOPED });
		casting.remote = new cast.framework.RemotePlayer();
		casting.controller = new cast.framework.RemotePlayerController(casting.remote);
		casting.controller.addEventListener(cast.framework.RemotePlayerEventType.ANY_CHANGE, updateCastControls);
		casting.controller.addEventListener(cast.framework.RemotePlayerEventType.PLAYER_STATE_CHANGED, () => {
			if (!casting.active || casting.busy || casting.remote.playerState !== 'IDLE') return;
			saveProgress();
			void report('stop');
			state.session = null;
			casting.active = false;
			updateCastControls();
			$('#playerStatus').textContent = 'Playback on the TV has ended. Choose a title to play again.';
			$('#castStatus').textContent = 'Google Cast · phone and TV must be on the same Wi-Fi.';
		});
		casting.context.addEventListener(cast.framework.CastContextEventType.SESSION_STATE_CHANGED, event => {
			if (event.sessionState === cast.framework.SessionState.SESSION_ENDED && casting.active && !casting.busy) {
				const position = casting.lastPosition;
				casting.active = false;
				void startPlayback(state.playing, position, true);
			}
		});
		$('#castStatus').textContent = 'Choose Cast to TV. Your phone and TV must be on the same Wi-Fi.';
	};
	const sdk = document.createElement('script');
	sdk.src = 'https://www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1';
	sdk.onerror = () => { $('#castStatus').textContent = 'Google Cast could not load. Try Chrome and check whether a content blocker is blocking Google Cast.'; };
	document.head.append(sdk);
}

async function castToTv() {
	if (!casting.context) {
		$('#castStatus').textContent = location.protocol !== 'https:'
			? 'Open the secure link below in Chrome, sign in, then play your title and choose Cast to TV.'
			: 'Google Cast is unavailable here. Use Chrome on Android or a computer, with your TV on the same Wi-Fi.';
		return;
	}
	if (!state.session || casting.busy) return;
	const sessionId = state.session;
	const generation = playGeneration;
	casting.busy = true;
	updateCastControls();
	let target;
	try {
		// Request the chooser directly from the click, before any network awaits.
		await casting.context.requestSession();
		if (sessionId !== state.session || generation !== playGeneration) return;
		target = casting.context.getCurrentSession();
		if (!target) return;
		casting.pendingTarget = target;
		$('#castStatus').textContent = 'Sending the stream to your TV…';
		const ticket = await api(`/api/sessions/${sessionId}/cast`, {}, state.sessionBase);
		const { loadCastMedia } = await import('/cast-load.mjs');
		if (sessionId !== state.session || generation !== playGeneration) return;
		const loadOnTv = async url => {
			const info = new chrome.cast.media.MediaInfo(url, ticket.contentType);
			info.metadata = new chrome.cast.media.GenericMediaMetadata();
			info.metadata.title = $('#playerTitle').textContent;
			info.streamType = state.live ? chrome.cast.media.StreamType.LIVE : chrome.cast.media.StreamType.BUFFERED;
			const load = new chrome.cast.media.LoadRequest(info);
			const caption=state.captionTracks?.find(track=>track.index===Number($('#subtitleTrack').value)&&track.url);
			if(caption){const track=new chrome.cast.media.Track(1,chrome.cast.media.TrackType.TEXT);track.trackContentId=url.slice(0,url.lastIndexOf('/')+1)+caption.url.split('/').at(-1);track.trackContentType='text/vtt';track.subtype=chrome.cast.media.TextTrackType.SUBTITLES;track.name=caption.label;info.tracks=[track];load.activeTrackIds=[1];}
			load.currentTime = state.live ? 0 : video.currentTime || 0;
			load.autoplay = true;
			await loadCastMedia(target, load, { isCurrent: () => sessionId === state.session && generation === playGeneration });
		};
		casting.route = 'relay';
		if (ticket.localUrl && (routing.direct || state.sessionBase)) {
			$('#castStatus').textContent = 'Connecting your TV directly to the home server…';
			try {
				await loadOnTv(ticket.localUrl);
				casting.route = 'local';
			} catch (error) {
				if (sessionId !== state.session || generation !== playGeneration) return;
				if (error?.code === 'cancel') throw error;
				$('#castStatus').textContent = 'The TV could not load the local stream. Trying the relay…';
				await loadOnTv(ticket.url);
			}
		} else await loadOnTv(ticket.url);
		if (sessionId !== state.session || generation !== playGeneration) { target.endSession(true); return; }
		casting.lastPosition = video.currentTime || 0;
		casting.active = true;
		beginViewing();
		video.pause();
		video.onloadedmetadata = null;
		if (state.hls) { state.hls.destroy(); state.hls = null; }
		video.querySelectorAll('track').forEach(track=>track.remove());
	video.removeAttribute('src');
		video.load();
		$('#playerStatus').textContent = 'Playing on your TV';
		$('#castStatus').textContent = `Connected to ${target.getCastDevice().friendlyName}. ${casting.route === 'local' ? 'Video stays on your home network.' : 'Video uses the relay.'} Closing this player stops the TV.`;
		void report('start');
	} catch (error) {
		const code = error?.code || error;
		if (sessionId === state.session && generation === playGeneration) {
			$('#castStatus').textContent = code === 'cancel' ? 'Casting cancelled. Choose Cast to TV when you’re ready.' : 'The TV did not confirm playback. Check the TV and Wi-Fi, or try compatibility mode and cast again.';
		}
	} finally { casting.pendingTarget = null; casting.busy = false; updateCastControls(); }
}

$('#castButton').onclick = castToTv;
$('#castPause').onclick = () => { if (!state.live) casting.controller?.playOrPause(); };
$('#castSeek').onchange = () => {
	if (!casting.active || state.live || !casting.remote.canSeek) return;
	casting.remote.currentTime = Number($('#castSeek').value);
	casting.lastPosition = casting.remote.currentTime;
	casting.controller.seek();
};
$('#castStop').onclick = () => { if (casting.active) void startPlayback(state.playing, playbackPosition(), true); };

function element(tag, className, text) {
	const node = document.createElement(tag);
	if (className) node.className = className;
	if (text !== undefined) node.textContent = text;
	return node;
}

async function api(url, body, base = '', timeoutOverride) {
	const timeout = timeoutOverride || (url === '/api/viewing-status' ? 8000 : url.startsWith('/api/sessions/') ? 15000 : 45000);
	const response = await fetch(new URL(url, base || location.origin), { signal: AbortSignal.timeout(timeout), credentials: base ? 'omit' : 'same-origin', ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
	if (response.status === 401) { location.replace('/login'); throw new Error('Please sign in again.'); }
	if (!response.ok) {
		const data = await response.json().catch(() => ({}));
		const error = new Error(data.error || 'Could not reach Tellybox. Please try again.');
		error.status = response.status; error.code = data.code || null; error.retryAfter = data.retryAfter;
		throw error;
	}
	return response.status === 204 ? null : response.json();
}

$('#livePlay').onclick = () => { video.play().catch(() => { $('#playerStatus').textContent = 'Tap the video to start live playback.'; }); };
$('#liveMute').onclick = () => { video.muted = !video.muted; updateLiveControls(); };
$('#liveFullscreen').onclick = async () => {
	try { if (document.fullscreenElement) await document.exitFullscreen(); else await $('.video-stage').requestFullscreen(); }
	catch { /* Fullscreen can be unavailable in some embedded browsers. */ }
};
document.addEventListener('fullscreenchange', updateLiveControls);

function imageUrl(item, backdrop = false, width = 400) {
	if (backdrop && item.BackdropArtwork) return item.BackdropArtwork;
	if (item.Artwork) return item.Artwork;
	const id = backdrop && !item.BackdropImageTags?.length ? item.ParentBackdropItemId || item.Id : item.Id;
	return `/images/${id}/${backdrop ? 'Backdrop' : 'Primary'}?width=${width}`;
}

function minutes(ticks) {
	const n = Math.round((ticks || 0) / 6e8);
	return n >= 60 ? `${Math.floor(n / 60)}h ${n % 60}m` : n ? `${n}m` : '';
}

function meta(item) {
	return [item.ProductionYear, item.OfficialRating ? `Age rating: ${item.OfficialRating}` : null, minutes(item.RunTimeTicks)].filter(Boolean).join('  ·  ');
}

function friendlyType(item) {
	return ({ Movie: 'Film', Series: 'Series', Episode: 'Episode', MusicAlbum: 'Album', Audio: 'Track', TvChannel: 'Live TV' })[item.Type] || item.Type;
}

function episodeNumber(item) {
	const season = Number.isInteger(item?.ParentIndexNumber) && item.ParentIndexNumber > 0 ? 'S' + item.ParentIndexNumber : '';
	const episode = Number.isInteger(item?.IndexNumber) && item.IndexNumber > 0 ? 'E' + item.IndexNumber : '';
	return [season, episode].filter(Boolean).join(' ');
}

function episodeLabel(item) {
	const series = typeof item?.SeriesName === 'string' ? item.SeriesName.trim() : '';
	const title = typeof item?.Name === 'string' ? item.Name.trim() : '';
	const number = episodeNumber(item);
	const parts = [], seen = new Set();
	for (const part of [series, number, title]) {
		const key = part.toLocaleLowerCase();
		if (!part || seen.has(key)) continue;
		seen.add(key); parts.push(part);
	}
	return parts.join(' · ');
}

function playbackTitle(item) {
	return item?.Type === 'Episode' || item?.SeriesName ? episodeLabel(item) : item?.Name || '';
}

function card(item, releaseDate = false) {
	const button = element('button', 'card');
	button.setAttribute('aria-label', `${item.Name}, ${friendlyType(item)}`);
	const poster = element('div', 'poster');
	poster.append(element('div', 'fallback', item.Name));
	const image = element('img');
	image.src = imageUrl(item);
	image.alt = '';
	image.loading = 'lazy';
	image.addEventListener('error', () => image.remove(), { once: true });
	poster.append(image, element('span', 'badge', friendlyType(item).toUpperCase()), element('span', 'play-mark', '▶'));
	const date = item.PremiereDate ? new Date(item.PremiereDate) : null;
	const caption = releaseDate && date && !Number.isNaN(date.valueOf())
		? date.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
		: item.CurrentProgram?.Name || [item.ProductionYear, item.Genres?.[0] || (item.Type === 'Episode' ? item.SeriesName : friendlyType(item))].filter(Boolean).join(' · ');
	button.append(poster, element('h3', '', item.Name), element('p', '', caption));
	if (item.Type === 'Movie') {
		const ratings = jserverUI.ratings(item.Ratings, { compact: true });
		if (!ratings.childElementCount) ratings.append(element('span', 'ratings-empty', 'Not rated yet'));
		button.append(ratings);
	}
	if (item.Source === 'streamed') button.append(element('span', 'source-note', 'Streamed · ' + (item.Provider || 'Dispatcharr')));
	button.addEventListener('click', () => showDetails(item.Id));
	return button;
}

function anotherPick() {
	const pool = coming.type === 'tv' ? coming.tv : coming.movies;
	if (!pool.length) return;
	const current = pool.indexOf(coming.featured);
	const item = pool[(current + 1) % pool.length];
	coming.featured = item;
	$('#heroTitle').textContent = item.title;
	$('#heroDescription').textContent = item.overview || 'Already on our list. Keep an eye out for it here.';
	$('#heroEyebrow').textContent = item.type === 'tv' ? 'YOUR NEXT EPISODE' : 'A FILM TO LOOK FORWARD TO';
	$('#heroMeta').replaceChildren(element('strong', 'coming-date', `${item.dateLabel} · ${jserverUI.comingDate(item)}`));
	if (item.episode) $('#heroMeta').append(element('span', 'coming-episode', `${item.episode} · ${item.episodeTitle}`));
	if (item.ratings?.length) $('#heroMeta').append(jserverUI.ratings(item.ratings, { compact: true }));
	const image = $('#heroImage'); image.hidden = !item.poster;
	if (item.poster) image.src = item.poster;
	image.onerror = () => { image.hidden = true; };
	$('#heroPlay').hidden = false; $('#heroPlay').textContent = item.type === 'tv' ? 'Episode schedule' : 'About this film';
	$('#heroDetails').hidden = true;
	$('#anotherPick').hidden = pool.length < 2;
	updateHomeSections();
}

function showComingDetails(item) {
	const body = element('div', 'detail-content coming-details');
	const title = element('h2', '', item.title); title.id = 'detailsTitle';
	body.append(element('p', 'eyebrow', 'COMING SOON'), title,
		element('p', 'coming-date', `${item.dateLabel} · ${jserverUI.comingDate(item)}`),
		element('p', 'overview', item.overview || 'Already on our list.'));
	if (item.type === 'movie') body.append(jserverUI.ratings(item.ratings, { links: true }));
	if (item.episodes?.length) {
		body.append(element('h3', '', 'Next episodes'));
		const schedule = element('div', 'upcoming-schedule');
		for (const episode of item.episodes) {
			const row = element('div', 'upcoming-episode');
			row.append(element('strong', '', `Season ${episode.season} · Episode ${episode.number}`), element('span', '', episode.title), element('span', 'coming-date', new Date(episode.date).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })));
			schedule.append(row);
		}
		body.append(schedule);
	}
	body.append(element('p', 'coming-note', item.type === 'tv' ? 'These are broadcast times in your time zone. Episodes appear here after they’ve been added to the collection.' : 'This is a release date, not a promise of when it will be watchable here. Cinema releases can arrive at home later.'));
	if (item.id) {
		const link = element('a', 'button secondary', item.type === 'tv' ? 'View show & available episodes' : 'View film & availability');
		link.href = `/discover?type=${item.type}&title=${item.id}`; body.append(link);
	}
	$('#detailsBody').replaceChildren(body);
	if (!details.open) details.showModal();
}

const compactComing = matchMedia('(max-width: 850px)');
compactComing.addEventListener('change', () => { if (coming.loaded) renderComing(); });
function renderCalendar() {
	const days = jserverCalendar.days(coming);
	$('#calendarDays').replaceChildren(...days.map((day, index) => {
		const row = element('section', 'calendar-day');
		row.setAttribute('aria-label', day.date.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' }));
		const date = element('div', 'calendar-date');
		date.append(element('strong', '', index === 0 ? 'Today' : day.date.toLocaleDateString(undefined, { weekday: 'short' })), element('span', '', day.date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })));
		const items = element('div', 'calendar-day-items');
		for (const item of day.items) {
			const button = element('button', 'calendar-item');
			button.append(element('strong', '', item.title), element('span', '', item.type === 'tv' ? item.episode : item.dateLabel));
			button.onclick = () => showComingDetails(item);
			items.append(button);
		}
		if (!day.items.length) items.append(element('span', 'calendar-empty', 'Nothing scheduled'));
		row.append(date, items);
		return row;
	}));
	$('#calendarSummary').textContent = coming.unavailable.length ? 'Some listings are temporarily unavailable.' : 'Scheduled releases · arrival may vary';
}

function renderComing() {
	renderCalendar();
	const items = coming.type === 'tv' ? coming.tv : coming.movies;
	const previewCount = compactComing.matches ? 3 : 6;
	$('#comingGrid').replaceChildren(...items.slice(0, coming.expanded ? items.length : previewCount).map(item => {
		const button = element('button', 'coming-card');
		if (item.poster) { const image = element('img'); image.src = item.poster; image.alt = ''; image.loading = 'lazy'; image.onerror = () => image.remove(); button.append(image); }
		const text = element('div', 'coming-card-text');
		text.append(element('strong', '', item.title), element('span', 'coming-date', `${item.dateLabel} · ${jserverUI.comingDate(item)}`));
		if (item.episode) text.append(element('small', '', `${item.episode} · ${item.episodeTitle}`));
		if (item.type === 'movie') text.append(jserverUI.ratings(item.ratings, { compact: true }));
		button.append(text); button.onclick = () => showComingDetails(item); return button;
	}));
	$('#comingStatus').textContent = coming.unavailable.includes(coming.type === 'tv' ? 'tv' : 'films') ? 'The schedule is temporarily unavailable. Please check back shortly.' : !items.length ? 'Nothing scheduled in the next three months yet. More dates will appear as they’re announced.' : '';
	$('#comingStatus').hidden = !$('#comingStatus').textContent;
	$('#comingMore').hidden = items.length <= previewCount;
	$('#comingMore').setAttribute('aria-expanded', String(coming.expanded));
	$('#comingMore').textContent = coming.expanded ? 'Show fewer' : `Show all ${items.length} upcoming ${coming.type === 'tv' ? 'shows' : 'films'}`;
}

async function loadComing() {
	try {
		Object.assign(coming, await api('/api/coming-soon'), { loaded: true });
		if (!coming.tv.length && coming.movies.length) coming.type = 'movie';
		for (const button of document.querySelectorAll('[data-coming]')) { const selected = button.dataset.coming === coming.type; button.classList.toggle('active', selected); button.setAttribute('aria-pressed', String(selected)); }
		renderComing(); anotherPick();
	} catch {
		$('#comingStatus').textContent = 'The schedule is temporarily unavailable. Please check back shortly.';
		$('#calendarSummary').textContent = 'The schedule is temporarily unavailable. Please check back shortly.';
	}
}

$('#comingFilters').onclick = event => {
	const button = event.target.closest('[data-coming]'); if (!button) return;
	coming.type = button.dataset.coming; coming.expanded = false; coming.featured = null;
	for (const tab of document.querySelectorAll('[data-coming]')) { tab.classList.toggle('active', tab === button); tab.setAttribute('aria-pressed', String(tab === button)); }
	$('#hero').hidden = true;
	renderComing(); anotherPick();
};
$('#comingMore').onclick = () => { coming.expanded = !coming.expanded; renderComing(); };

function updateHomeSections() {
	const home = !state.library && state.type === 'all' && !$('#search').value.trim();
	const favourites=Object.values(readFavourites());
	$('#favouriteShelf').hidden=!home||(!favourites.length&&!$('#importBrowserFavourites'));
	$('#favouriteGrid').replaceChildren(...favourites.slice(0,16).map(i=>card(i)));
	$('#comingSoon').hidden = !home;
	$('#hero').hidden = !home || !coming.featured;
	$('#releases').hidden = !home;
	$('#tvReleases').hidden = !home;
}

async function loadTvReleases() {
	try {
		const data = await api('/api/web/releases/tv');
		$('#tvReleaseGrid').replaceChildren(...data.items.map(episode => {
			if(episode.Type==='Series')return card(episode,true);
			const button = card({ ...episode, Id: episode.SeriesId, Name: episode.SeriesName, Type: 'Series' }, true);
			const number = [Number.isInteger(episode.ParentIndexNumber) ? `S${episode.ParentIndexNumber}` : '', Number.isInteger(episode.IndexNumber) ? `E${episode.IndexNumber}` : ''].filter(Boolean).join(' · ');
			button.append(element('p', 'release-episode', [number, episode.Name].filter(Boolean).join(' · ')));
			return button;
		}));
		$('#tvReleasesStatus').hidden = data.items.length > 0;
		$('#tvReleasesStatus').textContent = 'No episodes released in the past year are available yet.';
	} catch (error) { $('#tvReleasesStatus').hidden = false; $('#tvReleasesStatus').textContent = error.message; }
}

async function loadReleases() {
	try {
		const data = await api('/api/web/releases');
		$('#releaseGrid').replaceChildren(...data.items.map(item => card(item, true)));
		$('#releasesStatus').hidden = data.items.length > 0;
		$('#releasesStatus').textContent = 'No films released in the past year are listed in this library yet.';
	} catch (error) { $('#releasesStatus').textContent = error.message; }
}

async function loadItems(append = false) {
	const globalQuery=$('#search').value.trim();
	$('#searchEverywhere').hidden=!globalQuery;
	$('#searchEverywhere').href='/search?'+new URLSearchParams({q:globalQuery});
	if(state.type==='all'&&!state.library)loadHomeFeeds();
	const live = state.type === 'livetv';
	const nonstop = state.type === 'nonstop';
	const dvr = state.type === 'dvr';
	$('#channelGroups').hidden = !live && !nonstop;
	$('#genreLabel').hidden=live||nonstop||dvr;
	$('#grid').classList.toggle('nonstop-grid',nonstop);
	$('#grid').hidden = live || dvr;
	$('#recordingsView').hidden = !dvr;
	$('#liveGuide').hidden = !live;
	$('#sort').closest('label').hidden = live || nonstop || dvr || state.type === 'favourites';
	$('#source').closest('label').hidden = !['all','movies','tvshows'].includes(state.type);
	$('.collection-toolbar .eyebrow').textContent = live ? 'YOUR CHANNELS · AT A GLANCE' : 'SOMETHING FOR EVERYONE';
	$('#search').placeholder = live ? 'Find a channel or programme…' : 'Find a film, show or episode…';
	$('#search').setAttribute('aria-label', live ? 'Search channels and programmes' : 'Search the collection');
	updateHomeSections();
	if (live) return loadGuide();
	if (nonstop) return loadNonstop(append);
	if (dvr) return loadRecordings();
	$('#genreLabel').hidden=!['all','movies','tvshows'].includes(state.type);
	if(state.type==='favourites'){++state.generation;const items=Object.values(readFavourites()).filter(i=>i.Name.toLowerCase().includes($('#search').value.trim().toLowerCase()));state.items=items;state.total=items.length;$('#grid').replaceChildren(...items.map(i=>card(i)));$('#collectionTitle').firstChild.textContent=favouriteHome?'Home favourites ':'Favourites ';$('#count').textContent=items.length;$('#status').hidden=items.length>0;$('#status').textContent=favouriteHome?'Save something with the star button. Shared with everyone at home.':'Save something with the star button. Your favourites follow your sign-in.';$('#loadMore').hidden=true;return;}
	const generation = ++state.generation;
	const search = $('#search').value.trim();
	updateHomeSections();
	const params = new URLSearchParams({ type: state.type, sort: $('#sort').value, start: append ? state.items.length : 0 });
	if (state.library) params.set('parent', state.library.Id);
	if (search) params.set('search', search);
	params.set('source', $('#source').value);
	params.set('genre',$('#genre').value);
	$('#status').textContent = 'Finding something good…';
	$('#status').hidden = false;
	$('#loadMore').hidden = true;
	try {
		const unified = ['all','movies','tvshows'].includes(state.type);
		const data = await api((unified ? '/api/web/items?' : '/api/items?') + params);
		if (generation !== state.generation) return;
		state.items = append ? [...state.items, ...data.items] : data.items;
		state.total = data.total;
		if(data.genres){const selected=$('#genre').value;$('#genre').replaceChildren(new Option('All categories',''),...data.genres.map(g=>new Option(g,g)));$('#genre').value=data.genres.includes(selected)?selected:'';}
		if (!append) $('#grid').replaceChildren();
		$('#grid').append(...data.items.map(item => card(item, $('#sort').value === 'release')));
		$('#count').textContent = Number(data.total).toLocaleString();
		$('#collectionTitle').firstChild.textContent = search ? 'Search results ' : state.library ? state.library.Name + ' ' : 'The collection ';
		$('#status').hidden = data.items.length > 0 || append;
		$('#status').textContent = 'Nothing found. Try a different title or library.';
		if (data.notice) { $('#status').textContent = data.notice; $('#status').hidden = false; }
		if (data.indexing) setTimeout(() => { if (generation === state.generation) void loadItems(); }, 10000);
		$('#loadMore').hidden = state.items.length >= state.total || state.type === 'livetv';
		updateHomeSections();
	} catch (error) {
		if (generation !== state.generation) return;
		$('#status').textContent = error.message;
		$('#loadMore').hidden = false;
	}
}

let nonstopData = null, nonstopPending = null, channelGroup = '';
function nonstopFavourites(){return new Set(Object.values(readFavourites()).filter(i=>i.Type==='TvChannel').map(i=>i.Id));}
function channelGroups(groups, onChange, favourites = false) {
	const host = $('#channelGroups'); host.replaceChildren();
	for (const group of ['', ...(favourites?['__favourites']:[]), ...groups]) {
		const button = element('button','chip',group==='__favourites'?'★ Favourites':group ? group.replace(/^24\s*\/\s*7\s*/i,'') : 'All');
		button.classList.toggle('active',channelGroup===group);button.setAttribute('aria-pressed',String(channelGroup===group));
		button.onclick=()=>{channelGroup=group;onChange();};host.append(button);
	}
}
async function loadNonstop(append = false) {
	const generation=++state.generation;
	$('#search').placeholder='Find a 24/7 stream…';$('#search').setAttribute('aria-label','Search 24/7 streams');
	$('.collection-toolbar .eyebrow').textContent='ALWAYS ON · JUST PRESS PLAY';
	$('#collectionTitle').firstChild.textContent='24/7 ';
	$('#status').hidden=false;$('#status').textContent='Finding your always-on favourites…';$('#loadMore').hidden=true;
	try {
		if(!nonstopData || Date.now()-nonstopData.time>60000){
			nonstopPending ||= api('/api/dispatcharr/channels').then(data=>(nonstopData={...data,time:Date.now()})).finally(()=>{nonstopPending=null;});
			await nonstopPending;
		}
		if(generation!==state.generation)return;
		channelGroups(nonstopData.groups,()=>void loadNonstop(),true);
		const favourites=nonstopFavourites();
		const term=$('#search').value.trim().toLowerCase();
		const items=nonstopData.items.filter(item=>(channelGroup==='__favourites'?favourites.has(item.Id):!channelGroup||item.Group===channelGroup)&&(`${item.Name} ${item.ChannelNumber}`).toLowerCase().includes(term));
		const start=append?state.items.length:0, batch=items.slice(start,start+60);
		state.items=append?[...state.items,...batch]:batch;
		if(!append)$('#grid').replaceChildren();
		for(const item of batch) {
			const tile=element('article','nonstop-tile'),button=element('button','nonstop-card'),picture=element('div','nonstop-art'),image=element('img');
			image.src=imageUrl(item);image.alt='';image.loading='lazy';image.decoding='async';image.onerror=()=>image.remove();
			picture.append(image,element('span','nonstop-play','▶'));
			button.append(picture,element('strong','',item.Name.replace(/^24\s*\/\s*7\s*/i,'')),element('small','',item.Group+' · '+item.ChannelNumber));
			button.setAttribute('aria-label','Play '+item.Name);button.onclick=()=>startPlayback(item,0);
			const star=element('button','nonstop-favourite');
			function updateStar(){const saved=nonstopFavourites().has(item.Id);star.textContent=saved?'★':'☆';star.classList.toggle('saved',saved);star.setAttribute('aria-pressed',String(saved));star.setAttribute('aria-label',(saved?'Remove ':'Save ')+item.Name+(saved?' from favourites':' to favourites'));star.title=saved?'Remove favourite':'Save favourite';}
			star.onclick=async()=>{star.disabled=true;try{await changeFavourite({...item,Type:'TvChannel'},!nonstopFavourites().has(item.Id));if(channelGroup==='__favourites')void loadNonstop();else updateStar();}catch(error){$('#status').hidden=false;$('#status').textContent=error.message;}finally{star.disabled=false;}};
			const share=compactAction('share','Share',`Share ${item.Name} for 24 hours`);
			share.onclick=()=>openChannelShare(item);
			updateStar();tile.append(button,star);if(canShare)tile.append(share);$('#grid').append(tile);
		}
		$('#count').textContent=items.length+(items.length===1?' stream':' streams');$('#status').hidden=items.length>0;
		$('#status').textContent=channelGroup==='__favourites'?'No favourites match. Use the star on a channel to save it on this browser.':'No matching streams. Try another group or search.';$('#loadMore').hidden=state.items.length>=items.length;
	}catch(error){if(generation===state.generation)$('#status').textContent=error.message;}
}

function guideTime(value) {
	return new Date(value).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

function guideRange(programme) {
	return `${guideTime(programme.StartDate)} – ${guideTime(programme.EndDate)}`;
}

function programmeCell(channel, programme, label, now) {
	const cell = element('div', 'guide-cell');
	cell.append(element('span', 'guide-mobile-label', label));
	if (!programme) {
		cell.append(element('span', 'guide-missing', label === 'On now' ? 'No current listing' : 'No upcoming listing'));
		return cell;
	}
	const button = element('button', 'guide-programme');
	button.append(element('strong', '', programme.Name), element('span', 'guide-time', guideRange(programme)));
	button.setAttribute('aria-label', `${channel.Name}: ${programme.Name}, ${guideRange(programme)}. Programme details`);
	button.onclick = () => showGuideDetails(channel, programme);
	cell.append(button);
	if (label === 'On now') {
		const start = Date.parse(programme.StartDate);
		const end = Date.parse(programme.EndDate);
		const progress = element('progress', 'guide-progress');
		progress.max = end - start;
		progress.value = Math.max(0, Math.min(end - start, now - start));
		progress.setAttribute('aria-label', `${Math.max(1, Math.ceil((end - now) / 60000))} minutes remaining`);
		cell.append(progress);
	}
	return cell;
}

function renderGuide() {
	if (!guideData || state.type !== 'livetv') return;
	const term = $('#search').value.trim().toLowerCase(), now = Date.now();
	const start = Math.floor(now / 1800000) * 1800000, end = start + 4 * 3600000;
	const favourites = JSON.parse(localStorage.getItem('tellybox-channels') || '[]');
	channelGroups([...new Set(guideData.channels.map(c=>c.Group).filter(Boolean))],renderGuide);
	const channels = guideData.channels.filter(channel => (!channelGroup || channel.Group===channelGroup) && (document.querySelector('#onlyFavourites')?.getAttribute('aria-pressed') !== 'true' || favourites.includes(channel.Id)) && (channel.Name + ' ' + channel.ChannelNumber + ' ' + channel.programmes.map(p => p.Name).join(' ')).toLowerCase().includes(term));
	const grid = element('div', 'timetable');
	const header = element('div', 'timetable-row timetable-header');
	header.append(element('div', 'timetable-channel', 'CHANNEL'));
	const times = element('div', 'timetable-times');
	for (let time = start; time < end; time += 1800000) times.append(element('span', '', guideTime(time)));
	header.append(times); grid.append(header);
	for (const channel of channels) {
		const row = element('div', 'timetable-row');
		const identity = element('button', 'timetable-channel');
		identity.append(element('small', '', (favourites.includes(channel.Id) ? '★ ' : '') + (channel.ChannelNumber || '')), element('strong', '', channel.Name));
		if(channel.GuideWarning) {const note=element('small','guide-warning','Check listing');note.title=channel.GuideWarning;identity.append(note);}
		identity.setAttribute('aria-label', 'Watch ' + channel.Name + ' live'); identity.onclick = () => startPlayback(channel, 0);
		const track = element('div', 'timetable-track');
		const line = element('span', 'timetable-now'); line.style.left = ((now - start) / (end - start) * 100) + '%'; track.append(line);
		let count = 0;
		for (const programme of channel.programmes) {
			const a = Math.max(start, Date.parse(programme.StartDate)), b = Math.min(end, Date.parse(programme.EndDate));
			if (!(b > a)) continue; count++;
			const cell = element('button', 'timetable-programme');
			cell.style.left = ((a - start) / (end - start) * 100) + '%'; cell.style.width = ((b - a) / (end - start) * 100) + '%';
			cell.classList.toggle('on-now', a <= now && b > now);
			cell.append(element('strong', '', programme.Name), element('small', '', guideRange(programme)));
			if (programmeRecording(channel,programme)) cell.append(element('span','recording-dot','● Recording set'));
			cell.setAttribute('aria-label', channel.Name + ': ' + programme.Name + ', ' + guideRange(programme));
			cell.onclick = () => showGuideDetails(channel, programme); track.append(cell);
		}
		if (!count) { const empty = element('button', 'timetable-empty', 'No listings · watch channel live'); empty.onclick = () => startPlayback(channel, 0); track.append(empty); }
		row.append(identity, track); grid.append(row);
	}
	$('#guideRows').replaceChildren(grid);
	$('#count').textContent = channels.length + (channels.length === 1 ? ' channel' : ' channels');
	$('#status').hidden = channels.length > 0;
	$('#status').textContent = 'No matching channels. Try All channels or another search.';
	$('#guideSummary').textContent = new Date().toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' }) + ' · Next four hours · Swipe across to look ahead';
	$('#guideFreshness').textContent=guideData.stale?'Guide refresh failed. Showing any remaining saved listings.':'Dispatcharr listings · checked '+guideTime(guideData.fetchedAt)+'. Gaps mean no listing was supplied.';
}

async function loadGuide(force = false) {
	const generation = ++state.generation;
	$('#collectionTitle').firstChild.textContent = 'Live TV ';
	$('#loadMore').hidden = true;
	if (!force && guideData && Date.now() - guideData.fetchedAt < 60000) { renderGuide(); return; }
	$('#refreshGuide').disabled = true;
	if (!guideData) { $('#status').hidden = false; $('#status').textContent = 'Loading channels and programme listings…'; }
	else $('#guideSummary').textContent = 'Updating programme listings…';
	try {
		const recorded=api('/api/recordings').catch(()=>null);
		const data=await api('/api/web/live-guide'+(force?'?refresh=1':''));
		if (generation !== state.generation) return;
		guideData = data;
		renderGuide();
		void recorded.then(result=>{if(result&&generation===state.generation){recordingData=result.items;renderGuide();}});
	} catch (error) {
		if (generation !== state.generation) return;
		$('#status').hidden = false;
		$('#status').textContent = `${error.message} Use Refresh guide to try again.`;
		$('#guideSummary').textContent = guideData ? 'Showing earlier listings · refresh failed' : 'Guide unavailable';
	} finally { $('#refreshGuide').disabled = false; }
}

function showGuideDetails(channel, selected, checked = false) {
	if(!checked)void api('/api/recordings?refresh=1').then(data=>{recordingData=data.items;if(details.open&&$('#detailsTitle')?.textContent===(selected?.Name||channel.Name))showGuideDetails(channel,selected,true);}).catch(()=>{});
	const now = Date.now();
	const programmes = channel.programmes.filter(p => Date.parse(p.EndDate) > now);
	selected ||= programmes.find(p => Date.parse(p.StartDate) <= now) || programmes[0];
	const content = element('div', 'detail-content guide-details');
	const title = element('h2', '', selected?.Name || channel.Name);
	title.id = 'detailsTitle';
	content.append(element('p', 'eyebrow', channel.Name), title);
	if(channel.GuideWarning)content.append(element('p','guide-warning',channel.GuideWarning));
	if (selected) {
		content.append(element('p', 'detail-meta', guideRange(selected)), element('p', 'overview', selected.Overview || 'No programme description is available.'));
	}
	const watch = element('button', 'button primary', '▶ Watch channel live');
	watch.onclick = () => startPlayback(channel, 0);
	const favourite = element('button', 'button secondary');
	const savedChannels = JSON.parse(localStorage.getItem('tellybox-channels') || '[]');
	favourite.textContent = savedChannels.includes(channel.Id) ? '★ Favourite channel' : '☆ Add to favourites';
	favourite.onclick = () => { const next = savedChannels.includes(channel.Id) ? savedChannels.filter(id => id !== channel.Id) : [...savedChannels, channel.Id]; localStorage.setItem('tellybox-channels', JSON.stringify(next)); showGuideDetails(channel, selected); renderGuide(); };
	content.append(favourite);
	content.append(watch, element('p', 'guide-note', 'Plays what is broadcasting now. Upcoming programmes cannot be started early.'));
	if(selected&&channel.Id.startsWith('dispatch-live-')&&Date.parse(selected.StartDate)<=now-60000&&Date.parse(selected.EndDate)>now&&!guideData?.stale){
		const restartHost=element('div','guide-restart');content.append(restartHost);
		void api('/api/catchup/restart?channel='+encodeURIComponent(channel.Id)+'&programme='+encodeURIComponent(selected.Id)).then(data=>{
			if(!data.item||!restartHost.isConnected||!details.open)return;
			const restart=element('button','button secondary','↶ Restart programme');
			restart.onclick=()=>startPlayback(data.item,0);restartHost.append(restart);
		}).catch(()=>{});
	}
	const share=compactAction('share','Share channel for 24 hours',`Share ${channel.Name} for 24 hours`);
	share.onclick=()=>showShare(channel,content);if(canShare)content.append(share);
	if(selected){
		const saved=programmeRecording(channel,selected),record=element('button','button record-button',saved?'✓ Recording set':Date.parse(selected.StartDate)<=now?'● Record from now':'● Record programme');
		record.disabled=Boolean(saved)||Boolean(guideData?.stale);
		const status=element('p','guide-note');status.setAttribute('role','status');
		status.textContent=saved?(saved.Playable?'Your recording is ready to watch.':saved.State==='scheduled'?'Scheduled in Dispatcharr.':'Recording now. Playback is available when saving finishes.'):Date.parse(selected.StartDate)<=now?'Saves the rest of this programme; earlier scenes cannot be recovered.':'Uses the programme times and your recording padding settings in Dispatcharr.';
		record.onclick=async()=>{
			record.disabled=true;status.textContent='Sending to Dispatcharr…';
			try{const result=await api('/api/recordings',{channelId:channel.Id,programmeId:selected.Id});recordingData=[...recordingData.filter(r=>r.Id!==result.item.Id),result.item];record.textContent='✓ Recording set';status.textContent=result.existing?'This programme was already scheduled.':'Recording set. Find it in Recordings.';renderGuide();}
			catch(error){status.textContent=error.message;record.disabled=false;}
		};
		const view=element('button','button quiet','View recordings');view.onclick=()=>{details.close();selectLibrary('dispatch-recordings');};
		if(saved?.Playable){const play=element('button','button primary','▶ Play recording');play.onclick=()=>startPlayback(saved,0);content.append(play);}else content.append(record);
		content.append(view,status);
	}
	content.append(element('h3', 'guide-schedule-title', 'Coming up on this channel'));
	if (!programmes.length) content.append(element('p', 'overview', 'No programme listings are available for the next 24 hours. You can still watch this channel live.'));
	const schedule = element('div', 'guide-schedule');
	for (const programme of programmes) {
		const button = element('button', 'guide-schedule-item');
		button.classList.toggle('selected', programme === selected);
		button.append(element('span', 'guide-time', guideRange(programme)), element('strong', '', programme.Name));
		if (Date.parse(programme.StartDate) <= now) button.append(element('span', 'guide-live', 'ON NOW'));
		button.onclick = () => showGuideDetails(channel, programme);
		schedule.append(button);
	}
	content.append(schedule);
	$('#detailsBody').replaceChildren(content);
	if (!details.open) details.showModal();
}

$('#refreshGuide').onclick = () => loadGuide(true);
function programmeRecording(channel,programme){
	return recordingData.find(r=>channel.Id==='dispatch-live-'+r.ChannelUuid&&!['failed','cancelled'].includes(r.State)&&Date.parse(r.ProgrammeStart)===Date.parse(programme.StartDate)&&Date.parse(r.ProgrammeEnd)===Date.parse(programme.EndDate));
}
async function loadRecordings(force=false){
	const generation=++state.generation;
	$('#collectionTitle').firstChild.textContent='Recordings ';$('#count').textContent='';$('#loadMore').hidden=true;
	$('#search').placeholder='Find a recording or channel…';
	$('#status').hidden=false;$('#status').textContent='Checking your recordings…';$('#refreshRecordings').disabled=true;
	try{const data=await api('/api/recordings'+(force?'?refresh=1':''));if(generation!==state.generation)return;recordingData=data.items;renderRecordings();}
	catch(error){if(generation===state.generation){$('#status').hidden=false;$('#status').textContent=error.message;}}
	finally{$('#refreshRecordings').disabled=false;}
}
function renderRecordings(){
	if(state.type!=='dvr')return;
	const term=$('#search').value.trim().toLowerCase();
	const items=recordingData.filter(r=>(recordingFilter==='all'||r.State===recordingFilter||recordingFilter==='recording'&&r.State==='starting')&&(r.Name+' '+r.ChannelName).toLowerCase().includes(term));
	const order={recording:0,starting:0,scheduled:1,processing:2,completed:3,failed:4,cancelled:5};
	items.sort((a,b)=>order[a.State]-order[b.State]||(a.State==='scheduled'?Date.parse(a.StartDate)-Date.parse(b.StartDate):Date.parse(b.StartDate)-Date.parse(a.StartDate)));
	$('#count').textContent=items.length;$('#status').hidden=items.length>0;$('#status').textContent='No recordings here yet. Choose a programme in Live TV and select Record programme.';
	const list=$('#recordingsList');list.replaceChildren();
	for(const item of items){
		const row=element('article','recording-card'),body=element('div','recording-body'),actions=element('div','recording-actions');
		const image=element('img','recording-art');image.src=imageUrl(item);image.alt='';image.loading='lazy';image.onerror=()=>{image.hidden=true;};
		const labels={completed:item.Playable?'Ready to watch':'File unavailable',scheduled:'Scheduled',recording:'Recording now',starting:'Starting shortly',processing:'Finishing up',failed:'Recording failed',cancelled:'Cancelled'};
		body.append(element('span','recording-state state-'+item.State,labels[item.State]),element('h3','',item.Name));
		const date=new Date(item.StartDate).toLocaleDateString(undefined,{weekday:'short',day:'numeric',month:'short'});
		body.append(element('p','detail-meta',`${item.ChannelName} · ${date} · ${guideTime(item.StartDate)}–${guideTime(item.EndDate)}`));
		if(item.Overview)body.append(element('p','recording-description',item.Overview));
		if(item.Playable){const play=element('button','button primary',getProgress(item.Id)>30?'▶ Resume recording':'▶ Play recording');play.onclick=()=>startPlayback(item,getProgress(item.Id));actions.append(play);}
		else if(item.State==='recording'||item.State==='processing'||item.State==='starting')body.append(element('p','guide-note','Ready to watch once Dispatcharr finishes saving it.'));
		else if(item.State==='failed')body.append(element('p','guide-note','Dispatcharr could not complete this recording. Check its DVR page for details.'));
		if(item.CanCancel){const cancel=element('button','button quiet','Cancel recording');cancel.onclick=async()=>{cancel.disabled=true;try{await api('/api/recordings/'+item.Id+'/cancel',{});await loadRecordings(true);}catch(error){cancel.disabled=false;body.append(element('p','guide-note',error.message));}};actions.append(cancel);}
		row.append(image,body,actions);list.append(row);
		void recordingDeleteButton(item,actions,()=>loadRecordings(true));
	}
}
$('#refreshRecordings').onclick=()=>loadRecordings(true);
$('#recordingFilters').onclick=event=>{const button=event.target.closest('[data-recording-filter]');if(!button)return;recordingFilter=button.dataset.recordingFilter;for(const node of $('#recordingFilters').querySelectorAll('button')){node.classList.toggle('active',node===button);node.setAttribute('aria-pressed',String(node===button));}renderRecordings();};
setInterval(()=>{if(state.type==='dvr'&&!document.hidden&&!player.open&&!details.open&&!$('#recordingsList').contains(document.activeElement))void loadRecordings(true);},20000);
$('#onlyFavourites').onclick = event => { const button = event.currentTarget; const on = button.getAttribute('aria-pressed') !== 'true'; button.setAttribute('aria-pressed', String(on)); button.textContent = on ? '★ Favourites' : '☆ All channels'; renderGuide(); };
const autoplayPreference = document.querySelector('#autoNext');
autoplayPreference.checked = localStorage.getItem('tellybox-autoplay') === 'true';
autoplayPreference.onchange = () => localStorage.setItem('tellybox-autoplay', String(autoplayPreference.checked));
const subtitlePreference = document.querySelector('#defaultEnglish');
subtitlePreference.checked = localStorage.getItem('tellybox-english') === 'true';
subtitlePreference.onchange = () => localStorage.setItem('tellybox-english', String(subtitlePreference.checked));
setInterval(() => {
	if (state.type === 'livetv' && !document.hidden && !details.open && !player.open && !$('#liveGuide').contains(document.activeElement)) void loadGuide();
}, 60000);

function selectLibrary(id) {
	channelGroup='';
	$('#channelGroups').replaceChildren();$('#count').textContent='';
	state.library = state.libraries.find(item => item.Id === id) || null;
	state.type = state.library ? state.library.CollectionType || 'recordings' : 'all';
	const address=new URL(location.href);
	if(['livetv','nonstop','dvr'].includes(state.type))address.searchParams.set('view',state.type==='dvr'?'recordings':state.type);else address.searchParams.delete('view');
	history.replaceState(null,'',address);
	$('#search').value = '';
	$('#filters').hidden = Boolean(state.library);
	for (const node of document.querySelectorAll('[data-library]')) node.classList.toggle('active', node.dataset.library === (id || 'home'));
	for (const node of document.querySelectorAll('[data-type]')) node.classList.toggle('active', node.dataset.type === state.type);
	void loadItems();
}

async function showDetails(id) {
	$('#detailsBody').replaceChildren(element('p', 'detail-content', 'Loading details…'));
	if (!details.open) details.showModal();
	try {
		const item = await api('/api/web/items/' + id);
		if (!details.open) return;
		const art = element('img', 'detail-art');
		art.src = imageUrl(item, true, 1200);
		art.alt = '';
		art.onerror = () => { art.hidden = true; };
		const content = element('div', 'detail-content');
		const title = element('h2', '', item.Name);
		title.id = 'detailsTitle';
		content.append(element('p', 'eyebrow', friendlyType(item).toUpperCase()), title, element('p', 'detail-meta', meta(item)));
		if (['Movie', 'Series'].includes(item.Type)) content.append(jserverUI.ratings(item.Ratings, { links: true }));
		if (item.Genres?.length) content.append(element('p', 'detail-meta', item.Genres.join(' · ')));
		content.append(element('p', 'overview', item.Overview || item.CurrentProgram?.Overview || 'Ready when you are.'));
		if (item.Source === 'streamed') content.append(element('p', 'source-note', 'Streamed · ' + (item.Provider || 'Dispatcharr')));
		if (['Movie', 'Series', 'Episode'].includes(item.Type)) { content.append(TellyboxTaste.controls(item));const favouriteItem=favouriteTitle(item);const favourite=element('button','button secondary');const update=()=>{const saved=Boolean(readFavourites()[favouriteItem.Id]);favourite.textContent=saved?'★ In favourites':'☆ Add to favourites';favourite.setAttribute('aria-pressed',String(saved));};update();favourite.onclick=async()=>{favourite.disabled=true;try{await changeFavourite(favouriteItem,!readFavourites()[favouriteItem.Id]);update();}catch(error){favourite.textContent=error.message;}finally{favourite.disabled=false;}};content.append(favourite); }
		$('#detailsBody').replaceChildren(art, content);
		if(item.Source!=='streamed'&&['Movie','Episode','Video'].includes(item.Type))void recordingDeleteButton(item,content,()=>{details.close();selectLibrary(state.library?.Id);});
		const localRequest = await import('/local-request.mjs');
		if (!content.isConnected) return;
		if (localRequest.canRequestLocal(item)) {
			const request = element('button', 'button secondary', localRequest.localRequestLabel);
			request.onclick = async () => {
				request.disabled = true;
				try {
					const parent = item.Type === 'Episode' && item.SeriesId ? await api('/api/web/items/' + encodeURIComponent(item.SeriesId)) : item;
					location.assign(localRequest.localRequestUrl(item, parent));
				} catch { request.textContent = 'Could not open request · try again'; request.disabled = false; }
			};
			content.append(request);
		}
		if (['Series', 'Season', 'MusicAlbum', 'BoxSet', 'Folder'].includes(item.Type)) {
			const list = element('div', 'episode-list');
			if (item.Type === 'Series') {
				list.textContent = 'Finding episodes…'; content.append(list);
				const data = await api(`/api/web/items/${id}/episodes`);
				if (!content.isConnected) return;
				void seriesContinue(item, content, data.items);
				if (canShare && item.Source !== 'streamed') {
					const share = element('button', 'button secondary', item.VodIds?.length ? 'Share local episodes' : 'Share this series');
					share.onclick = () => showShare(item, content); content.append(share);
				}
				if (data.notice) content.append(element('p', 'source-note', data.notice));
				const localCount=data.items.filter(e=>e.Source!=='streamed').length,streamedCount=data.items.length-localCount;
				if(localCount&&streamedCount)content.append(element('p','series-sources',`${localCount} episodes on your server · ${streamedCount} streamed. Local copies play first.`));
				const selector = element('section', 'season-selector');
				const heading = element('h3', '', 'Choose a season');
				const tabs = element('div', 'season-tabs'); tabs.setAttribute('role', 'group'); tabs.setAttribute('aria-label', 'Season');
				const seasons = [...new Set(data.items.map(e => e.ParentIndexNumber).filter(n => Number.isInteger(n) && n >= 0))].sort((a,b) => a-b);
				const buttons = [];
				const choose = season => {
					for (const [value, button] of buttons) button.setAttribute('aria-pressed', String(value === season));
					heading.textContent = season === 0 ? 'Specials' : 'Season ' + season;
					renderEpisodes(data.items.filter(e => e.ParentIndexNumber === season), list);
				};
				for (const season of seasons) {
					const button = element('button', 'season-tab', season === 0 ? 'Specials' : 'Season ' + season);
					const count = data.items.filter(e => e.ParentIndexNumber === season).length;
					button.append(element('small', '', count + ' episodes'));
					button.onclick = () => choose(season); tabs.append(button); buttons.push([season, button]);
				}
				selector.append(heading, tabs); content.append(selector, list);
				if (seasons.length) choose(seasons.find(s => s > 0) ?? seasons[0]);
				else list.textContent = 'No episodes available yet.';
			} else { const children = await api(`/api/items/${id}/children?type=${item.Type}`); content.append(list); renderEpisodes(children, list); }
		} else {
			const saved = getProgress(id);
			const play = element('button', 'button primary', saved > 30 ? `▶  Resume at ${Math.floor(saved / 60)} min` : item.Type === 'TvChannel' ? '▶  Watch live' : '▶  Play');
			play.onclick = () => startPlayback(item, saved);
			content.append(play);
			if (canShare && ['Movie', 'Episode'].includes(item.Type) && item.Source !== 'streamed') {
				const share = element('button', 'button secondary share-button', 'Share this title');
				share.onclick = () => showShare(item, content);
				content.append(share);
			}
			if (saved > 30) {
				const restart = compactAction('refresh','Play from beginning','Play from beginning');
				restart.onclick = () => startPlayback(item, 0);
				content.append(document.createTextNode(' '), restart);
			}
		}
	} catch (error) { $('#detailsBody').replaceChildren(element('p', 'detail-content', error.message)); }
}

async function loadEpisodes(id, list) {
	list.dataset.season = id;
	list.textContent = 'Loading episodes…';
	try { const items = await api(`/api/items/${id}/children`); if (list.dataset.season === id) renderEpisodes(items, list); }
	catch (error) { list.textContent = error.message; }
}

function compactAction(kind,label,description=label) {
	const button=element('button','compact-action');button.type='button';button.setAttribute('aria-label',description);button.title=description;
	const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('aria-hidden','true');
	const path=document.createElementNS(svg.namespaceURI,'path');
	path.setAttribute('d',kind==='refresh'?'M3 10a9 9 0 1 1 2 8M3 3v7h7':kind==='download'?'M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5':'M8 11l8-5M8 13l8 5M8 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0M22 4a3 3 0 1 1-6 0 3 3 0 0 1 6 0M22 20a3 3 0 1 1-6 0 3 3 0 0 1 6 0');
	svg.append(path);button.append(svg,element('span','',label));return button;
}
async function recordingDeleteButton(item,parent,refresh){
	try{
		const info=await api('/api/recording-files/'+encodeURIComponent(item.Id));
		if(!parent.isConnected||!info.IsRecording)return;
		const button=compactAction('delete','Delete recording');
		button.querySelector('path').setAttribute('d','M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7');
		button.onclick=async()=>{
			button.disabled=true;
			try{
				const fresh=await api('/api/recording-files/'+encodeURIComponent(item.Id));
				if(!fresh.CanDelete){alert(fresh.reason||'This recording cannot be deleted.');return;}
				const dialog=element('dialog','recording-delete-dialog'),content=element('div','detail-content');
				const title=element('h2','','Delete recording?');title.id='deleteRecordingTitle';dialog.setAttribute('aria-labelledby',title.id);
				content.append(title,element('p','',fresh.Name),element('p','source-note','This permanently removes the saved recording and frees its disk space. It cannot be undone.'));
				const actions=element('div','recording-actions'),cancel=element('button','button secondary','Keep recording'),remove=element('button','button primary','Delete recording'),status=element('p','guide-note');status.setAttribute('role','status');
				cancel.onclick=()=>dialog.close();
				remove.onclick=async()=>{remove.disabled=true;cancel.disabled=true;status.textContent='Deleting recording…';try{await api('/api/recording-files/'+encodeURIComponent(item.Id)+'/delete',{confirm:true});dialog.close();await refresh();}catch(error){status.textContent=error.message;remove.disabled=false;cancel.disabled=false;}};
				dialog.onclose=()=>dialog.remove();actions.append(cancel,remove);content.append(actions,status);dialog.append(content);document.body.append(dialog);dialog.showModal();cancel.focus();
			}catch(error){alert(error.message);}finally{button.disabled=false;}
		};parent.append(button);
	}catch{/* No deletion control for remote viewers or unavailable sources. */}
}
function openChannelShare(item) {
	details.showModal();const content=element('div','detail-content');const title=element('h2','',item.Name);title.id='detailsTitle';
	content.append(title);$('#detailsBody').replaceChildren(content);void showShare(item,content);
}
function episodeRelease(item) {
	const value=String(item.PremiereDate||'').slice(0,10);
	if(!/^\d{4}-\d{2}-\d{2}$/.test(value))return '';
	const date=new Date(value+'T00:00:00Z');
	return Number.isFinite(date.getTime())?'Aired '+date.toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric',timeZone:'UTC'}):'';
}
function renderEpisodes(items, list) {
	list.replaceChildren();
	for (const item of items) {
		const button = element('button', 'episode');
		const thumbnail = element('img', 'episode-thumb');
		thumbnail.src = imageUrl(item, false, 360);
		thumbnail.alt = ''; thumbnail.loading = 'lazy'; thumbnail.onerror = () => { thumbnail.style.visibility = 'hidden'; };
		const text = element('span', 'episode-text');
		const progress = getProgress(item.Id);
		text.append(element('span', 'episode-kicker', `${item.IndexNumber ? 'EPISODE ' + item.IndexNumber + ' · ' : ''}${minutes(item.RunTimeTicks)}`), element('span', 'episode-title', item.Name), element('span','episode-release',episodeRelease(item)), element('span', 'episode-overview', item.Overview || 'Ready to watch.'), element('span', 'episode-action', progress > 30 ? `Continue · ${Math.floor(progress / 60)} min in` : '▶ Play episode'));
		button.append(thumbnail, text);
		button.setAttribute('aria-label', `${progress > 30 ? 'Continue' : 'Play'} ${item.Name}`);
		button.onclick = () => ['Season', 'Series', 'Folder', 'MusicAlbum'].includes(item.Type) ? showDetails(item.Id) : startPlayback(item, getProgress(item.Id));
		if (item.Type === 'Episode') {
			const row = element('article', 'episode-share-row');
			const actions = element('div', 'episode-actions');
			actions.append(element('span','episode-source',item.Source==='streamed'?'Streamed · '+(item.Provider||'Dispatcharr'):'On your server'));
			if(progress>30){const restart=compactAction('refresh','Play from beginning','Play from beginning');restart.onclick=()=>startPlayback(item,0);actions.append(restart);}
			if(item.Source !== 'streamed') {
			const share = compactAction('share','Share',`Share ${item.Name} for 24 hours`);
			share.onclick = () => showShare(item, row);
			const download = compactAction('download','Download',`Download ${item.Name}`);
			download.onclick = () => showEpisodeDownload(item, row);
			if(canShare)actions.append(share);actions.append(download);
			}
			row.append(button, actions);
			list.append(row);
		} else list.append(button);
	}
	if (!items.length) list.textContent = 'No playable items available yet.';
}

async function showEpisodeDownload(item, parent) {
	parent.querySelector('.share-panel')?.remove();
	const panel = element('section', 'share-panel episode-download-panel');
	const heading = element('h3', '', 'Download ' + item.Name);
	const message = element('p', 'share-message', 'Checking the download…'); message.setAttribute('role', 'status');
	const close = element('button', 'button quiet', 'Close'); close.onclick = () => panel.remove();
	panel.append(heading, message, close); parent.append(panel); heading.tabIndex = -1; heading.focus();
	try {
		const data = await api('/api/episode-downloads/' + item.Id + '/info');
		if (!panel.isConnected) return;
		const formatSize = bytes => !bytes ? 'Size unavailable' : bytes >= 1e9 ? (bytes / 1e9).toFixed(1) + ' GB' : Math.round(bytes / 1e6) + ' MB';
		message.textContent = 'Choose a copy to take with you';
		const choices = element('div', 'download-qualities'); choices.setAttribute('role', 'group'); choices.setAttribute('aria-label', 'Download quality');
		const note = element('p', 'download-note');
		const save = element('a', 'button primary', 'Download episode'); save.download = '';
		const options = data.options || [{ id:'original', label:'Original', container:data.container, bytes:data.bytes }];
		const select = option => {
			for (const button of choices.children) { const active = button.dataset.quality === option.id; button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active)); }
			save.href = data.url + '?quality=' + encodeURIComponent(option.id);
			save.textContent = 'Download · ' + formatSize(option.bytes);
			note.textContent = option.estimated ? 'Estimated size. An MP4 copy is prepared as it downloads; actual size varies. ' + (data.bytes < option.bytes ? 'The original is already smaller than this estimate. ' : '') + 'Restart if interrupted. Subtitles are not included in this web copy.' : 'Original file, exact size. Use a player that supports ' + data.container.toUpperCase() + '. Separate subtitles are not included.';
		};
		for (const option of options) {
			const button = element('button', 'download-quality'); button.dataset.quality = option.id;
			button.append(element('strong', '', option.label), element('span', '', (option.estimated ? '≈ ' : '') + formatSize(option.bytes)), element('small', '', option.bitrate ? option.bitrate / 1e6 + ' Mbps · MP4' : option.container.toUpperCase() + ' · original'));
			button.onclick = () => select(option); choices.append(button);
		}
		let checking = false, ready = false;
		save.onclick = async event => {
			if (ready) { ready = false; return; }
			event.preventDefault();
			if (checking) return;
			checking = true;
			try {
				await api('/api/downloads/status');
				message.textContent = 'Download requested. Check your browser’s downloads for progress or errors.';
				ready = true; save.click();
			} catch (error) { message.textContent = error.message; }
			finally { checking = false; }
		};
		panel.insertBefore(choices, close); panel.insertBefore(note, close); panel.insertBefore(save, close); const balanced = options.find(o => o.id === 'balanced');
		select(balanced && balanced.bytes && balanced.bytes < data.bytes ? balanced : options.find(o => o.id === 'original') || options[0]);
	} catch (error) { message.textContent = error.message; }
}

async function showShare(item, parent) {
	try { canShare=Boolean((await api('/api/capabilities')).canShare); } catch { canShare=false; }
	if(!canShare) { alert('Sharing is available to administrators or at home.'); return; }
	parent.querySelector('.share-panel')?.remove();
	const panel = element('section', 'share-panel');
	const heading = element('h3', '', 'Share ' + item.Name);
	const channel=item.Type==='TvChannel';
	const note = element('p', '', channel?'Anyone with the link can watch this channel live for 24 hours, without signing in. It follows the channel as programmes change; it is not a recording.':'Anyone with the link can watch this ' + (item.Type === 'Series' ? 'whole series' : 'video') + ' without signing in until it expires.');
	const message = element('p', 'share-message');
	message.setAttribute('role', 'status');
	const duration = element('select', 'share-duration'); duration.setAttribute('aria-label', 'Sharing period');
	for (const [hours, label] of (channel?[[24,'24 hours']]:[[24, '1 day'], [72, '3 days'], [168, '7 days'], [720, '30 days']])) duration.add(new Option(label, hours));
	const create = element('button', 'button primary', 'Create viewing link');
	const close = element('button', 'button quiet', 'Close');
	close.onclick = () => panel.remove();
	const links = element('div', 'share-links');
	panel.append(heading, note, duration, create, close, message, links);
	parent.append(panel);
	heading.tabIndex = -1; heading.focus();
	async function refresh() {
		const data = await api('/api/shares/' + item.Id);
		links.replaceChildren();
		for (const entry of data.shares) {
			const row = element('div', 'share-entry');
			const expiry = element('span', '', 'Link expires ' + new Date(entry.expires).toLocaleString());
			const revoke = element('button', 'button secondary', 'Stop sharing');
			revoke.onclick = async () => {
				revoke.disabled = true;
				try {
					await api('/api/shares/' + entry.id + '/revoke', {});
					panel.querySelector(`[data-share-id="${entry.id}"]`)?.remove();
					message.textContent = 'Link stopped. It can no longer be used.';
					await refresh();
				} catch (error) { message.textContent = error.message; revoke.disabled = false; }
			};
			row.append(expiry, revoke); links.append(row);
		}
	}
	create.onclick = async () => {
		create.disabled = true;
		try {
			const data = await api('/api/shares', { id: item.Id, hours: Number(duration.value) });
			const result = element('div', 'share-result'); result.dataset.shareId = data.id;
			const input = element('input', 'share-url'); input.type = 'text'; input.readOnly = true; input.value = data.url;
			input.setAttribute('aria-label', 'Temporary viewing link'); input.onclick = () => input.select();
			const copy = element('button', 'button secondary', 'Copy link');
			copy.onclick = async () => {
				try { await navigator.clipboard.writeText(data.url); message.textContent = 'Link copied. Ready to send.'; }
				catch {
					input.focus(); input.select();
					let copied = false;
					try { copied = document.execCommand('copy'); } catch {}
					message.textContent = copied ? 'Link copied. Ready to send.' : 'Select and copy the highlighted link.';
				}
			};
			result.append(input, copy); panel.insertBefore(result, links);
			message.textContent = 'Ready to share. Expires ' + new Date(data.expires).toLocaleString() + '.';
			await refresh();
		} catch (error) { message.textContent = error.message; }
		finally { create.disabled = false; }
	};
	try { await refresh(); } catch (error) { message.textContent = error.message; }
}

function getProgress(id) {
	try { return localStorage.getItem('tellybox-watched-' + id) === 'true' ? 0 : Number(localStorage.getItem('jimbo-progress-' + id)) || 0; } catch { return 0; }
}

function beginViewing() {
	if (viewingStarted || !state.playing || state.playing.Type === 'TvChannel') return;
	viewingStarted = true;
	try {
		if (localStorage.getItem('tellybox-watched-' + state.playing.Id) === 'true') {
			localStorage.setItem('jimbo-progress-' + state.playing.Id, '0');
			localStorage.removeItem('tellybox-watched-' + state.playing.Id);
		}
	} catch {}
}

function saveProgress() {
	if (!state.playing || state.live || state.playing.Type === 'TvChannel') return;
	const position = playbackPosition();
	let duration = casting.active ? casting.remote.duration : video.duration;
	let finished=(!casting.active && video.ended) || duration > 0 && position >= Math.max(duration * .95, duration - 90);
	if(state.playing.Type==='Catchup'){
		duration=(Date.parse(state.playing.EndDate)-Date.parse(state.playing.StartDate))/1000;
		finished=Number.isFinite(duration)&&duration>0&&Date.parse(state.playing.EndDate)<=Date.now()&&position>=duration-1.5;
	}
	try {
		if (localStorage.getItem('tellybox-watched-' + state.playing.Id) === 'true') return;
		if (state.playing.SeriesId) localStorage.setItem('tellybox-series-' + state.playing.SeriesId, state.playing.Id);
		if (finished) localStorage.setItem('tellybox-watched-' + state.playing.Id, 'true');
		if(position>0)localStorage.setItem('jimbo-progress-' + state.playing.Id, finished ? '0' : String(Math.floor(position))); } catch {}
}

function resetViewingState() {
	viewingWarningShown = false;
	viewingBlocked = false;
	$('#viewingBlocked').hidden = true;
	$('#viewingNotice').hidden = true;
	$('#viewingBlockedMessage').textContent = '';
}

function playbackContextCurrent({ generation, session }) {
	return generation === playGeneration && state.session === session && player.open;
}

async function queryViewingStatus() {
	try { return await api('/api/viewing-status'); } catch { return null; }
}

function showViewingBlocked(message, generation = playGeneration) {
	if (generation !== playGeneration || !player.open) return;
	const reason = message || 'Remote viewing is unavailable for this account.';
	if (viewingBlocked) { $('#viewingBlockedMessage').textContent = reason; return; }
	viewingBlocked = true;
	const session = state.session, sessionBase = state.sessionBase;
	state.session = null; state.sessionBase = '';
	if (session) void fetch(new URL('/api/sessions/' + session, sessionBase || location.origin), {
		method: 'POST', keepalive: true, credentials: sessionBase ? 'omit' : 'same-origin',
		headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'stop', position: 0 })
	}).catch(() => {});
	if (casting.active || casting.pendingTarget) {
		try { (casting.pendingTarget || casting.context?.getCurrentSession())?.endSession(true); } catch {}
		casting.active = false; casting.pendingTarget = null;
	}
	if (state.hls) { state.hls.destroy(); state.hls = null; }
	setLiveMode(false);
	video.pause();
	video.removeAttribute('src');
	video.load();
	playerLoading(false);
	$('#viewingNotice').hidden = true;
	$('#viewingBlockedMessage').textContent = reason;
	$('#viewingBlocked').hidden = false;
	$('#playerStatus').textContent = '';
	for (const id of ['quality', 'audioTrack', 'subtitleTrack', 'retryPlayer']) $('#' + id).disabled = true;
	$('#castButton').disabled = true;
	$('#viewingBlockedBack').focus();
}

async function checkViewingStatus({ quiet = false } = {}) {
	if (viewingBlocked || !state.playing || !state.session || !player.open) return null;
	const generation = playGeneration, session = state.session;
	const data = await queryViewingStatus();
	if (!data || !playbackContextCurrent({ generation, session })) return null;
	if (data.blocked) { showViewingBlocked(data.message, generation); return data; }
	if (!quiet && !viewingWarningShown && Number.isFinite(data.remainingSeconds) && data.remainingSeconds > 0 && data.remainingSeconds <= 300) {
		viewingWarningShown = true;
		const mins = Math.max(1, Math.ceil(data.remainingSeconds / 60));
		const reset = data.resetAt ? ' Resets ' + new Date(data.resetAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + '.' : '';
		const left = data.remainingSeconds < 60 ? 'Less than a minute of remote viewing time left.' : `About ${mins} minutes of remote viewing time left.`;
		$('#viewingNotice').textContent = left + reset;
		$('#viewingNotice').hidden = false;
	}
	return data;
}

function heartbeatBody(action) {
	return { action, position: playbackPosition(), paused: state.live ? false : casting.active ? casting.remote.isPaused : video.paused, buffering: !casting.active && video.readyState < 3, rate: casting.active ? 1 : video.playbackRate, muted: casting.active ? casting.remote.isMuted : video.muted };
}

async function sendHeartbeat(action, session, base, timeout) {
	try {
		await api('/api/sessions/' + session, heartbeatBody(action), base, timeout);
		return { error: null };
	} catch (error) {
		return { error };
	}
}

async function report(action) {
	const session = state.session;
	if (!session) return;
	const generation = playGeneration, sessionBase = state.sessionBase;
	const { error } = await sendHeartbeat(action, session, sessionBase);
	if (!error) return;
	if (action === 'stop' || viewingBlocked) return;
	if (!playbackContextCurrent({ generation, session })) return;
	if (error.code === 'VIEWING_LIMIT' || error.code === 'SESSION_LIMIT') {
		const data = await queryViewingStatus();
		if (!playbackContextCurrent({ generation, session })) return;
		showViewingBlocked(data?.message || error.message, generation);
	} else void checkViewingStatus({ quiet: true });
}

let nextEpisode = null, nextTimer = null, lastChannel = null, previousChannel = null;
let nextResult = null, nextCancelled = false, nextBusy = false, segments = [], skipSegment = null;
function cancelNext() { clearInterval(nextTimer); nextTimer = null; }
async function loadNext(generation) {
	try {
		const result = await api(`/api/web/items/${state.playing.Id}/next?series=${encodeURIComponent(state.playing.SeriesId || '')}`);
		if (generation !== playGeneration) return;
		nextResult = result; nextEpisode = result.item;
	} catch { if (generation === playGeneration) nextResult = { status: 'error', message: 'Could not check the next episode.' }; }
	if (generation === playGeneration && video.ended) showNext();
}
function showNext(ended = video.ended) {
	if (state.playing?.Type !== 'Episode' || casting.active || !player.open) return;
	cancelNext();
	const host = $('#upNext'); host.replaceChildren(); host.hidden = false; host.classList.toggle('episode-ended',Boolean(nextResult && !nextEpisode));
	if (!nextResult) { host.append(element('strong', '', 'Checking what’s next…')); return; }
	if (!nextEpisode) {
		const summary=element('div','episode-end-summary');
		summary.append(element('span','eyebrow','EPISODE FINISHED'),element('h2','',state.playing.SeriesName||nextResult.seriesName||'Your series'));
		if(Number.isInteger(state.playing.ParentIndexNumber)&&Number.isInteger(state.playing.IndexNumber))summary.append(element('p','muted',`Season ${state.playing.ParentIndexNumber} · Episode ${state.playing.IndexNumber}`));
		summary.append(element('p','muted',state.playing.Name));
		const copy=nextResult.status==='complete'?['Series complete','You’ve reached the final episode of this series.']:nextResult.status==='caught-up'?['You’re up to date','You’ve reached the latest available episode. Check back for more.']:['error','unknown'].includes(nextResult.status)?['Couldn’t check what’s next','We couldn’t confirm the next episode. Try again or browse the series.']:['That’s all for now','The next episode isn’t available to watch here yet.'];
		summary.append(element('h3','',copy[0]),element('p','muted',copy[1]));
		const back=element('button','button primary','Back to series');
		back.onclick=()=>{const series=nextResult.seriesId||state.playing.SeriesId;closePlayer();if(series)void showDetails(series);};summary.append(back);
		if (nextResult.status === 'error' || nextResult.status === 'unknown') {
			const retry = element('button', 'button secondary', 'Try again'); retry.onclick = () => { nextResult = null; showNext(); void loadNext(playGeneration); }; summary.append(retry);
		}
		host.append(summary);
		const suggestions=(nextResult.suggestions||[]).slice(0,3);
		if(suggestions.length){
			const more=element('section','episode-end-more'),cards=element('div','episode-end-cards');
			more.append(element('h3','','More to explore'),element('p','muted',nextResult.suggestionGenre?'More in '+nextResult.suggestionGenre:'Choose a show to see its episodes.'));
			for (const item of suggestions) {
				const button=element('button','episode-end-card'),image=element('img');image.src=imageUrl(item);image.alt='';image.onerror=()=>{image.style.visibility='hidden';};
				button.setAttribute('aria-label','View series: '+item.Name);button.append(image,element('span','episode-end-name',item.Name),element('small','','View series'));
				button.onclick=()=>{closePlayer();void showDetails(item.Id);};cards.append(button);
			}
			more.append(cards);host.append(more);
		}
		back.focus();return;
	}
	const next = nextEpisode;
	const preview=element('div','next-preview'),art=element('img');art.src=imageUrl(next);art.alt='';art.onerror=()=>art.hidden=true;
	const copy=element('div');copy.append(element('small','eyebrow',['UP NEXT',episodeNumber(next)].filter(Boolean).join(' · ')),element('strong','',next.Name));preview.append(art,copy);
	const play = element('button', 'button primary', 'Play now');
	play.onclick = async () => {
		if (nextBusy) return; nextBusy = true; cancelNext(); play.disabled = true;
		try { await startPlayback(next, getProgress(next.Id), true); }
		finally { nextBusy = false; play.disabled = false; }
	};
	const cancel = element('button', 'button secondary', 'Not now');
	cancel.onclick = () => { nextCancelled = true; cancelNext(); host.hidden = true; };
	const actions=element('div','next-actions');actions.append(play,cancel);host.append(preview,actions);
	if (!ended || nextCancelled || !autoplayPreference.checked || document.hidden) return;
	let remaining = 10;
	const countdown=element('span','','Starts in 10 seconds'),progress=document.createElement('progress');progress.max=10;progress.value=10;progress.setAttribute('aria-label','Time until next episode');copy.append(countdown);host.append(progress);
	nextTimer = setInterval(() => {
		if (document.hidden || !player.open || !video.ended) { cancel.click(); return; }
		remaining--; countdown.textContent = `Starts in ${remaining} seconds`;progress.value=remaining;
		if (remaining <= 0) void play.onclick();
	}, 1000);
}
video.addEventListener('timeupdate', () => {
	const position = video.currentTime;
	skipSegment = segments.find(s => s.type !== 'Outro' && position >= s.start && position < s.end);
	$('#skipIntro').hidden = !skipSegment || casting.active;
	if (skipSegment) $('#skipIntro').textContent = skipSegment.type === 'Recap' ? 'Skip recap' : 'Skip intro';
	if (!nextCancelled && nextEpisode && !video.paused && Number.isFinite(video.duration) && video.duration - position <= 20 && video.duration - position > 0 && $('#upNext').hidden) showNext(false);
	if (Number.isFinite(video.duration) && video.duration - position > 25 && !video.ended) { cancelNext(); $('#upNext').hidden = true; }
});
$('#skipIntro').onclick = () => { if (skipSegment) video.currentTime = skipSegment.end; };
async function seriesContinue(item, content, episodes) {
	try {
		const items = episodes || (await api(`/api/web/items/${item.Id}/episodes`)).items;
		const last = localStorage.getItem('tellybox-series-' + item.Id);
		const current = items.findIndex(episode => episode.Id === last);
		const watched = id => localStorage.getItem('tellybox-watched-' + id) === 'true';
		const target = current >= 0 && getProgress(last) > 10 ? items[current] : (current >= 0 ? items.slice(current + 1).find(episode => episode.ParentIndexNumber > 0 && !watched(episode.Id)) : null) || items.find(episode => episode.ParentIndexNumber > 0 && !watched(episode.Id)) || items[0];
		if (!target || !content.isConnected) return;
		const button = element('button', 'button primary series-continue', [`${getProgress(target.Id) > 10 ? 'Continue' : watched(target.Id) ? 'Watch again' : 'Watch next'}`, episodeNumber(target), target.Name].filter(Boolean).join(' · '));
		button.onclick = () => startPlayback(target, getProgress(target.Id));
		content.insertBefore(button, content.querySelector('.overview'));
	} catch { /* Season browsing remains available when continuation cannot load. */ }
}
$('#previousChannel').onclick = () => previousChannel && startPlayback(previousChannel);
document.addEventListener('visibilitychange', () => { if (document.hidden) { nextCancelled = true; cancelNext(); $('#upNext').hidden = true; } });
async function detach() {
	const generation = playGeneration;
	cancelNext(); $('#upNext').hidden = true;
	setLiveMode(false);
	$('#viewingNotice').hidden = true;
	const session = state.session;
	const sessionBase = state.sessionBase;
	const position = playbackPosition();
	video.pause();
	segments = []; $('#skipIntro').hidden = true;
	if (casting.active || casting.pendingTarget) {
		casting.active = false;
		(casting.pendingTarget || casting.context.getCurrentSession())?.endSession(true);
		casting.pendingTarget = null;
	}
	updateCastControls();
	if (session) await api('/api/sessions/' + session, { action: 'stop', position, paused: true }, sessionBase);
	// A newer play may have started while the stop request was in flight.
	if (generation !== playGeneration) return;
	if (state.session === session) { state.session = null; state.sessionBase = ''; }
	if (state.hls) { state.hls.destroy(); state.hls = null; }
	video.pause();
	video.removeAttribute('src');
	video.load();
}

function chooseCatchupResume(item,saved){
	return new Promise(resolve=>{
		const dialog=element('dialog','catchup-resume'),title=element('h2','',item.Name||'Catch up'),actions=element('div','detail-actions');
		dialog.setAttribute('aria-label','Resume '+(item.Name||'catch-up programme'));
		let result=null;
		const stamp=Math.floor(saved/60)+':'+String(Math.floor(saved%60)).padStart(2,'0');
		for(const [label,value,css] of [['Resume from '+stamp,saved,'button primary'],['Start from beginning',0,'button secondary'],['Cancel',null,'button secondary']]){
			const button=element('button',css,label);button.onclick=()=>{result=value;dialog.close();};actions.append(button);
		}
		dialog.append(title,actions);dialog.addEventListener('close',()=>{dialog.remove();resolve(result);},{once:true});document.body.append(dialog);dialog.showModal();
	});
}
async function startPlayback(item, position = 0, keepSettings = false) {
	// Track indexes belong to one file. Choose English afresh for the next episode.
	keepSettings = keepSettings && state.playing?.Id === item.Id;
	const generation = ++playGeneration;
	resetViewingState();
	saveProgress();
	if(item.Type==='Catchup'&&!keepSettings&&getProgress(item.Id)>0){
		const choice=await chooseCatchupResume(item,getProgress(item.Id));if(choice===null||generation!==playGeneration)return;position=choice;
	}
	try { await detach(); } catch { $('#playerStatus').textContent = 'The previous stream is still closing. Please try Play again.'; if(nextBusy){nextCancelled=true;showNext();} return; }
	if (generation !== playGeneration) return;
	state.playing = item; nextEpisode = null; nextResult = null; nextCancelled = false;
	if (!keepSettings) {
		viewingStarted = false;
		try { if (localStorage.getItem('tellybox-watched-' + item.Id) === 'true') position = 0; } catch {}
	}
	if (item.Type === 'Episode') { void loadNext(generation); void api(`/api/web/items/${item.Id}/segments`).then(result => { if (generation === playGeneration) segments = result.segments || []; }).catch(() => {}); }
	$('#previousChannel').hidden = item.Type !== 'TvChannel' || !previousChannel;
	started = false;
	if (!keepSettings) {
		state.compatibility = false;
		$('#audioTrack').replaceChildren(new Option('Default', ''));
		$('#subtitleTrack').replaceChildren(new Option('Off', '-1'));
	}
	details.close();
	if (!player.open) player.showModal();
	$('#playerTitle').textContent = playbackTitle(item);
	$('#playerStatus').textContent = '';playerLoading(true);
	$('#retryPlayer').disabled = true;
	try {
		const payload = { textSubtitles: true, id: item.Id, quality: Number($('#quality').value), compatibility: state.compatibility, subtitleIndex: Number($('#subtitleTrack').value) };
		if (!keepSettings && localStorage.getItem('tellybox-english') === 'true') { delete payload.subtitleIndex; payload.preferEnglishSubtitles = true; }
		if ($('#audioTrack').value !== '') payload.audioIndex = Number($('#audioTrack').value);
		const sessionBase = await playbackBase();
		if (generation !== playGeneration || !player.open) return;
		const playback = await api('/api/play', payload, sessionBase);
		if (generation !== playGeneration || !player.open) { await api('/api/sessions/' + playback.session, { action: 'stop' }, sessionBase); return; }
		state.session = playback.session;
		state.sessionBase = sessionBase;
		state.playbackKind = playback.kind;
		setLiveMode(playback.live === true);
		const audioValue = $('#audioTrack').value;
		$('#audioTrack').replaceChildren(new Option('Default', ''), ...playback.audio.map(track => new Option(track.label, String(track.index))));
		$('#audioTrack').value = audioValue;
		const subtitleValue = String(playback.subtitleIndex ?? $('#subtitleTrack').value);
		$('#subtitleTrack').replaceChildren(new Option('Off', '-1'), ...playback.subtitles.map(track => new Option(track.label, String(track.index))));
		$('#subtitleTrack').value = subtitleValue;
		$('#audioTrack').disabled = !playback.audio.length;
		$('#subtitleTrack').disabled = !playback.subtitles.length;
		$('#subtitleTrack').title = '';
		state.captionTracks=playback.subtitles;
		state.burnedCaption=Number(playback.subtitleIndex)>=0&&!playback.subtitles.find(track=>track.index===Number(playback.subtitleIndex)&& (track.url||track.hls));
		$('#quality').disabled = playback.kind === 'audio';
		$('#retryPlayer').disabled = playback.kind === 'audio';
		const begin = () => {
			if (generation !== playGeneration) return;
			if (position > 0 && !playback.live) video.currentTime = position;
			if(!state.hls)for(const track of video.textTracks)if(track.label.startsWith('tellybox-subtitle-'))track.mode=track.label==='tellybox-subtitle-'+subtitleValue?'showing':'disabled';
			video.play().catch(() => { playerLoading(false); $('#playerStatus').textContent = 'Ready. Tap play to start.'; updateLiveControls(); });
			updateLiveControls();
		};
		video.onloadedmetadata = begin;
		if (sessionBase) video.crossOrigin = 'anonymous';
		else video.removeAttribute('crossorigin');
		const mediaUrl = new URL(playback.url, sessionBase || location.origin).href;
		for(const track of playback.subtitles.filter(track=>track.url)){const node=document.createElement('track');node.kind='subtitles';node.label=track.label;node.dataset.index=String(track.index);node.src=new URL(track.url,sessionBase||location.origin).href;node.default=String(track.index)===subtitleValue;video.append(node);node.track.mode=node.default?'showing':'disabled';node.addEventListener('load',()=>{if(node.track.mode==='showing'&&!node.track.cues?.length)$('#playerStatus').textContent='No matching captions available. Video can keep playing.';});}
		if (playback.kind === 'hls' && Hls.isSupported()) {
			const hls = new Hls({ maxBufferLength:30,backBufferLength:30,startPosition:state.live?-1:position });
			state.hls = hls;
			hls.on(Hls.Events.ERROR, (_, data) => {
				if (data.fatal) void playbackFailed('Playback was interrupted. Try compatibility mode, or choose a lower quality.', hls, data);
			});
			hls.on(Hls.Events.SUBTITLE_TRACKS_UPDATED,()=>{const selected=Number($('#subtitleTrack').value);hls.subtitleTrack=hls.subtitleTracks.findIndex(t=>t.name==='tellybox-subtitle-'+selected);});
			hls.loadSource(mediaUrl);
			hls.attachMedia(video);
		} else video.src = mediaUrl;
		$('#playerStatus').textContent = state.live ? (item.Provider==='Dispatcharr'?'Live from Dispatcharr':'Live TV · ready to play') : playback.method === 'DirectPlay' ? 'Original stream · ready to play' : 'Preparing a stream for your browser…';
	} catch (error) {
		if (generation !== playGeneration) return;
		playerLoading(false);
		if (error.code === 'VIEWING_LIMIT' || error.code === 'SESSION_LIMIT') showViewingBlocked(error.message, generation);
		else { $('#playerStatus').textContent = error.message; $('#retryPlayer').disabled = state.playbackKind === 'audio'; }
	}
}

function policyDenialFromBody(body) {
	if (!body) return null;
	let data = body;
	if (typeof data === 'string') {
		const text = data.trim();
		try { data = JSON.parse(text); }
		catch {
			const start = text.indexOf('{'), end = text.lastIndexOf('}');
			if (start < 0 || end <= start) return null;
			try { data = JSON.parse(text.slice(start, end + 1)); } catch { return null; }
		}
	}
	if (!data || typeof data !== 'object') return null;
	if (data.code !== 'VIEWING_LIMIT' && data.code !== 'SESSION_LIMIT') return null;
	return { code: data.code, message: typeof data.error === 'string' ? data.error : typeof data.message === 'string' ? data.message : '' };
}

function policyDenialFromResponse(response) {
	return policyDenialFromBody(response?.text) || policyDenialFromBody(response?.data) || policyDenialFromBody(response?.body) || policyDenialFromBody(response);
}

function policyMessage(denial, fallback) {
	if (denial?.message) return denial.message;
	if (denial?.code === 'SESSION_LIMIT') return 'This account has reached its remote screen limit. Stop playback on another screen and try again.';
	if (denial?.code === 'VIEWING_LIMIT') return 'Remote viewing time for this account has been used.';
	return fallback;
}

async function playbackFailed(message, hls, failure) {
	if (viewingBlocked || (hls && state.hls !== hls)) return;
	const generation = playGeneration, session = state.session;
	if (!session) return;
	const denial = policyDenialFromResponse(failure?.response) || policyDenialFromResponse(failure);
	if (denial) { showViewingBlocked(policyMessage(denial, message), generation); return; }
	playerLoading(false);
	$('#playerStatus').textContent = 'Checking playback status...';
	$('#retryPlayer').disabled = true;
	const base = state.sessionBase;
	const heartbeat = await sendHeartbeat('progress', session, base, 6000);
	if (viewingBlocked || (hls && state.hls !== hls) || !playbackContextCurrent({ generation, session })) return;
	const heartbeatDenial = heartbeat.error && (heartbeat.error.code === 'VIEWING_LIMIT' || heartbeat.error.code === 'SESSION_LIMIT')
		? { code: heartbeat.error.code, message: heartbeat.error.message } : null;
	if (heartbeatDenial) { showViewingBlocked(policyMessage(heartbeatDenial, message), generation); return; }
	const data = await queryViewingStatus();
	if (viewingBlocked || (hls && state.hls !== hls) || !playbackContextCurrent({ generation, session })) return;
	if (data?.blocked) { showViewingBlocked(data.message, generation); return; }
	$('#playerStatus').textContent = message;
	$('#retryPlayer').disabled = state.playbackKind === 'audio';
}

function closePlayer() {
	++playGeneration;
	saveProgress();
	void detach().catch(() => { /* Server expiry cleans up unreachable sessions. */ });
	player.close();
	void refreshFavouriteOrder();
}

video.addEventListener('playing', () => {
	if (casting.active) { video.pause(); return; }
	$('#playerStatus').textContent = '';
	if (state.playing?.Type === 'TvChannel') {
		if (lastChannel && lastChannel.Id !== state.playing.Id) previousChannel = lastChannel;
		lastChannel = state.playing; $('#previousChannel').hidden = !previousChannel || previousChannel.Id === state.playing.Id;
	}
	beginViewing();
	updateLiveControls();
	if (!started) { started = true; void report('start'); }
});
video.addEventListener('pause', () => {
	updateLiveControls();
	if (keepLivePlayback()) return;
	saveProgress(); void report('progress');
});
video.addEventListener('seeking', keepLiveEdge);
video.addEventListener('ended', () => { if (casting.active) return; saveProgress(); void report('progress'); updateCastControls(); showNext(true); });
video.addEventListener('error', () => { if (state.session && !casting.active && !viewingBlocked) void playbackFailed('This browser could not play the stream. Try compatibility mode below.'); });
setInterval(async () => {
	if (!state.session || reporting) return;
	reporting = true;
	saveProgress();
	await report('progress');
	if (!viewingBlocked && state.session) await checkViewingStatus();
	reporting = false;
}, 10000);
window.addEventListener('pagehide', () => {
	saveProgress();
	if (state.session && !casting.active) void fetch(new URL('/api/sessions/' + state.session, state.sessionBase || location.origin), {
		method: 'POST', keepalive: true, credentials: state.sessionBase ? 'omit' : 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'stop', position: video.currentTime || 0 })
	}).catch(() => {});
});

$('#heroPlay').onclick = () => coming.featured && showComingDetails(coming.featured);
$('#heroDetails').onclick = () => coming.featured && showComingDetails(coming.featured);
$('#anotherPick').onclick = anotherPick;
$('#allTvReleases').onclick = () => {
	$('#sort').value = 'new';
	const shows = state.libraries.find(item => item.CollectionType === 'tvshows');
	if (shows) selectLibrary(shows.Id);
	else {
		state.type = 'tvshows';
		for (const node of document.querySelectorAll('[data-type]')) node.classList.toggle('active', node.dataset.type === 'tvshows');
		void loadItems();
	}
	$('.collection').scrollIntoView({ block: 'start' });
};
$('#allReleases').onclick = () => {
	$('#sort').value = 'release';
	const films = state.libraries.find(item => item.CollectionType === 'movies');
	if (films) selectLibrary(films.Id);
	else {
		state.type = 'movies';
		for (const node of document.querySelectorAll('[data-type]')) node.classList.toggle('active', node.dataset.type === 'movies');
		void loadItems();
	}
	$('.collection').scrollIntoView({ block: 'start' });
};
$('#closeDetails').onclick = () => details.close();
$('#closePlayer').onclick = closePlayer;
player.addEventListener('cancel', event => { event.preventDefault(); closePlayer(); });
$('#retryPlayer').onclick = () => { if (viewingBlocked) return; state.compatibility = true; void startPlayback(state.playing, video.currentTime || getProgress(state.playing.Id), true); };
for (const id of ['quality', 'audioTrack']) $('#' + id).onchange = () => { if (!viewingBlocked) state.playing && startPlayback(state.playing, video.currentTime, true); };
$('#viewingBlockedBack').onclick = closePlayer;
$('#subtitleTrack').onchange=()=>{
	if(!state.playing||viewingBlocked)return;
	const selected=Number($('#subtitleTrack').value),track=state.captionTracks?.find(track=>track.index===selected);
	if(!state.burnedCaption&&(selected<0||track?.url||track?.hls)){
		for(const node of video.querySelectorAll('track'))node.track.mode=Number(node.dataset.index)===selected?'showing':'disabled';
		if(state.hls)state.hls.subtitleTrack=state.hls.subtitleTracks.findIndex(t=>t.name==='tellybox-subtitle-'+selected);
		else for(const text of video.textTracks)if(text.label.startsWith('tellybox-subtitle-'))text.mode=text.label==='tellybox-subtitle-'+selected?'showing':'disabled';
	}else void startPlayback(state.playing,video.currentTime,true);
};
$('#loadMore').onclick = () => loadItems(true);
$('#sort').onchange = () => loadItems();
$('#source').onchange = () => loadItems();
$('#search').onkeydown=event=>{if(event.key==='Enter'&&$('#search').value.trim()){event.preventDefault();location.assign('/search?'+new URLSearchParams({q:$('#search').value.trim()}));}};
$('#search').oninput = () => { updateHomeSections(); clearTimeout(searchTimer); searchTimer = setTimeout(() => loadItems(), 300); };
$('#nav').onclick = event => { const button = event.target.closest('[data-library]'); if (button) selectLibrary(button.dataset.library); };
$('#filters').onclick = event => {
	const button = event.target.closest('[data-type]');
	if (!button) return;
	state.type = button.dataset.type;
	for (const node of document.querySelectorAll('[data-type]')) node.classList.toggle('active', node === button);
	void loadItems();
};

window.addEventListener('online', () => {
	if (state.session || casting.active) return;
	routing.checked = !routing.preferLocal; routing.enabled = false;
	void api('/api/auth/status').then(access => {
		routing.direct = access.local; routing.home = access.home; updateRouting();
	}).catch(() => window.dispatchEvent(new CustomEvent('tellybox-route', { detail: { route: 'unknown', text: 'Connection unavailable · unable to reach your server.' } })));
});

let sharedFavourites=null, favouriteHome=false, serverFavouritesRequired=false, canShare=false;
let homeFeedsStarted=false;
function loadHomeFeeds(){if(homeFeedsStarted)return;homeFeedsStarted=true;void Promise.all([loadReleases(),loadTvReleases(),loadComing()]);}
async function init() {
	try { canShare=Boolean((await api('/api/capabilities')).canShare); } catch { canShare=false; }
	try {
		const access = await api('/api/auth/status');
		routing.direct = access.local;
		routing.home = access.home;
		favouriteHome=Boolean((access.local||access.home)&&!access.person);
		serverFavouritesRequired=Boolean(access.local||access.home||access.email);
		try { if(serverFavouritesRequired) { const favourites=await api(favouriteHome?'/api/favourites/home':'/api/favourites'); sharedFavourites=favourites.own; } } catch {}
		if ((access.local||access.home) && access.person) {
			const shelf=$('#favouriteShelf'), toggle=element('button','chip','Home favourites');
			toggle.setAttribute('aria-pressed','false');
			toggle.onclick=async()=>{toggle.disabled=true;try{const home=!favouriteHome,result=await api(home?'/api/favourites/home':'/api/favourites');sharedFavourites=result.own;favouriteHome=home;toggle.textContent=home?'My favourites':'Home favourites';toggle.setAttribute('aria-pressed',String(home));updateHomeSections();if(state.type==='favourites')void loadItems();}catch(error){toggle.textContent='Try again';}finally{toggle.disabled=false;}};
			shelf.querySelector('.shelf-heading').append(toggle);
		}
		if(serverFavouritesRequired && Object.keys(browserFavourites()).length) {
			const button=element('button','button secondary',favouriteHome?'Add this browser’s saved titles to Home':'Add this browser’s saved titles to my favourites');
			button.id='importBrowserFavourites'; $('#favouriteShelf').append(button);
			button.onclick=async()=>{
				button.disabled=true;
				try {
					const previous=browserFavourites();
					for(const item of Object.values(previous)) await changeFavourite(item,true);
					localStorage.setItem('tellybox-favourites-before-sync',JSON.stringify(previous));localStorage.removeItem('tellybox-favourites');
					button.remove();updateHomeSections();
				}catch(error){button.textContent=error.message+' Try import again.';button.disabled=false;}
			};
		}
		routing.origin = access.localPlayback?.origin || '';
		routing.instance = access.localPlayback?.instance || '';
		try { routing.preferLocal = localStorage.getItem('jserver-prefer-local') !== 'false'; } catch {}
		routing.checked = !routing.preferLocal;
		if (routing.origin) { $('#localSiteLink').href = routing.origin; $('#localSiteLink').hidden = routing.direct; }
		updateRouting();
		setupCast();
		$('#remoteSettings').hidden = !access.local && !access.home;
		$('#activityLink').hidden = !access.local && !access.home;
		if (!access.local && access.home && routing.origin) {
			$('#remoteSettings').href = new URL('/settings', routing.origin).href;
			$('#activityLink').href = new URL('/activity', routing.origin).href;
		}
		$('#signOut').hidden = access.local || access.home;
		$('#signOut').onclick = async () => {
			if (state.session) await detach();
			await api('/api/auth/logout', {});
			location.replace('/login');
		};
		const status = await api('/api/status');
		const features = status.features || {};
		for (const node of document.querySelectorAll('a[href="/discover"]')) node.hidden = !features.discover;
		if (!status.connected) throw new Error('Your Tellybox is ready to set up. Connect Jellyfin or Dispatcharr in installation settings to start watching.');
		state.libraries = (await api('/api/libraries')).filter(item=>item.CollectionType!=='livetv');
		for(const library of state.libraries)if(library.CollectionType==='tvshows'&&/^(tv|tv shows|television)$/i.test(library.Name.trim()))library.Name='Series';
		for(const library of state.libraries)if(library.Name.toLowerCase()==='recordings'){library.LegacyRecordings=true;library.Name='Local recordings';}
		if (features.live) state.libraries.push({Id:'dispatch-tv',CollectionType:'livetv',Name:'Live TV'},{Id:'dispatch-247',CollectionType:'nonstop',Name:'24/7'});
		if (features.recordings) state.libraries.push({Id:'dispatch-recordings',CollectionType:'dvr',Name:'Recordings'});
		for (const library of state.libraries) {
			if(library.LegacyRecordings){const older=element('button','button quiet','Browse local recordings');older.onclick=()=>selectLibrary(library.Id);$('#olderRecordings').append(older);continue;}
			const button = element('button', 'nav-item', library.Name);
			button.dataset.library = library.Id;
			$('#nav').append(button);
		}
		const view=new URLSearchParams(location.search).get('view');
		if(view==='nonstop')selectLibrary('dispatch-247');else if(view==='livetv')selectLibrary('dispatch-tv');else if(view==='recordings')selectLibrary('dispatch-recordings');
		else if(['movies','tvshows'].includes(view)){const library=state.libraries.find(item=>item.CollectionType===view);if(library)selectLibrary(library.Id);else void loadItems();}
		else void loadItems();
		const requestedItem = new URLSearchParams(location.search).get('item');
		if (/^(?:[a-f0-9-]{32,36}|dispatch-live-[a-f0-9-]{36}|dispatch-(?:movie|series)-[1-9]\d*|dispatch-episode-[1-9]\d*-[1-9]\d*)$/i.test(requestedItem || '')) await showDetails(requestedItem);
	} catch (error) { $('#status').textContent = error.message; }
}
void init();

function favouriteTitle(item) {
	if (!['Episode', 'Season'].includes(item?.Type) || typeof item.SeriesId !== 'string'
		|| !/^[A-Za-z0-9:_.-]{1,180}$/.test(item.SeriesId) || Object.hasOwn(Object.prototype, item.SeriesId)
		|| typeof item.SeriesName !== 'string' || !item.SeriesName.trim()) return item;
	const id = item.SeriesId, vod = /^dispatch-series-([1-9][0-9]*)$/.exec(id);
	return { Id: id, Name: item.SeriesName.trim(), Type: 'Series',
		...(item.Source ? { Source: item.Source } : {}),
		Artwork: vod ? '/api/web/art/series/' + vod[1] : '/images/' + id + '/Primary?width=400' };
}
function normaliseFavourites(items) {
	const result = {};
	for (const item of items) {
		if (!item?.Id) continue;
		const title = favouriteTitle(item);
		if (!result[title.Id] || title === item) result[title.Id] = title;
	}
	return result;
}
function browserFavourites(){try{const saved=JSON.parse(localStorage.getItem('tellybox-favourites')||'{}');return saved&&typeof saved==='object'&&!Array.isArray(saved)?normaliseFavourites(Object.values(saved)):{};}catch{return {};}}
function readFavourites(){if(sharedFavourites)return normaliseFavourites(sharedFavourites.items);return serverFavouritesRequired?{}:browserFavourites();}
async function refreshFavouriteOrder() {
	if (!serverFavouritesRequired) return;
	const home = favouriteHome;
	try {
		const result = await api(home ? '/api/favourites/home' : '/api/favourites');
		if (home !== favouriteHome) return;
		sharedFavourites = result.own; updateHomeSections();
		if (state.type === 'favourites') void loadItems();
	} catch { /* Keep the last known favourites when reconnecting. */ }
}
window.addEventListener('focus', () => { if (!state.session) void refreshFavouriteOrder(); });
async function changeFavourite(item,saved){
	item=favouriteTitle(item);
	if(!sharedFavourites&&serverFavouritesRequired){const result=await api(favouriteHome?'/api/favourites/home':'/api/favourites');sharedFavourites=result.own;if(!sharedFavourites)throw Error('Couldn’t load favourites. Please try again.');}
	if(!sharedFavourites){const items=readFavourites();if(saved)items[item.Id]=item;else delete items[item.Id];localStorage.setItem('tellybox-favourites',JSON.stringify(items));updateHomeSections();return;}
	const change={id:item.Id,saved,item};
	const result=await api(favouriteHome?'/api/favourites/home':'/api/favourites',favouriteHome?change:{profileId:sharedFavourites.id,changes:[change]});
	sharedFavourites=favouriteHome?result:result.own;updateHomeSections();
	if(state.type==='favourites')void loadItems();
}

$('#genre').onchange=()=>loadItems();

function brandLoader(){const box=element('div','brand-loading');box.setAttribute('role','status');box.setAttribute('aria-label','Loading');const mark=element('img');mark.src='/tellybox-mark.svg';mark.alt='';const dots=element('span','loading-dots','•••');dots.setAttribute('aria-hidden','true');box.append(mark,dots);return box;}
$('#catchupGuide').onclick=async()=>{
	const content=element('div','detail-content catchup-content'),heading=element('h2','','Catch up');heading.id='detailsTitle';content.append(heading);const host=element('div');host.append(brandLoader());content.append(host);
	$('#detailsBody').replaceChildren(content);if(!details.open)details.showModal();
	try{const data=await api('/api/catchup');if(!content.isConnected)return;host.replaceChildren();
		if(!data.channels.length){host.textContent='No archived programmes are available yet.';return;}
		const layout=element('div','catchup-browser'),channels=element('nav','catchup-channels'),main=element('div','catchup-main'),title=element('h3'),dates=element('nav','catchup-dates'),shows=element('div','catchup-programmes');channels.setAttribute('aria-label','Catch-up channels');dates.setAttribute('aria-label','Broadcast date');main.append(title,dates,shows);layout.append(channels,main);host.append(layout);
		function select(button,list){for(const other of list.children)other.setAttribute('aria-pressed',String(other===button));}
		function openChannel(channel,button){select(button,channels);title.textContent=channel.Name;dates.replaceChildren();shows.replaceChildren();
			const groups=new Map();for(const p of [...channel.programmes].sort((a,b)=>Date.parse(b.StartDate)-Date.parse(a.StartDate))){const day=new Date(p.StartDate).toLocaleDateString([],{weekday:'short',day:'numeric',month:'short'});if(!groups.has(day))groups.set(day,[]);groups.get(day).push(p);}
			for(const [day,programmes] of groups){const date=element('button','catchup-chip',day);date.type='button';date.onclick=()=>{select(date,dates);shows.replaceChildren();shows.scrollTop=0;
				for(const p of [...programmes].reverse()){const watch=element('button','catchup-programme'),time=element('span','catchup-time',guideTime(p.StartDate)),copy=element('span','catchup-copy'),name=element('strong','',p.Name),duration=element('small','',Math.round((Date.parse(p.EndDate)-Date.parse(p.StartDate))/60000)+' min');copy.append(name,duration);if(p.Overview)copy.append(element('span','catchup-overview',p.Overview));const icon=element('span','catchup-play','▶');icon.setAttribute('aria-hidden','true');watch.append(time,copy,icon);watch.setAttribute('aria-label','Play '+p.Name+', '+guideTime(p.StartDate));watch.onclick=()=>{details.close();void startPlayback(p,0);};shows.append(watch);}
			};dates.append(date);}dates.firstElementChild?.click();
		}
		for(const channel of data.channels){const button=element('button','catchup-chip',channel.Name);button.type='button';button.onclick=()=>openChannel(channel,button);channels.append(button);}channels.firstElementChild?.click();
	}catch(error){host.textContent=error.message;}
};
function playerLoading(show){$('#playerLoading').hidden=!show||casting.active||!player.open;}
video.addEventListener('waiting',()=>playerLoading(true));
for(const event of ['playing','canplay','pause','ended','error','emptied'])video.addEventListener(event,()=>playerLoading(false));
