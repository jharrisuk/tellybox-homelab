/* Progressive artwork fallback.
 *
 * The server may send a signed CDN URL with an origin/local fallback, or a
 * local TMDB route with the public TMDB filename as a last resort. Error
 * events do not bubble, so capture them here before a card replaces the image
 * with a placeholder. The normal per-image handler still runs after the final
 * fallback fails.
 */
(() => {
	const absolute = value => {
		try { return value ? new URL(value, location.origin).href : ''; } catch { return ''; }
	};
	const candidates = image => {
		const stage = image.dataset.tellyboxArtworkStage || '';
		if (stage === 'local') return [image.dataset.tellyboxPoster];
		if (stage === 'poster') return [];
		return [image.dataset.tellyboxLocal, image.dataset.tellyboxPoster];
	};
	document.addEventListener('error', event => {
		const image = event.target;
		if (!(image instanceof HTMLImageElement)) return;
		if (!image.dataset.tellyboxLocal && !image.dataset.tellyboxPoster) return;
		const current = image.src;
		for (const value of candidates(image)) {
			const next = absolute(value);
			if (!next || next === current) continue;
			image.dataset.tellyboxArtworkStage = value === image.dataset.tellyboxLocal ? 'local' : 'poster';
			event.stopImmediatePropagation();
			event.stopPropagation();
			image.src = next;
			return;
		}
		// No fallback left: let the card's own error handler show its placeholder.
		delete image.dataset.tellyboxFallback;
	}, true);
})();
