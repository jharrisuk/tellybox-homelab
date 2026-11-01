import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createAccountLimits} from '../account-limits.mjs';
import {createSessionLimits,SESSION_LIMIT} from '../session-limits.mjs';

const person='a'.repeat(32),phone='b'.repeat(32),tv='c'.repeat(32),key='person:'+person;
function folder(t){const dir=mkdtempSync(path.join(os.tmpdir(),'session-limits-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));return dir;}
function setup(t,{maxSessions=2,linked=false,now=100000}={}){
	let clock=now,linkedNow=linked;
	const limits=createAccountLimits(folder(t),{clock:()=>clock,resolveViewer:viewer=>viewer?.deviceId&&linkedNow?{...viewer,personId:person}:viewer});
	for(const id of [key,'device:'+phone,'device:'+tv])limits.set(id,{minutes:0,downloads:true,maxSessions});
	const live=new Set();
	const sessions=createSessionLimits({accountLimits:limits,clock:()=>clock,exists:id=>live.has(id),preparedMs:1000,idleMs:4000});
	return {limits,sessions,live,advance:ms=>clock+=ms,setLinked:value=>linkedNow=value,now:()=>clock};
}

test('maxSessions migrates old records to unlimited, validates and persists',t=>{
	const dir=folder(t);
	writeFileSync(path.join(dir,'account-limits.json'),JSON.stringify({accounts:{[key]:{minutes:60,seconds:55,downloads:true}}}));
	const limits=createAccountLimits(dir);
	assert.equal(limits.status(key).maxSessions,0);
	assert.equal(limits.maxSessions(key),0);
	assert.equal(limits.set(key,{minutes:60,downloads:true,maxSessions:3}).maxSessions,3);
	assert.equal(createAccountLimits(dir).status(key).maxSessions,3);
	for(const value of [-1,4,1.5,'2',NaN])assert.throws(()=>limits.set(key,{minutes:60,downloads:true,maxSessions:value}),error=>error.status===400);
	assert.equal(limits.status(key).maxSessions,3);
});

test('unlimited remote screens are tracked so a later finite cap preserves them and rejects new starts',t=>{
	const {sessions,limits}=setup(t,{maxSessions:0});
	assert.equal(sessions.acquire('local',{personId:person,local:true}),null);
	assert.equal(sessions.acquire('download',{personId:person},{download:true}),null);
	assert.equal(sessions.count({personId:person}),0,'exemptions are not extended to unlimited accounts');
	sessions.acquire('one',{personId:person});
	sessions.acquire('two',{personId:person});
	assert.equal(sessions.count({personId:person}),2,'unlimited remote screens are still counted');
	limits.set(key,{minutes:0,downloads:true,maxSessions:1});
	sessions.touch('one',{personId:person},{heartbeat:true});
	sessions.touch('two',{personId:person},{heartbeat:true});
	assert.equal(sessions.count({personId:person}),2,'existing unlimited screens survive the new cap');
	assert.throws(()=>sessions.acquire('three',{personId:person}),error=>error.code===SESSION_LIMIT);
	assert.equal(sessions.release('one'),true);
	assert.throws(()=>sessions.acquire('three',{personId:person}),error=>error.code===SESSION_LIMIT);
	sessions.release('two');
	sessions.acquire('three',{personId:person});
	assert.equal(sessions.count({personId:person}),1);
});

test('screens are reserved atomically, shared by linked devices and released exactly once',t=>{
	const {sessions,setLinked}=setup(t,{maxSessions:2});
	const acquired=[];
	for(const id of ['one','two','three']){
		try{sessions.acquire(id,{personId:person});acquired.push(id);}
		catch(error){assert.equal(error.code,SESSION_LIMIT);assert.equal(error.status,429);assert.match(error.message,/screens/);}
	}
	assert.deepEqual(acquired,['one','two']);
	assert.equal(sessions.count({personId:person}),2);
	assert.equal(sessions.release('one'),true);
	assert.equal(sessions.release('one'),false);
	assert.equal(sessions.count({personId:person}),1);
	sessions.acquire('three',{personId:person});
	assert.equal(sessions.count({personId:person}),2);

	setLinked(true);
	const other=setup(t,{maxSessions:2,linked:true});
	other.sessions.acquire('phone',{deviceId:phone});
	other.sessions.acquire('tv',{deviceId:tv});
	assert.equal(other.sessions.count({deviceId:phone}),2);
	assert.throws(()=>other.sessions.acquire('web',{personId:person}),error=>error.code===SESSION_LIMIT);
});

test('local, home, admin and downloads do not take a remote screen',t=>{
	const {sessions}=setup(t,{maxSessions:1});
	assert.equal(sessions.acquire('local',{personId:person,local:true}),null);
	assert.equal(sessions.acquire('home',{personId:person,home:true}),null);
	assert.equal(sessions.acquire('admin',{personId:person},{admin:true}),null);
	assert.equal(sessions.acquire('download',{personId:person},{download:true}),null);
	assert.equal(sessions.count({personId:person}),0);
	// A role in the viewer is not trusted authority.
	sessions.acquire('body',{personId:person,role:'admin'});
	assert.equal(sessions.count({personId:person}),1);
	assert.throws(()=>sessions.acquire('second',{personId:person,role:'admin'}),error=>error.code===SESSION_LIMIT);
});

test('a link change re-keys a live screen, new remote transitions need capacity and a lowered cap keeps existing screens',t=>{
	const {sessions,setLinked}=setup(t,{maxSessions:1});
	sessions.acquire('tv',{deviceId:phone});
	assert.equal(sessions.count({deviceId:phone}),1);
	setLinked(true);
	sessions.touch('tv',{deviceId:phone},{heartbeat:true});
	assert.equal(sessions.snapshot()[0].key,key);
	assert.equal(sessions.count({personId:person}),1);

	// A locally prepared stream that has no reservation is a new remote
	// transition. It must not bypass a full account.
	assert.throws(()=>sessions.touch('local',{personId:person},{media:true}),error=>error.code===SESSION_LIMIT);
	assert.equal(sessions.count({personId:person}),1);
	assert.equal(sessions.snapshot().some(entry=>entry.id==='local'),false);

	const lowered=setup(t,{maxSessions:2});
	lowered.sessions.acquire('one',{personId:person});
	lowered.sessions.acquire('two',{personId:person});
	lowered.limits.set(key,{minutes:0,downloads:true,maxSessions:1});
	lowered.sessions.touch('one',{personId:person},{heartbeat:true});
	lowered.sessions.touch('two',{personId:person},{heartbeat:true});
	assert.equal(lowered.sessions.count({personId:person}),2,'existing screens are preserved after a cap reduction');
	assert.throws(()=>lowered.sessions.acquire('three',{personId:person}),error=>error.code===SESSION_LIMIT);
});

test('a pending preparation survives the sweep until commit, failure or its bounded TTL',t=>{
	const {sessions,live,advance}=setup(t,{maxSessions:1});
	sessions.acquire('preparing',{personId:person},{pending:true});
	advance(15000);sessions.tick();
	assert.equal(sessions.count({personId:person}),1,'a slow preparation must not free the last screen');
	assert.throws(()=>sessions.acquire('second',{personId:person}),error=>error.code===SESSION_LIMIT);

	live.add('preparing');
	assert.equal(sessions.commit('preparing'),true);
	sessions.tick();
	assert.equal(sessions.count({personId:person}),1);

	sessions.release('preparing');
	sessions.acquire('second',{personId:person});
	assert.equal(sessions.count({personId:person}),1);
	assert.equal(sessions.release('second'),true);

	sessions.acquire('abandoned',{personId:person},{pending:true});
	advance(60000);sessions.tick();
	assert.equal(sessions.count({personId:person}),0,'the pending TTL must bound a stuck preparation');
});

test('warm-up, idle, removed and stopped sessions release screens; heartbeats hold them',t=>{
	const {sessions,live,advance}=setup(t,{maxSessions:1});
	live.add('warm');
	sessions.acquire('warm',{personId:person});
	advance(1000);sessions.tick();
	assert.equal(sessions.count({personId:person}),0,'an unused warm-up must not hold a screen');
	sessions.acquire('warm',{personId:person});
	assert.equal(sessions.count({personId:person}),1);
	sessions.media('warm',{personId:person});

	advance(3999);sessions.heartbeat('warm',{personId:person});
	sessions.tick();
	assert.equal(sessions.count({personId:person}),1,'a heartbeat keeps a paused screen');
	advance(4000);sessions.tick();
	assert.equal(sessions.count({personId:person}),0,'an idle screen expires');

	live.add('gone');
	sessions.acquire('gone',{personId:person});
	live.delete('gone');
	sessions.tick();
	assert.equal(sessions.count({personId:person}),0,'a removed session releases its screen');

	live.add('stopped');
	sessions.acquire('stopped',{personId:person});
	assert.equal(sessions.release('stopped'),true);
	sessions.tick();
	assert.equal(sessions.count({personId:person}),0);
});

test('viewing-status reports only the caller minimum, daily reset and active screens',t=>{
	let now=Date.parse('2026-10-26T22:00:00Z');
	const limits=createAccountLimits(folder(t),{clock:()=>now});
	limits.set(key,{minutes:1,dailyMinutes:2,downloads:true,maxSessions:2});
	let status=limits.viewing({personId:person});
	assert.deepEqual(Object.keys(status).sort(),['activeSessions','blocked','code','maxSessions','message','remainingSeconds','resetAt']);
	assert.equal(status.remainingSeconds,60);
	assert.equal(status.resetAt,null);
	assert.equal(status.maxSessions,2);
	assert.equal(status.activeSessions,0);
	assert.equal(status.blocked,false);
	assert.equal(status.code,null);
	assert.equal(status.message,'');
	assert.equal(JSON.stringify(status).includes(person),false);

	limits.set(key,{minutes:0,dailyMinutes:1,downloads:true,maxSessions:2});
	status=limits.viewing({personId:person});
	assert.equal(status.remainingSeconds,60);
	assert.equal(status.resetAt,'2026-10-27T00:00:00.000Z');
	for(let i=0;i<13;i++){now+=5000;limits.media('s',{personId:person});limits.tick();}
	status=limits.viewing({personId:person},{activeSessions:1});
	assert.equal(status.remainingSeconds,0);
	assert.equal(status.blocked,true);
	assert.equal(status.code,'VIEWING_LIMIT');
	assert.match(status.message,/midnight/);
	assert.equal(status.activeSessions,1);
	assert.throws(()=>limits.guard({personId:person}),error=>error.status===403&&error.code==='VIEWING_LIMIT'&&error.retryAfter>0);

	for(const viewer of [{personId:person,local:true},{personId:person,home:true}])assert.deepEqual(limits.viewing(viewer,{activeSessions:1}),{remainingSeconds:null,resetAt:null,maxSessions:2,activeSessions:0,blocked:false,code:null,message:''});
	// Admins are exempt from the screen cap, not from their minute quota.
	const admin=limits.viewing({personId:person},{admin:true,activeSessions:1});
	assert.equal(admin.remainingSeconds,0);
	assert.equal(admin.blocked,true);
	assert.equal(admin.code,'VIEWING_LIMIT');
	assert.equal(admin.activeSessions,0);
	assert.match(admin.message,/midnight/);
	// The role must come from trusted app auth, not from the viewer or request body.
	assert.equal(limits.viewing({personId:person,role:'admin'}).blocked,true);
});

test('manual exhaustion takes precedence over a daily reset when both are exhausted',t=>{
	let now=Date.parse('2026-10-26T12:00:00Z');
	const limits=createAccountLimits(folder(t),{clock:()=>now});
	limits.set(key,{minutes:1,dailyMinutes:1,downloads:true});
	for(let i=0;i<13;i++){now+=5000;limits.media('s',{personId:person});limits.tick();}
	assert.ok(limits.status(key).seconds>=60);
	assert.ok(limits.status(key).dailySeconds>=60);
	const status=limits.viewing({personId:person});
	assert.equal(status.remainingSeconds,0);
	assert.equal(status.resetAt,null,'the manual total has no automatic midnight reset');
	assert.equal(status.blocked,true);
	assert.equal(status.code,'VIEWING_LIMIT');
	assert.match(status.message,/owner to reset/);
	assert.throws(()=>limits.guard({personId:person}),error=>error.code==='VIEWING_LIMIT'&&error.retryAfter===undefined);
});
