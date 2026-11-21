/* The declared app identity: one rule, one cross-origin guard, one fallback.
 * Every accepted declaration is paired with a non-vacuity assertion so a
 * permissive change cannot pass by labelling every request as an app. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { appMarkers, clientOf } from '../client-identity.mjs';

const DALVIK = 'Dalvik/2.1.0 (Linux; U; Android 17; SM-F966B)';
const CHROME = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/120 Mobile Safari';
const request = (headers = {}) => ({ get: name => headers[name.toLowerCase()] });
const phone = extra => ({
	host: 'jserver.test',
	'x-jserver-app': 'android',
	'x-tellybox-client': 'android-phone',
	'user-agent': DALVIK,
	...extra
});
const tv = extra => ({
	host: 'jserver.test',
	'x-jserver-app': 'android',
	'x-tellybox-client': 'android-tv',
	'user-agent': DALVIK,
	...extra
});

test('a cookie-authenticated same-origin phone declaration is android-phone', () => {
	const headers = phone({ cookie: 'jserver_session=fixture-cookie' });
	assert.equal(headers.authorization, undefined, 'this case must not rely on an Authorization header');
	assert.equal(clientOf(request(headers), { authenticated: true }), 'android-phone');
	// Non-vacuity: the same declaration without authentication is not an app.
	assert.equal(clientOf(request(headers), { authenticated: false }), 'web');
	assert.equal(clientOf(request(headers)), 'web', 'authentication must be explicit');
});

test('a bearer-authenticated same-origin TV declaration is android-tv', () => {
	const headers = tv({ authorization: 'Bearer ' + 'b'.repeat(64) });
	assert.equal(clientOf(request(headers), { authenticated: true }), 'android-tv');
	// Non-vacuity: trust without the declared kind falls back to the user agent.
	assert.equal(clientOf(request({ ...headers, 'x-tellybox-client': undefined }), { authenticated: true }), 'android-phone');
	// Non-vacuity: the declaration without authentication is web.
	assert.equal(clientOf(request(headers), { authenticated: false }), 'web');
});

test('an external Origin or Referer cannot borrow the app identity', () => {
	const headers = phone({ cookie: 'jserver_session=fixture-cookie' });
	const external = { origin: 'https://evil.example' };
	assert.equal(clientOf(request(phone({ ...external })), { authenticated: true }), 'web',
		'an external Origin is never an app, even with a native user agent');
	assert.equal(clientOf(request(phone({ referer: 'https://evil.example/watch' })), { authenticated: true }), 'web',
		'an external Referer is never an app');
	assert.equal(clientOf(request(phone({ origin: 'http://jserver.test', cookie: 'jserver_session=fixture-cookie' })), { authenticated: true }),
		'android-phone', 'the same origin is still accepted');
	assert.equal(clientOf(request(phone({ origin: 'http://127.0.0.1:8082' })), { authenticated: true }), 'web',
		'a different host on the same page is cross-origin');
});

test('a bare Authorization header is not an app declaration', () => {
	const bare = { host: 'jserver.test', authorization: 'Bearer ' + 'c'.repeat(64), 'user-agent': CHROME };
	assert.equal(clientOf(request(bare), { authenticated: true }), 'web');
	// Non-vacuity: adding both app markers is what makes it an app.
	assert.equal(clientOf(request({ ...tv(), authorization: bare.authorization }), { authenticated: true }), 'android-tv');
});

test('no markers keeps the legacy user-agent fallback and browser default', () => {
	assert.equal(clientOf(request({ host: 'jserver.test', 'user-agent': DALVIK })), 'android-phone');
	assert.equal(clientOf(request({ host: 'jserver.test', 'user-agent': CHROME })), 'web');
	assert.equal(clientOf(request({ host: 'jserver.test', 'user-agent': 'BeyondTV/1.0 Android 9' })), 'android-tv');
	assert.equal(clientOf(request({ host: 'jserver.test' })), 'web');
});

test('appMarkers records diagnosis only, never a header or credential', () => {
	assert.deepEqual(appMarkers(request(phone({ cookie: 'jserver_session=fixture-cookie' }))), { app: true, declared: 'android-phone' });
	assert.deepEqual(appMarkers(request(tv())), { app: true, declared: 'android-tv' });
	assert.deepEqual(appMarkers(request({ 'x-tellybox-client': 'android-tv' })), { app: false, declared: 'android-tv' });
	assert.deepEqual(appMarkers(request({ host: 'jserver.test', 'user-agent': CHROME })), { app: false });
	assert.deepEqual(appMarkers(request({ host: 'jserver.test', 'user-agent': DALVIK })), { app: false },
		'a legacy native agent without markers is still visibly unmarked');
	assert.deepEqual(appMarkers(request({ 'x-jserver-app': 'android', 'x-tellybox-client': 'smart-tv' })), { app: true });
	const serialized = JSON.stringify(appMarkers(request(tv({ authorization: 'Bearer ' + 'd'.repeat(64) }))));
	assert.equal(serialized.includes('Bearer'), false);
	assert.equal(serialized.includes('Dalvik'), false);
});
