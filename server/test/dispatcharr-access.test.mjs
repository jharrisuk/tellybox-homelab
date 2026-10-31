import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

test('Dispatcharr credentials are local-only, same-origin JSON, fail closed for app tokens and never returned',async t=>{
	const dir=mkdtempSync(path.join(os.tmpdir(),'dispatch-auth-'));
	const listen=handler=>new Promise(resolve=>{const s=http.createServer(handler).listen(0,'127.0.0.1',()=>resolve(s));});
	const upstream=await listen((req,res)=>{res.setHeader('Content-Type','application/json');res.end('{"results":[]}');});
	const local=await listen(),remote=await listen();
	t.after(()=>{for(const s of [upstream,local,remote]){s.closeAllConnections();s.close();}rmSync(dir,{recursive:true,force:true});});
	Object.assign(process.env,{NODE_ENV:'test',PORT:String(local.address().port),DATA_DIR:dir,AUTH_DIR:dir,DISPATCHARR_URL:`http://127.0.0.1:${upstream.address().port}`,LOCAL_HOSTS:'127.0.0.1',LOCAL_NETWORKS:'127.0.0.0/8',PUBLIC_ORIGIN:'https://tellybox.test'});
	(await import('./enabled-fixture.mjs')).enableIntegrations();
	const {app}=await import('../server.mjs');local.on('request',app);remote.on('request',app);
	const base=`http://127.0.0.1:${local.address().port}`;
	const request=(headers={},body={key:'synthetic-key'},target=base)=>fetch(target+'/api/dispatcharr/connection',{method:'POST',headers:{'Content-Type':'application/json',...headers},body:JSON.stringify(body)});
	assert.equal((await request()).status,403);
	assert.equal((await request({Origin:'https://evil.test'})).status,403);
	assert.equal((await request({Origin:process.env.PUBLIC_ORIGIN})).status,403);
	assert.equal((await request({Origin:base,Authorization:'Bearer invalid'})).status,401);
	assert.equal((await request({Origin:base,'X-Forwarded-For':'192.168.0.2'})).status,401);
	assert.equal((await request({Origin:base},undefined,`http://127.0.0.1:${remote.address().port}`)).status,401);
	assert.equal((await request({Origin:base})).status,200);
	assert.equal(JSON.parse(readFileSync(path.join(dir,'dispatcharr.json'),'utf8')).key,'synthetic-key');
	const result=await(await fetch(base+'/api/dispatcharr/connection')).json();
	assert.equal(result.connected,true);assert.equal(JSON.stringify(result).includes('synthetic-key'),false);
	for(const origin of ['', 'https://evil.test'])assert.equal((await fetch(base+'/api/subtitles/connection',{method:'POST',headers:{'Content-Type':'application/json',...(origin?{Origin:origin}:{})},body:'{}'})).status,403);
	assert.equal((await fetch(base+'/api/subtitles/connection',{headers:{Authorization:'Bearer invalid'}})).status,401);
	assert.equal((await fetch(base+'/api/subtitles/connection',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:'{}'})).status,400);
	assert.deepEqual(await(await fetch(base+'/api/subtitles/connection')).json(),{configured:false,enabled:false,account:false,notice:'',remaining:null});
	assert.equal((await fetch(`http://127.0.0.1:${remote.address().port}/api/web/live-guide`)).status,401);
	for(const route of ['/api/web/items','/api/web/items/dispatch-movie-1','/api/web/items/dispatch-series-1/episodes','/api/web/art/movie/1'])assert.equal((await fetch(`http://127.0.0.1:${remote.address().port}${route}`)).status,401);
	assert.equal((await fetch(`http://127.0.0.1:${remote.address().port}/api/play`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:'dispatch-movie-1'})})).status,401);
	assert.equal((await fetch(`http://127.0.0.1:${remote.address().port}/api/recordings`)).status,401);
	for(const route of ['/api/recordings','/api/recordings/dispatch-recording-1/cancel']){
		for(const origin of ['', 'https://evil.test'])assert.equal((await fetch(base+route,{method:'POST',headers:{'Content-Type':'application/json',...(origin?{Origin:origin}:{})},body:'{}'})).status,403);
	}
});
