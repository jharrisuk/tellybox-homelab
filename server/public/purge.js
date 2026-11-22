(() => {
	const $ = selector => document.querySelector(selector);
	const search = $('#purgeSearch'), results = $('#purgeResults'), message = $('#purgeMessage');
	const preview = $('#purgePreview'), summary = $('#purgeSummary'), confirm = $('#purgeConfirm');
	const remove = $('#purgeDelete'), cancel = $('#purgeCancel');
	let selected = null, timer = 0, generation = 0;

	const bytes = value => {
		const size = Number(value) || 0;
		if (!size) return '';
		const units = ['B', 'KB', 'MB', 'GB', 'TB'];
		let index = 0, amount = size;
		while (amount >= 1024 && index < units.length - 1) { amount /= 1024; index++; }
		return amount.toFixed(amount >= 10 || index === 0 ? 0 : 1) + ' ' + units[index];
	};
	const describe = item => {
		const type = String(item.Type || '');
		if (type === 'Season') return 'Season ' + (item.IndexNumber || '?');
		if (type === 'Episode') return 'Episode' + (Number.isInteger(item.ParentIndexNumber) ? ' S' + item.ParentIndexNumber + 'E' + item.IndexNumber : '');
		return type || 'Title';
	};
	async function call(path, body) {
		const response = await fetch(path, {
			method: body ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store',
			headers: body ? { 'Content-Type': 'application/json' } : { Accept: 'application/json' },
			body: body ? JSON.stringify(body) : undefined
		});
		const data = await response.json().catch(() => ({}));
		if (!response.ok) throw new Error(data.error || 'The request could not be completed.');
		return data;
	}
	function clearPreview() {
		selected = null;
		preview.hidden = true;
		summary.textContent = '';
		confirm.value = '';
		remove.disabled = true;
	}
	function match() {
		remove.disabled = !selected || confirm.value.trim().toLowerCase() !== String(selected.name || '').trim().toLowerCase();
	}
	function renderPreview(data) {
		selected = data;
		summary.textContent = data.type + ' · ' + data.count + (data.count === 1 ? ' file' : ' files') + (data.bytes ? ' · ' + bytes(data.bytes) : '') + ' — ' + data.name;
		preview.hidden = false;
		confirm.value = '';
		remove.disabled = true;
		confirm.focus();
	}
	async function choose(item) {
		clearPreview();
		message.textContent = 'Checking ' + item.Name + '…';
		try {
			const data = await call('/api/admin/purge/preview?id=' + encodeURIComponent(item.Id));
			message.textContent = '';
			renderPreview(data);
		} catch (error) { message.textContent = error.message; }
	}
	function render(items) {
		results.replaceChildren();
		if (!items.length) return;
		for (const item of items) {
			const button = document.createElement('button');
			button.type = 'button';
			button.className = 'button secondary';
			button.textContent = item.Name + ' · ' + describe(item) + (item.ProductionYear ? ' · ' + item.ProductionYear : '');
			button.onclick = () => choose(item);
			results.append(button);
		}
	}
	async function find() {
		const query = search.value.trim();
		const request = ++generation;
		if (query.length < 2) { results.replaceChildren(); return; }
		try {
			const data = await call('/api/admin/purge/search?q=' + encodeURIComponent(query));
			if (request !== generation) return;
			render(data.items || []);
		} catch (error) { if (request === generation) message.textContent = error.message; }
	}
	search.addEventListener('input', () => {
		clearTimeout(timer);
		timer = setTimeout(find, 300);
	});
	confirm.addEventListener('input', match);
	cancel.onclick = () => { clearPreview(); message.textContent = ''; };
	remove.onclick = async () => {
		if (!selected || remove.disabled) return;
		remove.disabled = true;
		message.textContent = 'Deleting ' + selected.name + '…';
		try {
			const data = await call('/api/admin/purge', { id: selected.id, confirm: confirm.value });
			message.textContent = 'Deleted ' + data.name + ' (' + data.count + (data.count === 1 ? ' file' : ' files') + ').';
			clearPreview();
			await find();
		} catch (error) {
			message.textContent = error.message;
			remove.disabled = false;
		}
	};
})();
