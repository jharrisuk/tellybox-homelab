import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

class Element {
	constructor(tag='div') { this.tag=tag;this.children=[];this.textContent=''; }
	append(...children) { this.children.push(...children); }
	replaceChildren(...children) { this.children=children; }
}
const tick=()=>new Promise(resolve=>setImmediate(resolve));
function dom() {
	const nodes={};
	return {nodes,document:{hidden:false,querySelector:key=>nodes[key] ||= new Element(),createElement:tag=>new Element(tag)}};
}
function all(root) { return [root,...root.children.flatMap(all)]; }

test('admin APK links use the public domain even from local admin and follow refreshed releases',async()=>{
	const {nodes,document}=dom();let version='0.21.5';
	const context={document,URL,fetch:async route=>{
		assert.equal(route,'/app-updates/downloads.json');
		return {ok:true,json:async()=>({edition:'personal',packageName:'org.example.familytv',phone:{package:'org.example.familytv',url:`https://watch.example.test/app-updates/Tellybox-phone-${version}.apk`,versionName:version,versionCode:37,bytes:9180562},tv:{package:'org.example.familytv',url:'https://other.example/unsafe.apk'}})};
	}};
	vm.runInNewContext(readFileSync(new URL('../public/admin-downloads.js',import.meta.url),'utf8'),context);await tick();
	assert.equal(nodes['#phoneApk'].href,'https://watch.example.test/app-updates/Tellybox-phone-0.21.5.apk');assert.equal(nodes['#tvApk'].hidden,true);
	version='0.22.0';await nodes['#refreshApks'].onclick();assert.equal(nodes['#phoneApk'].href,'https://watch.example.test/app-updates/Tellybox-phone-0.22.0.apk');
	assert.match(nodes['#phoneApkVersion'].textContent,/0.22.0/);
});

test('HomeLab admin downloads show central aliases and refuse alternate hosts or packages',async()=>{
	const {nodes,document}=dom();
	const feed={edition:'homelab',phone:{package:'app.tellybox.homelab',url:'https://homelab.tellyboxapp.com/downloads/Tellybox-phone-latest.apk'},tv:{package:'app.tellybox.homelab',url:'https://homelab.tellyboxapp.com/downloads/Tellybox-tv-latest.apk'}};
	const context={document,URL,fetch:async()=>({ok:true,json:async()=>feed})};
	vm.runInNewContext(readFileSync(new URL('../public/admin-downloads.js',import.meta.url),'utf8'),context);await tick();
	assert.equal(nodes['#phoneApk'].href,feed.phone.url);assert.equal(nodes['#tvApk'].href,feed.tv.url);
	assert.equal(nodes['#phoneApkVersion'].textContent,'Latest HomeLab release');
	feed.phone.url='https://other.example/downloads/Tellybox-phone-latest.apk';feed.tv.package='org.example.other';
	await nodes['#refreshApks'].onclick();assert.equal(nodes['#phoneApk'].hidden,true);assert.equal(nodes['#tvApk'].hidden,true);
});

test('sign-in panel renders supplied identities as text and sends only the selected connection reset',async()=>{
	const {nodes,document}=dom(),calls=[];let cleared=false;
	const entry={id:'fixture-id',ip:'192.0.2.1',email:'<untrusted@example.test>',attempts:3,limit:3,resetsAt:Date.now()+60000,state:'warning'};
	const context={document,confirm:()=>true,setInterval(){},authRequest:async(url,body)=>{
		calls.push({url,body});if(body){cleared=true;return {ok:true};}
		return {connections:cleared?[]:[entry],failed:[{time:Date.now(),ip:entry.ip,email:entry.email,reason:'Incorrect or expired email code',type:'login_failed'}],retentionDays:30};
	}};
	vm.runInNewContext(readFileSync(new URL('../public/login-protection.js',import.meta.url),'utf8'),context);await tick();
	const children=all(nodes['#signInConnections']);assert.ok(children.some(e=>e.textContent===entry.email));
	assert.ok(children.some(e=>e.textContent.includes('next submission blocks')));
	await children.find(e=>e.tag==='button').onclick();
	const mutation=calls.find(e=>e.body);assert.equal(mutation.url,'/api/auth/login-protection');assert.equal(mutation.body.id,entry.id);assert.deepEqual(Object.keys(mutation.body),['id']);
	assert.equal(nodes['#signInConnections'].children.length,0);assert.ok(all(nodes['#signInEvents']).some(e=>e.textContent==='Incorrect or expired email code'));
});

test('activity separates downloads from watching and hides the download section when empty',async()=>{
	const {nodes,document}=dom();document.createTextNode=text=>Object.assign(new Element('text'),{textContent:text});
	nodes['#filter']=Object.assign(new Element(),{value:'all'});nodes['#ipFilter']=Object.assign(new Element(),{value:''});
	const downloading={purpose:'download',title:'Downloading episode',bytes:50,totalBytes:100,ip:'192.0.2.1',mediaRoute:'local',updated:Date.now()};
	const snapshot={active:[{title:'Watching episode',state:'playing'},downloading],downloads:[downloading],recent:[],browsers:[],stats:{active:1,plays:1,remoteIps:0,failed:0}};
	const context={document,Node:Element,setInterval(){},fetch:async()=>({ok:true,json:async()=>snapshot})};
	vm.runInNewContext(readFileSync(new URL('../public/activity.js',import.meta.url),'utf8'),context);await tick();
	assert.equal(nodes['#downloadingSection'].hidden,false);
	assert.ok(!all(nodes['#watching']).some(e=>e.textContent==='Downloading episode'));
	assert.ok(all(nodes['#downloading']).some(e=>e.textContent==='Downloading episode'));
	assert.ok(all(nodes['#downloading']).some(e=>e.textContent.startsWith('50%')));
	snapshot.downloads=[];await context.refresh();assert.equal(nodes['#downloadingSection'].hidden,true);
});
