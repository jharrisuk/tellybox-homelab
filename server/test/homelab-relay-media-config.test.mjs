import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultConfig, validateConfig, redacted, capabilities } from '../homelab/config.mjs';
import { services } from '../homelab/services.mjs';

const network = () => { const c = defaultConfig(); c.network.publicOrigin = 'https://watch.example.com'; return c; };
test('exactly three user choices and no address entry for same-server or relay', () => {
	const spec = services.find(service => service.id === 'dispatcharr');
	assert.deepEqual(spec.locations, ['onThisServer', 'relay', 'anotherServer']);
	assert.equal(spec.fields.find(field => field.key === 'url').required, false);
	const local = network(); local.services.dispatcharr = { enabled: true, location: 'onThisServer', key: 'catalogue-key', live: true };
	const checked = validateConfig(local).services.dispatcharr;
	assert.equal(checked.location, 'onThisServer'); assert.equal(checked.execution, 'main'); assert.equal(checked.onThisServer, true);
	assert.equal(checked.url, 'http://host.docker.internal:9191');
});
test('old same-server and off-server configurations keep main execution and manual URL', () => {
	const same = network(); same.services.dispatcharr = { enabled: true, onThisServer: true, live: true, key: 'k' };
	const a = validateConfig(same).services.dispatcharr;
	assert.equal(a.location, 'onThisServer'); assert.equal(a.execution, 'main'); assert.equal(a.onThisServer, true);
	const manual = network(); manual.services.dispatcharr = { enabled: true, onThisServer: false, url: 'http://old.example.test:9191', key: 'k', live: true };
	const b = validateConfig(manual).services.dispatcharr;
	assert.equal(b.location, 'anotherServer'); assert.equal(b.execution, 'main'); assert.equal(b.onThisServer, false);
	assert.equal(b.url, 'http://old.example.test:9191'); assert.equal(b.manualUrl, 'http://old.example.test:9191');
});
test('On relay stores explicit private metadata/worker addresses and execution relay', () => {
	const c = network();
	c.services.dispatcharr = { enabled: true, location: 'relay', key: 'catalogue-key', relayKey: 'worker-key', live: true, vod: true,
		relayMetadataUrl: 'http://relay.example.test:9191', relayUrl: 'http://host.containers.internal:9192' };
	const checked = validateConfig(c), d = checked.services.dispatcharr;
	assert.equal(d.location, 'relay'); assert.equal(d.execution, 'relay'); assert.equal(d.onThisServer, false);
	assert.equal(d.url, 'http://relay.example.test:9191');
	assert.equal(d.relayUrl, 'http://host.containers.internal:9192');
	const generic = network(); generic.services.dispatcharr = { enabled: true, location: 'relay', live: true, key: 'k', relayMetadataUrl: 'http://relay.example.test:9191' };
	assert.equal(validateConfig(generic).services.dispatcharr.relayUrl, 'http://host.containers.internal:9191');
	assert.equal(capabilities(checked).relayMedia, true);
	const safe = redacted(checked);
	assert.equal(safe.services.dispatcharr.relayKey, undefined); assert.equal(safe.services.dispatcharr.relayKeySaved, true);
	assert.equal(JSON.stringify(safe).includes('worker-key'), false);
});
test('relay needs the checked relay metadata address and a public HTTPS origin', () => {
	const c = defaultConfig(); c.services.dispatcharr = { enabled: true, location: 'relay', live: true, key: 'k' };
	assert.throws(() => validateConfig(c), /checked relay metadata|public HTTPS/);
	const d = network(); d.services.dispatcharr = { enabled: true, location: 'relay', live: true, key: 'k' };
	assert.throws(() => validateConfig(d), /checked relay metadata/);
	const e = network(); e.services.dispatcharr = { enabled: true, location: 'relay', live: true, key: 'k', relayMetadataUrl: 'http://relay.example.test:9191' };
	assert.equal(validateConfig(e).services.dispatcharr.execution, 'relay');
});
test('Another server requires its own explicit URL and cannot select relay execution', () => {
	const c = network(); c.services.dispatcharr = { enabled: true, location: 'anotherServer', live: true, key: 'k' };
	assert.throws(() => validateConfig(c), /server address/);
	c.services.dispatcharr.url = 'https://other.example.test:9191';
	const checked = validateConfig(c).services.dispatcharr;
	assert.equal(checked.execution, 'main'); assert.equal(checked.location, 'anotherServer');
	c.services.dispatcharr.execution = 'relay';
	assert.equal(validateConfig(c).services.dispatcharr.execution, 'main');
});
