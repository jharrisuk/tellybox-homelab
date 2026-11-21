import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { CLIENT_TYPES, clientOf, legacyClient, normalizeClient } from '../client-identity.mjs';

const request = (headers = {}) => ({ get: name => headers[name.toLowerCase()] });
const appHeaders = (value, agent = 'Dalvik/2.1.0 (Linux; U; Android 9; Pixel 4)') => ({ authorization: 'Bearer ' + 'a'.repeat(64), 'x-jserver-app': 'android', 'user-agent': agent, ...(value ? { 'x-tellybox-client': value } : {}) });

test('the client enum accepts only the explicit kinds', () => {
	assert.deepEqual([...CLIENT_TYPES], ['android-tv', 'android-phone', 'web', 'unknown']);
	assert.equal(normalizeClient('android-tv'), 'android-tv');
	assert.equal(normalizeClient(' Android-TV '), 'android-tv');
	assert.equal(normalizeClient('android-phone'), 'android-phone');
	assert.equal(normalizeClient('web'), 'web');
	assert.equal(normalizeClient('smart-tv'), '');
	assert.equal(normalizeClient('tv'), '');
	assert.equal(normalizeClient(''), '');
	assert.equal(normalizeClient(null), '');
});

test('legacy fallback needs a real app or TV marker and never assumes a phone', () => {
	assert.equal(legacyClient('Mozilla/5.0 (Linux; Android 9; Kitchen TV) BeyondTV/1.0'), 'android-tv');
	assert.equal(legacyClient('Mozilla/5.0 (Linux; Android 9) AndroidTV/1.0'), 'android-tv');
	assert.equal(legacyClient('Dalvik/2.1.0 (Linux; U; Android 9; Google TV)'), 'android-tv');
	assert.equal(legacyClient('Dalvik/2.1.0 (Linux; U; Android 9; Pixel 4)'), 'android-phone');
	assert.equal(legacyClient('okhttp/4.12.0'), 'android-phone');
	assert.equal(legacyClient('Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/120 Mobile Safari'), 'unknown');
	assert.equal(legacyClient(''), 'unknown');
});

test('browser bearer requests stay web and a declared app needs authentication', () => {
	const app = { authenticated: true };
	assert.equal(clientOf(request(appHeaders('android-tv')), app), 'android-tv');
	assert.equal(clientOf(request(appHeaders('android-phone')), app), 'android-phone');
	assert.equal(clientOf(request(appHeaders('bogus')), app), 'android-phone', 'invalid header falls back to the real app user agent');
	assert.equal(clientOf(request({ ...appHeaders('bogus'), 'user-agent': 'Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/120' }), app), 'unknown', 'a browser-looking app request is not assumed to be a phone');
	assert.equal(clientOf(request({ authorization: 'Bearer token' })), 'web', 'a bearer token alone is not an app marker');
	assert.equal(clientOf(request({ authorization: 'Bearer token', 'x-tellybox-client': 'android-tv' }), app), 'web');
	assert.equal(clientOf(request({ 'x-jserver-app': 'android', 'x-tellybox-client': 'android-tv' })), 'web', 'the app marker also needs credentials');
	assert.equal(clientOf(request({})), 'web');
	assert.equal(clientOf(request({ authorization: 'Bearer token', 'x-jserver-app': 'android', 'x-tellybox-client': 'web', 'user-agent': 'Mozilla/5.0' }), app), 'unknown');
});

test('the Activity renderer separates the Android app from an Android browser', () => {
	const context = { document: { createElement: () => ({ append() {}, setAttribute() {}, style: {} }) } };
	vm.runInNewContext(readFileSync(new URL('../public/activity-summary.js', import.meta.url), 'utf8'), context);
	const lib = context.TellyboxActivitySummary;
	const tv = lib.deviceOf({ client: 'android-tv', browser: 'Dalvik/2.1.0 (Linux; U; Android 9; Kitchen TV) BeyondTV' });
	assert.equal(tv.key, 'tv');
	assert.equal(tv.label, 'Android TV');
	const phone = lib.deviceOf({ client: 'android-phone', browser: 'Dalvik/2.1.0 (Linux; U; Android 9; Pixel 4)' });
	assert.equal(phone.key, 'android');
	assert.equal(phone.label, 'Android app');
	const browser = lib.deviceOf({ client: 'web', browser: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/120 Mobile Safari' });
	assert.equal(browser.key, 'android');
	assert.equal(browser.label, 'Android browser');
	const webDalvik = lib.deviceOf({ client: 'web', browser: 'Dalvik/2.1.0 (Linux; U; Android 9; Pixel 4)' });
	assert.equal(webDalvik.label, 'Android browser', 'a web request stays a browser even with a native-looking agent');
	const web = lib.deviceOf({ client: 'web', browser: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' });
	assert.equal(web.key, 'desktop');
	const legacyTv = lib.deviceOf({ browser: 'Mozilla/5.0 (Linux; Android 9; Kitchen TV) BeyondTV/1.0' });
	assert.equal(legacyTv.key, 'tv', 'legacy events still recognise BeyondTV');
	const friendly = lib.deviceOf({ deviceName: 'Kitchen TV', browser: 'Dalvik/2.1.0 (Linux; U; Android 9)' });
	assert.equal(friendly.label, 'Android app', 'a legacy native app is not a TV and the name is ignored');
	assert.equal(lib.deviceOf({ client: 'unknown', browser: 'Mozilla/5.0 (Linux; Android 14) Chrome/120' }).label, 'Android browser');
});
