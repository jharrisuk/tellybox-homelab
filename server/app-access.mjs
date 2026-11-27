import { installAdminPush, notification, notificationTypes } from './admin-push.mjs';
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { installFavourites } from './favourites.mjs';
import { platformOf } from './client-identity.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const day = 86400000;
// The platform the app reports for itself, used for per-platform device
// allowances. Legacy user-agents are the fallback; unknown stays unset.
const declaredPlatform = (req, viewer) => platformOf(req) || (viewer?.client === 'android-tv' ? 'tv' : viewer?.client === 'android-phone' ? 'phone' : '');

export function installAppAccess(app, { directory, local, home = () => false, identity, origin, publicOrigin, disconnect, audit, publicDirectory, people, browserPerson = () => null }) {
	const file = path.join(directory, 'apps.json');
	const attempts = new Map();
	function read() {
		try { return JSON.parse(readFileSync(file, 'utf8')); }
		catch (error) { if (error.code === 'ENOENT') return {}; throw error; }
	}
	function save(entries) {
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		writeFileSync(file + '.tmp', JSON.stringify(entries), { mode: 0o600 });
		renameSync(file + '.tmp', file);
	}
	function key(req) {
		const value = req.get('authorization') || '';
		return /^Bearer [a-f0-9]{64}$/.test(value) ? hash(value.slice(7)) : null;
	}
	function entry(req) { const value = key(req); return value && read()[value]; }
	function valid(record) { return Boolean(record && record.status === 'approved' && record.expires > Date.now()); }
	function deviceKey(req) {
		const value = req.get('x-tellybox-device-id');
		return typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value) ? hash(value.toLowerCase()) : null;
	}
	function touch(record, req) {
		record.lastSeen = Date.now();
		record.ip = identity(req).ip;
	}
	function approveAtHome(record, req) {
		if (record.status !== 'pending' || record.expires <= Date.now() || !(local(req) || home(req))) return false;
		record.status = 'approved'; record.role = 'viewer'; record.approved = Date.now(); record.expires = Date.now() + 365 * day;
		audit?.record('app_auto_approved', identity(req), { deviceId: record.id, deviceName: record.name, role: 'viewer' });
		return true;
	}
	function enrollmentCode(entries) {
		const used = new Set(Object.values(entries).filter(record => record.status === 'pending' && record.expires > Date.now()).map(record => record.code));
		for (let attempt = 0; attempt < 8; attempt++) {
			const code = randomBytes(4).toString('hex').toUpperCase();
			if (!used.has(code)) return code;
		}
		return randomBytes(4).toString('hex').toUpperCase();
	}
	function view(record) {
		const { id, name, code, status, role, created, expires, approved, ip, lastSeen } = record;
		return { id, name, code, status: expires <= Date.now() ? 'expired' : status, role, created, expires, approved, ip, lastSeen, identified: Boolean(record.deviceKey), ...(record.platform ? { platform: record.platform } : {}), ...(people?.device(record.id) || {}) };
	}
	function admin(req, res, next) {
		if (req.get('authorization') || req.get('x-jserver-app')) {
			const record = entry(req);
			if (valid(record) && record.role === 'admin') return next();
		} else if (local(req)) return next();
		return res.status(403).json({ error: 'An approved admin app or the local settings page is required.' });
	}
	function writeCheck(req, res, next) {
		if (!req.is('application/json')) return res.status(415).json({ error: 'A JSON request is required.' });
		const from = req.get('origin');
		if (from && from !== origin(req) && from !== publicOrigin) return res.status(403).json({ error: 'Open jServer directly.' });
		if (!req.get('authorization') && !from) return res.status(403).json({ error: 'An origin is required.' });
		next();
	}
	installAdminPush(app, { directory, admin, writeCheck, record: entry, devices: () => Object.values(read()).filter(valid).map(view), audit });
	installFavourites(app, { directory, admin, writeCheck, audit, home: req => (local(req) || home(req)) && (!(req.get('authorization') || req.get('x-jserver-app')) || valid(entry(req))), device: req => { const record = entry(req); if (req.get('authorization') || req.get('x-jserver-app')) return valid(record) ? view(record) : null; const person = browserPerson(req); return person ? { id: person.personId, name: person.personName } : (local(req) || home(req)) ? { id: 'home', name: 'Home' } : null; }, devices: () => Object.values(read()).filter(valid).map(view) });
	app.get(['/apps', '/apps.html'], (req, res) => {
		if (!local(req)) return res.sendStatus(403);
		res.sendFile(path.join(publicDirectory, 'apps.html'));
	});
	app.post('/api/apps/enroll', (req, res) => {
		if (!req.is('application/json')) return res.sendStatus(415);
		if (!local(req) && !origin(req).startsWith('https://')) return res.status(403).json({ error: 'Use the secure jServer address.' });
		if (req.get('origin') && req.get('origin') !== origin(req) && req.get('origin') !== publicOrigin) return res.sendStatus(403);
		const name = req.body?.name;
		if (typeof name !== 'string' || name.trim().length < 2 || name.length > 80 || /[\x00-\x1f]/.test(name)) return res.status(400).json({ error: 'Enter a device name between 2 and 80 characters.' });
		const stableKey = deviceKey(req);
		if (req.get('x-tellybox-device-id') && !stableKey) return res.status(400).json({ error: 'Invalid device identifier.' });
		const now = Date.now();
		const viewer = identity(req);
		const platform = declaredPlatform(req, viewer);
		const entries = read(), currentKey = key(req), current = currentKey && entries[currentKey];
		if (current && current.expires > now && ['approved', 'pending'].includes(current.status)) {
			if (stableKey && current.deviceKey && stableKey !== current.deviceKey) return res.status(409).json({ error: 'This credential belongs to another device.' });
			if (stableKey && !Object.values(entries).some(record => record !== current && record.deviceKey === stableKey)) current.deviceKey = stableKey;
			if (platform) current.platform = platform;
			approveAtHome(current, req); touch(current, req); save(entries);
			return res.json({ token: req.get('authorization').slice(7), ...view(current) });
		}
		// A revoked credential must never recover itself. An expired token is not a
		// revocation: let the same installation fall through and request again, so a
		// timed-out pending request cannot lock the device out forever.
		if (current && current.status === 'revoked') return res.status(403).json({ error: 'This device access was revoked. Ask an administrator to review it.' });
		for (const [address, attempt] of attempts) if (attempt.until <= now) attempts.delete(address);
		const attempt = attempts.get(viewer.ip) || { count: 0, until: now + 3600000 };
		if (attempt.count >= 5 || attempts.size >= 1000) return res.status(429).json({ error: 'Too many approval requests. Try again in an hour.' });
		attempt.count++; attempts.set(viewer.ip, attempt);
		const match = stableKey && Object.entries(entries).find(([, record]) => record.deviceKey === stableKey);
		if (match) {
			const [oldKey, record] = match;
			if (record.status === 'revoked') return res.status(403).json({ error: 'This device access was revoked. Ask an administrator to review it.' });
			// An expired request or access is recoverable. The installation keeps its
			// identity, but must ask again; only home/local is auto-approved. This is
			// what stops a 24-hour pending timeout from needing a factory reset.
			if (record.expires <= now) {
				const token = randomBytes(32).toString('hex');
				record.status = 'pending'; record.role = 'viewer'; record.code = enrollmentCode(entries);
				record.created = now; delete record.approved; record.expires = now + day;
				if (platform) record.platform = platform;
				// The old access has lapsed. Drop the stale account binding so a UUID
				// (an identifier, not a secret) cannot re-enrol and hand the device to
				// a different account. The owner can link it again.
				people?.manage?.({ action: 'unlink', deviceId: record.id });
				touch(record, req);
				approveAtHome(record, req);
				delete entries[oldKey]; entries[hash(token)] = record; save(entries);
				disconnect(`app:${oldKey}`);
				audit?.record(record.status === 'approved' ? 'app_reconnected' : 'app_requested', viewer, { deviceId: record.id, deviceName: record.name, role: 'viewer' });
				return res.status(201).json({ token, ...view(record) });
			}
			if (!(local(req) || home(req))) return res.status(409).json({ error: 'This device is already registered. Reconnect on your home network to restore it without creating a duplicate.' });
			// An identifier is not authentication: home recovery always becomes a viewer.
			const token = randomBytes(32).toString('hex');
			record.status = 'approved'; record.role = 'viewer'; record.approved = now; record.expires = now + 365 * day;
			if (platform) record.platform = platform;
			touch(record, req); delete entries[oldKey]; entries[hash(token)] = record; save(entries);
			disconnect(`app:${oldKey}`);
			audit?.record('app_reconnected', viewer, { deviceId: record.id, deviceName: record.name, role: 'viewer' });
			return res.json({ token, ...view(record) });
		}
		// Keep known identities as tombstones so reinstalling cannot bypass revocation.
		for (const [entryKey, record] of Object.entries(entries)) if (!record.deviceKey && record.expires <= now) delete entries[entryKey];
		if (Object.keys(entries).length >= 256) return res.status(429).json({ error: 'The app list is full. Ask an admin to remove old devices.' });
		const token = randomBytes(32).toString('hex');
		const record = { id: randomBytes(16).toString('hex'), name: name.trim(), code: enrollmentCode(entries), status: 'pending', role: 'viewer', created: now, expires: now + day, ip: viewer.ip };
		if (stableKey) record.deviceKey = stableKey;
		if (platform) record.platform = platform;
		touch(record, req);
		approveAtHome(record, req);
		entries[hash(token)] = record; save(entries);
		if (record.status === 'pending') audit?.record('app_requested', viewer, { deviceId: record.id, deviceName: record.name });
		res.status(201).json({ token, ...view(record) });
	});
	app.get('/api/apps/me', (req, res) => {
		const entries = read(), tokenKey = key(req), record = tokenKey && entries[tokenKey];
		if (!record) return res.status(401).json({ error: 'Request approval for this installation.' });
		const stableKey = deviceKey(req);
		if (req.get('x-tellybox-device-id') && !stableKey) return res.status(400).json({ error: 'Invalid device identifier.' });
		if (record.expires > Date.now() && ['approved', 'pending'].includes(record.status)) {
			if (stableKey && !record.deviceKey && !Object.values(entries).some(other => other !== record && other.deviceKey === stableKey)) record.deviceKey = stableKey;
			approveAtHome(record, req); touch(record, req); save(entries);
		}
		res.json(view(record));
	});
	app.get('/api/apps', admin, (req, res) => res.json({ devices: Object.values(read()).map(view) }));
	app.get('/api/apps/activity', admin, (req, res) => res.json(audit?.snapshot() || {}));
	app.get('/api/apps/notifications', admin, (req, res) => {
		const since = Number(req.query.since || 0);
		if (!Number.isFinite(since) || since < 0) return res.status(400).json({ error: 'Invalid notification cursor.' });
		const until = Date.now();
		const notifications = (audit?.snapshot().recent || [])
			.filter(event => notificationTypes.includes(event.type) && event.time >= since && event.time <= until)
			.map(notification);
		res.json({ notifications, cursor: until });
	});
	app.post('/api/apps/:id', writeCheck, admin, (req, res) => {
		const { action, role, name, platform } = req.body || {};
		if (!['approve', 'role', 'revoke', 'rename', 'platform'].includes(action) || (['approve', 'role'].includes(action) && !['viewer', 'admin'].includes(role)) || (action === 'rename' && (typeof name !== 'string' || name.trim().length < 2 || name.length > 80 || /[\x00-\x1f]/.test(name)))) return res.status(400).json({ error: 'Choose approve, role or revoke, and a valid role.' });
		if (action === 'platform' && !['phone', 'tv'].includes(platform)) return res.status(400).json({ error: 'Choose phone or tv.' });
		const entries = read();
		const tokenKey = Object.keys(entries).find(value => entries[value].id === req.params.id);
		if (!tokenKey) return res.sendStatus(404);
		const record = entries[tokenKey];
		if (action === 'approve' && (record.status !== 'pending' || record.expires <= Date.now())) return res.status(409).json({ error: 'This request has expired or was already handled.' });
		if (action === 'role' && !valid(record)) return res.status(409).json({ error: 'Only an approved app can change role.' });
		if (action === 'revoke') { record.status = 'revoked'; record.expires = Date.now() + 30 * day; }
		else if (action === 'rename') record.name = name.trim();
		else if (action === 'platform') record.platform = platform;
		else { record.role = role; if (action === 'approve') { record.status = 'approved'; record.approved = Date.now(); record.expires = Date.now() + 365 * day; record.code = ''; } }
		save(entries);
		if (action === 'revoke') disconnect(`app:${tokenKey}`);
		audit?.record(`app_${action}`, identity(req), { deviceId: record.id, deviceName: record.name, role: record.role, ...(action === 'platform' ? { platform } : {}) });
		res.json(view(record));
	});
	// Q70 link-code support. byDeviceKey finds the installation a link code is
	// bound to; forPerson lists the devices counted against an account's
	// platform allowances; linkApprove performs the claim-time approval and
	// credential rotation, mirroring the home-reconnect rules (identifier is not
	// authentication, revoked tombstones fail closed, the old owner is cut off).
	function byDeviceKey(deviceKey) {
		if (!/^[a-f0-9]{64}$/.test(deviceKey || '')) return null;
		const entries = read();
		const tokenKey = Object.keys(entries).find(value => entries[value].deviceKey === deviceKey);
		return tokenKey ? { key: tokenKey, record: entries[tokenKey], device: view(entries[tokenKey]) } : null;
	}
	function forPerson(personId) {
		if (!/^[a-f0-9]{32}$/.test(personId || '')) return [];
		const now = Date.now();
		return Object.values(read()).filter(record => ['approved', 'pending'].includes(record.status) && record.expires > now && people?.device(record.id).personId === personId).map(view);
	}
	// The code shown by /api/apps/enroll is an approval reference, not a Q70 link
	// code. Let the signed-in account holder claim it from the account page so the
	// code on the TV works in both approval paths. Approval is in place: the device
	// keeps the token it already holds and its next /api/apps/me sees approved.
	function pendingByCode(code) {
		const value = String(code || '').trim().toUpperCase();
		if (!/^[A-F0-9]{8}$/.test(value)) return null;
		const entries = read(), wanted = Buffer.from(value);
		for (const tokenKey of Object.keys(entries)) {
			const record = entries[tokenKey];
			if (record.status !== 'pending' || typeof record.code !== 'string' || record.code.length !== value.length) continue;
			if (timingSafeEqual(Buffer.from(record.code), wanted)) return { key: tokenKey, record, device: view(record) };
		}
		return null;
	}
	function deviceById(id) {
		const entries = read();
		const tokenKey = Object.keys(entries).find(value => entries[value].id === id);
		return tokenKey ? { key: tokenKey, record: entries[tokenKey], device: view(entries[tokenKey]) } : null;
	}
	function approvePending(tokenKey) {
		const entries = read(), record = entries[tokenKey];
		if (!record || record.status !== 'pending' || record.expires <= Date.now()) {
			throw Object.assign(Error('This approval request has expired. Ask the device for a new code.'), { status: 409 });
		}
		record.status = 'approved'; record.role = 'viewer'; record.approved = Date.now(); record.expires = Date.now() + 365 * day;
		record.code = '';
		save(entries);
		return view(record);
	}
	function linkApprove({ deviceKey, name, platform, ip }) {
		const now = Date.now();
		const entries = read();
		const oldKey = Object.keys(entries).find(value => entries[value].deviceKey === deviceKey);
		let record = oldKey ? entries[oldKey] : null;
		if (record && (record.status === 'revoked' || record.expires <= now)) throw Object.assign(Error('This device access was revoked or expired. Ask an administrator to review it.'), { status: 403 });
		if (!record) {
			if (Object.keys(entries).length >= 256) throw Object.assign(Error('The app list is full. Ask an admin to remove old devices.'), { status: 429 });
			record = { id: randomBytes(16).toString('hex'), name, code: randomBytes(4).toString('hex').toUpperCase(), status: 'pending', role: 'viewer', created: now, expires: now + day, ip, deviceKey };
		}
		record.name = name; record.platform = platform;
		record.status = 'approved'; record.approved = now; record.expires = now + 365 * day;
		record.lastSeen = now; if (ip) record.ip = ip;
		const token = randomBytes(32).toString('hex');
		if (oldKey) { delete entries[oldKey]; disconnect(`app:${oldKey}`); }
		entries[hash(token)] = record; save(entries);
		return { token, device: view(record) };
	}
	return {
		requireAdmin: admin, writeCheck, devices: () => Object.values(read()).filter(valid).map(view),
		present: req => Boolean(req.get('authorization') || req.get('x-jserver-app')),
		resolve(req) { const record = entry(req); return valid(record) ? { ...view(record), owner: `app:${key(req)}` } : null; },
		validOwner: owner => owner.startsWith('app:') && valid(read()[owner.slice(4)]),
		byDeviceKey, deviceById, forPerson, linkApprove, pendingByCode, approvePending
	};
}
