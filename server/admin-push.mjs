import path from 'node:path';
import { readFileSync } from 'node:fs';
import { createSign } from 'node:crypto';
import { jsonStore } from './json-store.mjs';
import {createPushGatewayClient,PUSH_GATEWAY,PUBLIC_APP_PACKAGE} from './push-gateway-client.mjs';

export const notificationTypes = ['app_requested', 'person_requested', 'media_request', 'login_success', 'watch_started'];
export function pushClient(config, packageId = 'uk.co.jimbos.jserver') {
	if(!config)return {enabled:false};
	const applicationId=packageId==='uk.co.jimbos.jserver'?config.applicationId:packageId==='app.tellybox.homelab'?config.publicApplicationId:null;
	return applicationId?{enabled:true,package:packageId,projectId:config.projectId,applicationId,apiKey:config.apiKey,senderId:config.senderId}:{enabled:false};
}
export function notification(event) {
	const clean = value => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 300) : '';
	const person = clean(event.personName) || clean(event.deviceName);
	const local = event.home || event.local;
	const viewer = person || (local ? 'Someone at home' : 'A guest');
	const title = clean(event.title) || 'an untitled programme';
	const messages = {
		app_requested: `${person || 'A new device'} has requested access`,
		person_requested: `${person || 'A guest'} has requested access`,
		media_request: `${viewer} requested ${title}`,
		login_success: `${viewer} signed in${local ? ' locally' : ''}`,
		watch_started: local ? `Local stream of ${title}${person ? ` · ${person}` : ''}` : `${viewer} started watching ${title} · Remote`
	};
	return { id: event.id, time: event.time, type: event.type,
		title: ({ app_requested: 'Device awaiting approval', person_requested: 'Guest awaiting approval', media_request: 'New viewing request', login_success: 'Signed in', watch_started: 'Started watching' })[event.type],
		message: messages[event.type] || title };
}

