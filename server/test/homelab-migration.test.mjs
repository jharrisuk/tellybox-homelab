import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultConfig, atomicJson, configStore, materialize } from '../homelab/config.mjs';
import { migrateLegacy } from '../homelab/migrate.mjs';
import { createApplyController } from '../homelab/apply.mjs';

const json = file => JSON.parse(readFileSync(file, 'utf8'));
function fixture(t) {
	const directory = mkdtempSync(path.join(os.tmpdir(), 'tellybox-migration-'));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const mediaDirectory = path.join(directory,'old-media'), accessDirectory = path.join(directory,'old-access');
	mkdirSync(mediaDirectory); mkdirSync(accessDirectory);
	return { root: directory, mediaDirectory, accessDirectory, directory:path.join(directory,'candidate'),
		environment:{ JELLYFIN_URL:'http://media:8096', PUBLIC_ORIGIN:'https://watch.example.com', LOCAL_HOSTS:'192.168.10.5,localhost', LOCAL_NETWORKS:'192.168.10.0/24',
			TRUSTED_PROXIES:'100.64.1.2,100.64.1.3', HOME_TRUSTED_PROXY:'100.64.1.2,100.64.1.3', CLIENT_IP_HEADER:'x-real-ip' }, localOrigin:'http://192.168.10.5:8082', dispatcharrUrl:'http://tv:9191' };
}
test('migration preserves request destinations, identities, progress, limits and source files', t => {
	const f=fixture(t);
	atomicJson(path.join(f.mediaDirectory,'connection.json'),{token:'fixture-token',userId:'a'.repeat(32)});
	const seerr={url:'http://requests:5055',key:'fixture-key',specials:true,radarr:{serverId:1,profileId:3,rootFolder:'/films'},sonarr:{serverId:2,profileId:4,rootFolder:'/series'}};
	atomicJson(path.join(f.mediaDirectory,'seerr.json'),seerr);
	atomicJson(path.join(f.accessDirectory,'dispatcharr.json'),{key:'fixture-dispatch-key'});
	const files=['apps','people','favourites','viewing-totals','account-limits','upload-limit','sessions','push-devices','shares','series-links'];
	for(const name of files)atomicJson(path.join(f.accessDirectory,name+'.json'),{fixture:name});
	const report=migrateLegacy(f), config=json(path.join(f.directory,'configuration.json'));
	assert.deepEqual(config.apps,{edition:'personal',packageName:'uk.co.jimbos.jserver'});
	assert.equal(report.applied,false); assert.equal(existsSync(path.join(f.directory,'applied-configuration.json')),false);
	assert.equal(config.network.clientIpHeader,'x-real-ip'); assert.equal(config.network.homeTrustedProxy,'100.64.1.2,100.64.1.3');
	assert.deepEqual(json(path.join(f.directory,'media/seerr.json')),seerr);
	assert.deepEqual(json(path.join(f.mediaDirectory,'seerr.json')),seerr);
	const env=materialize(config,f.directory);
	for(const name of files)assert.equal(readFileSync(path.join(name==='series-links'?env.CATALOGUE_CACHE_DIR:env.AUTH_DIR,name+'.json'),'utf8'),readFileSync(path.join(f.accessDirectory,name+'.json'),'utf8'));
	const edited=configStore(f.directory);const safe=edited.save({...config,services:{...config.services,seerr:{...config.services.seerr,radarrProfileId:'8'}}});
	materialize(edited.get(),f.directory);
	assert.equal(json(path.join(f.directory,'media/seerr.json')).radarr.profileId,8);
	assert.equal(safe.services.seerr.key,undefined);assert.equal(safe.services.seerr.keySaved,true);
	assert.equal(JSON.stringify(report).includes('fixture-token'),false);
	assert.throws(()=>migrateLegacy(f),/already exists/);
});
test('legacy token-only Dispatcharr is reported rather than silently disconnected',t=>{
	const f=fixture(t);atomicJson(path.join(f.accessDirectory,'dispatcharr.json'),{access:'fixture',refresh:'fixture'});
	assert.throws(()=>migrateLegacy(f),/personal API key/);assert.equal(existsSync(f.directory),false);
});
test('migration marks services on the home server without rewriting URLs or mislabelling another LAN machine',t=>{
	const f=fixture(t);f.environment.JELLYFIN_URL='http://192.168.10.5:8096';f.dispatcharrUrl='http://192.168.10.9:9191';
	atomicJson(path.join(f.mediaDirectory,'connection.json'),{token:'fixture-token',userId:'a'.repeat(32)});
	atomicJson(path.join(f.accessDirectory,'dispatcharr.json'),{key:'fixture-dispatch-key'});
	migrateLegacy(f);const config=json(path.join(f.directory,'configuration.json'));
	assert.equal(config.services.jellyfin.onThisServer,true);assert.equal(config.services.jellyfin.url,f.environment.JELLYFIN_URL);
	assert.equal(config.services.dispatcharr.onThisServer,false);assert.equal(config.services.dispatcharr.url,f.dispatcharrUrl);
});
test('migration preserves published updates and cached captions, excluding unfinished files and media content',t=>{
	const f=fixture(t);
	mkdirSync(path.join(f.mediaDirectory,'app-updates'));mkdirSync(path.join(f.accessDirectory,'subtitle-cache'));
	const apk=Buffer.from([0,1,2,3,255]);writeFileSync(path.join(f.mediaDirectory,'app-updates','Tellybox-tv-1.0.apk'),apk);
	atomicJson(path.join(f.mediaDirectory,'app-updates','latest.json'),{fixture:true});
	mkdirSync(path.join(f.mediaDirectory,'app-updates','public'));
	atomicJson(path.join(f.mediaDirectory,'app-updates','public','latest.json'),{publicFixture:true});
	writeFileSync(path.join(f.accessDirectory,'subtitle-cache','fixture.srt'),'1\n00:00:01,000 --> 00:00:02,000\nHello\n');
	writeFileSync(path.join(f.accessDirectory,'subtitle-cache','fixture.srt.tmp'),'unfinished');
	mkdirSync(path.join(f.mediaDirectory,'recordings'));writeFileSync(path.join(f.mediaDirectory,'recordings','film.mp4'),'media fixture');
	const result=migrateLegacy(f);
	assert.deepEqual(readFileSync(path.join(f.directory,'media/app-updates/Tellybox-tv-1.0.apk')),apk);
	assert.equal(json(path.join(f.directory,'media/app-updates/public/latest.json')).publicFixture,true);
	assert.equal(readFileSync(path.join(f.directory,'access/subtitle-cache/fixture.srt'),'utf8'),readFileSync(path.join(f.accessDirectory,'subtitle-cache/fixture.srt'),'utf8'));
	assert.equal(existsSync(path.join(f.directory,'access/subtitle-cache/fixture.srt.tmp')),false);
	assert.equal(existsSync(path.join(f.directory,'media/recordings')),false);
	assert.equal(result.preservedFiles.length,4);
});
test('failed apply restores the previous revision and does not apply a saved draft on reboot',async t=>{
	const f=fixture(t);mkdirSync(f.directory);
	const store=configStore(f.directory), launched=[];let failNext=false;
	const options={directory:f.directory,stop:async()=>{},start:async env=>{launched.push(env);return env;},ready:async()=>{if(failNext){failNext=false;throw Error('not ready');}}};
	let runtime=createApplyController(options);await runtime.boot();assert.equal(runtime.status().appliedRevision,0);
	const initial=defaultConfig();initial.services.introdb.enabled=true;store.save(initial);
	await runtime.apply(store.get());assert.equal(runtime.status().appliedRevision,1);
	store.save({...store.get(),services:{...store.get().services,introdb:{enabled:false}}});
	failNext=true;await assert.rejects(runtime.apply(store.get()),/previous configuration was restored/);
	assert.equal(runtime.status().appliedRevision,1);assert.equal(launched.at(-1).INTRODB_ENABLED,'1');
	runtime=createApplyController(options);await runtime.boot();assert.equal(runtime.status().appliedRevision,1);assert.equal(launched.at(-1).INTRODB_ENABLED,'1');
	assert.equal(store.get().revision,2);assert.equal(store.get().services.introdb.enabled,false);
});
test('first boot does not implicitly apply saved unapproved settings',async t=>{
	const f=fixture(t);mkdirSync(f.directory);const store=configStore(f.directory), draft=defaultConfig();draft.services.introdb.enabled=true;store.save(draft);
	let started;const runtime=createApplyController({directory:f.directory,stop:async()=>{},start:async env=>{started=env;},ready:async()=>{}});
	await runtime.boot();assert.equal(started.INTRODB_ENABLED,'0');assert.equal(runtime.status().appliedRevision,0);
});
