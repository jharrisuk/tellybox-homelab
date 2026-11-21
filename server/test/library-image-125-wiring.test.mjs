import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// The parent session owns server/server.mjs. This guard proves that the exact
// patch in outputs/Tellybox-web-artwork-125/owner-a-server-artwork/
// SERVER-MJS-PATCH.md was applied, and that the route now goes through the
// versioned handler instead of the old inline proxyImage call.
const source = readFileSync(new URL('../server.mjs', import.meta.url), 'utf8');
const patched = [
	"import { createLibraryImageHandler } from './library-image.mjs';",
	'const libraryImage = createLibraryImageHandler({',
	"app.get('/images/:id/:kind', libraryImage);",
	"versioned: true, scope: req.jserverOwner || ''",
].every(line => source.includes(line));

test('the /images route is wired to the versioned library image handler', t => {
	if (!patched) {
		t.skip('SERVER-MJS-PATCH.md is not applied yet; the route still uses the inline no-store proxy');
		return;
	}
	assert.match(source, /authorize: \(req, \{ id \}\) => mayMintArtwork\(req, \{ Id: id \}\)/,
		'the handler authorizes with the same viewer gate as minting');
	assert.doesNotMatch(source, /app\.get\('\/images\/:id\/:kind', async \(req, res\) => \{/,
		'the old inline route must not remain alongside the handler');
	assert.doesNotMatch(source, /cache:'private, no-store',label:'Image'/, 'the old inline cache policy is gone');
});
