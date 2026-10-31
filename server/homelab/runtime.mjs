import { readFileSync } from 'node:fs';
import path from 'node:path';
import { capabilities, defaultConfig } from './config.mjs';

export function loadCapabilities(directory) {
	try { return { ...capabilities(defaultConfig()), ...JSON.parse(readFileSync(path.join(directory, 'capabilities.json'), 'utf8')) }; }
	catch { return capabilities(defaultConfig()); }
}
export function optionalDispatcharr(client, features) {
	const disabled = async () => { throw Object.assign(Error('This feature is disabled in installation settings.'), { status: 503 }); };
	return { ...client, channels: features.live ? client.channels : async () => [],
		status: features.vod ? client.status : () => ({ connected: false, origin: client.origin }),
		api: features.vod ? client.api : disabled, stream: features.vod ? client.stream : disabled,
		recordingApi: features.recordings ? client.recordingApi : disabled, recordingFile: features.recordings ? client.recordingFile : disabled,
		catchupSession: features.catchup ? client.catchupSession : disabled };
}
