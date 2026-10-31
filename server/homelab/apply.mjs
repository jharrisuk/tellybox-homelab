import { readFileSync } from 'node:fs';
import path from 'node:path';
import { defaultConfig, validateConfig, materialize, atomicJson } from './config.mjs';

/** Save and Apply remain separate across restarts; a failed apply restores the last working settings. */
export function createApplyController({ directory, start, stop, ready, materializeConfig = materialize }) {
	const appliedFile = path.join(directory, 'applied-configuration.json');
	let applied, applying = false, lastFailure = false;
	try { applied = JSON.parse(readFileSync(appliedFile, 'utf8')); }
	catch (error) { if (error.code !== 'ENOENT') throw Error('Applied configuration could not be read; refusing to reset it.'); }
	const checked = config => {
		if (config?.version !== 1 || !Number.isSafeInteger(config.revision) || config.revision < 0) throw Error('Unsupported configuration.');
		return validateConfig(config, { ...config, revision: config.revision - 1 });
	};
	if (applied) applied = checked(applied);
	async function launch(config) {
		const env = materializeConfig(config, directory);
		await ready(await start(env));
	}
	async function apply(candidate) {
		if (applying) throw Object.assign(Error('An apply is already in progress.'), { status: 409 });
		const config = checked(candidate);
		applying = true; lastFailure = false;
		try {
			await stop();
			await launch(config);
			atomicJson(appliedFile, config); applied = config;
		} catch {
			lastFailure = true;
			try { await stop(); await launch(applied || defaultConfig()); }
			catch {
				await stop();
				throw Object.assign(Error('Apply failed and media could not recover. Installation settings remain available.'), { status: 503 });
			}
			throw Object.assign(Error('New settings did not become ready. The previous configuration was restored.'), { status: 503 });
		} finally { applying = false; }
	}
	return { apply, boot: () => apply(applied || defaultConfig()), status: () => ({ applying, appliedRevision: applied?.revision ?? -1, lastApplyFailed: lastFailure }) };
}
