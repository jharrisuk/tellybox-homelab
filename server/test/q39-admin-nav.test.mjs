/* Q39 REGRESSION (0.26.50 batch): Activity navigation hiding.
 *
 * No existing test references admin-nav.js. This file pins the shipped
 * contract: exactly one /admin-nav.js script on every public page that carries
 * an Activity link (and none on pages without the link), placed in <head>
 * before the link so it runs before paint; the script hides a[href="/activity"]
 * synchronously and reveals it only when /api/auth/status answers admin:true.
 * Any refusal, failure or non-true value leaves the link hidden.
 *
 * Offline: static markup checks plus a vm DOM with a stubbed fetch.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { installAuth } from '../auth.mjs';

const publicDirectory = fileURLToPath(new URL('../public', import.meta.url));
const adminNav = readFileSync(new URL('../public/admin-nav.js', import.meta.url), 'utf8');
const SCRIPT = /<script[^>]*src="\/admin-nav\.js"[^>]*>\s*<\/script>/g;

const PAGES = ['index.html', 'discover.html', 'search.html', 'coming-soon.html', 'preferences.html',
	'settings.html', 'activity.html', 'apps.html', 'legal.html', 'login.html', 'share-player.html'];

test('every public page with an Activity link carries exactly one admin-nav script, before paint', () => {
	for (const page of PAGES) {
		const html = readFileSync(path.join(publicDirectory, page), 'utf8');
		const links = (html.match(/href="\/activity"/g) || []).length;
		const scripts = (html.match(SCRIPT) || []).length;
		if (links === 0) {
			assert.equal(scripts, 0, page + ' has no Activity link and needs no admin-nav script');
			continue;
		}
		assert.equal(scripts, 1, page + ' must carry exactly one /admin-nav.js script');
		const headEnd = html.indexOf('</head>');
		const scriptAt = html.search(SCRIPT);
		assert.ok(headEnd > 0 && scriptAt >= 0 && scriptAt < headEnd, page + ' loads admin-nav.js in <head>, before body paint');
		assert.ok(scriptAt < html.indexOf('href="/activity"'), page + ' hides the link before the link is parsed');
	}
});

/* Minimal DOM for the script: append/remove track parents so style.remove()
 * really detaches the hiding rule. */
class Element {
	constructor(tag = 'div') {
		this.tag = tag; this.children = []; this.textContent = ''; this.attributes = {}; this.parent = null;
	}
	append(...items) { for (const item of items) { item.parent = this; this.children.push(item); } }
	setAttribute(name, value) { this.attributes[name] = String(value); }
	getAttribute(name) { return Object.hasOwn(this.attributes, name) ? this.attributes[name] : null; }
	remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); }
}

function runScript({ response, reject = false }) {
	const head = new Element('head');
	const document = { head, documentElement: new Element('html'), createElement: tag => new Element(tag) };
	const calls = [];
	let settleFetch;
	const fetchGate = new Promise(resolve => { settleFetch = resolve; });
	const context = {
		document,
		fetch: (url, options) => {
			calls.push({ url: String(url), options });
			return fetchGate.then(() => {
				if (reject) throw new TypeError('Failed to fetch');
				return response;
			});
		}
	};
	// The hiding rule must exist synchronously, before the fetch settles.
	vm.runInNewContext(adminNav, context);
	const styles = head.children.filter(child => child.tag === 'style');
	assert.equal(styles.length, 1, 'the script appends one hiding style immediately');
	const style = styles[0];
	assert.equal(style.getAttribute('data-admin-nav'), '');
	assert.equal(style.textContent, 'a[href="/activity"]{display:none!important}', 'the rule hides the Activity link before paint');
	assert.equal(calls.length, 1);
	assert.equal(calls[0].url, '/api/auth/status');
	assert.equal(calls[0].options.credentials, 'same-origin');
	assert.equal(calls[0].options.cache, 'no-store');
	return {
		style, head,
		async settle() { settleFetch(); for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve)); return head.children.includes(style); }
	};
}

const json = body => ({ ok: true, status: 200, json: async () => body });

test('the link is revealed only for a strict admin:true answer', async () => {
	const revealed = runScript({ response: json({ admin: true }) });
	assert.equal(await revealed.settle(), false, 'admin:true removes the hiding style');

	for (const body of [{ admin: false }, { admin: 'true' }, { admin: 1 }, {}, { admin: null }, null]) {
		const run = runScript({ response: json(body) });
		assert.equal(await run.settle(), true, 'the link stays hidden for ' + JSON.stringify(body));
	}
});

test('a refused, failed or unreadable status answer leaves the link hidden', async () => {
	for (const status of [401, 403, 500]) {
		const run = runScript({ response: { ok: false, status, json: async () => ({ admin: true }) } });
		assert.equal(await run.settle(), true, 'a ' + status + ' answer never reveals the link');
	}
	const broken = runScript({ response: { ok: true, status: 200, json: async () => { throw new Error('unreadable'); } } });
	assert.equal(await broken.settle(), true, 'an unreadable body never reveals the link');
	const offline = runScript({ response: null, reject: true });
	assert.equal(await offline.settle(), true, 'a network failure never reveals the link');
});

test('the script is served to a local caller with its shipped content', async t => {
	const directory = mkdtempSync(path.join(tmpdir(), 'tellybox-q39-nav-'));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	const app = express();
	const server = app.listen(0, '127.0.0.1');
	await once(server, 'listening');
	t.after(() => { server.closeAllConnections?.(); server.close(); });
	installAuth(app, {
		directory, publicDirectory,
		localPort: server.address().port,
		localHosts: ['127.0.0.1'], localNetworks: ['127.0.0.0/8'], setupPort: 8990
	});
	app.use(express.static(publicDirectory));
	const response = await fetch('http://127.0.0.1:' + server.address().port + '/admin-nav.js');
	assert.equal(response.status, 200);
	assert.match(response.headers.get('content-type'), /javascript/);
	assert.equal(await response.text(), adminNav, 'the served script is the shipped file, unmodified');
});
