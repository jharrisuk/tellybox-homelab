/* Synthetic loopback fixture for the ARTWORK-128 route and browser checks.
 *
 * No provider, credential or production access is used. The catalogue and
 * metadata are deterministic; only the TMDB image host is intercepted so the
 * real server routes can be exercised without external network access.
 */
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { vodView } from '../vod-library.mjs';

// A small visible 2:3 gradient so screenshots show a loaded poster rather than
// a transparent 1x1 pixel. It is synthetic evidence art, not a real provider image.
export const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAADwAAABaCAYAAADkUTU1AAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAHySURBVHhe5cOJTw0AAMfx3x9jTPJSUkpe9+t8HU+vlA5dr+t1X4sW0UKOVotWa5EjRKIZM8bMjBnjP/r5Q76f7aMDmQkm1cGsIybVoWCiSXU4+6hJlZAbMKkS8wMmVaAwyaRKCh0zqZKLk02qlJIUkyq17LhJlRZONanSK06YVBlVaSZVZiTNpMqqSTepgtGTJlV2XYZJlVufaVLlNZwyqQoas0yqUPNpk6qoJWhSlbQGTarS9myTqrwjx6SqiOWYVJXduSZVdW+eSRXpyzepavoLTKrawUKTqm6o0KSqHwmZVA2jRSZV43ixSdU8WWJStUyVmlStF8tMqrbpcpOqYyZsUsUuh02qrtkKk6rnaqVJ1TtXZVLF56tNqoHrEZNqcOGMSTV8s8akGrkdNanGFqMm1cRSrUk1uVxnUk2tnDWpLtytN6mmVxtMqpm1cybVpfVGk2p2o8mkurLZZFLNPWg2qea3Wkyqa4/Om1Q3nrSaVAvbbSbVrWftJtWdnQ6TavFFp0m1tNtpUi3vxUyqldddJtW9/S6TavVtt0m19q7HpFp/32tSbXzoM6k2P8ZNqvuf4ibV1ud+k+rhlwGT6vHXQZNq+9uQSfX0+7BJ9fzHiEm183PUpHr5a8ykevV7zKTa+zNuUr35O2FS7f+bNOl/7Ul9rpLjPJQAAAAASUVORK5CYII=', 'base64');

export const IDS = Object.freeze({
	badPoster: 69227,
	providerPoster: 70001,
	noPoster: 70002,
	extraOne: 70003,
	extraTwo: 70004,
	extraThree: 70005,
	staleLogo: 70006,
});

const DEFAULT_MOVIES = [
	{ id: IDS.badPoster, name: 'Gentle Monster', tmdb_id: 1473148, year: 2026, genre: 'Drama', created_at: '2026-11-18T10:00:00Z' },
	{ id: IDS.noPoster, name: 'No Poster Film', tmdb_id: 800001, year: 2026, genre: 'Comedy', created_at: '2026-11-18T09:00:00Z' },
	{ id: IDS.providerPoster, name: 'Provider Art Film', tmdb_id: 700001, year: 2026, genre: 'Action', created_at: '2026-11-18T08:00:00Z', logo: { id: 9001 } },
	{ id: IDS.extraOne, name: 'Library Film One', tmdb_id: 700002, year: 2026, genre: 'Thriller', created_at: '2026-11-18T07:00:00Z' },
	{ id: IDS.extraTwo, name: 'Library Film Two', tmdb_id: 700003, year: 2026, genre: 'Family', created_at: '2026-11-18T06:00:00Z' },
	{ id: IDS.extraThree, name: 'Library Film Three', tmdb_id: 700004, year: 2026, genre: 'History', created_at: '2026-11-18T05:00:00Z' },
	// The provider catalogue still advertises a logo id, but the provider image
	// itself is gone. TMDB has a poster, so the card must not stay a placeholder.
	{ id: IDS.staleLogo, name: 'Stale Logo Film', tmdb_id: 700005, year: 2026, genre: 'Drama', created_at: '2026-11-18T04:00:00Z', logo: { id: 9002 } },
];

function rawMovie(row) {
	return {
		...row,
		description: 'A synthetic artwork fixture title.',
		duration_secs: 6000,
		air_date: '2026-01-01',
		providers: [],
	};
}

