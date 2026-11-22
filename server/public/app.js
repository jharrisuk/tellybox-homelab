const $ = selector => document.querySelector(selector);
const sourceLabel = window.TellyboxSourceLabel || { streamed: item => 'Streamed', streamNow: item => 'Stream now', available: item => 'Available in the streamed catalogue.' };
const autoplay = window.TellyboxAutoplay || {
	classify(error) {
		const name = error && typeof error.name === 'string' ? error.name : '';
		if (name === 'NotAllowedError') return 'blocked';
		if (name === 'AbortError') return 'race';
		if (name === 'NotSupportedError' || name === 'NotReadableError') return 'unsupported';
		return 'unknown';
	},
	status(kind, live) {
		if (kind === 'blocked') return live ? 'Your browser needs one tap to start live playback. Press Play live.' : 'Your browser needs one tap to start playback. Press play.';
		if (kind === 'unsupported') return 'This browser could not start the stream. Try compatibility mode below.';
		if (kind === 'race') return 'Preparing playback…';
		return 'Ready. Press play to start.';
	},
	shouldRetry(kind) { return kind === 'race'; },
	loadingVisible(value) { return !value.blocked && (Boolean(value.starting) || !value.paused); },
	playVisible(value) { return Boolean(value.live && value.paused && value.hasSource); }
};
const state = { libraries: [], library: null, type: 'all', items: [], total: 0, generation: 0, playing: null, session: null, hls: null, compatibility: false, compatibilityRetried: false, loading: false, live: false, relayMedia: false, playStarting: false, playBlocked: false, playRetry: false, playAttempt: null, hlsReady: false, playbackQuality: 0, providerQuality: 0 };
const video = $('#video');
const playbackClock = () => (globalThis.performance && typeof globalThis.performance.now === 'function' ? globalThis.performance.now() : Date.now());
const playbackWarning = globalThis.TellyboxBufferingWarning ? new globalThis.TellyboxBufferingWarning.Monitor() : null;
// One monitor per playback session. It is created from the server's live flag
// after /api/play succeeds, so films, episodes and catch-up save a resume point
// while live channels and 24/7 streams do not. Automatic next episodes reuse it
// through transition() instead of restarting the two-hour accumulator.
let stillWatching = null;
let stillPromptKeyDismissedAt = -Infinity;

function hidePlaybackTrouble() {
	const node = $('#playbackTrouble');
	if (node) node.hidden = true;
}
function resetPlaybackWarning() {
	if (playbackWarning) playbackWarning.reset(playbackClock(), '');
	hidePlaybackTrouble();
}
function showPlaybackTrouble() {
	const node = $('#playbackTrouble');
	if (!node) return;
	const message = $('#playbackTroubleMessage');
	if (message) message.textContent = 'Playback is struggling. This may be a slow connection or a temporary stream issue. Try again or choose a lower quality.';
	updateTroubleLowerAction();
	// One banner at a time: a warning appearing while the still-watching prompt
	// is open takes precedence. The prompt returns only after the warning clears.
	if (typeof hideStillWatching === 'function') hideStillWatching();
	node.hidden = false;
	// Never move focus automatically. Users and TV remotes choose an action.
}
function updatePlaybackTrouble() {
	// The one-second warning tick is also the player's still-watching tick. It
	// runs even when playback is paused, hidden or blocked so the monitor sees
	// every state change and the countdown only advances during healthy viewing.
	if (typeof updateStillWatching === 'function') updateStillWatching();
	if (!playbackWarning || !player.open || !state.playing || viewingBlocked || casting.active) { hidePlaybackTrouble(); return; }
	// Picture-in-Picture is intentional viewing, not a stalled page. Do not count
	// that time, and never draw the page banner under a popped-out video.
	const pip = document.pictureInPictureElement === video;
	if (pip) hidePlaybackTrouble();
	const status = playbackWarning.update({
		now: playbackClock(),
		streamKey: String(state.session || '') + ':' + String(state.playing.Id || ''),
		buffering: !pip && !video.paused && !video.seeking && !video.ended && video.readyState < 3,
		paused: video.paused || pip,
		seeking: video.seeking,
		ended: video.ended
	});
	if (status.show) showPlaybackTrouble();
	else if (status.hide) hidePlaybackTrouble();
}
function hideStillWatching() {
	const node = $('#stillWatching');
	if (node) node.hidden = true;
}
function stillWatchingPromptOpen() {
	const node = $('#stillWatching');
	return Boolean(node && !node.hidden);
}
// The player dialog itself is expected to be open during playback. Any other
// open dialog (details, catch-up resume, or a future modal) owns the screen.
function blockingModalOpen() {
	for (const dialog of document.querySelectorAll('dialog[open]')) if (dialog !== player) return true;
	return false;
}
function createStillWatchingSession(resumeApplies) {
	stillWatching = globalThis.TellyboxStillWatching
		? globalThis.TellyboxStillWatching.create({ resumeApplies: resumeApplies === true })
		: null;
	return stillWatching;
}
function beginStillWatchingSession(resumeApplies, automatic) {
	hideStillWatching();
	if (automatic && stillWatching) {
		stillWatching.setResumeApplies(resumeApplies);
		stillWatching.transition(playbackClock());
		return stillWatching;
	}
	return createStillWatchingSession(resumeApplies);
}
function showStillWatching(seconds) {
	const node = $('#stillWatching');
	if (!node) return;
	const wasHidden = node.hidden;
	const value = String(Math.max(1, Number(seconds) || 60));
	const countdown = $('#stillWatchingSeconds');
	if (countdown && countdown.textContent !== value) countdown.textContent = value;
	node.hidden = false;
	const keep = $('#stillWatchingKeep');
	// Focus the TV/remote default once. Later ticks only change the countdown,
	// so a viewer who moved to Stop is not pulled back every second.
	if (wasHidden && keep && document.activeElement !== keep) keep.focus();
}
function updateStillWatching() {
	const node = $('#stillWatching');
	if (!stillWatching || !player.open || !state.playing || viewingBlocked) { hideStillWatching(); return; }
	const pip = document.pictureInPictureElement === video;
	const buffering = !pip && !video.paused && !video.seeking && !video.ended && video.readyState < 3;
	// Casting runs on another screen and PiP is not visible in this document.
	const playing = !casting.active && !video.paused && !video.ended && video.readyState >= 3;
	const visible = !document.hidden && !pip;
	const upNext = $('#upNext');
	const canPrompt = visible && !casting.active && !viewingBlocked
		&& !blockingModalOpen()
		&& !(playbackWarning && playbackWarning.isShown())
		&& Boolean(upNext && upNext.hidden);
	const result = stillWatching.update(playbackClock(), playing, buffering, video.seeking, visible, canPrompt);
	if (result.state === 'prompt' && canPrompt && visible) {
		const seconds = String(Math.max(1, result.remainingSeconds));
		const countdown = $('#stillWatchingSeconds');
		if (result.show || !node || node.hidden) showStillWatching(result.remainingSeconds);
		else if (countdown && countdown.textContent !== seconds) countdown.textContent = seconds;
	} else {
		hideStillWatching();
	}
	if (result.stop) {
		hideStillWatching();
		const saveResume = result.resumeApplies;
		stillWatching = null;
		// The normal close path stops the server session and relay, saves the
		// resume point and returns to browsing. Never start another stream here.
		if (saveResume) saveProgress();
		closePlayer();
	}
}
function keepWatchingFromPrompt() {
	if (!stillWatching) return;
	stillWatching.keepWatching(playbackClock());
	hideStillWatching();
}
function stopFromStillWatching() {
	if (!stillWatching) return;
	stillWatching.stop(playbackClock());
	stillWatching = null;
	hideStillWatching();
	saveProgress();
	closePlayer();
}
function deliberatePlaybackInput(event) {
	if (!stillWatching || !player.open) return;
	if (stillWatchingPromptOpen()) {
		if (event?.type === 'keydown' && ['Escape', 'Backspace', 'GoBack', 'BrowserBack'].includes(event.key)) {
			event.preventDefault();
			event.stopPropagation();
			stillPromptKeyDismissedAt = playbackClock();
			keepWatchingFromPrompt();
		}
		return;
	}
	// A deferred prompt is already at the threshold. Dismissing the modal that
	// deferred it must not reset the clock and suppress the question.
	if (stillWatching.state === 'prompt' || stillWatching.elapsedMs >= stillWatching.thresholdMs) return;
	stillWatching.reset(playbackClock());
}
function retryFromTrouble() {
	hidePlaybackTrouble();
	if (!state.playing) return;
	if (playbackWarning) playbackWarning.reset(playbackClock(), String(state.playing.Id || ''));
	void startPlayback(state.playing, state.live ? 0 : video.currentTime, true);
}
function lowerQualityFromTrouble() {
	const quality = $('#quality');
	if (!quality || !state.playing) { retryFromTrouble(); return; }
	// A provider item hides the Quality select, so a choice left from a local
	// item must not make Lower quality look exhausted or send the wrong rung.
	if (playbackTuning && playbackTuning.isProviderPlayback(state.playing, false)) {
		const ceiling = Number(state.playbackQuality) || playbackTuning.PROVIDER_DEFAULT_QUALITY;
		if (Number(quality.value) !== ceiling) quality.value = String(ceiling);
	}
	const next = globalThis.TellyboxBufferingWarning
		? globalThis.TellyboxBufferingWarning.nextLowerQuality(Number(quality.value), null, state.playbackQuality)
		: 0;
	if (!next) {
		const message = $('#playbackTroubleMessage');
		if (message) message.textContent = 'Already at the lowest quality. Try Retry or Back.';
		return;
	}
	hidePlaybackTrouble();
	quality.value = String(next);
	if (state.playing && playbackTuning && playbackTuning.isProviderPlayback(state.playing, false)) state.providerQuality = next;
	quality.dispatchEvent(new Event('change'));
}
function updateTroubleLowerAction() {
	const quality = $('#quality');
	const button = $('#troubleLower');
	if (!button) return;
	if (quality && state.playing && playbackTuning && playbackTuning.isProviderPlayback(state.playing, false)) {
		const ceiling = Number(state.playbackQuality) || playbackTuning.PROVIDER_DEFAULT_QUALITY;
		if (Number(quality.value) !== ceiling) quality.value = String(ceiling);
	}
	const next = quality && globalThis.TellyboxBufferingWarning
		? globalThis.TellyboxBufferingWarning.nextLowerQuality(Number(quality.value), null, state.playbackQuality)
		: 0;
	button.disabled = !next;
	button.textContent = next ? 'Lower quality' : 'Lowest quality';
	button.title = next ? 'Try the next lower quality' : 'Already at the lowest quality';
}
const fullscreenElement = () => document.fullscreenElement || document.webkitFullscreenElement || document.webkitCurrentFullScreenElement || null;
const requestFullscreenOn = element => {
	const request = element.requestFullscreen || element.webkitRequestFullscreen || element.webkitRequestFullScreen || element.msRequestFullscreen;
	if (request) return request.call(element);
	if (video.webkitEnterFullscreen) return video.webkitEnterFullscreen();
	return Promise.reject(new Error('Fullscreen is unavailable.'));
};
const exitFullscreen = () => {
	const exit = document.exitFullscreen || document.webkitExitFullscreen || document.webkitCancelFullScreen || document.msExitFullscreen;
	return exit ? exit.call(document) : Promise.resolve();
};
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
// Browser progress (`jimbo-progress-*`, `tellybox-watched-*`, `tellybox-series-*`)
// belongs to whoever watched last in this browser, not to whoever is signed in
// now. It is only trustworthy when the viewer is genuinely local or at home,
// and that is not known until /api/auth/status answers. Until then it is
// untrusted, so a remote account can never inherit another account's position.
// The same gate covers the liked-show inputs: `tellybox-series-*` keys and
// `tellybox-taste` votes from a previous viewer must not build a remote
// account's "New episodes" rail either.
const browserProgress = { trusted: false };
let homeFeedsStarted = false;
const likedEpisodesState = { key: '', items: [], loaded: false, loading: false, failed: false, generation: 0 };
function browserProgressTrusted() { return browserProgress.trusted; }
function trustBrowserProgress(access) {
	const trusted = Boolean(access?.local || access?.home);
	if (trusted === browserProgress.trusted) return;
	browserProgress.trusted = trusted;
	// The viewer behind this browser just changed. The liked-series rail must
	// not keep the previous account's shows: forget the fetched items, bump the
	// generation so an in-flight response is discarded, and rebuild the rail
	// when Home is already on screen.
	likedEpisodesState.generation += 1;
	likedEpisodesState.key = '';
	likedEpisodesState.items = [];
	likedEpisodesState.loaded = false;
	likedEpisodesState.loading = false;
	likedEpisodesState.failed = false;
	if (homeFeedsStarted && isHomeView()) void loadLikedEpisodes().catch(() => {});
}
const coming = { tv: [], movies: [], unavailable: [], type: 'tv', expanded: false, featured: null, loaded: false };
const homeFeedState = { data: null, fetchedAt: 0, context: '', loading: false, generation: 0, deferred: false, artworkDeferred: false, signature: '', artworkSignature: '', settled: false, failed: false, queued: false, queuedInternal: false, authReady: false, scope: '', artworkRestartBudget: 1, favouritesSettled: false, access: null, cacheOrigin: false };

// Q44: a short-lived, per-account snapshot of the Home feed. It exists so a new
// tab can paint instantly instead of showing the boot overlay again. It is never
// authoritative: the feed is always reconciled in the background, and the key is
// scoped to the signed-in account so a shared browser cannot show one person's
// Continue rail to another.
const HOME_CACHE_TTL_MS = 15 * 60 * 1000;
const HOME_CACHE_PREFIX = 'tellybox-home-v1:';
function homeCacheKey(access) {
	// The feed's own opaque auth scope, not a display name: two people with the
	// same name must never share a snapshot.
	return HOME_CACHE_PREFIX + homeAuthScope(access || {});
}
function readHomeCache(access) {
	try {
		const key = homeCacheKey(access);
		const raw = localStorage.getItem(key);
		if (!raw) return null;
		const value = JSON.parse(raw);
		const fresh = value && typeof value.at === 'number'
			&& value.at <= Date.now() + 60 * 1000
			&& Date.now() - value.at <= HOME_CACHE_TTL_MS
			&& value.data && Array.isArray(value.data.rows);
		if (!fresh) { localStorage.removeItem(key); return null; }
		return value.data;
	} catch { return null; }
}
function writeHomeCache(access, data) {
	if (!access || !data || !Array.isArray(data.rows)) return;
	try { localStorage.setItem(homeCacheKey(access), JSON.stringify({ at: Date.now(), data })); } catch { /* storage may be blocked */ }
}
function clearHomeCaches() {
	try {
		for (let index = localStorage.length - 1; index >= 0; index -= 1) {
			const key = localStorage.key(index);
			if (key?.startsWith(HOME_CACHE_PREFIX)) localStorage.removeItem(key);
		}
	} catch { /* storage may be blocked */ }
}
// The overlay is markup from index.html, so it exists before any script runs.
// It is only ever removed; a genuine failure replaces the pulse with a retry.
const CACHE_NOTICE = 'Showing your last saved picks while we refresh.';
let bootOverlayTimer = null;
function bootOverlayNode() {
	return typeof document !== 'undefined' && typeof document.getElementById === 'function'
		? document.getElementById('bootOverlay') : null;
}
function setBackgroundInert(inert) {
	if (typeof document === 'undefined' || typeof document.querySelector !== 'function') return;
	for (const selector of ['header.topbar', 'main', 'footer']) {
		const node = document.querySelector(selector);
		if (node && 'inert' in node) node.inert = inert;
	}
}
function clearBootOverlayTimer() {
	if (bootOverlayTimer !== null) { clearTimeout(bootOverlayTimer); bootOverlayTimer = null; }
}
function hideBootOverlay() {
	clearBootOverlayTimer();
	setBackgroundInert(false);
	const overlay = bootOverlayNode();
	if (!overlay) return;
	overlay.setAttribute('aria-busy', 'false');
	overlay.hidden = true;
}
function bootOverlayError(message) {
	clearBootOverlayTimer();
	const overlay = bootOverlayNode();
	if (!overlay) return;
	const text = overlay.querySelector('.boot-overlay-text');
	const retry = document.getElementById('bootRetry');
	if (text) text.textContent = message;
	if (retry) {
		retry.hidden = false;
		retry.onclick = () => {
			retry.hidden = true;
			if (text) text.textContent = 'Loading your library…';
			overlay.setAttribute('aria-busy', 'true');
			armBootOverlayTimeout();
			loadHomeFeed(true);
		};
		// A keyboard user may have been focusing something behind the cover.
		try { retry.focus(); } catch { /* focus may be unavailable */ }
	}
}
function armBootOverlayTimeout() {
	if (bootOverlayTimer !== null) return;
	if (typeof setTimeout !== 'function') return;
	bootOverlayTimer = setTimeout(() => {
		bootOverlayTimer = null;
		const overlay = bootOverlayNode();
		const retry = typeof document !== 'undefined' && typeof document.getElementById === 'function'
			? document.getElementById('bootRetry') : null;
		// Only speak up while the load is still genuinely in flight: never
		// overwrite a specific failure, and never re-cover a retry in progress.
		if (!overlay || overlay.hidden || (retry && !retry.hidden)) return;
		bootOverlayError('Still loading — this is taking longer than usual.');
	}, 20000);
}
// Canonical landing order for the focused Home. Only these rails may render;
// unknown or extra server rows never dump onto the landing page.
const homeRowOrder = { 'continue': 0, 'new-episodes': 1, 'for-you': 2, 'new': 3 };
const homeRowAllowed = new Set(Object.keys(homeRowOrder));
let homeSkeletonShown = false;
// Verified watch surfaces can briefly return a short page while availability
// checks are still queued. Both the collection and Home poll a bounded number of
// times so a short page never looks like the end of the collection.
const availabilityPollDelay = 1750;
const availabilityPollLimit = 5;
const availabilityCheckingText = 'Checking availability for more titles…';
const homeAvailabilityRetryLimit = 2;
// Artwork continuation is separate from full-feed availability verification.
// A metadata lookup can land well after the two 1750 ms row checks, so the
// artwork light route is checked on its own bounded schedule. Only artwork
// fields flow back; a full Home POST is never sent just because an image is
// still pending. 5 attempts: 1200, 2400, 4800, 8000 and a final 8000 ms cap.
const homeArtworkPollDelays = [1200, 2000, 2800, 5000];
const homeArtworkPollLimit = 5;
const homeArtworkPoll = { token: 0, active: false };
// A superseded artwork session (missing/expired sign-in, account or source
// change) may ask for one full Home reload. That allowance is per Home view
// session, not per poll loop: otherwise every reload starts another loop that
// can ask for another reload. It is replenished only by explicit Home
// navigation or a genuinely new validated auth scope.
const homeArtworkRestartLimit = 1;
// Row/availability verification only. Artwork has its own loop and must not
// keep the full feed re-POSTing.
function feedAvailabilityPending(data) {
	const pending = Number(data?.availability?.pending);
	return Number.isFinite(pending) && pending > 0 ? pending : 0;
}
// The shared quiet notice still reports any outstanding work (rows or
// artwork), but the request paths use feedAvailabilityPending.
function pendingAvailability(data) {
	const pending = Number(data?.availability?.pending);
	const artwork = Number(data?.availability?.artwork?.pending);
	return (Number.isFinite(pending) && pending > 0 ? pending : 0) + (Number.isFinite(artwork) && artwork > 0 ? artwork : 0);
}
let guideData = null;
let recordingData = [], recordingFilter = 'all';

