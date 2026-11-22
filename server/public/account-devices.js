// Q70: the signed-in account holder's own devices. Shows the per-platform
// allowances, links a device by the short code it displays, and removes a
// device to free a slot. Only ever reads /api/people/me: no other account's
// data is available here, and the section stays hidden without an email
// account session (local and home browsing needs no account).
(() => {
	const section = document.querySelector('#accountDevices');
	if (!section) return;
	const summary = document.querySelector('#accountSummary');
	const allowanceLine = document.querySelector('#deviceAllowanceSummary');
	const usageLine = document.querySelector('#accountUsageSummary');
	const list = document.querySelector('#accountDeviceList');
	const form = document.querySelector('#linkDeviceForm');
	const codeInput = document.querySelector('#linkDeviceCode');
	const message = document.querySelector('#linkDeviceMessage');
	const submit = form.querySelector('button');
	async function call(path, body) {
		const response = await fetch(path, {
			method: body ? 'POST' : 'GET', credentials: 'same-origin',
			headers: body ? { 'Content-Type': 'application/json' } : { Accept: 'application/json' },
			body: body ? JSON.stringify(body) : undefined
		});
		const data = await response.json().catch(() => ({}));
		if (!response.ok) throw new Error(data.error || 'Could not reach your account. Refresh and try again.');
		return data;
	}
	function limitText(limit) { return Number(limit) > 0 ? String(limit) : 'unlimited'; }
	function duration(seconds) {
		const total = Math.max(0, Math.floor(Number(seconds) || 0));
		const hours = Math.floor(total / 3600), minutes = Math.round((total % 3600) / 60);
		if (hours && minutes) return hours + 'h ' + minutes + 'm';
		if (hours) return hours + 'h';
		if (minutes) return minutes + 'm';
		return total > 0 ? '<1m' : '0m';
	}
	function render(data) {
		section.hidden = false;
		summary.textContent = data.person.email;
		allowanceLine.textContent = 'Phones ' + data.allowances.phone.used + ' of ' + limitText(data.allowances.phone.limit)
			+ ' · TVs ' + data.allowances.tv.used + ' of ' + limitText(data.allowances.tv.limit);
		const bits = [];
		if (data.limits) {
			bits.push(data.watchingNow === 1 ? '1 screen in use now' : data.watchingNow + ' screens in use now');
			const daily = Number(data.limits.dailyMinutes);
			bits.push(daily > 0 ? duration(data.limits.dailySeconds) + ' of ' + duration(daily * 60) + ' today' : duration(data.limits.dailySeconds) + ' today');
			bits.push(data.limits.downloads ? 'Downloads allowed' : 'Downloads off');
		}
		usageLine.textContent = bits.join(' · ');
		list.replaceChildren();
		if (!data.devices.length) {
			const empty = document.createElement('p'); empty.className = 'auth-note'; empty.textContent = 'No phones or TVs linked yet. Use the code below to add one.'; list.append(empty);
		}
		for (const device of data.devices) {
			const row = document.createElement('article'); row.className = 'access-row';
			const identity = document.createElement('div'); identity.className = 'access-identity';
			const title = document.createElement('h3');
			const platform = device.platform === 'tv' ? 'TV' : device.platform === 'phone' ? 'Phone' : 'Device';
			title.textContent = device.name + ' · ' + platform;
			identity.append(title);
			const note = document.createElement('p'); note.className = 'auth-note';
			note.textContent = device.status === 'pending' ? 'Awaiting approval' : device.lastSeen ? 'Last connected ' + new Date(device.lastSeen).toLocaleString() : 'Linked to your account';
			identity.append(note);
			const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'button secondary'; remove.textContent = 'Remove';
			remove.onclick = async () => {
				if (!confirm('Remove ' + device.name + ' from your account? It keeps its own device access until an administrator revokes it, and you can link it again later.')) return;
				remove.disabled = true;
				try { await call('/api/people/me/devices', { deviceId: device.id, action: 'remove' }); message.textContent = 'Removed ' + device.name + '.'; await load(); }
				catch (error) { message.textContent = error.message; remove.disabled = false; }
			};
			row.append(identity, remove); list.append(row);
		}
	}
	async function load() {
		try { render(await call('/api/people/me')); }
		catch { section.hidden = true; }
	}
	form.onsubmit = async event => {
		event.preventDefault();
		if (!form.reportValidity()) return;
		submit.disabled = true; message.textContent = 'Linking...';
		try {
			const result = await call('/api/people/link-code', { code: codeInput.value.trim() });
			message.textContent = 'Linked ' + (result.device?.name || 'device') + ' to your account.';
			codeInput.value = '';
			await load();
		} catch (error) { message.textContent = error.message; }
		finally { submit.disabled = false; }
	};
	void load();
})();
