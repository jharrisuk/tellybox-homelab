import test from 'node:test';
import assert from 'node:assert/strict';
import {services} from '../homelab/services.mjs';
import {defaultConfig,validateConfig,redacted} from '../homelab/config.mjs';
import {locationChoice,isSameServerAddress} from '../homelab/public/service-location.mjs';

test('same-server choices use the Docker host and usual ports for exactly five integrations',()=>{
	const addresses=Object.fromEntries(services.filter(service=>service.sameServerUrl).map(service=>[service.id,service.sameServerUrl]));
	assert.deepEqual(addresses,{jellyfin:'http://host.docker.internal:8096',dispatcharr:'http://host.docker.internal:9191',seerr:'http://host.docker.internal:5055',sonarr:'http://host.docker.internal:8989',radarr:'http://host.docker.internal:7878'});
	const input=defaultConfig();for(const id of Object.keys(addresses))input.services[id].onThisServer=true;
	const config=validateConfig(input);
	for(const [id,url] of Object.entries(addresses)){
		assert.equal(config.services[id].url,url);assert.equal(config.services[id].onThisServer,true);assert.equal(config.services[id].enabled,false);
	}
});
test('choosing this server and returning to manual entry preserves the previous address',()=>{
	const manual={url:'https://media.example.test:8443',onThisServer:false};
	const local=locationChoice(manual,'http://host.docker.internal:8096',true);
	assert.deepEqual(local,{onThisServer:true,url:'http://host.docker.internal:8096',manualUrl:manual.url});
	assert.equal(locationChoice({...local,url:'http://host.docker.internal:18096'},'',false).url,manual.url);
	assert.equal(locationChoice({url:'',onThisServer:false},'http://host.docker.internal:8096',true).manualUrl,'');
});
test('saved same-server choices retain custom ports and manual addresses without changing legacy URLs',()=>{
	const input=defaultConfig();input.services.jellyfin={enabled:true,url:'http://existing-media:8096',key:'fixture-key',userId:'a'.repeat(32)};
	const imported=validateConfig(input);
	assert.equal(imported.services.jellyfin.onThisServer,false);assert.equal(imported.services.jellyfin.url,input.services.jellyfin.url);
	const next=redacted(imported);next.services.jellyfin={...next.services.jellyfin,onThisServer:true,url:'http://host.docker.internal:18096'};
	const saved=validateConfig(next,imported);
	assert.equal(saved.services.jellyfin.url,'http://host.docker.internal:18096');assert.equal(saved.services.jellyfin.manualUrl,'http://existing-media:8096');
	assert.equal(saved.services.jellyfin.key,'fixture-key');
	const roundtrip=validateConfig(redacted(saved),saved);assert.equal(roundtrip.services.jellyfin.onThisServer,true);assert.equal(roundtrip.services.jellyfin.url,saved.services.jellyfin.url);
	assert.equal(locationChoice(roundtrip.services.jellyfin,'',false).url,'http://existing-media:8096');
	next.services.jellyfin.onThisServer='true';assert.throws(()=>validateConfig(next,imported),/runs on this server/);
});
test('same-server selection does not relax integration address validation',()=>{
	for(const value of ['http://user:secret@host.docker.internal:8096','http://host.docker.internal:8096?key=secret','http://host.docker.internal:8096/subpath']){
		const input=defaultConfig();input.services.jellyfin={enabled:false,onThisServer:true,url:value};
		assert.throws(()=>validateConfig(input));
	}
});

test('migration recognises the same server, never other machines on its LAN or container loopback',()=>{
	const local='http://192.168.50.8:8082';
	assert.equal(isSameServerAddress('http://192.168.50.8:8989',local),true);
	assert.equal(isSameServerAddress('http://host.docker.internal:8096',local),true);
	for(const address of ['http://192.168.50.9:9191','http://127.0.0.1:8096','http://localhost:8096','invalid',''])assert.equal(isSameServerAddress(address,local),false);
	assert.equal(isSameServerAddress('http://192.168.50.8:8096',''),false);
});
