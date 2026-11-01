import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Readable} from 'node:stream';
import {performance} from 'node:perf_hooks';
import {createUploadLimit} from '../upload-limit.mjs';
function fixture(t){const directory=mkdtempSync(path.join(tmpdir(),'upload-priority-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));return directory;}
async function drain(stream,label,order){let bytes=0;for await(const part of stream){order.push(label);bytes+=part.length;}return bytes;}

// Deterministic scheduler time. The upload scheduler must remain testable
// without depending on how quickly a CI machine happens to schedule timers.
function virtualClock(){
	let time=0,sequence=0;const timers=[];
	const flush=()=>new Promise(resolve=>setImmediate(resolve));
	const setTimer=(callback,delay)=>{const timer={callback,due:time+Math.max(0,Number(delay)||0),sequence:++sequence};timers.push(timer);return timer;};
	const clearTimer=timer=>{const index=timers.indexOf(timer);if(index>=0)timers.splice(index,1);};
	async function advance(ms){
		const target=time+ms;
		for(;;){
			timers.sort((a,b)=>a.due-b.due||a.sequence-b.sequence);
			const next=timers[0];
			if(!next||next.due>target)break;
			timers.shift();time=Math.max(time,next.due);next.callback();await flush();
		}
		time=target;await flush();
	}
	return {now:()=>time,setTimer,clearTimer,advance,flush};
}
const demand=count=>(async function*(){const chunk=Buffer.alloc(1024,7);for(let index=0;index<count;index++)yield chunk;})();
function metered(limit,clock,state,counts,label,owner,account,weight,controller,max=10000){
	return (async()=>{
		try{for await(const part of limit.stream(demand(max),controller.signal,owner,{account,weight}))if(state.counting)counts[label]+=part.length;}
		catch{}
	})();
}

test('weighted accounts are prioritised without starving ordinary remote streams',async t=>{
	const clock=virtualClock(),limit=createUploadLimit(fixture(t),clock);limit.set(2);
	const state={counting:false},counts={high:0,low:0};
	const highController=new AbortController(),lowController=new AbortController();
	const high=metered(limit,clock,state,counts,'high','high','person:admin',3,highController);
	const low=metered(limit,clock,state,counts,'low','low','person:remote',1,lowController);
	await clock.flush();await clock.advance(300);state.counting=true;await clock.advance(1000);state.counting=false;
	highController.abort();lowController.abort();await clock.flush();await Promise.allSettled([high,low]);
	assert.ok(counts.low>30000,`ordinary remote traffic must never starve (${counts.low} bytes)`);
	assert.ok(counts.high>counts.low*2.4,`high priority shared ${counts.high} vs ${counts.low} bytes`);
});

test('priority weights cannot exceed the global upload cap',async t=>{
	const limit=createUploadLimit(fixture(t));limit.set(2);
	const payload=Buffer.alloc(128*1024,9),order=[],start=performance.now();
	await Promise.all([
		drain(limit.stream(Readable.from([payload]),undefined,'admin',{account:'person:admin',weight:3}),'high',order),
		drain(limit.stream(Readable.from([payload]),undefined,'remote',{account:'person:remote',weight:1}),'low',order)
	]);
	const elapsed=performance.now()-start;
	// 256 KiB minus the 64 KiB burst at 2 Mbps needs at least 786 ms in total.
	assert.ok(elapsed>=730,`priority bypassed the upload cap (${elapsed} ms)`);
	assert.ok(elapsed<6000,`scheduler stalled (${elapsed} ms)`);
	assert.equal(order.length,16);
	assert.equal(limit.status().transferredBytes,payload.length*2);
});

async function orderScenario(t,highFirst){
	const clock=virtualClock(),limit=createUploadLimit(fixture(t),clock);limit.set(2);
	const state={counting:false},counts={p:0,q:0,high:0},streams=[];
	const controllers={p:new AbortController(),q:new AbortController(),high:new AbortController()};
	let high;
	if(highFirst){
		high=metered(limit,clock,state,counts,'high','p-high','person:p',3,controllers.high);
		streams.push(high);
		await clock.flush();await clock.advance(300);
		streams.push(metered(limit,clock,state,counts,'p','p-normal','person:p',1,controllers.p));
		streams.push(metered(limit,clock,state,counts,'q','q-normal','person:q',1,controllers.q));
	}else{
		streams.push(metered(limit,clock,state,counts,'p','p-normal','person:p',1,controllers.p));
		await clock.flush();await clock.advance(300);
		high=metered(limit,clock,state,counts,'high','p-high','person:p',3,controllers.high);
		streams.push(high);
		streams.push(metered(limit,clock,state,counts,'q','q-normal','person:q',1,controllers.q));
	}
	await clock.flush();state.counting=true;await clock.advance(1000);state.counting=false;
	controllers.p.abort();controllers.q.abort();controllers.high.abort();
	await clock.flush();await Promise.allSettled(streams);
	return {p:counts.p+counts.high,q:counts.q};
}

test('account priority is independent of which stream started last',async t=>{
	for(const highFirst of [true,false]){
		const {p,q}=await orderScenario(t,highFirst);
		assert.ok(q>30000,`ordinary account transferred only ${q} bytes`);
		assert.ok(p>q*2.4,`${highFirst?'high-first':'high-last'} diluted priority (${p} vs ${q})`);
		assert.ok(p<q*4.5,`${highFirst?'high-first':'high-last'} exceeded weighted share (${p} vs ${q})`);
	}
});

test('an ordinary stream loses high priority as soon as its account has no high-priority stream',async t=>{
	const clock=virtualClock(),limit=createUploadLimit(fixture(t),clock);limit.set(2);
	const state={counting:false},counts={p:0,q:0,high:0};
	const controllers={p:new AbortController(),q:new AbortController(),high:new AbortController()};
	const normal=metered(limit,clock,state,counts,'p','p-normal','person:p',1,controllers.p);
	await clock.flush();await clock.advance(300);
	let highDone=false;
	const high=metered(limit,clock,state,counts,'high','p-high','person:p',3,controllers.high,80).then(()=>{highDone=true;});
	for(let step=0;step<30&&!highDone;step++)await clock.advance(100);
	assert.equal(highDone,true,'the finite high-priority stream must finish inside the virtual window');
	const other=metered(limit,clock,state,counts,'q','q-normal','person:q',1,controllers.q);
	await clock.flush();state.counting=true;await clock.advance(1000);state.counting=false;
	controllers.p.abort();controllers.q.abort();await clock.flush();await Promise.allSettled([normal,high,other]);
	assert.ok(counts.q>30000,`ordinary account transferred only ${counts.q} bytes`);
	assert.ok(counts.p<counts.q*1.6,`high weight leaked after its stream ended (${counts.p} vs ${counts.q})`);
	assert.ok(counts.p>counts.q*0.6,`the remaining ordinary stream was starved (${counts.p} vs ${counts.q})`);
});
