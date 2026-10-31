(() => {
	const el = (tag, text, className) => {
		const node = document.createElement(tag); node.textContent = text || ''; if (className) node.className = className; return node;
	};
	const message = document.querySelector('#signInMessage'), refresh = document.querySelector('#refreshSignIns');
	let busy = false;
	async function loadSignIns() {
		if (busy) return;
		busy = true; refresh.disabled = true;
		try {
			const result = await authRequest('/api/auth/login-protection');
			const connections = result.connections || [], events = result.failed || [];
			const summary = document.querySelector('#signInSummary'); summary.replaceChildren();
			for (const [label, count] of [['Blocked', connections.filter(e => e.state === 'blocked').length], ['Approaching limit', connections.filter(e => e.state === 'warning').length], ['Recent failures', events.filter(e => e.type !== 'login_limit_reset').length]]) {
				const item = el('div'); item.append(el('strong', String(count)), el('span', label)); summary.append(item);
			}
			const host = document.querySelector('#signInConnections'); host.replaceChildren();
			for (const [state, label] of [['blocked','Blocked connections'],['warning','Approaching the limit'],['recent','Recent email submissions']]) {
				const entries = connections.filter(e => e.state === state);
				if (!entries.length) continue;
				host.append(el('h4', label));
				for (const entry of entries) {
					const row = el('article', '', 'signin-row ' + state), detail = el('div');
					detail.append(el('strong', entry.email || entry.ip));
					if (entry.email) detail.append(el('small', entry.ip));
					const status = state === 'blocked' ? 'Blocked until ' + new Date(entry.blockedUntil).toLocaleString() : `${entry.attempts} of ${entry.limit} email submissions · ${entry.attempts === entry.limit ? 'next submission blocks this IP' : (entry.limit - entry.attempts) + ' remaining'}`;
					detail.append(el('p', status));
					if (state !== 'blocked') detail.append(el('small', 'Oldest submission clears at ' + new Date(entry.resetsAt).toLocaleTimeString()));
					const button = el('button', state === 'blocked' ? 'Unblock IP' : 'Reset counter', 'button secondary');
					button.onclick = async () => {
						if (!confirm(`${button.textContent} for ${entry.ip}? Email approval and account blocks will stay as they are.`)) return;
						button.disabled = true;
						try { await authRequest('/api/auth/login-protection', { id: entry.id }); await loadSignIns(); message.textContent = 'Email submission limit reset for ' + entry.ip + '.'; }
						catch (error) { message.textContent = error.message; button.disabled = false; }
					};
					row.append(detail, button); host.append(row);
				}
			}
			const history = document.querySelector('#signInEvents'); history.replaceChildren();
			for (const entry of events) {
				const row = el('article', '', 'signin-row'), detail = el('div');
				detail.append(el('strong', entry.reason), el('p', [entry.email, entry.ip, entry.local ? 'Local' : ''].filter(Boolean).join(' · ')));
				row.append(detail, el('time', new Date(entry.time).toLocaleString())); history.append(row);
			}
			if (!events.length) history.append(el('p', 'No failed sign-ins recorded.'));
			else history.append(el('small', 'Latest ' + events.length + ' events · kept for up to ' + result.retentionDays + ' days'));
			message.textContent = connections.some(e => e.state === 'blocked') ? 'Unblock a connection to let it try again.' : 'No connections blocked.';
		} catch (error) { message.textContent = error.message; }
		finally { busy = false; refresh.disabled = false; }
	}
	refresh.onclick = loadSignIns;
	void loadSignIns();
	setInterval(() => { if (!document.hidden) void loadSignIns(); }, 30000);
})();
