import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {
	createVodPlayer, createEncoderDiagnosticRetention, sanitizeEncoderDiagnostics, vodCopyEligible
} from '../vod-player.mjs';
import {deviceProfile,jellyfinTranscodeReason,relayConversionReason} from '../playback-profile.mjs';
import {sanitizeCapabilities, sanitizeNativeAudio} from '../capabilities.mjs';
import {capabilities,fileOpener,h264Aac,hasFfmpeg} from './consolidation-123-vod-fixture.mjs';

test('terminal encoder diagnostics redact URLs, tokens, credentials and provider paths', () => {
	const raw=Buffer.from([
		'\x1b[31mError opening input https://user:pass@provider.example/live/account-7?token=abc123&signature=deadbeef\x1b[0m',
		'frame=12 fps=0.0 out_time_us=0 speed=0x',
		'Unable to open /media/provider/account-7/payload/movie.mkv',
		'Windows path C:\\Users\\relay\\provider-cache\\private.bin',
		'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature123',
		'secret=0123456789abcdef0123456789abcdef0123456789abcdef',
		'client=ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/==',
		'Authorization: Basic Zm9vOmJhcg==',
		'username=alice password=secret123',
		'%74oken=secret123',
		'could not open /secret',
		'"token":"secret123"'
	].join('\n'),'utf8');
	const result=sanitizeEncoderDiagnostics(raw,{exitCode:1,limitLines:8,limitChars:1200});
	assert.equal(result.category,'input_open');
	assert.equal(result.code,'VOD_ENCODER_INPUT_OPEN');
	assert.equal(result.exitCode,1);
	assert.ok(result.lines.length<=8);
	assert.ok(JSON.stringify(result).length<=1600);
	const text=JSON.stringify(result);
	for(const secret of ['provider.example','abc123','deadbeef','user:pass','/media/provider','C:\\\\Users','eyJhbGci','0123456789abcdef0123456789abcdef','ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz','Zm9vOmJhcg','alice','secret123','%74oken']) {
		assert.ok(!text.includes(secret),`diagnostics leaked ${secret}: ${text}`);
	}
	assert.ok(!text.includes('/secret'),'single-segment secret paths are removed');
	assert.match(result.summary,/input/i);
	assert.match(result.userSummary,/Try another quality or source/);
});

test('terminal encoder diagnostics keep only bounded meaningful tail lines', () => {
	const lines=Array.from({length:60},(_,index)=>`error detail ${index}`);
	const result=sanitizeEncoderDiagnostics(lines.join('\n'),{limitLines:5,limitChars:1200});
	assert.deepEqual(result.lines,['error detail 55','error detail 56','error detail 57','error detail 58','error detail 59']);
	const huge=sanitizeEncoderDiagnostics('error '+'word '.repeat(2000),{limitLines:8,limitChars:240});
	assert.equal(huge.lines.length,1);
	assert.ok(huge.lines[0].length<=240);
	assert.ok(huge.lines[0].startsWith('\u2026'));
	assert.ok(JSON.stringify(huge).length<500);
});

test('terminal encoder diagnostics map stable categories without inventing causes', () => {
	const cases=[
		['Error opening input: No such file or directory','input_open'],
		['Server returned 403 Forbidden','http_status'],
		['Server returned 5XX Server Error reply','http_status'],
		['Invalid data found when processing input','invalid_data'],
		['Decoder (codec h264) not found for input stream #0:0','unsupported_codec'],
		['Error while decoding stream #0:0: Invalid NAL unit size','decoder_error'],
		['Error initializing output stream 0:0 -- Error while opening encoder for output stream #0:0','conversion_failed'],
		['Could not write header for output file #0: Permission denied','permission'],
		['Connection timed out','timeout']
	];
	for(const [line,category] of cases) {
		const result=sanitizeEncoderDiagnostics(line,{exitCode:1});
		assert.equal(result.category,category,`${line} -> ${result.category}`);
		assert.match(result.code,/^VOD_ENCODER_[A-Z_]+$/);
	}
	assert.equal(sanitizeEncoderDiagnostics('',{exitCode:1}).category,'encoder_exit');
	assert.equal(sanitizeEncoderDiagnostics('',{exitCode:1}).code,'VOD_ENCODER_EXIT');
	assert.equal(sanitizeEncoderDiagnostics('something unexpected').category,'unknown');
	assert.equal(sanitizeEncoderDiagnostics('something unexpected').exitCode,undefined);
});

