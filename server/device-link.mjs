import path from 'node:path';
import { randomBytes, randomInt, createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { jsonStore } from './json-store.mjs';

/* Q70 device link codes.
 *
 * A device that is not yet linked to an account asks for a short code, shows it
 * to the user, and polls for the outcome. A signed-in account holder enters the
 * code in the web UI; the server then approves the device (if needed) and binds
 * it to that account, enforcing the per-platform device allowance.
 *
 * Security model:
 * - The code is the only secret the device shows. It is stored as an HMAC, never
 *   in plaintext, never logged, and never returned by the status route.
 * - Codes are single use, bound to one device id, and expire after 10 minutes.
 * - Claiming requires an approved account session (or an administrator choosing
 *   an account). The device id alone never approves anything: an unclaimed
 *   device stays pending and the normal playback gate keeps refusing it.
 * - The credential issued at claim time is held in memory only, for the life of
 *   the link request, so the polling device can collect it. It is never written
 *   to disk and never logged. After a restart the device simply runs the link
 *   flow again.
 */

const hash = value => createHash('sha256').update(value).digest('hex');
const fail = (message, status = 400) => Object.assign(Error(message), { status });
// Unambiguous alphabet: no I, L, O, 0 or 1. 8 characters ~ 39.6 bits.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_PATTERN = new RegExp('^[' + CODE_ALPHABET + ']{8}$');
// Enrollment approval codes are 8 uppercase hex characters, so they may contain
// 0 or 1 even though link codes deliberately exclude them.
const APPROVAL_CODE = /^[A-F0-9]{8}$/;
const DEVICE_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const TTL = 10 * 60000;

export function createDeviceLink(directory, { clock = Date.now, apps, people, accountLimits, audit } = {}) {
	const store = jsonStore(path.join(directory, 'device-links.json'), { secret: randomBytes(32).toString('hex'), requests: {} });
	const buckets = new Map();
	// Credential escrow: memory only, keyed by device id hash, purged with the
	// request. The persisted request never carries the token.
	const credentials = new Map();
	function signature(deviceKey, code) { return createHmac('sha256', store.get().secret).update(deviceKey + ':' + code).digest('hex'); }
	function throttle(key, count, window) {
		for (const [k, b] of buckets) if (b.until < clock()) buckets.delete(k);
		// Bound memory without failing every caller: a full map refuses the new key
		// only. A global 429 here would let a flood of unknown device ids take
		// device linking down for everyone, and evicting an arbitrary bucket would
		// reset somebody's rate limit. Unknown device ids no longer create buckets,
		// so filling this map needs many source addresses.
		if (!buckets.has(key) && buckets.size >= 2000) throw fail('Please wait before trying again.', 429);
		const b = buckets.get(key) || { count: 0, until: clock() + window };
		buckets.set(key, b); if (++b.count > count) throw fail('Please wait before trying again.', 429);
	}
	function clean() {
		const state = store.get(); let dirty = false;
		// Keep expired requests for one extra TTL so status can report "expired"
		// rather than pretending the device never asked.
		for (const [key, r] of Object.entries(state.requests)) if (r.expires + TTL < clock()) { delete state.requests[key]; credentials.delete(key); dirty = true; }
		if (dirty) store.save();
	}
	function limitsFor(personId) {
		if (!accountLimits) return { phone: 1, tv: 1 };
		const status = accountLimits.status('person:' + personId);
		return { phone: status.maxPhones ?? 1, tv: status.maxTvs ?? 1 };
	}
	function allowances(personId) {
		const limits = limitsFor(personId), used = { phone: 0, tv: 0 };
		for (const device of apps.forPerson(personId)) if (device.platform === 'phone' || device.platform === 'tv') used[device.platform]++;
		return { phone: { used: used.phone, limit: limits.phone }, tv: { used: used.tv, limit: limits.tv } };
	}
	// The one wording for a full platform allowance, shared by the code claim and
	// the administrator's manual link. Unknown platforms are not counted; an
	// administrator can set the platform on the device to bring it under a limit.
	function checkAllowance(personId, platform, excludeDeviceId = '') {
		if (platform !== 'phone' && platform !== 'tv') return;
		if (!/^[a-f0-9]{32}$/.test(personId || '') || !people.list().people.some(p => p.id === personId)) return;
		const allowance = allowances(personId)[platform];
		let used = allowance.used;
		if (excludeDeviceId && apps.forPerson(personId).some(d => d.id === excludeDeviceId && d.platform === platform)) used--;
		if (allowance.limit > 0 && used >= allowance.limit) {
			throw fail(`This account already has ${used} of ${allowance.limit} ${platform === 'tv' ? 'TV' : 'phone'}. Remove one in Settings > People.`, 409);
		}
	}
	function start({ deviceId, platform, name }, identity) {
		if (typeof deviceId !== 'string' || !DEVICE_ID.test(deviceId)) throw fail('Invalid device identifier.', 400);
		const deviceKey = hash(deviceId.toLowerCase());
		if (platform !== 'phone' && platform !== 'tv') throw fail('Choose phone or tv for this device.', 400);
		if (typeof name !== 'string' || name.trim().length < 2 || name.length > 80 || /[\x00-\x1f]/.test(name)) throw fail('Enter a device name between 2 and 80 characters.', 400);
		const existing = apps.byDeviceKey(deviceKey);
		if (existing && (existing.record.status === 'revoked' || existing.record.expires <= clock())) throw fail('This device access was revoked or expired. Ask an administrator to review it.', 403);
		throttle('link-start-ip:' + identity.ip, 10, 10 * 60000);
		throttle('link-start-device:' + deviceKey, 5, 10 * 60000);
		clean();
		const state = store.get();
		if (!state.requests[deviceKey] && Object.values(state.requests).filter(r => r.expires > clock()).length >= 256) throw fail('Too many link requests. Try again later.', 429);
		const code = Array.from({ length: 8 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
		const expires = clock() + TTL;
		state.requests[deviceKey] = { deviceKey, platform, name: name.trim(), codeHash: signature(deviceKey, code), created: clock(), expires, claimedBy: null, claimedAt: null };
		credentials.delete(deviceKey);
		store.save();
		audit?.record('link_code_started', identity, { deviceKey, platform, deviceName: name.trim() });
		return { code, expiresAt: expires, expiresIn: Math.round(TTL / 1000), platform, name: name.trim() };
	}
	function status(deviceId, ip) {
		if (typeof deviceId !== 'string' || !DEVICE_ID.test(deviceId)) throw fail('Invalid device identifier.', 400);
		const deviceKey = hash(deviceId.toLowerCase());
		throttle('link-status-ip:' + ip, 300, 10 * 60000);
		clean();
		const request = store.get().requests[deviceKey];
		// Unknown ids are only counted against their source IP. Creating a
		// per-device bucket before this check let 2,000 random ids fill the map.
		if (!request) throw fail('No link request for this device.', 404);
		throttle('link-status-device:' + deviceKey, 150, 10 * 60000);
		if (request.claimedBy) {
			const found = apps.byDeviceKey(deviceKey);
			const linked = found && found.record.status === 'approved' && found.record.expires > clock() && people.device(found.record.id).personId === request.claimedBy;
			const credential = credentials.get(deviceKey);
			if (linked && credential && credential.expires > clock()) return { status: 'approved', token: credential.token, ...found.device };
			// Claimed but the credential is gone (restart) or the link was undone:
			// the device must run the link flow again.
			return { status: 'expired' };
		}
		if (request.expires <= clock()) return { status: 'expired' };
		return { status: 'pending', expiresAt: request.expires, platform: request.platform, name: request.name };
	}
	function claim({ code, personId }, identity) {
		throttle('link-claim-ip:' + identity.ip, 10, 15 * 60000);
		throttle('link-claim-all', 300, 15 * 60000);
		const value = String(code || '').trim().toUpperCase();
		if (!CODE_PATTERN.test(value) && !APPROVAL_CODE.test(value)) throw fail('That code is not correct.', 401);
		clean();
		const state = store.get();
		let request = null;
		for (const entry of Object.values(state.requests)) {
			if (timingSafeEqual(Buffer.from(entry.codeHash, 'hex'), Buffer.from(signature(entry.deviceKey, value), 'hex'))) { request = entry; break; }
		}
		const person = people.list().people.find(p => p.id === personId);
		if (!person || person.status !== 'approved') throw fail('This account needs the owner’s approval before linking devices.', 403);
		if (!request) {
			// The TV/phone apps show the enrollment approval code from
			// /api/apps/enroll. Accept it here too, so the same code works from the
			// account page without the device starting a separate link request.
			const pending = apps.pendingByCode?.(value);
			if (!pending) throw fail('That code is not correct.', 401);
			if (pending.record.expires <= clock()) throw fail('That code has expired. Request another.', 401);
			const currentOwner = people.device(pending.record.id).personId;
			if (currentOwner && currentOwner !== personId) throw fail('This device is already linked to another account.', 409);
			checkAllowance(personId, pending.record.platform, pending.record.id);
			apps.approvePending(pending.key);
			people.manage({ action: 'device', id: personId, deviceId: pending.record.id });
			// Re-read so the response carries the fresh account link.
			const linked = apps.deviceById(pending.record.id);
			const device = linked ? linked.device : pending.device;
			audit?.record('device_linked', identity, { personId, personName: person.name, deviceId: device.id, deviceName: device.name, platform: device.platform, method: 'approval-code' });
			return { ok: true, device, allowances: allowances(personId) };
		}
		if (request.expires <= clock()) throw fail('That code has expired. Request another.', 401);
		if (request.claimedBy) throw fail('That code has already been used. Request another.', 401);
		const found = apps.byDeviceKey(request.deviceKey);
		if (found && (found.record.status === 'revoked' || found.record.expires <= clock())) throw fail('This device access was revoked or expired. Ask an administrator to review it.', 403);
		const currentOwner = found ? people.device(found.record.id).personId : undefined;
		if (currentOwner && currentOwner !== personId) throw fail('This device is already linked to another account.', 409);
		// A device already linked to this account is checked against the platform
		// it is about to join: re-linking a TV as a phone must not bypass the phone
		// allowance. checkAllowance excludes this device when it is already counted
		// in that platform, so a same-platform re-link still fits.
		checkAllowance(personId, request.platform, found ? found.record.id : '');
		const result = apps.linkApprove({ deviceKey: request.deviceKey, name: request.name, platform: request.platform, ip: identity.ip });
		people.manage({ action: 'device', id: personId, deviceId: result.device.id });
		request.claimedBy = personId; request.claimedAt = clock();
		credentials.set(request.deviceKey, { token: result.token, expires: clock() + TTL });
		store.save();
		audit?.record('device_linked', identity, { personId, personName: person.name, deviceId: result.device.id, deviceName: result.device.name, platform: request.platform, method: 'link-code' });
		// Re-read the view so the response carries the fresh account link.
		return { ok: true, device: apps.byDeviceKey(request.deviceKey).device, allowances: allowances(personId) };
	}
	return { start, status, claim, allowances, checkAllowance };
}
