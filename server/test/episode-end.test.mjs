import test from 'node:test';
import assert from 'node:assert/strict';
import {createEpisodeNext} from '../episode-next.mjs';

test('end screen names the series and explains recommendations without unrelated films or genres',async()=>{
	const episode={Id:'episode',Type:'Episode',SeriesId:'series',ParentIndexNumber:1,IndexNumber:8};
	const series={Id:'series',Type:'Series',Name:'Example series',Genres:['Crime'],ProviderIds:{Tmdb:'100'}};
	const library={item:async id=>id==='episode'?episode:series,episodes:async()=>({items:[episode]}),list:async query=>{
		assert.equal(query.genre,'Crime');return {items:[series,{Id:'match',Type:'Series',Name:'Another crime show',Genres:['Crime']},{Id:'other',Type:'Series',Genres:['Comedy']},{Id:'film',Type:'Movie',Genres:['Crime']}]};
	}};
	const result=await createEpisodeNext({library,metadata:async()=>({status:'Returning Series',last_episode_to_air:{season_number:1,episode_number:8}})})('episode');
	assert.equal(result.status,'caught-up');assert.equal(result.seriesName,'Example series');assert.equal(result.suggestionGenre,'Crime');assert.deepEqual(result.suggestions.map(i=>i.Id),['match']);
});
