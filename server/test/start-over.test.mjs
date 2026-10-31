import test from 'node:test';
import assert from 'node:assert/strict';
import {createCatchup} from '../catchup.mjs';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const uuid='01234567-0123-0123-0123-012345678901',id='dispatch-live-'+uuid;
const initial=Date.parse('2026-10-30T12:00:00Z');
function fixture(){
	let now=initial,calls=0,stale=false;
	const programme=(name,from,to)=>({Id:uuid+':'+(initial+from*60000),Name:name,StartDate:new Date(initial+from*60000).toISOString(),EndDate:new Date(initial+to*60000).toISOString()});
	const current=programme('On air',-20,40),future=programme('Next',40,100),ended=programme('Earlier',-80,-20);
	const channel={Id:id,Name:'Channel',programmes:[ended,current,future]};
	const rows=[{uuid,is_catchup:true,catchup_days:7}];
	const service=createCatchup({recordingApi:async()=>{calls++;return {results:rows};}},{archive:async()=>({stale,channels:[channel]})},()=>now);
	return {service,current,future,ended,channel,rows,calls:()=>calls,advance:ms=>now+=ms,stale:()=>stale=true};
}
test('restart resolves only the on-air programme; browsing does not open a provider session',async()=>{
	const f=fixture(),result=await f.service.restart(id,f.current.Id);
	assert.equal(result.item.Name,'On air');assert.equal(result.item.Type,'Catchup');assert.equal(result.item.Restart,true);
	assert.equal(result.item.ChannelId,id);assert.equal(result.item.StartDate,f.current.StartDate);assert.equal(result.item.EndDate,f.current.EndDate);
	assert.equal((await f.service.resolve(result.item.Id)).Id,result.item.Id);
	assert.equal((await f.service.restart(id,f.future.Id)).item,null);
	assert.equal((await f.service.restart(id,f.ended.Id)).item,null);
	assert.equal((await f.service.restart(id,'some-other-programme')).item,null);
	assert.equal(f.calls(),1);assert.deepEqual((await f.service.list()).channels[0].programmes.map(p=>p.Name),['Earlier']);
});
test('a restart choice remains playable as ordinary catch-up after the programme ends',async()=>{
	const f=fixture(),{item}=await f.service.restart(id,f.current.Id);f.advance(41*60000);
	assert.equal((await f.service.restart(id,f.current.Id)).item,null);
	assert.equal((await f.service.resolve(item.Id)).Restart,false);
});
test('unsupported channels, 24/7 and stale schedules never offer restart',async()=>{
	for(const change of [f=>f.rows[0].is_catchup=false,f=>f.rows[0].catchup_days=0,f=>f.channel.Nonstop=true,f=>f.stale()]){
		const f=fixture();change(f);assert.equal((await f.service.restart(id,f.current.Id)).item,null);
	}
});
test('restart excludes future starts, just-started shows, invalid dates and overlong EPG entries',async()=>{
	for(const [from,to] of [[1,60],[-.5,60],[-600,60],[-20,-21]]){
		const f=fixture();f.current.StartDate=new Date(initial+from*60000).toISOString();f.current.EndDate=new Date(initial+to*60000).toISOString();
		f.current.Id=uuid+':'+Date.parse(f.current.StartDate);assert.equal((await f.service.restart(id,f.current.Id)).item,null);
	}
	const f=fixture();f.current.StartDate='invalid';assert.equal((await f.service.restart(id,f.current.Id)).item,null);
});
test('untrusted ids, expired archives and revoked catch-up capability cannot start playback',async()=>{
	const f=fixture();await assert.rejects(f.service.restart('http://private.invalid',f.current.Id),/Invalid/);
	const {item}=await f.service.restart(id,f.current.Id);f.rows[0].is_catchup=false;f.advance(301000);
	await assert.rejects(f.service.resolve(item.Id),/no longer available/);
	const expired=fixture(),result=await expired.service.restart(id,expired.current.Id);expired.advance(8*86400000);
	await assert.rejects(expired.service.resolve(result.item.Id),/no longer available/);
	await assert.rejects(expired.service.resolve('catchup-'+uuid+'-'+(initial+3600000)),/no longer available/);
});

function webFixture(){
	class Element{
		constructor(tag,css,text=''){this.tag=tag;this.textContent=text;this.children=[];this.isConnected=true;this.classList={toggle(){}};}
		append(...children){this.children.push(...children);}
		setAttribute(){}
		replaceChildren(...children){for(const old of this.children)for(const node of all(old))node.isConnected=false;this.children=children;}
	}
	const all=e=>[e,...e.children.flatMap(all)],body=new Element('div'),requests=[],plays=[];
	const context={Date,encodeURIComponent,JSON,details:{open:true},guideData:{stale:false},canShare:false,
		localStorage:{getItem:()=>null},element:(...args)=>new Element(...args),guideRange:()=>'',compactAction:()=>new Element('button'),programmeRecording:()=>null,
		$:()=>body,startPlayback:(...args)=>plays.push(args),api:path=>new Promise(resolve=>requests.push({path,resolve}))};
	const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
	vm.runInNewContext(source.slice(source.indexOf('function showGuideDetails('),source.indexOf("$('#refreshGuide').onclick")),context);
	const programme={Id:'programme:1',StartDate:new Date(Date.now()-120000).toISOString(),EndDate:new Date(Date.now()+120000).toISOString(),Name:'Current'};
	const channel={Id:id,Name:'Channel',programmes:[programme]};
	return {context,body,requests,plays,programme,channel,buttons:()=>all(body).filter(e=>e.tag==='button')};
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
test('web restart stays secondary, fetches metadata only and starts the selected archive at zero',async()=>{
	const f=webFixture();f.context.showGuideDetails(f.channel,f.programme,true);
	assert.equal(f.requests.length,1);assert.match(f.requests[0].path,/^\/api\/catchup\/restart\?/);assert.equal(f.plays.length,0);
	const item={Id:'catchup-fixture',Type:'Catchup',ChannelId:id,Restart:true};f.requests[0].resolve({item});await tick();
	const button=f.buttons().find(e=>e.textContent.includes('Restart programme'));assert.ok(button);
	assert.ok(f.buttons().some(e=>e.textContent.includes('Watch channel live')));button.onclick();
	assert.equal(f.plays[0][0],item);assert.equal(f.plays[0][1],0);
});
test('web hides restart for unsupported or stale programmes and discards a previous selection response',async()=>{
	const f=webFixture();f.context.showGuideDetails(f.channel,f.programme,true);f.requests[0].resolve({item:null});await tick();
	assert.ok(!f.buttons().some(e=>e.textContent.includes('Restart programme')));
	f.context.showGuideDetails(f.channel,f.programme,true);const late=f.requests[1];
	f.context.guideData.stale=true;f.context.showGuideDetails(f.channel,f.programme,true);assert.equal(f.requests.length,2);
	late.resolve({item:{Id:'old-programme'}});await tick();assert.ok(!f.buttons().some(e=>e.textContent.includes('Restart programme')));
});
