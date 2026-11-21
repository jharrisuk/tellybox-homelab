import { createCipheriv, createDecipheriv, createHash } from 'node:crypto';
import { normalizePublicAssetOrigin } from './public-assets.mjs';

/**
 * Signed artwork CDN URLs for public metadata artwork and, when explicitly
 * enabled, private library artwork.
 *
 * The edge never receives provider credentials. A short-lived, narrowly scoped
 * token is the only authority for one image variant. The origin re-verifies the
 * token and resolves the identifier through an allowlisted provider; arbitrary
 * URLs are impossible. Private artwork remains on the origin unless both the
 * origin secret and the private-art flag are configured.
 */
export const ARTWORK_PROVIDERS = Object.freeze([
	'jellyfin', 'tmdb', 'tvdb', 'dispatcharr-channel', 'dispatcharr-vod'
]);

const PROVIDER_SET = new Set(ARTWORK_PROVIDERS);
const JELLYFIN_ID = /^[a-f0-9-]{32,36}$/i;
const NUMERIC_ID = /^[1-9]\d{0,9}$/;
const CHANNEL_ID = /^[a-f0-9-]{32,36}$/i;
const IMAGE_PATH = /^\/[A-Za-z0-9_-]+\.(?:jpg|jpeg|png|webp)$/i;
const TVDB_PATH = /^\/banners\/[A-Za-z0-9_./-]+\.(?:jpg|jpeg|png)$/i;

export function normalizeArtworkCdnOrigin(value = '') {
	return normalizePublicAssetOrigin(value);
}

export function safeArtworkPath(value = '') {
	const path = String(value || '');
	if (!IMAGE_PATH.test(path) || path.includes('..')) return '';
	return path;
}

export function safeTvdbPath(value = '') {
	const path = String(value || '');
	if (!TVDB_PATH.test(path) || path.includes('..')) return '';
	return path;
}

function base64url(buffer) {
	return Buffer.from(buffer).toString('base64url');
}
function fromBase64url(value) {
	return Buffer.from(value, 'base64url');
}
function safeWidth(value) {
	const width = Number(value);
	return Number.isSafeInteger(width) ? Math.min(1920, Math.max(100, width)) : 400;
}
function extension(path) {
	const match = /\.(jpg|jpeg|png|webp)$/i.exec(path || '');
	return match ? match[1].toLowerCase().replace('jpeg', 'jpg') : 'jpg';
}
function tokenKey(secret) {
	return createHash('sha256').update('tellybox-artwork-cdn-v1\0' + String(secret)).digest();
}

