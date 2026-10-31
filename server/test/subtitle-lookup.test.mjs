import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createSubtitleLookup,subtitleIdentity,chooseSubtitle,cleanSrt,downloadedSubtitleIndex} from '../subtitle-lookup.mjs';
import {vodSubtitleTracks,selectVodSubtitle,vodVideoFilter} from '../vod-player.mjs';

const movie={Type:'Movie',Id:'film',ProviderIds:{Imdb:'tt123',Tmdb:'456'}};
const cue='1\n00:00:00,500 --> 00:00:02,000\n<i>Hello</i> {\\pos(0,0)}world\n';
const result=(changes={})=>({attributes:{language:'en',files:[{file_id:42}],feature_details:{feature_type:'Movie',imdb_id:123,tmdb_id:456},...changes}});

test('subtitle matches require English, exact media identity and episode numbering; exclude live and ambiguous releases',()=>{
	assert.equal(subtitleIdentity({Type:'TvChannel',ProviderIds:movie.ProviderIds}),null);
	assert.equal(subtitleIdentity({Type:'Movie',Name:'Guess me'}),null);
	const identity=subtitleIdentity(movie);
	assert.equal(chooseSubtitle([result({language:'fr'}),result({foreign_parts_only:true}),result({machine_translated:true}),result({files:[{file_id:1},{file_id:2}]}),result({feature_details:{feature_type:'Movie',imdb_id:999}})],identity),null);
	assert.equal(chooseSubtitle([result()],identity).files[0].file_id,42);
	const episode=subtitleIdentity({Type:'Episode',ParentIndexNumber:1,IndexNumber:2},{ProviderIds:{Tmdb:'5'}});
	assert.equal(chooseSubtitle([result({feature_details:{feature_type:'Episode',parent_tmdb_id:5,season_number:1,episode_number:3}})],episode),null);
	assert.ok(chooseSubtitle([result({feature_details:{feature_type:'Episode',parent_tmdb_id:5,season_number:1,episode_number:2}})],episode));
});

test('subtitle cache coalesces requests, survives restart and sends no credentials to file storage',async t=>{
	const directory=await mkdtemp(path.join(os.tmpdir(),'subtitle-cache-'));t.after(()=>rm(directory,{recursive:true,force:true}));let searches=0,downloads=0;
	const fetcher=async(url,options)=>{
		const u=new URL(url);
		if(u.hostname==='dl.opensubtitles.com'){assert.equal(options.headers,undefined);return new Response(cue);}
		assert.equal(options.headers['Api-Key'],'test-secret');
		if(u.pathname.endsWith('/infos/languages'))return Response.json({data:[]});
		if(u.pathname.endsWith('/subtitles')){searches++;assert.equal(u.searchParams.get('languages'),'en');assert.equal(u.searchParams.get('imdb_id'),'123');return Response.json({data:[result()]});}
		if(u.pathname.endsWith('/download')){downloads++;assert.deepEqual(JSON.parse(options.body),{file_id:42,sub_format:'srt'});return Response.json({link:'https://dl.opensubtitles.com/file.srt',remaining:4});}
		throw Error('Unexpected request');
	};
	const service=createSubtitleLookup({directory,fetcher});await service.connect({key:'test-secret'});
	const [a,b]=await Promise.all([service.lookup({item:movie,duration:90}),service.lookup({item:movie,duration:90})]);
	assert.equal(a.file,b.file);assert.equal(a.index,downloadedSubtitleIndex);assert.equal(searches,1);assert.equal(downloads,1);
	assert.equal((await readFile(a.file,'utf8')).includes('<i>'),false);assert.equal((await service.status()).remaining,4);assert.equal(JSON.stringify(await service.status()).includes('test-secret'),false);
	const restored=createSubtitleLookup({directory,fetcher:async()=>{throw Error('Must use cache');}});assert.equal((await restored.lookup({item:movie,duration:90})).file,a.file);
	await service.connect({enabled:false});assert.equal(await service.lookup({item:movie}),null);
});

test('no matches, quota errors and unsafe download addresses never block playback or leak secrets',async t=>{
	const directory=await mkdtemp(path.join(os.tmpdir(),'subtitle-errors-'));t.after(()=>rm(directory,{recursive:true,force:true}));let mode='miss',searches=0,files=0;
	const service=createSubtitleLookup({directory,fetcher:async(url)=>{
		const u=new URL(url);
		if(u.pathname.endsWith('/infos/languages'))return Response.json({data:[]});
		if(u.pathname.endsWith('/subtitles')){searches++;return Response.json({data:mode==='miss'?[]:[result()]});}
		if(u.pathname.endsWith('/download'))return mode==='quota'?new Response('secret upstream text',{status:406}):Response.json({link:'http://127.0.0.1/private'});
		files++;throw Error('Should not fetch arbitrary addresses');
	}});
	await service.connect({key:'secret'});assert.equal(await service.lookup({item:movie}),null);assert.equal(await service.lookup({item:movie}),null);assert.equal(searches,1);
	mode='quota';assert.equal(await service.lookup({item:movie,fingerprint:'other'}),null);assert.match((await service.status()).notice,/allowance/);assert.equal((await service.status()).notice.includes('secret'),false);
	await service.connect({key:'secret'});mode='unsafe';assert.equal(await service.lookup({item:movie,fingerprint:'third'}),null);assert.match((await service.status()).notice,/unsupported download address/);assert.equal(files,0);
});

