import test from 'node:test';
import assert from 'node:assert/strict';
import {recordingView,createRecordings} from '../recordings.mjs';
import {createDispatcharr} from '../dispatcharr.mjs';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
const now=Date.parse('2026-10-22T18:00:00Z'),uuid='11111111-1111-1111-1111-111111111111';
const channel={id:19,uuid,name:'BBC ONE'};
const programme={Id:uuid+':'+(now+3600000),Name:'The show',Overview:'Description',StartDate:new Date(now+3600000).toISOString(),EndDate:new Date(now+7200000).toISOString()};
function fixture(){
	const rows=[],calls=[];let stale=false;
	const dispatcharr={recordingApi:async(method,route,body)=>{
		calls.push({method,route,body});if(route.startsWith('/api/channels/channels/'))return [channel];
		if(method==='POST'){const item={...body,id:rows.length+1};rows.push(item);return item;}
		const id=Number(route.match(/recordings\/(\d+)/)?.[1]);
		if(method==='DELETE'){rows.splice(rows.findIndex(r=>r.id===id),1);return null;}
		return id?rows.find(r=>r.id===id):rows;
	}};
	const service=createRecordings({dispatcharr,clock:()=>now,guide:async()=>({available:!stale,stale,channels:[{Id:'dispatch-live-'+uuid,programmes:[programme]}]})});
	return {service,rows,calls,stale:()=>{stale=true;}};
}
test('recording metadata exposes titles and status without storage paths, task IDs or provider URLs',()=>{
	const r=recordingView({id:1,channel:19,start_time:programme.StartDate,end_time:programme.EndDate,task_id:'secret',custom_properties:{status:'completed',file_path:'/private/secret',file_url:'http://provider/secret',program:{title:'Show'}}},channel,now);
	assert.equal(r.Playable,true);assert.equal(r.CanCancel,false);assert.equal(r.State,'completed');assert.ok(!JSON.stringify(r).includes('secret'));
	assert.equal(recordingView({id:1,start_time:programme.StartDate,end_time:programme.EndDate,custom_properties:{status:'recording',file_path:'/exists'}},channel,now).Playable,false);
});
test('schedule uses server guide times and channel UUID mapping; concurrent duplicate clicks create once',async()=>{
	const f=fixture();const result=await Promise.all([f.service.schedule('dispatch-live-'+uuid,programme.Id),f.service.schedule('dispatch-live-'+uuid,programme.Id)]);
	assert.equal(f.rows.length,1);assert.equal(result[1].existing,true);
	const call=f.calls.find(c=>c.method==='POST');assert.equal(call.body.channel,19);assert.equal(call.body.start_time,programme.StartDate);assert.equal(call.body.custom_properties.program.title,'The show');
	assert.equal(result[0].item.CanCancel,true);
});
test('invalid, ended, changed and stale guide selections cannot create a recording',async()=>{
	const f=fixture();await assert.rejects(()=>f.service.schedule('dispatch-live-'+uuid,'wrong'),/ended or its listing/);
	await assert.rejects(()=>f.service.schedule('dispatch-live-missing',programme.Id));f.stale();await assert.rejects(()=>f.service.schedule('dispatch-live-'+uuid,programme.Id),/Refresh/);
	assert.equal(f.rows.length,0);
});
test('existing recordings with padding are matched using original programme times',async()=>{
	const f=fixture();f.rows.push({id:5,channel:19,start_time:new Date(now+3500000).toISOString(),end_time:new Date(now+7500000).toISOString(),custom_properties:{program:{start_time:programme.StartDate,end_time:programme.EndDate}}});
	assert.equal((await f.service.schedule('dispatch-live-'+uuid,programme.Id)).existing,true);assert.equal(f.rows.length,1);
});
test('cancellation only deletes a future recording without media; active and completed recordings are protected',async()=>{
	const f=fixture(),created=await f.service.schedule('dispatch-live-'+uuid,programme.Id);await f.service.cancel(created.item.Id);assert.equal(f.rows.length,0);
	for(const status of ['recording','completed']){f.rows.push({id:8,channel:19,start_time:programme.StartDate,end_time:programme.EndDate,custom_properties:{status,file_path:'/existing'}});await assert.rejects(()=>f.service.cancel('dispatch-recording-8'),/Only recordings/);f.rows.length=0;}
	assert.equal(f.calls.filter(c=>c.method==='DELETE').length,1);
});
test('recording integration cannot fetch arbitrary URLs or mutate other Dispatcharr resources',async()=>{
	const d=createDispatcharr({file:'absent',origin:'http://dispatch.test',fetcher:async()=>{throw Error('must not fetch');}});
	await assert.rejects(()=>d.recordingApi('POST','/api/accounts/'),/Invalid/);
	await assert.rejects(()=>d.recordingApi('DELETE','/api/channels/recordings/'),/Invalid/);
	await assert.rejects(()=>d.recordingApi('GET','https://evil.test/api/channels/recordings/'),/Invalid/);
	await assert.rejects(()=>d.recordingFile('../private'),/Invalid/);
});
test('recording media uses fixed authenticated URLs and preserves byte ranges without following redirects',async()=>{
	const directory=mkdtempSync(path.join(os.tmpdir(),'dvr-access-'));
	try{
		const file=path.join(directory,'connection.json');writeFileSync(file,JSON.stringify({key:'synthetic-key'}));
		const d=createDispatcharr({file,origin:'http://dispatch.test',fetcher:async(url,options)=>{
			assert.equal(String(url),'http://dispatch.test/api/channels/recordings/7/file/');assert.equal(options.redirect,'error');assert.equal(options.headers.Range,'bytes=10-19');assert.equal(options.headers['X-API-Key'],'synthetic-key');return new Response('0123456789',{status:206});
		}});
		assert.equal((await d.recordingFile(7,{range:'bytes=10-19'})).status,206);
		const denied=createDispatcharr({file,origin:'http://dispatch.test',fetcher:async()=>new Response('private account details',{status:403})});
		await assert.rejects(()=>denied.recordingApi('POST','/api/channels/recordings/',{}),e=>e.status===403&&/recording-management/.test(e.message)&&!e.message.includes('private'));
	}finally{rmSync(directory,{recursive:true,force:true});}
});
