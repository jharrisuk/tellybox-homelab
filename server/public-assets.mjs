import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * Public static asset CDN scope.
 *
 * All non-JavaScript static files with an immutable content hash are eligible:
 * stylesheets, branding and future font or image files. JavaScript remains on
 * the origin because its defer order and boot sequence cannot be recovered
 * safely with a per-tag fallback. HTML, APIs, personalised JSON, artwork
 * responses and all media stay on the origin or use the separate signed artwork
 * route.
 */
export const PUBLIC_CDN_ASSETS = Object.freeze([
	'style.css',
	'coming-soon.css',
	'discover.css',
	'search.css',
	'share-player.css',
	'home-124.css',
	'qbittorrent.css',
	'icon.svg',
	'tellybox-logo.png',
	'tellybox-wordmark.png',
	'tellybox-logo.webp',
	'tellybox-mark.svg',
	'tmdb-logo.svg'
]);

/** Extensions that the static packager may publish. */
export const PUBLIC_CDN_EXTENSIONS = Object.freeze([
	'.css', '.svg', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.woff', '.woff2', '.ttf', '.otf'
]);

export function normalizePublicAssetOrigin(value = '') {
	if (!value) return '';
	try {
		const url = new URL(String(value));
		if (url.protocol !== 'https:') return '';
		if (url.username || url.password || url.search || url.hash) return '';
		if (url.pathname !== '/') return '';
		if (/^(169\.254\.|0\.|metadata\.|metadata$|\[?fe80:)/i.test(url.hostname)) return '';
		return url.origin;
	} catch {
		return '';
	}
}

export function createPublicAssetCdn({
	directory, origin = '', verify = false, fetchImpl = globalThis.fetch,
	probeTimeoutMs = 2500, recheckMs = 15 * 60 * 1000, autoProbe = true,
} = {}) {
	const base = normalizePublicAssetOrigin(origin);
	const enabled = Boolean(base && directory);
	const assets = new Map();
	const versions = new Map();
	const cache = new Map();
	// A hashed URL is only usable once the CDN can actually serve it. Rewriting
	// first and discovering the 404 in the browser is what produced the unstyled
	// flash on every remote navigation: the stylesheet was pointed at a CDN path
	// that did not exist yet, so paint waited for a failed request and a fallback.
	// When `verify` is on, nothing is rewritten until a probe proves the file is
	// there. Tests and callers that predate the probe keep the old behaviour.
	const trusted = verify ? new Set() : null;
	if (enabled) {
		for (const name of PUBLIC_CDN_ASSETS) {
			const file = path.join(directory, name);
			if (!existsSync(file) || !statSync(file).isFile()) continue;
			const hash = createHash('sha256').update(readFileSync(file)).digest('hex').slice(0, 12);
			versions.set(name, hash);
			assets.set(name, `${base}/tellybox/${hash}/${name}`);
		}
	}
	const expectedType = name => name.endsWith('.css') ? /^text\/css(?:;|$)/i
		: /^image\//i;
	async function reachable(url, name) {
		const signal = AbortSignal.timeout(probeTimeoutMs);
		// Never follow a redirect: the CDN is operator-configured, but a probe must
		// not be steerable at another origin. A redirect is simply "not available".
		const head = await fetchImpl(url, { method: 'HEAD', signal, redirect: 'manual' });
		if (head.ok) {
			const type = head.headers?.get?.('content-type') || '';
			return Boolean(type) && expectedType(name).test(type);
		}
		// Some object stores refuse HEAD; a one-byte ranged GET proves the same fact.
		if (head.status === 405 || head.status === 501) {
			const ranged = await fetchImpl(url, { method: 'GET', headers: { Range: 'bytes=0-0' }, signal: AbortSignal.timeout(probeTimeoutMs), redirect: 'manual' });
			try {
				if (!ranged.ok) return false;
				const type = ranged.headers?.get?.('content-type') || '';
				return Boolean(type) && expectedType(name).test(type);
			} finally {
				// The body is never read; release the connection instead of leaking it.
				try { await ranged.body?.cancel?.(); } catch { /* already closed */ }
			}
		}
		return false;
	}
	let probePromise = null;
	function probe() {
		if (!enabled || !trusted || probePromise) return probePromise || Promise.resolve();
		probePromise = (async () => {
			let changed = false;
			for (const [name, url] of assets) {
				let ok = false;
				try { ok = await reachable(url, name); } catch { ok = false; }
				const had = trusted.has(name);
				if (ok && !had) { trusted.add(name); changed = true; }
				if (!ok && had) { trusted.delete(name); changed = true; }
			}
			if (changed) cache.clear();
			return trusted;
		})().finally(() => { probePromise = null; });
		return probePromise;
	}
	if (enabled && verify) {
		if (autoProbe) void probe();
		if (recheckMs > 0) {
			const timer = setInterval(() => { void probe(); }, recheckMs);
			if (typeof timer.unref === 'function') timer.unref();
		}
	}
	function rewrite(text, { local = false } = {}) {
		if (!enabled || !assets.size || local) return String(text || '');
		let output = String(text || ''), changed = 0;
		for (const [name, url] of assets) {
			if (trusted && !trusted.has(name)) continue;
			const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
			const pattern = new RegExp(`(href|src)="/?${escaped}"`, 'g');
			output = output.replace(pattern, (_, attribute) => {
				changed++;
				return `${attribute}="${url}" data-tellybox-local="/${name}"`;
			});
		}
		if (!changed || output.includes('/asset-fallback.js')) return output;
		const fallback = '<script src="/asset-fallback.js"></script>';
		return /<head(?:\s[^>]*)?>/i.test(output)
			? output.replace(/<head(?:\s[^>]*)?>/i, match => match + fallback)
			: fallback + output;
	}
	/** Wrap res.sendFile for public HTML pages without changing route/auth logic. */
	function middleware({ isLocal = () => false } = {}) {
		if (!enabled) return (req, res, next) => next();
		const root = path.resolve(directory) + path.sep;
		return (req, res, next) => {
			const original = res.sendFile.bind(res);
			res.sendFile = (file, options, callback) => {
				if (typeof options === 'function') { callback = options; options = undefined; }
				let resolved;
				try { resolved = path.resolve(String(file)); } catch { return original(file, options, callback); }
				if (!resolved.startsWith(root) || !resolved.toLowerCase().endsWith('.html')) return original(file, options, callback);
				if (isLocal(req)) return original(file, options, callback);
				try {
					if (!cache.has(resolved)) cache.set(resolved, rewrite(readFileSync(resolved, 'utf8')));
					if (options?.headers) for (const [key, value] of Object.entries(options.headers)) res.setHeader(key, value);
					res.type('html');
					return res.send(cache.get(resolved));
				} catch {
					return original(file, options, callback);
				}
			};
			next();
		};
	}
	/** Serve static HTML pages through the same rewriter. Install immediately before express.static. */
	function page({ isLocal = () => false } = {}) {
		if (!enabled) return (req, res, next) => next();
		const root = path.resolve(directory);
		return (req, res, next) => {
			if (!['GET', 'HEAD'].includes(req.method)) return next();
			const name = req.path === '/' ? 'index.html' : String(req.path || '').replace(/^\/+/, '');
			if (!name.toLowerCase().endsWith('.html')) return next();
			const resolved = path.resolve(root, name);
			if (!resolved.startsWith(root + path.sep) || !existsSync(resolved)) return next();
			if (isLocal(req)) return next();
			return res.sendFile(resolved);
		};
	}
	return { enabled, origin: base, assets, versions, trusted, probe, rewrite, middleware, page };
}
