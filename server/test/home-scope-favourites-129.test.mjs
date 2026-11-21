import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
function extract(name){const start=source.indexOf('function '+name+'(');return(source.slice(start-6,start)==='async '?'async ':'')+source.slice(start,source.indexOf('\n}',start)+2);}
function fixture(api){
	const calls=[];
	const c={homeFeedState:{authReady:true,scope:'scope:A',data:{},generation:0},sharedFavourites:{items:[{Id:'A-favourite'}]},favouriteHome:false,serverFavouritesRequired:true,routing:{},homeSkeletonShown:false,
		api,homeArtworkRestartLimit:1,stopHomeArtworkContinuation(){},resetHomeArtworkRestartBudget(){},trustBrowserProgress(){},isHomeView:()=>true,renderHomeSkeleton(){},updateHomeSections(){},
		loadHomeFeed:()=>calls.push(c.sharedFavourites?.items?.map(i=>i.Id)||[]),loadLikedEpisodes:async()=>{},calls};
	vm.createContext(c);vm.runInContext(['homeAuthScope','setHomeAuthScope','revalidateHomeAuthScope'].map(extract).join('\n'),c);return c;
}
const accessB={scope:'B',local:false,home:false,email:true,authenticated:true,person:'Same name'};
test('changed account reloads scoped favourites before new Home payload',async()=>{
	const routes=[];const c=fixture(async route=>{routes.push(route);return route==='/api/auth/status'?accessB:{own:{items:[{Id:'B-favourite'}]}};});
	await vm.runInContext('revalidateHomeAuthScope()',c);
	assert.deepEqual(JSON.parse(JSON.stringify(c.calls)),[['B-favourite']]);assert.ok(routes.includes('/api/favourites'));
});
test('unchanged account preserves cached favourites and avoids refetch',async()=>{
	const routes=[];const c=fixture(async route=>{routes.push(route);return{...accessB,scope:'A'};});await vm.runInContext('revalidateHomeAuthScope()',c);
	assert.equal(c.sharedFavourites.items[0].Id,'A-favourite');assert.deepEqual(routes,['/api/auth/status']);assert.equal(c.calls.length,0);
});
test('failed new-account favourites never reuse old-account values',async()=>{
	const c=fixture(async route=>{if(route==='/api/auth/status')return accessB;throw Error('offline');});await vm.runInContext('revalidateHomeAuthScope()',c);
	assert.deepEqual(JSON.parse(JSON.stringify(c.calls)),[[]]);assert.equal(c.serverFavouritesRequired,true);
});
test('late earlier-account favourites cannot overwrite newer scope',async()=>{
	let finishB;const c=fixture(async route=>{if(route==='/api/auth/status')return accessB;return new Promise(resolve=>finishB=resolve);});
	const waiting=vm.runInContext('revalidateHomeAuthScope()',c);await new Promise(resolve=>setImmediate(resolve));
	assert.equal(typeof finishB,'function');vm.runInContext('setHomeAuthScope({scope:"C",email:true,person:"C"})',c);c.sharedFavourites={items:[{Id:'C-favourite'}]};finishB({own:{items:[{Id:'B-favourite'}]}});await waiting;
	assert.equal(c.sharedFavourites.items[0].Id,'C-favourite');assert.equal(c.calls.length,0);
});
test('switch to shared Home loads Home favourites rather than personal ones',async()=>{
	const routes=[];const c=fixture(async route=>{routes.push(route);return route==='/api/auth/status'?{scope:'home',local:true,home:true,email:true,person:null}:{own:{items:[{Id:'home-favourite'}]}};});await vm.runInContext('revalidateHomeAuthScope()',c);
	assert.equal(c.favouriteHome,true);assert.ok(routes.includes('/api/favourites/home'));assert.deepEqual(JSON.parse(JSON.stringify(c.calls)),[['home-favourite']]);
});
test('late auth revalidation cannot undo a newer validated scope',async()=>{
	let finish;const c=fixture(()=>new Promise(resolve=>finish=resolve));const waiting=vm.runInContext('revalidateHomeAuthScope()',c);
	vm.runInContext('setHomeAuthScope({scope:"C",email:true,person:"C"})',c);finish(accessB);await waiting;
	assert.equal(c.homeFeedState.scope,'scope:C');assert.equal(c.calls.length,0);
});
