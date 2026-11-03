import test from 'node:test';
import assert from 'node:assert/strict';
import {trailerView,youtubeKey} from '../trailers.mjs';

test('only exact YouTube trailer identities are accepted',()=>{
	assert.equal(youtubeKey('https://www.youtube.com/watch?v=dQw4w9WgXcQ'),'dQw4w9WgXcQ');
	assert.equal(youtubeKey('https://youtu.be/dQw4w9WgXcQ?t=10'),'dQw4w9WgXcQ');
	assert.equal(youtubeKey('https://www.youtube.com/embed/dQw4w9WgXcQ'),'dQw4w9WgXcQ');
	assert.equal(youtubeKey('https://www.youtube-nocookie.com/shorts/dQw4w9WgXcQ'),'dQw4w9WgXcQ');
	for(const value of ['http://www.youtube.com/watch?v=dQw4w9WgXcQ','javascript:alert(1)','https://vimeo.com/123','https://youtube.com.evil.test/watch?v=dQw4w9WgXcQ','https://www.youtube.com/watch?v=short','https://user:pass@youtube.com/watch?v=dQw4w9WgXcQ','not a url'])assert.equal(youtubeKey(value),null,value);
});

test('a real trailer is preferred and returned as one canonical HTTPS link',()=>{
	const result=trailerView({relatedVideos:[
		{type:'Teaser',site:'YouTube',key:'aaaaaaaaaaa',name:'Teaser'},
		{type:'Trailer',site:'YouTube',key:'bbbbbbbbbbb',name:'Ordinary'},
		{type:'Trailer',site:'YouTube',key:'ccccccccccc',name:'Official',official:true}
	]});
	assert.deepEqual(result,{Provider:'YouTube',Key:'ccccccccccc',Name:'Official',Url:'https://www.youtube.com/watch?v=ccccccccccc'});
});

test('Jellyfin RemoteTrailers and TMDB videos are supported without arbitrary hosts',()=>{
	assert.deepEqual(trailerView({remoteTrailers:[{Url:'https://youtu.be/dQw4w9WgXcQ',Name:'Trailer'}]}),
		{Provider:'YouTube',Key:'dQw4w9WgXcQ',Name:'Trailer',Url:'https://www.youtube.com/watch?v=dQw4w9WgXcQ'});
	assert.deepEqual(trailerView({videos:{results:[{type:'Trailer',site:'YouTube',key:'dQw4w9WgXcQ',name:'Clip'}]}}),
		{Provider:'YouTube',Key:'dQw4w9WgXcQ',Name:'Clip',Url:'https://www.youtube.com/watch?v=dQw4w9WgXcQ'});
	for(const input of [
		null,{}, {relatedVideos:[]}, {remoteTrailers:[{Url:'https://evil.test/watch?v=dQw4w9WgXcQ'}]},
		{videos:{results:[{type:'Trailer',site:'Vimeo',key:'dQw4w9WgXcQ'}]}},
		{relatedVideos:[{type:'Clip',site:'YouTube',key:'dQw4w9WgXcQ'}]}
	])assert.equal(trailerView(input),null);
});

test('malformed trailer names and entries cannot break metadata',()=>{
	const result=trailerView({relatedVideos:[{type:'Trailer',site:'YouTube',key:'dQw4w9WgXcQ',name:'x'.repeat(500)}]});
	assert.equal(result.Name.length,200);assert.equal(result.Url,'https://www.youtube.com/watch?v=dQw4w9WgXcQ');
});
