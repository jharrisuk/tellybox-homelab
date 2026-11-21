import express from 'express';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const centralDownloads='https://homelab.tellyboxapp.com/downloads/';
const MAX_APK=128*1024*1024;
const MANIFEST_LIMIT=16384;
const flavours=['phone','tv'];

/** The configured origin a download link may advertise; an HTTPS origin always wins. */
function installationOrigin() {
	const configured=[process.env.PUBLIC_ORIGIN,process.env.LOCAL_PLAYBACK_ORIGIN].filter(Boolean), origins=[];
	for(const value of configured) {
		let origin;
		try {origin=new URL(value);} catch {throw Error('Invalid installation origin');}
		if(!['http:','https:'].includes(origin.protocol)||origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash)throw Error('Invalid installation origin');
		origins.push(origin);
	}
	const secure=origins.find(origin=>origin.protocol==='https:');
	if(secure)return secure;
	if(origins.length)return origins[0];
	throw Error('Configure an installation address before publishing updates.');
}

function unavailable() {
	const error=Error('Personal APK is unavailable');
	error.reconcile=true;
	return error;
}

function readManifest(directory,io) {
	const manifest=path.join(directory,'latest.json');
	if(io.stat(manifest).size>MANIFEST_LIMIT)throw Error('Invalid release manifest');
	return JSON.parse(io.readFile(manifest,'utf8'));
}

/**
 * One strict shape for every manifest entry. The latest.json routes tolerate an older manifest
 * that omits package/version/bytes fields, but any field that is present is checked exactly as
 * downloads.json checks it. downloads.json additionally requires a complete entry and the APK.
 */
function releaseFile(entry,flavour,{packageName,publicPath=false,requireComplete=false,io=null,directory=''}) {
	if(!entry||typeof entry!=='object'||Array.isArray(entry))throw Error('Invalid release');
	if(entry.package!==undefined&&entry.package!==packageName)throw Error('Wrong edition');
	if(entry.flavour!==undefined&&entry.flavour!==flavour)throw Error('Wrong edition');
	if(entry.versionCode!==undefined&&(!Number.isSafeInteger(entry.versionCode)||entry.versionCode<1||entry.versionCode>2147483647))throw Error('Invalid release version');
	if(entry.versionName!==undefined&&(typeof entry.versionName!=='string'||entry.versionName.length>40||!/^\d+(?:\.\d+){1,3}$/.test(entry.versionName)))throw Error('Invalid release version');
	if(entry.bytes!==undefined&&(!Number.isSafeInteger(entry.bytes)||entry.bytes<1||entry.bytes>MAX_APK))throw Error('Invalid release size');
	if(entry.sha256!==undefined&&(typeof entry.sha256!=='string'||!/^[a-f0-9]{64}$/.test(entry.sha256)))throw Error('Invalid release checksum');
	if(requireComplete&&(entry.package!==packageName||entry.flavour!==flavour||entry.versionCode===undefined||entry.versionName===undefined||entry.bytes===undefined||entry.sha256===undefined))throw Error('Invalid release');
	let url;
	try {url=new URL(entry.url);} catch {throw Error('Invalid release URL');}
	if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)throw Error('Invalid release URL');
	const filename=path.posix.basename(url.pathname);
	if(!new RegExp('^Tellybox-'+flavour+'-[0-9.]+\\.apk$').test(filename))throw Error('Invalid release URL');
	if(entry.versionName!==undefined&&filename!==`Tellybox-${flavour}-${entry.versionName}.apk`)throw Error('Invalid release URL');
	const exact='/app-updates/'+filename, published='/app-updates/public/'+filename;
	if(publicPath?url.pathname!==published&&url.pathname!==exact:url.pathname!==exact)throw Error('Invalid release URL');
	if(requireComplete) {
		let file;
		try {file=io.stat(path.join(directory,filename));}
		catch(error) {if(error.code==='ENOENT')throw unavailable();throw error;}
		if(!file.isFile()||file.size!==entry.bytes)throw unavailable();
	}
	return filename;
}

