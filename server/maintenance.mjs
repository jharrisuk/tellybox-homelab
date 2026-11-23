import fs from 'node:fs';
import path from 'node:path';

/**
 * Maintenance mode.
 *
 * One small JSON file is the switch. The middleware is registered after the
 * auth gate so an administrator can always get back in and turn it off; the
 * CLI can flip the file when the server itself is unhealthy.
 *
 * Scope: "local" means requests the installation classifies as local or home;
 * "remote" means everything else; "both" means everyone.
 */
export const MAINTENANCE_MESSAGE = 'Tellybox is down for maintenance. It will be back shortly.';
const SCOPES = new Set(['local', 'remote', 'both']);

// Assets the maintenance page itself needs. They must stay reachable while the
// rest of the site is refused, otherwise the page renders unstyled or without
// its logo.
const PAGE_ASSETS = new Set([
	'/style.css', '/tellybox-logo.png', '/tellybox-wordmark.png', '/tellybox-logo.webp', '/tellybox-mark.svg',
	'/icon.svg', '/asset-fallback.js'
]);
const ALWAYS_OPEN = new Set([
	'/api/maintenance', '/api/auth/status', '/api/version', '/health', '/login', '/settings'
]);

function normalise(value) {
	const scope = SCOPES.has(value?.scope) ? value.scope : 'both';
	return {
		enabled: value?.enabled === true,
		scope,
		updatedAt: Number.isFinite(Number(value?.updatedAt)) ? Number(value.updatedAt) : 0,
		updatedBy: typeof value?.updatedBy === 'string' ? value.updatedBy.slice(0, 120) : '',
	};
}

function page() {
	// The shipped CSP forbids inline styles, so the page reuses the site
	// stylesheet and a small set of classes appended to style.css.
	return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Maintenance - Tellybox</title><link rel="stylesheet" href="/style.css"></head><body class="maintenance-page"><main><img class="maintenance-mark" src="/tellybox-wordmark.png" alt="Tellybox"><h1>Tellybox is down for maintenance</h1><p>It will be back shortly.</p><a class="button primary" href="/">Try again</a></main></body></html>`;
}

export function createMaintenance({ directory, clock = Date.now } = {}) {
	const file = path.join(directory, 'maintenance.json');
	let cache = null;

	function read() {
		try {
			const stat = fs.statSync(file);
			if (cache && cache.mtimeMs === stat.mtimeMs) return cache.value;
			const value = normalise(JSON.parse(fs.readFileSync(file, 'utf8')));
			cache = { mtimeMs: stat.mtimeMs, value };
			return value;
		} catch {
			// Missing or corrupt state is "off", never "on": a broken file must not
			// silently take the installation offline.
			cache = null;
			return normalise(null);
		}
	}

	function write(next, by = '') {
		const value = normalise({ ...next, updatedAt: clock(), updatedBy: by });
		fs.mkdirSync(directory, { recursive: true });
		const tmp = file + '.tmp';
		fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
		fs.renameSync(tmp, file);
		cache = null;
		return value;
	}

	function enabledFor(kind) {
		const state = read();
		if (!state.enabled) return false;
		return state.scope === 'both' || state.scope === kind;
	}

	function respond(req, res, state) {
		res.setHeader('Retry-After', '120');
		res.setHeader('Cache-Control', 'no-store');
		const wantsHtml = String(req.headers.accept || '').includes('text/html');
		if (wantsHtml) {
			res.status(503).type('html').send(page());
			return;
		}
		res.status(503).json({ maintenance: true, code: 'MAINTENANCE', message: MAINTENANCE_MESSAGE, scope: state.scope });
	}

	function middleware({ classify, admin }) {
		return function maintenanceGate(req, res, next) {
			const state = read();
			if (!state.enabled) return next();
			if (ALWAYS_OPEN.has(req.path) || PAGE_ASSETS.has(req.path)) return next();
			if (typeof admin === 'function' && admin(req) === true) return next();
			const kind = classify(req) === 'local' ? 'local' : 'remote';
			if (!(state.scope === 'both' || state.scope === kind)) return next();
			return respond(req, res, state);
		};
	}

	return { read, write, enabledFor, middleware, message: MAINTENANCE_MESSAGE };
}
