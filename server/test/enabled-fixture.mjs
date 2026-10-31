import { writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
export function enableIntegrations() {
	const directory = path.resolve(process.env.DATA_DIR || '');
	if (process.env.NODE_ENV !== 'test' || !directory.startsWith(path.resolve(os.tmpdir()) + path.sep)) throw Error('Only enable fixture integrations inside a temporary test directory.');
	writeFileSync(path.join(directory, 'capabilities.json'), JSON.stringify({jellyfin:true,library:true,live:true,nonstop:true,vod:true,recordings:true,catchup:true,discover:true,comingSoon:true,introdb:true,subtitles:true}));
}
