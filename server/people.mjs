import path from 'node:path';
import { randomBytes, randomInt, createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { jsonStore } from './json-store.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const fail = (message, status = 400) => Object.assign(Error(message), { status });
const day = 86400000;
export function createPeople(directory, { clock = Date.now, deliver, audit, revoke = () => {}, loginUrl = '/login' } = {}) {
	const store = jsonStore(path.join(directory, 'people.json'), { users: {}, sessions: {}, devices: {}, challenges: {}, secret: randomBytes(32).toString('hex') });
	const config = jsonStore(path.join(directory, 'email.json'), { enabled: false, key: '', from: '' });
	const buckets = new Map();
	store.get().localBrowsers ||= {};
	function localBrowser(token) {
		return /^[a-f0-9]{64}$/.test(token || '') ? store.get().localBrowsers[hash(token)] || null : null;
	}
	function browserPerson(token) {
		const browser = localBrowser(token), user = browser && store.get().users[browser.personId];
		return user?.status === 'approved' ? { personId: user.id, personName: user.name } : null;
	}
	function registerBrowser(token, agent) {
		let browser = localBrowser(token);
		if (!browser) {
			if (Object.keys(store.get().localBrowsers).length >= 500) return null;
			token = randomBytes(32).toString('hex');
			browser = { id: randomBytes(16).toString('hex'), name: 'Home browser', browser: String(agent || 'Browser').slice(0,240), created: clock(), lastSeen: clock() };
			store.get().localBrowsers[hash(token)] = browser; store.save();
		} else if (clock() - browser.lastSeen > 300000) { browser.lastSeen = clock(); store.save(); }
		return { token, browser };
	}
	function manageBrowser({ id, action, name, personId }) {
		const entry = Object.entries(store.get().localBrowsers).find(([,b]) => b.id === id);
		if (!entry) throw fail('Browser not found.',404);
		const [key, browser] = entry;
		if (action === 'remove') delete store.get().localBrowsers[key];
		else if (action === 'link' && (!personId || store.get().users[personId]?.status === 'approved')) browser.personId = personId || '';
		else if (action === 'rename' && typeof name === 'string' && name.trim().length >= 2 && name.length <= 80 && !/[\x00-\x1f]/.test(name)) browser.name = name.trim();
		else throw fail('Choose an approved person or a valid browser name.');
		store.save(); return {ok:true};
	}
	const notifications = new Map();
	async function sendEmail(message, id) {
		if (deliver) return deliver(message);
		const response = await fetch('https://api.resend.com/emails', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(12000),
			headers: { Authorization: 'Bearer ' + config.get().key, 'Content-Type': 'application/json', 'Idempotency-Key': id },
			body: JSON.stringify({ from: 'Tellybox <' + config.get().from + '>', to: [message.email], subject: message.subject, text: message.text }) });
		if (!response.ok) throw Error('Delivery failed');
	}
	function notifyApproval(user) {
		if (user.approvalEmailStatus === 'sent') return { ok: true, approvalEmail: 'sent' };
		const notice = user.approvalNotice;
		if (notifications.has(notice)) return notifications.get(notice);
		user.approvalEmailStatus = 'sending'; store.save();
		const task = (async () => {
			let status = 'sent';
			try {
				await sendEmail({ type: 'approval', email: user.email, subject: 'You can now watch Tellybox',
					text: `Your Tellybox access has been approved.\n\nOpen ${loginUrl} and enter your email address to receive a sign-in code.\n\nEnjoy watching!` }, notice);
			} catch { status = 'failed'; }
			if (store.get().users[user.id] === user && user.status === 'approved' && user.approvalNotice === notice) {
				user.approvalEmailStatus = status; store.save();
			}
			return { ok: true, approvalEmail: status };
		})();
		notifications.set(notice, task);
		return task.finally(() => notifications.delete(notice));
	}
	function throttle(key, count, window) {
		for (const [k, b] of buckets) if (b.until < clock()) buckets.delete(k);
		if (buckets.size > 2000) throw fail('Please try again later.', 429);
		const b = buckets.get(key) || { count: 0, until: clock() + window };
		buckets.set(key, b); if (++b.count > count) throw fail('Please wait before trying again.', 429);
	}
	function status() { return { enabled: config.get().enabled, configured: Boolean(config.get().key && config.get().from), from: config.get().from }; }
	function configure(body) {
		const c = config.get();
		if (typeof body.enabled !== 'boolean') throw fail('Choose whether email sign-in is enabled.');
		if (body.key && (typeof body.key !== 'string' || !/^re_[A-Za-z0-9_-]{10,200}$/.test(body.key))) throw fail('Enter a valid Resend key.');
		if (typeof body.from !== 'string' || !/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(body.from) || body.from.length > 200 || /@resend\.dev$/i.test(body.from)) throw fail('Use a sender on your verified domain.');
		if (body.enabled && !(body.key || c.key)) throw fail('Add the Resend key first.');
		Object.assign(c, { enabled: body.enabled, from: body.from, key: body.key || c.key }); config.save();
		return status();
	}
	function clean() {
		const state = store.get();
		for (const [id, c] of Object.entries(state.challenges)) if (c.expires < clock()) delete state.challenges[id];
		for (const [id, s] of Object.entries(state.sessions)) if (s.expires < clock()) delete state.sessions[id];
	}
	function signature(id, code) { return createHmac('sha256', store.get().secret).update(id + ':' + code).digest('hex'); }
	async function request(email, ip, identity = { ip }) {
		if (!status().enabled) throw fail('Email sign-in is not enabled yet.', 503);
		if (typeof email !== 'string' || email.length > 254 || !/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(email)) throw fail('Enter your email address.');
		email = email.trim().toLowerCase();
		throttle('ip:' + ip, 8, 15 * 60000);
		clean(); const state = store.get();
		let user = Object.values(state.users).find(u => u.email === email);
		if (!user) {
			if (Object.keys(state.users).length >= 1000) throw fail('Please contact the owner.', 503);
			throttle('new-requests', 200, day);
			user = { id: randomBytes(16).toString('hex'), email, name: email, status: 'pending', created: clock() };
			state.users[user.id] = user; store.save();
			audit?.record('person_requested', identity, { personId: user.id, personName: user.name });
		}
		if (user.status === 'revoked') throw fail('Access is unavailable. Contact the owner.', 403);
		if (user.status !== 'approved') return { status: 'pending' };
		throttle('email:' + hash(email), 3, 15 * 60000); throttle('all', 80, day);
		for (const [id, c] of Object.entries(state.challenges)) if (c.email === email) delete state.challenges[id];
		const id = randomBytes(24).toString('hex'), code = String(randomInt(10000000, 100000000));
		state.challenges[id] = { email, hash: signature(id, code), expires: clock() + 10 * 60000, attempts: 0 }; store.save();
		try {
			await sendEmail({ type: 'code', email, code, subject: 'Your Tellybox sign-in code', text: `Your Tellybox code is ${code}.\n\nIt expires in 10 minutes. If you did not request this, ignore this email.` }, id);
		} catch { delete state.challenges[id]; store.save(); throw fail('We could not send the code. Please try again later.', 503); }
		return { status: 'code-sent', challenge: id, expiresIn: 600 };
	}
	function verify({ challenge, code, remember }, identity) {
		if (!status().enabled) throw fail('Email sign-in is not enabled.', 403);
		throttle('verify:' + identity.ip, 30, 15 * 60000);
		const state = store.get(), c = /^[a-f0-9]{48}$/.test(challenge || '') && Object.hasOwn(state.challenges, challenge) ? state.challenges[challenge] : null;
		if (!c || c.expires <= clock() || c.attempts >= 5) throw fail('That code has expired. Request another.', 401);
		c.attempts++; store.save();
		if (!/^\d{8}$/.test(String(code)) || !timingSafeEqual(Buffer.from(c.hash, 'hex'), Buffer.from(signature(challenge, code), 'hex'))) throw fail('That code is not correct.', 401);
		const user = Object.values(state.users).find(u => u.email === c.email);
		delete state.challenges[challenge];
		if (!user || user.status !== 'approved') { store.save(); throw fail('This email needs the owner’s approval before signing in.', 403); }
		clean();
		const prior = Object.entries(state.sessions).filter(([, s]) => s.personId === user.id);
		for (const [key] of prior.slice(0, Math.max(0, prior.length - 19))) { delete state.sessions[key]; revoke('email:' + key); }
		const token = randomBytes(32).toString('hex'), expires = clock() + (remember === true ? 30 * day : day);
		state.sessions[hash(token)] = { id: randomBytes(16).toString('hex'), personId: user.id, expires, created: clock(), ip: identity.ip, browser: identity.browser };
		store.save();
		if (user.status === 'approved') audit?.record('login_success', { ...identity, personId: user.id, personName: user.name });
		return { token, expires, status: user.status, name: user.name };
	}
	function session(token, approved = true) {
		if (!config.get().enabled || !/^[a-f0-9]{64}$/.test(token || '')) return null;
		const s = store.get().sessions[hash(token)], user = s && store.get().users[s.personId];
		return s && s.expires > clock() && user && user.status !== 'revoked' && (!approved || user.status === 'approved') ? { ...s, personName: user.name, status: user.status, owner: 'email:' + hash(token) } : null;
	}
	function end(token) { const key = hash(token || ''); delete store.get().sessions[key]; store.save(); revoke('email:' + key); }
	function manage({ id, action, name, deviceId }) {
		if (action === 'unlink' && /^[a-f0-9]{32}$/.test(deviceId || '')) { delete store.get().devices[deviceId]; store.save(); return { ok: true }; }
		const user = /^[a-f0-9]{32}$/.test(id || '') && Object.hasOwn(store.get().users, id) ? store.get().users[id] : null; if (!user) throw fail('Person not found.', 404);
		if (action === 'approve') {
			if (user.status === 'approved') return { ok: true, approvalEmail: user.approvalEmailStatus || 'not-sent' };
			user.status = 'approved'; user.approvalNotice = 'approval-' + randomBytes(24).toString('hex');
			user.approvalEmailStatus = 'sending'; store.save();
			return notifyApproval(user);
		} else if (action === 'notify-approval' && user.status === 'approved' && user.approvalNotice) return notifyApproval(user);
		else if (action === 'revoke' || action === 'remove') {
			user.status = 'revoked';
			for (const [key, c] of Object.entries(store.get().challenges)) if (c.email === user.email) delete store.get().challenges[key];
			for (const [key, s] of Object.entries(store.get().sessions)) if (s.personId === id) { delete store.get().sessions[key]; revoke('email:' + key); }
			if (action === 'remove') {
				for (const [device, person] of Object.entries(store.get().devices)) if (person === id) delete store.get().devices[device];
				for (const browser of Object.values(store.get().localBrowsers)) if (browser.personId === id) delete browser.personId;
				delete store.get().users[id];
			}
		} else if (action === 'rename' && typeof name === 'string' && name.trim().length >= 2 && name.length <= 80 && !/[\x00-\x1f]/.test(name)) user.name = name.trim();
		else if (action === 'device' && /^[a-f0-9]{32}$/.test(deviceId || '')) store.get().devices[deviceId] = id;
		else throw fail('Choose a valid action.');
		store.save(); return { ok: true };
	}
	return { status, configure, request, verify, session, end, manage, localBrowser, browserPerson, registerBrowser, manageBrowser,
		revokeAll() { for (const key of Object.keys(store.get().sessions)) revoke('email:' + key); store.get().sessions = {}; store.get().challenges = {}; store.save(); },
		list: () => ({ people: Object.values(store.get().users), devices: { ...store.get().devices }, browsers: Object.values(store.get().sessions).filter(s => s.expires > clock()), localBrowsers: Object.values(store.get().localBrowsers) }),
		device: id => { const u = store.get().users[store.get().devices[id]]; return u?.status === 'approved' ? { personId: u.id, personName: u.name } : {}; },
		validOwner: key => { const s = store.get().sessions[key.slice(6)]; return config.get().enabled && s?.expires > clock() && store.get().users[s.personId]?.status === 'approved'; },
		revokeBrowser(id) { for (const [key, s] of Object.entries(store.get().sessions)) if (s.id === id) { delete store.get().sessions[key]; revoke('email:' + key); } store.save(); }
	};
}
