import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
const base = 'http://127.0.0.1:8990';
const publicBase = 'http://127.0.0.1:8082';
const docker = args => { const r = spawnSync('docker', ['compose', '-p', 'homelab-ci', ...args], { encoding: 'utf8' }); if (r.status) throw Error(r.stderr); return r.stdout; };
const request = (route, body, cookie) => fetch(base + '/api/setup/' + route, { method: body ? 'POST' : 'GET', headers: { ...(body ? { Origin: base, 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });

// Release-135 served a valid-UTF-8-but-double-encoded setup page. Route and
// content-type probes alone could not see that, so every text response read by
// this check is now also inspected byte by byte. These checks live here, not in
// a helper module, because this file is the one copied into the public
// repository and must stay self-contained. ASCII only, code-point signatures.
const cp = (...points) => String.fromCodePoint(...points);
const DOUBLE_ENCODING_SIGNATURES = [
	cp(0x00e2, 0x20ac, 0x2122), // right single quote
	cp(0x00e2, 0x20ac, 0x0153), // left double quote
	cp(0x00e2, 0x20ac, 0x009d), // right double quote
	cp(0x00e2, 0x20ac, 0x201c), // en dash
	cp(0x00e2, 0x20ac, 0x201d), // em dash
	cp(0x00e2, 0x20ac, 0x00a6), // ellipsis
	cp(0x00e2, 0x2020), // left arrow
	cp(0x00c2, 0x00b7), // middle dot
	cp(0x00e2, 0x20ac), // generic latin-1 euro prefix
	cp(0x00c3), // latin-1 A-circumflex prefix
	cp(0xfffd) // replacement character
];
function textEncodingProblems(bytes) {
	const problems = [];
	if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) problems.push('UTF-8 BOM at start of file');
	let text;
	try {
		text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
	} catch {
		problems.push('not valid strict UTF-8');
		return problems;
	}
	if (/[\u0080-\u009f]/.test(text)) problems.push('C1 control characters (U+0080-U+009F)');
	if (DOUBLE_ENCODING_SIGNATURES.some(signature => text.includes(signature))) problems.push('double-encoded text');
	return problems;
}
function assertEncoded(route, contentType, bytes) {
	if (!/;\s*charset=utf-8(?:\s*;|$)/i.test(contentType || '')) {
		throw Error('Route ' + route + ' is missing charset=utf-8 (content-type: ' + (contentType || '(none)') + ')');
	}
	const problems = textEncodingProblems(Buffer.from(bytes));
	if (problems.length) throw Error('Route ' + route + ' failed the release encoding guard: ' + problems.join('; '));
}

// Negative control for hosts without a container. Run with --self-test.
function encodingSelfTest() {
	const corrupt = [
		['UTF-8 BOM', Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('<p>ok</p>')])],
		['C1 control', Buffer.from('<p>' + cp(0x0085) + '</p>')],
		['double encoding', Buffer.from('<p>' + cp(0x00e2, 0x20ac, 0x2122) + '</p>')],
		['invalid UTF-8', Buffer.from([0x3c, 0x70, 0x3e, 0xc3, 0x28])]
	];
	for (const [label, bytes] of corrupt) assert.ok(textEncodingProblems(bytes).length > 0, label + ' must be rejected by the encoding guard');
	assert.deepEqual(textEncodingProblems(Buffer.from('<!doctype html><p>caf' + cp(0x00e9) + '</p>')), []);
}
if (process.argv.includes('--self-test')) {
	encodingSelfTest();
	console.log('Container encoding guard self-test passed: BOM, C1 controls, double encoding and invalid UTF-8 are rejected.');
	process.exit(0);
}

