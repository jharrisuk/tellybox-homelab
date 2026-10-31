import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {defaultConfig,validateConfig,materialize,configStore} from '../homelab/config.mjs';

test('new installations default to HomeLab downloads and expose the explicit edition to runtime',t=>{
	const directory=mkdtempSync(path.join(tmpdir(),'tellybox-app-edition-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
	const config=validateConfig(defaultConfig());
	assert.equal(config.apps.edition,'public');
	assert.equal(materialize(config,directory).TELLYBOX_APP_EDITION,'public');
	config.apps={edition:'personal',packageName:'org.example.familytv'};
	const env=materialize(validateConfig(config),directory);
	assert.equal(env.TELLYBOX_APP_EDITION,'personal');assert.equal(env.TELLYBOX_APP_PACKAGE,'org.example.familytv');
});

test('app download edition persists across saves and omitted fields cannot reset a personal installation',t=>{
	const directory=mkdtempSync(path.join(tmpdir(),'tellybox-app-edition-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
	let store=configStore(directory), next=store.get();next.apps={edition:'personal',packageName:'org.example.familytv'};store.save(next);
	store=configStore(directory);assert.equal(store.get().apps.edition,'personal');
	next=store.get();delete next.apps;store.save(next);assert.deepEqual(store.get().apps,{edition:'personal',packageName:'org.example.familytv'});
	next=store.get();next.apps.edition='public';store.save(next);assert.equal(configStore(directory).get().apps.edition,'public');
});

test('only explicit HomeLab and Personal edition values are accepted',()=>{
	for(const apps of [null,[],false,{edition:'homelab'},{edition:'unexpected'},{edition:1}]){
		const config=defaultConfig();config.apps=apps;assert.throws(()=>validateConfig(config),/app download|app downloads/);
	}
	const legacy=defaultConfig();delete legacy.apps;assert.equal(validateConfig(legacy).apps.edition,'public');
});

test('Custom mode requires a distinct Android application ID, never an implicit personal identity',()=>{
	for(const packageName of ['',null,'example','app.tellybox.homelab','App.Tellybox.HomeLab','org.123.app','org.example.app-name','org.example/other']){
		const config=defaultConfig();config.apps={edition:'personal',packageName};assert.throws(()=>validateConfig(config),/application ID/);
	}
});
