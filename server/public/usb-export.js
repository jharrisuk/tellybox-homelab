(() => {
const exportBox = document.querySelector('#usbExportBox');
if (!exportBox) return;
const exportStatus = document.querySelector('#exportStatus');
const exportVolume = document.querySelector('#exportVolume');
const exportItemsHost = document.querySelector('#exportItems');
const exportSummary = document.querySelector('#exportSummary');
const exportProgress = document.querySelector('#exportProgress');
const exportSearch = document.querySelector('#exportSearch');
const mountButton = document.querySelector('#mountExport');
const planButton = document.querySelector('#planExport');
const startButton = document.querySelector('#startExport');
const cancelButton = document.querySelector('#cancelExport');
const finishButton = document.querySelector('#finishExport');
let catalogue = { movies: [], series: [], episodes: [], recordings: [] };
let plan = null, job = null, poll = null;

const bytes = value => value >= 1073741824 ? (value / 1073741824).toFixed(2) + ' GB' : (value / 1048576).toFixed(1) + ' MB';
const status = text => { exportStatus.textContent = text; };

async function call(route, body) {
	const response = await fetch(route, body === undefined ? { cache: 'no-store' } : {
		method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
	});
	const data = await response.json().catch(() => ({}));
	if (!response.ok) throw new Error(data.error || 'The export request failed.');
	return data;
}

function renderVolume() {
	const previous = exportVolume.value;
	exportVolume.replaceChildren();
	const volumes = exportBox.volumes || [];
	if (!volumes.length) {
		exportVolume.append(new Option('No USB drive detected', ''));
		exportVolume.disabled = true;
		return;
	}
	for (const volume of volumes) exportVolume.append(new Option(`${volume.name} · ${volume.mounted ? bytes(volume.freeBytes) + ' free' : 'not mounted'}${volume.ready ? '' : volume.mounted ? ' · not ready' : ''}`, volume.id));
	exportVolume.disabled = false;
	if (volumes.some(volume => volume.id === previous)) exportVolume.value = previous;
	updateMountButton();
}

function selectedVolume() {
	return (exportBox.volumes || []).find(volume => volume.id === exportVolume.value) || null;
}

function updateMountButton() {
	const volume = selectedVolume();
	mountButton.disabled = !volume?.mountable;
	planButton.disabled = !volume?.ready;
}

function renderItems() {
	const term = exportSearch.value.trim().toLowerCase();
	const groups = [
		['Films', catalogue.movies, item => `${item.name}${item.year ? ' (' + item.year + ')' : ''}`],
		['Series', catalogue.series, item => item.name],
		['Episodes', catalogue.episodes, item => `${item.seriesName || 'Series'} · S${item.season}E${item.episode} · ${item.name}`],
		['Completed local recordings', catalogue.recordings, item => `${item.name}${item.date ? ' · ' + new Date(item.date).toLocaleDateString() : ''}`]
	];
	exportItemsHost.replaceChildren();
	for (const [label, items, text] of groups) {
		const shown = items.filter(item => !term || text(item).toLowerCase().includes(term));
		if (!shown.length) continue;
		const heading = document.createElement('h3'); heading.textContent = label; exportItemsHost.append(heading);
		for (const item of shown.slice(0, 500)) {
			const row = document.createElement('label'); row.className = 'preference-row export-row';
			const span = document.createElement('span'); span.textContent = text(item);
			const input = document.createElement('input'); input.type = 'checkbox'; input.value = item.id; input.dataset.exportId = item.id;
			input.onchange = () => { plan = null; startButton.disabled = true; exportSummary.textContent = 'Selection changed. Review the size again.'; };
			row.append(span, input); exportItemsHost.append(row);
		}
	}
	if (!exportItemsHost.children.length) {
		const note = document.createElement('p'); note.className = 'auth-note'; note.textContent = term ? 'No local items match that search.' : 'No exportable local films, series, episodes or completed recordings were found.';
		exportItemsHost.append(note);
	}
}

function selectedIds() {
	return [...exportItemsHost.querySelectorAll('input[data-export-id]:checked')].map(input => input.value);
}

async function refresh() {
	try {
		const state = await call('/api/export/status');
		exportBox.hidden = false;
		exportBox.volumes = state.volumes || [];
		renderVolume();
		if (!state.enabled) { status(state.reason || 'USB export is not configured.'); planButton.disabled = true; return; }
		if (!state.volumes.length) { status('Plug a USB drive into the media host and refresh.'); planButton.disabled = true; }
		else status('Choose local files and a USB drive. Nothing is copied until you start.');
		catalogue = await call('/api/export/items');
		renderItems();
		updateMountButton();
	} catch (error) {
		exportBox.hidden = false;
		status(error.message);
		planButton.disabled = true;
	}
}

async function review() {
	const ids = selectedIds();
	if (!ids.length) { status('Choose at least one local item.'); return; }
	const drive = selectedVolume();
	if (!drive) { status('Choose a USB drive.'); return; }
	if (!drive.ready) { status('Mount the USB drive before reviewing the export.'); return; }
	planButton.disabled = true;
	try {
		plan = await call('/api/export/plan', { volumeId: exportVolume.value, itemIds: ids });
		exportSummary.textContent = `${plan.files.length} file${plan.files.length === 1 ? '' : 's'} · ${bytes(plan.totalBytes)} · ${bytes(plan.freeBytes)} free on the drive. Existing files are never overwritten.`;
		startButton.disabled = false;
		status('Review the summary, then start the export.');
	} catch (error) { plan = null; startButton.disabled = true; status(error.message); }
	finally { planButton.disabled = false; }
}

async function start() {
	if (!plan) return;
	startButton.disabled = true;
	try {
		job = await call('/api/export/start', { planId: plan.id, confirm: true });
		status('Exporting. Keep the USB drive connected.');
		cancelButton.disabled = false; finishButton.disabled = true;
		poll = setInterval(refreshJob, 1000);
	} catch (error) { startButton.disabled = false; status(error.message); }
}

async function refreshJob() {
	if (!job) return;
	try {
		job = await call('/api/export/jobs/' + job.id);
		const percent = job.totalBytes ? Math.min(100, Math.floor(job.bytes / job.totalBytes * 100)) : 0;
		exportProgress.textContent = `${job.status} · ${percent}% · ${job.filesDone}/${job.filesTotal} files${job.current ? ' · ' + job.current : ''}`;
		if (!['running', 'queued', 'cancelling'].includes(job.status)) {
			clearInterval(poll); poll = null; cancelButton.disabled = true;
			startButton.disabled = false;
			if (job.status === 'complete') { status('Export finished. Finish safely before removing the drive.'); finishButton.disabled = false; }
			else status(job.error || 'Export stopped.');
		}
	} catch (error) { clearInterval(poll); poll = null; status(error.message); }
}

async function cancel() {
	if (!job) return;
	try { job = await call('/api/export/jobs/' + job.id + '/cancel', {}); status('Cancelling and removing partial files...'); }
	catch (error) { status(error.message); }
}

async function finish() {
	if (!exportVolume.value) return;
	try {
		const result = await call('/api/export/finish', { volumeId: exportVolume.value });
		status(result.message || 'Export finished. Unmount the drive from the media host before unplugging.');
		finishButton.disabled = true;
	} catch (error) { status(error.message); }
}

exportVolume.onchange = () => { plan = null; startButton.disabled = true; exportSummary.textContent = 'Review the size for this drive.'; updateMountButton(); };
exportSearch.oninput = renderItems;
mountButton.onclick = async () => {
	const volume = selectedVolume();
	if (!volume) return;
	mountButton.disabled = true;
	try { await call('/api/export/mount', { volumeId: volume.id }); status('USB drive mounted.'); await refresh(); }
	catch (error) { status(error.message); mountButton.disabled = false; }
};
planButton.onclick = review;
startButton.onclick = start;
cancelButton.onclick = cancel;
finishButton.onclick = finish;
document.querySelector('#refreshExport').onclick = refresh;
refresh();
})();
