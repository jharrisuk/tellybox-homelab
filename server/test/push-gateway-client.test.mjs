import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,writeFileSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createPushGatewayClient,PUSH_GATEWAY,PUBLIC_APP_PACKAGE,pushDeviceId} from '../push-gateway-client.mjs';
import {defaultConfig,materialize,validateConfig} from '../homelab/config.mjs';

const handle='h'.repeat(48),ticket='t'.repeat(48),eventId='11111111-2222-4333-8444-555555555555';
function fixture(t,enabled=true) {
	const directory=mkdtempSync(path.join(tmpdir(),'tellybox-push-gateway-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
	writeFileSync(path.join(directory,'push-gateway.json'),JSON.stringify({enabled}));
	return directory;
}
function responder(calls,clock) {
	return async(url,options)=>{
		const body=options.body?JSON.parse(options.body):null;calls.push({url,options,body});
		assert.ok(url.startsWith(PUSH_GATEWAY+'/'));assert.equal(options.redirect,'error');assert.ok(options.signal);
		if(url.endsWith('/config'))return Response.json({enabled:true,package:PUBLIC_APP_PACKAGE});
		if(url.endsWith('/installations'))return Response.json({id:body.id});
		if(url.endsWith('/tickets'))return Response.json({ticket,expiresAt:clock()+60000});
		return Response.json({active:true,ok:true});
	};
}

test('gateway is completely inert until enabled, and reading config never enrols an installation',async t=>{
	let calls=0;const disabled=createPushGatewayClient({directory:fixture(t,false),fetcher:async()=>{calls++;throw Error();}});
	assert.equal(await disabled.status(),false);await assert.rejects(disabled.ticket('device'));assert.equal(calls,0);
	const events=[],clock=()=>100000,enabled=createPushGatewayClient({directory:fixture(t),fetcher:responder(events,clock),clock});
	assert.equal(await enabled.status(),true);assert.equal(await enabled.status(),true);assert.equal(events.length,1);
	assert.ok(events.every(call=>call.url.endsWith('/config')));
});

test('tenant identity survives materialization and requests contain only scoped opaque identifiers',async t=>{
	const root=fixture(t),config=defaultConfig();config.services.pushGateway.enabled=true;materialize(validateConfig(config),root);
	const directory=path.join(root,'access'),calls=[],clock=()=>100000;
	const client=createPushGatewayClient({directory,clock,fetcher:responder(calls,clock)});
	assert.deepEqual(await client.ticket('local-device'),{ticket,expiresAt:160000});
	const saved=readFileSync(path.join(directory,'push-gateway-installation.json'),'utf8');
	materialize(validateConfig(config),root);assert.equal(readFileSync(path.join(directory,'push-gateway-installation.json'),'utf8'),saved);
	assert.equal(await client.verify(handle,'local-device'),true);assert.equal(await client.wake(handle,eventId),true);await client.revoke(handle);
	const state=JSON.parse(saved),enrol=calls.find(call=>call.url.endsWith('/installations'));
	assert.deepEqual(enrol.body,{id:state.id,key:state.key});assert.equal(enrol.options.headers.Authorization,undefined);
	for(const call of calls.filter(call=>!call.url.endsWith('/config')&&!call.url.endsWith('/installations')))assert.equal(call.options.headers.Authorization,`Bearer ${state.id}.${state.key}`);
	assert.deepEqual(calls.find(call=>call.url.endsWith('/tickets')).body,{deviceId:pushDeviceId('local-device')});
	assert.deepEqual(calls.find(call=>call.url.endsWith('/devices/verify')).body,{handle,deviceId:pushDeviceId('local-device')});
	assert.deepEqual(calls.find(call=>call.url.endsWith('/wake')).body,{handle,eventId});
});

test('lost enrolment responses reuse the chosen credentials and persist failure backoff',async t=>{
	const directory=fixture(t),calls=[];let now=100000,fail=true;const good=responder(calls,()=>now);
	const fetcher=async(url,options)=>{const response=await good(url,options);if(url.endsWith('/installations')&&fail){fail=false;throw Error('lost response');}return response;};
	await assert.rejects(createPushGatewayClient({directory,fetcher,clock:()=>now}).ticket('device'));
	const first=JSON.parse(readFileSync(path.join(directory,'push-gateway-installation.json'),'utf8'));
	const retry=createPushGatewayClient({directory,fetcher,clock:()=>now});assert.equal(await retry.status(),false);
	now+=31000;await retry.ticket('device');
	const second=JSON.parse(readFileSync(path.join(directory,'push-gateway-installation.json'),'utf8'));
	assert.equal(second.id,first.id);assert.equal(second.key,first.key);
	assert.equal(calls.filter(call=>call.url.endsWith('/installations')).length,2);
});

test('oversized gateway responses are bounded, cached failures do not hammer the gateway',async t=>{
	let calls=0,now=100000;const client=createPushGatewayClient({directory:fixture(t),clock:()=>now,fetcher:async()=>{calls++;return new Response('x'.repeat(20000));}});
	assert.equal(await client.status(),false);assert.equal(await client.status(),false);assert.equal(calls,1);
	now+=31000;assert.equal(await client.status(),false);assert.equal(calls,2);
});

test('failed revocations persist and are retried before subsequent wake delivery',async t=>{
	const directory=fixture(t),calls=[];let now=100000,fail=true;const good=responder(calls,()=>now);
	const client=createPushGatewayClient({directory,clock:()=>now,fetcher:async(url,options)=>{if(url.endsWith('/devices/revoke')&&fail){fail=false;return new Response('',{status:503});}return good(url,options);}});
	await client.ticket('device');await client.revoke(handle);
	assert.deepEqual(JSON.parse(readFileSync(path.join(directory,'push-gateway-installation.json'),'utf8')).revocations,[handle]);
	now+=31000;await client.wake('o'.repeat(48),eventId);
	assert.deepEqual(JSON.parse(readFileSync(path.join(directory,'push-gateway-installation.json'),'utf8')).revocations,[]);
	assert.ok(calls.findIndex(call=>call.url.endsWith('/devices/revoke'))<calls.findIndex(call=>call.url.endsWith('/wake')));
});

test('a previously replaced gateway handle counts as revoked and cannot stall a new binding',async t=>{
	const directory=fixture(t),calls=[],clock=()=>100000,good=responder(calls,clock);
	const client=createPushGatewayClient({directory,clock,fetcher:(url,options)=>url.endsWith('/devices/revoke')?Promise.resolve(new Response('',{status:404})):good(url,options)});
	await client.ticket('device');await client.revoke(handle);assert.equal(await client.wake('n'.repeat(48),eventId),true);
	assert.deepEqual(JSON.parse(readFileSync(path.join(directory,'push-gateway-installation.json'),'utf8')).revocations,[]);
	assert.equal(calls.filter(call=>call.url.endsWith('/wake')).length,1);
});

test('an expired tenant enrols again with the same credentials, while revocation never resets its identity',async t=>{
	for(const status of [401,403]){
		const directory=fixture(t),calls=[];let now=100000,failed=false;const good=responder(calls,()=>now);
		const client=createPushGatewayClient({directory,clock:()=>now,fetcher:(url,options)=>url.endsWith('/tickets')&&failed?Promise.resolve(new Response('',{status})):good(url,options)});
		await client.ticket('device');const initial=JSON.parse(readFileSync(path.join(directory,'push-gateway-installation.json'),'utf8'));
		failed=true;await assert.rejects(client.ticket('device'));
		const after=JSON.parse(readFileSync(path.join(directory,'push-gateway-installation.json'),'utf8'));assert.equal(after.enrolled,status!==401);
		assert.equal(after.id,initial.id);assert.equal(after.key,initial.key);
		await assert.rejects(client.ticket('device'));assert.equal(calls.filter(call=>call.url.endsWith('/installations')).length,1);
		now+=31000;
		if(status===401){failed=false;await client.ticket('device');}else await assert.rejects(client.ticket('device'));
		const enrols=calls.filter(call=>call.url.endsWith('/installations'));
		assert.equal(enrols.length,status===401?2:1);assert.deepEqual(enrols.at(-1).body,{id:initial.id,key:initial.key});
	}
});
