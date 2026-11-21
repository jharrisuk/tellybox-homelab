(() => {
	'use strict';
	// A failed CDN stylesheet/image restores its normal-origin path. Stylesheets
	// and still-loading images are also checked after a bounded wait, so a hung
	// CDN cannot leave the page without local styling indefinitely.
	const FALLBACK_MS = 3000;
	function localPath(element) {
		return element && element.getAttribute ? element.getAttribute('data-tellybox-local') : '';
	}
	function loaded(element) {
		if (element.tagName === 'LINK') {
			const rel = (element.getAttribute('rel') || '').toLowerCase();
			if (rel === 'stylesheet') return Boolean(element.sheet);
			return true;
		}
		if (element.tagName === 'IMG') return element.complete && element.naturalWidth > 0;
		return true;
	}
	function restore(element, fromError = false) {
		// Artwork images with a public poster fallback are owned by
		// artwork-fallback.js on the error path. The timed liveness check still
		// restores a hung initial CDN image, because a hang emits no error event.
		if (fromError && element?.tagName === 'IMG' && element.hasAttribute('data-tellybox-poster')) return;
		if (!fromError && element?.tagName === 'IMG' && element.dataset.tellyboxArtworkStage) return;
		const local = localPath(element);
		if (!local) return;
		element.removeAttribute('data-tellybox-local');
		if (element.tagName === 'LINK') element.href = local;
		else if (element.tagName === 'IMG') element.src = local;
	}
	function check() {
		for (const element of document.querySelectorAll('[data-tellybox-local]')) {
			if (!loaded(element)) restore(element);
		}
	}
	window.addEventListener('error', event => restore(event.target, true), true);
	setTimeout(check, FALLBACK_MS);
	window.addEventListener('load', () => setTimeout(check, FALLBACK_MS), { once: true });
})();