export function metadataFor(row) {
	return {
		id: row.tmdb_id,
		title: row.name,
		overview: 'Synthetic TMDB metadata for the artwork fixture.',
		posterPath: row.tmdb_id === 800001 ? null : '/poster-' + row.tmdb_id + '.jpg',
		releaseDate: '2026-01-01',
		voteAverage: 7,
		voteCount: 100,
		genres: [{ name: row.genre }],
	};
}

export async function startArtworkFixture(t, {
	movies = DEFAULT_MOVIES, metadataMode = 'ok', directory: providedDirectory = '',
	seerrPort = 0, keepDirectory = false, artworkBytes = null, artworkType = 'image/png',
} = {}) {
	const rows = movies.map(rawMovie);
	const imageBytes = Buffer.isBuffer(artworkBytes) ? artworkBytes : png;
	const imageType = typeof artworkType === 'string' && /^image\//i.test(artworkType) ? artworkType : 'image/png';
	const directory = providedDirectory || mkdtempSync(path.join(tmpdir(), 'tellybox-artwork-128-'));
	const servers = [];
	const listen = (handler, port = 0) => new Promise(resolve => {
		const server = createServer(handler);
		server.listen(port, '127.0.0.1', () => { servers.push(server); resolve(server); });
	});
	const calls = {
		seerr: 0, seerrIds: [], provider: 0, providerLogos: 0, discover: 0,
		mode: metadataMode, delayMs: 0, discoverDelayMs: 0, discoverMode: 'ok',
		discoverDelays: new Map(),
		setMode(mode, delayMs = 0) { calls.mode = mode; calls.delayMs = Math.max(0, Number(delayMs) || 0); },
		setDiscoverMode(mode, delayMs = 0) { calls.discoverMode = mode; calls.discoverDelayMs = Math.max(0, Number(delayMs) || 0); },
		setDiscoverDelay(id, delayMs = 0) { calls.discoverDelays.set(Number(id), Math.max(0, Number(delayMs) || 0)); }
	};
	const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

	const dispatcharr = await listen((request, response) => {
		const url = new URL(request.url, 'http://127.0.0.1');
		if (url.pathname.startsWith('/api/vod/vodlogos/') && url.pathname.endsWith('/cache/')) {
			calls.providerLogos += 1;
			if (url.pathname.includes('/9002/')) { response.statusCode = 404; return response.end('{}'); }
			response.writeHead(200, { 'Content-Type': imageType, 'Content-Length': String(imageBytes.length) });
			return response.end(imageBytes);
		}
		response.setHeader('Content-Type', 'application/json');
		if (url.pathname === '/api/vod/movies/' || url.pathname === '/api/vod/movies') {
			return response.end(JSON.stringify({ results: rows, next: null }));
		}
		if (url.pathname === '/api/vod/series/' || url.pathname === '/api/vod/series') {
			return response.end(JSON.stringify({ results: [], next: null }));
		}
		const detail = /^\/api\/vod\/movies\/(\d+)\/$/.exec(url.pathname);
		if (detail) {
			calls.provider += 1;
			const row = rows.find(entry => Number(entry.id) === Number(detail[1]));
			if (!row) { response.statusCode = 404; return response.end('{}'); }
			return response.end(JSON.stringify(row));
		}
		return response.end(JSON.stringify({ results: [], next: null }));
	});

	const seerr = await listen(async (request, response) => {
		const url = new URL(request.url, 'http://127.0.0.1');
		// Discover landing/provider fixture. The real server composes current
		// availability and stores only the sanitized public catalogue snapshot.
		if (url.pathname === '/api/v1/discover/trending' || /^\/api\/v1\/discover\/(movies|tv)$/.test(url.pathname) || url.pathname === '/api/v1/search') {
			calls.discover += 1;
			if (calls.discoverMode === 'down') { response.statusCode = 503; return response.end('{}'); }
			const requestedProvider = Number(url.searchParams.get('watchProviders') || 0);
			const delay = calls.discoverDelays.get(requestedProvider) ?? calls.discoverDelayMs;
			if (delay) await sleep(delay);
			const type = url.pathname.endsWith('/tv') ? 'tv' : 'movie';
			const provider = requestedProvider;
			const base = 920000 + (type === 'tv' ? 500 : 0) + (provider ? provider * 10 : 0);
			const results = Array.from({ length: 20 }, (_, index) => ({
				id: base + index, mediaType: type, title: 'Discover ' + (provider ? 'provider ' + provider : 'fixture') + ' ' + (index + 1),
				overview: 'Synthetic Discover fixture metadata.', posterPath: '/discover-' + (base + index) + '.jpg',
				releaseDate: '2026-01-01', voteAverage: 7, voteCount: 100, genreIds: [18],
				mediaInfo: { status: 5, jellyfinMediaId: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' }
			}));
			response.setHeader('Content-Type', 'application/json');
			return response.end(JSON.stringify({ page: 1, totalPages: 3, results }));
		}
		const match = /^\/api\/v1\/(movie|tv)\/(\d+)$/.exec(url.pathname);
		if (!match) { response.statusCode = 404; return response.end('{}'); }
		const id = Number(match[2]);
		calls.seerr += 1;
		calls.seerrIds.push(id);
		if (calls.mode === 'down') { response.statusCode = 503; return response.end('{}'); }
		if (calls.delayMs) await sleep(calls.delayMs);
		const row = rows.find(entry => Number(entry.tmdb_id) === id);
		if (!row) { response.statusCode = 404; return response.end('{}'); }
		response.setHeader('Content-Type', 'application/json');
		return response.end(JSON.stringify(metadataFor(row)));
	}, seerrPort);

	const jellyfin = await listen((request, response) => {
		response.setHeader('Content-Type', 'application/json');
		response.end(JSON.stringify({ Items: [], TotalRecordCount: 0 }));
	});

	const local = await listen();
	Object.assign(process.env, {
		NODE_ENV: 'test', AUTH_DIR: directory, DATA_DIR: directory, CATALOGUE_CACHE_DIR: directory,
		JELLYFIN_URL: 'http://127.0.0.1:' + jellyfin.address().port,
		DISPATCHARR_URL: 'http://127.0.0.1:' + dispatcharr.address().port,
		PORT: String(local.address().port), LOCAL_HOSTS: '127.0.0.1', LOCAL_NETWORKS: '127.0.0.0/8',
		PUBLIC_ORIGIN: 'https://remote.test'
	});
	writeFileSync(path.join(directory, 'connection.json'), JSON.stringify({ userId: 'fixture', token: 'fixture-only' }));
	writeFileSync(path.join(directory, 'apps.json'), JSON.stringify({}));
	writeFileSync(path.join(directory, 'account-limits.json'), JSON.stringify({ accounts: {} }));
	writeFileSync(path.join(directory, 'dispatcharr.json'), JSON.stringify({ key: 'fixture-only' }));
	writeFileSync(path.join(directory, 'seerr.json'), JSON.stringify({ url: 'http://127.0.0.1:' + seerr.address().port, key: 'fixture-key' }));
	writeFileSync(path.join(directory, 'capabilities.json'), JSON.stringify({
		jellyfin: false, library: true, live: false, nonstop: false, vod: true, recordings: false,
		catchup: false, discover: true, comingSoon: false, introdb: false, subtitles: false,
		managedInstallation: true, canShare: true, canDownload: false
	}));
	const catalogue = rows.map(row => vodView(row, 'Movie')).filter(Boolean);
	writeFileSync(path.join(directory, 'vod-catalogue.json'), JSON.stringify({ time: Date.now(), items: catalogue }));
	writeFileSync(path.join(directory, 'series-links.json'), JSON.stringify({}));

	const originalFetch = globalThis.fetch;
	globalThis.fetch = async (input, init) => {
		if (String(input).startsWith('https://image.tmdb.org/')) {
			return new Response(imageBytes, { headers: { 'content-type': imageType, 'content-length': String(imageBytes.length) } });
		}
		return originalFetch(input, init);
	};
	const { app } = await import('../server.mjs');
	local.on('request', app);
	const base = 'http://127.0.0.1:' + local.address().port;
	t.after(() => {
		globalThis.fetch = originalFetch;
		for (const server of servers) { server.closeAllConnections(); server.close(); }
		if (!keepDirectory) {
			try { rmSync(directory, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 }); } catch {}
		}
	});
	return { base, directory, rows, calls, catalogue };
}
