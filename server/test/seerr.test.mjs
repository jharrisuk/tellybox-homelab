import test from 'node:test';
import assert from 'node:assert/strict';

test('ordinary browse separates documentaries without hiding them from global search',async()=>{
	const seen=[];
	const service=createSeerr({config:()=>({url:'http://seerr.test',key:'fixture'}),fetcher:async url=>{
		const page=Number(new URL(url).searchParams.get('page'));seen.push(page);
		return Response.json({page,totalPages:3,results:page===1?[{id:1,mediaType:'movie',title:'Nature',genreIds:[99]}]:[{id:2,mediaType:'movie',title:'A drama',genreIds:[18]},{id:3,mediaType:'movie',title:'True story',genreIds:[99,80]}]});
	}});
	const normal=await service.browse('',1,'movie','popular',true);assert.deepEqual(normal.items.map(i=>i.id),[2]);assert.equal(normal.page,2);assert.deepEqual(seen,[1,2]);
	const search=await service.browse('Nature',1,'all');assert.deepEqual(search.items.map(i=>i.id),[1]);
});
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import { createSeerr, mediaView, installSeerr } from '../seerr.mjs';
import { installAuth } from '../auth.mjs';

const config = () => ({ url: 'http://seerr.test', key: 'synthetic-secret', radarr: { serverId: 0, profileId: 1, rootFolder: '/movies' }, sonarr: { serverId: 0, profileId: 1, rootFolder: '/tv' } });
function fixture(detail) {
	const calls = [], events = [];
	const service = createSeerr({ config, audit: (...args) => events.push(args), fetcher: async (url, options) => {
		assert.equal(options.headers['X-Api-Key'], 'synthetic-secret');
		assert.equal(options.redirect, 'error');
		calls.push({ url: url.href, options });
		if (options.method === 'POST') {
			const body = JSON.parse(options.body);
			detail.mediaInfo = { status: 3, requests: [{ status: 2, is4k: false, seasons: (body.seasons || []).map(seasonNumber => ({ seasonNumber })) }] };
			return Response.json({ id: 22, status: 2 });
		}
		return Response.json(detail);
	} });
	return { service, calls, events };
}

test('discovery strips credentials, personal data and invalid poster/watch URLs', () => {
	const item = mediaView({ id: 1, title: '<script>test</script>', mediaType: 'movie', posterPath: '//evil.test/img', mediaInfo: {
		status: 3, serviceUrl: 'http://private', jellyfinMediaId: 'javascript:evil', requests: [{ status: 2, requestedBy: { email: 'private', apiKey: 'secret' } }]
	} });
	assert.equal(item.poster, null); assert.equal(item.watchId, null);
	assert.equal(item.requestable, false);
	assert.equal(item.statusLabel, 'Requested');
	assert.doesNotMatch(JSON.stringify(item), /private|secret|requestedBy|serviceUrl/);
});

test('film and TV discovery use separate catalogues and preserve pagination', async () => {
	const paths = [];
	const service = createSeerr({ config, fetcher: async url => {
		paths.push(url.pathname + url.search);
		return Response.json({ totalPages: 10, results: [{ id: 1, title: 'Film', mediaType: 'movie' }, { id: 2, name: 'Show', mediaType: 'tv' }, { id: 3, name: 'Person', mediaType: 'person' }] });
	} });
	const films = await service.browse('', 2, 'movie');
	const tv = await service.browse('', 3, 'tv');
	assert.deepEqual(paths, ['/api/v1/discover/movies?page=2', '/api/v1/discover/tv?page=3']);
	assert.deepEqual(films.items.map(i => i.type), ['movie']);
	assert.deepEqual(tv.items.map(i => i.type), ['tv']);
	assert.equal(films.page, 2); assert.equal(films.pages, 10);
	await assert.rejects(service.browse('', 1, '../settings'));
	assert.equal(paths.length, 2);
});

