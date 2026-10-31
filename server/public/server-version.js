'use strict';

// Cosmetic release information must never delay viewing or installation setup.
fetch('/api/version', { cache: 'no-store' }).then(async response => {
	if (!response.ok) return;
	const release = await response.json();
	if (typeof release.version !== 'string' || !/^\d+\.\d+\.\d+(?:-[\da-z.-]+)?$/i.test(release.version)) return;
	for (const label of document.querySelectorAll('[data-server-version]')) {
		label.textContent = `Server v${release.version}`;
		label.hidden = false;
	}
}).catch(() => {});
