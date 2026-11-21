import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';

// Permanent regression guard for the release-135 mojibake incident. The
// deployed /settings page was valid UTF-8 but double-encoded (23x U+00E2,
// 18x U+20AC, 14x U+00A6, a UTF-8 BOM and C1 controls). The corruption was a
// PowerShell 5.1 batch edit during the 132 review: Get-Content -Raw read the
// page as ANSI (cp1252) and Set-Content -Encoding utf8 wrote it back with a
// BOM. The image build and Docker COPY were byte-exact and not at fault, which
// is why this guard inspects the source assets and the real static-handler
// configuration rather than trusting a build step to be careful.

const here = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(here, '..');

const publicRoots = [
	{ name: 'public', directory: path.join(serverRoot, 'public') },
	{ name: 'homelab/public', directory: path.join(serverRoot, 'homelab', 'public') }
];

const SCANNED_EXTENSIONS = new Set(['.html', '.js', '.mjs', '.css', '.json', '.svg']);
const SCANNED_EXTENSION_LABEL = [...SCANNED_EXTENSIONS].join(', ');

// A few pages and scripts are served by explicit routes instead of
// express.static. Each entry is checked twice: the route must still be
// declared, and the bytes it serves must pass the same encoding rules.
const VENDOR_HLS = path.join(serverRoot, 'node_modules', 'hls.js', 'dist', 'hls.min.js');
const ROUTED_ASSETS = [
	{ route: '/vendor/hls.min.js', declaredIn: 'server.mjs', declaration: "app.get('/vendor/hls.min.js'", file: VENDOR_HLS },
	{ route: '/share-hls.js', declaredIn: 'shares.mjs', declaration: "app.get('/share-hls.js'", file: VENDOR_HLS },
	{ route: '/activity/downloads', declaredIn: 'qbittorrent.mjs', declaration: "app.get('/activity/downloads'", file: path.join(serverRoot, 'qbittorrent-page.mjs') }
];

// Generated pages live in module template strings, so their <script> and
// <link> references must be followed from the module rather than a public file.
const INLINE_PAGE_SOURCES = [
	{ file: path.join(serverRoot, 'qbittorrent-page.mjs'), name: 'qbittorrent-page.mjs' }
];

// Built from code points so this test source itself stays clean ASCII and can
// never become evidence of the bug it is meant to catch.
const cp = (...points) => String.fromCodePoint(...points);

// Signatures produced when UTF-8 bytes are decoded as Windows-1252 and then
// re-encoded as UTF-8 (the release-135 failure mode).
const DOUBLE_ENCODING_SIGNATURES = [
	{ name: 'latin-1 A-circumflex (C3 A2)', text: cp(0x00C3, 0x00A2) },
	{ name: 'right single quote (E2 80 99)', text: cp(0x00E2, 0x20AC, 0x2122) },
	{ name: 'left double quote (E2 80 9C)', text: cp(0x00E2, 0x20AC, 0x0153) },
	{ name: 'right double quote (E2 80 9D)', text: cp(0x00E2, 0x20AC, 0x009D) },
	{ name: 'en dash (E2 80 93)', text: cp(0x00E2, 0x20AC, 0x201C) },
	{ name: 'em dash (E2 80 94)', text: cp(0x00E2, 0x20AC, 0x201D) },
	{ name: 'ellipsis (E2 80 A6)', text: cp(0x00E2, 0x20AC, 0x00A6) },
	{ name: 'left arrow (E2 86 90)', text: cp(0x00E2, 0x2020, 0x0090) },
	{ name: 'middle dot (C2 B7)', text: cp(0x00C2, 0x00B7) },
	{ name: 'non-breaking space Â (C2 A0)', text: cp(0x00C2, 0x0020) },
	{ name: 'pound sign Â£ (C2 A3)', text: cp(0x00C2, 0x00A3) },
	{ name: 'euro sign â‚¬ (E2 82 AC)', text: cp(0x00E2, 0x201A, 0x00AC) }
];

const UTF8_BOM = [0xEF, 0xBB, 0xBF];
const C1_CONTROL = /[\u0080-\u009F]/;

function walkFiles(directory) {
	const files = [];
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const absolute = path.join(directory, entry.name);
		if (entry.isDirectory()) files.push(...walkFiles(absolute));
		else if (entry.isFile()) files.push(absolute);
	}
	return files;
}

function relativeName(file) {
	return path.relative(serverRoot, file).split(path.sep).join('/');
}

function isScanned(file) {
	return SCANNED_EXTENSIONS.has(path.extname(file).toLowerCase());
}