test('typed search skips empty pages without losing the next cursor and bounds upstream calls', async () => {
	const pages = [];
	const service = createSeerr({ config, fetcher: async url => {
		assert.equal(url.pathname, '/api/v1/search');
		assert.equal(url.searchParams.get('query'), 'test & title');
		const page = Number(url.searchParams.get('page')); pages.push(page);
		return Response.json({ totalPages: 10, results: [{ id: page, name: 'Result', mediaType: page === 2 ? 'tv' : 'movie' }] });
	} });
	const result = await service.browse('test & title', 1, 'tv');
	assert.deepEqual(pages, [1, 2]); assert.equal(result.page, 2); assert.equal(result.items[0].type, 'tv');
	const next = await service.browse('test & title', result.page + 1, 'tv');
	assert.deepEqual(pages, [1, 2, 3, 4, 5]); assert.equal(next.page, 5); assert.equal(next.pages, 10); assert.deepEqual(next.items, []);
});

test('unfiltered discovery sorts the full upstream catalogue and keeps search relevance explicit', async () => {
	const paths=[];const service=createSeerr({config,fetcher:async url=>{paths.push(url);return Response.json({totalPages:20,results:[]});}});
	await service.browse('',2,'movie','rating');
	assert.equal(paths[0].searchParams.get('sortBy'),'vote_average.desc');assert.equal(paths[0].searchParams.get('voteCountGte'),'50');assert.equal(paths[0].searchParams.get('page'),'2');
	await service.browse('',1,'tv','release');assert.equal(paths[1].searchParams.get('sortBy'),'first_air_date.desc');assert.ok(paths[1].searchParams.has('firstAirDateLte'));
	await assert.rejects(service.browse('test',1,'movie','rating'),/relevance/);
	await assert.rejects(service.browse('',1,'movie','unknown'));
	assert.equal(paths.length,2);
});

test('automatic requests use configured service zero and deduplicate concurrent submissions', async () => {
	const { service, calls, events } = fixture({ id: 42, title: 'A film' });
	const result = await Promise.all([service.request({ type: 'movie', id: 42 }, { ip: '192.0.2.1' }), service.request({ type: 'movie', id: 42 }, { ip: '192.0.2.2' })]);
	assert.equal(result.filter(r => r.created).length, 1);
	const posts = calls.filter(c => c.options.method === 'POST');
	assert.equal(posts.length, 1);
	assert.deepEqual(JSON.parse(posts[0].options.body), { mediaType: 'movie', mediaId: 42, is4k: false, serverId: 0, profileId: 1, rootFolder: '/movies' });
	assert.equal(events.length, 1); assert.equal(events[0][0], 'media_request');
	assert.equal(events[0][1].ip, '192.0.2.1'); assert.equal(events[0][2].title, 'A film');
	assert.equal(result[0].item.statusLabel, 'Requested');
});

test('TV requests validate seasons and omit already available or requested seasons', async () => {
	const { service, calls } = fixture({ id: 44, name: 'A show', seasons: [1, 2, 3].map(seasonNumber => ({ seasonNumber, episodeCount: 10 })), mediaInfo: {
		status: 4, seasons: [{ seasonNumber: 1, status: 5 }], requests: [{ status: 2, seasons: [{ seasonNumber: 2 }] }]
	} });
	await assert.rejects(service.request({ type: 'tv', id: 44, seasons: [99] }), /valid seasons/);
	await assert.rejects(service.request({ type: 'tv', id: 44, seasons: 'all' }), /valid seasons/);
	await assert.rejects(service.request({ type: 'tv', id: 44, seasons: [] }), /valid seasons/);
	await service.request({ type: 'tv', id: 44, seasons: [1, 2, 3, 3] });
	const post = JSON.parse(calls.find(c => c.options.method === 'POST').options.body);
	assert.deepEqual(post.seasons, [3]); assert.equal(post.rootFolder, '/tv');
});

test('invalid IDs, privileged fields and upstream errors fail without leaking secrets', async () => {
	const { service, calls } = fixture({ id: 1 });
	for (const body of [{ type: 'person', id: 1 }, { type: 'movie', id: '../settings' }, { type: 'movie', id: -1 }, { type: 'movie', id: 1, userId: 1 }, { type: 'movie', id: 1, rootFolder: '/other' }]) await assert.rejects(service.request(body));
	assert.equal(calls.length, 0);
	const failing = createSeerr({ config, fetcher: async () => new Response('secret upstream stack', { status: 500 }) });
	await assert.rejects(failing.details('movie', 1), error => error.status === 502 && !error.message.includes('secret'));
	await assert.rejects(createSeerr({ config: () => null }).browse(), error => error.status === 503);
});

