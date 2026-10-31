(() => {
	const message = document.querySelector('#apkMessage'), refresh = document.querySelector('#refreshApks');
	async function loadDownloads() {
		refresh.disabled = true;
		for (const flavour of ['phone','tv']) { document.querySelector('#' + flavour + 'Apk').hidden = true; document.querySelector('#' + flavour + 'ApkVersion').textContent = ''; }
		try {
			const response = await fetch('/app-updates/downloads.json', { cache: 'no-store' });
			if (!response.ok) throw Error('Downloads are unavailable just now. Try Refresh.');
			const feed = await response.json(); let count = 0;
			for (const flavour of ['phone','tv']) {
				const entry = feed[flavour]; if (!entry) continue;
				const url = new URL(entry.url);
				if (!['http:','https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) continue;
				if (feed.edition === 'homelab') {
					if (entry.package !== 'app.tellybox.homelab' || url.href !== `https://homelab.tellyboxapp.com/downloads/Tellybox-${flavour}-latest.apk`) continue;
				} else if (feed.edition !== 'personal' || entry.package !== feed.packageName || !new RegExp('^/app-updates/Tellybox-' + flavour + '-[0-9.]+\\.apk$').test(url.pathname)) continue;
				const link = document.querySelector('#' + flavour + 'Apk');
				link.href = url.href; link.download = url.pathname.split('/').pop(); link.hidden = false;
				document.querySelector('#' + flavour + 'ApkVersion').textContent = feed.edition === 'homelab' ? 'Latest HomeLab release' : `Version ${entry.versionName} · Build ${entry.versionCode} · ${Math.ceil(entry.bytes / 1048576)} MB`;
				count++;
			}
			message.textContent = count ? 'Latest published versions' : 'No app downloads published yet.';
		} catch (error) { message.textContent = error.message; }
		finally { refresh.disabled = false; }
	}
	refresh.onclick = loadDownloads;
	void loadDownloads();
})();
