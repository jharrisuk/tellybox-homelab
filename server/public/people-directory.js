let peopleDirectory = { people: [], apps: [], devices: {}, localBrowsers: [] };
const accessCounts = { accounts: 0, devices: 0 };
function peopleElement(tag, text, className) {
	const element = document.createElement(tag);
	if (text) element.textContent = text;
	if (className) element.className = className;
	return element;
}
function peopleButton(text, run, primary = false) {
	const button = peopleElement('button', text, 'button ' + (primary ? 'primary' : 'secondary'));
	button.type = 'button'; button.onclick = run; return button;
}
function updateAccessSummary(kind, count) {
	accessCounts[kind] = count;
	const total = accessCounts.accounts + accessCounts.devices;
	const summary = document.querySelector('#approvalSummary');
	if (summary) summary.textContent = total ? `${total} awaiting approval` : 'All caught up';
	const linkedPending = peopleDirectory.apps.filter(device => device.status === 'pending' && peopleDirectory.people.some(person => person.id === peopleDirectory.devices?.[device.id])).length;
	for (const [name, pending] of [['accounts', accessCounts.accounts + linkedPending], ['devices', Math.max(0, accessCounts.devices - linkedPending)]]) {
		const tab = document.querySelector(`[data-access-tab="${name}"] .access-count`);
		if (tab) { tab.textContent = pending ? String(pending) : ''; tab.hidden = !pending; }
	}
}
function filterAccessRows() {
	const query = document.querySelector('#accessSearch')?.value.trim().toLowerCase() || '';
	const status = document.querySelector('#accountStatus')?.value || 'all';
	for (const row of document.querySelectorAll('[data-access-search]')) {
		row.hidden = !row.dataset.accessSearch.includes(query) || (row.dataset.accountStatus && status !== 'all' && row.dataset.accountStatus !== status);
	}
	for (const panel of document.querySelectorAll('[data-access-panel]')) {
		const empty = panel.querySelector('.access-empty');
		if (empty) empty.hidden = Boolean(panel.querySelector('[data-access-search]:not([hidden])'));
	}
}
function showAccessPanel(name) {
	for (const tab of document.querySelectorAll('[data-access-tab]')) {
		const active = tab.dataset.accessTab === name;
		tab.classList.toggle('active', active); tab.setAttribute('aria-pressed', String(active));
	}
	for (const panel of document.querySelectorAll('[data-access-panel]')) panel.hidden = panel.dataset.accessPanel !== name;
	filterAccessRows();
}
for (const tab of document.querySelectorAll('[data-access-tab]')) tab.onclick = () => showAccessPanel(tab.dataset.accessTab);
document.querySelector('#accessSearch').oninput = filterAccessRows;
document.querySelector('#accountStatus').onchange = filterAccessRows;
document.querySelector('#refreshPeople').onclick = () => { void load(); };