test('complete-line retention is chunk-safe for every character split and bounded', () => {
	const secret='SYNTHETIC_PRIVATE_VALUE';
	const basic='Zm9vOlNZTlRIRVRJQ19QUklWQVRFX1ZBTFVF';
	const samples=[
		`error https://provider.invalid/file?token=${secret}`,
		`error %74oken=${secret}`,
		`error Authorization: Basic ${basic}`,
		`error /private/${secret}`,
		`error username=${secret} password=${secret}`
	];
	for(const sample of samples){
		for(let split=1;split<sample.length;split++){
			const retention=createEncoderDiagnosticRetention();
			retention.push(sample.slice(0,split));
			retention.push(sample.slice(split)+'\n');
			const text=retention.flush();
			assert.ok(!text.includes(secret),`split ${split} leaked the synthetic secret: ${text}`);
			assert.ok(!text.includes(basic),`split ${split} leaked the Basic value: ${text}`);
			assert.ok(text.length<=4096);
		}
		// The same boundaries without a trailing newline must be redacted at flush.
		const retention=createEncoderDiagnosticRetention();
		retention.push(sample.slice(0,8));
		retention.push(sample.slice(8));
		const text=retention.flush();
		assert.ok(!text.includes(secret)&&!text.includes(basic),`flush leaked: ${text}`);
	}
	const large=createEncoderDiagnosticRetention({limit:512});
	large.push(`error https://provider.invalid/?token=${secret} `+'A'.repeat(1024*1024));
	const largeText=large.flush();
	assert.ok(!largeText.includes(secret),'a 1 MiB no-newline chunk must not retain its secret');
	assert.ok(largeText.length<=512,'retained output stays bounded for a 1 MiB chunk');
	const overflow=createEncoderDiagnosticRetention({maxLine:4096});
	overflow.push('x'.repeat(8192));
	overflow.push(secret+'\n');
	overflow.push('safe line\n');
	const overflowText=overflow.flush();
	assert.ok(!overflowText.includes(secret),'an over-limit line is dropped without retaining its suffix');
	assert.match(overflowText,/safe line/);
});

test('the real stderr callback uses complete-line retention and logs nothing raw', () => {
	const source=readFileSync(new URL('../vod-player.mjs',import.meta.url),'utf8');
	const start=source.indexOf("child.stderr.on('data',chunk=>{",source.indexOf('// New generation:'));
	const end=source.indexOf("child.on('error'",start);
	let callback=null;
	const logs=[];
	const child={__vodGeneration:2,stderr:{on:(event,fn)=>{if(event==='data')callback=fn;}}};
	const job={child,generation:2,stopped:false,stderrRetention:createEncoderDiagnosticRetention(),outTimeUs:0,speed:''};
	vm.runInNewContext(source.slice(start,end),{child,job,process:{env:{VOD_DEBUG:'1'}},console:{error:(...args)=>logs.push(args.map(String).join(' '))}});
	assert.equal(typeof callback,'function');
	const secret='SYNTHETIC_PRIVATE_VALUE';
	const sample=`error https://provider.invalid/file?token=${secret}\n`;
	for(let split=1;split<sample.length;split++){
		job.stderrRetention=createEncoderDiagnosticRetention();
		callback(Buffer.from(sample.slice(0,split)));
		callback(Buffer.from(sample.slice(split)));
		const text=job.stderrRetention.flush();
		assert.ok(!text.includes(secret),`callback split ${split} leaked the synthetic secret: ${text}`);
	}
	job.stderrRetention=createEncoderDiagnosticRetention();
	callback(Buffer.from('A'.repeat(1024*1024)));
	const text=job.stderrRetention.flush();
	assert.ok(text.length<=4096,'a 1 MiB callback chunk is bounded');
	assert.deepEqual(logs,[],'the stderr callback must not log raw chunks or lines');
});

test('a stale child stderr or error callback cannot mutate or stop a newer producer', () => {
	const source=readFileSync(new URL('../vod-player.mjs',import.meta.url),'utf8');
	const stderrStart=source.indexOf("child.stderr.on('data',chunk=>{",source.indexOf('// New generation:'));
	const errorStart=source.indexOf("child.on('error'",stderrStart);
	const closeStart=source.indexOf("child.on('close'",errorStart);
	assert.ok(stderrStart>0&&errorStart>stderrStart&&closeStart>errorStart,'the guarded callbacks must exist');
	let stderrCallback=null,errorCallback=null;
	const oldChild={__vodGeneration:1,stderr:{on:(event,fn)=>{if(event==='data')stderrCallback=fn;}},
		on:(event,fn)=>{if(event==='error')errorCallback=fn;}};
	const newChild={__vodGeneration:2};
	const job={child:newChild,generation:2,stderr:'new generation',speed:'',outTimeUs:0,stopped:false,url:'private',
		produced:-1,requested:0,windowStart:0,windowEnd:29,lastFailure:null,exitGeneration:0};
	vm.runInNewContext(source.slice(stderrStart,errorStart),{child:oldChild,job,process:{env:{VOD_DEBUG:'1'}},console});
	assert.equal(typeof stderrCallback,'function');
	stderrCallback(Buffer.from('HTTP 403 Forbidden\nspeed=0.01x\n'));
	assert.equal(job.stderr,'new generation','a different current child must ignore stale stderr');
	assert.equal(job.speed,'','a stale child must not change current speed');
	// Same object but an older generation is also stale.
	job.child=oldChild;job.stderr='sentinel';
	stderrCallback(Buffer.from('token=leaked speed=9x\n'));
	assert.equal(job.stderr,'sentinel');
	assert.equal(job.speed,'');

	let stopped=0;
	vm.runInNewContext(source.slice(errorStart,closeStart),{child:oldChild,job,process:{env:{}},console,stop:()=>{stopped++;}});
	assert.equal(typeof errorCallback,'function');
	errorCallback(Error('stale spawn failure'));
	assert.equal(stopped,0,'an old child error must not stop the newer producer');
	assert.equal(job.lastFailure,null);
});

