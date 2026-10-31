export async function remoteAccessStatus(publicOrigin = '', metricsUrl = 'http://quick-tunnel:2000') {
	if (!publicOrigin) return { ...await tunnelStatus(metricsUrl), temporary: true };
	const address = new URL(publicOrigin);
	if (address.protocol !== 'https:' || address.username || address.password) throw new Error('Remote address must use HTTPS');
	let connected = false;
	try {
		const response = await fetch(new URL('/health', address), { signal: AbortSignal.timeout(3000), redirect: 'error' });
		connected = response.ok && (await response.json()).ok === true;
	} catch { /* Keep the stable address visible while the relay reconnects. */ }
	return { url: address.origin, connected, temporary: false };
}

export async function tunnelStatus(metricsUrl = 'http://quick-tunnel:2000') {
	try {
		const [details, readiness] = await Promise.all([
			fetch(new URL('/quicktunnel', metricsUrl), { signal: AbortSignal.timeout(3000), redirect: 'error' }),
			fetch(new URL('/ready', metricsUrl), { signal: AbortSignal.timeout(3000), redirect: 'error' })
		]);
		const connected = readiness.ok;
		await readiness.body?.cancel();
		if (!details.ok) { await details.body?.cancel(); throw new Error('Tunnel status unavailable'); }
		const { hostname } = await details.json();
		// Only turn the connector's expected hostname into a clickable public URL.
		if (typeof hostname !== 'string' || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.trycloudflare\.com$/.test(hostname)) throw new Error('No temporary hostname');
		return { url: `https://${hostname}`, connected };
	} catch {
		// Do not retain an old URL: the connector may be down or creating a replacement.
		return { url: null, connected: false };
	}
}