function startsWithBom(bytes) {
	return bytes.length >= 3 && bytes[0] === UTF8_BOM[0] && bytes[1] === UTF8_BOM[1] && bytes[2] === UTF8_BOM[2];
}

function analyseAsset(file, rootName) {
	const bytes = readFileSync(file);
	return {
		file,
		name: relativeName(file),
		rootName,
		bytes,
		...inspectBytes(bytes)
	};
}

function inspectBytes(bytes) {
	const result = {
		text: '',
		decodeError: null,
		bom: startsWithBom(bytes),
		hasC1: false,
		signatures: []
	};
	try {
		result.text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
	} catch (error) {
		result.decodeError = error;
		return result;
	}
	if (result.text.includes('\uFFFD')) result.decodeError = new Error('decoded text contains U+FFFD replacement characters');
	result.hasC1 = C1_CONTROL.test(result.text);
	result.signatures = DOUBLE_ENCODING_SIGNATURES.filter(signature => result.text.includes(signature.text));
	return result;
}

const assets = publicRoots.flatMap(root =>
	walkFiles(root.directory)
		.filter(isScanned)
		.map(file => analyseAsset(file, root.name))
);

const assetsByRoot = new Map(publicRoots.map(root => [root.name, assets.filter(asset => asset.rootName === root.name)]));
const inlinePageSources = INLINE_PAGE_SOURCES.map(source => ({ ...source, text: readFileSync(source.file, 'utf8') }));

// "Passed check 1" means every byte-level rule below held for that file.
const cleanAssets = new Set(
	assets
		.filter(asset => !asset.decodeError && !asset.bom && !asset.hasC1 && asset.signatures.length === 0)
		.map(asset => path.resolve(asset.file))
);

function assertAssetClean(asset) {
	assert.equal(asset.decodeError, null, `${asset.name} must decode as strict UTF-8 without replacement characters`);
	assert.ok(!asset.bom, `${asset.name} must not start with a UTF-8 BOM`);
	assert.ok(!asset.hasC1, `${asset.name} must not contain C1 control characters (U+0080-U+009F)`);
	for (const signature of asset.signatures) {
		assert.fail(`${asset.name} still contains double-encoded text: ${signature.name}`);
	}
}

function rootForFile(file) {
	const resolved = path.resolve(file);
	return publicRoots.find(root => {
		const directory = path.resolve(root.directory);
		return resolved === directory || resolved.startsWith(directory + path.sep);
	});
}

function insidePublicRoots(file) {
	return Boolean(rootForFile(file));
}

const EXTERNAL_REFERENCE = /^[a-z][a-z0-9+.-]*:/i;

function isLocalReference(value) {
	const trimmed = String(value || '').trim();
	if (!trimmed) return false;
	if (trimmed.startsWith('#') || trimmed.startsWith('?') || trimmed.startsWith('//')) return false;
	return !EXTERNAL_REFERENCE.test(trimmed);
}

function referencePath(value) {
	let pathname = String(value).trim().split('#')[0].split('?')[0];
	if (!pathname) return null;
	try {
		pathname = decodeURIComponent(pathname);
	} catch {
		// Keep the raw path when it is not valid percent-encoding.
	}
	return pathname;
}

function resolveReference(value, fromFile) {
	const pathname = referencePath(value);
	if (!pathname) return null;

	if (pathname.startsWith('/')) {
		const owner = rootForFile(fromFile);
		const orderedRoots = [owner, ...publicRoots.filter(root => root !== owner)].filter(Boolean);
		const relative = pathname.replace(/^\/+/, '');
		for (const root of orderedRoots) {
			const found = resolveCandidate(path.join(root.directory, relative));
			if (found) return { file: found };
		}
		return null;
	}

	const found = resolveCandidate(path.resolve(path.dirname(fromFile), pathname));
	return found ? { file: found } : null;
}

function resolveCandidate(candidate) {
	if (statSync(candidate, { throwIfNoEntry: false })?.isFile()) return candidate;
	if (statSync(candidate, { throwIfNoEntry: false })?.isDirectory()) {
		const index = path.join(candidate, 'index.html');
		if (statSync(index, { throwIfNoEntry: false })?.isFile()) return index;
	}
	if (!path.extname(candidate)) {
		const page = candidate + '.html';
		if (statSync(page, { throwIfNoEntry: false })?.isFile()) return page;
	}
	return null;
}

