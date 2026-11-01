import { once } from 'node:events';

const cancelled = reason => reason || Object.assign(Error('Image request closed.'), { name: 'AbortError' });

// Copy an image body without leaving a rejected web stream unobserved. A fetch
// timeout can reject the body after headers have gone; report that once and settle
// the response instead of letting an unhandled Readable error end the process.
export async function sendImageBody(body, res, { signal, maxBytes = 5 * 1024 * 1024, label = 'Image', logger = console } = {}) {
	if (!body) { if (!res.writableEnded) res.end(); return; }
	const reader = body.getReader();
	let finished = false, aborted = false;
	const onAbort = () => { aborted = true; void reader.cancel(cancelled(signal?.reason)).catch(() => {}); };
	if (signal?.aborted) onAbort();
	else signal?.addEventListener('abort', onAbort, { once: true });
	try {
		let total = 0;
		for (;;) {
			if (aborted) break;
			const { done, value } = await reader.read();
			if (done) { finished = true; break; }
			total += value.byteLength;
			if (total > maxBytes) throw Object.assign(Error('Image is too large.'), { status: 413 });
			if (!res.write(Buffer.from(value))) {
				await Promise.race([once(res, 'drain'), once(res, 'close')]);
				if (res.destroyed) { aborted = true; break; }
			}
		}
		if (aborted) {
			if (!res.destroyed && !res.writableEnded) {
				if (!res.headersSent) res.status(504).json({ error: 'The image request timed out.' });
				else res.destroy();
			}
			if (signal?.reason?.name === 'TimeoutError') logger?.error?.(`${label} proxy timed out:`, signal.reason.name);
			return;
		}
		if (!res.writableEnded) res.end();
	} catch (error) {
		const timedOut = error?.name === 'TimeoutError' || signal?.reason?.name === 'TimeoutError';
		const status = error?.status || (timedOut || signal?.aborted ? 504 : 502);
		if (!res.destroyed && !res.writableEnded) {
			if (!res.headersSent) res.status(status).json({ error: status === 413 ? 'Image is too large.' : status === 504 ? 'The image request timed out.' : 'The image could not be loaded.' });
			else res.destroy();
		}
		// Client disconnects are normal; real body failures must still be visible.
		if (!signal?.aborted || timedOut) logger?.error?.(`${label} proxy failed:`, error?.name || 'Error');
	} finally {
		signal?.removeEventListener('abort', onAbort);
		if (!finished) await reader.cancel().catch(() => {});
	}
}

// Shared route for the artwork endpoints. Validation stays with each caller so
// only a permitted image type and size reaches the response.
export async function proxyImage(res, {
	url, headers = {}, maxBytes = 5 * 1024 * 1024, timeoutMs = 15000, cache = 'private, no-store',
	allow = /^image\//i, notFound = 404, label = 'Image', logger = console, fetchImpl = fetch, fallbackType = '',
} = {}) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(Object.assign(Error('Image request timed out.'), { name: 'TimeoutError' })), timeoutMs);
	const close = () => controller.abort(Object.assign(Error('Image request closed.'), { name: 'AbortError' }));
	res.on?.('close', close);
	try {
		const response = await fetchImpl(url, { redirect: 'error', signal: controller.signal, headers });
		const type = response.headers.get('content-type') || fallbackType;
		if (!response.ok || !allow.test(type)) {
			await response.body?.cancel().catch(() => {});
			return res.sendStatus(notFound);
		}
		const length = Number(response.headers.get('content-length'));
		if (Number.isFinite(length) && length > maxBytes) {
			await response.body?.cancel().catch(() => {});
			return res.status(413).json({ error: 'Image is too large.' });
		}
		res.set('Cache-Control', cache).type(type);
		await sendImageBody(response.body, res, { signal: controller.signal, maxBytes, label, logger });
	} catch (error) {
		if (res.destroyed || res.writableEnded) return;
		const timedOut = error?.name === 'TimeoutError' || controller.signal.reason?.name === 'TimeoutError';
		logger?.error?.(`${label} request failed:`, error?.name || 'Error');
		if (!res.headersSent) res.status(timedOut ? 504 : 502).json({ error: timedOut ? 'The image request timed out.' : 'The image could not be loaded.' });
		else res.destroy();
	} finally {
		clearTimeout(timer);
		res.off?.('close', close);
	}
}
