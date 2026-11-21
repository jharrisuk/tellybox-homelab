/* Release 133 profile: nonempty 45k catalogue availability projection.
 *
 * Synthetic in-memory/file fixture. It measures what the existing code does,
 * plus the equivalent per-request provider-index rebuild that the pre-133 path
 * performed. No provider or production request is made.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createVodLibrary } from '../vod-library.mjs';

const COUNT = 45000;
const directory = mkdtempSync(path.join(tmpdir(), 'tellybox-catalogue-133-'));
const file = path.join(directory, 'catalogue.json');
const now = () => 1_800_000_000_000;
const items = Array.from({ length: COUNT }, (_, index) => ({
	Id: 'vod-' + index,
	Name: 'Title ' + index,
	Type: index % 4 === 0 ? 'Series' : 'Movie',
	Source: 'streamed',
	Provider: 'Dispatcharr',
	ProviderIds: index % 9 === 0 ? { Imdb: 'tt' + String(10_000_000 + index) } : { Tmdb: String(100_000 + index) },
	Genres: ['Drama'],
	PremiereDate: '2020-01-01',
	CommunityRating: 7
}));
writeFileSync(file, JSON.stringify({ items, time: Number(now()) }));
writeFileSync(path.join(directory, 'links.json'), JSON.stringify({}));

const dispatcharr = {
	status: () => ({ connected: true }),
	api: async () => { throw Error('the profile must not call upstream'); }
};
const clock = now;
const library = createVodLibrary({
	dispatcharr,
	localItems: async () => [],
	localItem: async () => null,
	localEpisodes: async () => [],
	file,
	linksFile: path.join(directory, 'links.json'),
	metadata: null,
	clock,
	indexFile: path.join(directory, 'index.json')
});

const time = async fn => {
	const started = performance.now();
	const value = await fn();
	return { value, ms: performance.now() - started };
};
const median = values => {
	const sorted = [...values].sort((a, b) => a - b);
	return Number(sorted[Math.floor(sorted.length / 2)].toFixed(2));
};
const respond = items.slice(0, 60).map(item => ({ id: Number(item.ProviderIds.Tmdb || 1), type: item.Type === 'Series' ? 'tv' : 'movie' }));

await library.all();
await library.all();
const allTimes = [];
for (let index = 0; index < 3; index++) allTimes.push((await time(() => library.all())).ms);

const first = await time(() => library.availability(respond));
const warmTimes = [];
for (let index = 0; index < 5; index++) warmTimes.push((await time(() => library.availability(respond))).ms);

// Equivalent pre-133 work: rebuild the provider ID map on every response.
const legacyTimes = [];
for (let index = 0; index < 5; index++) {
	const started = performance.now();
	const map = new Map();
	for (const item of items) {
		const type = item.Type;
		const tmdb = item.ProviderIds?.Tmdb;
		const imdb = item.ProviderIds?.Imdb;
		if (tmdb && !map.has(type + ':tmdb:' + tmdb)) map.set(type + ':tmdb:' + tmdb, item);
		if (/^tt\d+$/.test(imdb || '') && !map.has(type + ':imdb:' + imdb)) map.set(type + ':imdb:' + imdb, item);
	}
	legacyTimes.push(performance.now() - started);
}

console.log(JSON.stringify({
	catalogueItems: COUNT,
	responseItems: respond.length,
	allMergeMs: median(allTimes),
	availabilityFirstMs: Number(first.ms.toFixed(2)),
	availabilityWarmMs: median(warmTimes),
	legacyIndexRebuildMs: median(legacyTimes),
	note: 'Synthetic fixture; allMerge includes local/metadata merge, availability is the Discover projection. Times are local CPU, not production latency.'
}, null, 2));
rmSync(directory, { recursive: true, force: true });
