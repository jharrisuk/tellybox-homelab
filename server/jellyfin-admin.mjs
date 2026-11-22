// Local-admin media purge.
//
// Destructive by design and deliberately narrow:
//   * only Jellyfin items with a real local path (never a provider/stream URL);
//   * only a request from the local network by an installation administrator;
//   * a preview first, then the caller must repeat the exact title;
//   * deletion goes through Jellyfin's admin API with DeleteFileContents, so the
//     file leaves the disk exactly as it would from the Jellyfin dashboard.
//
// The admin API key comes from the installation configuration, not the viewer
// token Tellybox uses for browsing. If it is absent or invalid, the feature
// fails closed.
import { readFileSync } from 'node:fs';

const JELLYFIN_ID = /^[a-f0-9]{32}$/i;
const LOCAL_PATH = /^(?:\/|[A-Za-z]:[\\/])/;
const MAX_COUNT = 5000;

function fail(message, status = 400) {
	return Object.assign(Error(message), { status });
}

export function createJellyfinAdmin({ configPath = '', fetcher = fetch, clock = Date.now } = {}) {
	let cached = null;
	function credentials() {
		if (!configPath) throw fail('Jellyfin administration is not configured on this installation.', 503);
		if (cached && cached.until > clock()) return cached.value;
		let value = null;
		try {
			const text = JSON.parse(readFileSync(configPath, 'utf8'));
			const jellyfin = text?.jellyfin || text?.services?.jellyfin || null;
			if (jellyfin?.enabled !== false && jellyfin?.url && jellyfin?.key) value = { url: String(jellyfin.url).replace(/\/$/, ''), key: String(jellyfin.key) };
		} catch { value = null; }
		cached = { value, until: clock() + 30000 };
		if (!value) throw fail('A Jellyfin administrator API key is required before media can be deleted.', 503);
		return value;
	}
	async function request(path, options = {}) {
		const { url, key } = credentials();
		const response = await fetcher(url + path, {
			...options,
			redirect: 'error',
			signal: AbortSignal.timeout(20000),
			headers: { 'X-Emby-Token': key, Accept: 'application/json', ...(options.headers || {}) }
		});
		if (!response.ok) {
			await response.body?.cancel();
			throw fail(response.status === 401 || response.status === 403
				? 'The Jellyfin administrator key was refused. Check it in installation settings.'
				: 'Jellyfin could not complete that request.', response.status === 401 || response.status === 403 ? 502 : 502);
		}
		return response;
	}
	async function item(id) {
		if (!JELLYFIN_ID.test(String(id || ''))) throw fail('Choose a local Jellyfin title.', 400);
		// Jellyfin rejects /Items/<id> for an API key on some versions; the Ids query
		// returns the same item and is accepted.
		const response = await request('/Items?Ids=' + encodeURIComponent(id) + '&Fields=Path,ChildCount');
		const data = await response.json();
		const found = (data.Items || [])[0];
		if (!found) throw fail('That title was not found in Jellyfin.', 404);
		return found;
	}
	function localPath(value) {
		const path = String(value?.Path || value?.MediaSources?.[0]?.Path || '');
		return LOCAL_PATH.test(path) ? path : '';
	}
	async function episodes(seriesId, season) {
		const query = new URLSearchParams({ Fields: 'Path', Limit: String(MAX_COUNT) });
		if (Number.isInteger(season)) query.set('season', String(season));
		const response = await request('/Shows/' + encodeURIComponent(seriesId) + '/Episodes?' + query);
		return (await response.json()).Items || [];
	}
	async function preview(id) {
		const found = await item(id);
		const type = String(found.Type || '');
		if (!['Movie', 'Episode', 'Season', 'Series'].includes(type)) throw fail('Only films, episodes, seasons and series can be deleted here.', 400);
		let children = [];
		if (type === 'Season') children = await episodes(found.SeriesId, Number(found.IndexNumber));
		else if (type === 'Series') children = await episodes(found.Id);
		const targets = type === 'Season' || type === 'Series' ? children : [found];
		if (!targets.length) throw fail('Nothing deletable was found for that title.', 409);
		// Unaired or virtual children legitimately have no path. Any path that is
		// present must be local; a stream or a remote URL is never deleted here.
		const present = targets.filter(entry => String(entry?.Path || entry?.MediaSources?.[0]?.Path || ''));
		const paths = present.map(localPath).filter(Boolean);
		if (paths.length !== present.length) throw fail('That title includes a non-local source, so it will not be deleted here.', 409);
		if (!paths.length) throw fail('No local files were found for that title.', 409);
		return {
			id: found.Id,
			name: String(found.Name || ''),
			type,
			seriesId: found.SeriesId || '',
			season: Number.isInteger(Number(found.IndexNumber)) ? Number(found.IndexNumber) : null,
			count: present.length,
			bytes: present.reduce((total, entry) => total + (Number(entry?.MediaSources?.[0]?.Size) || 0), 0),
			episodeIds: present.map(entry => entry.Id).filter(Boolean).slice(0, MAX_COUNT)
		};
	}
	async function remove(id) {
		const data = await preview(id);
		// DELETE is sent with the file-content flag; Jellyfin cascades a series or
		// season itself. The preview already proved every target is a local path.
		await request('/Items/' + encodeURIComponent(data.id) + '?DeleteFileContents=true', { method: 'DELETE' });
		return data;
	}
	return { preview, remove, configured: () => { try { return Boolean(credentials()); } catch { return false; } } };
}
