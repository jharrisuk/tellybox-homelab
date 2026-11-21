import { createHash } from 'node:crypto';
import { proxyImage as defaultProxyImage } from './image-proxy.mjs';

/**
 * Private local library artwork (`/images/:id/:kind?width=`).
 *
 * The bytes stay on the origin: this module never keeps image bytes in memory
 * or on disk. What it adds is authenticated conditional revalidation:
 *
 * - A strong ETag built from the item's trusted Jellyfin image tag for the exact
 *   id/kind plus the kind and the clamped width. A tag is never derived from
 *   image bytes or from a client-supplied query value.
 * - `Cache-Control: private, no-cache` on a successful 200, so the browser may
 *   keep the previous body but must ask before reusing it.
 * - `304` only after the request passed the same authentication and the same
 *   viewer authorization as the 200 path. Errors are always `no-store` and
 *   never carry an ETag.
 * - If no trusted tag is available the route falls back to today's
 *   `private, no-store` response without any validator.
 *
 * The body path is still the bounded image proxy (maxBytes/type/timeout).
 */

const ITEM_ID = /^[a-f0-9-]{32,36}$/i;
// Jellyfin image tags are opaque tokens. Anything outside this set is treated as
// "no trusted tag" rather than being echoed into a validator.
const IMAGE_TAG = /^[A-Za-z0-9._~-]{1,128}$/;
const KINDS = new Set(['Primary', 'Backdrop']);
const DEFAULT_WIDTH = 400;
const MIN_WIDTH = 100;
const MAX_WIDTH = 1920;

export const LIBRARY_IMAGE_CACHE = 'private, no-cache';
export const LIBRARY_IMAGE_NO_STORE = 'private, no-store';
// Only the fields needed to version an image, so the metadata response stays small.
export const LIBRARY_IMAGE_TAG_FIELDS = 'Fields=ImageTags,BackdropImageTags,ParentBackdropItemId,ParentBackdropImageTags';

export function clampImageWidth(value, { fallback = DEFAULT_WIDTH, min = MIN_WIDTH, max = MAX_WIDTH } = {}) {
	// Same clamp the previous inline route used: an unparseable or zero width is
	// the default, everything else is bounded.
	const width = Number(value) || fallback;
	return Math.min(max, Math.max(min, width));
}

export function normalizeImageKind(value) {
	return KINDS.has(value) ? value : 'Primary';
}

export function libraryImageEtag({ id, kind, width, tag } = {}) {
	if (!ITEM_ID.test(String(id || '')) || !KINDS.has(kind) || !IMAGE_TAG.test(String(tag || ''))) return '';
	const digest = createHash('sha256')
		.update(['tellybox-library-image-v1', String(id).toLowerCase(), kind, String(width), String(tag)].join('\0'))
		.digest('hex');
	return '"tb125-' + digest.slice(0, 40) + '"';
}

// If-None-Match uses the weak comparison function, so an optional `W/` prefix is
// ignored. `*` is deliberately not treated as a match: the route must not claim
// a representation exists before the provider answered.
export function ifNoneMatchMatches(header, etag) {
	if (!header || !etag) return false;
	for (const part of String(header).split(',')) {
		let candidate = part.trim();
		if (!candidate || candidate === '*') continue;
		if (candidate.startsWith('W/')) candidate = candidate.slice(2).trim();
		if (candidate === etag) return true;
	}
	return false;
}

function discard(response) {
	try { return Promise.resolve(response?.body?.cancel?.()).catch(() => {}); } catch { return Promise.resolve(); }
}

