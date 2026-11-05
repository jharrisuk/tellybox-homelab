const $ = id => document.getElementById(id);
const base = location.pathname.replace(/\/$/, '');
const video = $('video');
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
let session = null;
let hls = null;
let busy = false;
let expired = false;
let expires = 0;
let selectedEpisode = '';
let live = false;
let blocked = false;
async function api(route, body) {
	const response = await fetch(base + route, {
		method: body === undefined ? 'GET' : 'POST', credentials: 'omit', cache: 'no-store',
		headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
		body: body === undefined ? undefined : JSON.stringify(body)
	});
	if (response.status === 410) { endAccess(); throw new Error('This link has expired or been stopped. Ask for a new link.'); }
	if (!response.ok) {
		const data = await response.json().catch(() => ({}));
		const error = new Error(data.error || 'Playback is unavailable. Please try again.');
		error.status = response.status; error.code = data.code || null; error.retryAfter = data.retryAfter;
		throw error;
	}
	return response.status === 204 ? null : response.json();
}
function updateLiveControls() {
	const show = live && !expired;
	$('liveControls').hidden = !show;
	if (show) {
		$('livePlay').hidden = !video.paused || !video.currentSrc;
		$('liveMute').textContent = video.muted ? 'Unmute' : 'Mute';
		$('liveMute').setAttribute('aria-pressed', String(video.muted));
		$('liveFullscreen').textContent = (document.fullscreenElement || document.webkitFullscreenElement || document.webkitCurrentFullScreenElement) ? 'Exit fullscreen' : 'Fullscreen';
	}
}
function setLive(value) {
	live = Boolean(value);
	video.controls = !live;
	video.disablePictureInPicture = live;
	updateLiveControls();
}
function keepLivePlayback() {
	if (!live || busy || expired || blocked) return false;
	video.play().catch(() => {});
	return true;
}
function keepLiveEdge() {
	if (!live || busy || expired || blocked) return;
	const seekable = video.seekable;
	if (!seekable?.length) return;
	const edge = seekable.end(seekable.length - 1);
	if (Number.isFinite(edge) && Math.abs(video.currentTime - edge) > 2) video.currentTime = edge;
}
function stopForPolicy() {
	blocked = true;
	setLive(false);
	video.pause(); hls?.destroy(); hls = null;
	video.removeAttribute('src'); video.load();
	$('play').hidden = true;
	for (const id of ['play', 'subtitles', 'audio', 'quality']) $(id).disabled = true;
	$('status').textContent = 'This shared playback cannot continue right now. Ask the person who shared it for a new link.';
}
function episodeNumber(item) {
	const season = Number.isInteger(item?.ParentIndexNumber) && item.ParentIndexNumber > 0 ? 'S' + item.ParentIndexNumber : '';
	const episode = Number.isInteger(item?.IndexNumber) && item.IndexNumber > 0 ? 'E' + item.IndexNumber : '';
	return [season, episode].filter(Boolean).join(' ');
}
function episodeTitle(item, series) {
	const parts = [], seen = new Set();
	for (const value of [series, episodeNumber(item), item?.Name]) {
		const part = typeof value === 'string' ? value.trim() : '';
		const key = part.toLocaleLowerCase();
		if (!part || seen.has(key)) continue;
		seen.add(key); parts.push(part);
	}
	return parts.join(' · ');
}
function endAccess() {
	expired = true;
	setLive(false);
	video.pause(); hls?.destroy(); hls = null;
	video.removeAttribute('src'); video.load();
	for (const id of ['play', 'subtitles', 'audio', 'quality']) $(id).disabled = true;
	$('status').textContent = 'This link has expired or been stopped. Ask for a new link.';
}
function choices(id, values, selected) {
	$(id).replaceChildren(...values.map(value => new Option(value.label, value.index, false, value.index === selected)));
}
async function play(restart = false) {
	if (busy || expired || blocked) return;
	busy = true;
	const position = restart && !live ? video.currentTime || 0 : 0;
	const previous = session; session = null;
	const subtitleIndex = Number($('subtitles').value || -1);
	const audioIndex = Number($('audio').value);
	for (const id of ['play', 'subtitles', 'audio', 'quality']) $(id).disabled = true;
	$('status').textContent = 'Preparing your video…';
	video.pause(); hls?.destroy(); hls = null;
	video.removeAttribute('src'); video.load();
	try {
		if (previous) await api('/session/' + previous, { action: 'stop', position }).catch(() => {});
		const data = await api('/play', { id: selectedEpisode, quality: Number($('quality').value), compatibility: !live, subtitleIndex, relayMedia: true, position: Number(position) || 0,
			...(restart && Number.isInteger(audioIndex) ? { audioIndex } : {}) });
		session = data.session;
		setLive(data.live === true);
		choices('subtitles', [{ index: -1, label: 'Off' }, ...data.subtitles], subtitleIndex);
		choices('audio', data.audio, restart ? audioIndex : data.audio.find(track => track.selected)?.index);
		video.onloadedmetadata = () => {
			if (position > 0 && !data.live) video.currentTime = position;
			video.play().catch(() => { $('status').textContent = 'Press play on the video to start.'; updateLiveControls(); });
			updateLiveControls();
		};
		const mediaUrl = new URL(data.url, location.origin).href;
		if (data.kind === 'hls' && Hls.isSupported()) {
			hls = new Hls();
			hls.on(Hls.Events.ERROR, (event, error) => {
				if (!error.fatal || blocked || expired) return;
				$('status').textContent = 'Playback interrupted. Select Retry playback.';
				void api('/info').catch(problem => { $('status').textContent = problem.message; });
				$('play').hidden = false;
				$('play').textContent = 'Retry playback';
				$('play').onclick = () => play(true);
			});
			hls.loadSource(mediaUrl); hls.attachMedia(video);
		} else if (data.kind !== 'hls' || video.canPlayType('application/vnd.apple.mpegurl')) video.src = mediaUrl;
		else throw new Error('Please open this link in an up-to-date Chrome, Edge, Firefox or Safari browser.');
		await api('/session/' + session, { action: 'start', position, paused: false });
		$('status').textContent = 'Ready to watch';
		$('play').hidden = true;
	} catch (error) {
		if (error.code === 'VIEWING_LIMIT' || error.code === 'SESSION_LIMIT') stopForPolicy();
		else { $('status').textContent = error.message; $('play').hidden = false; }
	}
	finally {
		busy = false;
		$('play').disabled = expired || blocked;
		$('quality').disabled = expired || blocked || !session;
		$('subtitles').disabled = expired || blocked || !session || $('subtitles').options.length < 2;
		$('audio').disabled = expired || blocked || !session || $('audio').options.length < 2;
	}
}
$('play').onclick = () => play();
for (const id of ['subtitles', 'audio', 'quality']) $(id).onchange = () => play(true);
$('livePlay').onclick = () => { video.play().catch(() => { $('status').textContent = 'Press play on the video to watch live.'; }); };
$('liveMute').onclick = () => { video.muted = !video.muted; updateLiveControls(); };
$('liveFullscreen').onclick = async () => {
	try { if (fullscreenElement()) await exitFullscreen(); else await requestFullscreenOn(document.querySelector('.screen')); }
	catch { /* Fullscreen can be unavailable in some embedded browsers. */ }
};
document.addEventListener('fullscreenchange', updateLiveControls);
document.addEventListener('webkitfullscreenchange', updateLiveControls);
video.addEventListener('pause', () => {
	updateLiveControls();
	if (keepLivePlayback()) return;
});
video.addEventListener('seeking', keepLiveEdge);
video.onplaying = () => { updateLiveControls(); $('status').textContent = live ? 'Live now' : 'Enjoy watching'; };
video.onerror = () => { if (!busy && !expired && !blocked) { $('status').textContent = 'Playback interrupted. Try again.'; $('play').hidden = false; } };
setInterval(() => {
	if (expires && Date.now() >= expires && !expired) endAccess();
	if (session && !busy && !expired && !blocked) void api('/session/' + session, { action: 'progress', position: video.currentTime || 0, paused: live ? false : video.paused })
		.catch(error => { if (error.code === 'VIEWING_LIMIT' || error.code === 'SESSION_LIMIT') stopForPolicy(); else $('status').textContent = error.message; });
}, 10000);
addEventListener('pagehide', () => {
	if (session) void fetch(base + '/session/' + session, { method: 'POST', credentials: 'omit', keepalive: true,
		headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'stop', position: video.currentTime || 0 }) });
});
void api('/info').then(async info => {
	expires = info.expires;
	setLive(info.type === 'TvChannel');
	if(live){$('play').textContent='▶ Watch live';document.querySelector('.eyebrow').textContent='LIVE TV · SHARED WITH YOU';document.querySelector('footer').textContent='This link opens this live channel only. No account needed. Access ends at the time shown above.';}
	$('title').textContent = info.title; document.title = info.title + ' · Tellybox';
	$('overview').textContent = info.overview;
	$('expires').textContent = 'Available until ' + new Date(expires).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
	$('status').textContent = 'No login needed. Make yourself comfortable.';
	if (info.type === 'Series') {
		const data = await api('/episodes');
		const list = document.createElement('section');
		const heading = document.createElement('h2'); heading.textContent = 'Choose an episode'; list.append(heading);
		let season;
		for (const item of data.items) {
			if (season !== item.ParentIndexNumber) { season = item.ParentIndexNumber; const h = document.createElement('h3'); h.textContent = season === 0 ? 'Specials' : 'Season ' + season; list.append(h); }
			const button = document.createElement('button'); button.textContent = [episodeNumber(item), item.Name].filter(Boolean).join(' · ');
			button.onclick = () => { if (busy || expired || blocked) return; selectedEpisode = item.Id; const label = episodeTitle(item, info.title); $('title').textContent = label; document.title = label + ' · Tellybox'; void play(); };
			list.append(button);
		}
		document.querySelector('main').append(list);
		$('play').hidden = true;
	} else $('play').disabled = false;
}).catch(error => { $('title').textContent = 'Link unavailable'; $('status').textContent = error.message; });