test('optional account login is renewed and failed connections preserve saved credentials',async t=>{
	const directory=await mkdtemp(path.join(os.tmpdir(),'subtitle-account-'));t.after(()=>rm(directory,{recursive:true,force:true}));let deny=false;
	const service=createSubtitleLookup({directory,fetcher:async(url,options)=>{
		if(new URL(url).pathname.endsWith('/login')){assert.equal(JSON.parse(options.body).password,'private');return deny?new Response('private',{status:401}):Response.json({token:'session-token',base_url:'vip-api.opensubtitles.com'});}
		assert.equal(new URL(url).hostname,'vip-api.opensubtitles.com');assert.equal(options.headers.Authorization,'Bearer session-token');return Response.json({data:{}});
	}});
	await service.connect({key:'key',username:'name',password:'private'});assert.equal((await service.status()).account,true);
	deny=true;await assert.rejects(service.connect({key:'bad',username:'name',password:'private'}),/access was rejected/);
	assert.equal(JSON.parse(await readFile(path.join(directory,'opensubtitles.json'),'utf8')).key,'key');
});

test('plain SRT validation strips markup, rejects empty/oversized captions and bad timing',()=>{
	assert.equal(cleanSrt(cue).end,2);assert.match(cleanSrt(cue).text,/Hello world/);
	assert.throws(()=>cleanSrt('<html>error</html>'));
	assert.throws(()=>cleanSrt('x'.repeat(2*1024*1024+1)));
	assert.throws(()=>cleanSrt('1\n00:90:00,000 --> 01:00:00,000\nBad'));
});

test('canonical search redirects work but cannot forward credentials to another host or endpoint',async t=>{
	const directory=await mkdtemp(path.join(os.tmpdir(),'subtitle-redirect-'));t.after(()=>rm(directory,{recursive:true,force:true}));
	let target='',searches=0;
	const service=createSubtitleLookup({directory,fetcher:async(url,options)=>{
		const u=new URL(url);assert.equal(u.origin,'https://api.opensubtitles.com');assert.equal(options.redirect,'manual');
		if(u.pathname.endsWith('/infos/languages'))return Response.json({data:[]});
		assert.equal(u.pathname,'/api/v1/subtitles');assert.equal(options.headers['Api-Key'],'private-fixture');
		searches++;assert.equal(u.searchParams.has('machine_translated'),false);
		if(u.searchParams.has('canonical')&&!target)return Response.json({data:[]});
		return new Response(null,{status:301,headers:{Location:target||url+'&canonical=1'}});
	}});
	await service.connect({key:'private-fixture'});await service.lookup({item:movie});assert.equal(searches,2);assert.equal((await service.status()).notice,'');
	for(const destination of ['https://untrusted.example/api/v1/subtitles','http://api.opensubtitles.com/api/v1/subtitles','https://api.opensubtitles.com/api/v1/login']){
		target=destination;const before=searches;await service.lookup({item:movie,fingerprint:target});assert.equal(searches,before+1);assert.match((await service.status()).notice,/unsupported search redirect/);
	}
	target='https://api.opensubtitles.com/api/v1/subtitles?loop=1';const before=searches;await service.lookup({item:movie,fingerprint:'loop'});assert.equal(searches,before+4);
});

test('VOD subtitle preference selects embedded English first, honours Off and exposes downloaded track',()=>{
	const tracks=vodSubtitleTracks([{codec_type:'video',index:0},{codec_type:'subtitle',codec_name:'subrip',index:2,tags:{language:'fra'}},{codec_type:'subtitle',codec_name:'ass',index:3,tags:{language:'eng'}}]);
	const external={index:downloadedSubtitleIndex,file:'/safe/sub.srt'};
	assert.equal(selectVodSubtitle({preferEnglishSubtitles:true},tracks,external).index,3);
	assert.equal(selectVodSubtitle({subtitleIndex:-1,preferEnglishSubtitles:true},tracks,external),null);
	assert.equal(selectVodSubtitle({subtitleIndex:downloadedSubtitleIndex},tracks,external),external);
	assert.equal(selectVodSubtitle({preferEnglishSubtitles:true},tracks.slice(0,1),external),external);
	const filter=vodVideoFilter({offset:40,subtitle:external,url:'http://127.0.0.1:123/test'})[1];assert.ok(filter.indexOf('setpts=PTS+40/TB')<filter.indexOf('subtitles='));assert.match(filter,/DejaVu Sans/);
});
