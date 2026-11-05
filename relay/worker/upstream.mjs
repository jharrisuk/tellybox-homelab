const fail = (message, status = 502) => Object.assign(Error(message), { status });

/** Scoped Dispatcharr client for the worker. Fixed origin, worker credential, no main modules. */
export function createWorkerUpstream({ origin, key = '', fetcher = fetch }) {
	let base;
	try { base = new URL(origin); } catch { throw Error('Worker Dispatcharr address is invalid.'); }
	if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash || base.pathname !== '/') throw Error('Worker Dispatcharr address must be an origin without credentials or a path.');
	const headers = () => key ? { 'X-API-Key': key, Authorization: 'ApiKey ' + key } : {};
	async function request(route, options = {}) {
		const url = new URL(route, base);
		if (url.origin !== base.origin) throw fail('Invalid worker upstream request.', 400);
		const response = await fetcher(url, { ...options, redirect: 'error', signal: options.signal || AbortSignal.timeout(30000) });
		if (!response.ok) {
			await response.body?.cancel().catch(() => {});
			throw fail(response.status === 401 || response.status === 403 ? 'The worker Dispatcharr credential was refused.' : 'Dispatcharr is unavailable to the relay worker.', response.status === 401 || response.status === 403 ? 503 : 502);
		}
		return response;
	}
	async function stream(source, { range, signal, client = 'Tellybox-Relay' } = {}) {
		if (!['movie', 'episode'].includes(source.type) || !/^[a-f0-9-]{36}$/i.test(source.uuid)) throw fail('Invalid streamed title.', 400);
		const prefix = `/proxy/vod/${source.type}/${source.uuid}`;
		let url = new URL(prefix + (/^[a-f0-9]{48}$/.test(source.session || '') ? '/' + source.session : ''), base);
		if (Number.isSafeInteger(source.account)) url.searchParams.set('m3u_account_id', String(source.account));
		if (/^\d+$/.test(String(source.streamId || ''))) url.searchParams.set('stream_id', String(source.streamId));
		for (let hop = 0; hop < 4; hop++) {
			const response = await fetcher(url, { headers: { ...headers(), 'User-Agent': client, ...(range ? { Range: range } : {}) }, redirect: 'manual', signal });
			if ([301, 302, 303, 307, 308].includes(response.status)) {
				const target = new URL(response.headers.get('location') || '', url);
				await response.body?.cancel();
				if (target.origin !== base.origin || !(target.pathname === prefix || target.pathname.startsWith(prefix + '/'))) throw fail('Dispatcharr must proxy VOD rather than redirect to a provider.');
				url = target; continue;
			}
			return response;
		}
		throw fail('Dispatcharr redirected this stream too many times.');
	}
	async function stopStream(session) {
		if (!/^[a-f0-9]{48}$/.test(session || '')) return;
		try { await (await request('/proxy/vod/stop_client/', { method: 'POST', headers: { ...headers(), 'Content-Type': 'application/json' }, body: JSON.stringify({ client_id: session }) })).body?.cancel(); } catch {}
	}
	async function recordingFile(id, { range, signal } = {}) {
		if (!Number.isSafeInteger(id) || id <= 0) throw fail('Invalid recording.', 400);
		return fetcher(new URL(`/api/channels/recordings/${id}/file/`, base), { headers: { ...headers(), ...(range ? { Range: range } : {}) }, redirect: 'error', signal });
	}
	async function catchupSession(channel, start, duration) {
		const response = await request('/api/catchup/sessions/', { method: 'POST', headers: { ...headers(), 'Content-Type': 'application/json' }, body: JSON.stringify({ channel_uuid: channel, start, duration }) });
		const data = await response.json(), url = new URL(data.playback_url, base);
		if (url.origin !== base.origin || url.pathname !== '/proxy/catchup/' + channel || !data.session_id) throw fail('Dispatcharr returned an invalid catch-up session.');
		return { open: signal => fetcher(url, { redirect: 'error', signal, headers: headers() }),
			stop: async () => { try { await (await request('/api/catchup/sessions/' + encodeURIComponent(data.session_id) + '/', { method: 'DELETE', headers: headers() })).body?.cancel(); } catch {} } };
	}
	async function liveStream(channelId, { signal } = {}) {
		if (!/^[a-f0-9-]{36}$/i.test(channelId)) throw fail('Invalid channel.', 400);
		return request('/proxy/ts/stream/' + channelId, { signal, headers: { ...headers() } });
	}
	async function health(signal) {
		const response = await request('/output/m3u', { signal: signal || AbortSignal.timeout(5000) });
		await response.body?.cancel();
		return true;
	}
	return { origin: base.origin, stream, stopStream, recordingFile, catchupSession, liveStream, health, fetcher: (url, options) => fetcher(url, { ...options, headers: { ...headers(), ...(options?.headers || {}) } }) };
}
