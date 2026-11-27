import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import vm from 'node:vm';
import { installAuth } from '../auth.mjs';
import { createActivity } from '../activity.mjs';
import { createAccountLimits } from '../account-limits.mjs';

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_PATTERN = new RegExp('^[' + CODE_ALPHABET + ']{8}$');
const TV_ID = '12345678-1234-4234-8234-123456789abc';
const PHONE_ID = '22345678-1234-4234-8234-123456789abc';
const TV2_ID = '32345678-1234-4234-8234-123456789abc';
const OVER_TV = 'This account already has 1 of 1 TV. Remove one in Settings > People.';
const OVER_PHONE = 'This account already has 1 of 1 phone. Remove one in Settings > People.';

async function fixture(t, extra = {}, existingDirectory) {
	const directory = existingDirectory || mkdtempSync(path.join(tmpdir(), 'tellybox-q70-'));
	if (!existingDirectory) t.after(() => rmSync(directory, { recursive: true, force: true }));
	const app = express(); app.use(express.json());
	const local = await new Promise(resolve => { const server = app.listen(0, '127.0.0.1', () => resolve(server)); });
	const remote = await new Promise(resolve => { const server = app.listen(0, '127.0.0.1', () => resolve(server)); });
	t.after(() => { local.closeAllConnections(); remote.closeAllConnections(); local.close(); remote.close(); });
	const audit = createActivity(directory);
	let mail;
	let linkNow = Date.now();
	let signIp = 0;
	const accountLimits = createAccountLimits(directory);
	const access = installAuth(app, {
		directory, audit, accountLimits, trustedProxies: ['127.0.0.1'],
		publicOrigin: 'https://127.0.0.1:' + remote.address().port,
		publicDirectory: path.resolve('public'), localPort: local.address().port,
		localHosts: ['127.0.0.1'], localNetworks: ['127.0.0.0/8'],
		emailDelivery: async value => { mail = value; }, linkClock: () => linkNow, ...extra
	});
	app.get('/api/items', (req, res) => res.json({ owner: req.jserverOwner, personId: req.jserverViewer?.personId || null }));
	const base = side => `http://127.0.0.1:${(side === 'local' ? local : remote).address().port}`;
	const call = (side, route, body, token, headers = {}) => fetch(base(side) + route, {
		method: body ? 'POST' : 'GET', redirect: 'manual',
		headers: {
			...(body ? { 'Content-Type': 'application/json', Origin: base(side) } : {}),
			...(token ? { Authorization: 'Bearer ' + token } : {}),
			...(side === 'remote' ? { 'X-Forwarded-Proto': 'https', Origin: 'https://127.0.0.1:' + remote.address().port } : {}),
			...headers
		},
		body: body ? JSON.stringify(body) : undefined
	});
	const json = async response => ({ status: response.status, body: await response.json().catch(() => ({})) });
	async function enableEmail() {
		await call('local', '/api/auth/email/config', { enabled: true, key: 're_fixture_only_123456', from: 'watch@example.test' });
	}
	async function signIn(email) {
		// Each account signs in from its own viewer address so the shared fixture
		// peer never trips the sign-in IP protection.
		const headers = { 'CF-Connecting-IP': '203.0.113.' + (++signIp) };
		await call('remote', '/api/auth/email/code', { email }, undefined, headers);
		const person = (await (await call('local', '/api/people')).json()).people.find(p => p.email === email);
		await call('local', '/api/people', { id: person.id, action: 'approve' });
		const challenge = await (await call('remote', '/api/auth/email/code', { email }, undefined, headers)).json();
		const verified = await call('remote', '/api/auth/email/verify', { ...challenge, code: mail.code, remember: true }, undefined, headers);
		return { person, cookie: verified.headers.get('set-cookie').split(';')[0] };
	}
	const start = (deviceId, platform, name, headers) => call('local', '/api/link/start', { deviceId, platform, name }, undefined, headers);
	const status = deviceId => call('remote', '/api/link/status?deviceId=' + deviceId);
	const claim = (code, cookie, personId) => call('remote', '/api/people/link-code', personId ? { code, personId } : { code }, undefined, cookie ? { Cookie: cookie } : {});
	return { directory, audit, access, accountLimits, call, json, base, enableEmail, signIn, start, status, claim, advanceLinkClock: ms => { linkNow += ms; }, linkNow: () => linkNow };
}

