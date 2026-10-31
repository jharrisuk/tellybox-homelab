// Fetch the first playable HLS segment so the encoder has actually started.
// This stays on the media server; it sends no video through the internet relay.
export async function primeStream(resource, { fetchResource, resolve, signal }) {
	let next = resource;
	for (let depth = 0; depth < 4; depth++) {
		if (signal?.aborted) throw signal.reason;
		const response = await fetchResource(next, signal);
		if (!response.ok) { await response.body?.cancel(); throw new Error('Preparation unavailable'); }
		if (response.headers.get('content-type')?.includes('mpegurl') || new URL(next, 'http://media').pathname.endsWith('.m3u8')) {
			const text = await response.text();
			const entry = text.split(/\r?\n/).find(line => line.trim() && !line.startsWith('#'));
			if (!entry) throw new Error('No segment ready yet');
			next = resolve(next, entry.trim());
		} else {
			const reader = response.body.getReader();
			try { await reader.read(); } finally { await reader.cancel(); }
			return;
		}
	}
	throw new Error('Too many playlist levels');
}
