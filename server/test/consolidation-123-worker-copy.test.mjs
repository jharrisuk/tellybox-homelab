import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createWorkerPlayers} from '../../relay/worker/players.mjs';
import {capabilities,hasFfmpeg,hevcMixedGop,hevcSmall,rangeOpener} from './consolidation-123-vod-fixture.mjs';

test('worker VOD adapter forwards capabilities into the real copy player and reports it',{skip:!hasFfmpeg,timeout:180000},async t=>{
	const {file}=await hevcSmall({seconds:24});
	const bytes=await readFile(file);
	const upstream={
		origin:'http://127.0.0.1:9',
		fetcher:async()=>{throw Object.assign(Error('upstream fetcher not used by VOD'),{status:500});},
		stream:rangeOpener(bytes),
		recordingFile:async()=>{throw Object.assign(Error('recording not used'),{status:404});},
		liveStream:async()=>{throw Object.assign(Error('live not used'),{status:404});},
		catchupSession:async()=>{throw Object.assign(Error('catch-up not used'),{status:404});},
		stopStream:async()=>{}
	};
	const worker=createWorkerPlayers({upstream});
	const request={
		mode:'vod',
		params:{type:'movie',uuid:'11111111-1111-1111-1111-111111111111',provider:'Dispatcharr'},
		options:{capabilities:capabilities(),quality:20000000,textSubtitles:false}
	};
	const probe=await worker.probe(request);
	assert.equal(probe.method,'Copy','the worker probe must report the real copy path');
	assert.equal(probe.videoCodec,'hevc');
	assert.equal(probe.audioCodec,'aac');
	const session=await worker.start(request);
	try {
		assert.equal(session.method,'Copy');
		assert.equal(session.videoCodec,'hevc');
		const segment=await session.read('segment000000000.ts');
		assert.ok(segment.length>1000);
	} finally {
		await session.stop();
	}
});

test('worker prepare metadata agrees with the actual player on an irregular GOP',{skip:!hasFfmpeg,timeout:180000},async t=>{
	const {file}=await hevcMixedGop();
	const bytes=await readFile(file);
	const upstream={
		origin:'http://127.0.0.1:9',
		fetcher:async()=>{throw Object.assign(Error('unused'),{status:500});},
		stream:rangeOpener(bytes),
		recordingFile:async()=>{throw Object.assign(Error('unused'),{status:404});},
		liveStream:async()=>{throw Object.assign(Error('unused'),{status:404});},
		catchupSession:async()=>{throw Object.assign(Error('unused'),{status:404});},
		stopStream:async()=>{}
	};
	const worker=createWorkerPlayers({upstream});
	const request={mode:'vod',params:{type:'movie',uuid:'22222222-2222-2222-2222-222222222222',provider:'Dispatcharr'},
		options:{capabilities:capabilities(),quality:20000000,textSubtitles:false}};
	const probe=await worker.probe(request);
	assert.equal(probe.method,'Transcode','no proven whole-title GOP plan must be reported as Transcode');
	const session=await worker.start(request);
	try {
		assert.equal(session.method,'Transcode','the actual player must use the same no-copy decision');
		assert.equal(session.videoCodec,'h264');
	} finally {
		await session.stop();
	}
});
