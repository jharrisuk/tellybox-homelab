import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

const nameOK = value => typeof value === 'string' && value.trim().length >= 2 && value.length <= 80 && !/[\x00-\x1f]/.test(value);
const idOK = value => typeof value === 'string' && /^[A-Za-z0-9:_.-]{1,180}$/.test(value) && !Object.hasOwn(Object.prototype, value);
const profileOK = (state, id) => typeof id === 'string' && /^[a-f0-9]{32}$/.test(id) && Object.hasOwn(state.profiles, id);

export function favouriteTitle(item) {
	if (!['Episode', 'Season'].includes(item?.Type) || typeof item.SeriesId !== 'string'
		|| !/^[A-Za-z0-9:_.-]{1,180}$/.test(item.SeriesId) || Object.hasOwn(Object.prototype, item.SeriesId)
		|| typeof item.SeriesName !== 'string' || !item.SeriesName.trim()) return item;
	const id = item.SeriesId, vod = /^dispatch-series-([1-9][0-9]*)$/.exec(id);
	return { Id: id, Name: item.SeriesName.trim(), Type: 'Series',
		...(item.Source ? { Source: item.Source } : {}),
		Artwork: vod ? '/api/web/art/series/' + vod[1] : '/images/' + id + '/Primary?width=400' };
}

