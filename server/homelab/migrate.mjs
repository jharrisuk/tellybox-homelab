import { readFileSync, writeFileSync, mkdirSync, readdirSync, lstatSync, existsSync, copyFileSync, openSync, readSync, closeSync, chmodSync, constants } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { defaultConfig, validateConfig, atomicJson, materialize } from './config.mjs';
import { isSameServerAddress } from './public/service-location.mjs';

const read = (directory, name) => {
	try { return JSON.parse(readFileSync(path.join(directory, name), 'utf8')); }
	catch (error) { if (error.code === 'ENOENT') return {}; throw Error('Cannot import ' + name + '; source files were not changed.'); }
};
const csv = value => String(value || '').split(',').map(v => v.trim()).filter(Boolean);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
function fileDigest(filename) {
	const file=openSync(filename,'r'), hash=createHash('sha256'), buffer=Buffer.allocUnsafe(1024*1024);
	try { let count; while((count=readSync(file,buffer,0,buffer.length,null)))hash.update(buffer.subarray(0,count)); }
	finally { closeSync(file); }
	return hash.digest('hex');
}
function assetFiles(source, relative='') {
	const files=[];
	for(const name of readdirSync(path.join(source,relative))) {
		const item=path.join(relative,name), stat=lstatSync(path.join(source,item));
		if(stat.isSymbolicLink()||(!stat.isFile()&&!stat.isDirectory()))throw Error('Refusing a linked or special runtime asset.');
		if(stat.isDirectory())files.push(...assetFiles(source,item));
		else if(!name.endsWith('.tmp'))files.push(item);
	}
	return files;
}