test('link code happy path: start, pending status, claim by the account holder, credential works, privacy holds', async t => {
	const f = await fixture(t);
	await f.enableEmail();
	const { person, cookie } = await f.signIn('viewer@example.test');
	const started = await f.json(await f.start(TV_ID, 'tv', 'Living room TV'));
	assert.equal(started.status, 200);
	assert.match(started.body.code, CODE_PATTERN);
	assert.equal(started.body.expiresIn, 600);
	assert.equal(started.body.platform, 'tv');
	assert.ok(started.body.expiresAt > f.linkNow());
	// Nothing is approved yet: the device id alone grants no playback.
	assert.equal((await f.call('remote', '/api/items', undefined, undefined, { 'X-Tellybox-Device-Id': TV_ID })).status, 401);
	const pending = await f.json(await f.status(TV_ID));
	assert.equal(pending.status, 200);
	assert.equal(pending.body.status, 'pending');
	assert.equal(pending.body.platform, 'tv');
	assert.ok(!JSON.stringify(pending.body).includes(started.body.code), 'status never returns the code');
	// Unauthenticated claim is refused; so is a viewer app bearer.
	assert.equal((await f.claim(started.body.code)).status, 403);
	const claimed = await f.json(await f.claim(started.body.code, cookie));
	assert.equal(claimed.status, 200);
	assert.equal(claimed.body.ok, true);
	assert.equal(claimed.body.device.platform, 'tv');
	assert.equal(claimed.body.device.personId, person.id);
	assert.deepEqual(claimed.body.allowances, { phone: { used: 0, limit: 1 }, tv: { used: 1, limit: 1 } });
	const approved = await f.json(await f.status(TV_ID));
	assert.equal(approved.status, 200);
	assert.equal(approved.body.status, 'approved');
	assert.match(approved.body.token, /^[a-f0-9]{64}$/);
	assert.equal(approved.body.personId, person.id);
	// The credential the app expects now works, and only for the linked account.
	const items = await f.json(await f.call('remote', '/api/items', undefined, approved.body.token));
	assert.equal(items.status, 200);
	assert.equal(items.body.personId, person.id);
	const me = await f.json(await f.call('remote', '/api/people/me', undefined, undefined, { Cookie: cookie }));
	assert.equal(me.status, 200);
	assert.equal(me.body.person.email, 'viewer@example.test');
	assert.equal(me.body.devices.length, 1);
	assert.equal(me.body.devices[0].platform, 'tv');
	assert.deepEqual(me.body.allowances.tv, { used: 1, limit: 1 });
	// The code and the credential never reach the audit log or the link store.
	const snapshot = JSON.stringify(f.audit.snapshot());
	assert.ok(!snapshot.includes(started.body.code));
	assert.ok(!snapshot.includes(approved.body.token));
	assert.ok(snapshot.includes('device_linked'));
	const linkFile = readFileSync(path.join(f.directory, 'device-links.json'), 'utf8');
	assert.ok(!linkFile.includes(started.body.code));
	assert.ok(!linkFile.includes(approved.body.token), 'the credential escrow is memory only');
	const appsFile = readFileSync(path.join(f.directory, 'apps.json'), 'utf8');
	assert.ok(!appsFile.includes(approved.body.token));
});

test('the platform the app already reports is recorded at enrolment and at link start', async t => {
	const f = await fixture(t);
	await f.enableEmail();
	const { cookie } = await f.signIn('viewer@example.test');
	const enrolled = await f.json(await f.call('local', '/api/apps/enroll', { name: 'Reported TV' }, undefined, { 'X-Tellybox-Device-Id': TV_ID, 'X-Tellybox-Client': 'android-tv', 'X-jServer-App': 'android' }));
	assert.equal(enrolled.status, 201);
	assert.equal(enrolled.body.platform, 'tv');
	const phone = await f.json(await f.call('local', '/api/apps/enroll', { name: 'Reported phone' }, undefined, { 'X-Tellybox-Device-Id': PHONE_ID, 'X-Tellybox-Client': 'android-phone', 'X-jServer-App': 'android' }));
	assert.equal(phone.body.platform, 'phone');
	// A legacy TV user-agent without the header still derives tv.
	const legacy = await f.json(await f.call('local', '/api/apps/enroll', { name: 'Legacy TV' }, undefined, { 'User-Agent': 'BeyondTV/1.0 (Android TV)' }));
	assert.equal(legacy.body.platform, 'tv');
	// link/start accepts the declared header instead of an explicit body platform.
	const started = await f.json(await f.start(PHONE_ID, undefined, 'Kitchen phone', { 'X-Tellybox-Client': 'android-phone' }));
	assert.equal(started.status, 200);
	assert.equal(started.body.platform, 'phone');
	assert.equal((await f.json(await f.claim(started.body.code, cookie))).status, 200);
	// Without either signal the request is refused rather than guessed.
	assert.equal((await f.start(TV2_ID, undefined, 'No platform')).status, 400);
	assert.equal((await f.start(TV2_ID, 'tablet', 'Bad platform')).status, 400);
	assert.equal((await f.start('not-a-uuid', 'tv', 'Bad id')).status, 400);
	assert.equal((await f.start(TV2_ID, 'tv', 'x')).status, 400);
});

test('expired codes are refused and report expired; reuse is refused; another account cannot take a linked device', async t => {
	const f = await fixture(t);
	await f.enableEmail();
	const alice = await f.signIn('alice@example.test');
	const bob = await f.signIn('bob@example.test');
	// Expired code.
	const first = await f.json(await f.start(TV_ID, 'tv', 'Old TV'));
	f.advanceLinkClock(11 * 60000);
	const expiredClaim = await f.json(await f.claim(first.body.code, alice.cookie));
	assert.equal(expiredClaim.status, 401);
	assert.equal(expiredClaim.body.error, 'That code has expired. Request another.');
	assert.equal((await f.json(await f.status(TV_ID))).body.status, 'expired');
	// Fresh code, single use.
	const second = await f.json(await f.start(TV_ID, 'tv', 'Living room TV'));
	assert.equal((await f.json(await f.claim(second.body.code, alice.cookie))).status, 200);
	const reuse = await f.json(await f.claim(second.body.code, alice.cookie));
	assert.equal(reuse.status, 401);
	assert.equal(reuse.body.error, 'That code has already been used. Request another.');
	// A different account cannot reuse the code either.
	assert.equal((await f.json(await f.claim(second.body.code, bob.cookie))).status, 401);
	// Nor can it claim a new code for a device already linked to Alice.
	const third = await f.json(await f.start(TV_ID, 'tv', 'Living room TV'));
	const takeover = await f.json(await f.claim(third.body.code, bob.cookie));
	assert.equal(takeover.status, 409);
	assert.equal(takeover.body.error, 'This device is already linked to another account.');
	// Wrong codes never match, and malformed input is refused uniformly.
	assert.equal((await f.json(await f.claim('AAAAAAAA', alice.cookie))).status, 401);
	assert.equal((await f.json(await f.claim('short', alice.cookie))).status, 401);
	assert.equal((await f.json(await f.status('bad-id'))).status, 400);
	assert.equal((await f.json(await f.status(TV2_ID))).status, 404);
});

