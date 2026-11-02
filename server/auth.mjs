import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { randomBytes, createHash, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { BlockList, isIP } from 'node:net';
import path from 'node:path';
import { createPeople } from './people.mjs';
import { createLoginProtection } from './login-protection.mjs';
import { installAppAccess } from './app-access.mjs';

const deriveKey = promisify(scrypt);
const cookieName = 'jserver_session';
const lifetime = 30 * 24 * 60 * 60 * 1000;
const digest = value => createHash('sha256').update(value).digest('hex');

export function installAuth(app, options) {
	const { directory, publicDirectory, localPort = 8082, publicOrigin = '', localNetworks = [], localHosts = ['localhost', '127.0.0.1'] } = options;
	const passwordPath = path.join(directory, 'password.json');
	const sessionPath = path.join(directory, 'sessions.json');
	const localAddresses = new BlockList();
	for (const network of localNetworks) {
		const [address, bits = '32'] = network.split('/');
		localAddresses.addSubnet(address, Number(bits), isIP(address) === 6 ? 'ipv6' : 'ipv4');
	}
	localAddresses.addSubnet('127.0.0.0', 8, 'ipv4');
	localAddresses.addAddress('::1', 'ipv6');
	const attempts = new Map();
	const responses = new Map();
	const homeTrustedProxies = String(options.homeTrustedProxy || '').split(',').map(value => value.trim()).filter(Boolean);
	const audit = options.audit;
	let revokeEpoch = 0;
	let busy = 0;
	let changing = false;
	function trustedProxy(req) {
		return (options.trustedProxies || []).includes((req.socket.remoteAddress || '').replace(/^::ffff:/, ''));
	}
	function origin(req) {
		const protocol = trustedProxy(req) && req.get('x-forwarded-proto') === 'https' ? 'https' : req.protocol;
		return `${protocol}://${req.get('host')}`;
	}
	function home(req) {
		const peer = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
		return Boolean(options.homeNetwork && homeTrustedProxies.includes(peer) && trustedProxy(req)
			&& publicOrigin.startsWith('https://') && origin(req) === publicOrigin
			&& options.homeNetwork.matches(req.get(options.clientIpHeader || 'cf-connecting-ip')));
	}
	function identity(req) {
		const peer = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
		// Only an explicitly configured proxy may supply the viewer address. This never grants local access.
		const forwarded = req.get(options.clientIpHeader || 'cf-connecting-ip');
		const trusted = trustedProxy(req) && isIP(forwarded || '');
		const entry = read(sessionPath, {})[digest(token(req))];
		const browser = (local(req) || home(req)) ? people.localBrowser(homeBrowserToken(req)) : null;
		const person = browserIdentity(req);
		return { ip: trusted ? forwarded : peer, ipSource: trusted ? 'trusted proxy' : 'connection', local: local(req), browser: (req.get('user-agent') || 'Unknown browser').slice(0, 240), browserId: person?.id || browser?.id || entry?.id || null, ...(browser ? {deviceName:browser.name} : {}), home: home(req), ...(person ? { personId: person.personId, personName: person.personName } : {}) };
	}
	function homeBrowserToken(req) { return (req.headers.cookie || '').split(';').map(p => p.trim()).find(p => p.startsWith('tellybox_browser='))?.slice(17) || ''; }
	function browserIdentity(req) { return people.session(token(req)) || ((local(req) || home(req)) ? people.browserPerson(homeBrowserToken(req)) : null); }
	function log(type, req) { audit?.record(type, identity(req)); }
	function disconnect(key) {
		for (const response of responses.get(key) || []) response.destroy();
		responses.delete(key);
		options.onRevoke?.(key);
	}
	function revokeAll() {
		revokeEpoch++;
		people.revokeAll();
		save(sessionPath, {});
		for (const key of [...responses.keys()]) disconnect(key);
		options.onRevoke?.(null);
	}

	function read(file, fallback) {
		try { return JSON.parse(readFileSync(file, 'utf8')); }
		catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
	}
	function save(file, value) {
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		const temporary = file + '.tmp';
		writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
		renameSync(temporary, file);
	}
	function local(req) {
		if (req.socket.localPort !== localPort || !localHosts.includes(req.hostname)) return false;
		// Never infer local access from forwarded addresses, even if a proxy is on this machine.
		if (Object.keys(req.headers).some(name => name === 'forwarded' || name.startsWith('x-forwarded-') || name.startsWith('cf-'))) return false;
		const address = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
		return localAddresses.check(address, address.includes(':') ? 'ipv6' : 'ipv4');
	}
	function token(req) {
		return (req.headers.cookie || '').split(';').map(part => part.trim()).find(part => part.startsWith(cookieName + '='))?.slice(cookieName.length + 1) || '';
	}
	function authenticated(req) {
		if (people.session(token(req))) return true;
		if (people.status().enabled) return false;
		const value = token(req);
		if (!/^[a-f0-9]{64}$/.test(value)) return false;
		const password = read(passwordPath, null);
		const session = read(sessionPath, {})[digest(value)];
		return Boolean(password && session && session.expires > Date.now() && session.version === password.version);
	}
	function secure(req) {
		return origin(req).startsWith('https://') || Boolean(publicOrigin.startsWith('https://') && req.get('host') === new URL(publicOrigin).host);
	}
	function setCookie(req, res, value, maxAge = lifetime) {
		res.cookie(cookieName, value, { httpOnly: true, sameSite: 'strict', secure: secure(req), path: '/', maxAge });
	}
	function csrf(req, res, next) {
		const expected = origin(req);
		if (!req.headers.origin || (req.headers.origin !== expected && req.headers.origin !== publicOrigin)) return res.status(403).json({ error: 'Open this page directly in jServer and try again.' });
		if (!req.is('application/json')) return res.status(415).json({ error: 'A JSON request is required.' });
		next();
	}
	function localOnly(req, res, next) {
		if (!local(req) || req.get('authorization') || req.get('x-jserver-app')) return res.status(403).json({ error: 'Open the local Tellybox address for this page.' });
		next();
	}
	app.use((req, res, next) => {
		res.setHeader('Cache-Control', 'no-store');
		req.jserverLocal = local(req);
		req.jserverOrigin = origin(req);
		next();
	});
	const people = createPeople(directory, { audit, revoke: disconnect, ...(publicOrigin ? { loginUrl: publicOrigin + '/login' } : {}), ...(options.emailDelivery ? { deliver: options.emailDelivery } : {}) });
	const loginProtection = createLoginProtection(directory);
	const apps = installAppAccess(app, { directory, people, browserPerson: browserIdentity, publicDirectory, local, home, identity, origin, publicOrigin, disconnect, audit });
	// The public player may contact the LAN for playback only, never for administration.
	app.use((req, res, next) => {
		const from = req.get('origin');
		if (!from || from === req.jserverOrigin) return next();
		const method = req.method === 'OPTIONS' ? req.get('access-control-request-method') : req.method;
		const allowed = (req.path === '/api/local-playback' && method === 'GET')
			|| (req.path === '/api/play' && method === 'POST')
			|| (/^\/api\/sessions\/[a-f0-9-]{36}(?:\/cast)?$/.test(req.path) && method === 'POST')
			|| (/^\/stream\/[a-f0-9-]{36}\/[A-Za-z0-9_-]+$/.test(req.path) && ['GET', 'HEAD'].includes(method));
		if (!req.jserverLocal || !publicOrigin || from !== publicOrigin || !allowed) return next();
		res.setHeader('Access-Control-Allow-Origin', publicOrigin);
		res.setHeader('Vary', 'Origin');
		res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, OPTIONS');
		res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');
		res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
		if (req.get('access-control-request-private-network') === 'true') res.setHeader('Access-Control-Allow-Private-Network', 'true');
		if (req.method === 'OPTIONS') return res.sendStatus(204);
		next();
	});
	app.get('/api/local-playback', localOnly, (req, res) => res.json({ instance: options.instanceId }));
	app.get('/health', (req, res) => res.json({ ok: true }));
	if (options.serverHealth) {
		app.get('/api/auth/server-health', apps.requireAdmin, async (req, res) => {
			res.set('Cache-Control', 'no-store');
			res.json(await options.serverHealth());
		});
	}
	if (options.uploadLimit) {
		app.get('/api/auth/upload-limit', apps.requireAdmin, (req, res) => res.json(options.uploadLimit.status()));
		app.post('/api/auth/upload-limit', csrf, apps.requireAdmin, (req, res) => {
			const result = options.uploadLimit.set(req.body?.mbps,req.body?.schedule);
			audit?.record('upload_limit_changed', identity(req), { mbps: result.mbps });
			res.json(result);
		});
	}
	if (options.playbackDefaults) {
		app.get('/api/auth/playback-defaults', apps.requireAdmin, (req, res) => res.json(options.playbackDefaults.status()));
		app.post('/api/auth/playback-defaults', csrf, apps.writeCheck, apps.requireAdmin, (req, res) => {
			try {
				const result = options.playbackDefaults.set(req.body || {});
				audit?.record('playback_defaults_changed', identity(req), result);
				res.json(result);
			} catch (error) {
				res.status(error.status || 500).json({ error: error.status ? error.message : 'Playback defaults could not be saved.' });
			}
		});
	}
	app.get('/api/auth/status', (req, res) => {
		const atHome = home(req);
		if ((req.jserverLocal || atHome) && !apps.present(req)) {
			const registered = people.registerBrowser(homeBrowserToken(req), req.get('user-agent'));
			if (registered && registered.token !== homeBrowserToken(req)) res.cookie('tellybox_browser',registered.token,{httpOnly:true,sameSite:'strict',secure:secure(req),path:'/',maxAge:365*86400000});
		}
		res.json({ email: people.status().enabled, local: req.jserverLocal, home: atHome, authenticated: authenticated(req), configured: Boolean(read(passwordPath, null)),
			person: browserIdentity(req)?.personName || null,
			localPlayback: (req.jserverLocal || atHome) && options.localPlaybackOrigin ? { origin: options.localPlaybackOrigin, instance: options.instanceId } : null });
	});
	app.get('/api/auth/email/status', (req, res) => res.json({ enabled: people.status().enabled }));
	app.post('/api/auth/email/code', csrf, async (req, res) => {
		const caller = identity(req);
		try {
			if (!caller.local && !caller.home) loginProtection.attempt(caller.ip, req.body?.email);
			res.json(await people.request(req.body?.email, caller.ip, caller));
		} catch (error) { recordEmailFailure(req, caller, error, 'request-code'); throw error; }
	});
	app.post('/api/auth/email/verify', csrf, (req, res) => {
		const caller = identity(req);
		try {
			if (!caller.local && !caller.home) loginProtection.check(caller.ip);
			const result = people.verify(req.body || {}, caller);
			setCookie(req, res, result.token, result.expires - Date.now());
			res.json({ status: result.status, name: result.name });
		} catch (error) { recordEmailFailure(req, caller, error, 'verify-code'); throw error; }
	});
	function recordEmailFailure(req, caller, error, step) {
		const email = step === 'request-code' && typeof req.body?.email === 'string' && req.body.email.length <= 254 && /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(req.body.email.trim()) ? req.body.email.trim().toLowerCase() : '';
		const reason = error.code === 'LOGIN_IP_BLOCKED' ? 'IP blocked for 24 hours' : error.status === 429 ? 'Sign-in rate limit reached' : error.status === 401 ? 'Incorrect or expired email code' : error.status === 403 ? 'Email access not approved or blocked' : error.status === 400 ? 'Invalid email or sign-in details' : 'Email sign-in temporarily unavailable';
		audit?.record(error.status === 429 ? 'login_throttled' : 'login_failed', caller, { method: 'email', step, email, reason });
	}
	app.get('/api/auth/email/me', (req, res) => {
		const person = people.session(token(req), false);
		res.json(person ? { status: person.status, name: person.personName } : { status: 'signed-out' });
	});
	app.get('/api/people', apps.requireAdmin, (req, res) => res.json({ ...people.list(), apps: apps.devices() }));
	app.get('/api/auth/login-protection', apps.requireAdmin, (req, res) => {
		res.set('Cache-Control', 'no-store');
		const connections = loginProtection.snapshot();
		const failed = (audit?.snapshot().recent || []).filter(e => ['login_failed','login_throttled','login_limit_reset'].includes(e.type)).slice(0,100)
			.map(e => ({ id: e.id, time: e.time, type: e.type, ip: e.targetIp || e.ip, email: e.email || '', local: e.type !== 'login_limit_reset' && Boolean(e.home || e.local),
				reason: e.reason || (e.type === 'login_throttled' ? 'Sign-in rate limit reached' : 'Incorrect password'), method: e.method || 'password' }));
		res.json({ blocked: connections.filter(e => e.state === 'blocked'), connections, failed, historyLimit: 100, retentionDays: 30 });
	});
	app.post('/api/auth/login-protection', apps.writeCheck, apps.requireAdmin, (req, res) => {
		const entry = loginProtection.snapshot().find(e => e.id === req.body?.id);
		const result = loginProtection.unblock(req.body?.id);
		if (entry) audit?.record('login_limit_reset', identity(req), { targetIp: entry.ip, email: entry.email, method: 'admin', reason: entry.state === 'blocked' ? 'IP block cleared by administrator' : 'Email submission counter reset by administrator' });
		res.json(result);
	});
	if(options.remoteControls){
		app.get('/api/remote-controls',apps.requireAdmin,(req,res)=>res.set('Cache-Control','no-store').json(options.remoteControls.status()));
		app.post('/api/remote-controls',apps.writeCheck,apps.requireAdmin,(req,res)=>{
			const result=options.remoteControls.set(req.body);
			audit?.record('remote_controls_changed',identity(req),result);
			res.json(result);
		});
	}
	if(options.accountLimits){
		const known=id=>people.list().people.some(p=>'person:'+p.id===id)||apps.devices().some(d=>'device:'+d.id===id);
		app.get('/api/account-limits/:id',apps.requireAdmin,(req,res)=>{if(!known(req.params.id))return res.sendStatus(404);res.json(options.accountLimits.status(req.params.id));});
		app.post('/api/account-limits/:id',apps.writeCheck,apps.requireAdmin,(req,res)=>{if(!known(req.params.id))return res.sendStatus(404);res.json(options.accountLimits.set(req.params.id,req.body||{}));});
	}
	app.post('/api/people/browsers', apps.writeCheck, apps.requireAdmin, (req,res) => res.json(people.manageBrowser(req.body || {})));
	app.post('/api/people', apps.writeCheck, apps.requireAdmin, async (req, res) => {
		if (['device', 'unlink'].includes(req.body?.action) && !apps.devices().some(d => d.id === req.body.deviceId)) return res.sendStatus(404);
		res.json(await people.manage(req.body || {}));
	});
	app.get('/api/auth/email/config', apps.requireAdmin, (req, res) => res.json(people.status()));
	app.post('/api/auth/email/config', apps.writeCheck, apps.requireAdmin, (req, res) => res.json(people.configure(req.body || {})));
	app.get('/login', (req, res) => {
		if (req.jserverLocal || authenticated(req) || home(req)) return res.redirect('/');
		res.sendFile(path.join(publicDirectory, 'login.html'));
	});
	app.get(['/settings', '/settings.html'], localOnly, (req, res) => res.sendFile(path.join(publicDirectory, 'settings.html')));
	app.get('/api/auth/tunnel', apps.requireAdmin, async (req, res) => res.json(options.tunnelStatus ? await options.tunnelStatus() : { url: null, connected: false }));
	app.get(['/activity', '/activity.html'], localOnly, (req, res) => res.sendFile(path.join(publicDirectory, 'activity.html')));
	app.get('/api/activity', apps.requireAdmin, (req, res) => {
		const config = read(passwordPath, null);
		const browsers = Object.values(read(sessionPath, {})).filter(entry => entry.expires > Date.now() && entry.version === config?.version).map(({ id, ip, browser, created, expires }) => ({ id, ip, browser, created, expires }));
		res.json({ ...audit?.snapshot(), browsers: [...browsers, ...people.list().browsers] });
	});
	for (const file of ['style.css', 'auth.js', 'connection-status.js', 'icon.svg', 'tellybox-logo.png']) app.get('/' + file, (req, res) => res.sendFile(path.join(publicDirectory, file)));

	app.post('/api/auth/password', csrf, apps.requireAdmin, async (req, res) => {
		const password = req.body?.password;
		if (typeof password !== 'string' || password.length < 12 || password.length > 200) return res.status(400).json({ error: 'Use a password between 12 and 200 characters.' });
		if (changing) return res.status(429).json({ error: 'A password change is already in progress.' });
		changing = true;
		try {
			const salt = randomBytes(32).toString('hex');
			const hash = await deriveKey(password, salt, 64);
			save(passwordPath, { salt, hash: hash.toString('hex'), version: randomBytes(16).toString('hex') });
			revokeAll();
			log('password_changed', req);
			attempts.clear();
			setCookie(req, res, '', 0);
			res.json({ ok: true });
		} finally { changing = false; }
	});
	app.post('/api/auth/revoke', csrf, apps.requireAdmin, (req, res) => {
		revokeAll();
		log('sessions_revoked', req);
		setCookie(req, res, '', 0);
		res.json({ ok: true });
	});
	app.post('/api/auth/revoke-browser', csrf, apps.requireAdmin, (req, res) => {
		const sessions = read(sessionPath, {});
		const key = Object.keys(sessions).find(key => sessions[key].id === req.body?.id);
		if (!key) { people.revokeBrowser(req.body?.id); return res.json({ ok: true }); }
		delete sessions[key];
		save(sessionPath, sessions);
		disconnect(key);
		log('browser_revoked', req);
		res.json({ ok: true });
	});
	app.post('/api/auth/login', csrf, async (req, res) => {
		if (people.status().enabled) return res.status(403).json({ error: 'Please use email sign-in.' });
		const address = identity(req).ip;
		const now = Date.now();
		const epoch = revokeEpoch;
		for (const [ip, value] of attempts) if (value.until <= now) attempts.delete(ip);
		let attempt = attempts.get(address);
		if (attempt?.count >= 8 || busy >= 2 || attempts.size >= 1000) {
			log('login_throttled', req);
			res.setHeader('Retry-After', String(Math.max(1, Math.ceil(((attempt?.until || now + 30000) - now) / 1000))));
			return res.status(429).json({ error: 'Too many attempts. Please wait before trying again.' });
		}
		if (!attempt) { attempt = { count: 0, until: now + 15 * 60000 }; attempts.set(address, attempt); }
		attempt.count++;
		const config = read(passwordPath, null);
		if (!config) return res.status(503).json({ error: 'Remote access is waiting for the owner to set a password at home.' });
		const password = req.body?.password;
		if (typeof password !== 'string' || password.length > 200) { log('login_failed', req); return res.status(401).json({ error: 'That password is not correct.' }); }
		busy++;
		try {
			const hash = await deriveKey(password, config.salt, 64);
			if (!timingSafeEqual(hash, Buffer.from(config.hash, 'hex'))) { log('login_failed', req); return res.status(401).json({ error: 'That password is not correct.' }); }
			// A simultaneous password change must not grant access with the old password.
			if (read(passwordPath, null)?.version !== config.version || epoch !== revokeEpoch) return res.status(401).json({ error: 'Access settings changed. Please try again.' });
			attempts.delete(address);
			const sessions = Object.fromEntries(Object.entries(read(sessionPath, {})).filter(([, entry]) => entry.expires > now && entry.version === config.version));
			const value = randomBytes(32).toString('hex');
			const keys = Object.keys(sessions);
			if (keys.length >= 256) { disconnect(keys[0]); delete sessions[keys[0]]; }
			const viewer = identity(req);
			const browserId = randomBytes(16).toString('hex');
			sessions[digest(value)] = { expires: now + lifetime, version: config.version, id: browserId, ip: viewer.ip, browser: viewer.browser, created: now };
			save(sessionPath, sessions);
			audit?.record('login_success', { ...viewer, browserId });
			setCookie(req, res, value);
			res.json({ ok: true });
		} finally { busy--; }
	});
	app.post('/api/auth/logout', csrf, (req, res) => {
		log('logout', req);
		people.end(token(req));
		const sessions = read(sessionPath, {});
		const key = digest(token(req));
		delete sessions[key];
		save(sessionPath, sessions);
		disconnect(key);
		setCookie(req, res, '', 0);
		res.json({ ok: true });
	});

	// Gate every remaining route, including images, HLS playlists, segments and direct streams.
	app.use((req, res, next) => {
		if (apps.present(req)) {
			const device = apps.resolve(req);
			if (!device) return res.status(401).json({ error: 'This app is awaiting approval, expired or revoked.' });
			req.jserverApp = device;
			req.jserverViewer = { ...identity(req), browserId: device.id, deviceId: device.id, deviceName: device.name, ...people.device(device.id) };
			req.jserverOwner = device.owner;
			if (req.path.startsWith('/stream/') || req.path.startsWith('/api/downloads/') || req.path.startsWith('/api/episode-downloads/')) {
				if (!responses.has(device.owner)) responses.set(device.owner, new Set());
				responses.get(device.owner).add(res);
				res.on('close', () => { responses.get(device.owner)?.delete(res); if (!responses.get(device.owner)?.size) responses.delete(device.owner); });
			}
			return next();
		}
		const signedIn = authenticated(req);
		if (req.jserverLocal || signedIn || home(req)) {
			req.jserverViewer = identity(req);
			req.jserverOwner = req.jserverLocal ? 'local' : signedIn ? (people.session(token(req))?.owner || digest(token(req))) : `home:${req.jserverViewer.ip}`;
			if (!req.jserverLocal && (req.path.startsWith('/stream/') || req.path.startsWith('/api/episode-downloads/'))) {
				const key = req.jserverOwner;
				if (!responses.has(key)) responses.set(key, new Set());
				responses.get(key).add(res);
				res.on('close', () => { responses.get(key)?.delete(res); if (!responses.get(key)?.size) responses.delete(key); });
			}
			return next();
		}
		if (['/', '/index.html', '/discover', '/discover.html', '/search', '/search.html'].includes(req.path)) return res.redirect('/login');
		res.status(401).json({ error: 'Please sign in to jServer.' });
	});
	// Evaluate on every request: a client hint or a previously granted role is not authority.
	const canShare = req => Boolean(req.jserverApp?.role === 'admin' || local(req) || home(req));
	app.get('/api/capabilities', (req, res) => {
		res.setHeader('Cache-Control', 'no-store');
		const playbackDefaults = options.playbackDefaults?.status() || { englishSubtitles:false, autoNext:false, skipIntros:false };
		res.json({ ...options.installationCapabilities, playbackDefaults, canShare:canShare(req),canDownload:(options.remoteControls?.allowed(req.jserverViewer)??true)&&(options.accountLimits?.allowed(req.jserverViewer,true)??true) });
	});
	app.use('/api/shares', (req, res, next) => {
		if (!canShare(req)) return res.status(403).json({ error: 'Sharing is available to administrators or at home.' });
		next();
	});
	return { viewerAccount: viewer => viewer?.deviceId ? {...viewer,personId:undefined,personName:undefined,...people.device(viewer.deviceId)} : viewer, identity, isLocal: local, isHome: req => local(req) || home(req), revokeOwner: disconnect, validOwner: key => key === 'local' || (key.startsWith('email:') ? people.validOwner(key) : key.startsWith('share:') ? Boolean(options.validShareOwner?.(key)) : key.startsWith('app:') ? apps.validOwner(key) : key.startsWith('home:') ? Boolean(options.homeNetwork?.matches(key.slice(5))) : (() => {
		const config = read(passwordPath, null);
		const session = read(sessionPath, {})[key];
		return Boolean(config && session && session.expires > Date.now() && session.version === config.version);
	})()) };
}
