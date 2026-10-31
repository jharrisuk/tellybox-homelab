import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

function player() {
	const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
	const storage=new Map();
	const context=vm.createContext({
		localStorage:{getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)},
		state:{playing:{Id:'episode',Type:'Episode',SeriesId:'series'}},viewingStarted:false,
		casting:{active:false,remote:{}},video:{currentTime:60,duration:3600,ended:false},
	});
	vm.runInContext(`function playbackPosition(){return video.currentTime;}
		${source.slice(source.indexOf('function getProgress('),source.indexOf('async function report('))}`,context);
	return {context,storage,run:code=>vm.runInContext(code,context)};
}

test('finished browser titles ignore old positions and late progress, including missing duration',()=>{
	const {context,storage,run}=player();
	storage.set('tellybox-watched-episode','true');storage.set('jimbo-progress-episode','80');
	assert.equal(run("getProgress('episode')"),0);
	context.video.duration=NaN;run('saveProgress()');assert.equal(run("getProgress('episode')"),0);
	assert.equal(storage.get('tellybox-watched-episode'),'true');
});

test('deliberate rewatch resumes normally but repeated playing events cannot undo completion',()=>{
	const {context,storage,run}=player();storage.set('tellybox-watched-episode','true');
	run('beginViewing();saveProgress()');assert.equal(run("getProgress('episode')"),60);
	context.video.currentTime=3599;context.video.ended=true;run('saveProgress()');
	assert.equal(run("getProgress('episode')"),0);assert.equal(storage.get('tellybox-watched-episode'),'true');
	context.video.ended=false;context.video.duration=NaN;context.video.currentTime=60;
	run('beginViewing();saveProgress()');assert.equal(run("getProgress('episode')"),0);
});
