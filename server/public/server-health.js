(() => {
	const panel = document.querySelector('[data-settings="server"]');
	const status = document.querySelector('#healthStatus');
	const refresh = document.querySelector('#refreshHealth');
	let pending = false;
	const node = (tag, text, className) => {
		const element = document.createElement(tag);
		if (text !== undefined) element.textContent = text;
		if (className) element.className = className;
		return element;
	};
	const finite = value => typeof value === 'number' && Number.isFinite(value);
	const bytes = value => {
		if (!finite(value)) return 'Unavailable';
		if (value < 1024) return Math.round(value) + ' B';
		if (value < 1024 ** 2) return (value / 1024).toFixed(1) + ' KiB';
		if (value < 1024 ** 3) return (value / 1024 ** 2).toFixed(1) + ' MiB';
		return value >= 1024 ** 4 ? (value / 1024 ** 4).toFixed(2) + ' TiB' : (value / 1024 ** 3).toFixed(1) + ' GiB';
	};
	const duration = seconds => {
		if (!finite(seconds)) return 'Unavailable';
		const days = Math.floor(seconds / 86400), hours = Math.floor(seconds / 3600) % 24, minutes = Math.floor(seconds / 60) % 60;
		return days ? days + 'd ' + hours + 'h' : hours ? hours + 'h ' + minutes + 'm' : minutes + 'm';
	};
	const meter = (value, label) => {
		const element = node('progress'); element.max = 100; element.value = Math.max(0, Math.min(100, value)); element.setAttribute('aria-label', label); return element;
	};
	function card(title, value, description, percentage) {
		const card = node('div', undefined, 'health-card');
		card.append(node('span', title, 'health-label'), node('strong', value, 'health-value'), node('small', description));
		if (finite(percentage)) card.append(meter(percentage, title));
		return card;
	}
	function render(data) {
		const host = data.host, memory = host?.memory, bandwidth = data.bandwidth || {}, service = data.service || {};
		const used = finite(memory?.total) && finite(memory?.available) ? Math.max(0, memory.total - memory.available) : null;
		const usedPercent = used !== null && memory.total > 0 ? used / memory.total * 100 : null;
		const stale = !host || host.stale;
		status.classList.toggle('health-warning', stale);
		status.textContent = !host ? 'Host readings are unavailable. Tellybox readings are still shown below.' : (host.stale ? 'Host readings are out of date. Last recorded ' : 'Host sampled ') + new Date(host.sampledAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) + (host.stale ? ' — the collector may have stopped.' : ' · refreshed ' + new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
		const metrics = document.querySelector('#healthMetrics');
		metrics.replaceChildren(
			card('CPU', finite(host?.cpuPercent) ? host.cpuPercent.toFixed(1) + '%' : '—', host ? host.sampleSeconds + '-second sample · ' + host.cpuThreads + ' logical cores' : 'Waiting for a host reading', host?.cpuPercent),
			card('Memory', finite(usedPercent) ? Math.round(usedPercent) + '%' : '—', used !== null ? bytes(used) + ' of ' + bytes(memory.total) + ' in use' : 'Waiting for a host reading', usedPercent),
			card('Remote upload', finite(bandwidth.measuredMbps) ? bandwidth.measuredMbps.toFixed(1) + ' Mbps' : '—', '10-second average · ' + (bandwidth.mbps === 0 ? 'no cap' : bandwidth.mbps + ' Mbps cap'), bandwidth.mbps > 0 ? bandwidth.measuredMbps / bandwidth.mbps * 100 : null),
			card('Watching now', String(service.watching ?? '—'), (bandwidth.activeTransfers ?? 0) + ' remote transfers moving data now')
		);
		const disks = document.querySelector('#healthDisks'); disks.replaceChildren();
		if (!host?.disks?.length) disks.append(node('p', 'Disk readings are unavailable.'));
		for (const disk of host?.disks || []) {
			const card = node('div', undefined, 'health-disk'); card.append(node('h4', disk.label));
			if (!disk.available || !(disk.total > 0) || !finite(disk.free) || !finite(disk.used)) {
				card.append(node('p', disk.reason || 'Disk readings unavailable', 'health-warning'));
			} else {
				const low = disk.free / disk.total < 0.1;
				card.append(node('strong', bytes(disk.free) + ' free', 'health-disk-free'), meter(disk.used / disk.total * 100, disk.label + ' used space'), node('small', bytes(disk.used) + ' used · ' + bytes(disk.total) + ' total'));
				if (low) card.append(node('p', 'Running low — less than 10% available.', 'health-warning'));
			}
			disks.append(card);
		}
		const details = document.querySelector('#healthDetails'); details.replaceChildren();
		for (const [label, value] of [
			['Machine uptime', duration(host?.uptimeSeconds)], ['Tellybox uptime', duration(service.uptimeSeconds)], ['Tellybox process memory', bytes(service.memoryBytes)],
			['Swap in use', memory ? bytes(memory.swapUsed) + ' of ' + bytes(memory.swapTotal) : 'Unavailable'],
			['Load average · 1 / 5 / 15 minutes', host?.load?.length === 3 ? host.load.map(value => finite(value) ? value.toFixed(2) : '—').join(' / ') : 'Unavailable'],
			['CPU waiting for disk I/O', finite(host?.ioWaitPercent) ? host.ioWaitPercent.toFixed(1) + '%' : 'Unavailable']
		]) details.append(node('dt', label), node('dd', value));
	}
	async function update() {
		if (pending || panel.hidden || document.hidden) return;
		pending = true; refresh.disabled = true;
		try {
			const response = await fetch('/api/auth/server-health', { cache: 'no-store', signal: AbortSignal.timeout(8000) });
			if (!response.ok) throw new Error(response.status === 403 || response.status === 401 ? 'Server stats require settings access.' : 'Could not refresh server stats.');
			render(await response.json());
		} catch (error) {
			status.classList.add('health-warning'); status.textContent = (error.name === 'TimeoutError' ? 'The server took too long to respond.' : error.message) + ' Any readings below are from the last successful refresh.';
		} finally { pending = false; refresh.disabled = false; }
	}
	refresh.onclick = update;
	for (const tab of document.querySelectorAll('[data-panel]')) tab.addEventListener('click', update);
	document.addEventListener('visibilitychange', update);
	setInterval(update, 30000);
})();
