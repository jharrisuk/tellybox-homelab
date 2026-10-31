import express from 'express';
import { readFileSync, statSync } from 'node:fs';
import path from 'node:path';

const centralDownloads='https://homelab.tellyboxapp.com/downloads/';
function adminDownloads(directory) {
	const edition=process.env.TELLYBOX_APP_EDITION||'public';
	if(edition==='public')return {edition:'homelab',...Object.fromEntries(['phone','tv'].map(flavour=>[flavour,{package:'app.tellybox.homelab',flavour,url:centralDownloads+`Tellybox-${flavour}-latest.apk`}]))};
	if(edition!=='personal')throw Error('Invalid app edition');
	const packageName=process.env.TELLYBOX_APP_PACKAGE||'';
	if(packageName.length>200||!/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/.test(packageName)||packageName.toLowerCase()==='app.tellybox.homelab')throw Error('Configure a custom application ID');
	const manifest=path.join(directory,'latest.json');
	if(statSync(manifest).size>16384)throw Error('Invalid release manifest');
	const feed=JSON.parse(readFileSync(manifest,'utf8'));
	const origin=new URL(process.env.PUBLIC_ORIGIN||process.env.LOCAL_PLAYBACK_ORIGIN||'');
	if(!['http:','https:'].includes(origin.protocol)||origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash)throw Error('Invalid installation origin');
	const result={edition:'personal',packageName};
	for(const flavour of ['phone','tv']) {
		const entry=feed?.[flavour];
		if(!entry||entry.package!==packageName||entry.flavour!==flavour||
			!Number.isSafeInteger(entry.versionCode)||entry.versionCode<1||!/^\d+(?:\.\d+){1,3}$/.test(entry.versionName||'')||
			!Number.isSafeInteger(entry.bytes)||entry.bytes<1||!/^[a-f0-9]{64}$/.test(entry.sha256||''))throw Error('Invalid personal release');
		const filename=`Tellybox-${flavour}-${entry.versionName}.apk`, url=new URL(entry.url);
		if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash||url.pathname!=='/app-updates/'+filename)throw Error('Invalid personal APK URL');
		const file=statSync(path.join(directory,filename));
		if(!file.isFile()||file.size!==entry.bytes)throw Error('Personal APK is unavailable');
		result[flavour]={package:entry.package,flavour,versionName:entry.versionName,versionCode:entry.versionCode,bytes:entry.bytes,url:origin.origin+'/app-updates/'+filename};
	}
	return result;
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
			const feed = JSON.parse(readFileSync(path.join(storage, 'latest.json'), 'utf8'));
			const origin = process.env.PUBLIC_ORIGIN || process.env.LOCAL_PLAYBACK_ORIGIN;
			if (!origin || !/^https?:\/\//.test(origin)) throw Error('Configure an installation address before publishing updates.');
			for (const flavour of ['phone', 'tv']) if (feed[flavour]) {
				const route = new URL(feed[flavour].url).pathname;
				if (!/^\/app-updates\/(?:public\/)?Tellybox-(phone|tv)-[0-9.]+\.apk$/.test(route)) throw new Error('Invalid update file');
				const expected=edition?'app.tellybox.homelab':process.env.TELLYBOX_APP_PACKAGE||'uk.co.jimbos.jserver';
				if(feed[flavour].package&&feed[flavour].package!==expected)throw Error('Wrong edition');
				feed[flavour].url = origin + base + path.posix.basename(route);
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
