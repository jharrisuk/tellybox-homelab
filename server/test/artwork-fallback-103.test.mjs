import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const read = name => readFileSync(new URL('../public/' + name, import.meta.url), 'utf8');

test('artwork fallback is loaded on every image surface',()=>{
	for(const page of ['index.html','discover.html','search.html'])assert.match(read(page),/src="\/artwork-fallback\.js"/,page);
	const fallback=read('artwork-fallback.js');
	assert.match(fallback,/addEventListener\('error'/);
	assert.match(fallback,/tellyboxArtworkStage/);
	assert.match(fallback,/stopImmediatePropagation/);
	for(const script of ['discover.js','search.js','app.js'])assert.match(read(script),/tellyboxPoster/,script);
	assert.match(read('asset-fallback.js'),/hasAttribute\('data-tellybox-poster'\)/,'asset fallback must not consume artwork poster fallbacks');
});

test('discovery and search remember the public TMDB poster fallback',()=>{
	assert.match(read('discover.js'),/dataset\.tellyboxPoster = 'https:\/\/image\.tmdb\.org\/t\/p\/w342'/);
	assert.match(read('search.js'),/dataset\.tellyboxPoster='https:\/\/image\.tmdb\.org\/t\/p\/w342'/);
	assert.match(read('app.js'),/dataset\.tellyboxPoster = 'https:\/\/image\.tmdb\.org\/t\/p\/w342'/);
});