function updateRouting(message = '') {
	const active = Boolean(casting.active || state.session);
	// At home on the public address the server has already recognised the home
	// network; show the home icon before playback rather than the relay cloud.
	const atHome = !active && routing.home === true;
	const local = casting.active ? casting.route === 'local' : state.session ? Boolean(routing.direct || state.sessionBase) : routing.direct || routing.enabled || atHome;
	const route = local ? 'local' : 'relay';
	const text = active ? (local ? 'Streaming locally · video is travelling directly from your home server.' : 'Streaming through the relay · video is using your internet connection.')
		: local ? (routing.direct ? 'Local connection · connected directly to your home server.' : atHome ? 'At home · local streaming will be checked when you press play.' : 'Local streaming available · your home server was reached directly. This page uses the relay.')
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
	if (routing.checked && routing.enabled) return routing.origin;
	if (routing.checked && !autoplay.localProbeDue(routing)) return '';
	if (!routing.pending) {
		routing.pending = (async () => {
			try {
				const response = await fetch(new URL('/api/local-playback', routing.origin), { credentials: 'omit', cache: 'no-store', signal: AbortSignal.timeout(autoplay.localProbeTimeout()), targetAddressSpace: 'local' });
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
		$('#livePlay').hidden = !(state.live && video.paused && Boolean(video.currentSrc || video.getAttribute('src')));
		$('#liveMute').textContent = video.muted ? 'Unmute' : 'Mute';
		$('#liveMute').setAttribute('aria-pressed', String(video.muted));
		$('#liveFullscreen').textContent = (document.fullscreenElement || document.webkitFullscreenElement || document.webkitCurrentFullScreenElement) ? 'Exit fullscreen' : 'Fullscreen';
	}
}

function hasPlaybackSource() {
	return Boolean(video.currentSrc || video.getAttribute('src'));
}

function settlePlayFailure(error, generation) {
	if (generation !== playGeneration) return;
	state.playStarting = false;
	state.playAttempt = null;
	const kind = autoplay.classify(error);
	if (kind === 'race') {
		// Our own source swap interrupted the play() call. Wait for metadata or
		// manifest-ready and try once more instead of showing a false failure.
		state.playRetry = true;
		return;
	}
	state.playBlocked = true;
	playerLoading(false);
	updateLiveControls();
	const message = autoplay.status(kind, state.live);
	$('#playerStatus').textContent = message;
	if (kind === 'unsupported') void playbackFailed(message);
	else if (state.live) $('#livePlay').focus?.();
}

function beginPlayback(generation) {
	if (generation !== playGeneration || !player.open || state.playBlocked) return Promise.resolve();
	if (state.hls && !state.hlsReady) {
		state.playRetry = true;
		return Promise.resolve();
	}
	if (state.playAttempt) return state.playAttempt;
	if (!hasPlaybackSource()) {
		state.playRetry = true;
		return Promise.resolve();
	}
	state.playStarting = true;
	let attempt;
	try { attempt = video.play(); }
	catch (error) { attempt = Promise.reject(error); }
	state.playAttempt = attempt;
	Promise.resolve(attempt).then(() => {
		if (generation !== playGeneration) return;
		state.playStarting = false;
		state.playBlocked = false;
		state.playRetry = false;
		playerLoading(false);
		updateLiveControls();
	}).catch(error => settlePlayFailure(error, generation)).finally(() => {
		if (state.playAttempt === attempt) state.playAttempt = null;
	});
	return state.playAttempt;
}

function nudgePlayback(generation) {
	if (generation !== playGeneration || !player.open || state.playBlocked || state.playAttempt) return;
	if (state.hls && !state.hlsReady) { state.playRetry = true; return; }
	if (!hasPlaybackSource()) { state.playRetry = true; return; }
	if (video.paused) void beginPlayback(generation);
}

// Native media keys and keyboard shortcuts can still pause or seek a video
// without on-screen controls. Live playback is pulled back to the live edge.
function keepLivePlayback() {
	if (!state.live || casting.active || !player.open || viewingBlocked) return false;
	// A genuine autoplay block must not be retried on every pause event. The
	// explicit Play live button clears the flag and starts playback.
	if (state.playBlocked) return true;
	if (video.currentSrc || video.getAttribute('src')) void beginPlayback(playGeneration);
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

const playbackTuning = globalThis.TellyboxPlaybackTuning || null;
// Provider and live playback keep the hidden control values out of the way.
// Local Jellyfin films/episodes show the same controls as before this policy.
function updatePlaybackTuning(item, live) {
	if (!playbackTuning) return;
	const hide = playbackTuning.isProviderPlayback(item, live === true);
	playbackTuning.applyVisibility([
		$('.player-settings'),
		$('#autoNext')?.closest('.browser-preference'),
		$('#defaultEnglish')?.closest('.browser-preference'),
		$('.browser-preference-note')
	], hide);
}

let castSecureLinkRequested = false;
function loadCastSecureLink() {
	if (castSecureLinkRequested || (window.isSecureContext && location.protocol === 'https:')) return;
	castSecureLinkRequested = true;
	void api('/api/auth/tunnel').then(value => {
		if (value.url?.startsWith('https://')) { $('#castSecureLink').href = value.url; $('#castSecureLink').hidden = false; }
	}).catch(() => { castSecureLinkRequested = false; });
}
function setupCast() {
	if (!window.isSecureContext || location.protocol !== 'https:') {
		// The secure address is only needed inside the player's Cast panel.
		// loadCastSecureLink fetches it when the player opens.
		$('#castStatus').textContent = 'To cast, open the secure Tellybox address in Chrome and sign in. Keep your phone and TV on the same Wi-Fi.';
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
		hideNextCard();
		beginViewing();
		video.pause();
		video.onloadedmetadata = null;
		if (state.hls) { state.hls.destroy(); state.hls = null; state.hlsReady = false; }
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
		// A planned outage is not a failure to retry blindly: show the branded
		// maintenance screen and stop.
		if (data.code === 'MAINTENANCE') {
			showMaintenanceScreen(data.message);
			const stopped = new Error(data.message || 'Tellybox is down for maintenance.');
			stopped.code = 'MAINTENANCE';
			throw stopped;
		}
		const error = new Error(data.error || 'Could not reach Tellybox. Please try again.');
		error.status = response.status; error.code = data.code || null; error.retryAfter = data.retryAfter;
		throw error;
	}
	return response.status === 204 ? null : response.json();
}

function showMaintenanceScreen(message) {
	const overlay = document.getElementById('bootOverlay');
	if (!overlay) return;
	const text = overlay.querySelector('.boot-overlay-text');
	const retry = document.getElementById('bootRetry');
	if (text) text.textContent = message || 'We’re doing some housekeeping. Tellybox will be back shortly.';
	if (retry) {
		retry.hidden = false;
		retry.textContent = 'Try again';
		retry.onclick = () => location.reload();
	}
	overlay.hidden = false;
	overlay.setAttribute('aria-busy', 'true');
	setBackgroundInert(true);
}

// A viewer who is still allowed (for example local access during a remote-only
// maintenance activation) should still be told that maintenance is on.
function renderMaintenanceBanner(state) {
	if (document.getElementById('maintenanceBanner')) return;
	const banner = document.createElement('div');
	banner.id = 'maintenanceBanner';
	banner.className = 'maintenance-banner';
	banner.setAttribute('role', 'status');
	const detail = state.scope === 'remote' ? 'Remote access is blocked.'
		: state.scope === 'local' ? 'Home access is blocked.'
			: 'Everyone is blocked except administrators.';
	banner.textContent = 'Maintenance mode is on. ' + detail;
	document.body.prepend(banner);
}

$('#livePlay').onclick = () => {
	state.playBlocked = false;
	state.playRetry = false;
	$('#playerStatus').textContent = '';
	void beginPlayback(playGeneration);
};
$('#liveMute').onclick = () => { video.muted = !video.muted; updateLiveControls(); };
$('#liveFullscreen').onclick = async () => {
	try { if (fullscreenElement()) await exitFullscreen(); else await requestFullscreenOn($('.video-stage')); }
	catch { /* Fullscreen can be unavailable in some embedded browsers. */ }
};
document.addEventListener('fullscreenchange', updateLiveControls);
document.addEventListener('webkitfullscreenchange', updateLiveControls);

function imageUrl(item, backdrop = false, width = 400) {
	if (backdrop && item.BackdropArtwork) return item.BackdropArtwork;
	if (item.Artwork) return item.Artwork;
	const id = backdrop && !item.BackdropImageTags?.length ? item.ParentBackdropItemId || item.Id : item.Id;
	return `/images/${id}/${backdrop ? 'Backdrop' : 'Primary'}?width=${width}`;
}

function localImageUrl(item, backdrop = false, width = 400) {
	if (backdrop && item.BackdropArtworkLocal) return item.BackdropArtworkLocal;
	if (item.ArtworkLocal) return item.ArtworkLocal;
	if (item.Artwork || item.BackdropArtwork) return '';
	const id = backdrop && !item.BackdropImageTags?.length ? item.ParentBackdropItemId || item.Id : item.Id;
	return `/images/${id}/${backdrop ? 'Backdrop' : 'Primary'}?width=${width}`;
}

// Local library artwork comes from the server's own /images/:id/:kind?width=N
// routine, which accepts a display width and, since release 125, a content
// version, for example /images/<id>/Primary?width=400&v=<12hex>. Parse that
// route rather than anchoring on the exact query string, so a versioned URL
// still gets a 1x and a 2x candidate. The 1x candidate is always the exact URL
// the server supplied; the 2x candidate is the same URL with only the numeric
// width doubled (clamped to the image route's 100..1920) and every other
// parameter, including v, kept as it was. A supplied Artwork/BackdropArtwork
// URL is an opaque signed capability: it is never rewritten, never given a
// srcset and always keeps its place as the primary source.
const localArtworkRoute = /^\/images\/[^/?#]+\/(?:Primary|Backdrop)$/;

function localArtworkWidth(url) {
	const raw = String(url || '');
	if (!raw.startsWith('/images/')) return 0;
	const query = raw.indexOf('?');
	if (query === -1) return 0;
	if (!localArtworkRoute.test(raw.slice(0, query))) return 0;
	const width = Number(new URLSearchParams(raw.slice(query + 1)).get('width'));
	if (!Number.isFinite(width) || width <= 0) return 0;
	return Math.round(width);
}

function localArtworkSrcset(url) {
	const width = localArtworkWidth(url);
	if (!width) return '';
	// The image route accepts 100..1920, so the 2x candidate is clamped to that
	// range. A URL already at (or past) the maximum has no useful 2x candidate.
	const doubled = Math.min(1920, Math.max(100, width * 2));
	if (doubled <= width) return '';
	const candidate = String(url).replace(/([?&]width=)\d+/, '$1' + doubled);
	if (candidate === url) return '';
	return url + ' 1x, ' + candidate + ' 2x';
}

function setArtwork(image, item, backdrop = false, width = 400) {
	const local = localImageUrl(item, backdrop, width);
	if (local) {
		image.dataset.tellyboxLocal = local;
		image.dataset.tellyboxFallback = '1';
	}
	const poster = item && item.poster;
	if (/^\/[A-Za-z0-9_-]+\.(jpg|jpeg|png|webp)$/i.test(poster || '')) image.dataset.tellyboxPoster = 'https://image.tmdb.org/t/p/w342' + poster;
	const source = imageUrl(item, backdrop, width);
	image.src = source;
	// Only a local /images route gets DPR candidates. A supplied signed URL (or
	// another server artwork route) is left exactly as the server sent it.
	const set = localArtworkSrcset(source);
	if (set) image.setAttribute('srcset', set);
	return image;
}

// A channel logo leads the identity when it loads. Until then, and on any
// failure, the channel number and name remain visible as the fallback.
function channelLogo(channel, className = 'guide-logo', onReady = null, onFailure = null) {
	if (!channel?.Artwork) return null;
	const image = element('img', className);
	if (channel.ArtworkLocal) {
		image.dataset.tellyboxLocal = channel.ArtworkLocal;
		image.dataset.tellyboxFallback = '1';
	}
	image.src = channel.Artwork;
	image.alt = '';
	image.loading = 'lazy';
	image.decoding = 'async';
	image.hidden = true;
	image.addEventListener('load', () => {
		image.hidden = false;
		if (onReady) onReady();
	}, { once: true });
	image.addEventListener('error', () => {
		image.remove();
		if (onFailure) onFailure();
	}, { once: true });
	return image;
}

function minutes(ticks) {
	const n = Math.round((ticks || 0) / 6e8);
	return n >= 60 ? `${Math.floor(n / 60)}h ${n % 60}m` : n ? `${n}m` : '';
}

function meta(item) {
	return [item.ProductionYear, item.OfficialRating ? `Age rating: ${item.OfficialRating}` : null, minutes(item.RunTimeTicks)].filter(Boolean).join('  ·  ');
}

function trailerUrl(trailer) {
	if (!trailer || String(trailer.Provider || '').toLowerCase() !== 'youtube') return '';
	const key = String(trailer.Key || '');
	return /^[A-Za-z0-9_-]{11}$/.test(key) ? 'https://www.youtube.com/watch?v=' + key : '';
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

function setPlayerChannelLogo(item) {
	const logo = $('#playerChannelLogo');
	if (!logo) return;
	const artwork = item?.Type === 'TvChannel' ? item.Artwork : '';
	if (!artwork) {
		logo.hidden = true;
		logo.removeAttribute('src');
		return;
	}
	if (logo.getAttribute('src') === artwork) {
		logo.hidden = false;
		return;
	}
	logo.hidden = true;
	logo.alt = '';
	if (item?.ArtworkLocal) {
		logo.dataset.tellyboxLocal = item.ArtworkLocal;
		logo.dataset.tellyboxFallback = '1';
	} else {
		delete logo.dataset.tellyboxLocal;
		delete logo.dataset.tellyboxFallback;
	}
	logo.onload = () => { logo.hidden = false; };
	logo.onerror = () => {
		if (!logo.dataset.tellyboxFallback) {
			logo.hidden = true;
			logo.removeAttribute('src');
		}
	};
	logo.src = artwork;
}

function updatePreviousChannelButton() {
	const button = $('#previousChannel');
	const channel = previousChannel;
	button.replaceChildren();
	if (!channel) {
		button.hidden = true;
		button.removeAttribute('aria-label');
		return;
	}
	const label = element('span', 'previous-label', 'Previous channel');
	const logo = channelLogo(channel, 'previous-channel-logo', () => button.classList.add('logo-only'), () => button.classList.remove('logo-only'));
	if (logo) button.append(logo);
	button.append(label);
	button.hidden = state.playing?.Type !== 'TvChannel' || channel.Id === state.playing?.Id;
	button.setAttribute('aria-label', 'Previous channel: ' + channel.Name);
}

function itemProgress(item) {
	const local = getProgress(item.Id);
	if (local > 0) return local;
	return Math.max(0, Math.round(Number(item.UserData?.PlaybackPositionTicks || 0) / 1e7));
}

// A failed image is hidden rather than removed: the fallback div and title stay
// visible, and Home can reuse the same element when artwork resolves later.
function hideFailedArtwork(image) {
	image.hidden = true;
	image.dataset.tellyboxFailed = '1';
}

function artworkErrorMessage(image) {
	return () => { if (!image.dataset.tellyboxFallback) hideFailedArtwork(image); };
}

function card(item, releaseDate = false, options = {}) {
	const button = element('button', 'card');
	button.dataset.tellyboxItem = item.Id;
	const resume = options.play ? itemProgress(item) : 0;
	button.setAttribute('aria-label', options.play ? `${resume > 30 ? 'Resume' : 'Play'} ${item.Name}` : `${item.Name}, ${friendlyType(item)}`);
	const poster = element('div', 'poster');
	poster.append(element('div', 'fallback', item.Name));
	const image = element('img');
	setArtwork(image, item);
	image.alt = '';
	image.loading = 'lazy';
	image.decoding = 'async';
	image.addEventListener('error', artworkErrorMessage(image));
	poster.append(image, element('span', 'badge', friendlyType(item).toUpperCase()));
	if (options.play) poster.append(element('span', 'play-mark', '▶'));
	if (resume > 30) poster.append(element('span', 'resume-badge', 'Resume - ' + Math.floor(resume / 60) + ' min'));
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
	if (item.Source === 'streamed') button.append(element('span', 'source-note', sourceLabel.streamed(item)));
	button.addEventListener('click', () => options.play ? startPlayback(item, itemProgress(item)) : showDetails(item.Id));
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
	const image = $('#heroImage'); const source = item.Artwork || item.poster; image.hidden = !source;
	if (source) {
		if (item.ArtworkLocal) { image.dataset.tellyboxLocal = item.ArtworkLocal; image.dataset.tellyboxFallback = '1'; }
		else { delete image.dataset.tellyboxLocal; delete image.dataset.tellyboxFallback; }
		image.src = source;
	}
	image.onerror = () => { if (!image.dataset.tellyboxFallback) image.hidden = true; };
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
		if (item.Artwork || item.poster) {
			const image = element('img'); const source = item.Artwork || item.poster;
			if (item.ArtworkLocal) { image.dataset.tellyboxLocal = item.ArtworkLocal; image.dataset.tellyboxFallback = '1'; }
			image.src = source; image.alt = ''; image.loading = 'lazy';
			image.onerror = () => { if (!image.dataset.tellyboxFallback) image.remove(); };
			button.append(image);
		}
		const text = element('div', 'coming-card-text');
		text.append(element('strong', '', item.title), element('span', 'coming-date', `${item.dateLabel} · ${jserverUI.comingDate(item)}`));
		if (item.episode) text.append(element('small', '', `${item.episode} · ${item.episodeTitle}`));
		if (item.type === 'movie') text.append(jserverUI.ratings(item.ratings, { compact: true }));
		button.append(text); button.onclick = () => showComingDetails(item); return button;
	}));
	$('#comingStatus').textContent = coming.unavailable.includes(coming.type === 'tv' ? 'tv' : 'films') ? 'The schedule is temporarily unavailable. Please check back shortly.' : !items.length ? 'Nothing dated yet. As soon as a release is announced, it’ll appear here.' : '';
	$('#comingStatus').hidden = !$('#comingStatus').textContent;
	$('#comingMore').hidden = items.length <= previewCount;
	$('#comingMore').setAttribute('aria-expanded', String(coming.expanded));
	$('#comingMore').textContent = coming.expanded ? 'Show fewer' : `Show all ${items.length} upcoming ${coming.type === 'tv' ? 'episodes' : 'films'}`;
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

if ($('#comingFilters')) $('#comingFilters').onclick = event => {
	const button = event.target.closest('[data-coming]'); if (!button) return;
	coming.type = button.dataset.coming; coming.expanded = false; coming.featured = null;
	for (const tab of document.querySelectorAll('[data-coming]')) { tab.classList.toggle('active', tab === button); tab.setAttribute('aria-pressed', String(tab === button)); }
	renderComing(); anotherPick();
};
if ($('#comingMore')) $('#comingMore').onclick = () => { coming.expanded = !coming.expanded; renderComing(); };

function homeContextPayload() {
	// Browser-local taste votes belong to the previous local viewer. A remote
	// authenticated account must not inherit them (or their disliked/remembered
	// shows) any more than it inherits their watch progress.
	const taste = browserProgressTrusted()
		? (() => { try { return window.TellyboxTaste?.payload?.() || null; } catch { return null; } })()
		: null;
	const favourites = Object.keys(readFavourites());
	const watched = [], progress = {};
	try {
		// Only a local or at-home viewer owns the browser's progress record. A
		// remote account sends the same payload shape with no browser progress,
		// so another account's positions and watched markers never leave this
		// browser on their behalf.
		if (browserProgressTrusted()) {
			for (let index = 0; index < localStorage.length; index++) {
				const key = localStorage.key(index);
				if (key?.startsWith('tellybox-watched-') && localStorage.getItem(key) === 'true') watched.push(key.slice('tellybox-watched-'.length));
				if (key?.startsWith('jimbo-progress-')) {
					const value = Number(localStorage.getItem(key));
					if (Number.isFinite(value) && value > 0) progress[key.slice('jimbo-progress-'.length)] = value;
				}
			}
		}
	} catch { /* Browser storage is optional. */ }
	return { taste, favourites: favourites.slice(0, 1000), watched: watched.slice(-5000), progress };
}

async function refreshHomeFeedAvailability(generation, context, attempt) {
	if (attempt > homeAvailabilityRetryLimit) return;
	await new Promise(resolve => setTimeout(resolve, availabilityPollDelay));
	// The Home feed and a new context (or a newer request) both invalidate this
	// retry. Rows stay on screen while it runs; only the checking notice changes.
	if (generation !== homeFeedState.generation) return;
	const payload = homeContextPayload();
	if (JSON.stringify(payload) !== context) return;
	let data;
	try { data = await api('/api/web/home', payload); }
	catch { return; } // Keep the first paint; a later refresh is the retry.
	if (generation !== homeFeedState.generation) return;
	homeFeedState.data = data;
	homeFeedState.fetchedAt = Date.now();
	// Keep the snapshot current after verification so a new tab's instant paint
	// does not re-advertise rows that have since been proven unavailable.
	writeHomeCache(homeFeedState.access, data);
	const signature = homeFeedSignature(data) + '|ep' + likedEpisodesSignature();
	if (signature === homeFeedState.signature) {
		// The verification pass returned the same picks; update the quiet status
		// only. Rebuilding identical rows would flicker the cards the viewer is
		// reading and reset their position.
		const artworkSignature = homeArtworkSignature(data);
		if (artworkSignature !== homeFeedState.artworkSignature) {
			// Artwork resolved without changing the rows: swap the images in place.
			// A deferred pass (details, player, session or casting) is retried after
			// the surface closes, so the signature is only recorded once it ran.
			rehydrateHomeArtwork(data);
			if (!details.open && !player.open && !state.session && !casting.active && isHomeView()) homeFeedState.artworkSignature = artworkSignature;
		}
		applyHomeFeedStatus(data);
	} else {
		renderHomeFeed();
	}
	if (feedAvailabilityPending(data) > 0) {
		if (attempt >= homeAvailabilityRetryLimit) {
			// Stop quietly rather than keeping a checking notice on the page.
			const status = $('#homeFeedStatus');
			if (status) status.textContent = '';
		} else void refreshHomeFeedAvailability(generation, context, attempt + 1).catch(() => {});
	}
	// A verification pass can expose cards that were waiting on row checks.
	// Continue any existing artwork budget rather than starting a fresh one.
	startHomeArtworkContinuation(false);
}

// ---------------------------------------------------------------------------
// Viewport stability helpers
// ---------------------------------------------------------------------------

// The nearest landing-level section under the viewport top. Insertions above it
// must not move it; preserveScrollAnchor keeps it pinned while the page settles.
function viewportAnchor() {
	const probe = document.elementFromPoint(Math.min(innerWidth - 16, 220), Math.min(innerHeight - 8, Math.max(8, innerHeight * 0.18)));
	if (!probe) return null;
	let node = probe;
	while (node && node !== document.body) {
		if (node.matches && node.matches('main > section, main, header, footer')) return node;
		node = node.parentElement;
	}
	return null;
}

// Run a DOM change, then adjust the scroll so the anchored section keeps its
// exact viewport position. A hidden/replaced anchor (for example a closed
// dialog) leaves the scroll untouched. This keeps the reading position stable
// when Home sections appear, collapse or grow above what the viewer reads.
function preserveScrollAnchor(change) {
	const host = document.scrollingElement || document.documentElement;
	const anchor = viewportAnchor();
	const anchorTop = anchor ? anchor.getBoundingClientRect().top : 0;
	const beforeY = host ? host.scrollTop : 0;
	change();
	if (!host) return;
	if (anchor && anchor.isConnected && !anchor.hidden && anchor.getClientRects().length) {
		const delta = anchor.getBoundingClientRect().top - anchorTop;
		// Only compensate when the viewer has actually scrolled below the top:
		// a top-of-page viewer watches the page fill in above them and must not
		// be pushed down by content that appears above the fold. Re-asserting
		// the (unchanged) entry scroll also stops Chrome's native scroll
		// anchoring from re-adjusting behind the change.
		if (beforeY > 0 && Number.isFinite(delta)) host.scrollTop = beforeY + delta;
		else host.scrollTop = beforeY;
		return;
	}
	// No anchor to pin (for example a modal dialog owns the screen, or the
	// anchored section was removed by this change). Re-asserting the entry
	// scroll also stops Chrome's native scroll anchoring from re-adjusting the
	// page behind the change.
	host.scrollTop = beforeY;
}

function applyHomeFeedStatus(data) {
	const status = $('#homeFeedStatus');
	if (!status) return;
	const pending = pendingAvailability(data);
	// Quiet, non-blocking live status: it clears as soon as the feed settles.
	status.textContent = pending ? 'Checking a few more titles...' : '';
}

function homeFeedSignature(data) {
	if (!data) return '';
	return [
		...(data.rows || []).filter(row => homeRowAllowed.has(row.id)).map(row => (row.id || '') + '=' + (row.items || []).map(item => item?.Id || '').join(',')),
	].join('|');
}

// Artwork can resolve after the rows themselves are settled. Track only the
// rendered rows and the fields that decide a card image, so a changed image
// can be swapped in place instead of rebuilding (and flickering) every row.
function homeArtworkSignature(data) {
	if (!data) return '';
	return orderedHomeRows(data).map(row => (row.id || '') + '=' + (row.items || []).map(item => [
		item?.Id || '', item?.Artwork || '', item?.BackdropArtwork || '',
	].join('~')).join(',')).join('|');
}

function likedEpisodesSignature() {
	return (newEpisodesRowData()?.items || []).map(item => item?.Id || '').join(',');
}

// Series the viewer likes: server-synced favourites for the signed-in account,
// plus this browser profile's own watch markers and votes when the viewer is
// local or at home. A remote account must not inherit `tellybox-series-*` keys
// or `tellybox-taste` votes left by whoever watched here last; its favourites
// already arrived from the server and stay in the set.
function likedSeriesIds() {
	const liked = new Set(), disliked = new Set();
	try {
		for (const item of Object.values(readFavourites())) {
			if (item?.Type === 'Series' && typeof item.Id === 'string') liked.add(item.Id);
		}
		if (!browserProgressTrusted()) return liked;
		for (let index = 0; index < localStorage.length; index += 1) {
			const key = localStorage.key(index);
			if (key?.startsWith('tellybox-series-')) liked.add(key.slice('tellybox-series-'.length));
		}
		// The visible Like/Not for me controls persist in tellybox-taste. A
		// positive series vote counts as a liked show even without a favourite;
		// a negative vote wins for this recommendation rail while the favourite
		// itself is left intact. Both are local-viewer signals only.
		const data = JSON.parse(localStorage.getItem('tellybox-taste') || '{}');
		for (const [id, vote] of Object.entries(data.votes || {})) {
			if (Number(vote?.value) > 0) liked.add(id);
			if (Number(vote?.value) < 0) {
				disliked.add(id);
				if (typeof vote?.watchId === 'string') disliked.add(vote.watchId);
			}
		}
		for (const id of disliked) liked.delete(id);
	} catch { /* Browser storage is optional. */ }
	return liked;
}

function watchedLocally(id) {
	if (!browserProgressTrusted()) return false;
	try { return localStorage.getItem('tellybox-watched-' + id) === 'true'; } catch { return false; }
}

function episodeFinishedLocally(episode) {
	if (!browserProgressTrusted()) return episode?.UserData?.Played === true;
	if (watchedLocally(episode.Id)) return true;
	const progress = Number(itemProgress(episode.Id)) || 0;
	const runtime = Number(episode.RunTimeTicks) / 1e7;
	return runtime > 0 && progress > 0 && progress >= runtime - 30;
}

// The Home "New episodes" rail comes from the dedicated releases endpoint,
// called only for a bounded list of series this profile likes or watches.
// Nothing is invented: a failed or empty response simply omits the rail.
function likedSeriesRequest(liked) {
	// The endpoint accepts only real series ids. Browser favourites or votes can
	// contain other id shapes; never send the whole request malformed for one.
	const accepted = /^(?:[a-f0-9-]{32,36}|dispatch-series-[1-9][0-9]*)$/i;
	return [...liked].filter(id => typeof id === 'string' && accepted.test(id)).sort().slice(0, 50);
}

function likedSeriesKey(liked) {
	return [...liked].sort().join('|');
}

// One history snapshot for this rail. Local browser progress is only trusted
// for a local or at-home viewer; a remote account never inherits it.
function localEpisodeHistory() {
	const watched = new Set(), positions = new Map();
	if (!browserProgressTrusted()) return { watched, positions };
	try {
		for (let index = 0; index < localStorage.length; index += 1) {
			const key = localStorage.key(index);
			if (!key) continue;
			if (key.startsWith('tellybox-watched-') && localStorage.getItem(key) === 'true') {
				watched.add(key.slice('tellybox-watched-'.length));
			} else if (key.startsWith('jimbo-progress-')) {
				const value = Number(localStorage.getItem(key));
				if (Number.isFinite(value) && value > 0) positions.set(key.slice('jimbo-progress-'.length), value);
			}
		}
	} catch { /* Browser storage is optional. */ }
	return { watched, positions };
}

function episodeAliasIds(episode) {
	const values = new Set();
	const add = value => { if (typeof value === 'string' && value.trim()) values.add(value.trim().toLowerCase()); };
	add(episode?.Id);
	if (Array.isArray(episode?.VodIds)) for (const value of episode.VodIds) add(value);
	return values;
}

function episodeRuntimeSeconds(episode) {
	return Math.max(0, Number(episode?.RunTimeTicks) / 1e7 || 0);
}

function historyPosition(history, episode) {
	let position = Math.max(0, Number(episode?.UserData?.PlaybackPositionTicks) / 1e7 || 0);
	for (const alias of episodeAliasIds(episode)) position = Math.max(position, Number(history.positions.get(alias)) || 0);
	return position;
}

function historyWatched(history, episode) {
	if (episode?.UserData?.Played === true) return true;
	for (const alias of episodeAliasIds(episode)) if (history.watched.has(alias)) return true;
	return false;
}

function episodeAvailableNow(episode, now) {
	if (!episode || episode.Type !== 'Episode') return false;
	if (typeof episode.Id !== 'string' || !episode.Id) return false;
	// The endpoint already filters these; checking again keeps a stale or
	// streamed row from becoming a playable card.
	if (episode.IsMissing === true || episode.IsUnaired === true || episode.IsVirtualItem === true) return false;
	const season = Number(episode.ParentIndexNumber), number = Number(episode.IndexNumber);
	if (!Number.isInteger(season) || season <= 0 || !Number.isInteger(number) || number <= 0) return false;
	const premiere = Date.parse(episode.PremiereDate);
	if (Number.isFinite(premiere) && premiere > now) return false;
	return true;
}

// Canonical show identity from stable ids only: a local series and its provider
// alias are linked by VodIds, never by title text.
function seriesCanonicalIndex(episodes, extraIds) {
	const parent = new Map();
	const keyOf = value => typeof value === 'string' ? value.trim().toLowerCase() : '';
	const add = value => {
		const key = keyOf(value);
		if (key && !parent.has(key)) parent.set(key, key);
		return key;
	};
	const find = key => {
		let root = parent.get(key);
		if (root === undefined) { parent.set(key, key); return key; }
		if (root === key) return key;
		root = find(root);
		parent.set(key, root);
		return root;
	};
	const union = (first, second) => {
		const a = add(first), b = add(second);
		if (!a || !b) return;
		const rootA = find(a), rootB = find(b);
		if (rootA !== rootB) parent.set(rootB, rootA);
	};
	const link = (item, seriesValue) => {
		const series = add(seriesValue);
		if (!series) return;
		const values = Array.isArray(item?.VodIds) ? item.VodIds : [];
		for (const raw of values) {
			const value = String(raw ?? '').trim();
			if (/^[1-9][0-9]{0,9}$/.test(value)) union(series, 'dispatch-series-' + value);
			else if (/^dispatch-series-[1-9][0-9]*$/i.test(value)) union(series, value);
		}
	};
	try {
		for (const item of Object.values(readFavourites())) if (item?.Type === 'Series') link(item, item.Id);
	} catch { /* Browser storage is optional. */ }
	for (const episode of Array.isArray(episodes) ? episodes : []) link(episode, episode?.SeriesId);
	for (const id of Array.isArray(extraIds) ? extraIds : []) add(id);
	return value => {
		const key = keyOf(value);
		if (!key) return '';
		if (!parent.has(key)) return key;
		const root = find(key);
		let fallback = '', real = '';
		for (const alias of parent.keys()) {
			if (find(alias) !== root) continue;
			if (!fallback || alias < fallback) fallback = alias;
			if (!alias.startsWith('dispatch-series-') && /^[a-f0-9-]{32,36}$/i.test(alias) && (!real || alias < real)) real = alias;
		}
		return real || fallback || key;
	};
}

function firstEpisodeAfter(show, season, number, history) {
	let best = null;
	for (const episode of show.episodes.values()) {
		const candidateSeason = Number(episode.ParentIndexNumber), candidateNumber = Number(episode.IndexNumber);
		if (candidateSeason < season || (candidateSeason === season && candidateNumber <= number)) continue;
		const runtime = episodeRuntimeSeconds(episode);
		const position = historyPosition(history, episode);
		const watched = historyWatched(history, episode);
		if (watched || (runtime > 0 && position > 0 && position >= runtime - 30)) continue;
		// Do not jump past an episode the viewer has already started.
		if (position > 10) continue;
		if (!best || candidateSeason < Number(best.ParentIndexNumber)
			|| (candidateSeason === Number(best.ParentIndexNumber) && candidateNumber < Number(best.IndexNumber))) best = episode;
	}
	return best;
}

function firstRegularEpisode(show, history) {
	let best = null;
	for (const episode of show.episodes.values()) {
		const season = Number(episode.ParentIndexNumber), number = Number(episode.IndexNumber);
		if (season <= 0 || number <= 0) continue;
		const runtime = episodeRuntimeSeconds(episode);
		const position = historyPosition(history, episode);
		const watched = historyWatched(history, episode);
		if (watched || (runtime > 0 && position > 0 && position >= runtime - 30)) continue;
		if (position > 10) continue;
		if (!best || season < Number(best.ParentIndexNumber)
			|| (season === Number(best.ParentIndexNumber) && number < Number(best.IndexNumber))) best = episode;
	}
	return best;
}

function newEpisodesRowData() {
	const liked = likedSeriesIds();
	if (!liked.size || !likedEpisodesState.loaded) return null;
	if (likedEpisodesState.key !== likedSeriesKey(liked)) return null;
	const raw = Array.isArray(likedEpisodesState.items) ? likedEpisodesState.items : [];
	// Continue wins: an unfinished current episode already on screen must not
	// reappear here as a different episode of the same show.
	const continueItems = (homeFeedState.data?.rows || [])
		.filter(row => row?.id === 'continue')
		.flatMap(row => Array.isArray(row.items) ? row.items : []);
	const canonical = seriesCanonicalIndex(raw, [...liked, ...continueItems.map(item => item?.SeriesId)]);
	const continueShows = new Set();
	for (const item of continueItems) {
		if (item?.Type !== 'Episode' || typeof item.SeriesId !== 'string') continue;
		const key = canonical(item.SeriesId);
		if (key) continueShows.add(key);
	}
	const likedShows = new Set();
	for (const id of liked) { const key = canonical(id); if (key) likedShows.add(key); }
	const now = Date.now();
	const shows = new Map();
	for (const episode of raw) {
		if (!episodeAvailableNow(episode, now)) continue;
		const key = canonical(episode.SeriesId);
		if (!key || !likedShows.has(key) || continueShows.has(key)) continue;
		let show = shows.get(key);
		if (!show) {
			show = { id: key, name: '', episodes: new Map() };
			shows.set(key, show);
		}
		if (!show.name && typeof episode.SeriesName === 'string' && episode.SeriesName.trim()) show.name = episode.SeriesName.trim();
		const numberKey = Number(episode.ParentIndexNumber) + ':' + Number(episode.IndexNumber);
		const existing = show.episodes.get(numberKey);
		// A local copy wins over a streamed alias of the same episode.
		if (!existing || (existing.Source === 'streamed' && episode.Source !== 'streamed')) show.episodes.set(numberKey, episode);
	}
	if (!shows.size) return null;
	const history = localEpisodeHistory();
	const chosen = [];
	for (const show of shows.values()) {
		let resume = null, resumePosition = 0;
		let furthestSeason = 0, furthestNumber = 0;
		for (const episode of show.episodes.values()) {
			const season = Number(episode.ParentIndexNumber), number = Number(episode.IndexNumber);
			const runtime = episodeRuntimeSeconds(episode);
			const position = historyPosition(history, episode);
			const watched = historyWatched(history, episode);
			const finished = watched || (runtime > 0 && position > 0 && position >= runtime - 30);
			const engaged = finished || position > 10;
			if (!finished && position > 10 && (resume === null || position > resumePosition
				|| (position === resumePosition && season * 10000 + number > Number(resume.ParentIndexNumber) * 10000 + Number(resume.IndexNumber)))) {
				resume = episode;
				resumePosition = position;
			}
			if (engaged && (season > furthestSeason || (season === furthestSeason && number > furthestNumber))) {
				furthestSeason = season;
				furthestNumber = number;
			}
		}
		let pick = null;
		if (resume) pick = resume;
		else if (furthestSeason > 0) pick = firstEpisodeAfter(show, furthestSeason, furthestNumber, history);
		else pick = firstRegularEpisode(show, history);
		if (pick) chosen.push({ show, episode: pick });
	}
	if (!chosen.length) return null;
	chosen.sort((a, b) => {
		const dateA = Date.parse(a.episode.PremiereDate), dateB = Date.parse(b.episode.PremiereDate);
		if (Number.isFinite(dateA) && Number.isFinite(dateB) && dateA !== dateB) return dateB - dateA;
		if (Number.isFinite(dateB) && !Number.isFinite(dateA)) return 1;
		if (Number.isFinite(dateA) && !Number.isFinite(dateB)) return -1;
		const nameA = (a.show.name || a.episode.SeriesName || a.episode.Name || '').toLowerCase();
		const nameB = (b.show.name || b.episode.SeriesName || b.episode.Name || '').toLowerCase();
		if (nameA !== nameB) return nameA < nameB ? -1 : 1;
		return a.episode.Id.localeCompare(b.episode.Id);
	});
	return {
		id: 'new-episodes',
		title: 'New episodes of your shows',
		note: 'Fresh episodes from the shows you like',
		items: chosen.slice(0, 12).map(entry => entry.episode),
	};
}

async function loadLikedEpisodes() {
	const liked = likedSeriesIds();
	if (!liked.size) {
		likedEpisodesState.key = '';
		likedEpisodesState.items = [];
		likedEpisodesState.loaded = true;
		likedEpisodesState.failed = false;
		if (homeFeedState.data && isHomeView()) renderHomeFeed();
		return;
	}
	const key = likedSeriesKey(liked);
	if (likedEpisodesState.loading && likedEpisodesState.key === key) return;
	if (likedEpisodesState.loaded && !likedEpisodesState.failed && likedEpisodesState.key === key) return;
	const request = likedSeriesRequest(liked);
	if (!request.length) {
		// Nothing this endpoint can query. Do not send a malformed request.
		likedEpisodesState.key = key;
		likedEpisodesState.items = [];
		likedEpisodesState.loaded = true;
		likedEpisodesState.failed = false;
		likedEpisodesState.loading = false;
		if (homeFeedState.data && isHomeView()) renderHomeFeed();
		return;
	}
	const generation = ++likedEpisodesState.generation;
	likedEpisodesState.key = key;
	likedEpisodesState.loading = true;
	likedEpisodesState.failed = false;
	try {
		const data = await api('/api/web/releases/episodes?' + new URLSearchParams({ series: request.join(',') }));
		if (generation !== likedEpisodesState.generation) return;
		likedEpisodesState.items = Array.isArray(data?.items) ? data.items : [];
		likedEpisodesState.loaded = true;
	} catch {
		if (generation !== likedEpisodesState.generation) return;
		// Omit the rail quietly. A later favourites or taste change retries.
		likedEpisodesState.items = [];
		likedEpisodesState.loaded = true;
		likedEpisodesState.failed = true;
	} finally {
		if (generation === likedEpisodesState.generation) likedEpisodesState.loading = false;
	}
	if (homeFeedState.data && isHomeView()) renderHomeFeed();
}

function homeEpisodeTile(episode) {
	const seriesName = typeof episode.SeriesName === 'string' ? episode.SeriesName.trim() : '';
	const title = seriesName || episode.Name;
	const wrap = element('div', 'home-tile');
	// Keep the real episode as the playback item so the player still shows the
	// episode name, but present the series name as the row's card title.
	const button = card(episode, false, { play: true });
	const heading = button.querySelector('h3');
	if (heading) heading.textContent = title;
	const fallback = button.querySelector('.poster .fallback');
	if (fallback) fallback.textContent = title;
	const number = [Number.isInteger(episode.ParentIndexNumber) && episode.ParentIndexNumber > 0 ? 'S' + episode.ParentIndexNumber : '',
		Number.isInteger(episode.IndexNumber) && episode.IndexNumber > 0 ? 'E' + episode.IndexNumber : ''].filter(Boolean).join(' ');
	const date = Date.parse(episode.PremiereDate);
	const dateLabel = Number.isFinite(date) ? new Date(episode.PremiereDate).toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' }) : '';
	const episodeName = episode.Name && episode.Name !== title ? episode.Name : '';
	const meta = button.querySelector('p');
	if (meta) meta.textContent = [number, episodeName, dateLabel].filter(Boolean).join(' · ');
	const verb = itemProgress(episode) > 30 ? 'Resume' : 'Play';
	button.setAttribute('aria-label', [verb, title, number, episodeName].filter(Boolean).join(' · '));
	wrap.append(button);
	const more = element('button', 'button quiet home-info', 'More info');
	more.setAttribute('aria-label', `More info about ${title}${number ? ' ' + number : ''}${episodeName ? ' · ' + episodeName : ''}`);
	more.onclick = () => showDetails(episode.Id);
	wrap.append(more);
	return wrap;
}

// Order, dedupe and sanity-check the focused Home rails. The server's other
// rows (favourites, genre, films, series, top rated) are deliberately not
// rendered here; they remain available through their own views and filters.
function orderedHomeRows(data) {
	const byId = new Map();
	for (const row of data.rows || []) {
		if (!row || !homeRowAllowed.has(row.id) || byId.has(row.id)) continue;
		byId.set(row.id, row);
	}
	const source = [];
	if (byId.has('continue')) source.push(byId.get('continue'));
	const episodeRow = newEpisodesRowData();
	if (episodeRow) source.push(episodeRow);
	if (byId.has('for-you')) source.push(byId.get('for-you'));
	if (byId.has('new')) source.push(byId.get('new'));
	const seen = new Set();
	const prepared = source.map((row, index) => {
		const copy = { ...row, _position: homeRowOrder[row.id], _index: index };
		copy.items = (Array.isArray(row.items) ? row.items : []).filter(item => {
			if (!item || typeof item.Id !== 'string' || !item.Id || typeof item.Name !== 'string' || !item.Name) return false;
			if (seen.has(item.Id)) return false;
			seen.add(item.Id);
			return true;
		}).slice(0, 12);
		if (copy.id === 'continue' && !copy.note) copy.note = 'Right where you left off';
		return copy;
	}).filter(row => row.items.length);
	prepared.sort((a, b) => a._position - b._position || a._index - b._index);
	return prepared.map(({ _position, _index, ...row }) => row);
}

// Swap only the Home card images whose artwork actually changed. The rendered
// holders are matched by item id, so unknown ids are never guessed at. An
// image that failed earlier is reused rather than duplicated: its staged
// fallback datasets are cleared and setArtwork restarts the same precedence.
// Returns the number of images updated, or 0 when Home cannot be touched.
function rehydrateHomeArtwork(data) {
	if (!data || !isHomeView()) return 0;
	if (details.open || player.open || state.session || casting.active) {
		// The close handlers apply this in place after focus returns to the card.
		// A full row rebuild there would be deferred again by renderHomeFeed's
		// focus guard, so keep the artwork pass separate from row deferral.
		homeFeedState.artworkDeferred = true;
		return 0;
	}
	homeFeedState.artworkDeferred = false;
	const rows = $('#homeRows');
	if (!rows) return 0;
	const items = new Map();
	for (const row of orderedHomeRows(data)) {
		for (const item of row.items || []) {
			if (item && typeof item.Id === 'string' && !items.has(item.Id)) items.set(item.Id, item);
		}
	}
	let updated = 0;
	for (const holder of rows.querySelectorAll('[data-tellybox-item]')) {
		const item = items.get(holder.dataset.tellyboxItem);
		if (!item) continue;
		const resume = holder.classList.contains('continue-card');
		const poster = resume ? null : holder.querySelector('.poster');
		if (!resume && !poster) continue;
		const width = resume ? 640 : 400;
		const source = imageUrl(item, resume, width);
		let image = holder.querySelector(resume ? '.continue-art-image' : '.poster img');
		if (image && !image.hidden && !image.dataset.tellyboxFailed && (image.getAttribute('src') || '') === source) continue;
		if (!image) {
			image = element('img', resume ? 'continue-art-image' : '');
			image.alt = '';
			image.loading = 'lazy';
			image.decoding = 'async';
			image.addEventListener('error', artworkErrorMessage(image));
			if (resume) holder.prepend(image);
			else {
				const fallback = poster.querySelector('.fallback');
				if (fallback) fallback.after(image);
				else poster.prepend(image);
			}
		}
		delete image.dataset.tellyboxLocal;
		delete image.dataset.tellyboxPoster;
		delete image.dataset.tellyboxFallback;
		delete image.dataset.tellyboxArtworkStage;
		delete image.dataset.tellyboxFailed;
		image.hidden = false;
		setArtwork(image, item, resume, width);
		updated += 1;
	}
	return updated;
}

// Apply artwork that resolved while details, the player or casting owned the
// screen. This is an in-place image swap, so it is safe while focus returns to
// the card that opened the overlay; it never rebuilds the rows.
function applyDeferredHomeArtwork() {
	if (!homeFeedState.artworkDeferred || !homeFeedState.data) return 0;
	if (!isHomeView()) return 0;
	if (details.open || player.open || state.session || casting.active) return 0;
	const signature = homeArtworkSignature(homeFeedState.data);
	if (signature === homeFeedState.artworkSignature) {
		homeFeedState.artworkDeferred = false;
		return 0;
	}
	const updated = rehydrateHomeArtwork(homeFeedState.data);
	homeFeedState.artworkSignature = signature;
	return updated;
}

// ---------------------------------------------------------------------------
// Bounded artwork continuation (light route)
// ---------------------------------------------------------------------------
// `remaining` is the honest "missing or still pending" count from the server.
// It can be non-zero while nothing is pending when the initial feed selected
// fewer candidates than the visible rails contain, so it starts the loop just
// like `pending` does. A failed/cached item is not "remaining" and never keeps
// this loop alive.
function artworkContinuationPending(data) {
	const artwork = data?.availability?.artwork;
	if (!artwork) return false;
	const remaining = Number(artwork.remaining);
	const pending = Number(artwork.pending);
	return (Number.isFinite(remaining) && remaining > 0) || (Number.isFinite(pending) && pending > 0);
}

function stopHomeArtworkContinuation() {
	homeArtworkPoll.token += 1;
	homeArtworkPoll.active = false;
}

// Only explicit Home entry (click, brand link, popstate return) and a newly
// validated auth scope may hand out another restart allowance. Background
// refreshes, favourites reconciliation and Continue changes never do.
function resetHomeArtworkRestartBudget() {
	homeFeedState.artworkRestartBudget = homeArtworkRestartLimit;
}

function startHomeArtworkContinuation(restart = true) {
	// A full-feed refresh can render again while the artwork loop is already
	// running; it continues that budget instead of starting a fresh one. A new
	// feed or a returning Home view always supersedes the older loop, so two
	// schedules can never run over the same cards.
	if (!restart && homeArtworkPoll.active) return 0;
	stopHomeArtworkContinuation();
	if (!isHomeView() || !artworkContinuationPending(homeFeedState.data)) return 0;
	const token = homeArtworkPoll.token;
	homeArtworkPoll.active = true;
	void continueHomeArtwork(homeFeedState.generation, homeFeedState.context, homeFeedState.scope, token).catch(() => {}).finally(() => {
		if (token === homeArtworkPoll.token) homeArtworkPoll.active = false;
	});
	return token;
}

async function continueHomeArtwork(generation, context, scope, token) {
	for (let attempt = 0; attempt < homeArtworkPollLimit; attempt += 1) {
		const delay = homeArtworkPollDelays[Math.min(attempt, homeArtworkPollDelays.length - 1)];
		await new Promise(resolve => setTimeout(resolve, delay));
		// Every reason to abandon the loop is re-checked after the wait: a newer
		// feed generation, another account/source context, a non-Home view or a
		// player/cast surface taking the screen.
		if (token !== homeArtworkPoll.token) return;
		if (generation !== homeFeedState.generation) return;
		if (context !== homeFeedState.context || scope !== homeFeedState.scope) return;
		if (!isHomeView() || player.open || state.session || casting.active) return;
		if (!artworkContinuationPending(homeFeedState.data)) return;
		const result = await refreshHomeArtwork(generation);
		if (token !== homeArtworkPoll.token) return;
		// A failed check uses the remaining attempt budget: the next scheduled
		// check is the retry, so there is no unbounded loop or request storm.
		if (!result) continue;
		if (result.restart) {
			// Session expired or the account/source changed: rebuild the feed once
			// instead of trying to patch artwork into a stale scope. The allowance
			// lives on homeFeedState, so the reload cannot hand this loop (or the
			// next one) an unlimited supply of restarts.
			stopHomeArtworkContinuation();
			const budget = Number(homeFeedState.artworkRestartBudget);
			if (Number.isFinite(budget) && budget > 0) {
				homeFeedState.artworkRestartBudget = budget - 1;
				void loadHomeFeed(true, { internal: true });
			} else {
				// Out of allowance: keep the honest card/poster placeholders and
				// stop claiming that more artwork is still on its way. No further
				// full Home POST is sent for artwork.
				const status = $('#homeFeedStatus');
				if (status && feedAvailabilityPending(homeFeedState.data) === 0) status.textContent = '';
			}
			return;
		}
		if (!artworkContinuationPending(homeFeedState.data)) return;
	}
}

// One lightweight artwork check. Returns the response, or null for a transient
// failure/no-op. A restart response is applied as no artwork and handled by the
// bounded loop so a superseded token can never trigger an extra rebuild.
async function refreshHomeArtwork(generation) {
	if (generation !== homeFeedState.generation) return null;
	let result;
	try { result = await api('/api/web/home/artwork', {}); }
	catch { return null; }
	if (generation !== homeFeedState.generation) return null;
	if (result && !result.restart) applyHomeArtwork(result);
	return result;
}

// Apply only the changed artwork fields from /api/web/home/artwork. Rows are
// never rebuilt here: the ids already on screen are matched in place, so scroll,
// focus, an open More info dialog and mixed row/artwork updates stay safe.
function applyHomeArtwork(result) {
	const data = homeFeedState.data;
	if (!data || !result) return 0;
	const byId = new Map();
	for (const update of Array.isArray(result.updates) ? result.updates : []) {
		if (update && typeof update.Id === 'string' && update.Id) byId.set(update.Id, update);
	}
	let changed = 0;
	if (byId.size) {
		const items = [];
		for (const row of Array.isArray(data.rows) ? data.rows : []) {
			if (Array.isArray(row?.items)) items.push(...row.items);
		}
		if (Array.isArray(data.featured)) items.push(...data.featured);
		for (const item of items) {
			const update = item && byId.get(item.Id);
			if (!update) continue;
			for (const field of ['Artwork', 'BackdropArtwork', 'ArtworkLocal', 'BackdropArtworkLocal']) {
				const value = update[field];
				if (typeof value === 'string' && value && value !== item[field]) {
					item[field] = value;
					changed += 1;
				}
			}
		}
	}
	if (result.availability && typeof result.availability === 'object') {
		data.availability = { ...(data.availability || {}), artwork: result.availability };
	}
	if (changed) {
		const signature = homeArtworkSignature(data);
		rehydrateHomeArtwork(data);
		if (!details.open && !player.open && !state.session && !casting.active && isHomeView()) homeFeedState.artworkSignature = signature;
	}
	applyHomeFeedStatus(data);
	return changed;
}

// A single compact skeleton rail occupies the same geometry as Continue
// watching while the feed loads, so the first real rail does not push the
// heading or discovery strip around. There is no hero skeleton.
function renderHomeSkeleton() {
	const rows = $('#homeRows');
	if (rows) {
		const section = element('section', 'home-row home-row--continue home-row--skeleton');
		const heading = element('div', 'shelf-heading');
		heading.append(element('h2', '', 'Continue watching'), element('p', 'shelf-description', 'Right where you left off'));
		const grid = element('div', 'release-grid home-row-grid');
		for (let index = 0; index < 3; index += 1) {
			const tile = element('div', 'continue-card continue-card--skeleton');
			tile.setAttribute('aria-hidden', 'true');
			tile.append(element('span', 'continue-skeleton-line continue-skeleton-title'), element('span', 'continue-skeleton-line continue-skeleton-meta'), element('span', 'continue-skeleton-line continue-skeleton-action'));
			grid.append(tile);
		}
		section.append(heading, grid);
		rows.replaceChildren(section);
	}
	const status = $('#homeFeedStatus');
	if (status) status.textContent = '';
	const container = $('#homeFeed');
	if (container) container.hidden = false;
	homeSkeletonShown = true;
}

function renderHomeFeedError() {
	const rows = $('#homeRows');
	if (!rows) return;
	const section = element('section', 'home-row home-error');
	section.setAttribute('aria-labelledby', 'homeErrorTitle');
	const heading = element('div', 'shelf-heading');
	const title = element('h2', '', 'Home is taking a break');
	title.id = 'homeErrorTitle';
	heading.append(title);
	const note = element('p', 'shelf-description', 'We could not load your picks just now.');
	const retry = element('button', 'button secondary', 'Try again');
	retry.type = 'button';
	retry.onclick = () => {
		retry.disabled = true;
		retry.textContent = 'Trying again...';
		homeFeedState.failed = false;
		homeFeedState.settled = false;
		homeSkeletonShown = false;
		renderHomeSkeleton();
		updateHomeSections();
		void loadHomeFeed(true);
	};
	section.append(heading, note, retry);
	rows.replaceChildren(section);
	const status = $('#homeFeedStatus');
	if (status) status.textContent = '';
	const container = $('#homeFeed');
	if (container) container.hidden = false;
	updateHomeFooter();
}

async function loadHomeFeed(force = false, { internal = false } = {}) {
	const container = $('#homeFeed');
	if (!container) return;
	// Home never paints before the auth scope is known.
	if (!homeFeedState.authReady) return;
	// Favourites are part of the feed context. Await the request init already
	// started so this request carries them; only a feed that genuinely began
	// without that context is reconciled by init.
	if (serverFavouritesRequired && !sharedFavourites && homeFavouritesRequest) {
		try {
			const favourites = await homeFavouritesRequest;
			if (favourites) sharedFavourites = favourites.own;
			homeFeedState.favouritesSettled = Boolean(favourites);
		} catch {}
		homeFavouritesRequest = null;
	} else if (!serverFavouritesRequired) homeFeedState.favouritesSettled = true;
	const payload = homeContextPayload(), context = JSON.stringify(payload);
	if (!force && homeFeedState.data && homeFeedState.context === context && Date.now() - homeFeedState.fetchedAt < 30 * 60 * 1000) return;
	if (homeFeedState.loading) {
		// A forced refresh queued behind the in-flight request runs once that
		// request settles. This is how a favourites/context change that arrived
		// after the first Home request is reconciled without blocking the paint.
		// An internal restart reload keeps its marker so the queued pass cannot
		// create a fresh artwork restart allowance.
		if (force) {
			homeFeedState.queued = true;
			if (internal) homeFeedState.queuedInternal = true;
		}
		return;
	}
	homeFeedState.loading = true;
	homeFeedState.deferred = false;
	homeFeedState.failed = false;
	stopHomeArtworkContinuation();
	const generation = ++homeFeedState.generation;
	$('#homeFeedStatus').textContent = '';
	try {
		// Web-only opt-in: the server returns every other rail immediately and
		// marks Continue pending. Native/TV/phone callers never send this flag
		// and keep receiving one complete feed.
		const data = await api('/api/web/home', { ...payload, deferContinue: true });
		if (generation !== homeFeedState.generation) return;
		homeFeedState.data = data;
		homeFeedState.fetchedAt = Date.now();
		homeFeedState.context = context;
		const wasCached = homeFeedState.cacheOrigin === true;
		homeFeedState.cacheOrigin = false;
		if (wasCached) {
			const cachedStatus = $('#homeFeedStatus');
			if (cachedStatus && cachedStatus.textContent === CACHE_NOTICE) cachedStatus.textContent = '';
		}
		writeHomeCache(homeFeedState.access, data);
		renderHomeFeed();
		hideBootOverlay();
		// Continue is one extra request that starts only after the first rows are
		// on screen. A failure leaves the page without that rail, not an error.
		if (data.continuePending) void loadHomeContinue(generation, context, payload).catch(() => {});
		// Never block the first paint on verification: show the rows that are
		// ready, then check again in the background a couple of times.
		if (feedAvailabilityPending(data) > 0) void refreshHomeFeedAvailability(generation, context, 1).catch(() => {});
		// A reload caused by restart:true has already used this session's one
		// restart. Starting another artwork loop here would recreate the storm
		// the persistent budget exists to stop, so only ordinary loads continue.
		if (!internal) startHomeArtworkContinuation();
		else if (!(Number(homeFeedState.artworkRestartBudget) > 0) && feedAvailabilityPending(data) === 0) {
			// The restart reload was the last allowance. Nothing is checking
			// artwork any more, so do not leave a "checking" notice over honest
			// placeholders that will stay until the next explicit Home entry.
			const status = $('#homeFeedStatus');
			if (status) status.textContent = '';
		}
	} catch (error) {
		if (generation !== homeFeedState.generation) return;
		if (!homeFeedState.data) {
			homeFeedState.failed = true;
			$('#homeFeedStatus').textContent = error.message || 'Recommendations are unavailable just now.';
			renderHomeFeedError();
			bootOverlayError(error.message || 'Home could not load just now.');
		} else if (homeFeedState.cacheOrigin) {
			// The cached paint is still on screen; say so rather than letting it
			// pass as current after a failed reconcile.
			const cachedStatus = $('#homeFeedStatus');
			if (cachedStatus) cachedStatus.textContent = 'Could not refresh just now — showing your last saved picks.';
		}
	} finally {
		if (generation === homeFeedState.generation) {
			homeFeedState.loading = false;
			homeFeedState.settled = true;
			// If the feed failed and there is no data, reveal the discovery links
			// once rather than leaving the page with no route out.
			if (!homeFeedState.data && isHomeView()) updateHomeSections();
			if (homeFeedState.queued) {
				const queuedInternal = homeFeedState.queuedInternal;
				homeFeedState.queued = false;
				homeFeedState.queuedInternal = false;
				void loadHomeFeed(true, { internal: queuedInternal });
			}
		}
	}
}

// The deferred Continue half of Home. It is requested only after the first
// rows have painted, and it never turns a failure into a page error: the rail
// is simply omitted. The request reuses the exact context body the feed was
// built from, so the server's per-viewer memo boundary matches.
async function loadHomeContinue(generation, context, payload) {
	let result;
	try { result = await api('/api/web/home/continue', payload); }
	catch {
		if (generation === homeFeedState.generation && homeFeedState.data) homeFeedState.data.continuePending = false;
		return;
	}
	if (generation !== homeFeedState.generation || context !== homeFeedState.context) return;
	const data = homeFeedState.data;
	if (!data) return;
	const row = (Array.isArray(result?.rows) ? result.rows : [])
		.find(entry => entry?.id === 'continue' && Array.isArray(entry.items) && entry.items.length);
	const rows = (Array.isArray(data.rows) ? data.rows : []).filter(entry => entry?.id !== 'continue');
	// Continue is the first landing rail (see homeRowOrder); prepend so it lands
	// in that position whether the other rows are already painted or not.
	data.rows = row ? [row, ...rows] : rows;
	data.continuePending = false;
	if (result?.availability?.continue && typeof result.availability.continue === 'object')
		data.availability = { ...(data.availability || {}), continue: result.availability.continue };
	// Persist after Continue lands so a new tab's instant paint includes the
	// primary rail, not just the browse rows.
	writeHomeCache(homeFeedState.access, data);
	renderHomeFeed();
}

// Continue watching uses a dedicated landscape resume card. The whole card is
// one button, so the visible Resume treatment is never a second tab stop. The
// generic .card is untouched and still drives every other row.
function homeContinueTile(item) {
	const progress = itemProgress(item);
	const seriesName = item.Type === 'Episode' && typeof item.SeriesName === 'string' ? item.SeriesName.trim() : '';
	const title = seriesName || item.Name;
	const metaParts = [];
	if (item.Type === 'Episode') {
		const number = episodeNumber(item);
		if (number) metaParts.push(number);
		if (item.Name && item.Name !== title) metaParts.push(item.Name);
	} else {
		if (item.ProductionYear) metaParts.push(String(item.ProductionYear));
		metaParts.push(friendlyType(item));
		if (item.Genres?.[0]) metaParts.push(item.Genres[0]);
	}
	const runtime = item.Type === 'Series' ? 0 : Number(item.RunTimeTicks) / 1e7 || 0;
	const percent = runtime > 0 && progress > 0 ? Math.min(100, Math.round((progress / runtime) * 100)) : 0;
	const minutesIn = Math.floor(progress / 60);
	const visibleResume = minutesIn > 0 ? `Resume - ${minutesIn} min` : '';
	const spokenProgress = minutesIn > 0 ? `${minutesIn} minutes in` : progress > 0 ? 'under a minute in' : '';
	const spokenPercent = percent > 0 ? `${percent} percent watched` : '';
	const button = element('button', 'continue-card');
	button.type = 'button';
	button.dataset.tellyboxItem = item.Id;
	button.setAttribute('aria-label', ['Resume', title, metaParts.join(', '), spokenPercent, spokenProgress].filter(Boolean).join(', '));
	const image = element('img', 'continue-art-image');
	image.alt = '';
	image.loading = 'lazy';
	image.decoding = 'async';
	setArtwork(image, item, true, 640);
	// A backdrop is preferred when one is selected, but a changed/expired image
	// must not leave the card blank. Retry the working poster once, then fall
	// back to the normal placeholder.
	let posterFallback = false;
	image.addEventListener('error', () => {
		const poster = typeof item.Artwork === 'string' ? item.Artwork : '';
		if (!posterFallback && poster && image.getAttribute('src') !== poster) {
			posterFallback = true;
			image.removeAttribute('srcset');
			image.src = poster;
			return;
		}
		if (!image.dataset.tellyboxFallback) hideFailedArtwork(image);
	});
	const shade = element('span', 'continue-shade');
	shade.setAttribute('aria-hidden', 'true');
	const body = element('span', 'continue-body');
	body.append(element('span', 'continue-title', title));
	if (metaParts.length) body.append(element('span', 'continue-meta', metaParts.join(' · ')));
	if (percent > 0) {
		const row = element('span', 'continue-progress-row');
		row.setAttribute('aria-hidden', 'true');
		const bar = element('span', 'continue-progress');
		const fill = element('span', 'continue-progress-fill');
		fill.style.width = percent + '%';
		bar.append(fill);
		row.append(bar, element('span', 'continue-percent', percent + '%'));
		body.append(row);
	}
	const foot = element('span', 'continue-foot');
	if (visibleResume) foot.append(element('span', 'continue-resume', visibleResume));
	const action = element('span', 'continue-action');
	action.append(element('span', '', 'Resume'), element('span', 'continue-action-mark', '▶'));
	action.lastChild.setAttribute('aria-hidden', 'true');
	foot.append(action);
	body.append(foot);
	button.append(image, shade, body);
	button.onclick = () => item.Type === 'Series' ? showDetails(item.Id) : startPlayback(item, itemProgress(item));
	return button;
}

function homeTile(item) {
	const wrap = element('div', 'home-tile');
	// A series card opens its episode browser and resume state. Only films and
	// episodes start playback directly, so an empty series cannot POST a series
	// id to the player.
	wrap.append(card(item, false, { play: item.Type !== 'Series' }));
	const more = element('button', 'button quiet home-info', 'More info');
	more.setAttribute('aria-label', `More info about ${item.Name}`);
	more.onclick = () => showDetails(item.Id);
	wrap.append(more);
	return wrap;
}

function homeRowSection(row) {
	const safeId = String(row.id || '').replace(/[^a-z0-9_-]/gi, '');
	const headingId = 'homeRowTitle-' + safeId;
	const section = element('section', 'home-row home-row--' + safeId);
	section.setAttribute('aria-labelledby', headingId);
	const heading = element('div', 'shelf-heading');
	const title = element('h2', '', row.title);
	title.id = headingId;
	heading.append(title, element('p', 'shelf-description', row.note || ''));
	const grid = element('div', 'release-grid home-row-grid');
	grid.append(...row.items.map(item => row.id === 'continue' ? homeContinueTile(item) : row.id === 'new-episodes' ? homeEpisodeTile(item) : homeTile(item)));
	section.append(heading, grid);
	return section;
}

function renderHomeFeed() {
	const data = homeFeedState.data, container = $('#homeFeed'), rows = $('#homeRows');
	if (!data || !container || !rows || !isHomeView()) return;
	// Rows exist, so the boot pulse has done its job even if this paint is
	// deferred behind an open dialog or player.
	hideBootOverlay();
	if (details.open || player.open || state.session || casting.active) { homeFeedState.deferred = true; return; }
	const active = document.activeElement;
	const focusInError = Boolean(active && rows.querySelector('.home-error')?.contains(active));
	if (active && rows.contains(active) && !focusInError) { homeFeedState.deferred = true; return; }
	homeSkeletonShown = false;
	preserveScrollAnchor(() => {
		rows.replaceChildren(...orderedHomeRows(data).map(homeRowSection));
		applyHomeFeedStatus(data);
		container.hidden = false;
		const discovery = $('#homeDiscovery');
		if (discovery) discovery.hidden = false;
	});
	homeFeedState.signature = homeFeedSignature(data) + '|ep' + likedEpisodesSignature();
	homeFeedState.artworkSignature = homeArtworkSignature(data);
	homeFeedState.deferred = false;
	updateHomeFooter();
}

function isHomeView() {
	// A deep-linked non-home view (?view=movies and friends) and any active
	// collection filter or search keep the full collection, not Home.
	const view = new URLSearchParams(location.search).get('view');
	return !state.library && state.type === 'all' && !$('#search').value.trim() && !view;
}

function updateHomeFooter(home = isHomeView()) {
	const loading = Boolean(home && !homeFeedState.data && !homeFeedState.settled && !homeFeedState.failed);
	document.documentElement.classList.toggle('home-pending', loading);
	const footer = $('#siteFooter');
	if (!footer) return;
	if (loading) {
		footer.setAttribute('aria-hidden', 'true');
		footer.inert = true;
	} else {
		footer.removeAttribute('aria-hidden');
		footer.inert = false;
	}
}

function updateHomeSections() {
	const home = isHomeView();
	preserveScrollAnchor(() => {
		const data = homeFeedState.data;
		if (home && !data && !homeFeedState.failed) {
			// The compact skeleton keeps the first rail's geometry stable while
			// the feed loads. There is no hero and no page-wide banner.
			if (!homeSkeletonShown) renderHomeSkeleton();
		}
		$('#homeFeed').hidden = !home;
		// Keep the discovery strip out of the reading flow until the rails have
		// rendered, so a delayed feed cannot push a visible link down the page.
		const discoveryReady = Boolean(homeFeedState.data) || homeFeedState.settled;
		$('#homeDiscovery').hidden = !home || !discoveryReady;
		const collection = $('#collectionView');
		if (collection) {
			collection.hidden = home;
			// Reserve the collection surface for at least the first screen while a
			// collection view is visible. Home no longer pre-renders the collection,
			// so without this the footer entered the viewport between "collection
			// shown" and "first page rendered" and moved out again, which measured
			// as a real layout shift on filter entry. The section keeps its natural
			// height once the grid is taller than one screen.
			collection.style.minHeight = home ? '' : '100vh';
		}
		const tools = $('#favouriteViewTools');
		if (tools) tools.hidden = home || state.type !== 'favourites';
		updateHomeFooter(home);
	});
}

// ---------------------------------------------------------------------------
// Same-document Home navigation
// ---------------------------------------------------------------------------
// The auth scope decides whose personalized feed this is. Current servers
// issue an opaque nonsecret `scope` string that already fingerprints the
// account/device and source generation; prefer it verbatim. Only old servers
// fall back to the compact legacy fingerprint. The requested value is prefixed
// so an opaque string can never collide with a legacy JSON fingerprint.
function homeAuthScope(access) {
	const issued = access?.scope;
	if (typeof issued === 'string' && issued) return 'scope:' + issued;
	return 'legacy:' + JSON.stringify([
		Boolean(access?.local), Boolean(access?.home), Boolean(access?.authenticated),
		Boolean(access?.email), access?.person || null, access?.localPlayback?.instance || null,
	]);
}

function setHomeAuthScope(access) {
	const scope = homeAuthScope(access);
	if (homeFeedState.scope && homeFeedState.scope !== scope) {
		// Favourites share the feed's account/source boundary.
		sharedFavourites = null;
		favouriteHome = Boolean((access.local || access.home) && !access.person);
		serverFavouritesRequired = Boolean(access.local || access.home || access.email);
		stopHomeArtworkContinuation();
		resetHomeArtworkRestartBudget();
		homeFeedState.generation += 1;
		homeFeedState.data = null;
		homeFeedState.fetchedAt = 0;
		homeFeedState.context = '';
		homeFeedState.signature = '';
		homeFeedState.artworkSignature = '';
		homeFeedState.artworkDeferred = false;
		homeFeedState.deferred = false;
		homeFeedState.settled = false;
		homeFeedState.failed = false;
		homeFeedState.loading = false;
		homeFeedState.queued = false;
		homeFeedState.queuedInternal = false;
		homeSkeletonShown = false;
	}
	homeFeedState.scope = scope;
	return scope;
}

// Explicit Home navigation already painted the warm feed, so revalidating the
// opaque scope never blocks that paint. A changed answer invalidates the
// cached personalized feed (setHomeAuthScope clears it) and requests the new
// viewer's feed; the skeleton is only shown when the cache is actually empty.
async function revalidateHomeAuthScope(access = null) {
	if (!homeFeedState.authReady) return;
	const previousScope = homeFeedState.scope;
	try { if (!access) access = await api('/api/auth/status'); }
	catch { return; }
	if (previousScope !== homeFeedState.scope || !access || homeAuthScope(access) === previousScope) return;
	routing.direct = Boolean(access.local);
	routing.home = Boolean(access.home);
	trustBrowserProgress(access);
	const scope = setHomeAuthScope(access);
	homeFeedState.access = access;
	if (isHomeView()) {
		if (!homeFeedState.data && !homeSkeletonShown) renderHomeSkeleton();
		updateHomeSections();
	}
	// Failure leaves an empty required cache, never the previous viewer's data.
	let favourites = null;
	try { if (serverFavouritesRequired) favourites = await api(favouriteHome ? '/api/favourites/home' : '/api/favourites'); }
	catch { /* Scoped favourites remain unavailable until a later refresh. */ }
	if (scope !== homeFeedState.scope) return;
	if (favourites) sharedFavourites = favourites.own;
	if (!isHomeView()) return;
	void loadLikedEpisodes().catch(() => {});
	void loadHomeFeed(true);
}

function resetHomeViewControls() {
	stopHomeArtworkContinuation();
	// Entering Home counts as a fresh artwork session: one restart allowance.
	resetHomeArtworkRestartBudget();
	state.library = null;
	state.type = 'all';
	channelGroup = '';
	const search = $('#search');
	if (search) search.value = '';
	const filters = $('#filters');
	if (filters) filters.hidden = false;
	for (const node of document.querySelectorAll('[data-library]')) node.classList.toggle('active', node.dataset.library === 'home');
	for (const node of document.querySelectorAll('[data-type]')) node.classList.toggle('active', node.dataset.type === 'all');
}

// Render the current Home state without waiting for a request. Warm cached data
// paints immediately; a stale context (or a different auth scope) shows the
// skeleton instead of the previous feed. A background load only happens when
// the cache is missing, stale or belongs to another context.
function showHomeView({ scroll = false } = {}) {
	const context = JSON.stringify(homeContextPayload());
	const warm = Boolean(homeFeedState.data) && homeFeedState.authReady && homeFeedState.context === context;
	if (!warm && homeFeedState.data) {
		// The cached feed belongs to an auth/source context that no longer
		// matches (for example the first response arrived before favourites were
		// known). Never present it as the current feed.
		homeFeedState.data = null;
		homeFeedState.fetchedAt = 0;
		homeFeedState.context = '';
		homeFeedState.signature = '';
		homeFeedState.artworkSignature = '';
		homeFeedState.artworkDeferred = false;
		homeFeedState.settled = false;
		homeFeedState.failed = false;
		homeSkeletonShown = false;
	}
	if (warm) {
		homeSkeletonShown = false;
		renderHomeFeed();
		if (!homeFeedState.deferred) startHomeArtworkContinuation();
	} else if (!homeFeedState.data && !homeSkeletonShown) {
		renderHomeSkeleton();
	}
	updateHomeSections();
	if (scroll) {
		const host = document.scrollingElement || document.documentElement;
		if (host) host.scrollTop = 0;
		const active = document.activeElement;
		if (!active || active === document.body) {
			const homeLink = document.querySelector('#nav a[href="/"]');
			if (homeLink) { try { homeLink.focus({ preventScroll: true }); } catch { /* Focus is best-effort. */ } }
		}
	}
	if (homeFeedState.authReady) {
		if (!homeFeedsStarted) loadHomeFeeds();
		else {
			void loadLikedEpisodes().catch(() => {});
			void loadHomeFeed(false);
		}
	}
}

function navigateHome({ mode = 'push', scroll = true } = {}) {
	resetHomeViewControls();
	const url = new URL(location.href);
	url.searchParams.delete('view');
	url.searchParams.delete('item');
	const current = location.pathname + location.search;
	const target = url.pathname + url.search;
	if (target !== current) {
		try {
			if (mode === 'push') history.pushState({ tellyboxHome: true }, '', url);
			else history.replaceState({ tellyboxHome: true }, '', url);
		} catch { /* History is best-effort; the view still renders. */ }
	}
	showHomeView({ scroll });
	void revalidateHomeAuthScope();
}

// A same-document view entry (for example the entry the browser restored after
// a Home click pushed '/'). The URL already names the view, so the library
// selection must not rewrite it.
function applySameDocumentView(view) {
	stopHomeArtworkContinuation();
	if (view === 'livetv' || view === 'nonstop' || view === 'recordings') {
		const id = view === 'livetv' ? 'dispatch-tv' : view === 'nonstop' ? 'dispatch-247' : 'dispatch-recordings';
		selectLibrary(id, { history: false });
		return true;
	}
	if (view === 'movies' || view === 'tvshows') {
		const library = state.libraries.find(item => item.CollectionType === view);
		if (library) { selectLibrary(library.Id, { history: false }); return true; }
		return false;
	}
	if (view === 'all') {
		state.library = null;
		state.type = 'all';
		void loadItems();
		return true;
	}
	return false;
}

function onHomePopState() {
	if (location.pathname !== '/') return;
	// The player owns its own history entry and restores details/scroll on Back.
	if (playerNavigation.isPushed() || player.open || details.open || state.session || casting.active) return;
	const view = new URLSearchParams(location.search).get('view');
	if (!view) {
		resetHomeViewControls();
		showHomeView({ scroll: false });
		void revalidateHomeAuthScope();
		return;
	}
	if (!applySameDocumentView(view)) {
		// The view cannot be mapped yet (for example before /api/libraries).
		// Leaving Home is enough: the artwork loop must not keep running.
		stopHomeArtworkContinuation();
	}
}


// The server verifies streamed series before returning a normal watch list. A
// first page can therefore arrive short (or empty) while checks are still queued.
// The page says so instead of pretending the collection ended, and re-requests
// the same page a bounded number of times until the pending count reaches zero.
function itemsHasMore(data) {
	if (!data) return false;
	// A verified page can report more candidates than it could return yet, so the
	// server's own flag wins over the local total.
	if (typeof data.hasMore === 'boolean') return data.hasMore;
	return state.items.length < Number(data.total || 0);
}
function sameItemIds(items) {
	const incoming = Array.isArray(items) ? items : [];
	if (incoming.length !== state.items.length) return false;
	return incoming.every((item, index) => item?.Id === state.items[index]?.Id);
}
function updateItemsSummary(data, append, search) {
	$('#count').textContent = Number(data.total).toLocaleString();
	$('#collectionTitle').firstChild.textContent = search ? 'Search results ' : state.library ? state.library.Name + ' ' : 'The collection ';
	const pending = pendingAvailability(data);
	if (pending) {
		// A server notice stays visible; the checking phrase tells the viewer why
		// the page may still be short.
		$('#status').textContent = data.notice ? data.notice + ' ' + availabilityCheckingText : availabilityCheckingText;
		$('#status').hidden = false;
	}
	else if (data.notice) { $('#status').textContent = data.notice; $('#status').hidden = false; }
	else if (!state.items.length && !append) { $('#status').textContent = 'Nothing found. Try a different title or library.'; $('#status').hidden = false; }
	else { $('#status').hidden = true; $('#status').textContent = ''; }
	$('#loadMore').hidden = !itemsHasMore(data) || state.type === 'livetv';
}
async function pollItemsAvailability(params, generation, search) {
	let attempts = 0;
	while (attempts < availabilityPollLimit) {
		await new Promise(resolve => setTimeout(resolve, availabilityPollDelay));
		// A newer load, a changed query or a new library cancels this poll. The
		// generation check also covers the search box debounce window.
		if (generation !== state.generation || $('#search').value.trim() !== search) return;
		let data;
		try { data = await api('/api/web/items?' + params); }
		catch {
			if (generation !== state.generation || $('#search').value.trim() !== search) return;
			// Keep the verified cards already on screen and stop polling; a manual
			// reload or Load more request is the retry, so there is no request storm.
			$('#status').textContent = availabilityCheckingText + ' This is taking longer than expected. Try again shortly.';
			$('#status').hidden = false;
			return;
		}
		if (generation !== state.generation || $('#search').value.trim() !== search) return;
		attempts += 1;
		state.total = data.total;
		if (!sameItemIds(data.items)) {
			state.items = Array.isArray(data.items) ? data.items : [];
			$('#grid').replaceChildren(...state.items.map(item => card(item, $('#sort').value === 'release')));
		}
		updateItemsSummary(data, false, search);
		updateHomeSections();
		if (feedAvailabilityPending(data) === 0) return;
	}
	if (generation === state.generation && $('#search').value.trim() === search) {
		$('#status').textContent = availabilityCheckingText + ' This is taking longer than expected. Try again shortly.';
		$('#status').hidden = false;
	}
}
async function loadItems(append = false) {
	const globalQuery=$('#search').value.trim();
	$('#searchEverywhere').hidden=!globalQuery;
	$('#searchEverywhere').href='/search?'+new URLSearchParams({q:globalQuery});
	const retryButton=$('#collectionRetry');if(retryButton)retryButton.hidden=true;
	if (isHomeView()) loadHomeFeeds();
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
	// Live TV has no dedicated text search: category chips and the EPG are the
	// way to find a channel. Reclaim the toolbar space and keep the global
	// Search page (/search) for everything else. Other collection views keep
	// their normal collection search.
	const searchControl = $('#search').closest('label');
	if (searchControl) searchControl.hidden = live;
	$('#searchEverywhere').hidden = live || !globalQuery;
	updateHomeSections();
	if (live) return loadGuide();
	if (nonstop) return loadNonstop(append);
	if (dvr) return loadRecordings();
	$('#genreLabel').hidden=!['all','movies','tvshows'].includes(state.type);
	if(state.type==='favourites'){++state.generation;const items=Object.values(readFavourites()).filter(i=>i.Name.toLowerCase().includes($('#search').value.trim().toLowerCase()));state.items=items;state.total=items.length;$('#grid').replaceChildren(...items.map(i=>card(i)));$('#collectionTitle').firstChild.textContent=favouriteHome?'Home favourites ':'Favourites ';$('#count').textContent=items.length;$('#status').hidden=items.length>0;$('#status').textContent=favouriteHome?'Tap the star on anything you love and it’ll appear here for everyone at home.':'Tap the star on anything you love — your favourites follow your sign-in.';$('#loadMore').hidden=true;return;}
	// Home is the feed, not the collection. Fetching and rendering the first
	// collection page here built up to 60 cards the viewer never saw (the
	// collection section is hidden on Home) and cost a metadata request plus
	// hidden artwork. The collection, its filters, paging and search still load
	// on demand: every route into a collection view calls loadItems again, and
	// Home itself needs no state.items.
	if (isHomeView()) { $('#loadMore').hidden = true; return; }
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
		if (!append) {
			state.items = Array.isArray(data.items) ? data.items : [];
			$('#grid').replaceChildren(...state.items.map(item => card(item, $('#sort').value === 'release')));
		} else {
			// A verified page can overlap titles already rendered. Never append a
			// duplicate card when the same title comes back on the next request.
			const known = new Set(state.items.map(item => item?.Id));
			const fresh = (Array.isArray(data.items) ? data.items : []).filter(item => item && !known.has(item.Id));
			state.items = [...state.items, ...fresh];
			$('#grid').append(...fresh.map(item => card(item, $('#sort').value === 'release')));
		}
		state.total = data.total;
		if(data.genres){const selected=$('#genre').value;$('#genre').replaceChildren(new Option('All categories',''),...data.genres.map(g=>new Option(g,g)));$('#genre').value=data.genres.includes(selected)?selected:'';}
		updateItemsSummary(data, append, search);
		if (data.indexing) setTimeout(() => { if (generation === state.generation) void loadItems(); }, 10000);
		updateHomeSections();
		if (unified && !append && feedAvailabilityPending(data) > 0) void pollItemsAvailability(params, generation, search).catch(() => {});
	} catch (error) {
		if (generation !== state.generation) return;
		// A transient failure is a retry, not a dead end and not a "Show more".
		$('#status').hidden = false;
		$('#status').textContent = error.message;
		$('#count').textContent = '';
		$('#loadMore').hidden = true;
		let retry = $('#collectionRetry');
		if (!retry) {
			retry = element('button', 'button secondary', 'Try again');
			retry.id = 'collectionRetry';
			retry.type = 'button';
			$('#status').after(retry);
		}
		retry.hidden = false;
		retry.onclick = () => { retry.hidden = true; void loadItems(append); };
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
	$('#status').hidden=false;$('#status').textContent='Finding your 24/7 favourites…';$('#loadMore').hidden=true;
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
			setArtwork(image,item);image.alt='';image.loading='lazy';image.decoding='async';image.onerror=()=>{if(!image.dataset.tellyboxFallback)image.remove();};
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

// The timetable sizes its rendered window to the viewport instead of a fixed
// 950px grid: about three hours on a phone, six on a tablet, four on desktop.
// Programmes are sliced from the guide data already fetched; nothing extra is requested.
const GUIDE_HALF_HOUR_MIN_PX = 40;
function guideLayout() {
	const viewport = window.innerWidth || document.documentElement.clientWidth || 950;
	const narrow = viewport <= 650;
	const hours = narrow ? 3 : viewport <= 1050 ? 6 : 4;
	const slots = hours * 2;
	const channel = narrow ? 110 : 155;
	const width = $('#guideRows').clientWidth || viewport;
	const track = Math.max(width - channel, slots * GUIDE_HALF_HOUR_MIN_PX);
	return { hours, slots, minWidth: channel + track };
}
let guideRenderedLayout = null;

function renderGuide() {
	if (!guideData || state.type !== 'livetv') return;
	const now = Date.now();
	const layout = guideLayout();
	const start = Math.floor(now / 1800000) * 1800000, end = start + layout.hours * 3600000;
	const favourites = JSON.parse(localStorage.getItem('tellybox-channels') || '[]');
	channelGroups([...new Set(guideData.channels.map(c=>c.Group).filter(Boolean))],renderGuide);
	// No text filtering on Live TV. Categories, favourites and the EPG remain.
	const channels = guideData.channels.filter(channel => (!channelGroup || channel.Group===channelGroup) && (document.querySelector('#onlyFavourites')?.getAttribute('aria-pressed') !== 'true' || favourites.includes(channel.Id)));
	const grid = element('div', 'timetable');
	grid.style.minWidth = layout.minWidth + 'px';
	const header = element('div', 'timetable-row timetable-header');
	header.append(element('div', 'timetable-channel', 'CHANNEL'));
	const times = element('div', 'timetable-times');
	times.style.gridTemplateColumns = 'repeat(' + layout.slots + ', 1fr)';
	for (let time = start; time < end; time += 1800000) times.append(element('span', '', guideTime(time)));
	header.append(times); grid.append(header);
	for (const channel of channels) {
		const row = element('div', 'timetable-row');
		const identity = element('button', 'timetable-channel');
		const identityText = element('span', 'guide-channel-name');
		identityText.append(element('small', '', (favourites.includes(channel.Id) ? '★ ' : '') + (channel.ChannelNumber || '')), element('strong', '', channel.Name));
		const logo = channelLogo(channel, 'guide-logo', () => identity.classList.add('logo-only'), () => identity.classList.remove('logo-only'));
		if (logo) identity.append(logo);
		identity.append(identityText);
		if(channel.GuideWarning) {const note=element('small','guide-warning','Check listing');note.title=channel.GuideWarning;identity.append(note);}
		identity.setAttribute('aria-label', 'Watch ' + (channel.ChannelNumber ? channel.ChannelNumber + ' ' : '') + channel.Name + ' live'); identity.onclick = () => startPlayback(channel, 0);
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
	const scroller = $('#guideRows');
	const active = document.activeElement;
	const activeLabel = active && scroller.contains(active) ? active.getAttribute('aria-label') : null;
	const scrollLeft = scroller.scrollLeft;
	scroller.replaceChildren(grid);
	scroller.scrollLeft = scrollLeft;
	if (activeLabel) {
		const restore = [...scroller.querySelectorAll('button')].find(node => node.getAttribute('aria-label') === activeLabel);
		if (restore) restore.focus({ preventScroll: true });
	}
	guideRenderedLayout = layout;
	$('#count').textContent = channels.length + (channels.length === 1 ? ' channel' : ' channels');
	$('#status').hidden = channels.length > 0;
	$('#status').textContent = 'No channels in this category. Try All channels.';
	const span = { 3: 'three', 4: 'four', 6: 'six' }[layout.hours] || String(layout.hours);
	const overflows = grid.scrollWidth > scroller.clientWidth + 1;
	$('#guideSummary').textContent = new Date().toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' }) + ' · Next ' + span + ' hours' + (overflows ? ' · Swipe across to look ahead' : '');
	$('#guideFreshness').textContent=guideData.stale?'Guide refresh failed. Showing any remaining saved listings.':'Dispatcharr listings · checked '+guideTime(guideData.fetchedAt)+'. Gaps mean no listing was supplied.';
}

let guideResizeTimer = 0;
window.addEventListener('resize', () => {
	if (state.type !== 'livetv' || !guideData) return;
	clearTimeout(guideResizeTimer);
	guideResizeTimer = setTimeout(() => {
		const layout = guideLayout();
		if (!guideRenderedLayout || layout.hours !== guideRenderedLayout.hours || layout.minWidth !== guideRenderedLayout.minWidth) renderGuide();
	}, 150);
});

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
	const heading = element('div', 'guide-detail-channel');
	const headingText = element('div');
	headingText.append(element('p', 'eyebrow', channel.Name));
	const logo = channelLogo(channel, 'guide-logo guide-detail-logo', () => heading.classList.add('logo-only'), () => heading.classList.remove('logo-only'));
	if (logo) heading.append(logo);
	heading.append(headingText);
	heading.setAttribute('aria-label', (channel.ChannelNumber ? channel.ChannelNumber + ' ' : '') + channel.Name);
	content.append(heading, title);
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
	const items=recordingData.filter(r=>{
		// "Ready to watch" must mean playable: a completed row whose file is gone
		// is not watchable and belongs under Everything, not this filter.
		const stateOk=recordingFilter==='all'
			||(recordingFilter==='completed'?r.State==='completed'&&r.Playable===true:false)
			||r.State===recordingFilter
			||(recordingFilter==='recording'&&r.State==='starting');
		return stateOk&&(r.Name+' '+r.ChannelName).toLowerCase().includes(term);
	});
	const order={recording:0,starting:0,scheduled:1,processing:2,completed:3,failed:4,cancelled:5};
	items.sort((a,b)=>order[a.State]-order[b.State]||(a.State==='scheduled'?Date.parse(a.StartDate)-Date.parse(b.StartDate):Date.parse(b.StartDate)-Date.parse(a.StartDate)));
	$('#count').textContent=items.length;
	$('#status').hidden=items.length>0;
	$('#status').textContent=term
		?'No recordings match your search.'
		:recordingFilter!=='all'
			?'No recordings match this filter.'
			:'No recordings here yet. Choose a programme in Live TV and select Record programme.';
	const list=$('#recordingsList');list.replaceChildren();
	for(const item of items){
		const row=element('article','recording-card'),body=element('div','recording-body'),actions=element('div','recording-actions');
		const image=element('img','recording-art');setArtwork(image,item);image.alt='';image.loading='lazy';image.onerror=()=>{if(!image.dataset.tellyboxFallback)image.hidden=true;};
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
// PLAYBACK_DEFAULTS_START
const serverPlaybackDefaults = { englishSubtitles: false, autoNext: false, skipIntros: false };
function normalisePlaybackDefaults(value) {
	const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
	return { englishSubtitles: source.englishSubtitles === true, autoNext: source.autoNext === true, skipIntros: source.skipIntros === true };
}
function localPlaybackChoice(key) {
	try {
		const value = localStorage.getItem(key);
		return value === 'true' ? true : value === 'false' ? false : undefined;
	} catch { return undefined; }
}
function playbackPreference(key, serverKey) {
	const local = localPlaybackChoice(key);
	return local === undefined ? serverPlaybackDefaults[serverKey] === true : local;
}
function setPlaybackPreference(key, enabled) {
	try { localStorage.setItem(key, String(enabled)); } catch { /* Private browsing can block storage. */ }
}
// PLAYBACK_DEFAULTS_END
const autoplayPreference = document.querySelector('#autoNext');
const subtitlePreference = document.querySelector('#defaultEnglish');
function applyPlaybackPreferences() {
	autoplayPreference.checked = playbackPreference('tellybox-autoplay', 'autoNext');
	subtitlePreference.checked = playbackPreference('tellybox-english', 'englishSubtitles');
}
applyPlaybackPreferences();
autoplayPreference.onchange = () => { setPlaybackPreference('tellybox-autoplay', autoplayPreference.checked); if(autoplayPreference.checked)updateNext();else hideCountdown(); };
function skipIntrosEnabled() {
	return playbackPreference('tellybox-skip-intros', 'skipIntros');
}
window.addEventListener('storage', event => {
	if (['tellybox-english', 'tellybox-autoplay', 'tellybox-skip-intros'].includes(event.key)) applyPlaybackPreferences();
	if (event.key === 'tellybox-skip-intros') updateNext();
});
subtitlePreference.onchange = () => setPlaybackPreference('tellybox-english', subtitlePreference.checked);
setInterval(() => {
	if (state.type === 'livetv' && !document.hidden && !details.open && !player.open && !$('#liveGuide').contains(document.activeElement)) void loadGuide();
}, 60000);

function selectLibrary(id, options = {}) {
	stopHomeArtworkContinuation();
	channelGroup='';
	$('#channelGroups').replaceChildren();$('#count').textContent='';
	state.library = state.libraries.find(item => item.Id === id) || null;
	state.type = state.library ? state.library.CollectionType || 'recordings' : 'all';
	if (options.history !== false) {
		const address=new URL(location.href);
		if(['livetv','nonstop','dvr'].includes(state.type))address.searchParams.set('view',state.type==='dvr'?'recordings':state.type);else address.searchParams.delete('view');
		history.replaceState(null,'',address);
	}
	$('#search').value = '';
	$('#filters').hidden = Boolean(state.library);
	for (const node of document.querySelectorAll('[data-library]')) node.classList.toggle('active', node.dataset.library === (id || 'home'));
	for (const node of document.querySelectorAll('[data-type]')) node.classList.toggle('active', node.dataset.type === state.type);
	void loadItems();
}

async function loadSimilarTitles(item, content) {
	if (!['Movie', 'Series', 'Episode'].includes(item?.Type)) return;
	let items = [];
	try {
		const data = await api('/api/web/similar', { ...homeContextPayload(), id: item.Id });
		items = Array.isArray(data?.items) ? data.items.filter(entry => entry && entry.Id && entry.Name) : [];
	} catch { /* Similar titles are optional; a failure leaves the details view unchanged. */ }
	if (!content.isConnected || !items.length) return;
	const section = element('section', 'similar-titles');
	const heading = element('h3', '', 'Similar titles');
	heading.id = 'similarTitlesHeading';
	const grid = element('div', 'release-grid');
	grid.setAttribute('role', 'list');
	grid.setAttribute('aria-label', 'Similar titles');
	for (const similar of items) {
		const tile = element('div', 'home-tile');
		tile.setAttribute('role', 'listitem');
		const button = card(similar, false);
		const reason = similar.reason || 'More like this';
		button.setAttribute('aria-label', `${similar.Name}, ${friendlyType(similar)}. ${reason}`);
		const note = element('p', 'source-note', reason);
		tile.append(button, note);
		grid.append(tile);
	}
	section.setAttribute('aria-labelledby', heading.id);
	section.append(heading, grid);
	content.append(section);
}

async function showDetails(id) {
	$('#detailsBody').replaceChildren(element('p', 'detail-content', 'Loading details…'));
	if (!details.open) details.showModal();
	try {
		const item = await api('/api/web/items/' + id);
		if (!details.open) return;
		const art = element('img', 'detail-art');
		setArtwork(art, item, true, 1200);
		art.alt = '';
		art.onerror = () => { if (!art.dataset.tellyboxFallback) art.hidden = true; };
		const content = element('div', 'detail-content');
		const title = element('h2', '', item.Name);
		title.id = 'detailsTitle';
		content.append(element('p', 'eyebrow', friendlyType(item).toUpperCase()), title, element('p', 'detail-meta', meta(item)));
		if (['Movie', 'Series'].includes(item.Type)) content.append(jserverUI.ratings(item.Ratings, { links: true }));
		if (item.Genres?.length) {
			const genres=element('div','genre-list');genres.setAttribute('aria-label','Genres');
			for(const name of [...new Set(item.Genres.map(value=>String(value||'').trim()).filter(Boolean))].slice(0,12))genres.append(element('span','genre-chip',name));
			content.append(genres);
		}
		content.append(element('p', 'overview', item.Overview || item.CurrentProgram?.Overview || 'Ready when you are.'));
		const trailer=trailerUrl(item.Trailer);
		if(trailer){const link=element('a','button secondary trailer-link','Watch trailer');link.href=trailer;link.target='_blank';link.rel='noopener noreferrer';link.setAttribute('aria-label','Watch trailer for '+item.Name);content.append(link);}
		if (item.Source === 'streamed') content.append(element('p', 'source-note', sourceLabel.streamed(item)));
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
				selector.append(heading, tabs);
				if (seasons.length) { content.append(selector, list); choose(seasons.find(s => s > 0) ?? seasons[0]); }
				else {
					list.textContent = data.notice || 'No episodes are available for this series yet. It may appear later; try again.';
					content.append(list);
				}
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
		// Loaded last so the section always follows the overview, actions and
		// episode list. The helper appends nothing when there are no results.
		if (content.isConnected) void loadSimilarTitles(item, content);
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
		setArtwork(thumbnail, item, false, 360);
		thumbnail.alt = ''; thumbnail.loading = 'lazy'; thumbnail.onerror = () => { if (!thumbnail.dataset.tellyboxFallback) thumbnail.style.visibility = 'hidden'; };
		const text = element('span', 'episode-text');
		const progress = getProgress(item.Id);
		text.append(element('span', 'episode-kicker', `${item.IndexNumber ? 'EPISODE ' + item.IndexNumber + ' · ' : ''}${minutes(item.RunTimeTicks)}`), element('span', 'episode-title', item.Name), element('span','episode-release',episodeRelease(item)), element('span', 'episode-overview', item.Overview || 'Ready to watch.'), element('span', 'episode-action', progress > 30 ? `Continue · ${Math.floor(progress / 60)} min in` : '▶ Play episode'));
		button.append(thumbnail, text);
		button.setAttribute('aria-label', `${progress > 30 ? 'Continue' : 'Play'} ${item.Name}`);
		button.onclick = () => ['Season', 'Series', 'Folder', 'MusicAlbum'].includes(item.Type) ? showDetails(item.Id) : startPlayback(item, getProgress(item.Id));
		if (item.Type === 'Episode') {
			const row = element('article', 'episode-share-row');
			const actions = element('div', 'episode-actions');
			actions.append(element('span','episode-source',item.Source==='streamed'?sourceLabel.streamed(item):'On your server'));
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
	// Fail closed if the guard is unavailable (for example an isolated harness):
	// an unqualified stored value must never be preferred over the server position.
	if (typeof browserProgressTrusted !== 'function' || !browserProgressTrusted()) return 0;
	try { return localStorage.getItem('tellybox-watched-' + id) === 'true' ? 0 : Number(localStorage.getItem('jimbo-progress-' + id)) || 0; } catch { return 0; }
}

function beginViewing() {
	if (viewingStarted || !state.playing || state.playing.Type === 'TvChannel') return;
	viewingStarted = true;
	// A remote account's playback must not touch the browser-owned progress
	// record that a local viewer of this browser relies on.
	if (!browserProgressTrusted()) return;
	try {
		if (localStorage.getItem('tellybox-watched-' + state.playing.Id) === 'true') {
			localStorage.setItem('jimbo-progress-' + state.playing.Id, '0');
			localStorage.removeItem('tellybox-watched-' + state.playing.Id);
		}
	} catch {}
}

function saveProgress() {
	if (!state.playing || state.live || state.playing.Type === 'TvChannel') return;
	// Remote accounts keep their position on the server. Writing it into this
	// browser's shared keys would overwrite the local viewer's resume point and
	// hand a signed-in account another account's state.
	if (!browserProgressTrusted()) return;
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

function showPlaybackClosed(message, generation = playGeneration) {
	if (generation !== playGeneration || !player.open) return;
	saveProgress();
	const note = message || 'Playback stopped, but your place is saved for whenever you’re ready.';
	closePlayer();
	const status = $('#status');
	if (status) status.textContent = note;
}
function showViewingBlocked(message, generation = playGeneration) {
	if (generation !== playGeneration || !player.open) return;
	const reason = message || 'Remote viewing is unavailable for this account.';
	if (viewingBlocked) { $('#viewingBlockedMessage').textContent = reason; return; }
	viewingBlocked = true;
	if (typeof hideStillWatching === 'function') hideStillWatching();
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
	if (state.hls) { state.hls.destroy(); state.hls = null; state.hlsReady = false; }
	setLiveMode(false);
	cancelNext();
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
	return { action, position: playbackPosition(), paused: state.live ? false : casting.active ? casting.remote.isPaused : video.paused, buffering: !casting.active && video.readyState < 3, seeking: !casting.active && video.seeking, rate: casting.active ? 1 : video.playbackRate, muted: casting.active ? casting.remote.isMuted : video.muted };
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
	} else if (error.code === 'PAUSED_TIMEOUT' || error.code === 'SESSION_IDLE') {
		showPlaybackClosed(error.message || 'Playback was paused too long and has closed. Your place was saved.', generation);
	} else void checkViewingStatus({ quiet: true });
}

let nextEpisode = null, nextTimer = null, lastChannel = null, previousChannel = null;
let nextResult = null, nextDismissed = false, nextBusy = false, nextAutoBlocked = false, segments = [], skipSegment = null, liveFloor = 0;
let nextRenderedId = null, nextRenderedResult = null, nextPlayAction = null;
const introLedger = new TellyboxEpisodeFlow.IntroLedger();
function clearNextTimer() { if (nextTimer !== null) { clearInterval(nextTimer); nextTimer = null; } }
function hideCountdown() {
	clearNextTimer();
	$('#upNext .next-countdown')?.remove();
	$('#upNext .next-countdown-bar')?.remove();
}
function hideNextCard() { clearNextTimer(); const host=$('#upNext'); if(host){ host.hidden = true; host.classList.remove('episode-ended'); } }
function cancelNext() { hideNextCard(); }
function mediaDurationMs() { return Number.isFinite(video.duration) && video.duration > 0 ? video.duration * 1000 : 0; }
function mediaPositionMs() { return Number.isFinite(video.currentTime) && video.currentTime > 0 ? video.currentTime * 1000 : 0; }
function currentOutro() { return TellyboxEpisodeFlow.reliableOutro(segments, mediaDurationMs()); }
async function loadNext(generation) {
	try {
		const result = await api(`/api/web/items/${state.playing.Id}/next?series=${encodeURIComponent(state.playing.SeriesId || '')}`);
		if (generation !== playGeneration) return;
		nextResult = result; nextEpisode = result.item;
	} catch { if (generation === playGeneration) nextResult = { status: 'error', message: 'Could not check the next episode.' }; }
	if (generation === playGeneration) {
		updateNext();
		if (!nextResult?.item && nextResult?.schedulePending) void loadSchedule(generation, state.playing?.Id);
	}
}
async function loadSchedule(generation, itemId) {
	try {
		const result = await api(`/api/web/items/${encodeURIComponent(itemId)}/schedule?series=${encodeURIComponent(state.playing?.SeriesId || '')}`);
		if (generation !== playGeneration || !player.open || state.playing?.Id !== itemId || nextEpisode || nextDismissed) return;
		if (!nextResult || nextResult.status === 'error') return;
		nextResult = { ...nextResult, schedule: result };
		updateEndSchedule();
	} catch {}
}
function endCopy(result) {
	if (result?.schedule?.status === 'complete') return ['Series complete', result.schedule.message || "You’ve finished this series."];
	if (result?.schedule?.status === 'caught-up') return ["You’re up to date", result.schedule.message || 'No next episode is scheduled yet. Check back for more.'];
	return result?.status === 'complete' ? ['Series complete', "You’ve reached the final episode of this series."]
		: result?.status === 'caught-up' ? ["You’re up to date", "You’ve reached the latest available episode. Check back for more."]
		: ['error', 'unknown'].includes(result?.status) ? ["Couldn't check what's next", "We couldn't confirm the next episode. Try again or browse the series."]
		: ["That's all for now", "The next episode isn't available to watch here yet."];
}
function renderEndSchedule(summary, result) {
	const schedule = result?.schedule;
	let block = summary.querySelector('.episode-end-next');
	if (!block) {
		block = element('div', 'episode-end-next');
		summary.append(block);
	}
	const copy = TellyboxEpisodeFlow?.nextScheduleCopy?.(schedule);
	if (!copy) { block.hidden = true; block.replaceChildren(); return copy; }
	block.hidden = false;
	block.replaceChildren(
		element('p', 'eyebrow', copy.phase === 'aired' ? 'NEXT EPISODE NOT YET AVAILABLE' : 'NEXT EPISODE'),
		element('strong', 'episode-end-next-identity', copy.identity),
		element('span', 'episode-end-next-when', copy.when),
		element('p', 'episode-end-next-detail', copy.detail)
	);
	return copy;
}
function updateEndSchedule() {
	const host = $('#upNext');
	if (!host || host.hidden || nextEpisode || !nextResult?.schedule) return;
	const summary = host.querySelector('.episode-end-summary');
	if (!summary) return;
	const copy = endCopy(nextResult);
	const title = summary.querySelector('.episode-end-copy-title');
	const text = summary.querySelector('.episode-end-copy-text');
	if (title) title.textContent = copy[0];
	if (text) text.textContent = copy[1];
	renderEndSchedule(summary, nextResult);
}
function renderEnd(host) {
	host.classList.add('episode-ended');
	const summary=element('div','episode-end-summary');
	summary.append(element('span','eyebrow','EPISODE FINISHED'),element('h2','',state.playing.SeriesName||nextResult.seriesName||'Your series'));
	if(Number.isInteger(state.playing.ParentIndexNumber)&&Number.isInteger(state.playing.IndexNumber))summary.append(element('p','muted',`Season ${state.playing.ParentIndexNumber} · Episode ${state.playing.IndexNumber}`));
	summary.append(element('p','muted',state.playing.Name));
	const copy=endCopy(nextResult);
	summary.append(element('h3','episode-end-copy-title',copy[0]),element('p','muted episode-end-copy-text',copy[1]));
	renderEndSchedule(summary, nextResult);
	const back=element('button','button primary','Back to series');
	back.onclick=()=>{const series=nextResult.seriesId||state.playing.SeriesId;closePlayer();if(series)void showDetails(series);};summary.append(back);
	if (nextResult.status === 'error' || nextResult.status === 'unknown') {
		const retry = element('button', 'button secondary', 'Try again'); retry.onclick = () => { nextResult = null; showNext(); void loadNext(playGeneration); }; summary.append(retry);
	}
	host.append(summary);
	const suggestions=(nextResult.status==='error'||nextResult.status==='unknown')?[]:(nextResult.suggestions||[]).slice(0,3);
	if(suggestions.length){
		const more=element('section','episode-end-more'),cards=element('div','episode-end-cards');
		more.append(element('h3','','More to explore'),element('p','muted',nextResult.suggestionGenre?'More in '+nextResult.suggestionGenre:'Choose a show to see its episodes.'));
		for (const item of suggestions) {
			const button=element('button','episode-end-card'),image=element('img');setArtwork(image,item);image.alt='';image.onerror=()=>{if(!image.dataset.tellyboxFallback)image.style.visibility='hidden';};
			button.setAttribute('aria-label','View series: '+item.Name);button.append(image,element('span','episode-end-name',item.Name),element('small','','View series'));
			button.onclick=()=>{closePlayer();void showDetails(item.Id);};cards.append(button);
		}
		more.append(cards);host.append(more);
	}
	back.focus();
}
function renderNextCard(host) {
	const next = nextEpisode;
	const preview=element('div','next-preview'),art=element('img');if(typeof setArtwork==='function')setArtwork(art,next);else art.src=imageUrl(next);art.alt='';art.onerror=()=>{if(!art.dataset.tellyboxFallback)art.hidden=true;};
	const copy=element('div');copy.append(element('small','eyebrow',['UP NEXT',episodeNumber(next)].filter(Boolean).join(' · ')),element('strong','',next.Name));preview.append(art,copy);
	const play = element('button', 'button primary', 'Play now');
	nextPlayAction = async () => {
		if (nextBusy) return; nextBusy = true; clearNextTimer(); play.disabled = true;
		try { await startPlayback(next, getProgress(next.Id), true, { automatic: true }); }
		finally { nextBusy = false; play.disabled = false; }
	};
	play.onclick = nextPlayAction;
	const cancel = element('button', 'button secondary', 'Keep watching');
	cancel.onclick = () => { nextDismissed = true; hideNextCard(); };
	const actions=element('div','next-actions');actions.append(play,cancel);host.append(preview,actions);
}
function showNext() {
	if (state.playing?.Type !== 'Episode' || state.live || casting.active || !player.open || viewingBlocked || nextDismissed || nextBusy) return;
	const ended = video.ended;
	if (!nextEpisode && !ended) return;
	// The up-next card owns the end of an episode. Never leave the
	// still-watching prompt underneath it.
	if (typeof hideStillWatching === 'function') hideStillWatching();
	clearNextTimer();
	const host = $('#upNext'); host.replaceChildren(); host.hidden = false;
	nextRenderedId = nextEpisode?.Id || null; nextRenderedResult = nextResult;
	if (!nextResult) { host.append(element('strong', '', 'Checking what’s next…')); return; }
	if (!nextEpisode) { renderEnd(host); return; }
	host.classList.remove('episode-ended');
	renderNextCard(host);
	armCountdown();
}
function armCountdown() {
	const host=$('#upNext');
	if(nextTimer!==null || nextPlayAction===null || nextAutoBlocked || !autoplayPreference.checked || document.hidden || casting.active
		|| nextDismissed || nextBusy || state.live || !nextEpisode || !player.open || viewingBlocked || host.hidden) return;
	const ended=video.ended, duration=mediaDurationMs(), position=mediaPositionMs();
	if(!TellyboxEpisodeFlow.creditsCountdown(position,duration,ended,currentOutro())) return;
	const copy=host.querySelector('.next-preview > div');
	if(!copy) return;
	let text=host.querySelector('.next-countdown'), progress=host.querySelector('.next-countdown-bar');
	if(!text){ text=element('span','next-countdown','Starts in 10 seconds'); copy.append(text); }
	if(!progress){ progress=document.createElement('progress'); progress.className='next-countdown-bar'; progress.max=10; progress.setAttribute('aria-label','Time until next episode'); host.append(progress); }
	let remaining=TellyboxEpisodeFlow.COUNTDOWN_SECONDS;
	progress.value=remaining; progress.hidden=false; text.hidden=false;
	nextTimer=setInterval(() => {
		if(nextDismissed || nextBusy || !player.open || state.live || casting.active || viewingBlocked || host.hidden){ clearNextTimer(); return; }
		const nowEnded=video.ended, at=mediaPositionMs(), length=mediaDurationMs();
		if(!TellyboxEpisodeFlow.creditsCountdown(at,length,nowEnded,TellyboxEpisodeFlow.reliableOutro(segments,length))){ hideNextCard(); return; }
		if(!TellyboxEpisodeFlow.countdownCanAdvance({ended:nowEnded,playing:!video.paused,buffering:video.readyState<3,seeking:video.seeking,
			hidden:document.hidden,casting:casting.active,stopped:!player.open,live:state.live,blocked:viewingBlocked})) return;
		remaining--;
		text.textContent=`Starts in ${remaining} seconds`; progress.value=remaining;
		if(remaining<=0){ clearNextTimer(); const action=nextPlayAction; if(action) void action(); }
	},1000);
}
function updateNext() {
	if (state.playing?.Type !== 'Episode' || state.live || casting.active || !player.open || viewingBlocked || nextDismissed || nextBusy) { hideNextCard(); return; }
	const ended = video.ended;
	const host = $('#upNext');
	if (!nextEpisode) {
		if (ended) {
			if (host.hidden || nextRenderedId !== null || nextRenderedResult !== nextResult) showNext();
		} else if (!host.hidden) hideNextCard();
		return;
	}
	const duration=mediaDurationMs(), position=mediaPositionMs(), outro=currentOutro();
	if (!TellyboxEpisodeFlow.cardDue(position,duration,ended,outro) && !ended) { hideNextCard(); return; }
	if (host.hidden || nextRenderedId !== nextEpisode.Id || nextRenderedResult !== nextResult) { showNext(); return; }
	armCountdown();
}
video.addEventListener('timeupdate', () => {
	// A live or 24/7 source can reconnect and restart its timestamps earlier. Do
	// not follow it backwards: return to the live edge instead of rewinding.
	if (state.live && !casting.active && !video.seeking && !state.playBlocked && liveFloor > video.currentTime + 2) {
		const ranges = video.seekable;
		let target = 0;
		if (ranges?.length) {
			// Keep the viewer where they were if the new stream still covers it; otherwise
			// go to the live edge.
			for (let i = 0; i < ranges.length; i++) if (liveFloor >= ranges.start(i) && liveFloor <= ranges.end(i)) { target = liveFloor; break; }
			if (!target) target = ranges.end(ranges.length - 1);
		}
		if (Number.isFinite(target) && target > 0) video.currentTime = target;
	}
	liveFloor = video.currentTime;
	const position = video.currentTime;
	skipSegment = TellyboxEpisodeFlow.manualAt(segments, mediaPositionMs(), mediaDurationMs());
	$('#skipIntro').hidden = !skipSegment || casting.active || state.live;
	if (skipSegment) $('#skipIntro').textContent = skipSegment.type === 'Recap' ? 'Skip recap' : 'Skip intro';
	const intro=TellyboxEpisodeFlow.introAt(segments, mediaPositionMs(), mediaDurationMs());
	if(intro && skipIntrosEnabled() && state.playing?.Type==='Episode' && !state.live && !casting.active && !viewingBlocked
		&& !document.hidden && !video.paused && !video.seeking && introLedger.shouldSkip(intro,mediaPositionMs(),mediaDurationMs())) {
		const target=intro.end;
		if (canSeekTo(target)) {
			introLedger.mark(intro);
			$('#skipIntro').hidden = true;
			video.currentTime=target;
		}
	}
	updateNext();
});
function canSeekTo(seconds) {
	const ranges=video.seekable;
	if(!ranges || !ranges.length) return false;
	for(let i=0;i<ranges.length;i++) if(seconds>=ranges.start(i)-0.5 && seconds<=ranges.end(i)+0.5) return true;
	return false;
}
$('#skipIntro').onclick = () => { if (skipSegment) video.currentTime = skipSegment.end; };
async function seriesContinue(item, content, episodes) {
	try {
		const items = episodes || (await api(`/api/web/items/${item.Id}/episodes`)).items;
		// The browser's last-watched episode and watched markers belong to the
		// local viewer. A remote account uses its own server state instead.
		const trusted = browserProgressTrusted();
		const last = trusted ? localStorage.getItem('tellybox-series-' + item.Id) : '';
		const current = trusted ? items.findIndex(episode => episode.Id === last) : -1;
		const playedOnServer = id => items.find(episode => episode.Id === id)?.UserData?.Played === true;
		const watched = id => trusted ? localStorage.getItem('tellybox-watched-' + id) === 'true' : playedOnServer(id);
		const resumeOf = episode => trusted ? getProgress(episode.Id) : itemProgress(episode);
		const target = current >= 0 && resumeOf(items[current]) > 10 ? items[current] : (current >= 0 ? items.slice(current + 1).find(episode => episode.ParentIndexNumber > 0 && !watched(episode.Id)) : null) || items.find(episode => episode.ParentIndexNumber > 0 && !watched(episode.Id)) || items[0];
		if (!target || !content.isConnected) return;
		const resume = resumeOf(target);
		const button = element('button', 'button primary series-continue', [`${resume > 10 ? 'Continue' : watched(target.Id) ? 'Watch again' : 'Watch next'}`, episodeNumber(target), target.Name].filter(Boolean).join(' · '));
		button.onclick = () => startPlayback(target, resume);
		content.insertBefore(button, content.querySelector('.overview'));
	} catch { /* Season browsing remains available when continuation cannot load. */ }
}
$('#previousChannel').onclick = () => previousChannel && startPlayback(previousChannel);
document.addEventListener('visibilitychange', () => {
	if (document.hidden) clearNextTimer(); else updateNext();
	// A throttled or suspended hidden tab must not hand its whole gap to the
	// still-watching monitor as healthy playback. Keep the accumulated time and
	// start a fresh delta at the transition.
	if (stillWatching) stillWatching.transition(playbackClock());
	updateStillWatching();
});
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
	if (state.session === session) { state.session = null; state.sessionBase = ''; state.relayMedia = false; }
	if (state.hls) { state.hls.destroy(); state.hls = null; state.hlsReady = false; }
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
// hls.js is only needed when a stream is HLS. The bundle is loaded on the
// first play, not with the Home page, and every caller shares one load.
let hlsScriptPromise = null;
function loadHlsScript() {
	if (typeof Hls !== 'undefined') return Promise.resolve(true);
	if (hlsScriptPromise) return hlsScriptPromise;
	hlsScriptPromise = new Promise((resolve, reject) => {
		const script = document.createElement('script');
		script.src = '/vendor/hls.min.js';
		script.async = true;
		script.onload = () => {
			const ready = typeof Hls !== 'undefined';
			if (!ready) hlsScriptPromise = null;
			resolve(ready);
		};
		script.onerror = () => {
			hlsScriptPromise = null;
			script.remove();
			reject(new Error('The video player could not load. Please try again.'));
		};
		document.head.append(script);
	});
	return hlsScriptPromise;
}
// Whether hls.js can run here. The bundle may still be loading, so the MSE
// probe mirrors hls.js 1.6's own support check; the real Hls object is used
// once it is available.
function hlsJsSupported() {
	if (typeof Hls !== 'undefined' && typeof Hls.isSupported === 'function') return Hls.isSupported();
	return typeof MediaSource !== 'undefined' && typeof MediaSource.isTypeSupported === 'function'
		&& MediaSource.isTypeSupported('video/mp4; codecs="avc1.42E01E"')
		&& (MediaSource.isTypeSupported('audio/mp4; codecs="mp4a.40.2"') || MediaSource.isTypeSupported('audio/aac'));
}
function playbackCapabilities() {
	const media = document.createElement('video');
	const mse = typeof MediaSource !== 'undefined' && typeof MediaSource.isTypeSupported === 'function';
	const hlsJs = hlsJsSupported();
	const nativeHls = media.canPlayType('application/vnd.apple.mpegurl') !== '';
	if (!hlsJs && !nativeHls) return null;
	// Probe the pipeline the player will actually choose, not both.
	const supported = type => hlsJs ? (mse && MediaSource.isTypeSupported(type)) : (media.canPlayType(type) !== '');
	const audio = document.createElement('audio');
	const audioSupported = type => hlsJs ? (mse && MediaSource.isTypeSupported(type)) : (audio.canPlayType(type) !== '' || media.canPlayType(type) !== '');
	if (!audioSupported('audio/mp4; codecs="mp4a.40.2"') && !audioSupported('audio/aac')) return null;
	const high = supported('video/mp4; codecs="avc1.640028"');
	const main = supported('video/mp4; codecs="avc1.4D401F"');
	const baseline = supported('video/mp4; codecs="avc1.42E01E"');
	const hevc = supported('video/mp4; codecs="hvc1.1.6.L120.B0"') || supported('video/mp4; codecs="hev1.1.6.L120.B0"');
	const videoCodecs = [];
	if (high || main || baseline) videoCodecs.push('h264');
	if (hevc) videoCodecs.push('hevc');
	if (!videoCodecs.length) return null;
	// Keep the advertised H.264 envelope inside the strongest profile actually
	// probed. Main-only browsers stay at 720p; High 4.0 gets 1080p.
	const h264Width = high ? 1920 : main ? 1280 : 720;
	const h264Height = high ? 1080 : main ? 720 : 480;
	const h264Bitrate = high ? 20000000 : main ? 10000000 : 4000000;
	return { videoCodecs, audioCodecs: ['aac'], maxWidth: h264Width, maxHeight: h264Height, maxBitrate: h264Bitrate, maxFps: 30,
		hevcMaxWidth: 1920, hevcMaxHeight: 1080, hevcMaxBitrate: 20000000, hevcMaxFps: 30,
		hevcMain10: hevc && supported('video/mp4; codecs="hvc1.2.4.L120.B0"'), hls: true, mpegTs: true };
}
async function startPlayback(item, position = 0, keepSettings = false, options = {}) {
	// Track indexes belong to one file. Choose English afresh for the next episode.
	keepSettings = keepSettings && state.playing?.Id === item.Id;
	const generation = ++playGeneration;
	state.playStarting = false;
	state.playBlocked = false;
	state.playRetry = false;
	state.playAttempt = null;
	state.hlsReady = false;
	// Start the player bundle in parallel with session teardown. It is awaited
	// only before capability probing, so direct playback still proceeds if the
	// script is unavailable.
	const hlsReady = loadHlsScript().catch(() => false);
	const relayReplacement = keepSettings && state.relayMedia === true && Boolean(state.session) && state.playing?.Id === item.Id;
	resetViewingState();
	saveProgress();
	if(item.Type==='Catchup'&&!keepSettings&&getProgress(item.Id)>0){
		const choice=await chooseCatchupResume(item,getProgress(item.Id));if(choice===null||generation!==playGeneration)return;position=choice;
	}
	// Resolve the local/relay route while the previous session is closing. The
	// probe is capped and cached, so it cannot hold a click indefinitely.
	const playbackBasePromise = playbackBase().catch(() => '');
	try { if (!relayReplacement) await detach(); } catch { $('#playerStatus').textContent = 'The previous stream is still closing. Please try Play again.'; if(nextBusy){nextBusy=false;nextAutoBlocked=true;showNext();} return; }
	if (generation !== playGeneration) return;
	if (item.Type === 'Series') {
		// Series Play/Resume resolves to one exact episode on the server. A
		// series-level position is only a label; never reuse it to enter another
		// episode at the wrong place.
		const target = await api('/api/web/play-target/' + encodeURIComponent(item.Id))
			.catch(error => error.code === 'SERIES_COMPLETE' ? { complete: true } : null);
		if (generation !== playGeneration) return;
		if (target?.complete) { void showDetails(item.Id); return; }
		if (target?.id && target.type === 'Episode') {
			item = { ...item, Id: target.id, Type: 'Episode', Name: target.name || item.Name,
				SeriesId: target.seriesId || item.Id, SeriesName: target.seriesName || item.Name,
				_requestedSeriesId: item.Id };
			position = Math.max(0, Number(target.position) || 0);
		} else {
			// A missing/failed series target must open the episode browser with
			// its availability state, never POST a series id as if it were a film.
			void showDetails(item.Id);
			return;
		}
	}
	state.playing = item; nextEpisode = null; nextResult = null; nextDismissed = false; nextAutoBlocked = false; nextRenderedId = null; nextRenderedResult = null; nextPlayAction = null; introLedger.reset(); hideNextCard();
	// Decide before /api/play so a provider item never flashes the local-only
	// tuning controls. The live flag is confirmed again from the response.
	updatePlaybackTuning(item, false);
	resetPlaybackWarning();
	if (!keepSettings) {
		viewingStarted = false;
		try {
			// Restart a finished title from the beginning. The browser marker is
			// only evidence for a local/at-home viewer; a remote account uses its
			// own server played state, never another account's marker.
			const watchedBefore = browserProgressTrusted()
				? localStorage.getItem('tellybox-watched-' + item.Id) === 'true'
				: item.UserData?.Played === true;
			if (watchedBefore) position = 0;
		} catch {}
	}
	if (item.Type === 'Episode') { void loadNext(generation); void api(`/api/web/items/${item.Id}/segments`).then(result => { if (generation === playGeneration) segments = result.segments || []; }).catch(() => {}); }
	updatePreviousChannelButton();
	started = false;
	if (!keepSettings) {
		state.compatibility = false;
		state.compatibilityRetried = false;
		$('#audioTrack').replaceChildren(new Option('Default', ''));
		$('#subtitleTrack').replaceChildren(new Option('Off', '-1'));
	}
	const freshOpen = !player.open;
	if (freshOpen) playerNavigation.open();
	details.close();
	if (freshOpen) { player.showModal(); loadCastSecureLink(); }
	$('#playerTitle').textContent = playbackTitle(item);
	setPlayerChannelLogo(item);
	$('#playerStatus').textContent = '';playerLoading(true);
	if (routing.home && !routing.direct && routing.origin && routing.preferLocal && !routing.checked) $('#playerStatus').textContent = 'Checking local playback…';
	$('#retryPlayer').disabled = true;
	$('#retryPlain').hidden = true;
	try {
		// /api/play and the relay worker use milliseconds. video.currentTime,
		// saved progress and catch-up resume choices are seconds. Keep the
		// absolute programme position when retrying catch-up rather than
		// restarting at the live edge.
		const capabilities = playbackCapabilities();
		const providerDefaults = Boolean(playbackTuning && playbackTuning.isProviderPlayback(item, false));
		const payload = { textSubtitles: true, id: item.Id, quality: Number($('#quality').value), compatibility: state.compatibility, subtitleIndex: Number($('#subtitleTrack').value), relayMedia: true, position: Math.max(0, Math.round((Number(position) || 0) * 1000)), ...(capabilities ? { capabilities } : {}) };
		if (providerDefaults) {
			// Hidden controls must never send a stale local choice to a provider.
			// Keep the normal visible defaults: Auto quality, no audio override and
			// subtitles off, including when a saved English-subtitle preference is on.
			// The trouble panel's explicit Lower quality action is the one allowed
			// exception; it sets providerQuality for this playback only.
			if (!keepSettings) state.providerQuality = 0;
			payload.quality = Number(state.providerQuality) > 0 ? Number(state.providerQuality) : playbackTuning.PROVIDER_DEFAULT_QUALITY;
			payload.subtitleIndex = -1;
			payload.textSubtitles = false;
		} else {
			if (!keepSettings && playbackPreference('tellybox-english', 'englishSubtitles')) { delete payload.subtitleIndex; payload.preferEnglishSubtitles = true; }
			if ($('#audioTrack').value !== '') payload.audioIndex = Number($('#audioTrack').value);
		}
		if (relayReplacement) payload.replaceSession = state.session;
		const sessionBase = await playbackBasePromise;
		if (generation !== playGeneration || !player.open) return;
		const playback = await api('/api/play', payload, sessionBase);
		if (generation !== playGeneration || !player.open) { await api('/api/sessions/' + playback.session, { action: 'stop' }, sessionBase); return; }
		state.session = playback.session;
		state.sessionBase = sessionBase;
		state.playbackKind = playback.kind;
		state.relayMedia = playback.mediaRoute === 'relay';
		// Effective negotiated ceiling from the play response. Auto resolves
		// against this; an explicit quality choice stays the ceiling because
		// the select value is positive.
		state.playbackQuality = Number(playback.quality) || 0;
		if (relayReplacement && state.hls) { state.hls.destroy(); state.hls = null; state.hlsReady = false; }
		setLiveMode(playback.live === true);
		updatePlaybackTuning(item, playback.live === true);
		// One monitor per server playback session. An automatic next episode
		// reuses the current monitor through transition() so the two-hour total
		// survives the episode change; a deliberate retry or quality change
		// starts a fresh session and a fresh accumulator.
		beginStillWatchingSession(playback.live !== true, options.automatic === true);
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
			liveFloor = 0;
			if (position > 0 && !playback.live) video.currentTime = position;
			if(!state.hls)for(const track of video.textTracks)if(track.label.startsWith('tellybox-subtitle-'))track.mode=track.label==='tellybox-subtitle-'+subtitleValue?'showing':'disabled';
			// Metadata can arrive after the click's transient activation has
			// expired, so call play() as soon as a source exists as well.
			if (video.paused && !state.playBlocked) void beginPlayback(generation);
			updateLiveControls();
		};
		video.onloadedmetadata = begin;
		if (sessionBase) video.crossOrigin = 'anonymous';
		else video.removeAttribute('crossorigin');
		const mediaUrl = new URL(playback.url, sessionBase || location.origin).href;
		// The player bundle is fetched on first play, in parallel with the play
		// request. Wait for it only when the server actually returned HLS.
		if (playback.kind === 'hls' && typeof Hls === 'undefined') {
			await hlsReady;
			if (generation !== playGeneration || !player.open) return;
		}
		for(const track of playback.subtitles.filter(track=>track.url)){const node=document.createElement('track');node.kind='subtitles';node.label=track.label;node.dataset.index=String(track.index);node.src=new URL(track.url,sessionBase||location.origin).href;node.default=String(track.index)===subtitleValue;video.append(node);node.track.mode=node.default?'showing':'disabled';node.addEventListener('load',()=>{if(node.track.mode==='showing'&&!node.track.cues?.length)$('#playerStatus').textContent='No matching captions available. Video can keep playing.';});}
		if (playback.kind === 'hls' && typeof Hls !== 'undefined' && typeof Hls.isSupported === 'function' && Hls.isSupported()) {
			const hls = new Hls({ maxBufferLength:30,backBufferLength:30,startPosition:state.live?-1:position, liveSyncDuration:4, liveMaxLatencyDuration:12, maxLiveSyncPlaybackRate:1.5 });
			state.hls = hls;
			hls.on(Hls.Events.ERROR, (_, data) => {
				if (data.fatal) void playbackFailed('Playback was interrupted. Try compatibility mode, or choose a lower quality.', hls, data);
			});
			hls.on(Hls.Events.SUBTITLE_TRACKS_UPDATED,()=>{const selected=Number($('#subtitleTrack').value);hls.subtitleTrack=hls.subtitleTracks.findIndex(t=>t.name==='tellybox-subtitle-'+selected);});
			hls.on(Hls.Events.MANIFEST_PARSED, () => { if (generation === playGeneration && state.hls === hls) { state.hlsReady = true; nudgePlayback(generation); } });
			hls.loadSource(mediaUrl);
			hls.attachMedia(video);
		} else video.src = mediaUrl;
		$('#playerStatus').textContent = state.live ? (item.Provider==='Dispatcharr'?'Live from Dispatcharr':'Live TV · ready to play') : playback.method === 'DirectPlay' ? 'Original stream · ready to play' : 'Preparing a stream for your browser…';
		nudgePlayback(generation);
	} catch (error) {
		if (generation !== playGeneration) return;
		playerLoading(false);
		if (error.code === 'VIEWING_LIMIT' || error.code === 'SESSION_LIMIT') showViewingBlocked(error.message, generation);
		else if (error.code === 'PAUSED_TIMEOUT' || error.code === 'SESSION_IDLE') showPlaybackClosed(error.message, generation);
		else { $('#playerStatus').textContent = error.message; $('#retryPlayer').disabled = state.playbackKind === 'audio'; $('#retryPlain').hidden = false; }
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

function compatibilityRequiredFailure(failure) {
	const response = failure?.response || failure?.data?.response || failure;
	let code = Number(response?.code || response?.status || failure?.networkDetails?.status);
	let header = response?.headers?.['x-tellybox-compatibility'];
	try { if (!header && failure?.networkDetails?.getResponseHeader) header = failure.networkDetails.getResponseHeader('x-tellybox-compatibility'); } catch {}
	return code === 409 || String(header || '').toLowerCase() === 'required';
}
async function playbackFailed(message, hls, failure) {
	if (viewingBlocked || (hls && state.hls !== hls)) return;
	const generation = playGeneration, session = state.session;
	if (!session) return;
	const denial = policyDenialFromResponse(failure?.response) || policyDenialFromResponse(failure);
	if (denial) { showViewingBlocked(policyMessage(denial, message), generation); return; }
	if (compatibilityRequiredFailure(failure) && !state.compatibility && !state.compatibilityRetried) {
		state.compatibility = true;
		state.compatibilityRetried = true;
		const position = video.currentTime || playbackPosition();
		playerLoading(false);
		$('#playerStatus').textContent = 'Switching to compatibility playback...';
		await startPlayback(state.playing, position, true);
		return;
	}
	playerLoading(false);
	$('#playerStatus').textContent = 'Checking playback status...';
	$('#retryPlayer').disabled = true;
	const base = state.sessionBase;
	const heartbeat = await sendHeartbeat('progress', session, base, 6000);
	if (viewingBlocked || (hls && state.hls !== hls) || !playbackContextCurrent({ generation, session })) return;
	const heartbeatDenial = heartbeat.error && (heartbeat.error.code === 'VIEWING_LIMIT' || heartbeat.error.code === 'SESSION_LIMIT')
		? { code: heartbeat.error.code, message: heartbeat.error.message } : null;
	if (heartbeatDenial) { showViewingBlocked(policyMessage(heartbeatDenial, message), generation); return; }
	if (heartbeat.error && ['PAUSED_TIMEOUT', 'SESSION_IDLE'].includes(heartbeat.error.code)) {
		showPlaybackClosed(heartbeat.error.message, generation); return;
	}
	const data = await queryViewingStatus();
	if (viewingBlocked || (hls && state.hls !== hls) || !playbackContextCurrent({ generation, session })) return;
	if (data?.blocked) { showViewingBlocked(data.message, generation); return; }
	$('#playerStatus').textContent = message;
	$('#retryPlayer').disabled = state.playbackKind === 'audio';
}

function teardownPlayer() {
	++playGeneration;
	resetPlaybackWarning();
	if (stillWatching) stillWatching.reset(playbackClock());
	stillWatching = null;
	hideStillWatching();
	saveProgress();
	void detach().catch(() => { /* Server expiry cleans up unreachable sessions. */ });
	if (fullscreenElement()) void exitFullscreen().catch(() => {});
	player.close();
	void refreshFavouriteOrder();
}

// The player's Back controls and the browser Back button share one path. The
// browsing origin is recorded once when the player first opens, so autoplay,
// retry and quality changes (which keep the player open) never overwrite it.
function closePlayer() {
	playerNavigation.back();
}

// Only reached when there is genuinely no recorded origin (for example a direct
// link straight into playback). Land on home without pushing a history entry.
function goHomeFallback() {
	if (location.pathname === '/' && !location.search) return;
	try { location.replace('/'); } catch { location.href = '/'; }
}

const playerNavigation = (() => {
	let origin = null;
	let pushed = false;
	let returning = false;
	let skipDocument = null;
	let token = 0;
	const KEY = 'tellyboxPlayerOpen';
	const HANDOFF_KEY = 'tellybox-handoff';
	const HANDOFF_TTL = 5 * 60 * 1000;

	// The search/discover documents own their ephemeral UI state (scroll,
	// filters and the discover detail dialog). When a cross-document player Back
	// returns to one of them we leave a one-shot marker in sessionStorage so only
	// that immediate return restores the state; a normal reload, direct link or
	// later visit does not. The marker is tiny, tab-scoped, validated by the
	// target document and cleared there after use.
	function armHandoffMarker(path) {
		if (path !== '/search' && path !== '/discover') return;
		try { sessionStorage.setItem(HANDOFF_KEY, JSON.stringify({ path, expiresAt: Date.now() + HANDOFF_TTL })); } catch {}
	}

	function scrollHost() { return document.scrollingElement || document.documentElement; }
	function capture() {
		const host = scrollHost();
		const active = document.activeElement;
		// The focused element and the details dialog's own reading position are
		// remembered so the return state restores where the viewer was, not
		// just which dialog was open. The element reference is only used when
		// it is still connected, so a re-rendered card is never focused
		// blindly.
		return {
			detailsOpen: details.open,
			detailsScroll: details.open ? details.scrollTop : 0,
			scrollTop: host ? host.scrollTop : 0,
			focus: active && active !== document.body && typeof active.focus === 'function' ? active : null,
		};
	}
	function restore(snapshot) {
		if (!snapshot) return false;
		if (snapshot.detailsOpen && !details.open) details.showModal();
		const host = scrollHost();
		if (host && Number.isFinite(snapshot.scrollTop)) host.scrollTop = snapshot.scrollTop;
		if (Number.isFinite(snapshot.detailsScroll) && details.open) details.scrollTop = snapshot.detailsScroll;
		if (snapshot.focus && snapshot.focus.isConnected && typeof snapshot.focus.focus === 'function') {
			// Focus without scrolling: the restored reading positions above are
			// the return state, not whatever the focus ring would scroll to.
			try { snapshot.focus.focus({ preventScroll: true }); } catch { /* Focus is best-effort only. */ }
		}
		return true;
	}
	// A player opened from a same-origin /search or /discover link lands on the
	// home ?item= handoff. One player Back should return straight to that
	// document instead of stopping on the intermediate home entry. Only a
	// same-origin handoff is skipped, so Back can never traverse outside the app.
	function skipBackDocument() {
		if (location.pathname !== '/' || !new URLSearchParams(location.search).has('item')) return null;
		// go(-2) needs the home handoff and the pushed player entry in this history.
		if (history.length < 3) return null;
		// Search and Discover links carry the origin explicitly. Referrer-Policy is
		// no-referrer, and a stale sessionStorage record must not move a direct link
		// or a Home-origin player somewhere else.
		const from = new URLSearchParams(location.search).get('from');
		return from === 'search' || from === 'discover' ? '/' + from : null;
	}
	function open() {
		if (pushed) return;
		origin = capture();
		returning = false;
		token += 1;
		let ok = true;
		try { history.pushState({ [KEY]: token }, '', location.href); } catch { ok = false; }
		pushed = ok;
		// Record the skip after the push so history.length includes the player entry.
		skipDocument = ok ? skipBackDocument() : null;
	}
	function finish() {
		returning = false;
		const snapshot = origin;
		const handoffTarget = skipDocument;
		origin = null;
		skipDocument = null;
		pushed = false;
		teardownPlayer();
		// A browser Back restores the home details first; leave the marker so a
		// following Back to /search or /discover restores that document's state.
		if (handoffTarget) armHandoffMarker(handoffTarget);
		if (!restore(snapshot)) goHomeFallback();
	}
	function back() {
		if (returning) return;                 // a Back is already in flight: ignore rapid re-clicks
		if (!pushed) { finish(); return; }
		returning = true;
		if (skipDocument) {
			// Stop the session, save progress and exit fullscreen before the
			// document unloads. finish() is not used, so home details are not restored.
			armHandoffMarker(skipDocument);
			teardownPlayer();
			history.go(-2);                    // skip the player and the intermediate home entry
			return;
		}
		history.back();
	}
	function onPopState() {
		if (!pushed) return;
		// Back on the still-watching prompt means Keep watching: restore the
		// player's history entry, clear the accumulator and stay in playback.
		if (player.open && typeof stillWatchingPromptOpen === 'function' && stillWatchingPromptOpen()) {
			try { history.pushState({ [KEY]: token }, '', location.href); } catch {}
			keepWatchingFromPrompt();
			return;
		}
		if (player.open) {
			if (skipDocument) {
				const target = skipDocument;
				skipDocument = null;
				pushed = false;
				origin = null;
				armHandoffMarker(target);
				teardownPlayer();
				history.go(-1);
				return;
			}
			finish();
		}
		else pushed = false;
	}
	return { open, back, onPopState, restore, isPushed: () => pushed, hasOrigin: () => origin !== null };
})();
window.addEventListener('popstate', playerNavigation.onPopState);
// Same-document Home/view restoration runs after the player's handler, which
// owns its own history entry, details/scroll restoration and still-watching
// prompt. The Home handler bails out while that surface is active.
window.addEventListener('popstate', onHomePopState);

video.addEventListener('playing', () => {
	if (casting.active) { video.pause(); return; }
	state.playStarting = false;
	state.playBlocked = false;
	state.playRetry = false;
	playerLoading(false);
	$('#playerStatus').textContent = '';
	if (state.playing?.Type === 'TvChannel') {
		if (lastChannel && lastChannel.Id !== state.playing.Id) previousChannel = lastChannel;
		lastChannel = state.playing; updatePreviousChannelButton();
	}
	beginViewing();
	updateLiveControls();
	updateNext();
	if (!started) { started = true; void report('start'); }
});
video.addEventListener('seeked', () => updateNext());
video.addEventListener('pause', () => {
	updateLiveControls();
	if (keepLivePlayback()) return;
	saveProgress(); void report('progress');
});
video.addEventListener('canplay', () => {
	if (state.playRetry && video.paused && !state.playBlocked) void beginPlayback(playGeneration);
});
video.addEventListener('click', () => {
	if (state.live && state.playBlocked) {
		state.playBlocked = false;
		state.playRetry = false;
		void beginPlayback(playGeneration);
	}
});
video.addEventListener('seeking', keepLiveEdge);
video.addEventListener('ended', () => { if (casting.active) return; hidePlaybackTrouble(); if(playbackWarning)playbackWarning.reset(playbackClock(),''); saveProgress(); void report('progress'); updateCastControls(); updateNext(); });
video.addEventListener('error', () => { hidePlaybackTrouble(); if (playbackWarning) playbackWarning.reset(playbackClock(), ''); if (state.session && !casting.active && !viewingBlocked) void playbackFailed('This browser could not play the stream. Try compatibility mode below.'); });
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

if ($('#heroPlay')) $('#heroPlay').onclick = () => coming.featured && showComingDetails(coming.featured);
if ($('#heroDetails')) $('#heroDetails').onclick = () => coming.featured && showComingDetails(coming.featured);
if ($('#anotherPick')) $('#anotherPick').onclick = anotherPick;
window.addEventListener('tastechange', () => { if (!isHomeView()) return; loadHomeFeed(true); void loadLikedEpisodes(); });
window.addEventListener('favouriteschange', () => { if (!isHomeView()) return; loadHomeFeed(true); void loadLikedEpisodes(); });
document.addEventListener('visibilitychange', () => {
	if (document.hidden || !isHomeView()) return;
	applyDeferredHomeArtwork();
	loadHomeFeed(false);
});
window.addEventListener('focus', () => {
	if (state.session || !isHomeView()) return;
	applyDeferredHomeArtwork();
	loadHomeFeed(false);
});
setInterval(() => { if (!document.hidden && isHomeView()) loadHomeFeed(false); }, 5 * 60 * 1000);
if (details?.addEventListener) details.addEventListener('close', () => {
	if (homeFeedState.deferred) renderHomeFeed();
	else applyDeferredHomeArtwork();
});
if (details?.addEventListener) details.addEventListener('toggle', () => { if (details.open) hideStillWatching(); });
if (player?.addEventListener) player.addEventListener('close', () => {
	if (homeFeedState.deferred) renderHomeFeed();
	else applyDeferredHomeArtwork();
});
$('#closeDetails').onclick = () => details.close();
$('#closePlayer').onclick = closePlayer;
for (const type of ['keydown', 'pointerdown', 'touchstart', 'wheel', 'click']) document.addEventListener(type, deliberatePlaybackInput, true);
document.addEventListener('change', deliberatePlaybackInput, true);
if ($('#stillWatchingKeep')) $('#stillWatchingKeep').onclick = keepWatchingFromPrompt;
if ($('#stillWatchingStop')) $('#stillWatchingStop').onclick = stopFromStillWatching;
// A capture listener sees the prompt before the ordinary cancel handler. The
// keydown path may have already dismissed it, so a recent dismissal is ignored
// rather than closing the player the viewer just chose to keep.
player.addEventListener('cancel', event => {
	const justKept = playbackClock() - stillPromptKeyDismissedAt < 500;
	if (justKept) {
		stillPromptKeyDismissedAt = -Infinity;
		event.preventDefault();
		event.stopImmediatePropagation();
		return;
	}
	if (!stillWatchingPromptOpen()) return;
	event.preventDefault();
	event.stopImmediatePropagation();
	keepWatchingFromPrompt();
}, true);
player.addEventListener('cancel', event => { event.preventDefault(); closePlayer(); });
$('#retryPlayer').onclick = () => { if (viewingBlocked) return; state.compatibility = true; void startPlayback(state.playing, video.currentTime || getProgress(state.playing.Id), true); };
$('#retryPlain').onclick = () => { if (viewingBlocked) return; $('#retryPlain').hidden = true; void startPlayback(state.playing, video.currentTime || getProgress(state.playing.Id)); };
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
$('#search').oninput = () => { stopHomeArtworkContinuation(); updateHomeSections(); clearTimeout(searchTimer); searchTimer = setTimeout(() => loadItems(), 300); };
$('#nav').onclick = event => { const button = event.target.closest('[data-library]'); if (button) selectLibrary(button.dataset.library); };
// Same-document Home/brand navigation on the index page. Search/Discover are
// other documents and are left to the browser; the player owns its own history
// entry, so clicks while it is open are ignored.
document.addEventListener('click', event => {
	if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
	if (location.pathname !== '/') return;
	const anchor = event.target.closest?.('a[href]');
	if (!anchor || anchor.target || anchor.hasAttribute('download')) return;
	let url;
	try { url = new URL(anchor.href, location.href); } catch { return; }
	if (url.origin !== location.origin || url.pathname !== '/') return;
	if (url.searchParams.has('view') || url.searchParams.has('item')) return;
	if (playerNavigation.isPushed() || player.open || state.session || casting.active) return;
	event.preventDefault();
	navigateHome({ mode: 'push', scroll: true });
});
$('#filters').onclick = event => {
	const button = event.target.closest('[data-type]');
	if (!button) return;
	stopHomeArtworkContinuation();
	state.type = button.dataset.type;
	for (const node of document.querySelectorAll('[data-type]')) node.classList.toggle('active', node === button);
	void loadItems();
};

window.addEventListener('online', () => {
	if (state.session || casting.active) return;
	routing.checked = !routing.preferLocal; routing.enabled = false;
	void api('/api/auth/status').then(access => {
		routing.direct = access.local; routing.home = access.home; trustBrowserProgress(access); void revalidateHomeAuthScope(access); updateRouting();
	}).catch(() => window.dispatchEvent(new CustomEvent('tellybox-route', { detail: { route: 'unknown', text: 'Connection unavailable · unable to reach your server.' } })));
});

let sharedFavourites=null, favouriteHome=false, serverFavouritesRequired=false, canShare=false;
// The first Home payload must contain the viewer's favourites, but Home also
// must not wait for a second request afterwards. init starts this request as
// soon as the auth scope is known and loadHomeFeed awaits the same promise
// before it builds the payload, so the feed is fetched once.
let homeFavouritesRequest = null;
let likedEpisodesScheduled = false;
function scheduleLikedEpisodes() {
	if (likedEpisodesScheduled || !isHomeView()) return;
	likedEpisodesScheduled = true;
	const run = () => { likedEpisodesScheduled = false; void loadLikedEpisodes().catch(() => {}); };
	// The rail is outside the first paint. Fetching it once the rows are on
	// screen keeps a 125 KB release lookup off the Home critical path.
	if (typeof window.requestIdleCallback === 'function') window.requestIdleCallback(run, { timeout: 1500 });
	else setTimeout(run, 200);
}
function loadHomeFeeds(){if(homeFeedsStarted)return;homeFeedsStarted=true;void loadHomeFeed().then(scheduleLikedEpisodes,scheduleLikedEpisodes);}
async function init() {
	// Show the compact Home skeleton before any bootstrap await. index.html
	// already marks the document home-pending; this adds the real rail geometry
	// without waiting for capabilities, auth or the feed.
	if (isHomeView()) updateHomeSections();
	// The overlay is markup, so it is already covering the page. Make the page
	// behind it inert for keyboard and assistive tech while it is up, and arm the
	// bounded "still loading" message before any bootstrap await.
	if (isHomeView()) { setBackgroundInert(true); armBootOverlayTimeout(); }
	else hideBootOverlay();
	// Allowed viewers still need to know the system is in maintenance. Blocked
	// viewers never reach this page; they get the 503 maintenance screen.
	void fetch('/api/maintenance', { cache: 'no-store' })
		.then(response => response.ok ? response.json() : null)
		.then(state => { if (state?.enabled) renderMaintenanceBanner(state); })
		.catch(() => {});
	// Capabilities and auth are independent reads. Start both before awaiting
	// either so startup pays one round trip, not two.
	const capabilitiesRequest = api('/api/capabilities').catch(() => null);
	const accessRequest = (async () => await api('/api/auth/status'))();
	const capabilities = await capabilitiesRequest;
	if (capabilities) {
		canShare=Boolean(capabilities.canShare);
		Object.assign(serverPlaybackDefaults, normalisePlaybackDefaults(capabilities.playbackDefaults));
	} else { canShare=false; Object.assign(serverPlaybackDefaults, normalisePlaybackDefaults(null)); }
	applyPlaybackPreferences();
	let access;
	try { access = await accessRequest; } catch (error) {
		$('#status').textContent = error.message;
		if (isHomeView()) bootOverlayError(error.message || 'Tellybox could not check your session.');
		return;
	}
	try {
		routing.direct = access.local;
		routing.home = access.home;
		trustBrowserProgress(access);
		favouriteHome=Boolean((access.local||access.home)&&!access.person);
		serverFavouritesRequired=Boolean(access.local||access.home||access.email);
		setHomeAuthScope(access);
		homeFeedState.authReady = true;
		homeFeedState.access = access;
		// A fresh per-account snapshot paints immediately; the feed below still
		// reconciles it in the background. Without one, the boot overlay stays
		// until the first rows are actually ready.
		const cachedHome = isHomeView() ? readHomeCache(access) : null;
		if (cachedHome) {
			homeFeedState.data = cachedHome;
			homeFeedState.fetchedAt = 0;
			homeFeedState.cacheOrigin = true;
			// Hide first: if a render ever throws, the user must not be left
			// pulsing forever with data already in hand.
			hideBootOverlay();
			const status = $('#homeFeedStatus');
			if (status) status.textContent = CACHE_NOTICE;
			try { renderHomeFeed(); }
			catch {
				homeFeedState.data = null;
				homeFeedState.cacheOrigin = false;
				if (status) status.textContent = '';
			}
		}
		if (!isHomeView()) hideBootOverlay();
		// Favourites stay behind auth. Start that read now; the first feed waits
		// for it inside loadHomeFeed so the payload already has the right
		// context. No forced second feed request is needed on this path.
		const favouritesRequest = serverFavouritesRequired
			? api(favouriteHome ? '/api/favourites/home' : '/api/favourites').catch(() => null)
			: Promise.resolve(null);
		homeFavouritesRequest = favouritesRequest;
		// The personalized feed starts as soon as auth is known. It does not wait
		// for /api/status or /api/libraries; those continue below.
		if (isHomeView()) loadHomeFeeds();
		const favouritesScope = homeFeedState.scope;
		let favourites = null;
		try { favourites = await favouritesRequest; } catch {}
		if (favouritesScope !== homeFeedState.scope) return;
		const feedStartedWithoutFavourites = isHomeView() && serverFavouritesRequired && !homeFeedState.favouritesSettled;
		if (favourites) sharedFavourites = favourites.own;
		homeFeedState.favouritesSettled = Boolean(favourites) || !serverFavouritesRequired;
		// Defensive only: a feed that genuinely started before favourites were
		// known is rebuilt once. The normal path awaited the same request above.
		if (feedStartedWithoutFavourites && favourites) void loadHomeFeed(true);
		const favouriteTools = $('#favouriteViewTools');
		if (favouriteTools && (access.local||access.home) && access.person) {
			const toggle=element('button','chip','Home favourites');
			toggle.type='button';
			toggle.setAttribute('aria-pressed','false');
			toggle.onclick=async()=>{toggle.disabled=true;try{const home=!favouriteHome,result=await api(home?'/api/favourites/home':'/api/favourites');sharedFavourites=result.own;favouriteHome=home;toggle.textContent=home?'My favourites':'Home favourites';toggle.setAttribute('aria-pressed',String(home));updateHomeSections();if(state.type==='favourites')void loadItems();}catch(error){toggle.textContent='Try again';}finally{toggle.disabled=false;}};
			favouriteTools.append(toggle);
		}
		if(favouriteTools && serverFavouritesRequired && Object.keys(browserFavourites()).length) {
			const button=element('button','button secondary',favouriteHome?'Add this browser’s saved titles to home favourites':'Add this browser’s saved titles to my favourites');
			button.id='importBrowserFavourites'; favouriteTools.append(button);
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

		$('#signOut').hidden = access.local || access.home;
		$('#signOut').onclick = async () => {
			if (state.session) await detach();
			clearHomeCaches();
			await api('/api/auth/logout', {});
			location.replace('/login');
		};
		const status = await api('/api/status');
		const features = status.features || {};
		for (const node of document.querySelectorAll('a[href="/discover"]')) node.hidden = !features.discover;
		for (const node of document.querySelectorAll('a[href="/coming-soon"]')) node.hidden = !features.comingSoon;
		updateHomeSections();
		if (!status.connected) throw new Error('Your Tellybox is ready to set up. Connect Jellyfin or Dispatcharr in installation settings to start watching.');
		state.libraries = (await api('/api/libraries')).filter(item=>item.CollectionType!=='livetv');
		for(const library of state.libraries)if(library.CollectionType==='tvshows'&&/^(tv|tv shows|television)$/i.test(library.Name.trim()))library.Name='Series';
		for(const library of state.libraries)if(library.CollectionType==='movies'&&/^(movies|films|cinema)$/i.test(library.Name.trim()))library.Name='Films';
		for(const library of state.libraries)if(library.Name.toLowerCase()==='recordings'){library.LegacyRecordings=true;library.Name='Local recordings';}
		if (features.live) state.libraries.push({Id:'dispatch-tv',CollectionType:'livetv',Name:'Live TV'},{Id:'dispatch-247',CollectionType:'nonstop',Name:'24/7'});
		if (features.recordings) state.libraries.push({Id:'dispatch-recordings',CollectionType:'dvr',Name:'Recordings'});
		for (const library of state.libraries) {
			if(library.LegacyRecordings){const older=element('button','button quiet','Browse local recordings');older.onclick=()=>selectLibrary(library.Id);$('#olderRecordings').append(older);continue;}
		}
		const view=new URLSearchParams(location.search).get('view');
		if(view==='nonstop')selectLibrary('dispatch-247');else if(view==='livetv')selectLibrary('dispatch-tv');else if(view==='recordings')selectLibrary('dispatch-recordings');
		else if(['movies','tvshows'].includes(view)){const library=state.libraries.find(item=>item.CollectionType===view);if(library)selectLibrary(library.Id);else void loadItems();}
		else void loadItems();
		const requestedItem = new URLSearchParams(location.search).get('item');
		if (/^(?:[a-f0-9-]{32,36}|dispatch-live-[a-f0-9-]{36}|dispatch-(?:movie|series)-[1-9]\d*|dispatch-episode-[1-9]\d*-[1-9]\d*)$/i.test(requestedItem || '')) await showDetails(requestedItem);
	} catch (error) {
		$('#status').textContent = error.message;
		// #status lives inside the hidden collection view on Home, so a first-run
		// setup failure used to leave an empty page with no explanation or route
		// to fix it. Put it on the visible Home surface instead.
		if (isHomeView()) {
			hideBootOverlay();
			const feed = $('#homeFeed'), rows = $('#homeRows');
			if (feed && rows) {
				feed.hidden = false;
				const section = element('section', 'home-row home-empty');
				const note = element('p', 'auth-note', error.message || 'Tellybox is not connected yet.');
				const link = element('a', 'button secondary', 'Open installation settings');
				link.href = '/settings';
				section.append(element('h2', '', 'Set up Tellybox'), note, link);
				rows.replaceChildren(section);
			}
		}
	}
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
		window.dispatchEvent(new Event('favouriteschange'));
		if (state.type === 'favourites') void loadItems();
	} catch { /* Keep the last known favourites when reconnecting. */ }
}
window.addEventListener('focus', () => { if (!state.session) void refreshFavouriteOrder(); });
async function changeFavourite(item,saved){
	item=favouriteTitle(item);
	if(!sharedFavourites&&serverFavouritesRequired){const result=await api(favouriteHome?'/api/favourites/home':'/api/favourites');sharedFavourites=result.own;if(!sharedFavourites)throw Error('Couldn’t load favourites. Please try again.');}
	if(!sharedFavourites){const items=readFavourites();if(saved)items[item.Id]=item;else delete items[item.Id];localStorage.setItem('tellybox-favourites',JSON.stringify(items));updateHomeSections();window.dispatchEvent(new Event('favouriteschange'));return;}
	const change={id:item.Id,saved,item};
	const result=await api(favouriteHome?'/api/favourites/home':'/api/favourites',favouriteHome?change:{profileId:sharedFavourites.id,changes:[change]});
	sharedFavourites=favouriteHome?result:result.own;updateHomeSections();window.dispatchEvent(new Event('favouriteschange'));
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
video.addEventListener('waiting',()=>{if(autoplay.loadingVisible({starting:state.playStarting,paused:video.paused,blocked:state.playBlocked}))playerLoading(true);});
video.addEventListener('stalled',()=>{if(!casting.active&&player.open)playerLoading(true);});
video.addEventListener('seeking',()=>{if(!casting.active&&player.open)playerLoading(true);});
video.addEventListener('seeked',()=>{if(video.readyState>=3)playerLoading(false);});
for(const event of ['playing','canplay','ended','error','emptied'])video.addEventListener(event,()=>playerLoading(false));
video.addEventListener('pause',()=>{if(!video.seeking)playerLoading(false);});
setInterval(updatePlaybackTrouble, 1000);
setInterval(updateStillWatching, 1000);
const troubleDismiss=$('#troubleDismiss');
if(troubleDismiss) troubleDismiss.onclick=()=>{ if(playbackWarning) playbackWarning.dismiss(playbackClock()); hidePlaybackTrouble(); };
const troubleRetry=$('#troubleRetry');
if(troubleRetry) troubleRetry.onclick=retryFromTrouble;
const troubleLower=$('#troubleLower');
if(troubleLower) troubleLower.onclick=lowerQualityFromTrouble;
const troubleBack=$('#troubleBack');
if(troubleBack) troubleBack.onclick=closePlayer;
