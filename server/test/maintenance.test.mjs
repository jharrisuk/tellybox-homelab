import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createMaintenance, MAINTENANCE_MESSAGE } from '../maintenance.mjs';

function fixture(t) {
	const directory = mkdtempSync(path.join(tmpdir(), 'tellybox-maintenance-'));
	t.after(() => rmSync(directory, { recursive: true, force: true }));
	return directory;
}

function fakeRequest({ path: route = '/', accept = '*/*' } = {}) {
	return { path: route, headers: { accept } };
}

function fakeResponse() {
	return {
		statusCode: 200,
		headers: {},
		body: null,
		setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
		status(code) { this.statusCode = code; return this; },
		type(value) { this.headers['content-type'] = value; return this; },
		send(body) { this.body = body; return this; },
		json(body) { this.headers['content-type'] = 'application/json'; this.body = body; return this; }
	};
}

test('maintenance is off by default and a missing or corrupt file never turns it on', t => {
	const directory = fixture(t);
	const maintenance = createMaintenance({ directory });
	assert.equal(maintenance.read().enabled, false);
	writeFileSync(path.join(directory, 'maintenance.json'), '{not json');
	assert.equal(maintenance.read().enabled, false);
	writeFileSync(path.join(directory, 'maintenance.json'), JSON.stringify({ enabled: 'yes', scope: 'nonsense' }));
	const value = maintenance.read();
	assert.equal(value.enabled, false);
	assert.equal(value.scope, 'both');
});

test('scope gates local, remote or both, and the administrator always passes', t => {
	const directory = fixture(t);
	const maintenance = createMaintenance({ directory });
	const gate = maintenance.middleware({
		classify: req => req.kind,
		admin: req => req.admin === true
	});
	const run = (scope, kind, admin = false, route = '/') => {
		maintenance.write({ enabled: true, scope });
		const request = { ...fakeRequest({ path: route }), kind, admin };
		const response = fakeResponse();
		let nextCalled = false;
		gate(request, response, () => { nextCalled = true; });
		return { response, nextCalled };
	};

	assert.equal(run('local', 'local').nextCalled, false);
	assert.equal(run('local', 'remote').nextCalled, true);
	assert.equal(run('remote', 'local').nextCalled, true);
	assert.equal(run('remote', 'remote').nextCalled, false);
	assert.equal(run('both', 'local').nextCalled, false);
	assert.equal(run('both', 'remote').nextCalled, false);
	assert.equal(run('both', 'remote', true).nextCalled, true, 'an administrator is never locked out');
	assert.equal(run('both', 'local', false, '/api/maintenance').nextCalled, true, 'the switch stays reachable');
	assert.equal(run('both', 'local', false, '/style.css').nextCalled, true, 'the page can still load its assets');
});

test('blocked API calls get a machine-readable 503 and browsers get the maintenance page', t => {
	const directory = fixture(t);
	const maintenance = createMaintenance({ directory });
	const gate = maintenance.middleware({ classify: () => 'remote', admin: () => false });
	maintenance.write({ enabled: true, scope: 'both' });

	const api = fakeResponse();
	gate(fakeRequest({ accept: 'application/json' }), api, () => {});
	assert.equal(api.statusCode, 503);
	assert.equal(api.headers['retry-after'], '120');
	assert.equal(api.headers['cache-control'], 'no-store');
	assert.deepEqual(api.body, {
		maintenance: true,
		code: 'MAINTENANCE',
		message: MAINTENANCE_MESSAGE,
		scope: 'both'
	});

	const page = fakeResponse();
	gate(fakeRequest({ accept: 'text/html' }), page, () => {});
	assert.equal(page.statusCode, 503);
	assert.match(String(page.body), /Tellybox is down for maintenance/);
	assert.match(String(page.body), /tellybox-wordmark\.png/);
});

test('the CLI writes and reads the state without the server running', t => {
	const directory = fixture(t);
	const script = fileURLToPath(new URL('../scripts/maintenance.mjs', import.meta.url));
	const run = (...args) => spawnSync(process.execPath, [script, ...args], {
		env: { ...process.env, AUTH_DIR: directory },
		encoding: 'utf8'
	});

	assert.equal(run('on').status, 2, 'on requires a scope');
	const on = run('on', '--scope', 'remote');
	assert.equal(on.status, 0, on.stderr);
	assert.equal(JSON.parse(on.stdout).scope, 'remote');
	const file = JSON.parse(readFileSync(path.join(directory, 'maintenance.json'), 'utf8'));
	assert.equal(file.enabled, true);
	assert.equal(file.scope, 'remote');
	assert.equal(file.updatedBy, 'cli');

	const status = run('status');
	assert.equal(JSON.parse(status.stdout).enabled, true);
	const off = run('off');
	assert.equal(JSON.parse(off.stdout).enabled, false);
	assert.equal(JSON.parse(off.stdout).scope, 'remote', 'off keeps the last scope');
});
