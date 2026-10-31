import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createPeople } from '../people.mjs';

function fixture(t) {
	const directory=mkdtempSync(path.join(tmpdir(),'tellybox-email-approval-'));
	t.after(()=>rmSync(directory,{recursive:true,force:true}));
	const mail=[],approvals=[],events=[],identity={ip:'192.0.2.1',browser:'Test'};
	const people=createPeople(directory,{loginUrl:'https://watch.example.test/login',deliver:async value=>(value.type==='approval'?approvals:mail).push(value),audit:{record:(...args)=>events.push(args)}});
	people.configure({enabled:true,key:'re_fixture_key_only_12345',from:'login@example.test'});
	return {directory,mail,approvals,events,identity,people};
}

test('unknown and pending emails notify admins once and never generate a code or session before approval',async t=>{
	const {directory,mail,events,identity,people}=fixture(t);
	assert.deepEqual(await people.request('Guest@Example.test',identity.ip,identity),{status:'pending'});
	assert.deepEqual(await people.request('guest@example.test',identity.ip,identity),{status:'pending'});
	assert.equal(mail.length,0);assert.equal(people.list().people.length,1);assert.equal(people.list().browsers.length,0);
	assert.equal(events.length,1);assert.equal(events[0][0],'person_requested');assert.equal(events[0][1].browser,'Test');
	assert.deepEqual(JSON.parse(readFileSync(path.join(directory,'people.json'),'utf8')).challenges,{});
	const restarted=createPeople(directory);assert.equal(restarted.list().people[0].status,'pending');
	const guest=people.list().people[0];assert.equal(guest.name,'guest@example.test');
	await people.manage({id:guest.id,action:'approve'});
	const first=await people.request('guest@example.test',identity.ip,identity);
	assert.equal(first.status,'code-sent');assert.equal(mail.length,1);assert.equal(people.list().browsers.length,0);
	assert.throws(()=>people.verify({challenge:first.challenge,code:'not-a-code'},identity),/not correct/);
	const result=people.verify({challenge:first.challenge,code:mail[0].code,email:'someone-else@example.test',name:'Unverified name'},identity);
	assert.equal(result.name,'guest@example.test');assert.equal(result.status,'approved');assert.equal(people.session(result.token).personId,guest.id);
	people.manage({id:guest.id,action:'rename',name:'Living room guest'});
	const second=await people.request('guest@example.test',identity.ip,identity);
	const returning=people.verify({challenge:second.challenge,code:mail[1].code,remember:true},identity);
	assert.equal(returning.name,'Living room guest');assert.equal(people.list().people.length,1);
	assert.throws(()=>people.verify({challenge:second.challenge,code:mail[1].code},identity),/expired/);
});

test('declined emails never receive codes and revocation invalidates an already issued code',async t=>{
	const {mail,identity,people}=fixture(t);
	await people.request('declined@example.test',identity.ip);
	const guest=people.list().people[0];people.manage({id:guest.id,action:'revoke'});
	await assert.rejects(people.request(guest.email,identity.ip),e=>e.status===403);assert.equal(mail.length,0);
	await people.manage({id:guest.id,action:'approve'});
	const sent=await people.request(guest.email,identity.ip);assert.equal(mail.length,1);
	people.manage({id:guest.id,action:'revoke'});
	assert.throws(()=>people.verify({challenge:sent.challenge,code:mail[0].code},identity),e=>e.status===401);
	await assert.rejects(people.request(guest.email,identity.ip),e=>e.status===403);assert.equal(mail.length,1);
	assert.equal(people.list().browsers.length,0);
});

test('approval sends one notice, removal is silent and clears browsers, codes and device links',async t=>{
	const {people,identity,mail,approvals}=fixture(t);
	await people.request('guest@example.test',identity.ip);const guest=people.list().people[0];
	await people.manage({id:guest.id,action:'approve'});await people.manage({id:guest.id,action:'approve'});
	assert.equal(approvals.length,1);assert.match(approvals[0].text,/https:\/\/watch.example.test\/login/);assert.equal(approvals[0].code,undefined);
	const c=await people.request(guest.email,identity.ip),session=people.verify({...c,code:mail[0].code},identity);
	const later=await people.request(guest.email,identity.ip),browser=people.registerBrowser('', 'Chrome');
	people.manageBrowser({id:browser.browser.id,action:'link',personId:guest.id});
	people.manage({id:guest.id,action:'device',deviceId:'a'.repeat(32)});
	people.manage({id:guest.id,action:'remove'});
	assert.equal(people.session(session.token),null);assert.equal(people.browserPerson(browser.token),null);
	assert.deepEqual(people.list().devices,{});assert.equal(people.list().people.length,0);
	assert.throws(()=>people.verify({...later,code:mail[1].code},identity));assert.equal(approvals.length,1);assert.equal(mail.length,2);
	assert.deepEqual(await people.request(guest.email,identity.ip),{status:'pending'});assert.notEqual(people.list().people[0].id,guest.id);
});

test('approval email failure keeps access approved and retry is explicit and deduplicated',async t=>{
	const {directory}=fixture(t);let fail=true,count=0;
	const people=createPeople(directory,{deliver:async value=>{if(value.type==='approval'){count++;if(fail)throw Error('offline');}}});
	await people.request('guest@example.test','test');const guest=people.list().people[0];
	assert.equal((await people.manage({id:guest.id,action:'approve'})).approvalEmail,'failed');assert.equal(guest.status,'approved');
	await people.manage({id:guest.id,action:'approve'});assert.equal(count,1);
	fail=false;await Promise.all([people.manage({id:guest.id,action:'notify-approval'}),people.manage({id:guest.id,action:'notify-approval'})]);
	assert.equal(count,2);assert.equal(guest.approvalEmailStatus,'sent');
	people.manage({id:guest.id,action:'revoke'});people.manage({id:guest.id,action:'remove'});assert.equal(count,2);
});
