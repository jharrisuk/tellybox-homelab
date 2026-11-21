/* Release 133: validate the existing installation-owner session.
 *
 * The main app has no owner session of its own. This helper forwards only the
 * existing `tellybox_setup` cookie to a fixed loopback setup endpoint, which
 * performs the real session check. A missing/forged cookie, a LAN caller or an
 * approved viewer bearer is therefore not an administrator. No caller URL,
 * header or body is forwarded.
 */
export function createOwnerSession({ origin, fetchImpl = fetch, timeoutMs = 4000 } = {}) {
	const base = String(origin || '');
	const cookieFor = req => req?.get?.('cookie')?.match(/(?:^|;\s*)tellybox_setup=([a-f0-9]{64})(?:;|$)/)?.[1] || '';
	return async function check(req) {
		const token = cookieFor(req);
		if (!token) return { ok: false, unavailable: false };
		let response;
		try {
			response = await fetchImpl(new URL('/api/setup/session', base), {
				headers: { cookie: 'tellybox_setup=' + token, accept: 'application/json' },
				redirect: 'error',
				signal: AbortSignal.timeout(Math.max(250, Number(timeoutMs) || 4000))
			});
		} catch {
			return { ok: false, unavailable: true };
		}
		try { await response.body?.cancel(); } catch {}
		if (response.status === 401 || response.status === 403) return { ok: false, unavailable: false };
		return { ok: response.ok, unavailable: !response.ok };
	};
}