// The setup API can answer while the packaged UI files are absent. Probe the real
// routes so a missing homelab/public bundle fails packaging instead of shipping.
async function assertSetupUiServed() {
	const page = await fetch(base + '/');
	if (page.status !== 200) throw Error('Setup page route / returned status ' + page.status);
	const pageType = page.headers.get('content-type') || '';
	if (!pageType.startsWith('text/html')) throw Error('Setup page route / returned content-type ' + (pageType || '(none)'));
	const pageBytes = Buffer.from(await page.arrayBuffer());
	assertEncoded('/', pageType, pageBytes);
	const html = pageBytes.toString('utf8');
	if (!html.includes('<title>Tellybox HomeLab')) throw Error('Setup page route / did not include the Tellybox HomeLab title');
	if (!html.includes('Setup')) throw Error('Setup page route / did not include the setup heading');
	const index = await fetch(base + '/index.html');
	if (index.status !== 200) throw Error('Setup entry route /index.html returned status ' + index.status);
	const indexType = index.headers.get('content-type') || '';
	if (!indexType.startsWith('text/html')) throw Error('Setup entry route /index.html returned content-type ' + (indexType || '(none)'));
	assertEncoded('/index.html', indexType, await index.arrayBuffer());
	for (const [route, expected] of [
		['/setup.js', 'javascript'], ['/setup.css', 'text/css'],
		['/service-location.mjs', 'javascript'], ['/notification-mode.mjs', 'javascript']
	]) {
		const asset = await fetch(base + route);
		if (asset.status !== 200) throw Error('Setup asset route ' + route + ' returned status ' + asset.status);
		const type = asset.headers.get('content-type') || '';
		if (!type.includes(expected)) throw Error('Setup asset route ' + route + ' returned content-type ' + (type || '(none)'));
		assertEncoded(route, type, await asset.arrayBuffer());
	}
	await assertPublicRootPages();
}

// The image has two public roots. server/homelab/public is the setup app above;
// server/public is the viewing app, behind its own auth gate. /coming-soon is
// the viewing page served before login, so it proves that root is shipped and
// clean without needing credentials.
async function assertPublicRootPages() {
	const page = await fetch(publicBase + '/coming-soon');
	if (page.status !== 200) throw Error('Viewing public page /coming-soon returned status ' + page.status);
	const type = page.headers.get('content-type') || '';
	if (!type.startsWith('text/html')) throw Error('Viewing public page /coming-soon returned content-type ' + (type || '(none)'));
	assertEncoded('/coming-soon (server/public)', type, await page.arrayBuffer());
}
assert.notEqual(docker(['exec', '-T', 'tellybox', 'id', '-u']).trim(), '0');
await assertSetupUiServed();
assert.equal((await request('config')).status, 401);
const bootstrap = JSON.parse(docker(['exec', '-T', 'tellybox', 'cat', '/config/bootstrap.json']));
const login = await request('login', { bootstrap: bootstrap.token, password: 'container-fixture-only-97531' });
assert.equal(login.status, 200);
const cookie = login.headers.get('set-cookie').split(';')[0];
const config = await (await request('config', null, cookie)).json();
assert.ok(Object.values(config.config.services).every(s => !s.enabled));
assert.equal(config.runtime.running, true);
assert.equal((await fetch('http://127.0.0.1:8082/health')).status, 200);
assert.equal((await request('relay')).status, 401);
assert.equal((await request('relay', null, cookie)).status, 200);
assert.equal((await request('apply', {revision:config.config.revision}, cookie)).status, 200);
docker(['restart', 'tellybox']);
for (let i = 0; i < 30; i++) {
	try { const s = await request('status'); if (s.ok) { assert.equal((await s.json()).claimed, true); break; } } catch { }
	if (i === 29) throw Error('Setup did not recover after restart');
	await new Promise(resolve => setTimeout(resolve, 1000));
}
const restored = await request('login', { password: 'container-fixture-only-97531' });
assert.equal(restored.status, 200);
await assertSetupUiServed();
console.log('Container: non-root, private setup, disabled services, explicit apply and persistent owner verified. Setup assets and both public roots are clean UTF-8 with charset=utf-8.');