test('a real local ffmpeg input failure fails fast with VOD_ENCODER_EXIT and safe diagnostics',{skip:!hasFfmpeg,timeout:120000},async t=>{
	const fixture=await h264Aac({seconds:16});
	let broken=false;
	const open=async(source,options)=>{
		if(broken)return new Response('',{status:503});
		return fileOpener(fixture.file)(source,options);
	};
	const player=createVodPlayer({open});
	const session=await player.start({type:'movie',uuid:'local-failure-126'},{quality:8000000});
	try {
		assert.equal(session.method,'Transcode');
		broken=true;
		const started=Date.now();
		await assert.rejects(()=>session.read('segment000000000.ts'),error=>{
			assert.equal(error.status,502);
			assert.equal(error.code,'VOD_ENCODER_EXIT');
			assert.match(error.message,/could not be started|Try another quality or source/);
			assert.doesNotMatch(error.message,/https?:|127\.0\.0\.1|token=|Users\\/i);
			return true;
		});
		assert.ok(Date.now()-started<15000,'a terminal child exit must not wait the full stall deadline');
		const diagnostics=JSON.parse(session.diagnostics());
		assert.ok(diagnostics.failure,'the terminal failure must be retained without VOD_DEBUG');
		assert.match(diagnostics.failure.code,/^VOD_ENCODER_/);
		assert.ok(['http_status','input_open','encoder_exit','unknown'].includes(diagnostics.failure.category),diagnostics.failure.category);
		assert.ok(Number.isInteger(diagnostics.exitCode)&&diagnostics.exitCode!==0,
			`a real child exit must be retained without normalizing/hiding it; got ${diagnostics.exitCode}`);
		assert.ok(session.diagnostics().length<=2048);
		assert.doesNotMatch(session.diagnostics(),/https?:|127\.0\.0\.1|token=|Users\\/i);

		// A later generation must not inherit the previous failure once it starts.
		broken=false;
		const next=await session.read('segment000000001.ts');
		assert.ok(next.length>1000);
		assert.equal(JSON.parse(session.diagnostics()).failure,undefined,'old generation failure must not taint a new generation');
	} finally {
		await session.stop();
	}
});

