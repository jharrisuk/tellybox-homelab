import test from 'node:test';
import assert from 'node:assert/strict';
import { subtitleChoice } from '../subtitle-choice.mjs';
import { englishSubtitle } from '../subtitle-choice.mjs';

test('smooth caption clients prefer the first English text track over bitmap captions but respect manual choices',async()=>{
	const tracks=[{Type:'Subtitle',Language:'eng',Codec:'DVBSUB',Index:2},{Type:'Subtitle',Language:'eng',Codec:'subrip',Index:3},{Type:'Subtitle',Language:'eng',Codec:'ass',Index:4}];
	const request={preferEnglishSubtitles:true,textSubtitles:true};
	assert.equal(subtitleChoice(request,tracks),3);
	assert.equal(subtitleChoice({...request,subtitleIndex:2},tracks),2);
	assert.equal(subtitleChoice({...request,subtitleIndex:-1},tracks),-1);
	assert.equal(subtitleChoice(request,tracks.slice(0,1)),2);
	assert.equal(subtitleChoice({preferEnglishSubtitles:true},tracks),2);
	const {selectVodSubtitle}=await import('../vod-player.mjs');
	const vod=[{index:2,codec_name:'dvb_subtitle',tags:{language:'eng'}},{index:3,codec_name:'subrip',tags:{language:'eng'}}];
	assert.equal(selectVodSubtitle(request,vod,null).index,3);
	assert.equal(selectVodSubtitle({...request,subtitleIndex:2},vod,null).index,2);
	assert.equal(selectVodSubtitle({...request,subtitleIndex:-1},vod,null),null);
});

test('provider abbreviations, separators and regional labels choose the first English subtitle', async()=>{
	for(const label of ['ENG','eng [SDH]','[EN] Full','English_SDH','en-US','2 - ENG - Forced','ＥＮＧ']){
		assert.equal(englishSubtitle('und',label),true,label);
		const tracks=[{Type:'Audio',Language:'eng',Index:1},{Type:'Subtitle',Language:'fra',Title:'French',Index:2},{Type:'Subtitle',Language:'und',DisplayTitle:label,Index:3},{Type:'Subtitle',Language:'eng',Index:4}];
		assert.equal(subtitleChoice({preferEnglishSubtitles:true},tracks),3,label);
		assert.equal(subtitleChoice({preferEnglishSubtitles:true,subtitleIndex:-1},tracks),-1);
		const {selectVodSubtitle}=await import('../vod-player.mjs');
		assert.equal(selectVodSubtitle({preferEnglishSubtitles:true},[{index:2,tags:{language:'fra'}},{index:3,tags:{handler_name:label}},{index:4,tags:{language:'eng'}}],null).index,3);
	}
	for(const label of ['French','Bengali','Bengal','Engineering','Legend','Englishman','enforced'])assert.equal(englishSubtitle('und',label),false,label);
});

test('English preference selects the first English subtitle, never an audio track', () => {
	const tracks = [
		{ Type: 'Audio', Language: 'eng', Index: 1 },
		{ Type: 'Subtitle', Language: 'spa', Index: 2 },
		{ Type: 'Subtitle', Language: 'en-GB', Index: 3 },
		{ Type: 'Subtitle', Language: 'eng', Index: 4 }
	];
	assert.equal(subtitleChoice({ preferEnglishSubtitles: true }, tracks), 3);
	assert.equal(subtitleChoice({ preferEnglishSubtitles: true, subtitleIndex: -1 }, tracks), -1);
	assert.equal(subtitleChoice({ preferEnglishSubtitles: true, subtitleIndex: 4 }, tracks), 4);
	assert.equal(subtitleChoice({}, tracks), -1);
	assert.equal(subtitleChoice({ preferEnglishSubtitles: true }, tracks.slice(0, 2)), -1);
	assert.equal(subtitleChoice({ preferEnglishSubtitles: true }), -1);
});


test('English display names work without language tags and keep first-track ordering', async () => {
	const {englishSubtitle}=await import('../subtitle-choice.mjs');
	const tracks=[{Type:'Subtitle',Language:'spa',DisplayTitle:'Spanish',Index:1},{Type:'Subtitle',Language:'und',DisplayTitle:'English (SDH)',Index:2},{Type:'Subtitle',Language:'eng',Index:3}];
	assert.equal(subtitleChoice({preferEnglishSubtitles:true},tracks),2);
	assert.equal(subtitleChoice({preferEnglishSubtitles:true,subtitleIndex:-1},tracks),-1);
	assert.equal(englishSubtitle('', 'ENGLISH - Full'),true);
	assert.equal(englishSubtitle('und', '', 'English subtitles'),true);
	assert.equal(englishSubtitle('fra', 'French'),false);
	const {selectVodSubtitle}=await import('../vod-player.mjs');
	const vod=[{index:1,tags:{language:'und',title:'English SDH'}},{index:2,tags:{language:'eng'}}];
	assert.equal(selectVodSubtitle({preferEnglishSubtitles:true},vod,{index:1000000}).index,1);
	assert.equal(selectVodSubtitle({preferEnglishSubtitles:true,subtitleIndex:-1},vod,{index:1000000}),null);
});