function peopleDialog(title) {
	const dialog = peopleElement('dialog', null, 'device-dialog account-dialog');
	const heading = peopleElement('div', null, 'settings-heading');
	const id = 'accountDialogTitle';
	const label = peopleElement('h2', title); label.id = id; dialog.setAttribute('aria-labelledby', id);
	heading.append(label, peopleButton('Close', () => dialog.close())); dialog.append(heading);
	dialog.addEventListener('close', () => dialog.remove());
	document.body.append(dialog); return dialog;
}
function accountDevices(person) {
	return peopleDirectory.apps.filter(device => ['approved', 'pending'].includes(device.status) && peopleDirectory.devices?.[device.id] === person.id);
}
function peopleStatus(person) {
	return { pending: 'Awaiting approval', approved: 'Approved', revoked: 'Blocked' }[person.status] || person.status;
}
function linkedDeviceButton(device) {
	const button = peopleButton('Manage', async () => {
		button.disabled = true;
		try {
			const [{ devices }, favourites] = await Promise.all([authRequest('/api/apps'), authRequest('/api/favourites/manage')]);
			const current = devices.find(entry => entry.id === device.id);
			if (!current) throw Error('This device is no longer available. Refresh the list.');
			await manage(current, favourites);
		} catch (error) { document.querySelector('#peopleMessage').textContent = error.message; }
		finally { button.disabled = false; }
	});
	button.setAttribute('aria-label', 'Manage ' + device.name); return button;
}
function addPersonLink(parent, device, directory, onSaved) {
	const section = peopleElement('section', null, 'account-link');
	section.append(peopleElement('h3', 'Account'));
	const label = peopleElement('label', 'Link to email account', 'auth-field');
	const select = document.createElement('select');
	select.setAttribute('aria-label', 'Link to email account');
	select.append(new Option('Separate device · no email account', ''));
	for (const person of directory.people.filter(p => p.status === 'approved')) select.append(new Option(person.email, person.id));
	const current = directory.devices?.[device.id] || '';
	// Keep a blocked account visible; opening a dialog must never silently unlink it.
	const existing = directory.people.find(p => p.id === current);
	if (existing && existing.status !== 'approved') select.append(new Option(existing.email + ' · ' + peopleStatus(existing), existing.id));
	select.value = current; label.append(select); section.append(label);
	section.append(peopleElement('p', 'Linked devices share this account’s favourites and viewing allowance. Device admin rights stay separate.', 'auth-note'));
	const message = peopleElement('p'); message.setAttribute('role', 'status');
	const save = peopleButton('Save account link', async () => {
		save.disabled = true;
		try {
			await authRequest('/api/people', { action: select.value ? 'device' : 'unlink', id: select.value, deviceId: device.id });
			await loadPeople(); await onSaved();
		} catch (error) { message.textContent = error.message; save.disabled = false; }
	});
	select.onchange = () => { save.disabled = select.value === current; }; save.disabled = true;
	section.append(save, message); parent.append(section);
	if (current) section.append(peopleElement('p', 'Viewing limits are managed from the linked account.', 'auth-note'));
}
function managePerson(person) {
	const dialog = peopleDialog('Manage account');
	dialog.append(peopleElement('p', person.email, 'account-email'), peopleElement('span', peopleStatus(person), 'access-badge ' + person.status));
	const devices = accountDevices(person), browsers = peopleDirectory.localBrowsers.filter(b => b.personId === person.id);
	const linked = peopleElement('section', null, 'account-link'); linked.append(peopleElement('h3', 'Linked devices & browsers'));
	if (!devices.length && !browsers.length) linked.append(peopleElement('p', 'No devices or home browsers linked.', 'auth-note'));
	else {
		const list = peopleElement('ul', null, 'account-linked-list');
		for (const entry of [...devices, ...browsers]) list.append(peopleElement('li', entry.name));
		linked.append(list);
	}
	linked.append(peopleButton('Link another device', () => { dialog.close(); showAccessPanel('devices'); })); dialog.append(linked);
	addAccountLimits(dialog, 'person:' + person.id);
	const controls = peopleElement('section', null, 'account-link'); controls.append(peopleElement('h3', 'Access'));
	controls.append(peopleElement('p', 'Controls email sign-in. Linked apps keep their separate device approval.', 'auth-note'));
	const actions = peopleElement('div', null, 'people-actions'); controls.append(actions);
	const message = peopleElement('p'); message.setAttribute('role', 'status'); controls.append(message); dialog.append(controls);
	const options = person.status === 'approved' ? ['revoke', 'remove'] : person.status === 'pending' ? ['approve', 'revoke', 'remove'] : ['approve', 'remove'];
	if (person.status === 'approved' && ['failed', 'sending'].includes(person.approvalEmailStatus)) {
		controls.prepend(peopleElement('p', person.approvalEmailStatus === 'failed' ? 'Approval email wasn’t sent.' : 'Approval email is sending.', 'auth-note'));
		options.unshift('notify-approval');
	}
	for (const action of options) {
		const button = peopleButton({ approve: 'Approve access', revoke: 'Block access', remove: 'Delete account', 'notify-approval': 'Retry approval email' }[action], async () => {
			if (action === 'revoke' && !confirm('Block email sign-in for ' + person.email + '? Their web sessions will end and they cannot request a code. Approved apps keep their device access. No email will be sent.')) return;
			if (action === 'remove' && !confirm('Delete ' + person.email + '? Browser access and device links will be removed. They can request approval again. No email will be sent.')) return;
			for (const control of actions.querySelectorAll('button')) control.disabled = true;
			try {
				const result = await authRequest('/api/people', { id: person.id, action });
				await load(); dialog.close();
				document.querySelector('#peopleMessage').textContent = result.approvalEmail === 'failed' ? 'Access approved, but the email could not be sent. Open Manage to retry.' : result.approvalEmail === 'sent' ? 'Approved · email sent.' : action === 'remove' ? 'Account deleted.' : action === 'revoke' ? 'Account blocked.' : 'Account updated.';
			} catch (error) { message.textContent = error.message; for (const control of actions.querySelectorAll('button')) control.disabled = false; }
		}, action === 'approve');
		actions.append(button);
	}
	dialog.showModal();
}
function manageHomeBrowser(browser) {
	const dialog = peopleDialog('Manage home browser');
	const form = peopleElement('form'); dialog.append(form);
	const nameLabel = peopleElement('label', 'Browser name', 'auth-field'), name = document.createElement('input');
	name.value = browser.name; name.required = true; name.minLength = 2; name.maxLength = 80; nameLabel.append(name); form.append(nameLabel);
	const label = peopleElement('label', 'Favourites account', 'auth-field'), select = document.createElement('select');
	select.setAttribute('aria-label', 'Favourites account');
	select.append(new Option('Shared Home favourites', ''));
	for (const person of peopleDirectory.people.filter(p => p.status === 'approved')) select.append(new Option(person.email, person.id));
	const linkedPerson = peopleDirectory.people.find(p => p.id === browser.personId);
	if (linkedPerson && linkedPerson.status !== 'approved') select.append(new Option(linkedPerson.email + ' · ' + peopleStatus(linkedPerson), linkedPerson.id));
	select.value = browser.personId || ''; label.append(select); form.append(label);
	form.append(peopleElement('p', 'Home access stays login-free. Linking uses this person’s favourites and includes them in Home.', 'auth-note'));
	const info = peopleElement('details'); info.append(peopleElement('summary', 'Browser details'), peopleElement('p', browser.browser, 'auth-note')); form.append(info);
	const message = peopleElement('p'); message.setAttribute('role', 'status');
	const controls = peopleElement('div', null, 'people-actions');
	const save = peopleElement('button', 'Save changes', 'button primary'); save.type = 'submit';
	const remove = peopleButton('Remove browser', async () => {
		if (!confirm('Remove this browser link? Local browsing stays login-free. It will appear as a new browser next time.')) return;
		save.disabled = remove.disabled = true;
		try { await authRequest('/api/people/browsers', { id: browser.id, action: 'remove' }); await loadPeople(); dialog.close(); }
		catch (error) { message.textContent = error.message; save.disabled = remove.disabled = false; }
	});
	controls.append(save, remove); form.append(controls, message);
	form.onsubmit = async event => {
		event.preventDefault(); if (!form.reportValidity()) return; save.disabled = remove.disabled = true;
		try {
			if (name.value !== browser.name) await authRequest('/api/people/browsers', { id: browser.id, action: 'rename', name: name.value });
			if (select.value !== (browser.personId || '')) await authRequest('/api/people/browsers', { id: browser.id, action: 'link', personId: select.value });
			await loadPeople(); dialog.close();
		} catch (error) { message.textContent = error.message; save.disabled = remove.disabled = false; }
	}; dialog.showModal();
}
async function loadPeople(directory) {
	try {
		peopleDirectory = directory || await authRequest('/api/people');
		const host = document.querySelector('#webPeople'); host.replaceChildren();
		const rank = { pending: 0, approved: 1, revoked: 2 };
		for (const person of [...peopleDirectory.people].sort((a, b) => (rank[a.status] ?? 3) - (rank[b.status] ?? 3) || a.email.localeCompare(b.email))) {
			const row = peopleElement('article', null, 'access-row');
			const linked = accountDevices(person);
			row.dataset.accessSearch = [person.email, ...linked.map(device => device.name)].join(' ').toLowerCase(); row.dataset.accountStatus = person.status;
			const identity = peopleElement('div', null, 'access-identity'); identity.append(peopleElement('h3', person.email));
			const count = accountDevices(person).length, browsers = peopleDirectory.localBrowsers.filter(b => b.personId === person.id).length;
			identity.append(peopleElement('p', `${count} linked ${count === 1 ? 'device' : 'devices'}${browsers ? ` · ${browsers} home ${browsers === 1 ? 'browser' : 'browsers'}` : ''}`, 'auth-note'));
			if (person.status === 'approved' && person.approvalEmailStatus === 'failed') identity.append(peopleElement('p', 'Approval email needs retrying', 'access-warning'));
			row.append(identity, peopleElement('span', peopleStatus(person), 'access-badge ' + person.status), peopleButton(person.status === 'pending' ? 'Review request' : 'Manage', () => managePerson(person), person.status === 'pending'));
			if (linked.length) {
				const list = peopleElement('div', null, 'account-devices');
				for (const device of linked) {
					const item = peopleElement('div', null, 'account-device'); item.dataset.linkedDevice = device.id;
					item.append(peopleElement('span', device.name, 'account-device-name'), peopleElement('span', device.status === 'pending' ? 'Awaiting approval' : device.role === 'admin' ? 'Admin' : 'Viewer', 'access-badge ' + device.status), linkedDeviceButton(device)); list.append(item);
				}
				row.append(list);
			}
			host.append(row);
		}
		const browsers = document.querySelector('#homeBrowsers'); browsers.replaceChildren();
		for (const browser of [...peopleDirectory.localBrowsers].sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0))) {
			const person = peopleDirectory.people.find(p => p.id === browser.personId);
			const row = peopleElement('article', null, 'access-row'); row.dataset.accessSearch = `${browser.name} ${person?.email || ''}`.toLowerCase();
			const identity = peopleElement('div', null, 'access-identity'); identity.append(peopleElement('h3', browser.name), peopleElement('p', person?.email || 'Shared Home favourites', 'auth-note'));
			if (browser.lastSeen) identity.append(peopleElement('p', 'Last seen ' + new Date(browser.lastSeen).toLocaleString(), 'auth-note'));
			row.append(identity, peopleElement('span', 'Login-free', 'access-badge'), peopleButton('Manage', () => manageHomeBrowser(browser))); browsers.append(row);
		}
		updateAccessSummary('accounts', peopleDirectory.people.filter(p => p.status === 'pending').length);
		document.querySelector('#peopleMessage').textContent = '';
		filterAccessRows();
	} catch (error) { document.querySelector('#peopleMessage').textContent = error.message; }
}
