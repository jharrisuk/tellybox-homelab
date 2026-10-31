import path from 'node:path';
import { isIP } from 'node:net';
import { createHash } from 'node:crypto';
import { jsonStore } from './json-store.mjs';

const windowMs = 5 * 60000;
const blockMs = 24 * 3600000;

export function createLoginProtection(directory, { clock = Date.now } = {}) {
	const store = jsonStore(path.join(directory, 'login-protection.json'), { addresses: {} });
	function address(value) {
		value = String(value || '').replace(/^::ffff:/i, '');
		if (!isIP(value)) throw Object.assign(Error('Unable to identify this connection.'), { status: 400 });
		return isIP(value) === 6 ? new URL('http://[' + value + ']').hostname.slice(1,-1) : value;
	}
	function key(ip) { return createHash('sha256').update(ip).digest('hex'); }
	function cleanup() {
		for (const [id, entry] of Object.entries(store.get().addresses)) {
			entry.attempts = entry.attempts.filter(time => time > clock() - windowMs);
			if (!entry.attempts.length && entry.blockedUntil <= clock()) delete store.get().addresses[id];
		}
	}
	function reject(entry) {
		if (entry?.blockedUntil > clock()) throw Object.assign(Error('Too many sign-in attempts. Try again in 24 hours or contact the owner.'), {
			status: 429, code: 'LOGIN_IP_BLOCKED', retryAfter: Math.ceil((entry.blockedUntil - clock()) / 1000)
		});
	}
	return {
		check(ip) { reject(store.get().addresses[key(address(ip))]); },
		attempt(value, email) {
			const ip = address(value), id = key(ip);
			cleanup(); reject(store.get().addresses[id]);
			if (!store.get().addresses[id] && Object.keys(store.get().addresses).length >= 10000) {
				throw Object.assign(Error('Sign-in is busy. Please try again later.'), { status: 503, retryAfter: 300 });
			}
			const entry = store.get().addresses[id] ||= { ip, attempts: [], blockedUntil: 0 };
			entry.email = typeof email === 'string' && email.length <= 254 && /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(email.trim()) ? email.trim().toLowerCase() : '';
			entry.lastAttempt = clock();
			entry.attempts.push(clock());
			if (entry.attempts.length > 3) entry.blockedUntil = clock() + blockMs;
			store.save(); reject(entry);
		},
		list() {
			cleanup();
			return Object.entries(store.get().addresses).filter(([,e]) => e.blockedUntil > clock())
				.map(([id,e]) => ({ id, ip: e.ip, blockedUntil: e.blockedUntil }));
		},
		snapshot() {
			cleanup();
			return Object.entries(store.get().addresses).map(([id,e]) => ({ id, ip: e.ip, email: e.email || '',
				attempts: e.attempts.length, limit: 3, blockedUntil: e.blockedUntil,
				lastAttempt: e.lastAttempt || e.attempts.at(-1) || e.blockedUntil - blockMs,
				resetsAt: e.attempts.length ? e.attempts[0] + windowMs : 0,
				state: e.blockedUntil > clock() ? 'blocked' : e.attempts.length >= 2 ? 'warning' : 'recent'
			})).sort((a,b) => b.lastAttempt - a.lastAttempt);
		},
		unblock(id) {
			if (!/^[a-f0-9]{64}$/.test(id || '')) throw Object.assign(Error('Choose a connection.'), { status: 400 });
			delete store.get().addresses[id]; store.save(); return { ok: true };
		}
	};
}
