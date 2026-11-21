// Fetch the first playable HLS segment so the encoder has actually started.
// This stays on the media server; it sends no video through the internet relay.
//
// Warm-up is enabled by default. Set TELLYBOX_WARMUP=0 (also accepts off,
// false, no, disabled, none) to turn it off server-wide: /api/sessions/:id/prepare
// still answers, but it will not open an upstream request. Playback then starts
// through its own first fetch exactly as it would for an un-warmed session.
const DISABLED = new Set(['0', 'off', 'false', 'no', 'disabled', 'disable', 'none']);

export function warmupEnabled(env = process.env) {
	const value = String(env?.TELLYBOX_WARMUP ?? '').trim().toLowerCase();
	return value === '' || !DISABLED.has(value);
}

async function release(response) {
	try { await response?.body?.cancel(); }
	catch { /* the body is already closed */ }
}

export async function primeStream(resource, { fetchResource, resolve, signal, enabled } = {}) {
	if (enabled === false || (enabled === undefined && !warmupEnabled())) return false;
	if (typeof fetchResource !== 'function') throw new Error('Preparation unavailable');
	let next = resource;
	for (let depth = 0; depth < 4; depth++) {
		if (signal?.aborted) throw signal.reason;
		const response = await fetchResource(next, signal);
		if (!response.ok) { await release(response); throw new Error('Preparation unavailable'); }
		if (response.headers.get('content-type')?.includes('mpegurl') || new URL(next, 'http://media').pathname.endsWith('.m3u8')) {
			let text;
			try { text = await response.text(); }
			catch (error) { await release(response); throw error; }
			const entry = text.split(/\r?\n/).find(line => line.trim() && !line.startsWith('#'));
			if (!entry) throw new Error('No segment ready yet');
			next = resolve(next, entry.trim());
		} else {
			// The segment is only read far enough to prove the encoder output
			// exists; the connection is released before the player takes over so
			// the provider never sees the warm fetch and the playback fetch at
			// the same time.
			const reader = response.body.getReader();
			try { await reader.read(); } finally { await reader.cancel().catch(() => {}); }
			return true;
		}
	}
	throw new Error('Too many playlist levels');
}