test('specials follow Seerr settings and unsuccessful upstream requests are not called approved', async () => {
	const { service, calls } = fixture({ id: 44, name: 'A show', seasons: [{ seasonNumber: 0, episodeCount: 5 }] });
	const result = await service.request({ type: 'tv', id: 44, seasons: [0] });
	assert.equal(result.created, false);
	assert.equal(calls.filter(c => c.options.method === 'POST').length, 0);
	const failing = createSeerr({ config, fetcher: async (url, options) => Response.json(options.method === 'POST' ? { status: 4 } : { id: 42, title: 'A film' }) });
	const failed = await failing.request({ type: 'movie', id: 42 });
	assert.equal(failed.item.statusLabel, 'Needs attention');
	assert.match(failed.message, /needs attention/);
});

test('request status list preserves attention states and excludes upstream identity fields', async () => {
	const service = createSeerr({ config, fetcher: async url => Response.json(url.pathname.endsWith('/request') ? {
		pageInfo: { pages: 2 }, results: [{ id: 1, type: 'movie', status: 4, requestedBy: { email: 'secret' }, media: { tmdbId: 42, status: 3 } }]
	} : { id: 42, title: 'A film', posterPath: '/poster.jpg' }) });
	const result = await service.requests();
	assert.equal(result.pages, 2); assert.equal(result.items[0].statusLabel, 'Needs attention');
	assert.equal(result.items[0].poster, '/poster.jpg');
	assert.doesNotMatch(JSON.stringify(result), /secret|requestedBy/);
});

test('discovery routes inherit remote login and reject cross-origin and originless mutations', async t => {
	const directory = mkdtempSync(path.join(tmpdir(), 'jserver-seerr-'));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const app = express(); app.use(express.json());
	const local = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
	const remote = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
	t.after(() => { local.closeAllConnections(); remote.closeAllConnections(); local.close(); remote.close(); });
	installAuth(app, { directory, publicDirectory: path.resolve('public'), localPort: local.address().port, localHosts: ['127.0.0.1'], localNetworks: ['127.0.0.0/8'] });
	const configPath = path.join(directory, 'seerr.json'); writeFileSync(configPath, '{}');
	installSeerr(app, { configPath });
	app.use((error, req, res, next) => res.status(error.status || 500).json({ error: error.message }));
	const base = side => `http://127.0.0.1:${side.address().port}`;
	for (const route of ['/api/discover', '/api/discover/requests', '/api/discover/movie/42', '/api/discover/options', '/api/discover/provider/8', '/api/search?q=Arrival']) assert.equal((await fetch(base(remote) + route)).status, 401);
	assert.equal((await fetch(base(remote) + '/discover', { redirect: 'manual' })).status, 302);
	assert.equal((await fetch(base(remote) + '/search', { redirect: 'manual' })).status, 302);
	for (const origin of ['', 'https://unrelated.test']) {
		const result = await fetch(base(local) + '/api/discover/request', { method: 'POST', headers: { 'Content-Type': 'application/json', ...(origin ? { Origin: origin } : {}) }, body: JSON.stringify({ type: 'movie', id: 42 }) });
		assert.equal(result.status, 403);
	}
	for (const origin of ['', 'https://unrelated.test']) {
		const result = await fetch(base(local) + '/api/discover/for-you', { method:'POST', headers:{'Content-Type':'application/json', ...(origin ? {Origin:origin} : {})}, body:JSON.stringify({genres:[],exclude:[]}) });
		assert.equal(result.status,403);
	}
	assert.equal((await fetch(base(remote) + '/api/discover/for-you', {method:'POST', headers:{'Content-Type':'application/json',Origin:base(remote)},body:JSON.stringify({genres:[],exclude:[]})})).status,401);
	const allowed = await fetch(base(local) + '/api/discover/request', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base(local) }, body: JSON.stringify({ type: 'movie', id: 42 }) });
	assert.equal(allowed.status, 503);
});