test('native direct-play profile uses sanitized native audio and only gated HEVC', () => {
	const caps=sanitizeCapabilities({videoCodecs:['h264','hevc'],audioCodecs:['aac','eac3'],maxWidth:1920,maxHeight:1080,
		maxBitrate:20000000,maxFps:30,hevcMaxWidth:1920,hevcMaxHeight:1080,hevcMaxBitrate:20000000,hevcMaxFps:30,
		hevcProfiles:['main','main10'],hevcPixelFormats:['yuv420p','yuv420p10le'],hevcMaxLevel:186,
		hevcMain10:true,hls:true,mpegTs:true});
	assert.equal(caps.hevcEvidence,true,'full explicit HEVC fields are evidence');
	const tv=deviceProfile(false,8000000,true,['eac3','flac','bogus-codec'],caps);
	assert.equal(tv.DirectPlayProfiles[0].VideoCodec,'h264','H.264 stays the default direct profile');
	assert.match(tv.DirectPlayProfiles[0].Container,/mkv/);
	assert.match(tv.DirectPlayProfiles[0].AudioCodec,/eac3/);
	assert.match(tv.DirectPlayProfiles[0].AudioCodec,/flac/);
	assert.doesNotMatch(tv.DirectPlayProfiles[0].AudioCodec,/bogus/);
	const hevc=tv.DirectPlayProfiles.find(profile=>profile.VideoCodec==='hevc');
	assert.ok(hevc,'an Android native profile with proven HEVC advertises HEVC DirectPlay');
	assert.match(hevc.Container,/mkv/);
	assert.match(hevc.AudioCodec,/eac3/);
	assert.doesNotMatch(hevc.AudioCodec,/bogus/);
	const hevcConditions=tv.CodecProfiles.find(profile=>profile.Codec==='hevc').Conditions;
	const depth=hevcConditions.find(condition=>condition.Property==='VideoBitDepth');
	assert.equal(depth.Value,'10','Main10 proves at most 10-bit, never an unconditional enable');
	assert.equal(hevcConditions.find(condition=>condition.Property==='VideoLevel').Value,'186');
	assert.equal(hevcConditions.find(condition=>condition.Property==='Width').Value,'1920');
	assert.equal(hevcConditions.find(condition=>condition.Property==='Height').Value,'1080');
	assert.equal(hevcConditions.find(condition=>condition.Property==='VideoFramerate').Value,'30');
	assert.equal(hevcConditions.find(condition=>condition.Property==='VideoBitrate').Value,'8000000','the quality ceiling caps HEVC too');

	const main8=deviceProfile(false,8000000,true,[],{...caps,hevcMain10:false});
	assert.equal(main8.CodecProfiles.find(profile=>profile.Codec==='hevc').Conditions
		.find(condition=>condition.Property==='VideoBitDepth').Value,'8');
	assert.equal(main8.CodecProfiles.find(profile=>profile.Codec==='hevc').Conditions
		.find(condition=>condition.Property==='VideoProfile').Value,'main');
	assert.equal(main8.DirectPlayProfiles.find(profile=>profile.VideoCodec==='hevc').AudioCodec,'aac,mp3');

	const browser=deviceProfile(false,8000000,false,['eac3'],caps);
	assert.equal(browser.DirectPlayProfiles.some(profile=>profile.VideoCodec==='hevc'),false,'browser non-native keeps H.264-only direct play');
	assert.equal(browser.DirectPlayProfiles[0].AudioCodec,'aac,mp3');
	const h264Only=deviceProfile(false,8000000,true,[],{...caps,videoCodecs:['h264'],hevcMain10:true});
	assert.equal(h264Only.DirectPlayProfiles.some(profile=>profile.VideoCodec==='hevc'),false,'a Main10 flag without HEVC in the codec list fails closed');
	assert.deepEqual(deviceProfile(true,8000000,true,[],caps).DirectPlayProfiles,[],'forced compatibility keeps no direct profile');
	assert.deepEqual(sanitizeNativeAudio(['eac3','eac3','dts','made-up']),['eac3','dts']);
});

test('Android capability contract bounds profiles, levels, pixel formats, containers and audio channels', () => {
	const caps=sanitizeCapabilities({clientKind:'android-tv',videoCodecs:['hevc','h264','vp9'],audioCodecs:['aac','eac3'],
		containers:['mkv','mp4','webm','ts','mov','avi','mp4'],h264Profiles:['high','main','bogus'],hevcProfiles:['main','main10'],
		h264PixelFormats:['yuv420p','yuv422p10le'],hevcPixelFormats:['yuv420p','yuv420p10le'],
		h264MaxLevel:999,hevcMaxLevel:999,maxAudioChannels:6,audioChannels:{aac:2,eac3:9,dts:6,bogus:2},
		maxWidth:3840,maxHeight:2160,maxBitrate:80000000,maxFps:60,hevcMaxWidth:3840,hevcMaxHeight:2160,hevcMaxBitrate:80000000,hevcMaxFps:60,
		hevcMain10:true,hls:true,mpegTs:true});
	assert.equal(caps.clientKind,'android-tv');
	assert.deepEqual(caps.containers,['mkv','mp4','webm','ts','mov'],'unknown containers are dropped');
	assert.deepEqual(caps.h264Profiles,['high','main']);
	assert.deepEqual(caps.hevcProfiles,['main','main10']);
	assert.deepEqual(caps.h264PixelFormats,['yuv420p']);
	assert.deepEqual(caps.hevcPixelFormats,['yuv420p','yuv420p10le']);
	assert.equal(caps.h264MaxLevel,62);
	assert.equal(caps.hevcMaxLevel,186);
	assert.equal(caps.maxAudioChannels,6);
	assert.deepEqual(caps.audioChannels,{aac:2,dts:6},'out-of-range and unknown audio channel claims are dropped');
	assert.equal(sanitizeCapabilities({clientKind:'web',videoCodecs:['h264'],audioCodecs:['aac']}).clientKind,undefined);
	const empty=deviceProfile(false,20000000,true,[],{...caps,containers:[]});
	assert.deepEqual(empty.DirectPlayProfiles,[],'an explicit empty container claim fails direct play closed');
});