test('over the platform allowance the claim returns the exact 409 wording, and removing a device frees the slot', async t => {
	const f = await fixture(t);
	await f.enableEmail();
	const { person, cookie } = await f.signIn('viewer@example.test');
	const tv1 = await f.json(await f.start(TV_ID, 'tv', 'Living room TV'));
	assert.equal((await f.json(await f.claim(tv1.body.code, cookie))).status, 200);
	const tv2 = await f.json(await f.start(TV2_ID, 'tv', 'Bedroom TV'));
	const over = await f.json(await f.claim(tv2.body.code, cookie));
	assert.equal(over.status, 409);
	assert.equal(over.body.error, OVER_TV);
	// The refused claim did not consume the code: after removal it still works.
	const me = await f.json(await f.call('remote', '/api/people/me', undefined, undefined, { Cookie: cookie }));
	const deviceId = me.body.devices.find(d => d.name === 'Living room TV').id;
	// Another account cannot remove a device it does not own.
	const bob = await f.signIn('bob@example.test');
	assert.equal((await f.call('remote', '/api/people/me/devices', { deviceId, action: 'remove' }, undefined, { Cookie: bob.cookie })).status, 404);
	const removed = await f.json(await f.call('remote', '/api/people/me/devices', { deviceId, action: 'remove' }, undefined, { Cookie: cookie }));
	assert.equal(removed.status, 200);
	assert.deepEqual(removed.body.allowances.tv, { used: 0, limit: 1 });
	const retried = await f.json(await f.claim(tv2.body.code, cookie));
	assert.equal(retried.status, 200);
	assert.equal(retried.body.device.name, 'Bedroom TV');
	assert.deepEqual(retried.body.allowances.tv, { used: 1, limit: 1 });
	// Phone allowance is separate, with its own wording.
	const phone1 = await f.json(await f.start(PHONE_ID, 'phone', 'My phone'));
	assert.equal((await f.json(await f.claim(phone1.body.code, cookie))).status, 200);
	const phone2 = await f.json(await f.start('42345678-1234-4234-8234-123456789abc', 'phone', 'Second phone'));
	const overPhone = await f.json(await f.claim(phone2.body.code, cookie));
	assert.equal(overPhone.status, 409);
	assert.equal(overPhone.body.error, OVER_PHONE);
	// The admin unlink fallback frees a slot too.
	const directory = await (await f.call('local', '/api/people')).json();
	const phoneDeviceId = directory.apps.find(d => d.name === 'My phone').id;
	assert.equal((await f.call('local', '/api/people', { action: 'unlink', deviceId: phoneDeviceId })).status, 200);
	assert.equal((await f.json(await f.claim(phone2.body.code, cookie))).status, 200);
});

test('start and claim are rate limited by IP, and start is limited per device', async t => {
	const f = await fixture(t);
	await f.enableEmail();
	const { cookie } = await f.signIn('viewer@example.test');
	// Ten different devices from one IP are allowed; the eleventh is throttled.
	for (let i = 0; i < 10; i++) assert.equal((await f.start('aaaaaaaa-1234-4234-8234-' + String(i).padStart(12, '0'), 'tv', 'TV ' + i)).status, 200);
	assert.equal((await f.start(TV_ID, 'tv', 'One too many')).status, 429);
	// Claim attempts are bounded too: ten wrong codes, then throttled.
	for (let i = 0; i < 10; i++) assert.equal((await f.claim('AAAAAA' + CODE_ALPHABET[i % CODE_ALPHABET.length] + 'A', cookie)).status, 401);
	assert.equal((await f.claim('BBBBBBBB', cookie)).status, 429);
});

test('a device-scoped start limit applies even under the IP budget', async t => {
	const f = await fixture(t);
	// Five starts for one device are allowed; the sixth is throttled while the
	// IP budget still has room (a different device can start).
	for (let i = 0; i < 5; i++) assert.equal((await f.start(TV_ID, 'tv', 'TV ' + i)).status, 200);
	assert.equal((await f.start(TV_ID, 'tv', 'Sixth')).status, 429);
	assert.equal((await f.start(PHONE_ID, 'phone', 'Phone')).status, 200);
});

test('a pending enrolment is approved by the claim, the old credential is rotated, and revoked devices fail closed', async t => {
	const f = await fixture(t);
	await f.enableEmail();
	const { cookie } = await f.signIn('viewer@example.test');
	const enrolled = await f.json(await f.call('remote', '/api/apps/enroll', { name: 'Pending TV' }, undefined, { 'X-Tellybox-Device-Id': TV_ID }));
	assert.equal(enrolled.status, 201);
	assert.equal(enrolled.body.status, 'pending');
	// Pending devices get no playback.
	assert.equal((await f.call('remote', '/api/items', undefined, enrolled.body.token)).status, 401);
	const started = await f.json(await f.start(TV_ID, 'tv', 'Pending TV'));
	assert.equal((await f.json(await f.claim(started.body.code, cookie))).status, 200);
	const approved = await f.json(await f.status(TV_ID));
	assert.equal(approved.body.status, 'approved');
	assert.notEqual(approved.body.token, enrolled.body.token);
	assert.equal((await f.call('remote', '/api/items', undefined, enrolled.body.token)).status, 401, 'the enrolment credential is rotated at claim');
	assert.equal((await f.call('remote', '/api/items', undefined, approved.body.token)).status, 200);
	// Revoked tombstones cannot be resurrected through the link flow.
	await f.call('local', '/api/apps/' + approved.body.id, { action: 'revoke' });
	const again = await f.json(await f.start(TV_ID, 'tv', 'Pending TV'));
	assert.equal(again.status, 403);
	assert.equal(again.body.error, 'This device access was revoked or expired. Ask an administrator to review it.');
});

