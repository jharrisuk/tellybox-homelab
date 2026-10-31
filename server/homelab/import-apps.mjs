import { constants } from 'node:fs';
import { link, lstat, mkdir, open, rename, rm, rmdir, writeFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const MAX_APK = 128 * 1024 * 1024;
const PACKAGE = 'app.tellybox.homelab';
const fields = ['package', 'flavour', 'versionCode', 'versionName', 'minSdk', 'url', 'bytes', 'sha256', 'notes'];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

async function plainPath(filename) {
	for (let current = path.resolve(filename);; current = path.dirname(current)) {
		try { if ((await lstat(current)).isSymbolicLink()) throw Error('Symbolic links are not accepted.'); }
		catch (error) { if (error.code !== 'ENOENT') throw error; }
		if (current === path.dirname(current)) break;
	}
}

async function boundedFile(filename, limit) {
	await plainPath(filename);
	const handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
	try {
		const stat = await handle.stat();
		if (!stat.isFile() || stat.size < 1 || stat.size > limit) throw Error('Invalid or oversized bundle file.');
		const bytes = Buffer.alloc(stat.size);
		let offset = 0;
		while (offset < bytes.length) {
			const result = await handle.read(bytes, offset, bytes.length - offset, offset);
			if (!result.bytesRead) throw Error('Bundle file changed during import.');
			offset += result.bytesRead;
		}
		if ((await handle.stat()).size !== bytes.length) throw Error('Bundle file changed during import.');
		return bytes;
	} finally { await handle.close(); }
}

function releaseInfo(value, flavour) {
	if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !fields.includes(key))) throw Error('Invalid release fields.');
	if (value.package !== PACKAGE || value.flavour !== flavour) throw Error('Only matching public phone/TV packages are accepted.');
	if (!Number.isSafeInteger(value.versionCode) || value.versionCode < 1 || value.versionCode > 2147483647 ||
		!Number.isSafeInteger(value.minSdk) || value.minSdk < 26 || value.minSdk > 100 ||
		typeof value.versionName !== 'string' || !/^\d+(?:\.\d+){1,3}$/.test(value.versionName) || value.versionName.length > 40 ||
		!Number.isSafeInteger(value.bytes) || value.bytes < 1 || value.bytes > MAX_APK ||
		typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256) ||
		(value.notes !== undefined && (typeof value.notes !== 'string' || value.notes.length > 2000))) throw Error('Invalid release metadata.');
	const filename = `Tellybox-${flavour}-${value.versionName}.apk`;
	const url = new URL(value.url);
	if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash ||
		url.pathname !== `/app-updates/public/${filename}`) throw Error('Invalid public APK URL.');
	return filename;
}

// This checks the trusted release bundle's metadata and bytes. Android still verifies
// the APK's actual package and signing certificate before installing it.
export async function importPublicApps(stage, configuration) {
	const source = path.resolve(stage), root = path.resolve(configuration);
	await plainPath(source); await plainPath(root);
	if (!(await lstat(source)).isDirectory() || !(await lstat(root)).isDirectory()) throw Error('Bundle and configuration directories must exist.');
	const feed = JSON.parse((await boundedFile(path.join(source, 'latest.json'), 16384)).toString('utf8'));
	if (!feed || typeof feed !== 'object' || Array.isArray(feed) || Object.keys(feed).some(key => !['phone', 'tv', 'publishedAt'].includes(key))) throw Error('Invalid bundle manifest.');
	if (feed.publishedAt !== undefined && (typeof feed.publishedAt !== 'string' || feed.publishedAt.length > 40 || !Number.isFinite(Date.parse(feed.publishedAt)))) throw Error('Invalid publication date.');
	const releases = [];
	for (const flavour of ['phone', 'tv']) {
		const entry = feed[flavour], filename = releaseInfo(entry, flavour);
		const bytes = await boundedFile(path.join(source, filename), MAX_APK);
		if (bytes.length !== entry.bytes || hash(bytes) !== entry.sha256) throw Error('APK size or checksum does not match the manifest.');
		releases.push({ filename, bytes, entry });
	}
	if (feed.phone.versionCode !== feed.tv.versionCode || feed.phone.versionName !== feed.tv.versionName) throw Error('Phone and TV must be the same release.');
	const destination = path.join(root, 'media', 'app-updates', 'public');
	await plainPath(destination);
	await mkdir(destination, { recursive: true });
	const lock = path.join(root, '.public-app-import.lock');
	await mkdir(lock);
	const pending = path.join(destination, `.latest-${randomUUID()}.tmp`);
	const staged = [];
	try {
		// Check every existing artifact before adding anything; never replace a version's bytes.
		for (const release of releases) {
			const target = path.join(destination, release.filename);
			try {
				const existing = await boundedFile(target, MAX_APK);
				if (hash(existing) !== release.entry.sha256) throw Error('An APK with this filename already has different bytes. Use a new version.');
				release.exists = true;
			} catch (error) { if (error.code !== 'ENOENT') throw error; }
		}
		await plainPath(path.join(destination, 'latest.json'));
		for (const release of releases) if (!release.exists) {
			const temporary = path.join(destination, `.apk-${randomUUID()}.tmp`);
			staged.push(temporary);
			await writeFile(temporary, release.bytes, { flag: 'wx', mode: 0o644 });
			// A hard link exposes a complete file and refuses to replace an existing name.
			await link(temporary, path.join(destination, release.filename));
		}
		await writeFile(pending, JSON.stringify(feed, null, '\t') + '\n', { flag: 'wx', mode: 0o644 });
		await rename(pending, path.join(destination, 'latest.json'));
		return { version: feed.phone.versionName, versionCode: feed.phone.versionCode, edition: 'public', files: releases.map(release => release.filename) };
	} finally {
		await rm(pending, { force: true });
		for (const temporary of staged) await rm(temporary, { force: true });
		await rmdir(lock);
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
	try {
		if (process.argv.length !== 3) throw Error('Usage: node homelab/import-apps.mjs /config/app-update-stage');
		console.log(JSON.stringify(await importPublicApps(process.argv[2], process.env.HOMELAB_DATA || '/config')));
	} catch (error) { console.error('Public app import failed: ' + error.message); process.exitCode = 1; }
}
