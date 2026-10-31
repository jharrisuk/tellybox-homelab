import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {createRecordingDeletion,installRecordingDeletion} from '../recording-deletion.mjs';
const id='a'.repeat(32),root='b'.repeat(32);
function fixture(){
	const calls=[],state={busy:false,timers:[],parent:root,item:{Id:id,Name:'Saved show',Type:'Movie',LocationType:'FileSystem',CanDelete:true,Path:'/recordings/show.ts'}};
	const jelly=async(route,options={})=>{
		calls.push([route,options]);if(options.method==='DELETE')return null;
		if(route.endsWith('/Views'))return {Items:[{Id:root,Name:'Recordings'}]};
		if(route.includes('/Ancestors'))return [{Id:state.parent}];
		if(route==='/LiveTv/Timers')return {Items:state.timers};
		if(route.startsWith('/Items?'))return {Items:[state.item],TotalRecordCount:1};
		return state.item;
	};
	const recording={Id:'dispatch-recording-7',Name:'DVR show',State:'completed',EndDate:'2026-01-01T00:00:00Z'};
	const manager=createRecordingDeletion({jelly,userId:()=>id,busy:()=>state.busy,recordings:{item:async()=>recording,remove:async()=>calls.push(['dispatch-delete'])},invalidated:()=>calls.push(['invalidated'])});
	return {manager,state,calls,recording};
}
test('deletion is confined to individual filesystem recordings, never folders, VOD or normal library titles',async()=>{
	const f=fixture();assert.equal((await f.manager.inspect(id)).CanDelete,true);
	f.state.parent='c'.repeat(32);await assert.rejects(()=>f.manager.remove(id),/Only individual recordings/);
	f.state.parent=root;
	for(const changes of [{IsFolder:true},{IsVirtualItem:true},{Type:'Series'},{LocationType:'Remote'}]){
		const before={...f.state.item};Object.assign(f.state.item,changes);await assert.rejects(()=>f.manager.remove(id),/Only individual/);f.state.item=before;
	}
	for(const bad of ['../file','dispatch-series-1','dispatch-recording-0','-'.repeat(32)])await assert.rejects(()=>f.manager.remove(bad),/Invalid/);
	assert(!f.calls.some(c=>c[1]?.method==='DELETE'));
});
test('Jellyfin deletion permissions, active captures and active playback are rechecked before removal',async()=>{
	const f=fixture();await f.manager.inspect(id);f.state.busy=true;await assert.rejects(()=>f.manager.remove(id),/watched or downloaded/);
	f.state.busy=false;f.state.item.CanDelete=false;await assert.rejects(()=>f.manager.remove(id),/Enable deletion/);
	f.state.item.CanDelete=true;f.state.timers=[{Status:'InProgress',RecordingPath:'/recordings/show.ts'}];await assert.rejects(()=>f.manager.remove(id),/finished saving/);
	f.state.timers=[];assert.equal((await f.manager.remove(id)).ok,true);assert.equal(f.calls.filter(c=>c[1]?.method==='DELETE').length,1);assert(f.calls.some(c=>c[0]==='invalidated'));
});
test('Dispatcharr deletion blocks unfinished recordings and busy playback',async()=>{
	const f=fixture();for(const state of ['scheduled','starting','recording','processing']){f.recording.State=state;await assert.rejects(()=>f.manager.remove('dispatch-recording-7'),/finished saving/);}
	f.recording.State='completed';f.state.busy=true;await assert.rejects(()=>f.manager.remove('dispatch-recording-7'),/watched/);
	f.state.busy=false;assert.equal((await f.manager.remove('dispatch-recording-7')).ok,true);assert.equal(f.calls.filter(c=>c[0]==='dispatch-delete').length,1);
});
test('local recordings listing scopes the query to the recordings library',async()=>{
	const f=fixture();assert.equal((await f.manager.localList()).length,1);const route=f.calls.find(c=>c[0].startsWith('/Items?'))[0];assert(route.includes('ParentId='+root));assert(route.includes('LocationTypes=FileSystem'));
});
test('recording endpoints require trusted management access, same origin and explicit confirmation',async()=>{
	const f=fixture(),app=express(),events=[];app.use(express.json());app.use((req,res,next)=>{req.jserverOrigin='http://tellybox.test';next();});
	installRecordingDeletion(app,{manager:f.manager,allowed:req=>req.get('x-test-role')==='admin',audit:(...event)=>events.push(event)});
	app.use((err,req,res,next)=>res.status(err.status||500).json({error:err.message}));
	const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
	try{
		const url='http://127.0.0.1:'+server.address().port+'/api/recording-files/'+id;
		assert.equal((await fetch(url)).status,403);
		for(const [role,origin,confirm,expected]of [['viewer','http://tellybox.test',true,403],['admin','http://evil.test',true,400],['admin','http://tellybox.test',false,400]]){
			assert.equal((await fetch(url+'/delete',{method:'POST',headers:{'Content-Type':'application/json','x-test-role':role,origin},body:JSON.stringify({confirm})})).status,expected);
		}
		assert.equal(f.calls.length,0);
		assert.equal((await fetch(url+'/delete',{method:'POST',headers:{'Content-Type':'application/json','x-test-role':'admin',origin:'http://tellybox.test'},body:'{"confirm":true}'})).status,200);
		assert.equal(events[0][0],'recording_deleted');
	}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});
