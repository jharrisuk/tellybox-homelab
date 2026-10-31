import {locationChoice} from './service-location.mjs';
import {notificationMode,withNotificationMode} from './notification-mode.mjs';
const $ = selector => document.querySelector(selector);
let model, specs, dirty = false;
const el = (tag, text, className) => { const n = document.createElement(tag); if (text) n.textContent = text; if (className) n.className = className; return n; };
const message = text => { $('#message').textContent = text; };
async function request(route, body) {
	const response = await fetch('/api/setup/' + route, { method: body ? 'POST' : 'GET', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
	const data = await response.json(); if (!response.ok) throw Error(data.error || 'Could not complete this action.'); return data;
}
function input(labelText, value, type, hint, key) {
	const label = el('label', labelText), control = el('input'); control.type = type === 'secret' ? 'password' : type === 'boolean' ? 'checkbox' : type;
	if (type === 'boolean') control.checked = value === true; else control.value = value || '';
	if (key) control.dataset.key = key;
	if (type === 'secret') control.autocomplete = 'new-password';
	label.append(control); if (hint) label.append(el('small', hint)); return label;
}
function markDirty() { dirty = true; $('#saveStatus').textContent = 'Unsaved changes'; }
function showAppEdition() {
	const custom = $('#appEdition').value === 'personal';
	$('#appPackageLabel').hidden = !custom; $('#appPackage').required = custom;
	$('#appEditionHint').textContent = custom
		? 'Use your own signed phone and TV apps and your installation’s update feed. This does not change apps already installed.'
		: 'Official HomeLab apps ask for your server address. App updates come directly from the Tellybox publisher.';
}
$('#appEdition').onchange = () => { showAppEdition(); markDirty(); };
function renderService(spec,embedded=false) {
	const data = model.services[spec.id], card = el(embedded?'div':'details', '', embedded?'notification-custom':'service service-row'); card.dataset.service = spec.id;
	const heading = el('summary', '', 'service-row-heading'), title = el('span', '', 'service-row-title');
	title.append(el('strong', spec.name), el('span', spec.summary, 'service-row-description'));
	const state = el('span', '', 'service-state');
	const chevron = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
	chevron.setAttribute('class', 'service-chevron'); chevron.setAttribute('viewBox', '0 0 24 24');
	chevron.setAttribute('aria-hidden', 'true'); chevron.setAttribute('focusable', 'false');
	const stroke = document.createElementNS('http://www.w3.org/2000/svg', 'path');
	stroke.setAttribute('d', 'm6 9 6 6 6-6'); chevron.append(stroke);
	const updateState = enabled => { state.textContent = enabled ? 'Enabled' : 'Off'; card.dataset.enabled = String(enabled); };
	updateState(data.enabled === true); heading.append(title, state, chevron); if(!embedded)card.append(heading);
	const body = el('div', '', 'service-row-body');
	const toggle = input('Enable ' + spec.name, data.enabled, 'boolean'); toggle.querySelector('input').dataset.enable = spec.id; if(!embedded)body.append(toggle);
	const badges = el('div', '', 'benefits'); spec.enables.forEach(x => badges.append(el('span', x))); body.append(badges);
	const details = el('details'); details.append(el('summary', 'What does it do?'), el('p', spec.description), el('h4', 'You’ll need'), el('p', spec.requires), el('h4', 'If you leave it off'), el('p', spec.without), el('p', spec.note));
	const link = el('a', 'Official setup guide ↗'); link.href = spec.docs; link.target = '_blank'; link.rel = 'noopener noreferrer'; details.append(link); body.append(details);
	const fields = el('div', '', 'fields'); fields.hidden = !embedded&&!data.enabled;
	if(spec.sameServerUrl) {
		const location=input('Runs on this server',data.onThisServer,'boolean');
		const checkbox=location.querySelector('input');checkbox.dataset.onThisServer='true';
		card.dataset.manualUrl=data.manualUrl||(!data.onThisServer?data.url||'':'');
		checkbox.onchange=()=>{
			const address=card.querySelector('[data-key="url"]');
			const choice=locationChoice({onThisServer:!checkbox.checked,url:address.value,manualUrl:card.dataset.manualUrl},spec.sameServerUrl,checkbox.checked);
			address.value=choice.url;card.dataset.manualUrl=choice.manualUrl;markDirty();
		};
		fields.append(location);
	}
	for (const f of spec.fields) {
		const saved = f.type === 'secret' && data[f.key + 'Saved'];
		const hint=f.key==='url'&&spec.sameServerUrl?'Use the host-published address and port, or enter another server address.':f.hint;
		const label = input(f.label, data[f.key], f.type, saved ? 'Saved securely. Leave blank to keep it.' : hint, f.key);
		if (f.jsonFile) {
			const secret = label.querySelector('input'); secret.hidden = true;
			const file = el('input'); file.type = 'file'; file.accept = '.json,application/json';
			file.onchange = async () => { try { if (file.files[0].size > 16000) throw Error('Choose the service-account JSON file.'); secret.value = JSON.stringify(JSON.parse(await file.files[0].text())); markDirty(); } catch (e) { file.value = ''; secret.value = ''; message(e.message); } }; label.append(file);
		}
		fields.append(label);
	}
	const test = el('button', 'Test saved connection'); test.type = 'button'; const result = el('p', '', 'test-result'); result.setAttribute('role', 'status');
	if (spec.fields.length) fields.append(test, result);
	test.onclick = async () => { if (dirty) return message('Save your changes before testing.'); test.disabled = true; try { const r = await request('test/' + spec.id, {}); result.textContent = r.message; } catch (e) { result.textContent = e.message; } finally { test.disabled = false; } };
	toggle.querySelector('input').onchange = e => { fields.hidden = !e.target.checked; updateState(e.target.checked); markDirty(); };
	body.append(fields); card.append(body); return card;
}
function showNotificationMode() {
	const mode=$('#notificationMode').value;$('#customNotifications').hidden=mode!=='custom';
	$('#notificationHint').textContent=mode==='standard'?'Uses the official HomeLab notification service. No Firebase account or keys are needed. Enable admin alerts in your approved HomeLab phone app.':mode==='custom'?'Uses your own Firebase project and saved app settings. Your private credentials stay on this server.':'Push notifications are off. Periodic background alerts remain available.';
}
$('#notificationMode').onchange=()=>{showNotificationMode();markDirty();};
async function load() {
	const data = await request('config'); model = data.config; specs = data.services; dirty = false;
	const expanded = new Set([...document.querySelectorAll('.service-row[open]')].map(card => card.dataset.service));
	$('#signIn').hidden = true; $('#settings').hidden = false; $('#integrations').replaceChildren();
	$('#runtime').textContent = data.runtime.running ? `Media is running · settings revision ${data.runtime.appliedRevision}` : 'Media is stopped. Save and apply your configuration to start it.';
	$('#saveStatus').textContent = model.revision === data.runtime.appliedRevision ? 'Saved settings are applied.' : 'Saved settings are waiting to be applied.';
	$('#appEdition').value = model.apps?.edition || 'public'; $('#appPackage').value = model.apps?.packageName || ''; showAppEdition();
	const ordinary=specs.filter(s=>!['firebase','pushGateway'].includes(s.id));
	for (const group of [...new Set(ordinary.map(s => s.group))]) {
		const section = el('section'), list = el('div', '', 'integration-list'); section.append(el('h2', group), list);
		for (const spec of ordinary.filter(s => s.group === group)) { const card = renderService(spec); card.open = expanded.has(spec.id); list.append(card); }
		$('#integrations').append(section);
	}
	$('#notificationMode').value=notificationMode(model.services);
	$('#customNotifications').replaceChildren(renderService(specs.find(s=>s.id==='firebase'),true));showNotificationMode();
	$('#networkFields').replaceChildren();
	const networkFields = { publicOrigin: ['Public HTTPS address', 'https://watch.example.com — optional'], localOrigin: ['Local playback address', 'The LAN address clients can reach, including port'], localNetworks: ['Trusted home networks', 'Comma-separated CIDRs, for example 192.168.10.0/24. These get login-free local access.'], localHosts: ['Local hostnames', 'Comma-separated IPs or hostnames used to open the local site'], trustedProxies: ['Trusted relay IPs', 'Exact private IPs only. Never trust every proxy.'], homeTrustedProxy: ['Home recognition proxy', 'Optional: an IP from the trusted relay list'], clientIpHeader: ['Relay client IP header', 'x-forwarded-for, x-real-ip or cf-connecting-ip'], homeIpEndpoint: ['Home public-IP check', 'Optional HTTPS endpoint returning your home public IP'] };
	for (const [key, [name, hint]] of Object.entries(networkFields)) $('#networkFields').append(input(name, Array.isArray(model.network[key]) ? model.network[key].join(', ') : model.network[key], 'text', hint, key));
	if(data.connection?.cidr) {
		const box=el('div'), allow=el('button','Allow local viewing from this connection');allow.type='button';
		box.append(el('p','Your connection reaches Tellybox from '+data.connection.address+'. This can help with Docker networking. It only affects the local viewing port; remote access still needs approval.'),allow);
		allow.onclick=()=>{
			const field=$('#networkFields [data-key="localNetworks"]'),networks=field.value.split(',').map(value=>value.trim()).filter(Boolean);
			if(!networks.includes(data.connection.cidr))networks.push(data.connection.cidr);
			field.value=networks.join(', ');markDirty();message('Added to home networks. Review, save and apply when ready.');
		};$('#networkFields').append(box);
	}
	$('#infrastructure').replaceChildren();
	for (const service of data.infrastructure) { const block = el('section'); block.append(el('h3', service.name), el('p', service.summary), el('p', service.requires), el('p', service.note)); $('#infrastructure').append(block); }
	void relayStatus(true).catch(e => { $('#relayStatus').textContent = e.message; });
	void showRelayHealth();
	if (location.hash === '#relayPanel') $('#relayPanel').scrollIntoView({ block: 'start' });
}
function collect() {
	const value = structuredClone(model);
	value.apps = { edition: $('#appEdition').value, packageName: $('#appEdition').value === 'personal' ? $('#appPackage').value.trim() : '' };
	value.services=withNotificationMode(value.services,$('#notificationMode').value);
	for (const spec of specs) {
		if(spec.id==='pushGateway')continue;
		const card = document.querySelector(`[data-service="${spec.id}"]`), service = value.services[spec.id]; if(spec.id!=='firebase')service.enabled = card.querySelector('[data-enable]').checked;
		for (const field of spec.fields) { const control = card.querySelector(`[data-key="${field.key}"]`); service[field.key] = field.type === 'boolean' ? control.checked : control.value; }
		if(spec.sameServerUrl){service.onThisServer=card.querySelector('[data-on-this-server]').checked;service.manualUrl=service.onThisServer?card.dataset.manualUrl:service.url;}
	}
	for (const control of $('#networkFields').querySelectorAll('input')) { const key = control.dataset.key; value.network[key] = Array.isArray(model.network[key]) ? control.value.split(',').map(v => v.trim()).filter(Boolean) : control.value.trim(); }
	return value;
}
$('#loginForm').onsubmit = async event => { event.preventDefault(); try { await request('login', { password: $('#password').value, bootstrap: $('#bootstrap').value }); $('#password').value = ''; $('#bootstrap').value = ''; message(''); await load(); } catch (e) { message(e.message); } };
$('#configuration').oninput = markDirty;
$('#configuration').onsubmit = async event => { event.preventDefault(); try { await request('config', collect()); await load(); message('Saved. Apply when you’re ready to restart media.'); } catch (e) { message(e.message); } };
$('#apply').onclick = async () => { if (dirty) return message('Save your changes first.'); if (!confirm('Apply the saved settings and restart media? Anyone watching will be disconnected.')) return; $('#apply').disabled = true; try { await request('apply', { revision: model.revision }); await load(); message('Settings applied. Media is ready.'); } catch (e) { message(e.message); } finally { $('#apply').disabled = false; } };
$('#logout').onclick = async () => { await request('logout', {}); location.reload(); };
let relayTimer;
async function showRelayHealth() {
	const box = $('#relayHealth'), button = $('#relayHealthCheck'); button.disabled = true;
	box.replaceChildren(el('p', 'Checking remote access...'));
	try {
		const health = await request('relay/health');
		const labels = { operational: 'Operational', unavailable: 'Unable to reach your relay', 'different-server': 'Address points to a different server', 'not-configured': 'Remote access is not configured' };
		const state = el('strong', labels[health.state] || 'Status unavailable', 'relay-state'); state.dataset.state = health.state;
		box.replaceChildren(state);
		if (health.origin) {
			const address = el('a', health.origin); address.href = health.origin; address.target = '_blank'; address.rel = 'noopener noreferrer'; box.append(address);
			const details = el('details'); details.append(el('summary', 'Connection details'));
			const list = el('dl');
			list.append(el('dt', 'Public viewing address'), el('dd', health.origin), el('dt', 'Trusted proxy addresses'), el('dd', health.proxies.join(', ') || 'None configured'));
			if (health.checkedAt) list.append(el('dt', 'Last checked'), el('dd', new Date(health.checkedAt).toLocaleString()));
			details.append(list); box.append(details);
			if (health.state === 'operational') box.append(el('p', 'Your HTTPS address reaches this Tellybox server.'));
			else box.append(el('p', 'Check the public address and relay connection, then refresh.'));
		}
	} catch (e) { box.replaceChildren(el('p', 'Relay status is unavailable. Try refreshing.')); }
	finally { button.disabled = false; }
}
$('#relayHealthCheck').onclick = showRelayHealth;
async function relayStatus(fill = false) {
	clearTimeout(relayTimer);
	const state = await request('relay'), c = state.connection, job = state.job;
	if (fill && c) for (const key of ['sshHost','sshPort','sshUser','hostname','homeTailscaleIp']) $('#relayForm').elements[key].value = c[key];
	$('#relaySaved').textContent = c ? ' Connection saved · credentials hidden' : '';
	$('#relayCheck').disabled = !c || job?.status === 'running';
	$('#relayPlan').disabled = !c || job?.status === 'running';
	$('#relayInstall').disabled = !state.checked || job?.status === 'running';
	$('#relayStatus').textContent = job ? `${job.action === 'check' ? 'Connection check' : 'Relay setup'} · ${job.status.replaceAll('-', ' ')}` : 'No remote changes made.';
	$('#relayOutput').hidden = !job?.output; $('#relayOutput').textContent = job?.output || '';
	if (job?.status === 'running') relayTimer = setTimeout(() => relayStatus().catch(e => message(e.message)), 2000);
}
$('#relayForm').onsubmit = async event => {
	event.preventDefault();
	try {
		const value = Object.fromEntries(new FormData(event.target)), file = $('#relayKey').files[0];
		if (file && file.size > 16000) throw Error('Choose a private SSH key file under 16 KB.');
		value.privateKey = file ? await file.text() : '';
		await request('relay', value); $('#relayKey').value = ''; event.target.elements.knownHosts.value = '';
		$('#relayReview').hidden = true; await relayStatus(); message('Relay connection saved. Check it before starting setup.');
	} catch (e) { message(e.message); }
};
$('#relayCheck').onclick = async () => { try { await request('relay/run', { action: 'check' }); await relayStatus(); } catch (e) { message(e.message); } };
$('#relayPlan').onclick = async () => {
	try {
		const p = await request('relay/plan'), output = $('#relayPlanText'); output.replaceChildren(el('p', `${p.target} → ${p.hostname} → ${p.upstream}`));
		const steps = el('ol'); p.steps.forEach(step => steps.append(el('li', step))); output.append(steps, el('h4', 'You’ll finish'));
		const manual = el('ul'); p.manual.forEach(step => manual.append(el('li', step))); output.append(manual);
		$('#relayConfirm').placeholder = p.hostname; $('#relayConfirm').value = ''; $('#relayReview').hidden = false;
	} catch (e) { message(e.message); }
};
$('#relayInstall').onclick = async () => {
	try { await request('relay/run', { action: 'install', confirmation: $('#relayConfirm').value.trim() }); await relayStatus(); }
	catch (e) { message(e.message); }
};
window.addEventListener('beforeunload', event => { if (dirty) event.preventDefault(); });
try { const status = await request('status'); $('#bootstrapLabel').hidden = status.claimed; $('#loginTitle').textContent = status.claimed ? 'Open installation settings' : 'Claim this installation'; await load(); } catch (e) { if (!e.message.includes('Sign in')) message(e.message); }
