import { readFileSync } from 'node:fs';

// The server package is the release source of truth, independent of APK versions.
const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
if (!/^\d+\.\d+\.\d+(?:-[\da-z.-]+)?$/i.test(version)) throw Error('Invalid server release version.');
export const serverRelease = Object.freeze({ product: 'Tellybox', version });

export function installReleaseVersion(app) {
	app.get('/api/version', (req, res) => res.set('Cache-Control', 'no-store').json(serverRelease));
}
