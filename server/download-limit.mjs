// Identity comes only from authenticated server middleware, never request parameters.
export function downloadOwner(req) {
	const viewer = req.jserverViewer || {};
	if (viewer.personId) return `person:${viewer.personId}`;
	if (viewer.deviceId) return `device:${viewer.deviceId}`;
	if (viewer.browserId) return `browser:${viewer.browserId}`;
	if (req.jserverOwner && req.jserverOwner !== 'local' && !req.jserverOwner.startsWith('home:')) return `owner:${req.jserverOwner}`;
	return `local-ip:${viewer.ip || req.socket?.remoteAddress || 'unknown'}`;
}

export function createDownloadLimit({ clock = Date.now, idleMs = 90000 } = {}) {
	const entries = new Map();
	function current(key) {
		const entry = entries.get(key);
		if (entry && !entry.active && entry.expires <= clock()) { entries.delete(key); return null; }
		return entry;
	}
	function check(key, id) {
		const entry = current(key);
		if (entry && entry.id !== id) throw Object.assign(new Error('You already have a download in progress. Finish or cancel it before starting another.'), { status: 409, code: 'DOWNLOAD_IN_PROGRESS' });
	}
	function enter(key, id) {
		check(key, id);
		const entry = current(key) || { id, active: 0, expires: 0 };
		entries.set(key, entry); entry.active++;
		let ended = false;
		return (retain = false) => {
			if (ended) return; ended = true;
			entry.active--;
			if (entries.get(key) !== entry) return;
			if (!entry.active && !retain) entries.delete(key);
			else entry.expires = clock() + idleMs;
		};
	}
	function release(key, id) { if (entries.get(key)?.id === id) entries.delete(key); }
	const cleanup = setInterval(() => { for (const key of entries.keys()) current(key); }, idleMs);
	cleanup.unref();
	return { check, enter, release };
}