test('the approval code shown by a pending app links from the account page and keeps its device token', async t => {
	const f = await fixture(t);
	await f.enableEmail();
	const { person, cookie } = await f.signIn('viewer@example.test');
	const enrolled = await f.json(await f.call('remote', '/api/apps/enroll', { name: 'Sitting room TV' }, undefined, { 'X-Tellybox-Device-Id': TV_ID, 'X-Tellybox-Client': 'android-tv' }));
	assert.equal(enrolled.status, 201);
	assert.equal(enrolled.body.status, 'pending');
	// Approval codes are hex and may contain 0 or 1, unlike Q70 link codes.
	const file = path.join(f.directory, 'apps.json');
	const entries = JSON.parse(readFileSync(file, 'utf8'));
	for (const record of Object.values(entries)) if (record.id === enrolled.body.id) record.code = 'A10B2C3D';
	writeFileSync(file, JSON.stringify(entries));
	const claimed = await f.json(await f.claim('A10B2C3D', cookie));
	assert.equal(claimed.status, 200);
	assert.equal(claimed.body.device.personId, person.id);
	assert.equal(claimed.body.device.platform, 'tv');
	assert.deepEqual(claimed.body.allowances.tv, { used: 1, limit: 1 });
	const me = await f.json(await f.call('remote', '/api/apps/me', undefined, enrolled.body.token, { 'X-Tellybox-Device-Id': TV_ID }));
	assert.equal(me.status, 200);
	assert.equal(me.body.status, 'approved');
	assert.equal(me.body.personId, person.id);
	assert.equal((await f.call('remote', '/api/items', undefined, enrolled.body.token)).status, 200, 'the device keeps the token it was already polling with');
	assert.equal((await f.json(await f.claim('A10B2C3D', cookie))).status, 401, 'the code is single use');
	// The allowance is enforced before the second TV is approved.
	const second = await f.json(await f.call('remote', '/api/apps/enroll', { name: 'Bedroom TV' }, undefined, { 'X-Tellybox-Device-Id': TV2_ID, 'X-Tellybox-Client': 'android-tv' }));
	const secondEntries = JSON.parse(readFileSync(file, 'utf8'));
	for (const record of Object.values(secondEntries)) if (record.id === second.body.id) record.code = 'B20C3D4E';
	writeFileSync(file, JSON.stringify(secondEntries));
	const blocked = await f.json(await f.claim('B20C3D4E', cookie));
	assert.equal(blocked.status, 409);
	assert.equal(blocked.body.error, OVER_TV);
	assert.equal((await f.json(await f.call('remote', '/api/apps/me', undefined, second.body.token, { 'X-Tellybox-Device-Id': TV2_ID }))).body.status, 'pending');
});

test('expired access is unlinked before the same identity can request again', async t => {
	const f = await fixture(t);
	await f.enableEmail();
	const { person, cookie } = await f.signIn('viewer@example.test');
	const enrolled = await f.json(await f.call('local', '/api/apps/enroll', { name: 'Living room TV' }, undefined, { 'X-Tellybox-Device-Id': TV_ID, 'X-Tellybox-Client': 'android-tv' }));
	assert.equal(enrolled.body.status, 'approved');
	assert.equal((await f.call('local', '/api/people', { action: 'device', id: person.id, deviceId: enrolled.body.id })).status, 200);
	const before = await f.json(await f.call('remote', '/api/people/me', undefined, undefined, { Cookie: cookie }));
	assert.equal(before.body.devices.length, 1);
	const file = path.join(f.directory, 'apps.json'), entries = JSON.parse(readFileSync(file, 'utf8'));
	for (const record of Object.values(entries)) if (record.id === enrolled.body.id) record.expires = Date.now() - 1;
	writeFileSync(file, JSON.stringify(entries));
	const recovered = await f.json(await f.call('remote', '/api/apps/enroll', { name: 'Living room TV' }, undefined, { 'X-Tellybox-Device-Id': TV_ID, 'X-Tellybox-Client': 'android-tv' }));
	assert.equal(recovered.status, 201);
	assert.equal(recovered.body.status, 'pending');
	assert.notEqual(recovered.body.token, enrolled.body.token);
	const after = await f.json(await f.call('remote', '/api/people/me', undefined, undefined, { Cookie: cookie }));
	assert.equal(after.body.devices.length, 0, 'an expired access loses its stale account binding');
	// The original owner can still claim the fresh request and link it again.
	const claimed = await f.json(await f.claim(recovered.body.code, cookie));
	assert.equal(claimed.status, 200);
	assert.equal(claimed.body.device.personId, person.id);
});

