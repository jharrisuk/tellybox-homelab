// Provider artwork fallback.
//
// Dispatcharr's logo cache can reject a remote logo (its fetch policy answers
// 404 "Remote image not allowed") even though the provider's own playlist still
// advertises a direct HTTPS logo. This module validates such a URL and fetches
// it with a bounded, negative-cached in-memory store. The browser only ever
// sees Tellybox's own artwork route.

const IMAGE_TYPE = /^image\/(?:png|jpeg|webp|gif)(?:;|$)/i;
const IMAGE_SUFFIX = /\.(?:png|jpe?g|webp|gif)$/i;
const IMAGE_HINT = /(?:^|\/)(?:image|images|logo|logos|icon|icons|artwork|art)(?:[-_.\/]|$)/i;
const CREDENTIAL_KEY = /^(?:token|access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|key|auth|authorization|password|passwd|secret|client[_-]?secret|signature|sig|credential|credentials|session|sessionid|sid|user|username|login|oauth|code)$/i;
const CREDENTIAL_VALUE = /(?:[?&](?:token|access[_-]?token|api[_-]?key|key|auth|password|secret|signature|sig)=)|(?::\/\/[^/\s:@]+:[^/\s@]+@)|(?:\bbearer\s+[a-z0-9._~-]{8,})/i;

const hostSet = hosts => {
	if (hosts instanceof Set) return new Set([...hosts].map(host => String(host).toLowerCase()));
	return new Set(Array.isArray(hosts) ? hosts.map(host => String(host).toLowerCase()) : []);
};

// A logo is eligible for the fallback only when the provider playlist named an
// HTTPS host, the caller derived that host from the playlist, the path looks
// like artwork, and no query string looks like it carries a credential.
export function providerLogoUrl(candidate, hosts) {
	if (typeof candidate !== 'string' || !candidate || candidate.length > 2048) return '';
	let url;
	try { url = new URL(candidate); } catch { return ''; }
	if (url.protocol !== 'https:' || url.username || url.password) return '';
	const allowed = hostSet(hosts);
	if (!url.hostname || !allowed.has(url.hostname.toLowerCase())) return '';
	if (!IMAGE_SUFFIX.test(url.pathname) && !IMAGE_HINT.test(url.pathname)) return '';
	if (url.search) {
		if (url.search.length > 1024) return '';
		for (const [key, value] of url.searchParams) {
			if (CREDENTIAL_KEY.test(key) || CREDENTIAL_VALUE.test(value)) return '';
		}
	}
	url.hash = '';
	return url.href;
}

// Positive entries are kept for a few hours; failures are remembered briefly so
// a dead provider host cannot make every grid request wait for a timeout. The
// store is bounded by both entry count and total bytes.
export function createProviderImageCache({
	fetcher = fetch, clock = Date.now, timeoutMs = 8000,
	maxBytes = 3 * 1024 * 1024, maxEntries = 512, maxTotalBytes = 64 * 1024 * 1024,
	ttlMs = 6 * 3600000, negativeTtlMs = 15 * 60000, concurrency = 4, logger = console,
} = {}) {
	const entries = new Map();
	let totalBytes = 0, active = 0;
	const waiting = [];
	const cancel = response => { try { void response.body?.cancel?.().catch(() => {}); } catch {} };
	// A released slot is handed straight to the next waiter, so a new request
	// arriving in the same tick cannot jump the queue and exceed the limit.
	const release = () => {
		const next = waiting.shift();
		if (next) next();
		else active--;
	};
	const acquire = async () => {
		if (active < concurrency) { active++; return; }
		await new Promise(resolve => waiting.push(resolve));
	};
	const evict = () => {
		while (entries.size > maxEntries || totalBytes > maxTotalBytes) {
			const first = entries.entries().next();
			if (first.done) break;
			const [key, entry] = first.value;
			entries.delete(key);
			totalBytes -= entry.body?.length || 0;
		}
	};
	const remember = (url, entry) => {
		const previous = entries.get(url);
		if (previous) totalBytes -= previous.body?.length || 0;
		entries.delete(url);
		entries.set(url, entry);
		totalBytes += entry.body?.length || 0;
		evict();
	};
	async function load(url) {
		const response = await fetcher(url, {
			redirect: 'error',
			signal: AbortSignal.timeout(timeoutMs),
			headers: { Accept: 'image/png,image/jpeg,image/webp,image/gif' },
		});
		const type = response.headers.get('content-type') || '';
		if (!response.ok || !IMAGE_TYPE.test(type)) { cancel(response); return null; }
		const declared = Number(response.headers.get('content-length'));
		if (Number.isFinite(declared) && declared > maxBytes) { cancel(response); return null; }
		const reader = response.body?.getReader?.();
		if (!reader) return null;
		const chunks = [];
		let size = 0;
		try {
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				size += value.byteLength;
				if (size > maxBytes) { await reader.cancel().catch(() => {}); return null; }
				chunks.push(Buffer.from(value));
			}
		} catch (error) {
			await reader.cancel().catch(() => {});
			throw error;
		}
		if (!size) return null;
		return { body: Buffer.concat(chunks, size), type: type.split(';')[0].trim().toLowerCase() };
	}
	async function get(url) {
		const now = clock();
		const cached = entries.get(url);
		if (cached && cached.until > now) {
			entries.delete(url);
			entries.set(url, cached);
			return cached.body ? { body: cached.body, type: cached.type } : null;
		}
		if (cached) {
			entries.delete(url);
			totalBytes -= cached.body?.length || 0;
		}
		await acquire();
		try {
			const raced = entries.get(url);
			if (raced && raced.until > clock()) {
				entries.delete(url);
				entries.set(url, raced);
				return raced.body ? { body: raced.body, type: raced.type } : null;
			}
			let result = null;
			try { result = await load(url); }
			catch (error) { logger?.error?.('Provider artwork fetch failed:', error?.name || 'Error'); }
			if (result) {
				remember(url, { body: result.body, type: result.type, until: clock() + ttlMs });
				return result;
			}
			remember(url, { body: null, type: '', until: clock() + negativeTtlMs });
			return null;
		} finally {
			release();
		}
	}
	return {
		get,
		clear: () => { entries.clear(); totalBytes = 0; },
		size: () => entries.size,
		bytes: () => totalBytes,
	};
}