export function installFavourites(app, { directory, admin, writeCheck, device, devices, home = () => false, audit }) {
	const file = path.join(directory, 'favourites.json');
	function read() {
		try {
			const state = JSON.parse(readFileSync(file, 'utf8'));
			for (const entry of Object.values(state.profiles)) {
				const items = {}, aliases = entry.episodeAliases || {};
				for (const item of Object.values(entry.items)) {
					const title = favouriteTitle(item);
					if (title.Id !== item.Id) aliases[item.Id] = title.Id;
					if (!items[title.Id] || title === item) items[title.Id] = title;
				}
				entry.items = items; entry.episodeAliases = aliases;
			}
			return state;
		}
		catch (error) { if (error.code === 'ENOENT') return { profiles: {}, devices: {} }; throw error; }
	}
	function save(state) {
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		writeFileSync(file + '.tmp', JSON.stringify(state), { mode: 0o600 });
		renameSync(file + '.tmp', file);
	}
	function profile(state, name) {
		const id = randomBytes(16).toString('hex');
		state.profiles[id] = { id, name: name.trim(), items: {} };
		return state.profiles[id];
	}
	function settings(state, record) {
		if (record.personId) {
			if (!state.devices[record.personId]) state.devices[record.personId] = { profileId: profile(state, record.personName).id, linkedProfiles: [] };
			return state.devices[record.personId];
		}
		if (!state.devices[record.id]) state.devices[record.id] = { profileId: profile(state, record.name).id, linkedProfiles: [] };
		return state.devices[record.id];
	}
	function approved(req, res, next) {
		req.favouritesDevice = device(req);
		if (!req.favouritesDevice) return res.status(401).json({ error: 'An approved app is required.' });
		next();
	}
	function ordered(items, played = {}, added = {}) {
		return items.map(item => ({ ...item, LastPlayedAt: played[item.Id] || 0, FavouritedAt: added[item.Id] || 0 }))
			.sort((a, b) => b.LastPlayedAt - a.LastPlayedAt || b.FavouritedAt - a.FavouritedAt || a.Name.localeCompare(b.Name) || a.Id.localeCompare(b.Id));
	}
	function collection(entry, played = entry.played) { return { id: entry.id, name: entry.name, items: ordered(Object.values(entry.items), played, entry.added) }; }
	function view(state, record) {
		const config = settings(state, record), own = state.profiles[config.profileId];
		return { own: collection(own), collections: [...new Set([own.id, ...config.linkedProfiles])].map(id => state.profiles[id]).filter(Boolean).map(entry => collection(entry, own.played)) };
	}
	function cleanItem(item) {
		if (!item || !idOK(item.Id) || typeof item.Name !== 'string' || !item.Name.trim() || item.Name.length > 250
			|| !['Movie', 'Series', 'Season', 'Episode', 'TvChannel'].includes(item.Type)) return null;
		const result = { Id: item.Id, Name: item.Name.trim(), Type: item.Type };
		for (const key of ['SeriesId', 'SeriesName', 'Source', 'ChannelNumber', 'Group', 'WatchId']) {
			if (typeof item[key] === 'string' && item[key].length <= 250) result[key] = item[key];
		}
		for (const key of ['ProductionYear', 'ParentIndexNumber', 'IndexNumber', 'RunTimeTicks']) {
			if (Number.isSafeInteger(item[key]) && item[key] >= 0) result[key] = item[key];
		}
		if (typeof item.Artwork === 'string' && item.Artwork.length < 1000 && (/^\/(?!\/)[A-Za-z0-9/_?.=&%-]+$/.test(item.Artwork) || /^https:\/\/image\.tmdb\.org\/[A-Za-z0-9/_.-]+$/.test(item.Artwork))) result.Artwork = item.Artwork;
		return result;
	}
	function applyChange(target, change) {
		const original = change.item || target.items[change.id];
		const item = original ? favouriteTitle(original) : null;
		const id = item?.Id || target.episodeAliases?.[change.id] || change.id;
		if (id !== change.id) {
			target.episodeAliases ||= {}; target.episodeAliases[change.id] = id;
			delete target.items[change.id];
		}
		if (change.saved) {
			target.added ||= {};
			if (!target.items[id]) target.added[id] = Date.now();
			// Keep richer series metadata already saved by another episode of this show.
			if (!target.items[id] || id === change.id) target.items[id] = item;
		} else { delete target.items[id]; if (target.added) delete target.added[id]; }
	}
	function homeProfile(state) {
		if (!state.homeId || !state.profiles[state.homeId]) state.homeId = profile(state, 'Home').id;
		return state.profiles[state.homeId];
	}
	function includeHome(state, record) {
		const config = settings(state, record);
		state.homeProfiles ||= [];
		if (!state.homeProfiles.includes(config.profileId)) state.homeProfiles.push(config.profileId);
	}
	function homeCollection(state) {
		const base = homeProfile(state), items = new Map(Object.values(base.items).map(item => [item.Id,item]));
		const added = { ...base.added };
		for (const id of state.homeProfiles || []) for (const item of Object.values(state.profiles[id]?.items || {})) {
			if (!items.has(item.Id)) items.set(item.Id,item);
			added[item.Id] = Math.max(added[item.Id] || 0, state.profiles[id].added?.[item.Id] || 0);
		}
		return {...collection(base),items:ordered([...items.values()], base.played, added)};
	}
	// Only trusted, confirmed playback events change recency. Never accept a
	// client-supplied timestamp or infer identity from a device name or address.
	audit?.subscribe(event => {
		if (event.type !== 'watch_started' || event.purpose === 'download' || event.shareId) return;
		const title = event.seriesId || event.itemId;
		if (!idOK(title)) return;
		const record = event.personId ? { id: event.personId, name: event.personName || 'Viewer' }
			: devices().find(record => record.id === event.deviceId)
				|| ((event.local || event.home) && !event.deviceId ? { id: 'home', name: 'Home' } : null);
		if (!record) return;
		const state = read(), own = state.profiles[settings(state, record).profileId];
		const targets = [own];
		if (event.local || event.home) targets.push(homeProfile(state));
		for (const target of targets) {
			target.played ||= {}; target.played[title] = Date.now();
			const keys = Object.keys(target.played).sort((a,b) => target.played[b] - target.played[a]);
			for (const key of keys.slice(5000)) if (!target.items[key]) delete target.played[key];
		}
		save(state);
	});
	app.get('/api/favourites/home', approved, (req, res) => {
		if (!home(req)) return res.sendStatus(403);
		const state = read(); includeHome(state,req.favouritesDevice); const own = homeCollection(state); save(state); res.json({ own, collections: [own] });
	});
	app.post('/api/favourites/home', writeCheck, approved, (req, res) => {
		if (!home(req)) return res.sendStatus(403);
		const state = read(), target = homeProfile(state), change = req.body;
		if (!idOK(change?.id) || typeof change.saved !== 'boolean') return res.status(400).json({ error: 'Choose a favourite.' });
		const item = change.item ? cleanItem(change.item) : null;
		if (change.saved && (!item || item.Id !== change.id)) return res.status(400).json({ error: 'Invalid favourite.' });
		applyChange(target, { ...change, item });
		if (!change.saved) {
			const own = state.profiles[settings(state,req.favouritesDevice).profileId];
			applyChange(own, { ...change, item });
		}
		if (Object.keys(target.items).length > 1000) return res.sendStatus(409);
		save(state); res.json(homeCollection(state));
	});
	app.get('/api/favourites', approved, (req, res) => {
		const state = read(), result = view(state, req.favouritesDevice);
		if (home(req)) { includeHome(state,req.favouritesDevice); result.home = homeCollection(state); }
		save(state); res.json(result);
	});
	app.post('/api/favourites', writeCheck, approved, (req, res) => {
		const state = read(), config = settings(state, req.favouritesDevice);
		if (req.body?.profileId !== config.profileId) return res.status(409).json({ error: 'Your collection changed. Refresh and try again.' });
		const changes = req.body?.changes;
		if (!Array.isArray(changes) || changes.length > 20) return res.status(400).json({ error: 'Send up to 20 favourite changes at a time.' });
		const prepared = changes.map(change => change && typeof change === 'object' ? ({ ...change, item: change.item ? cleanItem(change.item) : null }) : {});
		if (prepared.some(change => !idOK(change.id) || typeof change.saved !== 'boolean' || (change.saved && (!change.item || change.item.Id !== change.id)))) return res.status(400).json({ error: 'Invalid favourite.' });
		const items = { ...state.profiles[config.profileId].items };
		const target = { ...state.profiles[config.profileId], items };
		for (const change of prepared) applyChange(target, change);
		if (Object.keys(items).length > 1000) return res.status(400).json({ error: 'This collection can hold up to 1,000 favourites.' });
		state.profiles[config.profileId] = target; if(home(req)) includeHome(state,req.favouritesDevice); save(state); res.json(view(state, req.favouritesDevice));
	});
	app.get('/api/favourites/manage', admin, (req, res) => {
		const state = read(), approvedDevices = devices();
		for (const record of approvedDevices) settings(state, record);
		save(state);
		res.json({ profiles: Object.values(state.profiles).map(({ id, name, items }) => ({ id, name, count: Object.keys(items).length })), devices: Object.fromEntries(approvedDevices.map(record => [record.id, settings(state, record)])) });
	});
	app.post('/api/favourites/profiles', writeCheck, admin, (req, res) => {
		if (!nameOK(req.body?.name)) return res.status(400).json({ error: 'Enter a collection name between 2 and 80 characters.' });
		const state = read();
		if (Object.keys(state.profiles).length >= 512) return res.status(409).json({ error: 'Too many collections.' });
		const result = profile(state, req.body.name); save(state); res.status(201).json(collection(result));
	});
	app.post('/api/favourites/profiles/:id', writeCheck, admin, (req, res) => {
		if (!nameOK(req.body?.name)) return res.status(400).json({ error: 'Enter a collection name between 2 and 80 characters.' });
		const state = read();
		if (!profileOK(state, req.params.id)) return res.sendStatus(404);
		const entry = state.profiles[req.params.id];
		entry.name = req.body.name.trim(); save(state); res.json(collection(entry));
	});
	app.post('/api/favourites/devices/:id', writeCheck, admin, (req, res) => {
		const record = devices().find(value => value.id === req.params.id);
		if (!record) return res.sendStatus(404);
		const state = read(), { profileId, linkedProfiles } = req.body || {};
		if (!profileOK(state, profileId) || !Array.isArray(linkedProfiles) || linkedProfiles.length > 32 || linkedProfiles.some(id => !profileOK(state, id))) return res.status(400).json({ error: 'Choose existing favourites collections.' });
		const owner = record.personId || record.id;
		state.devices[owner] = { profileId, linkedProfiles: [...new Set(linkedProfiles)].filter(id => id !== profileId) };
		save(state); res.json(state.devices[owner]);
	});
}