test('Android HEVC Main10 direct play requires profile, level, pixel format and container evidence', () => {
	const base={clientKind:'android-tv',videoCodecs:['hevc','h264'],audioCodecs:['aac','eac3'],containers:['mkv','mp4','webm','ts'],
		h264Profiles:['high','main'],hevcProfiles:['main','main10'],h264PixelFormats:['yuv420p'],hevcPixelFormats:['yuv420p','yuv420p10le'],
		h264MaxLevel:41,hevcMaxLevel:153,maxAudioChannels:6,audioChannels:{aac:2,eac3:6},
		maxWidth:3840,maxHeight:2160,maxBitrate:80000000,maxFps:60,hevcMaxWidth:3840,hevcMaxHeight:2160,hevcMaxBitrate:80000000,hevcMaxFps:60,
		hevcMain10:true,hls:true,mpegTs:true};
	const tv=deviceProfile(false,20000000,true,['eac3'],base);
	const hevc=tv.DirectPlayProfiles.find(profile=>profile.VideoCodec==='hevc');
	assert.ok(hevc);
	assert.equal(hevc.Container,'mp4,mkv','only the native allowed containers are advertised');
	assert.match(hevc.AudioCodec,/eac3/);
	const conditions=tv.CodecProfiles.find(profile=>profile.Codec==='hevc').Conditions;
	assert.equal(conditions.find(condition=>condition.Property==='VideoBitDepth').Value,'10');
	assert.equal(conditions.find(condition=>condition.Property==='VideoLevel').Value,'153');
	assert.equal(conditions.find(condition=>condition.Property==='VideoProfile').Value,'main|main 10');
	const h264Conditions=tv.CodecProfiles.find(profile=>profile.Codec==='h264').Conditions;
	assert.equal(h264Conditions.find(condition=>condition.Property==='VideoLevel').Value,'41','the advertised H.264 level tightens the existing ceiling');
	assert.equal(h264Conditions.find(condition=>condition.Property==='VideoProfile').Value,'high|main');
	assert.equal(h264Conditions.find(condition=>condition.Property==='VideoBitDepth').Value,'8');
	const audioProfiles=tv.CodecProfiles.filter(profile=>profile.Type==='Audio');
	assert.ok(audioProfiles.some(profile=>profile.Codec==='eac3'&&profile.Conditions[0].Value==='6'));

	// Main10 flag but no 10-bit pixel format is contradictory proof: no HEVC.
	const noTen=deviceProfile(false,20000000,true,['eac3'],{...base,hevcPixelFormats:['yuv420p']});
	assert.equal(noTen.DirectPlayProfiles.some(profile=>profile.VideoCodec==='hevc'),false);
	// Main10-only profile plus no 10-bit pixel format proves nothing.
	const noTenAtAll=deviceProfile(false,20000000,true,['eac3'],{...base,hevcProfiles:['main10'],hevcPixelFormats:['yuv420p']});
	assert.equal(noTenAtAll.DirectPlayProfiles.some(profile=>profile.VideoCodec==='hevc'),false);
	// An explicit unknown HEVC level (0) must not advertise HEVC.
	const noLevel=deviceProfile(false,20000000,true,['eac3'],{...base,hevcMaxLevel:0});
	assert.equal(noLevel.DirectPlayProfiles.some(profile=>profile.VideoCodec==='hevc'),false);
	// H.264 10-bit-only evidence tightens H.264 direct play away.
	const noH264=deviceProfile(false,20000000,true,[],{...base,h264PixelFormats:['yuv420p10le'],hevcPixelFormats:[]});
	assert.equal(noH264.CodecProfiles.find(profile=>profile.Codec==='h264').Conditions
		.find(condition=>condition.Property==='VideoBitDepth').Value,'0');
	// Forced compatibility and browser remain H.264-only/no direct play.
	assert.deepEqual(deviceProfile(true,20000000,true,['eac3'],base).DirectPlayProfiles,[]);
	const browser=deviceProfile(false,20000000,false,['eac3'],base);
	assert.equal(browser.DirectPlayProfiles.some(profile=>profile.VideoCodec==='hevc'),false);
	assert.equal(browser.DirectPlayProfiles[0].Container,'mp4','browser keeps its own container intersection');
	assert.equal(browser.DirectPlayProfiles[0].AudioCodec,'aac,mp3');
});

