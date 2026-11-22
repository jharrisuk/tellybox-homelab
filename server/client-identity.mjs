/* Explicit client identity for display and Activity attribution.
 *
 * The Android apps advertise a validated client kind and the app marker on every
 * request. An app declaration is honoured only when the request proves both
 * authentication (a session cookie or an app bearer, checked by the caller) and
 * same-origin delivery. A bearer token alone is not proof of an app: browser
 * bearer requests stay web. Older installations have no header, so a narrow
 * user-agent fallback recognises only real legacy app markers. web is the
 * default for everything else, and an unrecognised app request is unknown
 * rather than assumed to be a phone.
 *
 * This value is presentation metadata only. It never grants local access,
 * approves an app, chooses a role or replaces a person identity. A client can
 * choose a different display label; it cannot change authorization.
 */
export const CLIENT_TYPES = Object.freeze(['android-tv', 'android-phone', 'web', 'unknown']);
const APP_TYPES = new Set(['android-tv', 'android-phone']);
const ALIASES = new Map([
	['android-tv', 'android-tv'],
	['androidtv', 'android-tv'],
	['android tv', 'android-tv'],
	['android-phone', 'android-phone'],
	['android-phone-tablet', 'android-phone'],
	['android', 'android-phone'],
	['web', 'web']
]);
// BeyondTV and Android TV renderers are the known shipping legacy TV clients.
const TV_AGENT = /beyond\s*tv|android\s*tv|androidtv|google\s*tv|googletv/i;
// A legacy app request is a native HTTP client, not a browser rendering engine.
const APP_AGENT = /(?:^|[\s(])(?:dalvik|okhttp|tellybox)\//i;

export function normalizeClient(value) {
	if (typeof value !== 'string') return '';
	return ALIASES.get(value.trim().toLowerCase()) || '';
}

/* The device platform the app already declares via X-Tellybox-Client, mapped to
 * the allowance platforms. Presentation and allowance metadata only: it never
 * authenticates, approves or chooses a role. Empty when the client reports
 * nothing recognisable, so callers can fall back to an explicit choice. */
export function platformOf(req) {
	const declared = normalizeClient(req?.get?.('x-tellybox-client'));
	if (declared === 'android-tv') return 'tv';
	if (declared === 'android-phone') return 'phone';
	return '';
}

export function legacyClient(userAgent) {
	const agent = String(userAgent || '');
	if (TV_AGENT.test(agent)) return 'android-tv';
	if (APP_AGENT.test(agent)) return 'android-phone';
	return 'unknown';
}

/* Diagnosis only: whether the app marker was supplied and which validated
 * client kind the request declared. Never a raw header or a credential. */
export function appMarkers(req) {
	const app = Boolean(req?.get?.('x-jserver-app'));
	const declared = normalizeClient(req?.get?.('x-tellybox-client'));
	return { app, ...(declared ? { declared } : {}) };
}

function hostOf(value) {
	if (typeof value !== 'string' || !value.trim()) return null;
	const text = value.trim().toLowerCase();
	if (text === 'null') return null;
	try {
		const url = new URL(text.includes('://') ? text : 'http://' + text);
		return { hostname: url.hostname.replace(/^\[|\]$/g, ''), port: url.port };
	} catch { return null; }
}

/* A native app usually sends no Origin at all. If a browser supplies one, it
 * must match the host this request was sent to; a cross-site page can therefore
 * never borrow the app label by adding headers to its own request. */
function sameOrigin(req, origins = []) {
	const sources = [req?.get?.('origin'), req?.get?.('referer')].filter(Boolean);
	if (!sources.length) return true;
	const own = hostOf(req?.get?.('host'));
	if (!own) return false;
	for (const source of sources) {
		// A configured public origin is trusted exactly, or as the start of a
		// Referer path when a tunnel keeps a different internal Host.
		if (origins.some(value => value && (source === value || source.startsWith(value + '/')))) continue;
		const target = hostOf(source);
		if (!target || target.hostname !== own.hostname) return false;
		if (target.port && own.port && target.port !== own.port) return false;
	}
	return true;
}

export function clientOf(req, options = {}) {
	const authenticated = options?.authenticated === true;
	const markers = appMarkers(req);
	if (markers.app) {
		const trusted = authenticated && sameOrigin(req, options?.origins);
		// A declared app that cannot prove authentication or same-origin delivery
		// is a web request, not a weaker app. Its user agent cannot upgrade it.
		if (!trusted) return 'web';
		if (APP_TYPES.has(markers.declared)) return markers.declared;
		// The app marker was trusted but the declaration was absent or invalid:
		// keep the narrow legacy fallback rather than inventing a phone.
		return legacyClient(req?.get?.('user-agent'));
	}
	// No marker: only a real legacy app/TV user agent is recognised. Everything
	// else, including a browser, is web.
	const legacy = legacyClient(req?.get?.('user-agent'));
	return legacy === 'unknown' ? 'web' : legacy;
}
