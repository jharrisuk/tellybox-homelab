/* Maintenance mode switch. Enabling disconnects everyone, so it confirms first;
 * the administrator session itself always bypasses maintenance. */
(() => {
	'use strict';
	const state = document.querySelector('#maintenanceState');
	const scope = document.querySelector('#maintenanceScope');
	const toggle = document.querySelector('#maintenanceToggle');
	const message = document.querySelector('#maintenanceMessage');
	if (!state || !scope || !toggle) return;
	let current = { enabled: false, scope: 'both' };
	const label = value => value === 'local' ? 'at home only' : value === 'remote' ? 'remote only' : 'everyone';
	function render(next) {
		current = {
			enabled: next.enabled === true,
			scope: ['local', 'remote', 'both'].includes(next.scope) ? next.scope : 'both'
		};
		scope.value = current.scope;
		state.textContent = current.enabled ? `On — blocking ${label(current.scope)}.` : 'Off.';
		toggle.textContent = current.enabled ? 'Turn maintenance off' : 'Turn maintenance on';
		toggle.classList.toggle('primary', !current.enabled);
		toggle.classList.toggle('secondary', current.enabled);
	}
	async function load() {
		try {
			const response = await fetch('/api/maintenance', { cache: 'no-store' });
			if (!response.ok) throw Error('Maintenance state unavailable.');
			render(await response.json());
		} catch {
			state.textContent = 'Maintenance state unavailable.';
		}
	}
	toggle.onclick = async () => {
		const next = !current.enabled;
		if (next && !confirm('Take Tellybox offline for maintenance? Everyone using it will be disconnected.')) return;
		toggle.disabled = true;
		if (message) message.textContent = '';
		try {
			const response = await fetch('/api/maintenance', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ enabled: next, scope: scope.value })
			});
			if (!response.ok) {
				const data = await response.json().catch(() => ({}));
				throw Error(data.error || 'Could not change maintenance.');
			}
			render(await response.json());
			if (message) message.textContent = next
				? 'Maintenance is on. Everyone has been disconnected.'
				: 'Maintenance is off. Tellybox is available again.';
		} catch (error) {
			if (message) message.textContent = error.message;
		} finally {
			toggle.disabled = false;
		}
	};
	scope.onchange = () => {
		if (current.enabled) {
			if (message) message.textContent = 'Turn maintenance off and on again to apply a new scope.';
			scope.value = current.scope;
		}
	};
	void load();
})();
