import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
test('web catch-up progress uses the programme duration, not the short live buffer',()=>{
	const now=Date.now(),saved=new Map(),playing={Id:'catchup-test',Type:'Catchup',StartDate:new Date(now-300000).toISOString(),EndDate:new Date(now+300000).toISOString()};
	const context={Date,state:{playing},casting:{active:false},video:{duration:60,ended:true},playbackPosition:()=>59,
		localStorage:{getItem:key=>saved.get(key),setItem:(key,value)=>saved.set(key,value)}};
	vm.runInNewContext(source.slice(source.indexOf('function saveProgress()'),source.indexOf('async function report(')),context);
	context.saveProgress();assert.equal(saved.get('jimbo-progress-catchup-test'),'59');assert.equal(saved.has('tellybox-watched-catchup-test'),false);
	playing.StartDate=new Date(now-700000).toISOString();playing.EndDate=new Date(now-100000).toISOString();context.playbackPosition=()=>599;
	context.saveProgress();assert.equal(saved.get('jimbo-progress-catchup-test'),'0');assert.equal(saved.get('tellybox-watched-catchup-test'),'true');
});
test('web resume choice waits for Resume, Beginning or Cancel',async()=>{
	for(const [button,wanted] of [[0,125],[1,0],[2,null]]){
		let dialog;
		const element=(tag,css,text)=>({tag,text,children:[],append(...nodes){this.children.push(...nodes);},setAttribute(){},addEventListener(name,callback){this[name+'Handler']=callback;},showModal(){this.open=true;},close(){this.closeHandler();},remove(){this.removed=true;}});
		const context={element,Math,String,Promise,document:{body:{append(value){dialog=value;}}}};
		vm.runInNewContext(source.slice(source.indexOf('function chooseCatchupResume('),source.indexOf('async function startPlayback(')),context);
		let settled=false;const result=context.chooseCatchupResume({Name:'Planet Earth'},125).then(value=>{settled=true;return value;});
		await Promise.resolve();assert.equal(settled,false);assert.equal(dialog.children[1].children[0].text,'Resume from 2:05');
		dialog.children[1].children[button].onclick();assert.equal(await result,wanted);assert.equal(dialog.removed,true);
	}
});
