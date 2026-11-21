import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { contentSecurityPolicy } from '../csp.mjs';

const index = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8');

test('the Home pre-paint bootstrap is allowed by its exact CSP hash, not unsafe-inline', () => {
	const match = /<script>([\s\S]*?)<\/script>/.exec(index);
	assert.ok(match, 'the Home pre-paint inline bootstrap must exist');
	const hash = createHash('sha256').update(Buffer.from(match[1], 'utf8')).digest('base64');
	const policy = contentSecurityPolicy({ localPlaybackOrigin: 'http://127.0.0.1:1' });
	const script = /(?:^|;)\s*script-src\s+([^;]+)/.exec(policy)?.[1] || '';
	assert.ok(script.includes(`'sha256-${hash}'`), 'script-src must include the exact inline bootstrap hash');
	assert.doesNotMatch(script, /'unsafe-inline'/);
});

test('the CSP keeps the existing script and frame origins', () => {
	const policy = contentSecurityPolicy({ localPlaybackOrigin: 'http://127.0.0.1:1', relayMediaOrigin: 'https://relay.example', assetOrigin: 'https://assets.example' });
	assert.match(policy, /script-src 'self' 'sha256-[^']+' https:\/\/www\.gstatic\.com/);
	assert.match(policy, /frame-src https:\/\/www\.gstatic\.com/);
	assert.match(policy, /style-src 'self' https:\/\/assets\.example/);
	assert.match(policy, /connect-src 'self' http:\/\/127\.0\.0\.1:1 https:\/\/relay\.example/);
});
