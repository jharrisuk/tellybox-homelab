import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { contentSecurityPolicy, normalizeAssetOrigin, normalizeRelayOrigin } from '../csp.mjs';

const localOrigin = 'http://192.168.1.50:8082';
const relayOrigin = 'https://watch.example.test';

// The Home pre-paint bootstrap is inline, so script-src allows it by the exact
// SHA-256 of the real index.html script content. Compute it from the file so a
// Home change can never pass this test against a stale hardcoded hash.
const index = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');
const bootstrap = /<script>([\s\S]*?)<\/script>/.exec(index);
if (!bootstrap) throw new Error('the Home pre-paint inline bootstrap must exist');
const bootstrapHash = `'sha256-${createHash('sha256').update(Buffer.from(bootstrap[1], 'utf8')).digest('base64')}'`;

test('local playback keeps its existing CSP and adds the exact relay HTTPS origin', () => {
	const policy = contentSecurityPolicy({
		localPlaybackOrigin: localOrigin,
		relayMediaOrigin: normalizeRelayOrigin(relayOrigin, true),
	});
	assert.match(policy, new RegExp(`media-src 'self' blob: ${localOrigin.replaceAll('.', '\\.')} ${relayOrigin.replaceAll('.', '\\.')};`));
	assert.match(policy, new RegExp(`connect-src 'self' ${localOrigin.replaceAll('.', '\\.')} ${relayOrigin.replaceAll('.', '\\.')};`));
	assert.ok(!policy.includes('*'), 'CSP must not contain a wildcard');
	assert.match(policy, /frame-ancestors 'none'/);
});

test('relay CSP origin is omitted when relay media is disabled or no public origin exists', () => {
	assert.equal(normalizeRelayOrigin(relayOrigin, false), '');
	assert.equal(normalizeRelayOrigin('', true), '');
	const policy = contentSecurityPolicy({ localPlaybackOrigin: localOrigin });
	assert.ok(!policy.includes('watch.example.test'));
	assert.match(policy, new RegExp(`media-src 'self' blob: ${localOrigin.replaceAll('.', '\\.')};`));
});

test('relay CSP origin accepts a trailing slash but rejects paths, credentials, queries, fragments and HTTP', () => {
	assert.equal(normalizeRelayOrigin('https://watch.example.test/', true), relayOrigin);
	for (const value of [
		'http://watch.example.test',
		'https://user:pass@watch.example.test',
		'https://watch.example.test/relay',
		'https://watch.example.test/?x=1',
		'https://watch.example.test/#x',
		'not-a-url',
	]) {
		assert.equal(normalizeRelayOrigin(value, true), '', value);
	}
});

test('public asset CDN is allowed only for styles, images and fonts, never scripts or connections', () => {
	const assetOrigin = 'https://cdn.example.test';
	const policy = contentSecurityPolicy({ localPlaybackOrigin: localOrigin, assetOrigin: normalizeAssetOrigin(assetOrigin) });
	assert.match(policy, new RegExp(`style-src 'self' ${assetOrigin.replaceAll('.', '\\.')};`));
	assert.match(policy, new RegExp(`img-src 'self' data: https://image\\.tmdb\\.org https://artworks\\.thetvdb\\.com ${assetOrigin.replaceAll('.', '\\.')};`));
	assert.match(policy, new RegExp(`font-src 'self' ${assetOrigin.replaceAll('.', '\\.')};`));
	const scriptDirective = /(?:^|;)\s*script-src\s+([^;]+)/.exec(policy)?.[1].trim() || '';
	assert.deepEqual(scriptDirective.split(/\s+/), ["'self'", bootstrapHash, 'https://www.gstatic.com']);
	assert.doesNotMatch(scriptDirective, /'unsafe-inline'/);
	assert.doesNotMatch(policy, new RegExp(`script-src[^;]*${assetOrigin.replaceAll('.', '\\.')}`));
	assert.doesNotMatch(policy, new RegExp(`connect-src[^;]*${assetOrigin.replaceAll('.', '\\.')}`));
	const plain = contentSecurityPolicy({ localPlaybackOrigin: localOrigin });
	assert.ok(!plain.includes(assetOrigin));
});

test('public asset CDN origin is origin-only HTTPS and fails closed', () => {
	assert.equal(normalizeAssetOrigin('https://cdn.example.test/'), 'https://cdn.example.test');
	for (const value of ['http://cdn.example.test', 'https://user:pass@cdn.example.test',
		'https://cdn.example.test/assets', 'https://cdn.example.test/?x=1', 'https://cdn.example.test/#x',
		'not-a-url', 'https://169.254.169.254']) {
		assert.equal(normalizeAssetOrigin(value), '', value);
	}
});
