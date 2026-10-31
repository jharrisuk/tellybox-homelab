import path from 'node:path';
import { jsonStore } from './json-store.mjs';

export function cleanSegments(items, duration) {
	return items.filter(s => ['Intro', 'Recap', 'Outro'].includes(s.type) && Number.isFinite(s.start) && Number.isFinite(s.end)
		&& s.start >= 0 && s.end > s.start + 2 && s.end <= duration && s.end - s.start <= (s.type === 'Intro' ? 300 : 900))
		.sort((a, b) => a.start - b.start).slice(0, 12);
}

export function createMediaSegments({ directory, item, jelly, fetcher = fetch, clock = Date.now }) {
	const cache = jsonStore(path.join(directory, 'media-segments.json'), {}), pending = new Map();
	let cooldown = 0;
	async function load(id) {
		const media = await item(id);
		const duration = Number(media.RunTimeTicks) / 1e7;
		if (media.Type !== 'Episode' || !(duration > 0)) return { segments: [], source: 'none' };
		const key = [id, duration, media.ProviderIds?.Imdb || '', media.ParentIndexNumber, media.IndexNumber].join(':');
		const saved = cache.get()[key]; if (saved?.until > clock()) return saved.value;
		let segments = [], source = 'none';
		if (!id.startsWith('dispatch-')) {
			try {
				const data = await jelly('/MediaSegments/' + encodeURIComponent(id));
				segments = cleanSegments((data.Items || []).map(s => ({ type: s.Type, start: s.StartTicks / 1e7, end: s.EndTicks / 1e7, exact: true })), duration);
				if (segments.length) source = 'Jellyfin';
			} catch { /* An absent plugin or older server must not block playback. */ }
		}
		let transient = false;
		if (process.env.INTRODB_ENABLED !== '0' && !segments.some(s => s.type === 'Intro') && cooldown <= clock() && media.SeriesId) {
			try {
				const series = await item(media.SeriesId), imdb = series.ProviderIds?.Imdb;
				if (/^tt\d{5,12}$/.test(imdb || '') && Number.isInteger(media.ParentIndexNumber) && Number.isInteger(media.IndexNumber)) {
					const url = new URL('https://api.introdb.app/segments');
					url.search = new URLSearchParams({ imdb_id: imdb, season: media.ParentIndexNumber, episode: media.IndexNumber });
					const response = await fetcher(url, { redirect: 'error', signal: AbortSignal.timeout(5000) });
					if (response.status === 429) { cooldown = clock() + 300000; transient = true; }
					else if (response.ok) {
						const text = await response.text(); if (text.length > 64000) throw Error('Oversized response');
						const data = JSON.parse(text);
						if (data.imdb_id === imdb && Number(data.season) === media.ParentIndexNumber && Number(data.episode) === media.IndexNumber) {
							const fallback = cleanSegments(['intro', 'recap', 'outro'].flatMap(type => {
								const s = data[type];
								return s && Number(s.confidence) >= .8 && Number(s.submission_count) >= 2 ? [{ type: type[0].toUpperCase() + type.slice(1), start: Number(s.start_sec ?? s.start_ms / 1000), end: Number(s.end_sec ?? s.end_ms / 1000), exact: false }] : [];
							}), duration).filter(s => !segments.some(existing => existing.type === s.type));
							if (fallback.length) { source = segments.length ? 'Jellyfin + IntroDB' : 'IntroDB'; segments = cleanSegments([...segments, ...fallback], duration); }
						}
					} else transient = response.status !== 404;
				}
			} catch { transient = true; }
		}
		const value = { segments, source };
		cache.get()[key] = { until: clock() + (transient ? 300000 : segments.length ? 7 * 86400000 : 86400000), value };
		const keys = Object.keys(cache.get()); for (const k of keys.slice(0, Math.max(0, keys.length - 3000))) delete cache.get()[k];
		cache.save(); return value;
	}
	return { get(id) { if (!pending.has(id)) pending.set(id, load(id).finally(() => pending.delete(id))); return pending.get(id); } };
}