// Setup is deliberately file-based: service-account credentials never enter an app or a public endpoint.
export function installAdminPush(app, { directory, admin, writeCheck, record, devices, audit, fetcher = fetch }) {
	const registrations = jsonStore(path.join(directory, 'push-devices.json'), {});
	const gateway=createPushGatewayClient({directory,fetcher});
	let config = null, credential = null, accessToken = '', tokenUntil = 0, busy = false;
	try {
		config = JSON.parse(readFileSync(path.join(directory, 'firebase-client.json'), 'utf8'));
		credential = JSON.parse(readFileSync(path.join(directory, 'firebase-service-account.json'), 'utf8'));
		if (!/^[a-z][a-z0-9-]{4,60}$/.test(config.projectId) || credential.project_id !== config.projectId || !credential.client_email?.endsWith('.iam.gserviceaccount.com') || !credential.private_key?.startsWith('-----BEGIN PRIVATE KEY-----')) throw Error();
	} catch { config = credential = null; }
	const queue = [];
	async function oauth() {
		if (accessToken && tokenUntil > Date.now()) return accessToken;
		const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
		const now = Math.floor(Date.now() / 1000);
		const data = encode({ alg: 'RS256', typ: 'JWT' }) + '.' + encode({ iss: credential.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 });
		const signer = createSign('RSA-SHA256'); signer.update(data); signer.end();
		const assertion = data + '.' + signer.sign(credential.private_key, 'base64url');
		const response = await fetcher('https://oauth2.googleapis.com/token', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000), body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }) });
		if (!response.ok) throw Error('Push connection unavailable');
		const result = await response.json();
		if (!result.access_token) throw Error('Push connection unavailable');
		accessToken = result.access_token; tokenUntil = Date.now() + Math.min(Number(result.expires_in) || 300, 3300) * 1000;
		return accessToken;
	}
	async function drain() {
		if (busy || (!config&&!gateway.enabled)) return; busy = true;
		try {
			while (queue.length) {
				const event = queue.shift();
				for (const [id, registration] of Object.entries(registrations.get())) {
					if (!devices().some(d => d.id === id && d.role === 'admin') || !registration.types.includes(event.type)) continue;
					if(registration.mode==='gateway') {
						if(gateway.enabled&&registration.package===PUBLIC_APP_PACKAGE)try{await gateway.wake(registration.handle,event.id);}catch{}
						continue;
					}
					if((gateway.enabled&&registration.package===PUBLIC_APP_PACKAGE)||!pushClient(config,registration.package).enabled)continue;
					try {
						const token = await oauth();
						// Wake the app with an event ID only. It must authenticate again to retrieve any details.
						const response = await fetcher(`https://fcm.googleapis.com/v1/projects/${config.projectId}/messages:send`, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000), headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, body: JSON.stringify({ message: { token: registration.token, data: { eventId: event.id }, android: { priority: 'high', ttl: '300s' } } }) });
						if (response.status === 404) { delete registrations.get()[id]; registrations.save(); }
						if (response.status === 401) { accessToken = ''; tokenUntil = 0; }
					} catch { /* Periodic authenticated polling remains the fallback. */ }
				}
			}
		} finally { busy = false; }
	}
	app.get('/api/apps/push/config', admin, async(req, res) => {
		if(req.query.package===PUBLIC_APP_PACKAGE&&gateway.enabled){
			if(!await gateway.status())return res.status(503).json({error:'Tellybox notifications are temporarily unavailable. Background alerts remain available.'});
			return res.json({enabled:true,mode:'gateway',gateway:PUSH_GATEWAY,package:PUBLIC_APP_PACKAGE});
		}
		res.json(pushClient(config,req.query.package));
	});
	app.post('/api/apps/push/ticket',writeCheck,admin,async(req,res)=>{
		const device=record(req);if(!device||device.role!=='admin')return res.sendStatus(403);
		if(!gateway.enabled||(req.body.package&&req.body.package!==PUBLIC_APP_PACKAGE))return res.status(409).json({error:'HomeLab notifications are not enabled.'});
		res.json(await gateway.ticket(device.id));
	});
	app.post('/api/apps/push/register', writeCheck, admin, async(req, res) => {
		const device = record(req); if (!device || device.role !== 'admin') return res.sendStatus(403);
		if (req.body.enabled === false) {
			const previous=registrations.get()[device.id];delete registrations.get()[device.id];registrations.save();
			if(previous?.mode==='gateway')await gateway.revoke(previous.handle);
			return res.json({ok:true});
		}
		const packageId=req.body.package ?? 'uk.co.jimbos.jserver';
		const { token, types } = req.body;
		if(!Array.isArray(types)||types.length>notificationTypes.length||types.some(t=>!notificationTypes.includes(t)))return res.status(400).json({error:'Invalid notification preferences.'});
		if(packageId===PUBLIC_APP_PACKAGE&&gateway.enabled) {
			if(token!==undefined||!await gateway.verify(req.body.handle,device.id))return res.status(400).json({error:'Complete notification verification in the app first.'});
			const current=record(req);if(!current||current.id!==device.id||current.role!=='admin')return res.sendStatus(403);
			if(!registrations.get()[device.id]&&Object.keys(registrations.get()).length>=128)return res.status(409).json({error:'Too many notification devices are registered.'});
			const previous=registrations.get()[device.id];
			registrations.get()[device.id]={mode:'gateway',package:packageId,handle:req.body.handle,types:[...new Set(types)]};registrations.save();
			if(previous?.mode==='gateway'&&previous.handle!==req.body.handle)await gateway.revoke(previous.handle);
			return res.json({ok:true});
		}
		if(!pushClient(config,packageId).enabled)return res.status(409).json({error:'Push is not configured for this app edition. Background alerts remain available.'});
		if (typeof token !== 'string' || token.length < 20 || token.length > 4096 || /\s/.test(token) || !Array.isArray(types) || types.some(t => !notificationTypes.includes(t))) return res.status(400).json({ error: 'Invalid notification registration.' });
		const previous=registrations.get()[device.id];
		registrations.get()[device.id] = { token, types: [...new Set(types)],package:packageId }; registrations.save();
		if(previous?.mode==='gateway')await gateway.revoke(previous.handle);
		res.json({ ok: true });
	});
	audit?.subscribe(event => { if ((config||gateway.enabled) && notificationTypes.includes(event.type)) { if (queue.length < 100) queue.push({ id: event.id, type: event.type }); void drain(); } });
}
