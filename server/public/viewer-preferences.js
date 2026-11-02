(() => {
	function bind(selector, key) {
		const input = document.querySelector(selector);
		if (!input) return;
		try { input.checked = localStorage.getItem(key) === 'true'; } catch { input.checked = false; }
		input.onchange = () => {
			try { localStorage.setItem(key, String(input.checked)); } catch { /* Private browsing can block storage. */ }
		};
	}
	bind('#englishSubtitles', 'tellybox-english');
	bind('#autoNext', 'tellybox-autoplay');
	bind('#skipIntros', 'tellybox-skip-intros');
})();
