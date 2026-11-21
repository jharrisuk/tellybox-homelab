/**
 * Content Security Policy helpers.
 *
 * A local page may play relay media from the configured public HTTPS origin.
 * Only that exact origin is added, and only when relay media is enabled.
 */
export function normalizeRelayOrigin(value = '', enabled = false) {
	if (!enabled) return '';
	try {
		const url = new URL(value);
		if (url.protocol !== 'https:') return '';
		if (url.username || url.password) return '';
		if (url.pathname !== '/' || url.search || url.hash) return '';
		return url.origin;
	} catch {
		return '';
	}
}

/** Optional public CDN origin for stylesheets and static branding. */
export function normalizeAssetOrigin(value = '') {
	const origin = normalizeRelayOrigin(value, true);
	if (!origin) return '';
	try {
		const host = new URL(origin).hostname;
		if (/^(169\.254\.|0\.|metadata\.|metadata$|\[?fe80:)/i.test(host)) return '';
	} catch {
		return '';
	}
	return origin;
}

export function contentSecurityPolicy({ localPlaybackOrigin, relayMediaOrigin = '', assetOrigin = '' } = {}) {
	const relay = relayMediaOrigin ? ` ${relayMediaOrigin}` : '';
	const asset = assetOrigin ? ` ${assetOrigin}` : '';
	// The Home pre-paint bootstrap is an inline script. It is allowed by its exact
	// SHA-256 content hash, never by 'unsafe-inline'; csp-124.test.mjs fails if
	// index.html changes without updating this hash.
	return `default-src 'self'; script-src 'self' 'sha256-ST12Mvbndnai81j42hv0vwnaS5Isa1L3vcLQFXqEquw=' https://www.gstatic.com; style-src 'self'${asset}; img-src 'self' data: https://image.tmdb.org https://artworks.thetvdb.com${asset}; font-src 'self'${asset}; media-src 'self' blob: ${localPlaybackOrigin}${relay}; connect-src 'self' ${localPlaybackOrigin}${relay}; frame-src https://www.gstatic.com; worker-src 'self' blob:; frame-ancestors 'none'`;
}
