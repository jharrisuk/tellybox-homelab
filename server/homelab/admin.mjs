import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, existsSync } from 'node:fs';
import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { atomicJson, configStore, redacted } from './config.mjs';
import { services, infrastructure, presets } from './services.mjs';
import { relayManager } from './relay-jobs.mjs';
import { setupHosts, localConnectionSuggestion } from './setup-hosts.mjs';
import { relayHealth } from './relay-health.mjs';
import { installReleaseVersion } from '../release-version.mjs';
import { createHomeAssistantTokens } from '../home-assistant.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && timingSafeEqual(Buffer.from(hash(a)), Buffer.from(hash(b)));
export function createSetup({ directory, apply = async () => {}, status = () => ({}), fetcher = fetch, clock = Date.now, allowedHosts = '' }) {
	const hostAllowed=setupHosts(allowedHosts);
	const app = express(), store = configStore(directory), sessions = new Map(), attempts = new Map(), relay = relayManager(directory);
	const remoteHealth = relayHealth(directory, { fetcher, clock, localPort: Number(process.env.PORT || 8082) });
	// The media process receives this same directory as AUTH_DIR.
	const homeAssistant = createHomeAssistantTokens(path.join(directory, 'access'));
	const ownerFile = path.join(directory, 'owner.json'), bootstrapFile = path.join(directory, 'bootstrap.json');
	let owner = existsSync(ownerFile) ? JSON.parse(readFileSync(ownerFile, 'utf8')) : null;
	if (!owner && !existsSync(bootstrapFile)) atomicJson(bootstrapFile, { token: randomBytes(24).toString('hex') });
	const bootstrap = !owner ? JSON.parse(readFileSync(bootstrapFile, 'utf8')).token : '';
	app.disable('x-powered-by');
	app.use((req, res, next) => {
		// A private bind may be enabled explicitly. Locality never bypasses owner authentication.
		if (!hostAllowed(req.get('host')) || Object.keys(req.headers).some(name=>name==='forwarded'||name.startsWith('x-forwarded-')||name.startsWith('cf-'))) return res.sendStatus(403);
		res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
			'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'" });
		if (!['GET', 'HEAD'].includes(req.method) && (req.get('origin') !== `http://${req.get('host')}` || !req.is('application/json'))) return res.sendStatus(403);
		next();
	});
	app.use(express.json({ limit: '48kb' }));
	installReleaseVersion(app);
	app.get('/server-version.js', (req, res) => res.sendFile(fileURLToPath(new URL('../public/server-version.js', import.meta.url))));
	app.get('/api/setup/status', (req, res) => res.json({ claimed: Boolean(owner) }));
	app.post('/api/setup/login', (req, res) => {
		const ip = req.socket.remoteAddress, now = clock(), old = attempts.get(ip);
		const bucket = old && old.until > now ? old : { count: 0, until: now + 900000 };
		attempts.set(ip, bucket);
		if (++bucket.count > 8) return res.status(429).json({ error: 'Too many attempts. Wait 15 minutes.' });
		const password = req.body?.password;
		if (typeof password !== 'string' || password.length < 12 || password.length > 200) return res.status(400).json({ error: 'Use a password of 12–200 characters.' });
		if (!owner) {
			if (!equal(req.body.bootstrap, bootstrap)) return res.status(401).json({ error: 'Check the setup code.' });
			const salt = randomBytes(32).toString('hex');
			owner = { salt, password: scryptSync(password, salt, 64).toString('hex') };
			atomicJson(ownerFile, owner);
			atomicJson(bootstrapFile, { consumed: true });
		} else if (!equal(scryptSync(password, owner.salt, 64).toString('hex'), owner.password)) return res.status(401).json({ error: 'Check your password.' });
		attempts.delete(ip);
		for (const [key, exp] of sessions) if (exp <= now) sessions.delete(key);
		if (sessions.size >= 32) sessions.delete(sessions.keys().next().value);
		const token = randomBytes(32).toString('hex'); sessions.set(hash(token), now + 3600000);
		res.cookie('tellybox_setup', token, { httpOnly: true, sameSite: 'strict', path: '/', maxAge: 3600000 });
		res.json({ ok: true });
	});
	app.use('/api/setup', (req, res, next) => {
		const token = req.get('cookie')?.match(/(?:^|;\s*)tellybox_setup=([a-f0-9]{64})(?:;|$)/)?.[1];
		if (!token || (sessions.get(hash(token)) || 0) <= clock()) return res.status(401).json({ error: 'Sign in to configure this installation.' });
		next();
	});
	app.get('/api/setup/config', (req, res) => res.json({ config: redacted(store.get()), services, infrastructure, presets, runtime: status(), connection:localConnectionSuggestion(req.socket.remoteAddress) }));
	app.post('/api/setup/config', (req, res) => res.json({ config: store.save(req.body), saved: true, applyRequired: true }));
	app.get('/api/setup/home-assistant', (req, res) => res.json(homeAssistant.status()));
	app.post('/api/setup/home-assistant', (req, res) => {
		const action = req.body?.action;
		try {
			if (!['create', 'rotate', 'revoke'].includes(action)) return res.status(400).json({ error: 'Choose create, rotate or revoke.' });
			if (action === 'revoke') return res.json(homeAssistant.revoke());
			const result = action === 'create' ? homeAssistant.create() : homeAssistant.rotate();
			// Returned once. Only its hash is stored, so it cannot be shown again.
			return res.status(action === 'create' ? 201 : 200).json(result);
		} catch (error) {
			return res.status(error.status || 500).json({ error: error.status ? error.message : 'The Home Assistant token could not be changed.' });
		}
	});
	app.post('/api/setup/apply', async (req, res) => {
		const config=store.get();
		if (req.body?.revision !== config.revision) return res.status(409).json({error:'Settings changed. Reload and review before applying.'});
		await apply(config); res.json({ ok: true, runtime: status() });
	});
	app.post('/api/setup/logout', (req, res) => {
		const token = req.get('cookie')?.match(/tellybox_setup=([a-f0-9]{64})/)?.[1]; if (token) sessions.delete(hash(token));
		res.clearCookie('tellybox_setup', { path: '/' }); res.json({ ok: true });
	});
	app.get('/api/setup/relay', (req, res) => res.json(relay.status()));
	app.get('/api/setup/relay/health', async (req, res) => res.json(await remoteHealth()));
	app.post('/api/setup/relay', (req, res) => res.json(relay.save(req.body || {})));
	app.get('/api/setup/relay/plan', (req, res) => res.json(relay.plan()));
	app.post('/api/setup/relay/run', (req, res) => res.json(relay.start(req.body?.action, req.body?.confirmation)));
	app.post('/api/setup/test/:id', async (req, res) => {
		const s = store.get().services[req.params.id];
		if (!s?.enabled) return res.status(400).json({ error: 'Enable and save the service first.' });
		const probes = { jellyfin: ['/System/Info', { 'X-Emby-Token': s.key }], dispatcharr: [s.key ? '/api/vod/movies/?page_size=1' : '/output/m3u', s.key ? { 'X-API-Key': s.key, Authorization: 'ApiKey ' + s.key } : {}], seerr: ['/api/v1/settings/main', { 'X-Api-Key': s.key }], sonarr: ['/api/v3/system/status', { 'X-Api-Key': s.key }], radarr: ['/api/v3/system/status', { 'X-Api-Key': s.key }] };
		const probe = probes[req.params.id];
		if (!probe) return res.json({ ok: true, verified: false, message: 'Saved. This integration is checked when used; no email, subtitle download or notification was sent.' });
		try {
			const target = new URL(s.url + probe[0]);
			const response = await fetcher(target, { headers: probe[1], signal: AbortSignal.timeout(7000), redirect: 'error' });
			await response.body?.cancel();
			res.json({ ok: response.ok, verified: response.ok, message: response.ok ? 'Connection accepted.' : [401,403].includes(response.status) ? 'Connection reached, but access was refused. Check the key and permissions.' : 'The service was reached but did not accept this check.' });
		} catch { res.json({ ok: false, verified: false, message: s.onThisServer
			? 'Could not reach this service. Check its published host port. A service bound only to host localhost or an unpublished container port is not reachable here.'
			: 'Could not reach this service. Check the address from inside the Tellybox container.' }); }
	});
	app.use(express.static(path.join(path.dirname(fileURLToPath(import.meta.url)), 'public'), { index: 'index.html', dotfiles: 'deny' }));
	app.use((error, req, res, next) => res.status(error.status || 500).json({ error: error.status ? error.message : 'The operation could not be completed. Configuration was not reset.' }));
	return { app, store };
}
