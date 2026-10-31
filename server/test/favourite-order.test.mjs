import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { installFavourites } from '../favourites.mjs';
import { createActivity } from '../activity.mjs';

test('confirmed playback orders account favourites across devices, promotes series and isolates other people', async t => {
	const directory = mkdtempSync(path.join(tmpdir(), 'favourite-order-'));
	const audit = createActivity(directory), app = express(); app.use(express.json());
	const devices = [
		{ id:'phone', name:'Phone', personId:'person-a', personName:'A' },
		{ id:'tv', name:'TV', personId:'person-a', personName:'A' },
		{ id:'other', name:'Other', personId:'person-b', personName:'B' }
	];
	const pass = (req,res,next) => next();
	installFavourites(app,{ directory, audit, admin:pass, writeCheck:pass, devices:()=>devices, device:req=>devices.find(d=>d.id===req.get('device')), home:()=>true });
	const server = await new Promise(resolve=>{ const s=app.listen(0,'127.0.0.1',()=>resolve(s)); });
	t.after(()=>{ audit.flush(); server.closeAllConnections(); server.close(); rmSync(directory,{recursive:true,force:true}); });
	const call = async (device, route='/api/favourites', body) => {
		const response=await fetch(`http://127.0.0.1:${server.address().port}`+route,{method:body?'POST':'GET',headers:{device,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});
		assert.equal(response.status,200); return response.json();
	};
	const film={Id:'film',Name:'A film',Type:'Movie'}, show={Id:'series',Name:'Z show',Type:'Series'}, channel={Id:'channel',Name:'24/7',Type:'TvChannel'};
	for(const device of ['phone','other']) {
		const own=(await call(device)).own;
		await call(device,'/api/favourites',{profileId:own.id,changes:[film,show,channel].map(item=>({id:item.Id,item,saved:true}))});
	}
	const original=(await call('other')).own.items.map(i=>i.Id);
	const episode={Id:'ep2',Name:'Second episode',Type:'Episode',SeriesId:'series',SeriesName:'Z show'};
	audit.begin('watch',{deviceId:'tv',personId:'person-a',personName:'A',local:true},episode,{purpose:'watch'});
	assert.equal((await call('phone')).own.items.every(i=>!i.LastPlayedAt),true,'preparing a stream is not playback');
	audit.update('watch',{heartbeat:true,state:'playing',position:12});
	assert.equal((await call('phone')).own.items[0].Id,'series');
	assert.equal((await call('tv')).own.items[0].Id,'series');
	assert.equal((await call('phone','/api/favourites/home')).own.items[0].Id,'series');
	assert.deepEqual((await call('other')).own.items.map(i=>i.Id),original);
	assert.equal((await call('other')).own.items.every(i=>!i.LastPlayedAt),true);
	audit.begin('download',{deviceId:'tv',personId:'person-a'},film,{purpose:'download'});
	audit.update('download',{heartbeat:true,state:'playing',position:100});
	assert.equal((await call('phone')).own.items[0].Id,'series');
	await new Promise(resolve=>setTimeout(resolve,3));
	audit.begin('live',{deviceId:'phone',personId:'person-a'},channel,{purpose:'watch'});
	audit.update('live',{heartbeat:true,state:'playing',position:0});
	assert.equal((await call('tv')).own.items[0].Id,'channel');
	// Marking a title watched is not a watch_started event.
	audit.record('watched',{personId:'person-a'},{itemId:'film'});
	assert.equal((await call('phone')).own.items[0].Id,'channel');
});