test('admin manual link stays the fallback, obeys the same allowance, and the allowance is configurable', async t => {
	const f = await fixture(t);
	await f.enableEmail();
	const { person, cookie } = await f.signIn('viewer@example.test');
	const tv1 = await f.json(await f.call('local', '/api/apps/enroll', { name: 'TV one' }, undefined, { 'X-Tellybox-Device-Id': TV_ID, 'X-Tellybox-Client': 'android-tv' }));
	const tv2 = await f.json(await f.call('local', '/api/apps/enroll', { name: 'TV two' }, undefined, { 'X-Tellybox-Device-Id': TV2_ID, 'X-Tellybox-Client': 'android-tv' }));
	assert.equal((await f.call('local', '/api/people', { action: 'device', id: person.id, deviceId: tv1.body.id })).status, 200);
	const blocked = await f.json(await f.call('local', '/api/people', { action: 'device', id: person.id, deviceId: tv2.body.id }));
	assert.equal(blocked.status, 409);
	assert.equal(blocked.body.error, OVER_TV);
	// The admin raises the TV allowance, then the manual link succeeds.
	const limits = await f.json(await f.call('local', '/api/account-limits/person:' + person.id, { minutes: 0, downloads: true, maxTvs: 2, maxPhones: 1 }));
	assert.equal(limits.status, 200);
	assert.equal(limits.body.maxTvs, 2);
	assert.equal((await f.call('local', '/api/people', { action: 'device', id: person.id, deviceId: tv2.body.id })).status, 200);
	// Validation and the admin platform action for older apps.
	assert.equal((await f.call('local', '/api/account-limits/person:' + person.id, { minutes: 0, downloads: true, maxTvs: 9 })).status, 400);
	assert.equal((await f.call('local', '/api/account-limits/person:' + person.id, { minutes: 0, downloads: true, maxPhones: -1 })).status, 400);
	const legacy = await f.json(await f.call('local', '/api/apps/enroll', { name: 'Legacy box' }));
	assert.equal(legacy.body.platform, undefined);
	assert.equal((await f.call('local', '/api/apps/' + legacy.body.id, { action: 'platform', platform: 'tablet' })).status, 400);
	const set = await f.json(await f.call('local', '/api/apps/' + legacy.body.id, { action: 'platform', platform: 'tv' }));
	assert.equal(set.body.platform, 'tv');
	// Now the legacy device counts against the (raised) TV allowance: 2 of 2.
	const me = await f.json(await f.call('remote', '/api/people/me', undefined, undefined, { Cookie: cookie }));
	assert.deepEqual(me.body.allowances.tv, { used: 2, limit: 2 });
	// An administrator can also claim a code on behalf of an account.
	const phone = await f.json(await f.start(PHONE_ID, 'phone', 'Admin linked phone'));
	const adminClaim = await f.json(await f.call('local', '/api/people/link-code', { code: phone.body.code, personId: person.id }));
	assert.equal(adminClaim.status, 200);
	assert.equal(adminClaim.body.device.personId, person.id);
	// Without an account choice the admin claim is refused; viewers cannot claim.
	assert.equal((await f.call('local', '/api/people/link-code', { code: 'BBBBBBBB' })).status, 400);
	assert.equal((await f.call('remote', '/api/people/link-code', { code: 'BBBBBBBB' }, undefined, { Authorization: 'Bearer ' + tv1.body.token })).status, 403);
});

test('the account view payloads agree: allowances, limits and live usage come from the same stores', async t => {
	const f = await fixture(t);
	await f.enableEmail();
	const { person, cookie } = await f.signIn('viewer@example.test');
	const tv = await f.json(await f.start(TV_ID, 'tv', 'Living room TV'));
	await f.claim(tv.body.code, cookie);
	await f.call('local', '/api/account-limits/person:' + person.id, { minutes: 0, downloads: true, dailyMinutes: 120, maxSessions: 2, maxPhones: 2, maxTvs: 1 });
	// Charge 80 minutes of today's window through the real account-limits clock.
	f.accountLimits.media('fixture-session', { personId: person.id });
	const me = await f.json(await f.call('remote', '/api/people/me', undefined, undefined, { Cookie: cookie }));
	const limits = await f.json(await f.call('local', '/api/account-limits/person:' + person.id));
	const directory = await (await f.call('local', '/api/people')).json();
	assert.equal(me.status, 200);
	assert.equal(me.body.limits.dailyMinutes, limits.body.dailyMinutes);
	assert.equal(me.body.limits.dailySeconds, limits.body.dailySeconds);
	assert.equal(me.body.limits.maxSessions, limits.body.maxSessions);
	assert.equal(me.body.limits.maxPhones, limits.body.maxPhones);
	assert.equal(me.body.limits.maxTvs, limits.body.maxTvs);
	assert.equal(me.body.allowances.tv.used, directory.apps.filter(d => directory.devices[d.id] === person.id && d.platform === 'tv').length);
	assert.equal(me.body.allowances.phone.limit, 2);
	assert.equal(me.body.watchingNow, 0);
	// Signed-out and local browsers without an account see nothing.
	assert.equal((await f.call('remote', '/api/people/me')).status, 403);
	assert.equal((await f.call('local', '/api/people/me')).status, 403);
	assert.equal((await f.call('remote', '/api/people/me/devices', { deviceId: 'a'.repeat(32), action: 'remove' })).status, 403);
});

test('after a restart the credential escrow is gone and the device can link again', async t => {
	const f = await fixture(t);
	await f.enableEmail();
	const { cookie } = await f.signIn('viewer@example.test');
	const started = await f.json(await f.start(TV_ID, 'tv', 'Living room TV'));
	assert.equal((await f.json(await f.claim(started.body.code, cookie))).status, 200);
	const restarted = await fixture(t, {}, f.directory);
	const afterRestart = await f.json(await restarted.status(TV_ID));
	assert.equal(afterRestart.body.status, 'expired', 'no credential survives a restart');
	// The link itself persisted; a fresh code re-claims idempotently and issues a
	// working credential without needing a free slot.
	const again = await f.json(await restarted.start(TV_ID, 'tv', 'Living room TV'));
	assert.equal(again.status, 200);
	const reclaimed = await f.json(await restarted.claim(again.body.code, cookie));
	assert.equal(reclaimed.status, 200);
	const approved = await f.json(await restarted.status(TV_ID));
	assert.equal(approved.body.status, 'approved');
	assert.equal((await restarted.call('remote', '/api/items', undefined, approved.body.token)).status, 200);
});

