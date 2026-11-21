import { createHash } from 'node:crypto';

const JELLYFIN = /^\/images\/([a-f0-9-]{32,36})\/(Primary|Backdrop)(?:\?([^#]*))?$/i;
const VOD_ART = /^\/api\/web\/art\/(movie|series|episode)\/([1-9]\d{0,9})(?:\?([^#]*))?$/;
const TMDB_ART = /^\/api\/web\/tmdb-art\/(movie|tv)\/([1-9]\d{0,9})\/(poster|backdrop)$/;
const CHANNEL_ART = /^\/api\/dispatcharr\/channels\/([a-f0-9-]{32,36})\/image(?:\?([^#]*))?$/i;
const TMDB_DIRECT = /^https:\/\/image\.tmdb\.org\/t\/p\/[^/]+\/([A-Za-z0-9_-]+\.(?:jpg|jpeg|png|webp))$/i;
const TVDB_DIRECT = /^https:\/\/artworks\.thetvdb\.com(\/banners\/[A-Za-z0-9_./-]+\.(?:jpg|jpeg|png))$/i;
const TMDB_PATH = /^\/[A-Za-z0-9_-]+\.(?:jpg|jpeg|png|webp)$/i;

export function isLocalOrHome(req) {
	return Boolean(req?.jserverLocal || req?.jserverViewer?.home === true);
}

function queryValue(query, key) {
	const params = new URLSearchParams(query || '');
	return params.get(key) || '';
}
function imageWidth(query, fallback = 400) {
	const width = Number(queryValue(query, 'width'));
	return Number.isSafeInteger(width) ? Math.min(1920, Math.max(100, width)) : fallback;
}
function tmdbType(item) {
	if (item?.type === 'movie' || item?.mediaType === 'movie') return 'movie';
	if (item?.type === 'tv' || item?.mediaType === 'tv') return 'tv';
	if (item?.Type === 'Movie') return 'movie';
	if (item?.Type === 'Series') return 'tv';
	return '';
}
function tmdbId(item) {
	const value = item?.id ?? item?.ProviderIds?.Tmdb;
	return Number.isSafeInteger(Number(value)) && Number(value) > 0 ? String(Number(value)) : '';
}
function jellyfinTag(item, backdrop) {
	if (backdrop) return String(item?.ParentBackdropImageTags?.[0] || item?.BackdropImageTags?.[0] || '');
	return String(item?.ImageTags?.Primary || '');
}
// A short content version for the browser URL. It is derived from the trusted
// provider image tag only, never from image bytes, so a changed tag naturally
// produces a new URL and an unchanged tag keeps the same one.
function contentVersion(tag) {
	const value = String(tag || '');
	if (!value) return '';
	return createHash('sha256').update('tellybox-library-image-version-v1\0' + value).digest('hex').slice(0, 12);
}
function localImage(id, kind, width, version = '') {
	const route = '/images/' + encodeURIComponent(id) + '/' + kind + '?width=' + width;
	return version ? route + '&v=' + version : route;
}
function localTmdb(type, id, kind) {
	return '/api/web/tmdb-art/' + type + '/' + id + '/' + kind;
}
function originRelative(url, cdn) {
	if (!url || !cdn?.origin || !url.startsWith(cdn.origin + '/')) return '';
	const relative = url.slice(cdn.origin.length);
	return /^\/tellybox\/[A-Za-z0-9_./-]+$/.test(relative) ? relative : '';
}
function assignImage(target, key, localKey, value, local, cdn) {
	if (!value) return;
	target[key] = value;
	if (!local) {
		const relative = originRelative(value, cdn);
		if (relative) target[localKey] = relative;
	}
}

async function rewriteRoute(route, item, kind, { cdn, local, resolvers, authorize, versioned = false, scope = '' }) {
	if (typeof route !== 'string' || !route) return route;
	// Minting is explicit: the caller must pass an authorization check, and the
	// trusted image tag is only a content version. Local requests never mint.
	const maySign = !local && typeof authorize === 'function' && authorize(item) === true;
	let match = JELLYFIN.exec(route);
	if (match) {
		const id = match[1], imageKind = match[2], width = imageWidth(match[3]);
		// A parent-series poster referenced from an episode (different id) does
		// not carry the episode's own image tag. Do not derive a version or mint
		// a signed URL from the episode tag; keep the auth-gated origin route
		// until the parent's own tag is available.
		if (imageKind === 'Primary' && String(id) !== String(item?.Id || '')) {
			return localImage(id, imageKind, width);
		}
		const tag = imageKind === 'Backdrop'
			? (String(id) === String(item?.ParentBackdropItemId) ? String(item?.ParentBackdropImageTags?.[0] || '') : String(item?.BackdropImageTags?.[0] || ''))
			: String(item?.ImageTags?.Primary || '');
		const version = versioned ? contentVersion(tag) : '';
		if (local) return localImage(id, imageKind, width, version);
		const signed = maySign && tag && cdn?.privateEnabled ? cdn.jellyfinUrl({ id, kind: imageKind, width, tag, scope }) : null;
		return signed?.url || localImage(id, imageKind, width, version);
	}
	match = VOD_ART.exec(route);
	if (match) {
		const vodKind = match[1];
		const id = match[2];
		// Local viewers keep the same-origin route and must never wait on a
		// provider logo lookup. This await used to run before the local check,
		// adding a serial Dispatcharr round-trip to every local Home response.
		if (local) return route;
		const version = queryValue(match[3], 'v') || await resolvers.vodLogo?.(vodKind, id);
		const signed = maySign && version ? cdn?.vodUrl({ id, kind: vodKind, logoId: version }) : null;
		return signed?.url || route;
	}
	match = TMDB_ART.exec(route);
	if (match) {
		const type = match[1], id = match[2], imageKind = match[3];
		const itemPath = imageKind === 'poster' ? item?.poster : item?.backdropPath;
		const knownPath = TMDB_PATH.test(itemPath || '') ? itemPath : '';
		if (local) {
			if (knownPath) await resolvers.tmdbRemember?.(type, id, imageKind, knownPath);
			return route;
		}
		const path = knownPath || await resolvers.tmdbPath?.(type, id, imageKind);
		const signed = maySign && path ? cdn?.tmdbUrl({ type, id, kind: imageKind, path }) : null;
		return signed?.url || route;
	}
	match = CHANNEL_ART.exec(route);
	if (match) {
		const id = match[1];
		const version = queryValue(match[2], 'v') || await resolvers.channelLogo?.(id);
		if (local) return route;
		const signed = maySign && version ? cdn?.channelUrl({ id, logoId: version }) : null;
		return signed?.url || route;
	}
	match = TMDB_DIRECT.exec(route);
	if (match) {
		const path = '/' + match[1];
		const type = tmdbType(item), id = tmdbId(item);
		if (local) {
			if (type && id && TMDB_PATH.test(path) && await resolvers.tmdbRemember?.(type, id, 'poster', path) === true) {
				return localTmdb(type, id, 'poster');
			}
			return route;
		}
		const signed = maySign && type && id ? cdn?.tmdbUrl({ type, id, kind: 'poster', path }) : null;
		return signed?.url || route;
	}
	match = TVDB_DIRECT.exec(route);
	if (match) {
		if (local) return route;
		const signed = maySign ? cdn?.tvdbUrl({ path: match[1] }) : null;
		return signed?.url || route;
	}
	return route;
}

async function rewriteItem(item, options) {
	if (!item || typeof item !== 'object' || Array.isArray(item)) return;
	const { local, cdn, resolvers, versioned = false, scope = '' } = options;
	const maySign = !local && typeof options.authorize === 'function' && options.authorize(item) === true;
	if (typeof item.Artwork === 'string') {
		const rewritten = await rewriteRoute(item.Artwork, item, 'Artwork', options);
		assignImage(item, 'Artwork', 'ArtworkLocal', rewritten, local, cdn);
	}
	if (typeof item.BackdropArtwork === 'string') {
		const rewritten = await rewriteRoute(item.BackdropArtwork, item, 'BackdropArtwork', options);
		assignImage(item, 'BackdropArtwork', 'BackdropArtworkLocal', rewritten, local, cdn);
	}
	// Discovery entries carry a TMDB path in poster, not an artwork URL.
	const type = tmdbType(item), tmdb = tmdbId(item);
	if (type && tmdb && typeof item.poster === 'string' && TMDB_PATH.test(item.poster)) {
		const localRoute = localTmdb(type, tmdb, 'poster');
		if (local) {
			if (await resolvers.tmdbRemember?.(type, tmdb, 'poster', item.poster) === true && !item.Artwork) item.Artwork = localRoute;
		} else if (maySign && !item.Artwork) {
			const signed = cdn?.tmdbUrl({ type, id: tmdb, kind: 'poster', path: item.poster });
			if (signed) assignImage(item, 'Artwork', 'ArtworkLocal', signed.url, false, cdn);
		}
	}
	if (type && tmdb && typeof item.backdropPath === 'string' && TMDB_PATH.test(item.backdropPath)) {
		const localRoute = localTmdb(type, tmdb, 'backdrop');
		if (local) {
			if (await resolvers.tmdbRemember?.(type, tmdb, 'backdrop', item.backdropPath) === true && !item.BackdropArtwork) item.BackdropArtwork = localRoute;
		} else if (maySign && !item.BackdropArtwork) {
			const signed = cdn?.tmdbUrl({ type, id: tmdb, kind: 'backdrop', path: item.backdropPath });
			if (signed) assignImage(item, 'BackdropArtwork', 'BackdropArtworkLocal', signed.url, false, cdn);
		}
	}
	// Jellyfin item payloads normally have image tags but no explicit route.
	const primaryTag = jellyfinTag(item, false);
	if (!item.Artwork && item.Id && primaryTag && /^[a-f0-9-]{32,36}$/i.test(String(item.Id))) {
		const route = localImage(item.Id, 'Primary', 400, versioned ? contentVersion(primaryTag) : '');
		if (local) item.Artwork = route;
		else {
			const signed = maySign && cdn?.privateEnabled ? cdn.jellyfinUrl({ id: item.Id, kind: 'Primary', width: 400, tag: primaryTag, scope }) : null;
			if (signed) assignImage(item, 'Artwork', 'ArtworkLocal', signed.url, false, cdn);
			else item.Artwork = route;
		}
	}
	if (!item.BackdropArtwork && item.Id) {
		const parentTag = String(item.ParentBackdropImageTags?.[0] || '');
		const ownTag = String(item.BackdropImageTags?.[0] || '');
		const tag = parentTag || ownTag;
		const backdropId = parentTag ? item.ParentBackdropItemId : item.Id;
		if (tag && /^[a-f0-9-]{32,36}$/i.test(String(backdropId))) {
			const route = localImage(backdropId, 'Backdrop', 1280, versioned ? contentVersion(tag) : '');
			if (local) item.BackdropArtwork = route;
			else {
				const signed = maySign && cdn?.privateEnabled ? cdn.jellyfinUrl({ id: backdropId, kind: 'Backdrop', width: 1280, tag, scope }) : null;
				if (signed) assignImage(item, 'BackdropArtwork', 'BackdropArtworkLocal', signed.url, false, cdn);
				else item.BackdropArtwork = route;
			}
		}
	}
	if (!item.Artwork && item.watchId && /^[a-f0-9-]{32,36}$/i.test(String(item.watchId))) {
		// Discovery watch ids do not carry a trusted image tag, so they stay on
		// the origin even for remote clients. The private original route is safe.
		item.Artwork = localImage(item.watchId, 'Primary', 342);
	}
}

async function walk(value, options) {
	if (Array.isArray(value)) {
		for (const entry of value) await walk(entry, options);
		return;
	}
	if (!value || typeof value !== 'object') return;
	await rewriteItem(value, options);
	for (const entry of Object.values(value)) if (entry && typeof entry === 'object') await walk(entry, options);
}

/**
 * Return a copy of a JSON response with artwork fields prepared for this
 * request. Local requests keep local routes. Remote requests use signed CDN
 * URLs where a trusted version is available, and keep the private original
 * route where it is not. The copy prevents cached feed objects being poisoned
 * by a different caller's local/CDN mode.
 */
export async function rewriteArtworkResponse(body, options = {}) {
	if (!body || typeof body !== 'object') return body;
	const copy = structuredClone(body);
	await walk(copy, { local: options.local === true, cdn: options.cdn, resolvers: options.resolvers || {},
		authorize: options.authorize,
		// Content-versioned local URLs and private mint reuse are opt-in so the
		// caller has to name the authorization scope that was actually checked.
		versioned: options.versioned === true,
		scope: typeof options.scope === 'string' ? options.scope : '' });
	return copy;
}
