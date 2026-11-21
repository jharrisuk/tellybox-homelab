import {
	access, lstat, mkdir, open, readFile, readdir, readlink, realpath, stat, statfs, unlink
} from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const ALLOWED_EXPORT_FS = new Set(['vfat', 'fat', 'fat32', 'exfat', 'ntfs', 'ntfs3', 'ext2', 'ext3', 'ext4', 'btrfs', 'xfs', 'f2fs']);
const FALLBACK_FREE_RESERVE = 64 * 1024 * 1024;
const FAT32_MAX = 0xffffffff - 1;
const COPY_CHUNK_BYTES = 256 * 1024;
// Flush dirty USB pages regularly. Without this a multi-GB copy can fill the
// container's memory cgroup with writeback cache long before the final sync.
const FLUSH_BYTES = 8 * 1024 * 1024;
const SUBTITLE = /\.(srt|vtt|ass|ssa|sub|idx)$/i;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

export function decodeMountField(value) {
	return String(value || '').replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)));
}

export function protectedMount(mountPoint, roots = [], allowedRoot = '') {
	const point = String(mountPoint || '').replace(/\/+$/, '') || '/';
	const allowed = String(allowedRoot || '').replace(/\/+$/, '') || '/';
	const protectedRoots = ['/', '/boot', '/boot/efi', '/home', '/var', ...roots]
		.map(root => String(root || '').replace(/\/+$/, '') || '/');
	const allowedSafe = Boolean(allowedRoot)
		&& !['/', '/boot', '/boot/efi', '/home', '/var'].includes(allowed)
		&& !protectedRoots.some(root => root === allowed || root.startsWith(allowed + '/'));
	if (allowedSafe && (point === allowed || point.startsWith(allowed + '/'))) return false;
	for (const root of protectedRoots) {
		const base = String(root || '').replace(/\/+$/, '') || '/';
		if (base === '/') {
			if (point === '/') return true;
			continue;
		}
		if (point === base || point.startsWith(base + '/') || base.startsWith(point + '/')) return true;
	}
	return false;
}

export function parseMountInfo(text, usbRoot) {
	const root = path.resolve(usbRoot || '');
	const mounts = [];
	for (const line of String(text || '').split(/\r?\n/)) {
		const fields = line.trim().split(' ');
		if (fields.length < 7) continue;
		const separator = fields.findIndex((field, index) => index >= 6 && field === '-');
		if (separator < 0 || !fields[separator + 1]) continue;
		const mountPoint = decodeMountField(fields[4]);
		const resolved = path.resolve(mountPoint);
		const relative = path.relative(root, resolved);
		if (relative.startsWith('..') || path.isAbsolute(relative)) continue;
		mounts.push({
			major: fields[2].split(':')[0], minor: fields[2].split(':')[1],
			mountPoint: resolved, fsType: fields[separator + 1],
			source: decodeMountField(fields[separator + 2] || '')
		});
	}
	return mounts.sort((a, b) => a.mountPoint.length - b.mountPoint.length);
}

