import { readFileSync } from 'node:fs';
import path from 'node:path';

// Verify the public route reaches this running media process, not just any HTTP server.
// Use applied settings: an unsaved or unapplied address must never look operational.
export function relayHealth(directory, { fetcher = fetch, clock = Date.now, localPort = 8082 } = {}) {
	let cached, pending;
	async function probe(network) {
		const result = { origin: network.publicOrigin || '', proxies: network.trustedProxies || [], checkedAt: clock(), state: 'unavailable' };
		try {
			const origin = new URL(result.origin);
			if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) return result;
			const options = { redirect: 'error', signal: AbortSignal.timeout(5000), headers: { 'Cache-Control': 'no-cache' } };
			const responses = await Promise.all([
				fetcher(`http://127.0.0.1:${localPort}/homelab-ready`, options),
				fetcher(new URL('/homelab-ready?check=' + result.checkedAt, origin), options)
			]);
			const values = await Promise.all(responses.map(async response => {
				if (!response.ok) { await response.body?.cancel(); throw Error('Route unavailable'); }
				// A redirect, unrelated website or oversized response is not a health check.
				const reader = response.body.getReader(); let text = '';
				try {
					for (;;) { const { done, value } = await reader.read(); if (done) break; if (text.length + value.length > 1024) throw Error('Unexpected response'); text += new TextDecoder().decode(value); }
				} finally { await reader.cancel(); }
				return JSON.parse(text);
			}));
			const instance = values[0]?.instance;
			result.state = typeof instance === 'string' && /^[a-f0-9-]{36}$/i.test(instance) && values[1]?.instance === instance ? 'operational' : 'different-server';
		} catch { /* Keep failure details private; the UI offers a bounded recheck. */ }
		return result;
	}
	return async () => {
		let network;
		try { network = JSON.parse(readFileSync(path.join(directory, 'applied-configuration.json'), 'utf8')).network || {}; }
		catch { return { state: 'not-configured', origin: '', proxies: [], checkedAt: null }; }
		if (!network.publicOrigin) return { state: 'not-configured', origin: '', proxies: [], checkedAt: null };
		const identity = JSON.stringify([network.publicOrigin, network.trustedProxies]);
		if (cached?.identity === identity && clock() - cached.result.checkedAt < 30000) return cached.result;
		if (pending?.identity === identity) return pending.promise;
		const promise = probe(network).then(result => { cached = { identity, result }; return result; });
		const current = { identity, promise }; pending = current;
		try { return await promise; } finally { if (pending === current) pending = null; }
	};
}
