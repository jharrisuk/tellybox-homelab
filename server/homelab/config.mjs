import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { isIP, BlockList } from 'node:net';
import { createHash, createPrivateKey } from 'node:crypto';
import { services } from './services.mjs';

const fail = message => Object.assign(Error(message), { status: 400 });
export function defaultConfig() {
	return { version: 1, revision: 0, apps: { edition: 'public', packageName: '' }, network: { publicOrigin: '', localOrigin: '', localNetworks: [], localHosts: ['localhost', '127.0.0.1'], trustedProxies: [], homeTrustedProxy: '', homeIpEndpoint: '', clientIpHeader: 'x-forwarded-for' }, services: Object.fromEntries(services.map(s => [s.id, { enabled: false }])) };
}
export function serviceUrl(value, { optional = false, https = false, originOnly = false } = {}) {
	if (!value && optional) return '';
	if (typeof value !== 'string' || value.length > 500) throw fail('Enter a valid service address.');
	let url; try { url = new URL(value); } catch { throw fail('Include http:// or https:// in the address.'); }
	if (!(https ? ['https:'] : ['http:', 'https:']).includes(url.protocol) || url.username || url.password || url.hash || url.search) throw fail('Use an HTTP(S) address without credentials, query parameters or fragments.');
	if (/^(169\.254\.|0\.|metadata\.|metadata$|\[?fe80:)/i.test(url.hostname)) throw fail('Metadata and link-local service addresses are not allowed.');
	if (originOnly && url.pathname !== '/') throw fail('Use the origin only, without a path.');
	return url.href.replace(/\/$/, '');
}
function list(value, validator, label) {
	if (!Array.isArray(value) || value.length > 32 || value.some(v => typeof v !== 'string' || !validator(v))) throw fail('Check ' + label + '.');
	return [...new Set(value)];
}
function subnet(value) {
	try { const [ip, bits] = value.split('/'); if (!isIP(ip) || !/^\d+$/.test(bits || '')) return false; const n = Number(bits); if (n < 8) return false; new BlockList().addSubnet(ip, n, isIP(ip) === 4 ? 'ipv4' : 'ipv6'); return true; } catch { return false; }
}
export function validateConfig(input, previous = defaultConfig()) {
	if (!input || typeof input !== 'object' || Array.isArray(input)) throw fail('Invalid configuration.');
	const result = defaultConfig(), net = input.network || {};
	result.revision = previous.revision + 1;
	if(input.apps!==undefined&&(!input.apps||typeof input.apps!=='object'||Array.isArray(input.apps)))throw fail('Choose an app download edition.');
	const edition=input.apps?.edition??previous.apps?.edition??'public';
	if(!['public','personal'].includes(edition))throw fail('Choose HomeLab or Custom app downloads.');
	const packageName=input.apps?.packageName??previous.apps?.packageName??'';
	if(typeof packageName!=='string'||(edition==='personal'&&(packageName.length>200||!/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/.test(packageName)||packageName.toLowerCase()==='app.tellybox.homelab')))throw fail('Custom apps need their own Android application ID.');
	result.apps={edition,packageName:edition==='personal'?packageName:''};
	result.network = {
		publicOrigin: serviceUrl(net.publicOrigin || '', { optional: true, https: true, originOnly: true }),
		localOrigin: serviceUrl(net.localOrigin || '', { optional: true, originOnly: true }),
		localNetworks: list(net.localNetworks || [], subnet, 'local network ranges'),
		localHosts: list(net.localHosts || [], v => /^[a-zA-Z0-9.:[\]-]{1,253}$/.test(v), 'local hostnames'),
		trustedProxies: list(net.trustedProxies || [], isIP, 'trusted proxy IP addresses'),
		homeTrustedProxy: net.homeTrustedProxy || '',
		homeIpEndpoint: serviceUrl(net.homeIpEndpoint || '', { optional: true, https: true }),
		clientIpHeader: net.clientIpHeader || 'x-forwarded-for'
	};
	if (!['x-forwarded-for','x-real-ip','cf-connecting-ip'].includes(result.network.clientIpHeader)) throw fail('Choose a supported client IP header.');
	const homeProxies=result.network.homeTrustedProxy.split(',').map(value=>value.trim()).filter(Boolean);
	if (homeProxies.some(ip=>!result.network.trustedProxies.includes(ip))) throw fail('Every home proxy must be in the trusted proxy list.');
	result.network.homeTrustedProxy=[...new Set(homeProxies)].join(',');
	for (const spec of services) {
		const candidate = input.services?.[spec.id] || (spec.id==='pushGateway'?{enabled:false}:{}), old = previous.services[spec.id] || {};
		if (typeof candidate.enabled !== 'boolean') throw fail('Choose whether ' + spec.name + ' is enabled.');
		const output = { enabled: candidate.enabled };
		if(spec.sameServerUrl) {
			if(candidate.onThisServer!==undefined&&typeof candidate.onThisServer!=='boolean')throw fail('Choose whether '+spec.name+' runs on this server.');
			output.onThisServer=candidate.onThisServer===true;
			const manual=output.onThisServer?(candidate.manualUrl??old.manualUrl??(!old.onThisServer?old.url:'')):(candidate.url||'');
			output.manualUrl=serviceUrl(manual||'',{optional:true,originOnly:true});
		}
		for (const f of spec.fields) {
			let value = candidate[f.key];
			if(f.key==='url'&&output.onThisServer&&!value)value=spec.sameServerUrl;
			if (f.type === 'secret' && (value === undefined || value === '')) value = old[f.key] || '';
			if (f.type === 'boolean') { output[f.key] = value === true; continue; }
			if (value === undefined) value = '';
			if (typeof value !== 'string' || value.length > 4096 || /[\x00-\x1f]/.test(value)) throw fail('Check ' + spec.name + ': ' + f.label + '.');
			if (f.type !== 'secret') value = value.trim();
			if (output.enabled && f.required && !value) throw fail(spec.name + ' needs ' + f.label.toLowerCase() + '.');
			if (f.type === 'url' && value) value = serviceUrl(value, { originOnly: true });
			output[f.key] = value;
		}
		if (spec.id === 'dispatcharr') {
			// The physical address and the media execution are separate. Exactly
			// three user choices are accepted; only On relay selects execution relay.
			let location = candidate.location;
			if (location !== undefined && !['onThisServer', 'relay', 'anotherServer'].includes(location)) throw fail('Choose On this server, On relay or Another server.');
			if (location === undefined) location = candidate.onThisServer === true ? 'onThisServer' : candidate.onThisServer === false ? 'anotherServer' : old.location || (candidate.url ? 'anotherServer' : 'onThisServer');
			const manual = candidate.manualUrl ?? old.manualUrl ?? (!old.onThisServer ? old.url : '');
			if (location === 'onThisServer') {
				output.onThisServer = true;
				output.url = candidate.url || old.location === 'onThisServer' && old.url || spec.sameServerUrl;
				output.manualUrl = serviceUrl(manual || '', { optional: true, originOnly: true });
				output.execution = 'main';
			} else if (location === 'relay') {
				output.onThisServer = false;
				output.execution = 'relay';
				output.relayMetadataUrl = serviceUrl(candidate.relayMetadataUrl || output.relayMetadataUrl || '', { optional: true, originOnly: true });
				output.relayUrl = serviceUrl(candidate.relayUrl || old.relayUrl || 'http://host.containers.internal:9191', { originOnly: true });
				output.url = output.relayMetadataUrl;
				output.manualUrl = serviceUrl(manual || '', { optional: true, originOnly: true });
				if (output.enabled && !output.relayMetadataUrl) throw fail('On relay needs the checked relay metadata address. Register and check the relay first.');
				if (output.enabled && !result.network.publicOrigin) throw fail('On relay needs your public HTTPS address so viewers can reach the relay media prefix.');
			} else {
				output.onThisServer = false;
				output.execution = 'main';
				output.url = serviceUrl(candidate.url || '', { optional: true, originOnly: true });
				output.manualUrl = output.url;
				if (output.enabled && !output.url) throw fail('Another server needs its server address.');
			}
			output.location = location;
			if (output.enabled && !['live', 'vod', 'recordings', 'catchup'].some(key => output[key] === true)) throw fail('Choose at least one Dispatcharr feature.');
			if (output.location !== 'relay' && output.execution !== 'main') throw fail('Only On relay can use relay media execution.');
		}
		result.services[spec.id] = output;
	}
	const s = result.services;
	if(s.pushGateway.enabled&&s.firebase.enabled)throw fail('Choose Standard Tellybox HomeLab or Custom Firebase notifications, not both.');
	for (const id of ['sonarr','radarr']) {
		const prefix=s.seerr, fields=['ServerId','ProfileId','RootFolder'].map(key=>prefix[id+key]);
		if (fields.some(Boolean) && (!fields.every(Boolean)||!/^\d+$/.test(fields[0])||!/^\d+$/.test(fields[1]))) throw fail('Complete the Seerr '+id+' request destination, profile and folder together.');
	}
	if (s.jellyfin.enabled && !/^[a-f0-9-]{32,36}$/i.test(s.jellyfin.userId)) throw fail('Use the Jellyfin viewer user ID, not its name.');
	if (s.dispatcharr.enabled && (s.dispatcharr.vod || s.dispatcharr.recordings || s.dispatcharr.catchup) && !s.dispatcharr.key) throw fail('Dispatcharr catalogue, recordings and catch-up need a personal API key.');
	if (s.dispatcharr.enabled && (s.dispatcharr.recordings || s.dispatcharr.catchup) && !s.dispatcharr.live) throw fail('Enable live channels to use recordings or catch-up.');
	if (s.opensubtitles.enabled && Boolean(s.opensubtitles.username) !== Boolean(s.opensubtitles.password)) throw fail('Add both OpenSubtitles username and password, or neither.');
	if (s.resend.enabled && (!result.network.publicOrigin || !/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(s.resend.from) || /@resend\.dev$/i.test(s.resend.from))) throw fail('Resend needs a public HTTPS address and an email on your verified sender domain.');
	if (s.firebase.enabled) {
		const f = s.firebase;
		const appIds=[f.applicationId,f.publicApplicationId].filter(Boolean);
		if (!/^[a-z][a-z0-9-]{4,60}$/.test(f.projectId) || !/^\d{5,20}$/.test(f.senderId) || !appIds.length || appIds.some(id=>!/^1:\d+:android:[a-f0-9]+$/.test(id)||!id.startsWith('1:' + f.senderId + ':android:'))) throw fail('Check the Firebase project, sender ID and Android app IDs.');
		try {
			const account = JSON.parse(f.serviceAccount);
			if (account.type !== 'service_account' || account.project_id !== f.projectId || !account.client_email?.endsWith('@' + f.projectId + '.iam.gserviceaccount.com') || createPrivateKey(account.private_key).asymmetricKeyType !== 'rsa') throw Error();
			f.serviceAccount = JSON.stringify({ type: account.type, project_id: account.project_id, client_email: account.client_email, private_key: account.private_key });
		} catch { throw fail('Choose a valid Firebase service-account JSON file for the same project.'); }
	}
	return result;
}
export function redacted(config) {
	const result = structuredClone(config);
	for (const spec of services) {
		const data = result.services[spec.id];
		for (const f of spec.fields.filter(f => f.type === 'secret')) { data[f.key + 'Saved'] = Boolean(data[f.key]); delete data[f.key]; }
	}
	return result;
}
export function capabilities(config) {
	const s = config.services;
	return { library: s.jellyfin.enabled || (s.dispatcharr.enabled && s.dispatcharr.vod), jellyfin: s.jellyfin.enabled,
		live: s.dispatcharr.enabled && s.dispatcharr.live, nonstop: s.dispatcharr.enabled && s.dispatcharr.live,
		vod: s.dispatcharr.enabled && s.dispatcharr.vod, recordings: s.dispatcharr.enabled && s.dispatcharr.recordings,
		catchup: s.dispatcharr.enabled && s.dispatcharr.catchup, discover: s.seerr.enabled,
		relayMedia: s.dispatcharr.enabled && s.dispatcharr.location === 'relay',
		comingSoon: s.sonarr.enabled || s.radarr.enabled, subtitles: s.opensubtitles.enabled, introdb: s.introdb.enabled };
}
export function atomicJson(file, value) {
	mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	writeFileSync(file + '.tmp', JSON.stringify(value, null, '\t') + '\n', { mode: 0o600 });
	renameSync(file + '.tmp', file);
}
export function configStore(directory) {
	const file = path.join(directory, 'configuration.json');
	let current;
	try { current = JSON.parse(readFileSync(file, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw Error('Configuration could not be read; refusing to reset it.'); current = defaultConfig(); }
	if (current.version !== 1 || !current.services || !current.network) throw Error('Unsupported configuration; refusing to reset it.');
	current.services = { ...defaultConfig().services, ...current.services };
	current.apps = current.apps || defaultConfig().apps;
	return { get: () => structuredClone(current), save(input) {
		if (input.revision !== current.revision) throw Object.assign(Error('Configuration changed. Reload before saving.'), { status: 409 });
		const next = validateConfig(input, current); atomicJson(file, next); current = next; return redacted(next);
	} };
}

export function materialize(config, directory) {
	const data = path.join(directory, 'media'), auth = path.join(directory, 'access'), s = config.services;
	mkdirSync(data, { recursive: true, mode: 0o700 }); mkdirSync(auth, { recursive: true, mode: 0o700 });
	const sourceId = createHash('sha256').update(JSON.stringify([s.jellyfin.url || '', s.jellyfin.userId || '', s.dispatcharr.url || '', s.dispatcharr.key || ''])).digest('hex').slice(0, 24);
	const cache = path.join(directory, 'catalogues', sourceId); mkdirSync(cache, { recursive: true, mode: 0o700 });
	const write = (dir, file, value) => atomicJson(path.join(dir, file), value);
	write(data, 'connection.json', s.jellyfin.enabled ? { token: s.jellyfin.key, userId: s.jellyfin.userId } : {});
	const requests=Object.fromEntries(['sonarr','radarr'].filter(id=>s.seerr[id+'RootFolder']).map(id=>[id,{serverId:Number(s.seerr[id+'ServerId']),profileId:Number(s.seerr[id+'ProfileId']),rootFolder:s.seerr[id+'RootFolder']}]));
	write(data, 'seerr.json', s.seerr.enabled ? { url: s.seerr.url, key: s.seerr.key, specials:s.seerr.specials===true, ...requests } : {});
	write(data, 'insights.json', Object.fromEntries(['sonarr', 'radarr'].filter(id => s[id].enabled).map(id => [id, { url: s[id].url, key: s[id].key }])));
	write(auth, 'dispatcharr.json', s.dispatcharr.enabled ? { key: s.dispatcharr.key || '' } : {});
	write(auth, 'relay-media.json', s.dispatcharr.enabled && s.dispatcharr.location === 'relay'
		? { enabled: true, workerUpstreamUrl: s.dispatcharr.relayUrl || '', workerKey: s.dispatcharr.relayKey || '', metadataUrl: s.dispatcharr.relayMetadataUrl || '' }
		: { enabled: false });
	write(auth, 'opensubtitles.json', { ...(s.opensubtitles.enabled ? s.opensubtitles : {}), enabled: s.opensubtitles.enabled });
	write(auth, 'email.json', { ...(s.resend.enabled ? s.resend : {}), enabled: s.resend.enabled });
	write(auth, 'firebase-client.json', s.firebase.enabled ? { projectId: s.firebase.projectId, applicationId: s.firebase.applicationId, ...(s.firebase.publicApplicationId?{publicApplicationId:s.firebase.publicApplicationId}:{}), senderId: s.firebase.senderId, apiKey: s.firebase.apiKey } : {});
	write(auth, 'firebase-service-account.json', s.firebase.enabled ? JSON.parse(s.firebase.serviceAccount) : {});
	write(auth, 'push-gateway.json', {enabled:s.pushGateway?.enabled===true});
	write(data, 'capabilities.json', capabilities(config));
	const n = config.network;
	return { HOMELAB: '1', TELLYBOX_APP_EDITION: config.apps?.edition || 'public', TELLYBOX_APP_PACKAGE: config.apps?.edition==='personal'?config.apps.packageName||'':'', DATA_DIR: data, AUTH_DIR: auth, CATALOGUE_CACHE_DIR: cache, TRENDING_CACHE_PATH: path.join(cache, 'trending-cache.json'), JELLYFIN_URL: s.jellyfin.enabled ? s.jellyfin.url : 'http://127.0.0.1:1',
		RELAY_STATE_DIR: directory, RELAY_MEDIA_ENABLED: s.dispatcharr.enabled && s.dispatcharr.location === 'relay' ? '1' : '0',
		DISPATCHARR_URL: s.dispatcharr.enabled ? s.dispatcharr.url : 'http://127.0.0.1:1', PUBLIC_ORIGIN: n.publicOrigin,
		LOCAL_PLAYBACK_ORIGIN: n.localOrigin || 'http://127.0.0.1:8082', LOCAL_NETWORKS: n.localNetworks.join(','), LOCAL_HOSTS: n.localHosts.join(','),
		TRUSTED_PROXIES: n.trustedProxies.join(','), HOME_TRUSTED_PROXY: n.homeTrustedProxy, HOME_IP_ENDPOINT: n.homeIpEndpoint,
		CLIENT_IP_HEADER: n.clientIpHeader || 'x-forwarded-for', INTRODB_ENABLED: s.introdb.enabled ? '1' : '0' };
}