export function safeName(value, max = 120) {
	let name = String(value || '').normalize('NFKC')
		.replace(/[\\/:*?"<>|\x00-\x1f\x7f]/g, ' ')
		.replace(/\s+/g, ' ').trim().replace(/[. ]+$/g, '');
	if (!name) name = 'Untitled';
	if (WINDOWS_RESERVED.test(name)) name = '_' + name;
	if (name.length > max) name = name.slice(0, max).trim().replace(/[. ]+$/g, '');
	return name || 'Untitled';
}

export function within(root, target) {
	const relative = path.relative(path.resolve(root), path.resolve(target));
	return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export function uniqueName(name, used) {
	const directory = path.dirname(name), extension = path.extname(name), base = path.basename(name, extension);
	let candidate = name, index = 2;
	while (used.has(candidate.toLowerCase())) {
		candidate = path.join(directory, safeName(`${base} (${index})`) + extension);
		index++;
	}
	used.add(candidate.toLowerCase());
	return candidate;
}

export function fat32Limit(fsType) {
	return /^(vfat|fat|fat32|msdos)$/i.test(fsType || '') ? FAT32_MAX : Infinity;
}

function friendly(message) {
	return Object.assign(new Error(message), { status: 400 });
}

function errorMessage(error) {
	if (error?.status === 400) return error.message;
	const code = error?.code || '';
	if (['ENOENT', 'ENODEV', 'EIO', 'ENOTCONN'].includes(code)) return 'The USB drive was removed or changed. Reinsert it and review the export again.';
	if (code === 'ENOSPC') return 'The USB drive does not have enough free space.';
	if (code === 'EACCES' || code === 'EPERM') return 'The USB drive is not writable.';
	if (code === 'EEXIST') return 'A destination file already exists. Review the export again.';
	return 'The export could not finish. The USB drive and source files are unchanged.';
}

async function sidecarPaths(entry, roots, readdirImpl = readdir) {
	const values = new Set(Array.isArray(entry.sidecars) ? entry.sidecars : []);
	const directory = path.dirname(entry.path), base = path.basename(entry.path, path.extname(entry.path));
	try {
		for (const name of await readdirImpl(directory)) {
			if (name.startsWith(base + '.') && SUBTITLE.test(name)) values.add(path.join(directory, name));
		}
	} catch { /* Adjacent sidecars are optional. */ }
	const result = [];
	for (const value of values) {
		if (typeof value !== 'string' || !withinAny(roots, value)) continue;
		try {
			const info = await lstat(value);
			if (info.isFile() && !info.isSymbolicLink()) result.push(value);
		} catch {}
	}
	return [...new Set(result)];
}

function withinAny(roots, target) {
	return roots.some(root => within(root, target));
}

export function createUsbExport({
	directory, mediaRoots = [], usbRoot = '', clock = Date.now, sysRoot = '/sys', protectedRoots = ['/', '/boot', '/home', '/var'],
	volumeProvider, readFileImpl = readFile, readlinkImpl = readlink, statImpl = stat, statfsImpl = statfs,
	accessImpl = access, lstatImpl = lstat, realpathImpl = realpath,
	readdirImpl, unlinkImpl = unlink, mkdirImpl = mkdir,
	openImpl = open, createReadStreamImpl = null,
	mountImpl = null, ejectImpl = null
} = {}) {
	const roots = mediaRoots.map(root => path.resolve(root));
	const jobs = new Map(), plans = new Map(), volumeIds = new Map();
	const enabled = Boolean(usbRoot && roots.length);
	let queue = Promise.resolve();

	function requireEnabled() {
		if (!enabled) throw Object.assign(new Error('USB export is not configured on this server.'), { status: 404 });
	}

	async function removable(major, minor) {
		try {
			const resolved = await realpathImpl(path.join(sysRoot, 'dev', 'block', `${major}:${minor}`));
			const pathParts = resolved.split(path.sep);
			const usb = pathParts.some(part => /^usb\d*$/i.test(part)) || pathParts.includes('usb');
			let current = resolved, text = '';
			for (let depth = 0; depth < 4; depth++) {
				try { text = (await readFileImpl(path.join(current, 'removable'), 'utf8')).trim(); break; }
				catch { current = path.dirname(current); }
			}
			if (!text) return { removable: false, usb };
			return { removable: text === '1', usb };
		} catch { return { removable: false, usb: false }; }
	}

	async function volumes() {
		requireEnabled();
		const mounts = volumeProvider ? await volumeProvider() : parseMountInfo(await readFileImpl('/proc/self/mountinfo', 'utf8'), usbRoot);
		const result = [];
		for (const mount of mounts) {
			const block = mount.removable === undefined || mount.usb === undefined ? await removable(mount.major, mount.minor) : {};
			const isRemovable = mount.removable === undefined ? block.removable : Boolean(mount.removable);
			const usb = mount.usb === undefined ? block.usb : Boolean(mount.usb);
			let writable = false;
			try { await accessImpl(mount.mountPoint, 2); writable = true; } catch {}
			let info = null;
			try { info = await statfsImpl(mount.mountPoint); } catch {}
			const blockSize = Number(info?.bsize) || 0, blocks = Number(info?.blocks) || 0, available = Number(info?.bavail) || 0;
			const totalBytes = blockSize * blocks, freeBytes = blockSize * available;
			const mounted = Boolean(mount.mountPoint);
			const protectedMountPoint = protectedMount(mount.mountPoint, protectedRoots, path.isAbsolute(usbRoot || '') ? usbRoot : '');
			let mountStat = null;
			try { if (mounted) mountStat = await statImpl(mount.mountPoint); } catch {}
			const key = `${mount.major}:${mount.minor}|${mount.fsType}|${mount.uuid || mount.source || ''}`;
			if (!volumeIds.has(key)) volumeIds.set(key, randomUUID());
			const id = volumeIds.get(key);
			if (volumeIds.size > 128) volumeIds.delete(volumeIds.keys().next().value);
			const identity = mount.identity || `${key}|${mountStat?.dev || ''}`;
			const supported = ALLOWED_EXPORT_FS.has(String(mount.fsType || '').toLowerCase());
			result.push({
				id, identity, name: mount.label || path.basename(mount.mountPoint || '') || mount.source || 'USB drive', mountPoint: mount.mountPoint,
				fsType: mount.fsType, source: mount.source || '', totalBytes, freeBytes, mounted, mountable: !mounted && Boolean(mountImpl),
				writable, removable: isRemovable === true, usb, supported,
				ready: mounted && !protectedMountPoint && usb && writable && supported && freeBytes > 0,
				reason: !mounted ? 'The USB drive is detected but not mounted.' : protectedMountPoint ? 'Protected system or media mounts cannot be exported.' : !usb ? 'This mount is not on a USB transport.' : !supported ? 'This filesystem is not supported for export.' : !writable ? 'This USB volume is read-only.' : freeBytes <= 0 ? 'This USB volume is full.' : ''
			});
		}
		return result;
	}

	async function findVolume(id) {
		const found = (await volumes()).find(item => item.id === id);
		if (!found) throw friendly('The USB drive is no longer connected. Reinsert it and refresh.');
		if (!found.ready) throw friendly(found.reason || 'The USB drive is not ready.');
		return found;
	}

	async function validateSource(source) {
		if (typeof source !== 'string' || !withinAny(roots, source)) throw friendly('That item is not in the configured local media folders.');
		let direct;
		try { direct = await lstatImpl(source); } catch { throw friendly('That local file is no longer available.'); }
		if (direct.isSymbolicLink()) throw friendly('Only regular local files can be exported.');
		let resolved;
		try { resolved = await realpathImpl(source); } catch { throw friendly('That local file is no longer available.'); }
		if (!withinAny(roots, resolved)) throw friendly('That local file is outside the configured media folders.');
		const info = await lstatImpl(resolved);
		if (!info.isFile() || info.isSymbolicLink()) throw friendly('Only regular local files can be exported.');
		return { path: resolved, size: info.size };
	}

	async function availableDestination(volume, relative, used) {
		let candidate = uniqueName(relative, used);
		for (let attempt = 0; attempt < 200; attempt++) {
			try {
				await lstatImpl(path.join(volume.mountPoint, candidate));
				candidate = uniqueName(relative, used);
			} catch (error) {
				if (error?.code === 'ENOENT') return candidate;
				throw friendly('The USB destination could not be checked.');
			}
		}
		throw friendly('There are too many files with the same name on the USB drive.');
	}

	async function plan({ volumeId, items = [] }) {
		requireEnabled();
		if (!Array.isArray(items) || !items.length || items.length > 500) throw friendly('Choose at least one local item, up to 500 entries.');
		const volume = await findVolume(volumeId);
		const files = [], used = new Set(), warnings = [];
		for (const entry of items) {
			if (!entry || typeof entry !== 'object' || typeof entry.folder !== 'string') continue;
			const source = await validateSource(entry.path);
			const folder = String(entry.folder).split(/[\\/]+/).map(part => safeName(part)).filter(Boolean).join(path.sep) || 'Exports';
			const name = safeName(entry.name || path.basename(source.path));
			const relative = path.join(folder, name);
			if (!within(volume.mountPoint, path.join(volume.mountPoint, relative))) throw friendly('The export destination is invalid.');
			const destination = await availableDestination(volume, relative, used);
			const limit = fat32Limit(volume.fsType);
			if (source.size > limit) throw friendly('A file is 4 GB or larger, which this FAT32 USB drive cannot store.');
			files.push({ source: source.path, destination, size: source.size, kind: entry.kind || 'item' });
			for (const sidecar of await sidecarPaths({ path: source.path, sidecars: entry.sidecars }, roots, readdirImpl)) {
				const info = await lstatImpl(sidecar);
				const extension = path.extname(sidecar);
				const originalStem = path.basename(source.path, path.extname(source.path));
				const mainStem = path.basename(name, path.extname(name));
				const sideName = path.basename(sidecar), sideStem = path.basename(sidecar, extension);
				let suffix;
				if (sideStem.startsWith(originalStem)) suffix = sideStem.slice(originalStem.length);
				else if (sideStem.startsWith(mainStem)) suffix = sideStem.slice(mainStem.length);
				else { const dot = sideStem.indexOf('.'); suffix = dot >= 0 ? sideStem.slice(dot) : sideStem; }
				const subRelative = path.join(path.dirname(destination), safeName(path.basename(destination, path.extname(destination)) + suffix + extension));
				const subName = await availableDestination(volume, subRelative, used);
				if (info.size > limit) warnings.push('Skipped a sidecar 4 GB or larger on FAT32.');
				else files.push({ source: sidecar, destination: subName, size: info.size, kind: 'subtitle', sidecar: true });
			}
		}
		if (!files.length) throw friendly('No exportable local files were selected.');
		const totalBytes = files.reduce((sum, file) => sum + file.size, 0);
		const reserve = Math.min(FALLBACK_FREE_RESERVE, Math.max(1024 * 1024, Math.floor(volume.freeBytes * 0.01)));
		if (totalBytes + reserve > volume.freeBytes) throw friendly('The selected files do not fit in the USB drive free space.');
		const id = randomUUID();
		const value = { id, volumeId: volume.id, volume, createdAt: clock(), files, totalBytes, freeBytes: volume.freeBytes, reserve, warnings };
		plans.set(id, value);
		if (plans.size > 64) plans.delete(plans.keys().next().value);
		return { id, volume: publicVolume(volume), totalBytes, freeBytes: volume.freeBytes, reserve,
			files: files.map(file => ({ destination: file.destination, size: file.size, kind: file.kind })), warnings };
	}

	function publicVolume(volume) {
		const { id, name, fsType, totalBytes, freeBytes, writable, removable, ready, reason, mounted, mountable } = volume;
		return { id, name, fsType, totalBytes, freeBytes, writable, removable, ready, reason, mounted: Boolean(mounted), mountable: Boolean(mountable) };
	}

	async function ancestry(volume, destination) {
		const relative = path.relative(volume.mountPoint, destination);
		if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw friendly('The export destination is invalid.');
		let current = volume.mountPoint;
		for (const part of relative.split(path.sep).slice(0, -1)) {
			current = path.join(current, part);
			let info;
			try { info = await lstatImpl(current); }
			catch (error) {
				if (error?.code !== 'ENOENT') throw friendly('The USB destination could not be checked.');
				try { await mkdirImpl(current, { mode: 0o755 }); } catch (createError) { if (createError?.code !== 'EEXIST') throw friendly('The USB destination folder could not be created.'); }
				info = await lstatImpl(current);
			}
			if (info.isSymbolicLink() || !info.isDirectory()) throw friendly('The USB destination contains a symlink or a non-directory.');
		}
	}

	async function anchoredDirectories(root, parts) {
		const dirFlags = fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY || 0) | (fsConstants.O_NOFOLLOW || 0);
		let handle = await openImpl(root, dirFlags);
		try {
			for (const part of parts) {
				const anchored = `/proc/self/fd/${handle.fd}/${part}`;
				let next;
				try { next = await openImpl(anchored, dirFlags); }
				catch (error) {
					if (error?.code !== 'ENOENT') throw friendly('The destination folder is a symlink or cannot be opened.');
					try { await mkdirImpl(anchored, { mode: 0o755 }); } catch (createError) { if (createError?.code !== 'EEXIST') throw createError; }
					next = await openImpl(anchored, dirFlags);
				}
				await handle.close(); handle = next;
			}
			return handle;
		} catch (error) { await handle.close().catch(() => {}); throw error; }
	}

	async function openDestination(volume, destination) {
		if (process.platform === 'linux') {
			const relative = path.relative(volume.mountPoint, destination);
			if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw friendly('The export destination is invalid.');
			const parts = relative.split(path.sep), name = parts.pop();
			const dir = await anchoredDirectories(volume.mountPoint, parts);
			let handle;
			try {
				handle = await openImpl(`/proc/self/fd/${dir.fd}/${name}`, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW || 0), 0o644);
				const actual = await readlinkImpl(`/proc/self/fd/${handle.fd}`);
				if (!within(volume.mountPoint, actual)) throw friendly('The USB destination escaped the selected volume.');
			} catch (error) {
				// openDestination owns this O_EXCL file until it returns. Never leave
				// it behind if the post-open path check fails.
				if (handle) {
					try { await unlinkImpl(`/proc/self/fd/${dir.fd}/${name}`); } catch {}
					await handle.close().catch(() => {});
				}
				await dir.close().catch(() => {});
				throw error;
			}
			return { handle, dir, name };
		}
		await ancestry(volume, destination);
		const handle = await openImpl(destination, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW || 0), 0o644);
		return { handle, dir: null, name: path.basename(destination), destination };
	}

	/** Remove only the O_EXCL file this job created; never an existing destination. */
	async function removePartial(opened) {
		if (!opened) return;
		try {
			if (opened.dir) await unlinkImpl(`/proc/self/fd/${opened.dir.fd}/${opened.name}`);
			else if (opened.destination) await unlinkImpl(opened.destination);
		} catch {}
	}

	async function openSource(source) {
		const info = await validateSource(source);
		if (process.platform === 'linux') {
			const root = roots.find(candidate => within(candidate, info.path));
			if (!root) throw friendly('The local source is outside the configured media folders.');
			const relative = path.relative(root, info.path);
			const parts = relative.split(path.sep), name = parts.pop();
			const dir = await anchoredDirectories(root, parts);
			try {
				const handle = await openImpl(`/proc/self/fd/${dir.fd}/${name}`, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
				const actual = await readlinkImpl(`/proc/self/fd/${handle.fd}`);
				if (!withinAny(roots, actual)) { await handle.close(); throw friendly('The local source escaped the configured media folders.'); }
				return { handle, path: info.path, size: info.size };
			} finally { await dir.close().catch(() => {}); }
		}
		const handle = await openImpl(info.path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
		return { handle, path: info.path, size: info.size };
	}

	async function run(job, planValue) {
		const volume = planValue.volume;
		let current = null;
		job.status = 'running';
		try {
			for (const file of planValue.files) {
				if (job.cancelled) throw Object.assign(new Error('Export cancelled.'), { cancelled: true });
				const fresh = await findVolume(volume.id);
				if (fresh.id !== volume.id || fresh.identity !== volume.identity) throw friendly('The USB drive changed during the export.');
				const destination = path.join(volume.mountPoint, file.destination);
				if (!within(volume.mountPoint, destination)) throw friendly('The export destination is invalid.');
				let source = null, opened = null;
				try {
					source = await openSource(file.source);
					opened = await openDestination(volume, destination);
					current = opened;
					const stream = createReadStreamImpl ? createReadStreamImpl(file.source, { highWaterMark: COPY_CHUNK_BYTES }) : source.handle.createReadStream({ highWaterMark: COPY_CHUNK_BYTES });
					let unflushed = 0;
					for await (const chunk of stream) {
						if (job.cancelled) throw Object.assign(new Error('Export cancelled.'), { cancelled: true });
						let offset = 0;
						while (offset < chunk.length) {
							const written = await opened.handle.write(chunk, offset, chunk.length - offset);
							offset += written.bytesWritten;
							if (job.cancelled) throw Object.assign(new Error('Export cancelled.'), { cancelled: true });
						}
						job.bytes += chunk.length;
						job.current = file.destination;
						unflushed += chunk.length;
						if (unflushed >= FLUSH_BYTES) {
							// Bound dirty page cache. The file remains open and the
							// existing no-overwrite destination is unchanged.
							if (typeof opened.handle.datasync === 'function') await opened.handle.datasync();
							else await opened.handle.sync();
							unflushed = 0;
							await new Promise(resolve => setImmediate(resolve));
						}
					}
					await opened.handle.sync();
					if (opened.dir) await opened.dir.sync();
				} catch (error) {
					await removePartial(current);
					current = null;
					throw error;
				} finally {
					if (opened?.handle) await opened.handle.close().catch(() => {});
					if (opened?.dir) await opened.dir.close().catch(() => {});
					if (source?.handle) await source.handle.close().catch(() => {});
				}
				job.filesDone++;
				current = null;
			}
			job.status = 'complete'; job.finishedAt = clock(); job.current = '';
			job.filesFlushed = true;
			job.safeToRemove = false;
		} catch (error) {
			await removePartial(current);
			job.status = error?.cancelled ? 'cancelled' : 'failed';
			job.error = error?.cancelled ? 'Export cancelled. Partial files were removed.' : errorMessage(error);
			job.finishedAt = clock();
		}
	}

	function start(id, { confirmed } = {}) {
		requireEnabled();
		if (confirmed !== true) throw friendly('Review the size summary and start the export explicitly.');
		const planValue = plans.get(id);
		if (!planValue) throw friendly('This export summary has expired. Review the files again.');
		if ([...jobs.values()].some(job => job.volumeId === planValue.volumeId && ['queued', 'running'].includes(job.status))) throw friendly('Another export is already running on this USB drive.');
		const job = { id: randomUUID(), planId: id, volumeId: planValue.volumeId, volume: publicVolume(planValue.volume), status: 'queued',
			bytes: 0, totalBytes: planValue.totalBytes, filesDone: 0, filesTotal: planValue.files.length, current: '',
			startedAt: clock(), finishedAt: null, cancelled: false, safeToRemove: false };
		jobs.set(job.id, job);
		if (jobs.size > 64) jobs.delete(jobs.keys().next().value);
		// One export at a time keeps source reads, USB writeback and memory bounded.
		// A queued job is visible immediately and can still be cancelled.
		queue = queue.then(() => run(job, planValue)).catch(() => {});
		return publicJob(job);
	}

	function publicJob(job) {
		return { id: job.id, volumeId: job.volumeId, volume: job.volume, status: job.status, bytes: job.bytes,
			totalBytes: job.totalBytes, filesDone: job.filesDone, filesTotal: job.filesTotal, current: job.current,
			startedAt: job.startedAt, finishedAt: job.finishedAt, error: job.error || '',
			filesFlushed: Boolean(job.filesFlushed), safeToRemove: Boolean(job.safeToRemove) };
	}

	function job(id) {
		requireEnabled();
		const found = jobs.get(id);
		if (!found) throw Object.assign(new Error('Export job not found.'), { status: 404 });
		return publicJob(found);
	}

	async function cancel(id) {
		const found = jobs.get(id);
		if (!found) throw Object.assign(new Error('Export job not found.'), { status: 404 });
		if (!['running', 'queued'].includes(found.status)) return publicJob(found);
		found.cancelled = true;
		found.status = 'cancelling';
		return publicJob(found);
	}

	async function mount(id) {
		requireEnabled();
		const found = (await volumes()).find(item => item.id === id);
		if (!found) throw friendly('The USB drive is no longer connected.');
		if (found.mounted) return publicVolume(found);
		if (!mountImpl) throw friendly('Mounting is not available on this installation.');
		await mountImpl(found.source, found.identity);
		const after = (await volumes()).find(item => item.id === id);
		if (!after?.mounted) throw friendly('The USB drive did not mount. Check the host helper.');
		return publicVolume(after);
	}

	async function finish(volumeId) {
		requireEnabled();
		const volume = await findVolume(volumeId);
		if ([...jobs.values()].some(job => job.volumeId === volumeId && ['queued', 'running', 'cancelling'].includes(job.status))) throw friendly('Wait for the export to finish before removing the USB drive.');
		if (ejectImpl) await ejectImpl(volume.source, volume.identity);
		return { filesFlushed: true, safeToRemove: Boolean(ejectImpl), volume: publicVolume(volume),
			message: ejectImpl ? 'Export finished. Files are flushed; the USB helper has unmounted the drive.' : 'Export finished. Files are flushed; unmount the USB drive from the media host before unplugging.' };
	}

	function status() {
		if (!enabled) return Promise.resolve({ enabled: false, reason: 'USB export is not configured. Add a read-only local media mount and a writable USB volume on the media host.', volumes: [] });
		return volumes().then(items => ({ enabled: true, volumes: items.map(publicVolume) }));
	}

	return { status, volumes, plan, start, job, cancel, finish, mount, enabled,
		_volumes: volumes, _parseMountInfo: parseMountInfo };
}

export function adminAllowed(req, { isLocal, isAdmin }) {
	if (req.get('authorization') || req.get('x-jserver-app')) return Boolean(isAdmin(req));
	return Boolean(isLocal(req));
}

export function installUsbExport(app, { manager, allowed, resolve, audit = () => {} }) {
	function guard(req, res, next) {
		res.setHeader('Cache-Control', 'no-store');
		if (!allowed(req)) return res.status(403).json({ error: 'USB export is available to administrators only.' });
		if (req.method !== 'GET' && (!req.is('application/json') || req.get('origin') !== req.jserverOrigin)) return res.status(403).json({ error: 'Open the local Tellybox settings to export files.' });
		next();
	}
	app.get('/api/export/status', guard, async (req, res, next) => { try { res.json(await manager.status()); } catch (error) { next(error); } });
	app.get('/api/export/items', guard, async (req, res, next) => { try { res.json(await resolve()); } catch (error) { next(error); } });
	app.post('/api/export/plan', guard, async (req, res, next) => {
		try { const result = await manager.plan({ volumeId: req.body?.volumeId, items: await resolve(req.body?.itemIds) }); audit('export_planned', req.jserverViewer, { files: result.files.length }); res.json(result); }
		catch (error) { next(error); }
	});
	app.post('/api/export/start', guard, async (req, res, next) => { try { res.json(manager.start(req.body?.planId, { confirmed: req.body?.confirm === true })); } catch (error) { next(error); } });
	app.post('/api/export/mount', guard, async (req, res, next) => { try { res.json(await manager.mount(req.body?.volumeId)); } catch (error) { next(error); } });
	app.get('/api/export/jobs/:id', guard, (req, res, next) => { try { res.json(manager.job(req.params.id)); } catch (error) { next(error); } });
	app.post('/api/export/jobs/:id/cancel', guard, async (req, res, next) => { try { res.json(await manager.cancel(req.params.id)); } catch (error) { next(error); } });
	app.post('/api/export/finish', guard, async (req, res, next) => { try { res.json(await manager.finish(req.body?.volumeId)); } catch (error) { next(error); } });
}
