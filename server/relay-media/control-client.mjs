import { randomBytes } from 'node:crypto';
import { controlHeaders, signControl } from './protocol.mjs';

const fail = (message, status = 502, code = 'RELAY_CONTROL') => Object.assign(Error(message), { status, code });
const ROUTES = { prepare: '/internal/worker/prepare', activate: '/internal/worker/activate', replace: '/internal/worker/replace', stop: '/internal/worker/stop' };

export function createRelayControlClient({ worker, mainKey, fetcher = fetch, clock = Date.now, timeoutMs = 8000 } = {}) {
	if (!worker?.controlUrl) throw fail('No approved relay worker is configured.', 409, 'RELAY_WORKER_UNAVAILABLE');
	const base = new URL(worker.controlUrl);
	async function call(action, body, { idempotencyKey = '' } = {}) {
		const route = ROUTES[action];
		if (!route) throw fail('Unknown worker action.', 400);
		const path = route;
		const timestamp = String(clock());
		const nonce = randomBytes(18).toString('base64url');
		const headers = { 'content-type': 'application/json', ...controlHeaders(mainKey.privateKey, { method: 'POST', path, body, now: clock(), nonce }) };
		if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;
		let response;
		try {
			response = await fetcher(new URL(path, base), { method: 'POST', headers, body: JSON.stringify(body), redirect: 'error',
				signal: AbortSignal.timeout(action === 'prepare' || action === 'replace' ? 20000 : timeoutMs) });
		} catch (error) {
			throw fail(error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'The relay worker did not answer in time.' : 'The relay worker is unreachable. Relay playback is unavailable; main media was not used.', 503, 'RELAY_WORKER_UNREACHABLE');
		}
		const text = await response.text();
		let data = {};
		try { data = text ? JSON.parse(text) : {}; } catch { throw fail('The relay worker returned an invalid response.', 502); }
		if (!response.ok) throw fail(typeof data.error === 'string' ? data.error : 'The relay worker refused this playback request.', response.status === 404 || response.status === 409 || response.status === 410 || response.status === 429 ? response.status : 503, data.code || 'RELAY_WORKER_REFUSED');
		if (data.workerId && worker.workerId && data.workerId !== worker.workerId) throw fail('The relay worker identity did not match the approved worker.', 502, 'RELAY_WORKER_IDENTITY');
		return data;
	}
	return {
		prepare: (body, idempotencyKey) => call('prepare', body, { idempotencyKey }),
		activate: (body, idempotencyKey) => call('activate', body, { idempotencyKey }),
		replace: (body, idempotencyKey) => call('replace', body, { idempotencyKey }),
		stop: (body, idempotencyKey) => call('stop', body, { idempotencyKey }),
		verifyControl: request => signControl(mainKey.privateKey, request)
	};
}
