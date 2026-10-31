import test from 'node:test';
import assert from 'node:assert/strict';
import { canRequestLocal, localRequestUrl } from '../public/local-request.mjs';

test('local-copy links support streamed movies and mixed series without offering local films or live channels', () => {
	assert.equal(canRequestLocal({Type:'Movie',Source:'streamed'}), true);
	assert.equal(canRequestLocal({Type:'Series',Source:'local',VodIds:[1]}), true);
	assert.equal(canRequestLocal({Type:'Movie',Source:'local',VodIds:[1]}), false);
	assert.equal(canRequestLocal({Type:'TvChannel',Source:'streamed'}), false);
	assert.equal(localRequestUrl({Type:'Movie',ProviderIds:{Tmdb:'42'}}), '/discover?type=movie&title=42');
});

test('episode requests use the series identity and missing metadata opens an encoded search', () => {
	const episode={Type:'Episode',SeriesName:'A show & friends',ProviderIds:{Tmdb:999}};
	assert.equal(localRequestUrl(episode,{Type:'Series',ProviderIds:{Tmdb:77}}), '/discover?type=tv&title=77');
	assert.equal(localRequestUrl(episode), '/discover?type=tv&q=A+show+%26+friends');
	assert.equal(localRequestUrl({Type:'Movie',Name:'A film',ProviderIds:{Tmdb:'99999999999'}}), '/discover?type=movie&q=A+film');
});