test('provider copy uses the Android profile/level/pixel-format and level contract', () => {
	const caps=sanitizeCapabilities({clientKind:'android-tv',videoCodecs:['hevc','h264'],audioCodecs:['aac'],containers:['mkv','mp4'],
		h264Profiles:['high'],hevcProfiles:['main','main10'],h264PixelFormats:['yuv420p'],hevcPixelFormats:['yuv420p','yuv420p10le'],
		h264MaxLevel:41,hevcMaxLevel:153,maxWidth:3840,maxHeight:2160,maxBitrate:80000000,maxFps:60,
		hevcMaxWidth:3840,hevcMaxHeight:2160,hevcMaxBitrate:80000000,hevcMaxFps:60,hevcMain10:true,hls:true,mpegTs:true});
	const format={format_name:'matroska',bit_rate:8000000};
	const audio={codec_name:'aac',channels:2};
	const hevc={codec_name:'hevc',profile:'Main 10',level:153,pix_fmt:'yuv420p10le',width:1920,height:1080,r_frame_rate:'25/1',bit_rate:7000000};
	assert.equal(vodCopyEligible(hevc,format,{capabilities:caps,quality:20000000,audio,container:'matroska'}),true);
	assert.equal(vodCopyEligible({...hevc,level:154},format,{capabilities:caps,quality:20000000,audio,container:'matroska'}),false,'source level above the device HEVC level fails closed');
	const noTen=sanitizeCapabilities({...caps,hevcPixelFormats:['yuv420p']});
	assert.equal(vodCopyEligible(hevc,format,{capabilities:noTen,quality:20000000,audio,container:'matroska'}),false,'10-bit source without 10-bit pixel-format evidence fails closed');
	const noLevel=sanitizeCapabilities({...caps,hevcMaxLevel:0});
	assert.equal(vodCopyEligible(hevc,format,{capabilities:noLevel,quality:20000000,audio,container:'matroska'}),false,'unknown HEVC level fails closed');
	const h264={codec_name:'h264',profile:'High',level:52,pix_fmt:'yuv420p',width:1920,height:1080,r_frame_rate:'25/1',bit_rate:7000000};
	assert.equal(vodCopyEligible(h264,format,{capabilities:caps,quality:20000000,audio,container:'matroska'}),false,'H.264 level above the advertised level fails closed');
	assert.equal(vodCopyEligible({...h264,level:41,profile:'Main'},format,{capabilities:caps,quality:20000000,audio,container:'matroska'}),false,'H.264 profile not in the advertised list fails closed');
	assert.equal(vodCopyEligible({...h264,level:41},format,{capabilities:caps,quality:20000000,audio,container:'matroska'}),true);
	assert.equal(vodCopyEligible({...hevc,profile:undefined},format,{capabilities:caps,quality:20000000,audio,container:'matroska'}),false,'missing source profile fails closed');
	assert.equal(vodCopyEligible({...hevc,level:0},format,{capabilities:caps,quality:20000000,audio,container:'matroska'}),false,'missing source level fails closed');
	assert.equal(vodCopyEligible({...hevc,pix_fmt:undefined},format,{capabilities:caps,quality:20000000,audio,container:'matroska'}),false,'missing source pixel format fails closed');
});

test('relay conversion reasons are truthful, bounded and free of internals', () => {
	const cases=[
		[relayConversionReason('Copy'),'Provider stream copied without re-encoding'],
		[relayConversionReason('Remux'),'Provider video copied; audio converted to AAC stereo'],
		[relayConversionReason('Transcode'),'Provider source converted for this device'],
		[relayConversionReason('Relay'),'Relay playback prepared for this device'],
		[relayConversionReason('Copy',{recording:true}),'Recording copied without re-encoding'],
		[relayConversionReason('Remux',{recording:true}),'Recording video copied; audio converted to AAC stereo'],
		[relayConversionReason('Transcode',{recording:true}),'Recording converted for this device'],
		[relayConversionReason('Copy',{catchup:true}),'Catch-up stream copied without re-encoding'],
		[relayConversionReason('Remux',{catchup:true}),'Catch-up video copied; audio converted to AAC stereo'],
		[relayConversionReason('Transcode',{catchup:true}),'Catch-up source converted for this device']
	];
	for(const [actual,expected] of cases) {
		assert.equal(actual,expected);
		assert.doesNotMatch(actual,/https?:|token|capability|provider\.example/i);
		assert.ok(actual.length<=120);
	}
	assert.doesNotMatch(relayConversionReason('Transcode'),/DirectPlay/i,'a transcode is never described as DirectPlay');
});

test('minimal HEVC caps fail closed; explicit evidence is required', () => {
	const minimal=sanitizeCapabilities({videoCodecs:['hevc'],audioCodecs:['aac']});
	assert.equal(minimal.hevcEvidence,undefined,'codec names plus sanitizer defaults are not evidence');
	const profile=deviceProfile(false,8000000,true,[],minimal);
	assert.equal(profile.DirectPlayProfiles.some(entry=>entry.VideoCodec==='hevc'),false,'minimal caps must not get HEVC DirectPlay');
	assert.equal(profile.DirectPlayProfiles[0].VideoCodec,'h264','legacy H.264 behavior remains');
	const hevc={codec_name:'hevc',profile:'Main 10',level:153,pix_fmt:'yuv420p10le',width:1920,height:1080,r_frame_rate:'25/1',bit_rate:7000000};
	assert.equal(vodCopyEligible(hevc,{format_name:'matroska',bit_rate:8000000},{capabilities:minimal,quality:20000000,audio:{codec_name:'aac',channels:2},container:'matroska'}),false,'minimal caps must not get HEVC copy');
});