// --- Manage-account UI: the rendered numbers must match the server payloads. ---

class FakeText {
	constructor(text) { this.text = String(text); }
	get textContent() { return this.text; }
}
function splitSelector(selector) {
	const parts = []; let current = '', depth = 0, quote = false;
	for (const ch of selector.trim()) {
		if (ch === '[') depth++;
		if (ch === ']') depth = Math.max(0, depth - 1);
		if (ch === '"') quote = !quote;
		if (/\s/.test(ch) && depth === 0 && !quote) { if (current) { parts.push(current); current = ''; } }
		else current += ch;
	}
	if (current) parts.push(current);
	return parts;
}
class FakeElement {
	constructor(tag) {
		this.tagName = String(tag || 'div').toUpperCase(); this.children = []; this.attributes = {}; this.style = {}; this.dataset = {};
		this.classList = { add() {}, remove() {}, toggle() {} }; this._text = ''; this.parent = null; this.hidden = false; this.disabled = false;
		this.value = ''; this.checked = false; this.required = false; this.type = ''; this.className = ''; this.id = ''; this.name = '';
		this.maxLength = 0; this.autocomplete = ''; this.listeners = {}; this.open = false; this.onclick = null; this.oninput = null; this.onchange = null; this.onsubmit = null;
	}
	get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
	set textContent(value) { this._text = String(value); this.children = []; }
	append(...items) { for (const item of items) { const node = typeof item === 'string' ? new FakeText(item) : item; if (node.parent) node.remove(); node.parent = this; this.children.push(node); } }
	prepend(...items) { for (const item of items.reverse()) { const node = typeof item === 'string' ? new FakeText(item) : item; if (node.parent) node.remove(); node.parent = this; this.children.unshift(node); } }
	replaceChildren(...items) { this.children = []; this._text = ''; this.append(...items); }
	remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); this.parent = null; }
	setAttribute(name, value) { this.attributes[name] = String(value); if (name === 'id') this.id = String(value); }
	getAttribute(name) { return this.attributes[name] ?? null; }
	addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
	dispatch(type) { for (const fn of this.listeners[type] || []) fn({ preventDefault() {} }); }
	showModal() { this.open = true; }
	close() { this.open = false; this.dispatch('close'); }
	reportValidity() { return true; }
	all() { const out = []; for (const child of this.children) { if (child instanceof FakeElement) { out.push(child, ...child.all()); } } return out; }
	matches(selector) {
		// Supports the selector forms these scripts use: #id, .class, tag,
		// [attr], [attr="value"], tag[attr], and one descendant combinator.
		const parts = splitSelector(selector);
		if (parts.length > 1) return false;
		const simple = parts[0];
		const match = /^([a-zA-Z]*)((?:[#.][\w-]+|\[[^\]]+\])*)$/.exec(simple);
		if (!match) return false;
		if (match[1] && this.tagName !== match[1].toUpperCase()) return false;
		for (const token of match[2].match(/[#.][\w-]+|\[[^\]]+\]/g) || []) {
			if (token[0] === '#') { if (this.id !== token.slice(1)) return false; }
			else if (token[0] === '.') { if (!this.className.split(/\s+/).includes(token.slice(1))) return false; }
			else {
				const attr = /^\[([\w-]+)(?:="([^"]*)")?\]$/.exec(token);
				if (!attr) return false;
				const value = attr[1] === 'data-access-search' ? this.dataset.accessSearch : this.attributes[attr[1]];
				if (attr[2] !== undefined) { if (value !== attr[2]) return false; }
				else if (value === undefined) return false;
			}
		}
		return true;
	}
	querySelectorAll(selector) {
		const parts = splitSelector(selector);
		if (parts.length === 1) return this.all().filter(node => node.matches(parts[0]));
		const out = [];
		for (const ancestor of this.all().filter(node => node.matches(parts[0]))) out.push(...ancestor.querySelectorAll(parts.slice(1).join(' ')));
		return out;
	}
	querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
	get elements() { const out = {}; for (const node of this.all()) if (node.name) out[node.name] = node; return out; }
}
function fakeSettingsDocument() {
	const body = new FakeElement('body');
	const add = (tag, id, className, parent = body) => { const node = new FakeElement(tag); if (id) node.id = id; if (className) node.className = className; parent.append(node); return node; };
	add('p', 'approvalSummary');
	for (const name of ['accounts', 'devices', 'browsers']) {
		const tab = add('button', null, 'chip'); tab.dataset.accessTab = name; add('span', null, 'access-count', tab);
		const panel = add('section', null, null); panel.dataset.accessPanel = name; add('p', null, 'access-empty', panel);
	}
	add('input', 'accessSearch'); add('select', 'accountStatus'); add('button', 'refreshPeople');
	add('div', 'webPeople'); add('div', 'homeBrowsers'); add('p', 'peopleMessage');
	const emailSettings = add('form', 'emailSettings');
	for (const name of ['from', 'key', 'enabled']) { const field = new FakeElement('input'); field.name = name; emailSettings.append(field); }
	add('button', null, null, emailSettings);
	add('p', 'emailMessage');
	return { body, add };
}
function uiContext(payloads, calls = []) {
	const { body } = fakeSettingsDocument();
	const document = {
		body, hidden: false, createElement: tag => new FakeElement(tag),
		querySelector: selector => body.querySelector(selector),
		querySelectorAll: selector => body.querySelectorAll(selector),
		addEventListener() {}
	};
	const respond = route => {
		const bodyMatch = /^\/api\/account-limits\/(.+)$/.exec(route);
		if (bodyMatch) return payloads.limits;
		if (route === '/api/people') return payloads.directory;
		if (route === '/api/activity') return payloads.activity;
		if (route === '/api/auth/email/config') return { enabled: true, configured: true, from: 'watch@example.test' };
		if (route === '/api/people/link-code') {
			if (payloads.linkError) throw new Error(payloads.linkError);
			return { ok: true, device: { name: 'New TV' }, allowances: payloads.directory.allowances || { phone: { used: 0, limit: 1 }, tv: { used: 1, limit: 1 } } };
		}
		throw new Error('Unexpected route ' + route);
	};
	const authRequest = async (route, requestBody) => { calls.push({ route, body: requestBody }); return respond(route); };
	const context = vm.createContext({
		document, authRequest, confirm: () => true, Option: class { constructor(label, value) { this.label = label; this.value = value; } },
		fetch: async route => ({ ok: true, json: async () => respond(route) }),
		setInterval: () => 0, clearInterval: () => {}, setTimeout: (fn) => { fn(); return 0; }, clearTimeout: () => {},
		URLSearchParams, console
	});
	vm.runInContext(readFileSync(new URL('../public/people-directory.js', import.meta.url), 'utf8'), context);
	vm.runInContext(readFileSync(new URL('../public/people.js', import.meta.url), 'utf8'), context);
	return { context, body, calls };
}
const PERSON_ID = 'a'.repeat(32);
function uiPayloads() {
	return {
		limits: { minutes: 0, seconds: 3600, downloads: true, dailyMinutes: 120, dailySeconds: 4800, day: '2026-11-21', maxSessions: 2, maxPhones: 2, maxTvs: 1, remainingMinutes: null, dailyRemainingMinutes: 40, reset: 'manual', dailyTimezone: 'Europe/London' },
		directory: {
			people: [{ id: PERSON_ID, email: 'viewer@example.test', name: 'viewer@example.test', status: 'approved' }],
			devices: { ['b'.repeat(32)]: PERSON_ID, ['c'.repeat(32)]: PERSON_ID },
			apps: [
				{ id: 'b'.repeat(32), name: 'Living room TV', status: 'approved', role: 'viewer', platform: 'tv' },
				{ id: 'c'.repeat(32), name: 'My phone', status: 'approved', role: 'viewer', platform: 'phone' }
			],
			browsers: [], localBrowsers: []
		},
		activity: { active: [{ id: 's1', personId: PERSON_ID, purpose: 'watch', local: false, home: false, state: 'playing' }], downloads: [], viewing: { users: [{ id: 'person:' + PERSON_ID, name: 'viewer@example.test', seconds: 3600, minutes: 60, dailySeconds: 4800, dailyLimitSeconds: 7200 }] } }
	};
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('manage-account dialog renders Screens / Time / Downloads with live numbers matching the payloads', async () => {
	const payloads = uiPayloads();
	const { context, body } = uiContext(payloads);
	await tick(); await tick();
	context.managePerson(payloads.directory.people[0]);
	await tick(); await tick(); await tick();
	const dialog = body.querySelector('dialog');
	assert.ok(dialog, 'the manage account dialog opens');
	const text = dialog.textContent;
	for (const group of ['Screens', 'Time', 'Downloads']) assert.ok(text.includes(group), 'group ' + group);
	assert.ok(text.includes('1 in use now'), 'live screens from /api/activity active');
	assert.ok(text.includes('1h 20m of 2h today'), '4800 dailySeconds of 120 dailyMinutes');
	assert.ok(text.includes('Phones 1 of 2 · TVs 1 of 1'), 'allowance counts and limits from the payloads');
	assert.ok(text.includes('0 downloading now'), 'live downloads from /api/activity');
	assert.ok(text.includes('1h since manual reset'), '3600 seconds since manual reset');
	assert.ok(text.includes('Living room TV · TV'), 'platform label on the linked device');
	assert.ok(text.includes('Link device'), 'the link code control is present');
	// The pure helpers agree with the payloads for edge values too.
	assert.equal(context.formatDuration(4800), '1h 20m');
	assert.equal(context.formatDuration(7200), '2h');
	assert.equal(context.formatDuration(20), '<1m');
	assert.equal(context.timeLiveText(4800, 120), '1h 20m of 2h today');
	assert.equal(context.timeLiveText(600, 0), '10m today · no daily limit');
	assert.equal(context.screensLiveText(1), '1 in use now');
	assert.equal(context.allowanceLine({ phone: { used: 1, limit: 0 }, tv: { used: 2, limit: 2 } }), 'Phones 1 of unlimited · TVs 2 of 2');
	assert.deepEqual(JSON.parse(JSON.stringify(context.accountLiveUsage(payloads.activity, 'person:' + PERSON_ID, ['b'.repeat(32)]))), { screens: 1, downloads: 0 });
	// Home playback is exempt and never counted against the screens line.
	const homeOnly = { active: [{ personId: PERSON_ID, purpose: 'watch', local: true, home: false }], downloads: [] };
	assert.deepEqual(JSON.parse(JSON.stringify(context.accountLiveUsage(homeOnly, 'person:' + PERSON_ID))), { screens: 0, downloads: 0 });
});

test('the manage-account link control claims the code for the account and surfaces the exact over-limit wording', async () => {
	const payloads = uiPayloads();
	const calls = [];
	const { context, body } = uiContext(payloads, calls);
	await tick(); await tick();
	context.managePerson(payloads.directory.people[0]);
	await tick(); await tick(); await tick();
	const dialog = body.querySelector('dialog');
	const input = dialog.querySelector('input[aria-label="Device code"]');
	assert.ok(input, 'code input present');
	input.value = 'ABCD2345';
	const buttons = dialog.querySelectorAll('button').filter(node => node.textContent === 'Link device');
	assert.equal(buttons.length, 1);
	buttons[0].onclick();
	await tick(); await tick(); await tick();
	const claimCall = calls.find(call => call.route === '/api/people/link-code');
	assert.deepEqual(JSON.parse(JSON.stringify(claimCall.body)), { code: 'ABCD2345', personId: PERSON_ID });
	assert.ok(dialog.textContent.includes('Linked New TV.'), 'success outcome is shown');
	// The server's 409 wording is shown verbatim.
	payloads.linkError = OVER_TV;
	input.value = 'ZZZZ2345';
	buttons[0].onclick();
	await tick(); await tick(); await tick();
	assert.ok(dialog.textContent.includes(OVER_TV), 'exact over-limit wording reaches the dialog');
});

test('the account holder page section is wired to /api/people/me and the link-code route only', () => {
	const html = readFileSync(new URL('../public/preferences.html', import.meta.url), 'utf8');
	assert.ok(html.includes('/account-devices.js'));
	assert.ok(html.includes('id="accountDevices"'));
	assert.ok(html.includes('id="linkDeviceCode"'));
	assert.ok(html.includes('Link device'));
	const source = readFileSync(new URL('../public/account-devices.js', import.meta.url), 'utf8');
	assert.ok(source.includes('/api/people/me'));
	assert.ok(source.includes('/api/people/link-code'));
	assert.ok(source.includes('/api/people/me/devices'));
	assert.ok(!source.includes('/api/people\''), 'never reads the admin directory');
	assert.ok(source.includes('Phones '));
	assert.ok(source.includes('TVs '));
	// No admin script is loaded by the viewer page.
	for (const admin of ['settings.js', 'people.js', 'apps.js', 'auth.js', 'people-directory.js']) assert.equal(html.includes(admin), false, admin);
});

test('re-linking a device as another platform cannot bypass the new platform allowance', async t => {
	const f = await fixture(t);
	await f.enableEmail();
	const { cookie } = await f.signIn('viewer@example.test');
	const tv = await f.json(await f.start(TV_ID, 'tv', 'Living room TV'));
	assert.equal((await f.json(await f.claim(tv.body.code, cookie))).status, 200);
	const phone = await f.json(await f.start(PHONE_ID, 'phone', 'Phone'));
	assert.equal((await f.json(await f.claim(phone.body.code, cookie))).status, 200);
	// The TV is already linked, but it is not counted against the phone
	// allowance. Moving it to phone must not steal a second phone slot.
	const moved = await f.json(await f.start(TV_ID, 'phone', 'TV pretending to be a phone'));
	const denied = await f.json(await f.claim(moved.body.code, cookie));
	assert.equal(denied.status, 409);
	assert.equal(denied.body.error, OVER_PHONE);
	// Re-linking in the same platform still fits, because the device is excluded
	// from its own platform count.
	const again = await f.json(await f.start(PHONE_ID, 'phone', 'Phone again'));
	assert.equal((await f.json(await f.claim(again.body.code, cookie))).status, 200);
});

test('unknown device status polls cannot knock out linking for everyone', { timeout: 90000 }, async t => {
	const f = await fixture(t);
	await f.enableEmail();
	await f.signIn('viewer@example.test');
	let rejected = 0;
	// 2,001 unique device ids across seven source addresses, under the per-IP
	// budget. Unknown ids must not create per-device throttle buckets; otherwise
	// the old global cap turned every later link request into a 429.
	for (let i = 0; i < 2001; i++) {
		const id = String(i).padStart(8, '0') + '-0000-4000-8000-' + String(i).padStart(12, '0');
		const response = await f.call('remote', '/api/link/status?deviceId=' + id, undefined, undefined, { 'CF-Connecting-IP': '198.51.100.' + (i % 7) });
		if (response.status === 404) rejected++;
	}
	assert.ok(rejected > 1500, 'unknown ids are rejected rather than accumulated: ' + rejected);
	const started = await f.json(await f.start(TV_ID, 'tv', 'After the flood'));
	assert.equal(started.status, 200, 'a real link still starts after the flood');
});

test('a claim made late in the code window still leaves time to collect the credential', async t => {
	const f = await fixture(t);
	await f.enableEmail();
	const { cookie } = await f.signIn('viewer@example.test');
	const started = await f.json(await f.start(TV_ID, 'tv', 'Late TV'));
	f.advanceLinkClock(9 * 60000);
	assert.equal((await f.json(await f.claim(started.body.code, cookie))).status, 200);
	// The ten-minute code window has now passed, but the pickup window starts at
	// the claim, not at the code.
	f.advanceLinkClock(2 * 60000);
	const collected = await f.json(await f.status(TV_ID));
	assert.equal(collected.status, 200);
	assert.equal(collected.body.status, 'approved');
	assert.match(collected.body.token, /^[a-f0-9]{64}$/);
});
