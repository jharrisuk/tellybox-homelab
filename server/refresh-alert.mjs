import express from 'express';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// A refresh-alert token is a separate, revocable write-only ingest credential.
// It is deliberately not the Home Assistant stats token: a stats reader must
// never be able to create installation alerts, and an alert sender must never
// be able to read installation statistics.
export const ALERT_PATH = '/api/integrations/refresh-alert';
export const ALERT_TYPE = 'refresh_alert';
export const ALERT_LIMIT = 12;
export const ALERT_WINDOW_MS = 60000;
export const ALERT_BODY_LIMIT = '4kb';

const tokenFile = 'refresh-alert-token.json';
const tokenPattern = /^[a-f0-9]{64}$/;
const digest = value => createHash('sha256').update(value).digest('hex');
const FIELDS = ['title', 'message', 'result', 'run_id', 'source'];
// C0/C1 controls, DEL, and the Unicode line/paragraph separators. Removing
// markup characters keeps every alert plain text on both the Android
// notification and the admin notification feed.
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;
const clean = (value, max) => value.replace(CONTROL, ' ').replace(/[<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, max);

function readJson(file) {
	try { return JSON.parse(readFileSync(file, 'utf8')); }
	catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return null; throw error; }
}
function writeJson(file, value) {
	mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	const temporary = file + '.tmp';
	writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
	renameSync(temporary, file);
}
function publicToken(record) {
	if (!record || !tokenPattern.test(record.tokenHash || '') || typeof record.id !== 'string') return { configured: false };
	return { configured: true, id: record.id, createdAt: Number.isFinite(record.createdAt) ? record.createdAt : null, rotatedAt: Number.isFinite(record.rotatedAt) ? record.rotatedAt : null };
}

// Same storage shape and lifecycle as the Home Assistant stats token, but a
// different file, a different scope and no read permission. Only the sha256
// digest is persisted; the raw token is returned once to the administrator.
export function createRefreshAlertTokens(directory) {
	const file = path.join(directory, tokenFile);
	function status() {
		try { return publicToken(readJson(file)); }
		catch { return { configured: false }; }
	}
	function issue(previous) {
		const token = randomBytes(32).toString('hex'), now = Date.now();
		const record = { version: 1, id: randomBytes(8).toString('hex'), tokenHash: digest(token), createdAt: previous?.createdAt || now, updatedAt: now, ...(previous ? { rotatedAt: now } : {}) };
		writeJson(file, record);
		return { token, ...publicToken(record) };
	}
	// The credential id is used only as a rate-limit key; it is never returned
	// to the caller and never written to a log.
	function authenticate(token) {
		if (typeof token !== 'string' || !tokenPattern.test(token)) return null;
		try {
			const saved = readJson(file);
			if (!publicToken(saved).configured) return null;
			return timingSafeEqual(Buffer.from(digest(token), 'hex'), Buffer.from(saved.tokenHash, 'hex')) ? { id: saved.id } : null;
		} catch { return null; }
	}
	return {
		status,
		authenticate,
		verify(token) { return Boolean(authenticate(token)); },
		create() {
			const current = readJson(file);
			if (publicToken(current).configured) throw Object.assign(Error('A refresh alert token already exists. Rotate it instead.'), { status: 409 });
			return issue(null);
		},
		rotate() {
			const current = readJson(file);
			if (!publicToken(current).configured) throw Object.assign(Error('Create a refresh alert token first.'), { status: 409 });
			return issue(current);
		},
		revoke() {
			if (!existsSync(file)) return { revoked: false, configured: false };
			unlinkSync(file);
			return { revoked: true, configured: false };
		}
	};
}

// Validate and sanitise the ingest body. Every accepted field is a bounded
// plain-text token; nothing from the caller is used as a path, header or HTML.
export function refreshAlertPayload(body) {
	if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
	const keys = Object.keys(body);
	if (keys.length !== FIELDS.length || keys.some(key => !FIELDS.includes(key))) return null;
	if (FIELDS.some(key => typeof body[key] !== 'string')) return null;
	const title = clean(body.title, 120), message = clean(body.message, 300);
	const result = clean(body.result, 32).toLowerCase(), runId = clean(body.run_id, 64), source = clean(body.source, 64);
	if (!title || !message || !runId) return null;
	if (!/^[a-z][a-z0-9_-]{0,31}$/.test(result)) return null;
	if (!/^[a-z0-9][a-z0-9._:-]{0,63}$/i.test(runId)) return null;
	if (!/^[a-z0-9][a-z0-9._-]{0,63}$/i.test(source)) return null;
	return { title, message, result, runId, source };
}

// Registered before the ordinary viewer gate and before the shared JSON
// parser, so this route has its own 4 KB ceiling and is authenticated only by
// its own bearer token. It never inspects a cookie or an app/session token.
export function installRefreshAlert(app, { tokens, record, path: route = ALERT_PATH, now = Date.now, limit = ALERT_LIMIT, windowMs = ALERT_WINDOW_MS } = {}) {
	const parser = express.json({ limit: ALERT_BODY_LIMIT, type: 'application/json' });
	const buckets = new Map();
	const headers = { 'Cache-Control': 'no-store', Pragma: 'no-cache', Vary: 'Authorization', 'X-Content-Type-Options': 'nosniff' };
	function rateLimited(credential) {
		const at = now(), bucket = buckets.get(credential.id);
		if (!bucket || bucket.until <= at) {
			// A single installation has one credential, but rotation must not
			// leak counters. Keep the map bounded anyway.
			if (buckets.size >= 64) buckets.delete(buckets.keys().next().value);
			buckets.set(credential.id, { count: 1, until: at + windowMs });
			return null;
		}
		if (bucket.count >= limit) return Math.max(1, Math.ceil((bucket.until - at) / 1000));
		bucket.count++;
		return null;
	}
	app.post(route, (req, res, next) => {
		res.set(headers);
		const authorization = req.get('authorization') || '';
		// Bound the header before hashing. A query string, cookie or app token
		// can never satisfy this check.
		const match = authorization.length <= 96 ? /^Bearer ([a-f0-9]{64})$/.exec(authorization) : null;
		const credential = match && tokens.authenticate(match[1]);
		if (!credential) return res.status(401).json({ error: 'A valid refresh alert token is required.' });
		const retry = rateLimited(credential);
		if (retry !== null) { res.setHeader('Retry-After', String(retry)); return res.status(429).json({ error: 'Too many refresh alerts. Try again shortly.' }); }
		parser(req, res, error => {
			if (error) return res.status(error.status === 413 ? 413 : 400).json({ error: error.status === 413 ? 'The refresh alert body is too large.' : 'Send a valid JSON refresh alert.' });
			next();
		});
	}, (req, res) => {
		if (!req.is('application/json')) return res.status(400).json({ error: 'Send application/json.' });
		const alert = refreshAlertPayload(req.body);
		if (!alert) return res.status(400).json({ error: 'Send title, message, result, run_id and source only.' });
		try {
			record(ALERT_TYPE, { deviceName: 'Nightly refresh', deviceId: alert.source, client: 'integration' }, {
				title: alert.title, message: alert.message, result: alert.result, runId: alert.runId, source: alert.source
			});
		} catch {
			return res.status(503).json({ error: 'The refresh alert could not be queued.' });
		}
		res.status(202).json({ accepted: true });
	});
	// A method check comes before authentication so a GET can never reveal
	// whether a token is configured. Nothing but POST exists here.
	app.all(route, (req, res) => {
		res.set({ ...headers, Allow: 'POST' }).status(405).json({ error: 'Use POST for refresh alerts.' });
	});
}