test('explicit empty profile/pixel evidence fails closed for local and provider paths', () => {
	const full={videoCodecs:['hevc','h264'],audioCodecs:['aac'],containers:['mkv','mp4'],h264Profiles:['high'],hevcProfiles:['main','main10'],
		h264PixelFormats:['yuv420p'],hevcPixelFormats:['yuv420p','yuv420p10le'],h264MaxLevel:41,hevcMaxLevel:153,
		maxWidth:1920,maxHeight:1080,maxBitrate:20000000,maxFps:30,hevcMaxWidth:1920,hevcMaxHeight:1080,hevcMaxBitrate:20000000,hevcMaxFps:30,
		hevcMain10:true,hls:true,mpegTs:true};
	const emptyHevcProfiles=deviceProfile(false,8000000,true,[],{...full,hevcProfiles:[]});
	assert.equal(emptyHevcProfiles.DirectPlayProfiles.some(entry=>entry.VideoCodec==='hevc'),false);
	const emptyHevcPixels=deviceProfile(false,8000000,true,[],{...full,hevcPixelFormats:[]});
	assert.equal(emptyHevcPixels.DirectPlayProfiles.some(entry=>entry.VideoCodec==='hevc'),false);
	const emptyH264=deviceProfile(false,8000000,true,[],{...full,h264Profiles:[],h264PixelFormats:[]});
	const h264Conditions=emptyH264.CodecProfiles.find(entry=>entry.Codec==='h264').Conditions;
	assert.equal(h264Conditions.find(condition=>condition.Property==='VideoProfile').Value,'__unsupported__');
	assert.equal(h264Conditions.find(condition=>condition.Property==='VideoBitDepth').Value,'0');
	const hevc={codec_name:'hevc',profile:'Main 10',level:153,pix_fmt:'yuv420p10le',width:1920,height:1080,r_frame_rate:'25/1',bit_rate:7000000};
	const format={format_name:'matroska',bit_rate:8000000},audio={codec_name:'aac',channels:2};
	assert.equal(vodCopyEligible(hevc,format,{capabilities:sanitizeCapabilities({...full,hevcProfiles:[]}),quality:20000000,audio,container:'matroska'}),false,'empty HEVC profile proof');
	assert.equal(vodCopyEligible(hevc,format,{capabilities:sanitizeCapabilities({...full,hevcPixelFormats:[]}),quality:20000000,audio,container:'matroska'}),false,'empty HEVC pixel proof');
	const h264={codec_name:'h264',profile:'High',level:41,pix_fmt:'yuv420p',width:1920,height:1080,r_frame_rate:'25/1',bit_rate:7000000};
	assert.equal(vodCopyEligible(h264,format,{capabilities:sanitizeCapabilities({...full,h264Profiles:[]}),quality:20000000,audio,container:'matroska'}),false,'empty H264 profile proof');
	assert.equal(vodCopyEligible(h264,format,{capabilities:sanitizeCapabilities({...full,h264PixelFormats:[]}),quality:20000000,audio,container:'matroska'}),false,'empty H264 pixel proof');
});

