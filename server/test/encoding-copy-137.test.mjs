import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(here, '..');
const publicDirectory = path.join(serverRoot, 'public');
const homelabPublicDirectory = path.join(serverRoot, 'homelab', 'public');

const marker = codePoints => String.fromCodePoint(...codePoints);

// Mojibake sequences produced when UTF-8 bytes are read as Windows-1252.
// Each string is built from code points so this test source stays clean ASCII.
const MOJIBAKE_MARKERS = [
	{ name: 'middle dot C2 B7', text: marker([0x00C2, 0x00B7]) },
	{ name: 'em dash E2 80 94', text: marker([0x00E2, 0x20AC, 0x201D]) },
	{ name: 'apostrophe E2 80 99', text: marker([0x00E2, 0x20AC, 0x2122]) },
	{ name: 'open quote E2 80 9C', text: marker([0x00E2, 0x20AC, 0x0153]) },
	{ name: 'close quote E2 80 9D', text: marker([0x00E2, 0x20AC, 0x009D]) },
	{ name: 'ellipsis E2 80 A6', text: marker([0x00E2, 0x20AC, 0x00A6]) },
	{ name: 'arrow E2 86 92', text: marker([0x00E2, 0x2020, 0x2019]) },
	{ name: 'hamburger E2 98 B0', text: marker([0x00E2, 0x02DC, 0x00B0]) },
	{ name: 'times C3 97', text: marker([0x00C3, 0x2014]) },
	{ name: 'search glyph E2 8C 95', text: marker([0x00E2, 0x0152, 0x2022]) },
	{ name: 'fullwidth plus EF BC 8B', text: marker([0x00EF, 0x00BC, 0x2039]) }
];

const MOJIBAKE_PLUS_TIME_PERIOD = marker([0x00EF, 0x00BC, 0x2039]) + ' Time period';

function htmlFiles() {
	return [
		...readdirSync(publicDirectory).filter(name => name.endsWith('.html')).map(name => path.join(publicDirectory, name)),
		...readdirSync(homelabPublicDirectory).filter(name => name.endsWith('.html')).map(name => path.join(homelabPublicDirectory, name))
	].map(file => ({ file, name: path.relative(serverRoot, file), bytes: readFileSync(file) }));
}

function decodeStrict(bytes, label) {
	let text;
	assert.doesNotThrow(() => {
		text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
	}, `${label} must be strict UTF-8`);
	assert.ok(!text.includes('\uFFFD'), `${label} must not contain U+FFFD replacement characters`);
	return text;
}

const pages = htmlFiles();
const pageText = new Map(pages.map(page => [page.name, decodeStrict(page.bytes, page.name)]));

test('every served HTML page is strict UTF-8, BOM-free and free of mojibake', () => {
	assert.ok(pages.length > 0, 'expected HTML pages to scan');
	for (const page of pages) {
		assert.ok(
			!(page.bytes.length >= 3 && page.bytes[0] === 0xEF && page.bytes[1] === 0xBB && page.bytes[2] === 0xBF),
			`${page.name} must not start with a UTF-8 BOM`
		);
		const text = pageText.get(page.name);
		for (const mojibake of MOJIBAKE_MARKERS) {
			assert.ok(!text.includes(mojibake.text), `${page.name} still contains mojibake: ${mojibake.name}`);
		}
		assert.ok(!text.includes(MOJIBAKE_PLUS_TIME_PERIOD), `${page.name} still contains the corrupted "plus Time period" label`);
	}
});

test('every HTML page declares a UTF-8 charset', () => {
	for (const page of pages) {
		assert.match(pageText.get(page.name), /<meta\s+charset="utf-8">/i, `${page.name} must declare <meta charset="utf-8">`);
	}
});

test('repaired titles and copy are present', () => {
	const settings = pageText.get(path.join('public', 'settings.html'));
	const preferences = pageText.get(path.join('public', 'preferences.html'));
	const discover = pageText.get(path.join('public', 'discover.html'));
	const search = pageText.get(path.join('public', 'search.html'));
	const comingSoon = pageText.get(path.join('public', 'coming-soon.html'));

	assert.match(settings, /<title>Settings (?:&middot;|\u00B7) Tellybox<\/title>/, 'settings title must use a middle dot');
	assert.match(preferences, /<title>Watching settings (?:&middot;|\u00B7) Tellybox<\/title>/, 'preferences title must use a middle dot');
	assert.match(discover, /<title>Discover - Tellybox<\/title>/, 'discover title must use a regular hyphen');
	assert.match(search, /<title>Search - Tellybox<\/title>/, 'search title must use a regular hyphen');

	for (const [name, text] of [['settings', settings], ['preferences', preferences]]) {
		assert.ok(text.includes('Back to watching'), `${name} must keep "Back to watching"`);
	}
	assert.ok(settings.includes("Who's watching"), 'settings must keep "Who\'s watching"');
	assert.ok(settings.includes('Open installation settings'), 'settings must keep "Open installation settings"');

	assert.ok(discover.includes('Finding something good...'), 'discover must use three dots in "Finding something good..."');
	assert.ok(discover.includes("you'd love"), 'discover must use an ASCII apostrophe in "you\'d love"');
	assert.ok(search.includes("Watch what's here. Add what's missing."), 'search must use ASCII apostrophes in its hint');
	assert.match(comingSoon, /Next highlight (?:&rarr;|\u2192)/, 'coming-soon must keep a real arrow or entity after "Next highlight"');

	assert.ok(settings.includes('+ Time period'), 'settings must use a plain plus for the time period button');
	assert.ok(!settings.includes(MOJIBAKE_PLUS_TIME_PERIOD), 'settings must not use the corrupted plus glyph');
	assert.ok(!settings.includes(marker([0x00C2, 0x00B7])), 'settings must not use a corrupted middle dot');
});

test('static server delivers repaired pages as UTF-8 text/html', async t => {
	const app = express();
	app.use(express.static(publicDirectory));
	const server = await new Promise(resolve => {
		const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
	});
	t.after(() => {
		server.closeAllConnections?.();
		server.close();
	});

	const base = `http://127.0.0.1:${server.address().port}`;
	const expected = new Map([
		['/settings.html', [/Settings (?:&middot;|\u00B7) Tellybox/, /Who's watching/, /Back to watching/, /Open installation settings/, /\+ Time period/]],
		['/preferences.html', [/Watching settings (?:&middot;|\u00B7) Tellybox/, /Back to watching/]]
	]);

	for (const [route, patterns] of expected) {
		const response = await fetch(base + route);
		assert.equal(response.status, 200, `${route} must return 200`);
		assert.match(
			response.headers.get('content-type') ?? '',
			/^text\/html;\s*charset=utf-8$/i,
			`${route} must be served as text/html with charset=utf-8`
		);

		const bytes = new Uint8Array(await response.arrayBuffer());
		assert.ok(
			!(bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF),
			`${route} must be served without a BOM`
		);
		const body = decodeStrict(bytes, `served ${route}`);
		assert.ok(body.trimStart().startsWith('<!doctype html>'), `${route} must start with the doctype`);
		for (const mojibake of MOJIBAKE_MARKERS) {
			assert.ok(!body.includes(mojibake.text), `served ${route} still contains mojibake: ${mojibake.name}`);
		}
		for (const pattern of patterns) {
			assert.match(body, pattern, `served ${route} must contain the repaired copy`);
		}
	}
});
