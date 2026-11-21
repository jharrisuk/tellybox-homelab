/* qBittorrent settings live in the installation settings service, but the
 * media process owns the integration. The setup service writes the same
 * `qbittorrent.json` file inside AUTH_DIR that the media process reads on each
 * status and list call, so a saved change applies without a restart.
 *
 * This module never returns the saved password. Connection tests report a
 * sanitized state only and never include the target, account or response body
 * in an error.
 */
import path from 'node:path';
import {
	mergeQbittorrentConfig,
	probeQbittorrent,
	qbittorrentSettings,
	readQbittorrentConfig,
	removeQbittorrentConfig,
	saveQbittorrentConfig
} from '../qbittorrent.mjs';

export function createQbittorrentSettings({ directory, fetcher = fetch, timeoutMs = 8000 } = {}) {
	// materialize() gives the media process `<HOMELAB_DATA>/access` as AUTH_DIR.
	const file = path.join(directory, 'access', 'qbittorrent.json');
	const status = () => qbittorrentSettings(file);
	return {
		file,
		status,
		save(body) {
			return saveQbittorrentConfig(file, body);
		},
		remove() {
			return removeQbittorrentConfig(file);
		},
		async test(body = {}) {
			// Merge unsaved form values over the saved file, but never persist a
			// test. A blank password field keeps the saved password.
			const candidate = mergeQbittorrentConfig(readQbittorrentConfig(file), body);
			return probeQbittorrent(candidate, { fetcher, timeoutMs });
		}
	};
}
