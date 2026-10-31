import test from 'node:test';
import assert from 'node:assert/strict';
import {generateKeyPairSync} from 'node:crypto';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {defaultConfig,validateConfig,redacted,materialize} from '../homelab/config.mjs';
import {notificationMode,withNotificationMode} from '../homelab/public/notification-mode.mjs';

function customConfig() {
	const config=defaultConfig(),{privateKey}=generateKeyPairSync('rsa',{modulusLength:2048});
	config.services.firebase={enabled:true,projectId:'fixture-project',applicationId:'1:123456789:android:abcdef',publicApplicationId:'',senderId:'123456789',apiKey:'fixture-client-key',serviceAccount:JSON.stringify({type:'service_account',project_id:'fixture-project',client_email:'fixture@fixture-project.iam.gserviceaccount.com',private_key:privateKey.export({type:'pkcs8',format:'pem'})})};
	return config;
}

test('one notification selector maps Off, Standard and Custom without losing custom fields',()=>{
	const services=customConfig().services;
	assert.equal(notificationMode(defaultConfig().services),'off');assert.equal(notificationMode(services),'custom');
	for(const mode of ['off','standard','custom']){
		const selected=withNotificationMode(services,mode);
		assert.equal(selected.pushGateway.enabled,mode==='standard');assert.equal(selected.firebase.enabled,mode==='custom');
		assert.equal(selected.firebase.serviceAccount,services.firebase.serviceAccount);assert.equal(notificationMode(selected),mode);
		assert.equal(services.firebase.enabled,true);
	}
	assert.throws(()=>withNotificationMode(services,'both'));
});

test('existing own Firebase configuration opens as Custom, retaining masked credentials on save',t=>{
	const source=customConfig();delete source.services.pushGateway;
	const config=validateConfig(source);assert.equal(notificationMode(config.services),'custom');assert.equal(config.services.pushGateway.enabled,false);
	const masked=redacted(config);assert.equal(masked.services.firebase.serviceAccount,undefined);
	masked.services=withNotificationMode(masked.services,'custom');
	const saved=validateConfig(masked,config);assert.equal(saved.services.firebase.serviceAccount,config.services.firebase.serviceAccount);assert.equal(saved.services.firebase.apiKey,config.services.firebase.apiKey);
	const directory=mkdtempSync(path.join(tmpdir(),'tellybox-custom-push-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
	const env=materialize(saved,directory);
	assert.deepEqual(JSON.parse(readFileSync(path.join(env.AUTH_DIR,'push-gateway.json'),'utf8')),{enabled:false});
	assert.equal(JSON.parse(readFileSync(path.join(env.AUTH_DIR,'firebase-client.json'),'utf8')).applicationId,source.services.firebase.applicationId);
});

test('Standard uses no supplied Firebase keys and conflicting providers are rejected',()=>{
	const config=defaultConfig();config.services=withNotificationMode(config.services,'standard');
	const standard=validateConfig(config);assert.equal(standard.services.pushGateway.enabled,true);assert.equal(standard.services.firebase.enabled,false);
	const both=customConfig();both.services.pushGateway.enabled=true;assert.throws(()=>validateConfig(both),/not both/);
});