/** Offline import only. Never starts services, sends messages or modifies the source. */
export function migrateLegacy({ mediaDirectory, accessDirectory, directory, environment = {}, localOrigin, dispatcharrUrl }) {
	const destination = path.resolve(directory), media = path.resolve(mediaDirectory), access = path.resolve(accessDirectory);
	for (const source of [media, access]) {
		const relative = path.relative(source, destination);
		if (!relative || (!relative.startsWith('..' + path.sep) && !path.isAbsolute(relative))) throw Error('Choose a new directory outside the existing installation.');
	}
	if (existsSync(destination)) throw Error('Migration destination already exists; refusing to overwrite it.');
	const config = defaultConfig(), s = config.services;
	config.apps={edition:'personal',packageName:'uk.co.jimbos.jserver'};
	const connection = read(media, 'connection.json'), seerr = read(media, 'seerr.json'), insights = read(media, 'insights.json');
	const dispatcharr = read(access, 'dispatcharr.json'), subtitles = read(access, 'opensubtitles.json'), email = read(access, 'email.json');
	const firebase = read(access, 'firebase-client.json'), account = read(access, 'firebase-service-account.json');
	config.network = {
		publicOrigin: environment.PUBLIC_ORIGIN || '', localOrigin: environment.LOCAL_PLAYBACK_ORIGIN || localOrigin || '',
		localNetworks: csv(environment.LOCAL_NETWORKS), localHosts: csv(environment.LOCAL_HOSTS),
		trustedProxies: csv(environment.TRUSTED_PROXIES), homeTrustedProxy: environment.HOME_TRUSTED_PROXY || '',
		homeIpEndpoint: environment.HOME_IP_ENDPOINT || '', clientIpHeader: environment.CLIENT_IP_HEADER || 'x-forwarded-for'
	};
	if (connection.token) s.jellyfin = { enabled: true, url: environment.JELLYFIN_URL || '', key: connection.token, userId: connection.userId || '' };
	if ((dispatcharr.access || dispatcharr.refresh) && !dispatcharr.key) throw Error('Import needs a Dispatcharr personal API key; the current sign-in has not been changed.');
	if (dispatcharr.key) s.dispatcharr = { enabled: true, url: environment.DISPATCHARR_URL || dispatcharrUrl || '', key: dispatcharr.key, live: true, vod: true, recordings: true, catchup: true };
	if (seerr.key) {
		s.seerr = { enabled: true, url: seerr.url, key: seerr.key, specials: seerr.specials === true };
		for (const id of ['sonarr', 'radarr']) if (seerr[id]) for (const field of ['serverId', 'profileId', 'rootFolder']) {
			s.seerr[id + field[0].toUpperCase() + field.slice(1)] = String(seerr[id][field] ?? '');
		}
	}
	for (const id of ['sonarr', 'radarr']) if (insights[id]?.key) s[id] = { enabled: true, url: insights[id].url, key: insights[id].key };
	if (subtitles.key) s.opensubtitles = { ...subtitles, enabled: subtitles.enabled !== false };
	s.introdb = { enabled: environment.INTRODB_ENABLED !== '0' };
	if (email.key) s.resend = { ...email, enabled: email.enabled === true };
	if (firebase.projectId || account.private_key) s.firebase = { enabled: true, ...firebase, serviceAccount: JSON.stringify(account) };
	for (const id of ['jellyfin', 'dispatcharr', 'seerr', 'sonarr', 'radarr']) {
		if (isSameServerAddress(s[id].url, config.network.localOrigin)) s[id].onThisServer = true;
	}
	const checked = validateConfig(config);
	// Validate all JSON before creating a destination, never silently drop a corrupt database.
	const copies = [];
	for (const [source, subdirectory] of [[media, 'media'], [access, 'access']]) for (const name of readdirSync(source)) {
		if (!name.endsWith('.json')) continue;
		const filename = path.join(source, name);
		if (!lstatSync(filename).isFile()) throw Error('Refusing a linked runtime file: ' + name);
		const bytes = readFileSync(filename); JSON.parse(bytes.toString('utf8'));
		copies.push({ name, subdirectory, bytes });
	}
	// These are application assets, not films or recordings. Validate the trees before copying.
	const assets=[];
	for(const [source,subdirectory,name] of [[media,'media','app-updates'],[access,'access','subtitle-cache']]) {
		const from=path.join(source,name);if(!existsSync(from))continue;
		if(!lstatSync(from).isDirectory()||lstatSync(from).isSymbolicLink())throw Error('Refusing a linked runtime asset directory.');
		for(const item of assetFiles(from))assets.push({from:path.join(from,item),relative:path.join(subdirectory,name,item)});
	}
	mkdirSync(destination, { mode: 0o700 });
	const env = materialize(checked, destination);
	const generated = new Set(['media/connection.json','media/seerr.json','media/insights.json','access/dispatcharr.json','access/opensubtitles.json','access/email.json','access/firebase-client.json','access/firebase-service-account.json']);
	const catalogue = new Set(['nonstop-metadata.json','dispatcharr-guide.json','trending-cache.json','series-links.json','vod-catalogue.json','vod-catalogue.json.series.json','vod-metadata.json']);
	const retained = [];
	for (const file of copies) {
		const relative = file.subdirectory + '/' + file.name;
		if (generated.has(relative)) continue;
		const target = path.join(file.subdirectory === 'access' && catalogue.has(file.name) ? env.CATALOGUE_CACHE_DIR : path.join(destination, file.subdirectory), file.name);
		writeFileSync(target, file.bytes, { mode: 0o600, flag: 'wx' });
		if (digest(readFileSync(target)) !== digest(file.bytes)) throw Error('Migration verification failed. Do not apply this copy.');
		retained.push({ file: path.relative(destination, target).split(path.sep).join('/'), sha256: digest(file.bytes) });
	}
	for(const asset of assets) {
		const target=path.join(destination,asset.relative);mkdirSync(path.dirname(target),{recursive:true,mode:0o700});
		const before=fileDigest(asset.from);copyFileSync(asset.from,target,constants.COPYFILE_EXCL);chmodSync(target,0o600);
		if(fileDigest(target)!==before||fileDigest(asset.from)!==before)throw Error('Runtime assets changed during migration. Freeze writes and prepare a new copy.');
		retained.push({file:asset.relative.split(path.sep).join('/'),sha256:before});
	}
	atomicJson(path.join(destination, 'configuration.json'), checked);
	const report = { version: 1, status: 'prepared-not-applied', created: new Date().toISOString(),
		services: Object.entries(checked.services).filter(([,value]) => value.enabled).map(([key]) => key), preservedFiles: retained,
		sourceChanged: false, applied: false, requiresFinalSnapshot: true };
	atomicJson(path.join(destination, 'migration-report.json'), report);
	return report;
}
