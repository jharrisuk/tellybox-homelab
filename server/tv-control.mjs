import { randomUUID } from 'node:crypto';

// A short-lived mailbox for approved apps at home. It opens no inbound TV port.
export function installTvControl(app, { auth, sessions, now = Date.now }) {
	const televisions = new Map();
	const fresh = tv => now() - tv.seen < 15000 && auth.validOwner(tv.owner) && sessions.get(tv.session)?.owner === tv.owner;
	function prune() { for (const [id, tv] of televisions) if (!fresh(tv)) televisions.delete(id); }
	function permitted(req, res, next) {
		res.set('Cache-Control', 'no-store');
		if (!req.jserverApp || !req.jserverViewer?.deviceId || !auth.isHome(req)) return res.status(403).json({ error: 'TV controls are available to approved apps at home.' });
		next();
	}
	app.use('/api/tv-control', permitted);
	app.get('/api/tv-control', (req, res) => {
		prune();
		res.json({ televisions: [...televisions.values()].map(tv => ({ id: tv.id, name: tv.name, title: tv.title, paused: tv.paused, live: tv.live, position: tv.position, duration: tv.duration })) });
	});
	app.post('/api/tv-control/state', (req, res) => {
		prune();
		const id = req.jserverViewer.deviceId, body = req.body || {}, previous = televisions.get(id);
		if (body.ended === true) {
			if (previous?.session === body.session) televisions.delete(id);
			return res.json({ commands: [] });
		}
		if (typeof body.session !== 'string' || sessions.get(body.session)?.owner !== req.jserverOwner) return res.status(403).json({ error: 'Playback session is not yours.' });
		if (!previous && televisions.size >= 100) return res.status(429).json({ error: 'Too many televisions.' });
		const tv = previous?.session === body.session ? previous : { id, owner: req.jserverOwner, session: body.session, commands: [], lastCommand: -Infinity };
		const seconds = value => Number.isFinite(value) ? Math.min(604800, Math.max(0, value)) : 0;
		Object.assign(tv, { seen: now(), name: String(req.jserverViewer.deviceName || 'Tellybox TV').slice(0, 100), title: String(body.title || 'Now playing').slice(0, 200), paused: body.paused === true, live: body.live === true, position: seconds(body.position), duration: seconds(body.duration) });
		const ack = tv.commands.findIndex(command => command.id === body.ack);
		if (ack >= 0) tv.commands.splice(0, ack + 1);
		televisions.set(id, tv);
		res.json({ commands: tv.commands });
	});
	app.post('/api/tv-control/:id/command', (req, res) => {
		prune();
		const tv = televisions.get(req.params.id), action = req.body?.action;
		if (!tv) return res.status(404).json({ error: 'This TV is no longer playing.' });
		if (!['play', 'pause', 'seekBack', 'seekForward', 'stop'].includes(action) || (tv.live && action.startsWith('seek'))) return res.status(400).json({ error: 'This control is not available.' });
		if (now() - tv.lastCommand < 250 || tv.commands.length >= 8) return res.status(429).json({ error: 'Please wait a moment.' });
		tv.lastCommand = now();
		tv.commands.push({ id: randomUUID(), action });
		res.json({ accepted: true });
	});
}