export function createArtworkCdn({
	origin = '', secret = '', now = Date.now, bucketMs = 5 * 60 * 1000, ttlMs = 60 * 60 * 1000,
	privateTtlMs = 5 * 60 * 1000, privateArtwork = false,
	// Bounded reuse of an already minted private URL. Every entry is scoped by the
	// authorization scope the caller checked, so two viewers never share one, and
	// the original ticket expiry is never extended. 0 disables the memo entirely.
	mintMemoMaxEntries = 256, mintMemoMinRemainingMs = 5000,
} = {}) {
	const base = normalizeArtworkCdnOrigin(origin);
	const key = secret && Buffer.byteLength(String(secret), 'utf8') >= 32 ? tokenKey(secret) : null;
	const enabled = Boolean(base && key);
	const privateEnabled = enabled && privateArtwork === true;
	const bucket = Math.max(30 * 1000, Number(bucketMs) || 5 * 60 * 1000);
	const ttl = Math.max(bucket, Number(ttlMs) || 60 * 60 * 1000);
	// Private library artwork is a bearer capability. Keep its lifetime short and
	// exact, not rounded up to the public cache bucket, so revocation is bounded
	// by a known maximum even after a person or device is signed out.
	const privateTtl = Math.min(15 * 60 * 1000, Math.max(30 * 1000, Number(privateTtlMs) || 5 * 60 * 1000));
	const memoCap = Math.max(0, Math.floor(Number(mintMemoMaxEntries) || 0));
	// An entry close to expiry is not reused; a fresh mint is cheaper for the
	// browser than a URL the edge rejects a second later.
	const memoFloor = Math.max(0, Math.min(
		Math.floor(Number(mintMemoMinRemainingMs) || 0),
		Math.floor(privateTtl / 2),
	));
	const mints = new Map();
	const mintCounts = { hits: 0, misses: 0, evictions: 0, expired: 0 };

	function mintKey(scope, id, kind, width, tag) {
		return [scope, 'jellyfin', String(id).toLowerCase(), kind, String(width), tag].join('\0');
	}
	function mintTake(key) {
		const entry = mints.get(key);
		if (!entry) return null;
		if (entry.expires <= now() + memoFloor) {
			mints.delete(key);
			mintCounts.expired += 1;
			return null;
		}
		mintCounts.hits += 1;
		// The stored object keeps its original expiry; reuse can never extend it.
		return entry.value;
	}
	function mintKeep(key, value) {
		// Expiry cleanup happens on every store, so the map cannot grow with dead
		// entries between inserts.
		for (const [stored, entry] of mints) {
			if (entry.expires > now() + memoFloor) continue;
			mints.delete(stored);
			mintCounts.expired += 1;
		}
		mints.delete(key);
		mints.set(key, { value, expires: value.expires });
		while (mints.size > memoCap) {
			mints.delete(mints.keys().next().value);
			mintCounts.evictions += 1;
		}
	}

	function encrypt(payload) {
		const plaintext = JSON.stringify(payload);
		// A deterministic IV is required for a stable URL inside one bucket, so
		// every viewer shares the same edge cache entry. A hash of the complete
		// plaintext is unique for different payloads, which keeps GCM nonces safe.
		const iv = createHash('sha256').update(plaintext).digest().subarray(0, 12);
		const cipher = createCipheriv('aes-256-gcm', key, iv);
		const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
		return base64url(iv) + '.' + base64url(ciphertext) + '.' + base64url(cipher.getAuthTag());
	}

	function decrypt(token) {
		try {
			const parts = String(token || '').split('.');
			if (parts.length !== 3) return null;
			const iv = fromBase64url(parts[0]);
			const ciphertext = fromBase64url(parts[1]);
			const tag = fromBase64url(parts[2]);
			if (iv.length !== 12 || !ciphertext.length || tag.length !== 16) return null;
			const decipher = createDecipheriv('aes-256-gcm', key, iv);
			decipher.setAuthTag(tag);
			const payload = JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8'));
			return payload && typeof payload === 'object' ? payload : null;
		} catch {
			return null;
		}
	}

	function validPayload(payload) {
		if (!payload || payload.v !== 1 || !PROVIDER_SET.has(payload.p)) return false;
		if (!Number.isSafeInteger(payload.e) || payload.e < 0) return false;
		if (typeof payload.i !== 'string' || !payload.i || payload.i.length > 200) return false;
		if (typeof payload.k !== 'string' || !payload.k || payload.k.length > 40) return false;
		if (!Number.isSafeInteger(payload.w) || payload.w < 0 || payload.w > 1920) return false;
		if (typeof payload.t !== 'string' || payload.t.length > 256) return false;
		if (payload.p === 'jellyfin') {
			if (!JELLYFIN_ID.test(payload.i) || !['Primary', 'Backdrop'].includes(payload.k)) return false;
			if (!payload.t || payload.t.length > 128) return false;
		}
		if (payload.p === 'tmdb') {
			if (!/^(?:movie|tv)\/[1-9]\d{0,9}$/.test(payload.i) || !['poster', 'backdrop'].includes(payload.k)) return false;
			if (!safeArtworkPath(payload.x)) return false;
		}
		if (payload.p === 'tvdb') {
			if (payload.i !== 'banner' || payload.k !== 'image' || !safeTvdbPath(payload.x)) return false;
		}
		if (payload.p === 'dispatcharr-channel') {
			if (!CHANNEL_ID.test(payload.i) || payload.k !== 'logo' || !NUMERIC_ID.test(payload.t)) return false;
		}
		if (payload.p === 'dispatcharr-vod') {
			if (!['movie', 'series', 'episode'].includes(payload.k) || !NUMERIC_ID.test(payload.i)) return false;
			if (!NUMERIC_ID.test(payload.t)) return false;
		}
		return true;
	}

	function build(payload) {
		if (!enabled) return '';
		const lifetime = payload.p === 'jellyfin' ? privateTtl : ttl;
		const expiry = payload.p === 'jellyfin'
			? Math.ceil(now() + lifetime)
			: Math.ceil(now() / bucket) * bucket + lifetime;
		const full = { v: 1, ...payload, e: expiry };
		if (!validPayload(full)) return '';
		const token = encrypt(full);
		const hash = createHash('sha256').update(JSON.stringify(full)).digest('hex').slice(0, 12);
		const name = payload.x ? 'image.' + extension(payload.x) : 'image.jpg';
		return { url: `${base}/tellybox/art/${token}/${hash}/${name}`, path: `/tellybox/art/${token}/${hash}/${name}`,
			expires: full.e, hash };
	}

	function verify(token, at = now()) {
		if (!enabled) return null;
		const payload = decrypt(token);
		if (!validPayload(payload) || payload.e < at) return null;
		return payload;
	}

	function jellyfinUrl({ id, kind, width = 400, tag = '', scope = '' } = {}) {
		if (!privateEnabled || !JELLYFIN_ID.test(String(id || '')) || !['Primary', 'Backdrop'].includes(kind)) return '';
		if (!tag) return '';
		const trusted = String(tag).slice(0, 128);
		const safe = safeWidth(width);
		// Without an explicit authorization scope there is no safe sharing key, so
		// the URL is minted fresh: the memo fails closed.
		const shareable = typeof scope === 'string' && scope.length > 0 && scope.length <= 200;
		const key = shareable ? mintKey(scope, String(id), kind, safe, trusted) : '';
		if (key) {
			const reused = mintTake(key);
			if (reused) return reused;
			mintCounts.misses += 1;
		}
		const built = build({ p: 'jellyfin', i: String(id), k: kind, w: safe, t: trusted });
		if (key && built) mintKeep(key, built);
		return built;
	}

	function tmdbUrl({ type, id, kind, path } = {}) {
		const typeId = String(type || '') + '/' + String(id || '');
		if (!/^(?:movie|tv)\/[1-9]\d{0,9}$/.test(typeId) || !['poster', 'backdrop'].includes(kind)) return '';
		const safe = safeArtworkPath(path);
		if (!safe) return '';
		return build({ p: 'tmdb', i: typeId, k: kind, w: kind === 'backdrop' ? 1280 : 500, t: createHash('sha256').update(safe).digest('hex').slice(0, 12), x: safe });
	}

	function tvdbUrl({ path } = {}) {
		const safe = safeTvdbPath(path);
		if (!safe) return '';
		return build({ p: 'tvdb', i: 'banner', k: 'image', w: 0, t: createHash('sha256').update(safe).digest('hex').slice(0, 12), x: safe });
	}

	function channelUrl({ id, logoId } = {}) {
		if (!CHANNEL_ID.test(String(id || '')) || !NUMERIC_ID.test(String(logoId || ''))) return '';
		return build({ p: 'dispatcharr-channel', i: String(id), k: 'logo', w: 0, t: String(logoId) });
	}

	function vodUrl({ id, kind, logoId } = {}) {
		if (!NUMERIC_ID.test(String(id || '')) || !['movie', 'series', 'episode'].includes(kind)) return '';
		if (!NUMERIC_ID.test(String(logoId || ''))) return '';
		return build({ p: 'dispatcharr-vod', i: String(id), k: kind, w: 0, t: String(logoId) });
	}

	return {
		enabled, privateEnabled, origin: base, privateTtlMs: privateTtl,
		verify, jellyfinUrl, tmdbUrl, tvdbUrl, channelUrl, vodUrl,
		// Tests and the private edge reference use these; they never expose the key.
		decode: decrypt,
		expiresAt: () => Math.ceil(now() / bucket) * bucket + ttl,
		// Observability for the bounded private mint memo. No secret or token.
		mintStats: () => ({ ...mintCounts, entries: mints.size, maxEntries: memoCap, minRemainingMs: memoFloor }),
		clearMints: () => mints.clear(),
	};
}