test('HEVC/H264 conditions require source metadata and enforce explicit geometry', () => {
	const hevcCaps={videoCodecs:['hevc','h264'],audioCodecs:['aac'],containers:['mkv'],h264Profiles:['high'],hevcProfiles:['main','main10'],
		h264PixelFormats:['yuv420p'],hevcPixelFormats:['yuv420p','yuv420p10le'],h264MaxLevel:41,hevcMaxLevel:153,
		maxWidth:1280,maxHeight:720,maxBitrate:8000000,maxFps:30,hevcMaxWidth:1280,hevcMaxHeight:720,hevcMaxBitrate:8000000,hevcMaxFps:30,
		hevcMain10:true,hls:true,mpegTs:true};
	const tv=deviceProfile(false,8000000,true,[],hevcCaps);
	const hevcConditions=tv.CodecProfiles.find(entry=>entry.Codec==='hevc').Conditions;
	for(const property of ['VideoBitDepth','VideoLevel','VideoProfile','VideoBitrate','Width','Height','VideoFramerate']) {
		const condition=hevcConditions.find(entry=>entry.Property===property);
		assert.ok(condition,`${property} condition exists`);
		assert.equal(condition.IsRequired,true,`${property} must fail when source metadata is missing`);
	}
	const h264Conditions=tv.CodecProfiles.find(entry=>entry.Codec==='h264').Conditions;
	for(const property of ['Width','Height','VideoFramerate']){
		const condition=h264Conditions.find(entry=>entry.Property===property);
		assert.ok(condition,`${property} H264 condition exists`);
		assert.equal(condition.IsRequired,true);
	}
	assert.equal(h264Conditions.find(entry=>entry.Property==='Width').Value,'1280');
	assert.equal(h264Conditions.find(entry=>entry.Property==='Height').Value,'720');
	assert.equal(h264Conditions.find(entry=>entry.Property==='VideoFramerate').Value,'30');
	const format={format_name:'matroska',bit_rate:8000000},audio={codec_name:'aac',channels:2};
	const caps=sanitizeCapabilities(hevcCaps);
	const hd={codec_name:'h264',profile:'High',level:41,pix_fmt:'yuv420p',width:1920,height:1080,r_frame_rate:'25/1',bit_rate:7000000};
	assert.equal(vodCopyEligible(hd,format,{capabilities:caps,quality:8000000,audio,container:'matroska'}),false,'a 720p device must not copy a 1080p source');
	const hevc={codec_name:'hevc',profile:'Main 10',level:153,pix_fmt:'yuv420p10le',width:1280,height:720,r_frame_rate:'30/1',bit_rate:6000000};
	assert.equal(vodCopyEligible(hevc,format,{capabilities:caps,quality:8000000,audio,container:'matroska'}),true);
	assert.equal(vodCopyEligible({...hevc,width:undefined},format,{capabilities:caps,quality:8000000,audio,container:'matroska'}),false,'missing source width fails');
	assert.equal(vodCopyEligible({...hevc,profile:undefined},format,{capabilities:caps,quality:8000000,audio,container:'matroska'}),false,'missing source profile fails');
	assert.equal(vodCopyEligible({...hevc,level:0},format,{capabilities:caps,quality:8000000,audio,container:'matroska'}),false,'missing source level fails');
	assert.equal(vodCopyEligible({...hevc,pix_fmt:undefined},format,{capabilities:caps,quality:8000000,audio,container:'matroska'}),false,'missing source pixel format fails');
});

test('Jellyfin transcoding reason is truthful and never claims DirectPlay', () => {
	const h264={MediaStreams:[{Type:'Video',Codec:'h264'}]};
	const audioOnly=jellyfinTranscodeReason(h264,'/Videos/x/master.m3u8?VideoCodec=h264&AudioCodec=aac&TranscodeReasons=AudioCodecNotSupported&AllowVideoStreamCopy=true');
	assert.equal(audioOnly,'Jellyfin: audio codec not supported (video copied, audio/container converted)');
	assert.doesNotMatch(audioOnly,/DirectPlay/);
	const hevcSource={MediaStreams:[{Type:'Video',Codec:'hevc'}]};
	const encode=jellyfinTranscodeReason(hevcSource,'/Videos/x/master.m3u8?VideoCodec=h264&AudioCodec=aac&TranscodeReasons=AudioCodecNotSupported&AllowVideoStreamCopy=true');
	assert.equal(encode,'Jellyfin: audio codec not supported','a different target codec is not called a video copy');
	const videoReason=jellyfinTranscodeReason(h264,'/Videos/x/master.m3u8?VideoCodec=h264&TranscodeReasons=VideoCodecNotSupported&AllowVideoStreamCopy=true');
	assert.equal(videoReason,'Jellyfin: video codec not supported');
	assert.equal(jellyfinTranscodeReason(h264,'/Videos/x/master.m3u8'),'Jellyfin requested transcoding (reason not provided)',
		'without TranscodeReasons the server keeps the generic reason');
	assert.equal(jellyfinTranscodeReason(h264,'',{burnSubtitles:true}),'Subtitles included in the picture');
	assert.equal(jellyfinTranscodeReason(h264,'',{forceTranscode:true}),'Compatible playback requested by this app');
});

test('copy eligibility uses the audio-inclusive container bitrate and the quality ceiling', () => {	const caps=capabilities({maxBitrate:20000000,hevcMaxBitrate:20000000});
	const video={codec_name:'hevc',profile:'Main',level:120,pix_fmt:'yuv420p',width:1920,height:1080,r_frame_rate:'25/1',bit_rate:4000000};
	const format={format_name:'matroska',bit_rate:9000000};
	const audio={codec_name:'aac',channels:2};
	assert.equal(vodCopyEligible(video,format,{capabilities:caps,quality:8000000,audio,container:'matroska'}),false,
		'the container bitrate (audio + video), not the smaller video bitrate, must obey the quality ceiling');
	assert.equal(vodCopyEligible(video,format,{capabilities:caps,quality:20000000,audio,container:'matroska'}),true);
});