export function imageTagsFromItem(item) {
	if (!item || typeof item !== 'object') return null;
	const primary = String(item.ImageTags?.Primary || '');
	const own = Array.isArray(item.BackdropImageTags) ? String(item.BackdropImageTags[0] || '') : '';
	const parent = Array.isArray(item.ParentBackdropImageTags) ? String(item.ParentBackdropImageTags[0] || '') : '';
	return {
		primary: IMAGE_TAG.test(primary) ? primary : '',
		backdrop: IMAGE_TAG.test(own) ? own : '',
		// A child item inherits the parent backdrop, but the body is only ever read
		// for the requested id. These two fields therefore stay metadata: they are
		// used below only when the parent id is this same id.
		parentBackdrop: IMAGE_TAG.test(parent) ? parent : '',
		parentId: ITEM_ID.test(String(item.ParentBackdropItemId || '')) ? String(item.ParentBackdropItemId) : '',
	};
}

export function trustedImageTag(tags, kind, id = '') {
	if (!tags) return '';
	if (kind === 'Backdrop') {
		if (tags.backdrop) return tags.backdrop;
		// Parent-backdrop resolution: the local URL builder addresses the parent id
		// directly, so looking that id up already returns the parent's own backdrop
		// tag. This branch only covers a payload whose parent is itself; it never
		// borrows a tag that belongs to a different id, because authorization and
		// the proxied body are both scoped to the requested id.
		if (tags.parentBackdrop && tags.parentId && id && tags.parentId === String(id)) return tags.parentBackdrop;
		return '';
	}
	return tags.primary;
}

export function createItemTagReader({
	upstream, headers = () => ({}), fetchImpl = null, timeoutMs = 8000, maxBytes = 256 * 1024,
} = {}) {
	if (!upstream) throw new TypeError('upstream is required');
	const base = new URL(upstream);
	return async function readItemTags(id) {
		if (!ITEM_ID.test(String(id || ''))) return null;
		const controller = new AbortController();
		const timer = setTimeout(
			() => controller.abort(Object.assign(Error('Image metadata timed out.'), { name: 'TimeoutError' })),
			timeoutMs,
		);
		try {
			const url = new URL('/Items/' + encodeURIComponent(id) + '?' + LIBRARY_IMAGE_TAG_FIELDS, base);
			const response = await (fetchImpl || fetch)(url, { redirect: 'error', signal: controller.signal, headers: headers() });
			if (!response.ok) { await discard(response); return null; }
			const length = Number(response.headers.get('content-length'));
			if (Number.isFinite(length) && length > maxBytes) { await discard(response); return null; }
			const text = await response.text();
			if (text.length > maxBytes) return null;
			return imageTagsFromItem(JSON.parse(text));
		} catch {
			// A provider failure is never a version.
			return null;
		} finally {
			clearTimeout(timer);
		}
	};
}

// Bounded, short-lived metadata cache. Keys are item ids that already passed
// authorization; failures are never stored. Conditional requests read fresh so a
// changed tag can never be answered with a stale 304.
export function createTagCache({ ttlMs = 30_000, maxEntries = 1024, now = Date.now } = {}) {
	const entries = new Map();
	const cap = Math.max(1, Math.floor(Number(maxEntries) || 1024));
	const ttl = Math.max(0, Math.floor(Number(ttlMs) || 0));
	return {
		get(id, { fresh = false } = {}) {
			const entry = entries.get(id);
			if (!entry) return undefined;
			if (fresh || now() - entry.at >= ttl) { entries.delete(id); return undefined; }
			return entry.tags;
		},
		set(id, tags) {
			if (!tags) return;
			entries.delete(id);
			entries.set(id, { tags, at: now() });
			while (entries.size > cap) entries.delete(entries.keys().next().value);
		},
		clear() { entries.clear(); },
		get size() { return entries.size; },
		get maxEntries() { return cap; },
	};
}

export function libraryImageUrl(upstream, id, kind, width) {
	return new URL(`/Items/${encodeURIComponent(id)}/Images/${kind}?maxWidth=${width}&quality=85`, upstream);
}

function fail(res, status, error) {
	if (res.headersSent || res.writableEnded) return;
	res.removeHeader?.('ETag');
	res.setHeader('Cache-Control', 'no-store');
	// end() rather than json() so Express cannot attach its automatic weak ETag
	// to an error response.
	res.setHeader('Content-Type', 'application/json; charset=utf-8');
	return res.status(status).end(JSON.stringify({ error }));
}

