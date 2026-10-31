const $ = id => document.getElementById(id);
const base = location.pathname.replace(/\/$/, '');
const video = $('video');
let session = null;
let hls = null;
let busy = false;
let expired = false;
let expires = 0;
let selectedEpisode = '';
let live = false;
async function api(route, body) {
	const response = await fetch(base + route, {
		method: body === undefined ? 'GET' : 'POST', credentials: 'omit', cache: 'no-store',
		headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
		body: body === undefined ? undefined : JSON.stringify(body)
	});
	if (response.status === 410) { endAccess(); throw new Error('This link has expired or been stopped. Ask for a new link.'); }
	if (!response.ok) {
		const error = await response.json().catch(() => ({}));
		throw new Error(error.error || 'Playback is unavailable. Please try again.');
	}
	return response.status === 204 ? null : response.json();
}
function endAccess() {
	expired = true;
	video.pause(); hls?.destroy(); hls = null;
	video.removeAttribute('src'); video.load();
	for (const id of ['play', 'subtitles', 'audio', 'quality']) $(id).disabled = true;
	$('status').textContent = 'This link has expired or been stopped. Ask for a new link.';
}
function choices(id, values, selected) {
	$(id).replaceChildren(...values.map(value => new Option(value.label, value.index, false, value.index === selected)));
}
async function play(restart = false) {
	if (busy || expired) return;
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
		const data = await api('/play', { id: selectedEpisode, quality: Number($('quality').value), compatibility: !live, subtitleIndex,
			...(restart && Number.isInteger(audioIndex) ? { audioIndex } : {}) });
		session = data.session;
		choices('subtitles', [{ index: -1, label: 'Off' }, ...data.subtitles], subtitleIndex);
		choices('audio', data.audio, restart ? audioIndex : data.audio.find(track => track.selected)?.index);
		video.onloadedmetadata = () => {
			if (position > 0 && !data.live) video.currentTime = position;
			video.play().catch(() => { $('status').textContent = 'Press play on the video to start.'; });
		};
		if (data.kind === 'hls' && Hls.isSupported()) {
			hls = new Hls();
			hls.on(Hls.Events.ERROR, (event, error) => {
				if (error.fatal) {
					$('status').textContent = 'Playback interrupted. Select Retry playback.';
				void api('/info').catch(problem => { $('status').textContent = problem.message; });
				$('play').hidden = false;
				$('play').textContent = 'Retry playback';
				$('play').onclick = () => play(true);
			}
			});
			hls.loadSource(data.url); hls.attachMedia(video);
		} else if (data.kind !== 'hls' || video.canPlayType('application/vnd.apple.mpegurl')) video.src = data.url;
		else throw new Error('Please open this link in an up-to-date Chrome, Edge, Firefox or Safari browser.');
		await api('/session/' + session, { action: 'start', position, paused: false });
		$('status').textContent = 'Ready to watch';
		$('play').hidden = true;
	} catch (error) { $('status').textContent = error.message; $('play').hidden = false; }
	finally {
		busy = false;
		$('play').disabled = expired;
		$('quality').disabled = expired || !session;
		$('subtitles').disabled = expired || !session || $('subtitles').options.length < 2;
		$('audio').disabled = expired || !session || $('audio').options.length < 2;
	}
}
$('play').onclick = () => play();
for (const id of ['subtitles', 'audio', 'quality']) $(id).onchange = () => play(true);
video.onplaying = () => { $('status').textContent = 'Enjoy watching'; };
video.onerror = () => { if (!busy && !expired) { $('status').textContent = 'Playback interrupted. Try again.'; $('play').hidden = false; } };
setInterval(() => {
	if (expires && Date.now() >= expires && !expired) endAccess();
	if (session && !busy && !expired) void api('/session/' + session, { action: 'progress', position: video.currentTime || 0, paused: video.paused }).catch(error => { $('status').textContent = error.message; });
}, 10000);
addEventListener('pagehide', () => {
	if (session) void fetch(base + '/session/' + session, { method: 'POST', credentials: 'omit', keepalive: true,
		headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'stop', position: video.currentTime || 0 }) });
});
void api('/info').then(async info => {
	expires = info.expires;
	live = info.type === 'TvChannel';
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
			const button = document.createElement('button'); button.textContent = 'Episode ' + item.IndexNumber + ' · ' + item.Name;
			button.onclick = () => { if (busy || expired) return; selectedEpisode = item.Id; $('title').textContent = info.title + ' · ' + item.Name; void play(); };
			list.append(button);
		}
		document.querySelector('main').append(list);
		$('play').hidden = true;
	} else $('play').disabled = false;
}).catch(error => { $('title').textContent = 'Link unavailable'; $('status').textContent = error.message; });
