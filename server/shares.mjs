import { randomBytes, createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import path from 'node:path';

const hash = value => createHash('sha256').update(value).digest('hex');
const lifetime = 24 * 60 * 60 * 1000;

export function createShares(directory, { now = Date.now, onRevoke = () => {} } = {}) {
	const file = path.join(directory, 'shares.json');
	let entries = {};
	try { entries = JSON.parse(readFileSync(file, 'utf8')); }
	catch (error) { if (error.code !== 'ENOENT') throw error; }
	function save() {
		entries = Object.fromEntries(Object.entries(entries).filter(([, entry]) => entry.expires > now()));
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		writeFileSync(file + '.tmp', JSON.stringify(entries), { mode: 0o600 });
		renameSync(file + '.tmp', file);
	}
	function validOwner(owner) {
		return owner?.startsWith('share:') && entries[owner.slice(6)]?.expires > now();
	}
	return {
		validOwner,
		resolve(token) {
			if (!/^[a-f0-9]{64}$/.test(token || '')) return null;
			const key = hash(token);
			return validOwner('share:' + key) ? { ...entries[key], owner: 'share:' + key } : null;
		},
		create(item, creator, hours = 24) {
			if (![24, 72, 168, 720].includes(hours)) throw Object.assign(new Error('Choose 1, 3, 7 or 30 days.'), { status: 400 });
			save();
			if (Object.keys(entries).length >= 500) throw Object.assign(new Error('Stop an existing share before creating another.'), { status: 429 });
			if (!['Movie', 'Episode', 'Series', 'TvChannel'].includes(item.Type) || item.IsVirtualItem) throw Object.assign(new Error('Choose an available film, episode, series or TV channel.'), { status: 400 });
			if (item.Type === 'TvChannel' && hours !== 24) throw Object.assign(new Error('TV channel links last 24 hours.'), { status: 400 });
			const token = randomBytes(32).toString('hex');
			const entry = { id: randomUUID(), itemId: item.Id, type: item.Type, title: item.SeriesName ? `${item.SeriesName} · ${item.Name}` : item.Name,
				overview: item.Overview || '', creator, created: now(), expires: now() + hours * 60 * 60 * 1000 };
			entries[hash(token)] = entry;
			save();
			return { token, ...entry };
		},
		list(itemId) {
			return Object.values(entries).filter(entry => entry.itemId === itemId && entry.expires > now())
				.map(({ id, title, created, expires }) => ({ id, title, created, expires }));
		},
		revoke(id) {
			const key = Object.keys(entries).find(key => entries[key].id === id);
			if (!key) return false;
			delete entries[key];
			save();
			onRevoke('share:' + key);
			return true;
		}
	};
}

export function installPublicShares(app, options) {
	const { shares, publicDirectory, hlsFile, playback, stream, session, identity } = options;
	const preparing = new Set();
	for (const name of ['share-player.js', 'share-player.css']) app.get('/' + name, (req, res) => res.sendFile(path.join(publicDirectory, name)));
	app.get('/share-hls.js', (req, res) => res.sendFile(hlsFile));
	app.use('/share/:token', (req, res, next) => {
		res.set('Cache-Control', 'no-store');
		res.set('Referrer-Policy', 'no-referrer');
		res.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
		const share = shares.resolve(req.params.token);
		if (!share) return res.status(410).type('html').send('<!doctype html><meta name="viewport" content="width=device-width"><title>Link unavailable · Tellybox</title><link rel="stylesheet" href="/share-player.css"><main><p class="brand">Tellybox</p><h1>This link is no longer available</h1><p>It may have expired or been stopped by the person who shared it. Ask them for a new link.</p></main>');
		if (req.method === 'POST' && (!req.is('application/json') || !options.sameOrigin(req))) return res.sendStatus(403);
		req.jserverShare = share;
		req.jserverShareToken = req.params.token;
		req.jserverOwner = share.owner;
		req.jserverViewer = { ...identity(req), shareId: share.id, browser: 'Shared link · ' + (req.get('user-agent') || 'Browser').slice(0, 200) };
		// End an in-flight direct stream too, rather than waiting for the next segment request.
		const expiry = setTimeout(() => res.destroy(), Math.max(1, share.expires - Date.now())).unref();
		res.on('close', () => clearTimeout(expiry));
		next();
	});
	app.get('/share/:token', (req, res) => res.sendFile(path.join(publicDirectory, 'share-player.html')));
	app.get('/share/:token/info', (req, res) => {
		const { title, overview, expires, type } = req.jserverShare;
		res.json({ title, overview, expires, type: type || 'Movie' });
	});
	app.get('/share/:token/episodes', async (req, res) => {
		if (req.jserverShare.type !== 'Series') return res.sendStatus(404);
		res.json({ items: await options.seriesEpisodes(req.jserverShare.itemId) });
	});
	app.post('/share/:token/play', async (req, res, next) => {
		if (preparing.has(req.jserverOwner)) return res.status(429).json({ error: 'This video is already being prepared. Please try again in a moment.' });
		// The URL capability chooses the item; a caller-supplied ID is never trusted.
		if (req.jserverShare.type === 'Series') {
			const item = await options.sharedItem(req.body.id);
			if (item.Type !== 'Episode' || item.SeriesId !== req.jserverShare.itemId || item.IsVirtualItem) return res.sendStatus(404);
			req.body.id = item.Id;
		} else req.body.id = req.jserverShare.itemId;
		preparing.add(req.jserverOwner);
		try { return await playback(req, res, next); }
		finally { preparing.delete(req.jserverOwner); }
	});
	app.get('/share/:token/stream/:session/:resource', stream);
	app.post('/share/:token/session/:id', session);
	// Unknown subpaths must never fall through to the normal authenticated site.
	app.use('/share/:token', (req, res) => res.sendStatus(404));
}