/**
 * @param {object} options
 * @param {URL|string} options.upstream Jellyfin base URL.
 * @param {() => object} [options.headers] Provider credentials for the upstream call.
 * @param {(req, ctx: {id: string, kind: string, width: number}) => boolean|Promise<boolean>} [options.authorize]
 *   The same authorization decision the 200 path and the mint path use. It runs
 *   before any cache lookup and before any 304.
 * @param {Function} [options.readTags] Override for the tag lookup (tests).
 * @param {Function} [options.proxyImage] Bounded image proxy (tests).
 */
export function createLibraryImageHandler({
	upstream, headers = () => ({}), proxyImage = defaultProxyImage, authorize = null,
	readTags = null, fetchImpl = null, now = Date.now,
	tagTtlMs = 30_000, tagMaxEntries = 1024,
	maxBytes = 10 * 1024 * 1024, timeoutMs = 15_000, logger = console,
} = {}) {
	if (!upstream) throw new TypeError('upstream is required');
	const base = new URL(upstream);
	const read = readTags || createItemTagReader({ upstream: base, headers, fetchImpl });
	const cache = createTagCache({ ttlMs: tagTtlMs, maxEntries: tagMaxEntries, now });

	async function loadTags(id, fresh) {
		const cached = cache.get(id, { fresh });
		if (cached) return cached;
		let tags = null;
		try { tags = await read(id); } catch { tags = null; }
		if (!tags) return null;
		cache.set(id, tags);
		return tags;
	}

	async function handleLibraryImage(req, res) {
		if (!['GET', 'HEAD'].includes(req.method)) return fail(res, 405, 'Artwork can only be read.');
		const id = String(req.params?.id || '').toLowerCase();
		if (!ITEM_ID.test(id)) return fail(res, 404, 'Artwork is not available.');
		const kind = normalizeImageKind(req.params?.kind);
		const width = clampImageWidth(req.query?.width);

		// Authentication is the caller's gate. Re-check it here so a route mounted
		// outside the gate cannot serve or validate anything.
		if (!req.jserverViewer && !req.jserverLocal) return fail(res, 401, 'Please sign in to jServer.');
		// Authorization runs before the tag lookup, before the conditional check and
		// before any response that could be reused. A denied viewer never reaches a
		// 304, even with a validator minted while they were still allowed.
		if (typeof authorize === 'function' && await authorize(req, { id, kind, width }) !== true) {
			return fail(res, 403, 'Artwork is not available.');
		}

		const requestValidator = req.headers?.['if-none-match'];
		const tags = await loadTags(id, Boolean(requestValidator));
		const tag = trustedImageTag(tags, kind, id);
		const url = libraryImageUrl(base, id, kind, width);
		if (!tag) {
			// No trusted content version: keep the current no-store behaviour rather
			// than invent a weak or wrong validator.
			return proxyImage(res, {
				url, headers: headers(), maxBytes, timeoutMs, label: 'Library image', logger,
				cache: LIBRARY_IMAGE_NO_STORE, fallbackType: 'image/jpeg',
			});
		}

		const etag = libraryImageEtag({ id, kind, width, tag });
		if (ifNoneMatchMatches(requestValidator, etag)) {
			res.setHeader('Cache-Control', LIBRARY_IMAGE_CACHE);
			res.setHeader('ETag', etag);
			res.status(304);
			return res.end();
		}

		return proxyImage(res, {
			url, headers: headers(), maxBytes, timeoutMs, label: 'Library image', logger,
			cache: LIBRARY_IMAGE_CACHE, fallbackType: 'image/jpeg',
			// Set the validator only once the proxy accepted the upstream image, so a
			// 404/413/5xx never carries a reusable ETag.
			onSuccess: target => { target.setHeader?.('ETag', etag); },
		});
	}

	handleLibraryImage.tagCache = cache;
	return handleLibraryImage;
}
