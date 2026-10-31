const message = document.querySelector('#appMessage');
function node(tag, text, className) { const element = document.createElement(tag); if (text) element.textContent = text; if (className) element.className = className; return element; }
async function request(path, body) {
	const response = await fetch(path, { method: body ? 'POST' : 'GET', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
	const data = await response.json().catch(() => ({}));
	if (!response.ok) throw new Error(data.error || 'Could not update these settings.');
	return data;
}
function field(parent, label, input) { const wrap = node('label', label, 'auth-field'); wrap.append(input); parent.append(wrap); return input; }
function button(label, run, primary = false) { const result = node('button', label, 'button ' + (primary ? 'primary' : 'secondary')); result.type = 'button'; result.onclick = run; return result; }
function seen(device) { return device.lastSeen ? 'Last connected ' + new Date(device.lastSeen).toLocaleString() : 'Last connection not recorded by older builds'; }
function cleanup(devices) {
	const candidates = devices.filter(device => !device.identified && ['approved', 'pending'].includes(device.status));
	const dialog = node('dialog', null, 'device-dialog'), form = node('form'); dialog.append(form);
	form.append(node('h2', 'Review older installations'), node('p', 'First open the updated app on each device you still use. It will be marked “Recognised device”. Select only installations you no longer use. Access will stop; their favourites collections are kept.', 'auth-note'));
	const checks = [];
	for (const device of candidates) {
		const label = node('label', null, 'collection-choice'), check = node('input'); check.type = 'checkbox'; check.value = device.id;
		label.append(check, node('span', `${device.name} · ${device.role} · ${device.id.slice(0, 8)} — ${seen(device)}`)); form.append(label); checks.push(check);
	}
	if (!candidates.length) form.append(node('p', 'No older installations to review.'));
	const status = node('p'); status.setAttribute('role', 'status'); form.append(status);
	const remove = button('Remove selected access', async () => {
		const selected = checks.filter(check => check.checked);
		if (!selected.length || !confirm(`Revoke access for these ${selected.length} selected installations? Favourites collections will be kept.`)) return;
		remove.disabled = true;
		try {
			for (const check of selected) { await request('/api/apps/' + check.value, { action: 'revoke' }); check.disabled = true; check.checked = false; }
			dialog.close(); await load();
		} catch (error) { status.textContent = error.message; remove.disabled = false; }
	});
	form.append(remove, button('Close', () => dialog.close()));
	dialog.addEventListener('close', () => dialog.remove()); document.body.append(dialog); dialog.showModal();
}
async function manage(device, favourites) {
	const dialog = node('dialog', null, 'device-dialog'), form = node('form'); dialog.append(form);
	const header = node('div', null, 'settings-heading'); header.append(node('h2', 'Manage device'), button('Close', () => dialog.close())); form.append(header);
	form.append(node('p', `${seen(device)} · Device ${device.id.slice(0, 8)} · ${device.identified ? 'Recognised device' : 'Open the updated app to recognise this device'}`, 'auth-note'));
	const name = field(form, 'Device name', node('input')); name.value = device.name; name.required = true; name.minLength = 2; name.maxLength = 80;
	const role = field(form, 'Access', node('select'));
	for (const [value, label] of [['viewer', 'Viewer — watch and request'], ['admin', 'Admin — manage Tellybox']]) { const option = node('option', label); option.value = value; role.append(option); }
	role.value = device.role;
	if (typeof addPersonLink === 'function') {
		try {
			const directory = await request('/api/people');
			addPersonLink(form, device, directory, async () => { dialog.close(); await load(); });
			if (!directory.devices?.[device.id]) addAccountLimits(dialog, 'device:' + device.id);
		} catch (error) { form.append(node('p', 'Account links could not be loaded. ' + error.message, 'auth-note')); }
	}
	let own, collectionName, linked;
	const config = favourites.devices[device.id];
	if (device.status === 'approved' && config) {
		form.append(node('h3', 'Favourites'), node('p', 'Keep a person’s collection separate from their device name. Linked collections appear on this device’s Everyone view.', 'auth-note'));
		if (device.personId) form.append(node('p', `Linked to ${device.personName}. Collection changes apply to this person’s web login and linked devices.`, 'auth-note'));
		own = field(form, device.personId ? 'This person’s collection' : 'This device’s collection', node('select'));
		for (const profile of favourites.profiles) { const option = node('option', `${profile.name} · ${profile.count} favourites`); option.value = profile.id; own.append(option); }
		const fresh = node('option', 'Create a new collection…'); fresh.value = 'new'; own.append(fresh); own.value = config.profileId;
		collectionName = field(form, 'Collection name', node('input')); collectionName.required = true; collectionName.minLength = 2; collectionName.maxLength = 80;
		linked = node('fieldset', null, 'linked-collections'); linked.append(node('legend', 'Also show favourites from'));
		for (const profile of favourites.profiles) {
			const label = node('label', null, 'collection-choice'), check = node('input'); check.type = 'checkbox'; check.value = profile.id;
			check.checked = config.linkedProfiles.includes(profile.id); label.append(check, node('span', profile.name)); linked.append(label);
		}
		function selection() {
			collectionName.value = favourites.profiles.find(p => p.id === own.value)?.name || '';
			for (const check of linked.querySelectorAll('input')) { check.disabled = check.value === own.value; if (check.disabled) check.checked = false; }
		}
		own.onchange = selection; selection(); form.append(linked);
		form.append(node('p', 'Linking shares favourites only. It never grants admin rights. Unlinking keeps the original collection.', 'auth-note'));
	}
	const status = node('p'); status.setAttribute('role', 'status'); form.append(status);
	const save = node('button', device.status === 'pending' ? 'Approve device' : 'Save changes', 'button primary'); save.type = 'submit'; form.append(save);
	form.onsubmit = async event => {
		event.preventDefault();
		if (role.value === 'admin' && (device.role !== 'admin' || device.status === 'pending') && !confirm(`Allow ${name.value} to manage devices and server settings?`)) return;
		save.disabled = true; status.textContent = 'Saving…';
		try {
			let profileId = own?.value;
			if (profileId === 'new') profileId = (await request('/api/favourites/profiles', { name: collectionName.value })).id;
			else if (profileId && collectionName.value !== favourites.profiles.find(p => p.id === profileId)?.name) await request('/api/favourites/profiles/' + profileId, { name: collectionName.value });
			if (name.value !== device.name) await request('/api/apps/' + device.id, { action: 'rename', name: name.value });
			if (device.status === 'pending' || role.value !== device.role) await request('/api/apps/' + device.id, { action: device.status === 'pending' ? 'approve' : 'role', role: role.value });
			if (profileId) await request('/api/favourites/devices/' + device.id, { profileId, linkedProfiles: [...linked.querySelectorAll('input:checked')].map(input => input.value).filter(id => id !== profileId) });
			dialog.close(); await load();
		} catch (error) { status.textContent = error.message; save.disabled = false; }
	};
	const danger = node('details', null, 'device-danger'); danger.append(node('summary', 'Remove access'), node('p', 'Online access stops. Offline downloads and saved favourites are kept.', 'auth-note'));
	danger.append(button(device.status === 'pending' ? 'Reject request' : 'Revoke access', async () => {
		if (!confirm(`Remove access for ${device.name}?`)) return;
		try { await request('/api/apps/' + device.id, { action: 'revoke' }); dialog.close(); await load(); } catch (error) { status.textContent = error.message; }
	})); form.append(danger);
	dialog.addEventListener('close', () => dialog.remove()); document.body.append(dialog); dialog.showModal();
}
async function load() {
	try {
		const [{ devices }, favourites, directory] = await Promise.all([request('/api/apps'), request('/api/favourites/manage'), typeof loadPeople === 'function' ? request('/api/people') : null]);
		const list = document.querySelector('#appDevices'); list.replaceChildren();
		let cleanupButton = document.querySelector('#cleanupDevices');
		if (!cleanupButton) { cleanupButton = button('Review older installations', () => {}); cleanupButton.id = 'cleanupDevices'; document.querySelector('#refreshApps').after(cleanupButton); }
		cleanupButton.onclick = () => cleanup(devices);
		const pending = devices.filter(device => device.status === 'pending').length;
		const unlinkedPending = devices.filter(device => device.status === 'pending' && !directory?.people.some(person => person.id === directory.devices?.[device.id])).length;
		message.textContent = unlinkedPending ? `${unlinkedPending} ${unlinkedPending === 1 ? 'device needs' : 'devices need'} your approval` : 'All caught up. New requests will appear here.';
		const summary = document.querySelector('#deviceSummary'); if (summary) summary.textContent = `${devices.filter(d => d.status === 'approved').length} approved · ${pending} awaiting approval`;
		const approval = document.querySelector('#approvalSummary');
		if (typeof updateAccessSummary === 'function') updateAccessSummary('devices', pending);
		else if (approval) approval.textContent = pending ? `${pending} to review` : 'All caught up';
		for (const device of devices.filter(d => ['pending', 'approved'].includes(d.status)).sort((a, b) => Number(b.status === 'pending') - Number(a.status === 'pending') || Number(b.identified) - Number(a.identified) || (b.lastSeen || 0) - (a.lastSeen || 0) || a.name.localeCompare(b.name))) {
			if (directory?.people.some(person => person.id === directory.devices?.[device.id])) continue;
			if (typeof filterAccessRows === 'function') {
				const row = node('article', null, 'access-row');
				row.dataset.accessSearch = `${device.name} ${device.personName || ''} ${device.id}`.toLowerCase();
				const identity = node('div', null, 'access-identity'); identity.append(node('h3', device.name));
				identity.append(node('p', device.personName || 'Separate device account', 'auth-note'), node('p', seen(device), 'auth-note'));
				if (device.status === 'pending') identity.append(node('p', 'Pairing code: ' + device.code, 'approval-code'));
				const label = device.status === 'pending' ? 'Awaiting approval' : device.role === 'admin' ? 'Admin' : 'Viewer';
				row.append(identity, node('span', label, 'access-badge ' + device.status), button(device.status === 'pending' ? 'Review request' : 'Manage', () => manage(device, favourites), device.status === 'pending')); list.append(row);
				continue;
			}
			const section = node('section', null, 'settings-box device-card');
			section.dataset.accessSearch = `${device.name} ${device.personName || ''} ${device.id}`.toLowerCase();
			section.append(node('p', device.status === 'pending' ? 'AWAITING APPROVAL' : device.role === 'admin' ? 'ADMINISTRATOR' : 'VIEWER', 'eyebrow'), node('h3', device.name));
			section.append(node('p', device.identified ? 'Recognised device' : 'Older installation · ' + device.id.slice(0, 8), 'auth-note'), node('p', seen(device), 'auth-note'));
			if (device.status === 'pending') section.append(node('p', device.code, 'approval-code'));
			else {
				const config = favourites.devices[device.id], profile = favourites.profiles.find(p => p.id === config?.profileId);
				section.append(node('p', profile ? `Favourites: ${profile.name}` : 'Favourites ready to set up', 'auth-note'));
				const names = favourites.profiles.filter(p => config?.linkedProfiles.includes(p.id)).map(p => p.name);
				if (names.length) section.append(node('p', 'Linked: ' + names.join(', '), 'auth-note'));
			}
			section.append(button(device.status === 'pending' ? 'Review request' : 'Manage', () => manage(device, favourites), device.status === 'pending')); list.append(section);
		}
		if (directory) await loadPeople(directory);
		if (typeof filterAccessRows === 'function') filterAccessRows();
	} catch (error) { message.textContent = error.message; }
}
document.querySelector('#refreshApps').onclick = load;
void load();
