const authMessage = document.querySelector('#authMessage');
const passwordField = document.querySelector('#password');
const passwordForm = document.querySelector('#passwordForm');
const loginForm = document.querySelector('#loginForm');
const uploadForm = document.querySelector('#uploadForm');

async function authRequest(route, body) {
	const response = await fetch(route, { method: body ? 'POST' : 'GET', headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
	const result = await response.json();
	if (!response.ok) throw new Error(result.error || 'Unable to update remote access. Please try again.');
	return result;
}

if (loginForm) loginForm.addEventListener('submit', async event => {
	event.preventDefault();
	const button = loginForm.querySelector('button');
	button.disabled = true;
	authMessage.textContent = 'Signing in…';
	try {
		await authRequest('/api/auth/login', { password: passwordField.value });
		passwordField.value = '';
		location.replace('/');
	} catch (error) { authMessage.textContent = error.message; }
	finally { button.disabled = false; }
});

if (uploadForm) {
	const input = document.querySelector('#uploadMbps');
	const message = document.querySelector('#uploadMessage');
	const button = uploadForm.querySelector('button[type=submit]');
	const describe = mbps => mbps ? `${mbps} Mbps total · up to ${(mbps / 8).toLocaleString(undefined, { maximumFractionDigits: 2 })} MB/s shared between remote transfers.` : 'Unlimited remote upload. Direct local streaming is always unrestricted.';
	authRequest('/api/auth/upload-limit').then(settings => {
		input.value = settings.defaultMbps??settings.mbps;
		for(const row of settings.schedule||[])addUploadPeriod(row);
		input.disabled = false; button.disabled = false;
		message.textContent = describe(settings.mbps);
	}).catch(error => { message.textContent = error.message; });
	uploadForm.addEventListener('submit', async event => {
		event.preventDefault(); button.disabled = true;
		message.textContent = 'Saving upload limit…';
		try {
			const result = await authRequest('/api/auth/upload-limit', { mbps:Number(input.value),schedule:[...document.querySelectorAll('#uploadPeriods .upload-period')].map(row=>({start:row.querySelector('[name=start]').value,end:row.querySelector('[name=end]').value,mbps:Number(row.querySelector('[name=mbps]').value)})) });
			message.textContent = 'Saved. ' + describe(result.mbps);
		} catch (error) { message.textContent = error.message; }
		finally { button.disabled = false; }
	});
}

if (passwordForm) {
	async function refreshTunnel() {
		const link = document.querySelector('#tunnelLink');
		const status = document.querySelector('#tunnelState');
		try {
			const tunnel = await authRequest('/api/auth/tunnel');
			link.hidden = !tunnel.url;
			if (tunnel.url) { link.href = tunnel.url; link.textContent = tunnel.url; }
			else { link.removeAttribute('href'); link.textContent = ''; }
			status.textContent = tunnel.connected ? (tunnel.homeAccess?.active ? 'Connected · home network recognised · sign-in required away from home' : 'Connected · sign-in required') : tunnel.url ? 'The connection is unavailable. Retrying automatically…' : 'The temporary address is unavailable. The tunnel may be restarting or stopped.';
			document.querySelector('#tunnelNote').textContent = tunnel.temporary === false
				? (tunnel.homeAccess?.active ? 'Use this address at home without signing in, or sign in away from home. Home recognition follows your public IP; browser administration stays on the local site; approved admin apps can manage settings remotely.' : 'Open this link away from home and sign in. This address stays the same when the home server restarts.')
				: 'Open this link away from home and sign in. The address changes when the temporary tunnel restarts; this page checks for updates every 15 seconds.';
		} catch {
			link.hidden = true;
			link.removeAttribute('href');
			link.textContent = '';
			status.textContent = 'Unable to check the address. Retrying automatically…';
		}
	}
	void refreshTunnel();
	setInterval(() => { if (!document.hidden) void refreshTunnel(); }, 15000);
	passwordForm.addEventListener('submit', async event => {
		event.preventDefault();
		if (passwordField.value !== document.querySelector('#confirmPassword').value) {
			authMessage.textContent = 'The passwords do not match.';
			return;
		}
		const button = passwordForm.querySelector('button');
		button.disabled = true;
		authMessage.textContent = 'Saving…';
		try {
			await authRequest('/api/auth/password', { password: passwordField.value });
			passwordForm.reset();
			document.querySelector('#passwordState').textContent = 'A remote access password is set.';
			authMessage.textContent = 'Password saved. Remote browsers must sign in again. Local access is unchanged.';
		} catch (error) { authMessage.textContent = error.message; }
		finally { button.disabled = false; }
	});
	document.querySelector('#revokeSessions').onclick = async () => {
		if (!confirm('Sign out all remote browsers? They will need the password to watch again.')) return;
		try { await authRequest('/api/auth/revoke', {}); authMessage.textContent = 'All remote browsers have been signed out.'; }
		catch (error) { authMessage.textContent = error.message; }
	};
}

authRequest('/api/auth/status').then(status => {
	if (loginForm && status.email) setupEmailLogin();
	if (passwordForm) { passwordForm.hidden = Boolean(status.email); document.querySelector('#passwordState').textContent = status.email ? 'Email sign-in is active. The shared password is not used.' : status.configured ? 'A remote access password is set.' : 'No remote password yet. Remote access stays locked until you set one.'; }
	if (loginForm && !status.configured && !status.email) {
		authMessage.textContent = 'The owner needs to set a remote password from the local settings page first.';
		loginForm.querySelector('button').disabled = true;
	}
}).catch(error => { authMessage.textContent = error.message; });

function setupEmailLogin() {
	loginForm.hidden = true;
	document.querySelector('.auth-description').textContent = 'Enter your email. New guests need approval before receiving a sign-in code.';
	document.querySelector('.auth-note').textContent = 'At home, you can watch without signing in.';
	const form = document.querySelector('#emailLogin'), code = document.querySelector('#emailCode');
	const pending = document.querySelector('#approvalPending'), checkButton = document.querySelector('#checkApproval');
	function showPending() {
		form.hidden = code.hidden = true; pending.hidden = false;
		document.querySelector('.auth-card h1').textContent = 'Waiting for approval';
		document.querySelector('.auth-description').textContent = 'The owner needs to approve your access.';
		document.querySelector('#pendingEmail').textContent = form.elements.email.value.trim();
	}
	function resetHeading() {
		pending.hidden = true;
		document.querySelector('.auth-card h1').textContent = 'Welcome back.';
		document.querySelector('.auth-description').textContent = 'Enter your email. New guests need approval before receiving a sign-in code.';
	}
	let challenge = '', details, polling;
	form.hidden = false;
	async function check() {
		try {
			const result = await authRequest('/api/auth/email/me');
			if (result.status === 'approved') { clearInterval(polling); location.replace('/'); }
			else if (result.status === 'pending') { showPending(); if (!polling) polling = setInterval(check, 10000); }
			else if (polling) { clearInterval(polling); polling = null; form.hidden = false; authMessage.textContent = 'Please sign in again.'; }
		} catch { authMessage.textContent = 'Unable to check approval. We’ll try again shortly.'; }
	}
	form.onsubmit = async event => {
		event.preventDefault(); const button = form.querySelector('button'); button.disabled = checkButton.disabled = true;
		details = { remember: form.elements.remember.checked };
		try {
			const result = await authRequest('/api/auth/email/code', { email: form.elements.email.value.trim() });
			if (result.status === 'pending') {
				challenge = ''; showPending();
				authMessage.textContent = 'Still awaiting approval. You can close this page.';
			} else if (result.challenge) {
				resetHeading();
				challenge = result.challenge; form.hidden = true; code.hidden = false; code.elements.code.focus();
				authMessage.textContent = 'Check your inbox for an eight-digit code.';
			} else throw Error('Please try again.');
		}
		catch (error) { authMessage.textContent = error.message; } finally { button.disabled = checkButton.disabled = false; }
	};
	code.onsubmit = async event => {
		event.preventDefault(); const button = code.querySelector('button'); button.disabled = true;
		try { await authRequest('/api/auth/email/verify', { challenge, code: code.elements.code.value, ...details }); code.reset(); await check(); }
		catch (error) { authMessage.textContent = error.message; } finally { button.disabled = false; }
	};
	form.elements.email.oninput = () => { challenge = ''; form.querySelector('button').textContent = 'Continue'; authMessage.textContent = ''; };
	const anotherEmail = () => { clearInterval(polling); polling = null; challenge = ''; resetHeading(); form.hidden = false; code.hidden = true; code.reset(); form.querySelector('button').textContent = 'Continue'; authMessage.textContent = ''; form.elements.email.focus(); };
	document.querySelector('#anotherCode').onclick = anotherEmail;
	document.querySelector('#changePendingEmail').onclick = anotherEmail;
	checkButton.onclick = () => form.onsubmit({ preventDefault() {} });
	void check();
}

function addUploadPeriod(value={start:'18:00',end:'23:00',mbps:25}){
	const row=document.createElement('div');row.className='upload-period';
	for(const [name,label,type] of [['start','From','time'],['end','Until','time'],['mbps','Mbps','number']]){const field=document.createElement('label');field.textContent=label;const input=document.createElement('input');input.type=type;input.name=name;input.value=value[name];input.required=true;if(type==='number'){input.min=0;input.max=1000;input.step=1;}field.append(input);row.append(field);}
	const remove=document.createElement('button');remove.type='button';remove.className='button quiet';remove.textContent='×';remove.setAttribute('aria-label','Remove time period');remove.onclick=()=>row.remove();row.append(remove);document.querySelector('#uploadPeriods').append(row);
}
document.querySelector('#addUploadPeriod')?.addEventListener('click',()=>addUploadPeriod());
