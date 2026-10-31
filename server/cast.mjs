import { randomBytes, createHash, timingSafeEqual } from 'node:crypto';

const digest = value => createHash('sha256').update(value).digest();

export function issueCastTicket(session, origin, now = Date.now()) {
	const address = new URL(origin);
	if (address.protocol !== 'https:' || address.username || address.password) throw new Error('Casting needs the secure jServer address.');
	const token = randomBytes(32).toString('hex');
	session.castHash = digest(token);
	session.castExpires = now + 8 * 60 * 60 * 1000;
	return { url: address.origin + castPath(session.id, session.resource, token), expires: session.castExpires };
}

export function castPath(sessionId, resource, token) {
	return `/cast-stream/${token}/${sessionId}/${resource}`;
}

export function validCastTicket(session, token, validOwner, now = Date.now()) {
	return Boolean(session?.castHash && session.castExpires > now && /^[a-f0-9]{64}$/.test(token || '')
		&& timingSafeEqual(session.castHash, digest(token)) && validOwner(session.owner));
}
