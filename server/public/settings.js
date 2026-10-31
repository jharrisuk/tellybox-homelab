for (const button of document.querySelectorAll('[data-panel]')) {
	button.onclick = () => {
		for (const tab of document.querySelectorAll('[data-panel]')) {
			const active = tab === button;
			tab.classList.toggle('active', active); tab.setAttribute('aria-pressed', String(active));
		}
		for (const panel of document.querySelectorAll('[data-settings]')) panel.hidden = panel.dataset.settings !== button.dataset.panel;
	};
}
const english = document.querySelector('#englishSubtitles');
english.checked = localStorage.getItem('tellybox-english') === 'true';
english.onchange = () => localStorage.setItem('tellybox-english', String(english.checked));

for (const button of document.querySelectorAll("[data-open-panel]")) button.onclick = () => document.querySelector(`[data-panel="${button.dataset.openPanel}"]`)?.click();