export function adminDownloads(directory,io={readFile:readFileSync,stat:statSync}) {
	const edition=process.env.TELLYBOX_APP_EDITION||'public';
	if(edition==='public')return {edition:'homelab',...Object.fromEntries(flavours.map(flavour=>[flavour,{package:'app.tellybox.homelab',flavour,url:centralDownloads+`Tellybox-${flavour}-latest.apk`}]))};
	if(edition!=='personal')throw Error('Invalid app edition');
	const packageName=process.env.TELLYBOX_APP_PACKAGE||'';
	if(packageName.length>200||!/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/.test(packageName)||packageName.toLowerCase()==='app.tellybox.homelab')throw Error('Configure a custom application ID');
	const origin=installationOrigin();
	let feed=readManifest(directory,io);
	const build=()=>{
		if(!feed||typeof feed!=='object'||Array.isArray(feed))throw Error('Invalid release manifest');
		const result={edition:'personal',packageName}, files={};
		for(const flavour of flavours)files[flavour]=releaseFile(feed[flavour],flavour,{packageName,requireComplete:true,io,directory});
		for(const flavour of flavours)result[flavour]={package:packageName,flavour,versionName:feed[flavour].versionName,versionCode:feed[flavour].versionCode,bytes:feed[flavour].bytes,url:origin.origin+'/app-updates/'+files[flavour]};
		return result;
	};
	try {return build();}
	catch(error) {
		// A publication can replace latest.json and its APK between two reads. One fresh read
		// makes the endpoint idempotent instead of failing until the next request.
		if(!error.reconcile)throw error;
		feed=readManifest(directory,io);
		return build();
	}
}

// Only published binaries and their manifest are public. No device token is needed.
export function installAppUpdates(app, directory) {
	app.get('/app-updates/downloads.json',(req,res)=>{
		res.set('Cache-Control','no-store').set('X-Content-Type-Options','nosniff');
		try {res.json(adminDownloads(directory));}
		catch {res.status(503).json({error:'App downloads are temporarily unavailable.'});}
	});
	for(const edition of ['', 'public/']) {
	const base='/app-updates/'+edition, storage=path.join(directory,edition);
	app.get(base+'latest.json', (req, res, next) => {
		try {
			const feed = readManifest(storage,{readFile:readFileSync,stat:statSync});
			if (!feed || typeof feed !== 'object' || Array.isArray(feed)) throw Error('Invalid release manifest');
			const origin = installationOrigin();
			const expected=edition?'app.tellybox.homelab':process.env.TELLYBOX_APP_PACKAGE||'uk.co.jimbos.jserver';
			for (const flavour of flavours) if (feed[flavour] !== undefined) {
				const filename = releaseFile(feed[flavour],flavour,{packageName:expected,publicPath:Boolean(edition),requireComplete:false});
				feed[flavour].url = origin.origin + base + filename;
			}
			res.set('Cache-Control', 'no-store').set('X-Content-Type-Options', 'nosniff').json(feed);
		} catch (error) { if (error.code === 'ENOENT') return next(); res.status(503).json({ error: 'Updates are temporarily unavailable.' }); }
	});
	}
	app.use('/app-updates', (req, res, next) => {
		if (!['GET', 'HEAD'].includes(req.method)) return res.sendStatus(405);
		if (!/^\/(?:public\/)?(latest\.json|Tellybox-(phone|tv)-[0-9.]+\.apk)$/.test(req.path)) return res.sendStatus(404);
		res.setHeader('Cache-Control', 'no-store');
		res.setHeader('X-Content-Type-Options', 'nosniff');
		if (req.path.endsWith('.apk')) {
			res.type('application/vnd.android.package-archive');
			res.setHeader('Content-Disposition', 'attachment');
		}
		next();
	}, express.static(directory, { dotfiles:'deny', index:false, redirect:false, fallthrough:false, cacheControl:false }));
}