const HTML_REFERENCE = /\b(?:src|href)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
const CSS_REFERENCE = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"]*))\s*\)/gi;
const JS_IMPORT = /\bimport\s+(?:[^'"]*?\bfrom\s+)?['"]([^'"]+)['"]/g;

function collectReferences() {
	const references = [];
	for (const asset of [...assets, ...inlinePageSources]) {
		const extension = path.extname(asset.file).toLowerCase();
		const add = (value, kind, match) => {
			if (!isLocalReference(value)) return;
			const line = asset.text.slice(0, match.index).split('\n').length;
			references.push({ value, kind, file: asset.file, line, label: `${asset.name}:${line}` });
		};

		if (extension === '.html') {
			for (const match of asset.text.matchAll(HTML_REFERENCE)) add(match[1] ?? match[2] ?? '', 'attribute', match);
		} else if (extension === '.css') {
			for (const match of asset.text.matchAll(CSS_REFERENCE)) add(match[1] ?? match[2] ?? match[3] ?? '', 'url()', match);
		} else if (extension === '.js' || extension === '.mjs') {
			for (const match of asset.text.matchAll(JS_IMPORT)) add(match[1] ?? '', 'import', match);
		}
	}
	return references;
}

// --- express.static configuration -----------------------------------------

function splitTopLevel(text, separator = ',') {
	const parts = [];
	let depth = 0;
	let quote = '';
	let start = 0;
	for (let index = 0; index < text.length; index++) {
		const character = text[index];
		if (quote) {
			if (character === '\\') index++;
			else if (character === quote) quote = '';
			continue;
		}
		if (character === "'" || character === '"' || character === '`') { quote = character; continue; }
		if (character === '(' || character === '{' || character === '[') depth++;
		else if (character === ')' || character === '}' || character === ']') depth--;
		else if (character === separator && depth === 0) {
			parts.push(text.slice(start, index));
			start = index + 1;
		}
	}
	parts.push(text.slice(start));
	return parts;
}

function readStaticMounts(sourceName) {
	const source = readFileSync(path.join(serverRoot, sourceName), 'utf8');
	const mounts = [];
	const marker = 'express.static(';
	let cursor = 0;
	while ((cursor = source.indexOf(marker, cursor)) !== -1) {
		const start = cursor + marker.length;
		let depth = 0;
		let quote = '';
		let end = start;
		for (; end < source.length; end++) {
			const character = source[end];
			if (quote) {
				if (character === '\\') end++;
				else if (character === quote) quote = '';
				continue;
			}
			if (character === "'" || character === '"' || character === '`') { quote = character; continue; }
			if (character === '(' || character === '{' || character === '[') depth++;
			else if (character === ')' || character === '}' || character === ']') {
				if (depth === 0 && character === ')') break;
				depth--;
			}
		}
		assert.notEqual(end, source.length, `${sourceName} express.static( call must be closed`);
		const args = splitTopLevel(source.slice(start, end));
		mounts.push({
			sourceName,
			line: source.slice(0, cursor).split('\n').length,
			pathExpression: args[0].trim(),
			optionsText: (args[1] ?? '').trim()
		});
		cursor = end + 1;
	}
	return mounts;
}

function parseStaticOptions(optionsText) {
	const trimmed = optionsText.trim();
	if (!trimmed) return {};
	assert.match(trimmed, /^\{[\s\S]*\}$/, `express.static options must be an object literal, received: ${trimmed}`);
	const body = trimmed.slice(1, -1).trim();
	if (!body) return {};
	const options = {};
	for (const part of splitTopLevel(body)) {
		const match = /^\s*['"]?([A-Za-z_$][\w$]*)['"]?\s*:\s*([\s\S]+?)\s*$/.exec(part);
		assert.ok(match, `express.static option must be a simple literal, received: ${part.trim()}`);
		const key = match[1];
		const value = match[2];
		if (/^'(?:[^'\\]|\\.)*'$/.test(value) || /^"(?:[^"\\]|\\.)*"$/.test(value)) options[key] = value.slice(1, -1);
		else if (/^(?:true|false)$/.test(value)) options[key] = value === 'true';
		else if (/^-?\d+$/.test(value)) options[key] = Number(value);
		else assert.fail(`express.static option "${key}" uses an unsupported expression (${value}); keep the static configuration simple so the charset guard can replay it`);
	}
	return options;
}

const STATIC_SOURCES = [
	{ sourceName: 'server.mjs', rootName: 'public' },
	{ sourceName: path.join('homelab', 'admin.mjs'), rootName: 'homelab/public' }
];

function staticConfigurations() {
	return STATIC_SOURCES.map(expected => {
		const root = publicRoots.find(candidate => candidate.name === expected.rootName);
		const mounts = readStaticMounts(expected.sourceName).filter(mount => mount.pathExpression.includes("'public'"));
		assert.equal(
			mounts.length,
			1,
			`${expected.sourceName} must mount exactly one express.static directory for ${expected.rootName} (found ${mounts.length})`
		);
		return { ...expected, root, ...mounts[0] };
	});
}

async function listen(app) {
	return new Promise(resolve => {
		const server = app.listen(0, '127.0.0.1', () => resolve(server));
	});
}

async function close(server) {
	server.closeAllConnections?.();
	await new Promise(resolve => server.close(resolve));
}

// --- checks ---------------------------------------------------------------

test(`every served page, script, stylesheet, manifest and icon (${SCANNED_EXTENSION_LABEL}) is strict UTF-8`, () => {
	assert.ok(assets.length > 0, 'expected served assets to scan');
	for (const asset of assets) assertAssetClean(asset);
});

function assertBytesClean(bytes, label) {
	const inspected = inspectBytes(bytes);
	assert.equal(inspected.decodeError, null, `${label} must decode as strict UTF-8 without replacement characters`);
	assert.ok(!inspected.bom, `${label} must not start with a UTF-8 BOM`);
	assert.ok(!inspected.hasC1, `${label} must not contain C1 control characters (U+0080-U+009F)`);
	for (const signature of inspected.signatures) {
		assert.fail(`${label} still contains double-encoded text: ${signature.name}`);
	}
}

function assertRoutedReference(reference, route) {
	const sourcePath = path.join(serverRoot, route.declaredIn);
	assert.ok(
		readFileSync(sourcePath, 'utf8').includes(route.declaration),
		`${reference.label} points at ${route.route}, so ${route.declaredIn} must still declare ${route.declaration}`
	);
	assertBytesClean(readFileSync(route.file), `${relativeName(route.file)} served at ${route.route}`);
}

test('every local page, script and stylesheet reference resolves to an asset that passed the encoding check', () => {
	const references = collectReferences();
	assert.ok(references.length > 0, 'expected local references to verify');

	for (const reference of references) {
		const resolution = resolveReference(reference.value, reference.file);
		if (!resolution) {
			const pathname = referencePath(reference.value);
			const routed = ROUTED_ASSETS.find(entry => entry.route === pathname);
			assert.ok(
				routed,
				`${reference.label} ${reference.kind} reference ${JSON.stringify(reference.value)} must resolve to a served file or a declared app route`
			);
			assertRoutedReference(reference, routed);
			continue;
		}
		const extension = path.extname(resolution.file).toLowerCase();
		if (!SCANNED_EXTENSIONS.has(extension) || !insidePublicRoots(resolution.file)) continue;
		assert.ok(
			cleanAssets.has(path.resolve(resolution.file)),
			`${reference.label} ${reference.kind} reference ${JSON.stringify(reference.value)} must point at a file that passed the encoding check: ${relativeName(resolution.file)}`
		);
	}
});

test('the real express.static configuration serves html, js and css with charset=utf-8', async () => {
	const configurations = staticConfigurations();

	for (const configuration of configurations) {
		// A setHeaders hook is the realistic way to drop the charset that
		// express.static adds from the media type. Refuse it outright.
		const mountLabel = `${configuration.sourceName}:${configuration.line}`;
		assert.doesNotMatch(
			configuration.optionsText,
			/setHeaders|content-type/i,
			`${mountLabel} express.static for ${configuration.rootName} must not override Content-Type: charset=utf-8 would be lost`
		);

		const options = parseStaticOptions(configuration.optionsText);
		const app = express();
		app.use(express.static(configuration.root.directory, options));
		const server = await listen(app);
		try {
			const base = `http://127.0.0.1:${server.address().port}`;
			for (const extension of ['.html', '.js', '.css']) {
				const asset = assetsByRoot.get(configuration.rootName).find(candidate => path.extname(candidate.file).toLowerCase() === extension);
				assert.ok(asset, `${configuration.rootName} must contain a ${extension} asset to verify the static charset`);
				const route = '/' + encodeURIComponent(path.basename(asset.file));
				const response = await fetch(base + route);
				assert.equal(response.status, 200, `${route} from ${configuration.rootName} must be served`);
				assert.match(
					response.headers.get('content-type') ?? '',
					/^text\/(?:html|javascript|css);\s*charset=utf-8$/i,
					`${route} from ${configuration.rootName} must be served with charset=utf-8`
				);
				await response.arrayBuffer();
			}
		} finally {
			await close(server);
		}
	}
});
