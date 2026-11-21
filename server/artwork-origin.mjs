import { proxyImage as defaultProxyImage } from './image-proxy.mjs';
import { channelLogoUrl, findChannelForArtwork } from './dispatcharr.mjs';

const JELLYFIN_ID = /^[a-f0-9-]{32,36}$/i;
const CHANNEL_LOGO = /^\/api\/channels\/logos\/(\d+)\/cache\/$/;
const VOD_LOGO = /^\/api\/vod\/vodlogos\/(\d+)\/cache\/$/;
const TMDB_PATH = /^\/[A-Za-z0-9_-]+\.(?:jpg|jpeg|png|webp)$/i;
const TVDB_PATH = /^\/banners\/[A-Za-z0-9_./-]+\.(?:jpg|jpeg|png)$/i;

function fail(res, status = 404) {
	if (res.headersSent || res.writableEnded) return;
	res.setHeader('Cache-Control', 'no-store');
	res.status(status).json({ error: status === 413 ? 'Artwork is too large.' : status === 504 ? 'Artwork request timed out.' : 'Artwork is not available.' });
}

export function createArtworkOrigin({
	cdn, upstream, headers, dispatcharr, vodLibrary, proxyImage = defaultProxyImage, now = Date.now,
} = {}) {
	return async function handleArtworkOrigin(req, res) {
		res.setHeader('X-Content-Type-Options', 'nosniff');
		res.setHeader('Access-Control-Allow-Origin', '*');
		res.setHeader('Cache-Control', 'no-store');
		if (!['GET', 'HEAD'].includes(req.method)) return fail(res, 405);
		if (!cdn?.enabled) return fail(res, 404);
		const payload = cdn.verify(req.params.token);
		if (!payload) return fail(res, 404);
		if (!/^image\.(?:jpg|jpeg|png|webp)$/i.test(String(req.params.name || ''))) return fail(res, 404);
		// A signed URL is a capability that ends at the token expiry. Never send a
		// year-long public cache header from the origin; the edge keeps its own
		// separate internal cache. A direct origin response is private to one
		// client and expires no later than the ticket.
		const remaining = Math.max(0, Math.floor((Number(payload.e) - now()) / 1000));
		const cache = `private, max-age=${remaining}, must-revalidate`;
		try {
			if (payload.p === 'jellyfin') {
				if (!JELLYFIN_ID.test(payload.i) || !['Primary', 'Backdrop'].includes(payload.k)) return fail(res, 404);
				const url = new URL(`/Items/${payload.i}/Images/${payload.k}?maxWidth=${payload.w}&quality=85&tag=${encodeURIComponent(payload.t)}`, upstream);
				return await proxyImage(res, { url, headers: headers(), maxBytes: 10 * 1024 * 1024,
					allow: /^image\//i, cache, timeoutMs: 10000,
					fallbackType: 'image/jpeg', label: 'CDN library artwork' });
			}
			if (payload.p === 'tmdb') {
				if (!TMDB_PATH.test(payload.x)) return fail(res, 404);
				const size = payload.k === 'backdrop' ? 'w1280' : 'w500';
				const url = `https://image.tmdb.org/t/p/${size}${payload.x}`;
				return await proxyImage(res, { url, maxBytes: 5 * 1024 * 1024,
					allow: /^image\/(?:png|jpeg|webp)(?:;|$)/i, cache,
					timeoutMs: 10000, label: 'CDN TMDB artwork' });
			}
			if (payload.p === 'tvdb') {
				if (!TVDB_PATH.test(payload.x)) return fail(res, 404);
				const url = `https://artworks.thetvdb.com${payload.x}`;
				return await proxyImage(res, { url, maxBytes: 5 * 1024 * 1024,
					allow: /^image\/(?:png|jpeg)(?:;|$)/i, cache,
					timeoutMs: 10000, label: 'CDN TVDB artwork' });
			}
			if (payload.p === 'dispatcharr-channel') {
				// Resolve exactly the way the live channel-image route does, and
				// keep its provider-logo fallback. Dispatcharr's own logo cache
				// refuses many provider images, so proxying only that URL 404s
				// even though the channel has artwork.
				const channel = findChannelForArtwork(await dispatcharr.channels(), payload.i);
				if (!channel) return fail(res, 404);
				const cached = channelLogoUrl(channel, dispatcharr.origin);
				const fallback = channel.sourceLogo && typeof dispatcharr.providerLogo === 'function'
					? dispatcharr.providerLogo(channel.sourceLogo) : '';
				const target = fallback || cached;
				if (!target) return fail(res, 404);
				return await proxyImage(res, { url: target, maxBytes: 3 * 1024 * 1024,
					allow: /^image\/(?:png|jpeg|webp|gif)(?:;|$)/i, cache,
					timeoutMs: 10000, label: 'CDN channel artwork' });
			}
			if (payload.p === 'dispatcharr-vod') {
				const raw = await vodLibrary.raw(`dispatch-${payload.k}-${payload.i}`);
				const logo = Number(raw?.data?.logo?.id);
				// Same staleness rule as channels: a valid ticket for an item that
				// still exists serves its current logo.
				if (!Number.isSafeInteger(logo) || logo <= 0) return fail(res, 404);
				const url = new URL(`/api/vod/vodlogos/${logo}/cache/`, dispatcharr.origin);
				const match = VOD_LOGO.exec(url.pathname);
				if (!match || Number(match[1]) !== logo) return fail(res, 404);
				return await proxyImage(res, { url, maxBytes: 3 * 1024 * 1024,
					allow: /^image\/(?:png|jpeg|webp|gif)(?:;|$)/i, cache,
					timeoutMs: 10000, label: 'CDN catalogue artwork' });
			}
			return fail(res, 404);
		} catch (error) {
			// Never turn a provider failure into a cacheable response.
			const status = error?.name === 'TimeoutError' ? 504 : 502;
			return fail(res, status);
		}
	};
}
