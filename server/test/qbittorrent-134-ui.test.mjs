/* Release 134: desktop and mobile confirmation states for the owner-only
 * downloads surface. These are static contract checks; the protocol and route
 * suites exercise the real server behaviour. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DOWNLOADS_PAGE as page } from '../qbittorrent-page.mjs';
const script = readFileSync(new URL('../public/qbittorrent-downloads.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../public/qbittorrent.css', import.meta.url), 'utf8');
const settings = readFileSync(new URL('../public/settings.html', import.meta.url), 'utf8');
const settingsScript = readFileSync(new URL('../public/qbittorrent-settings.js', import.meta.url), 'utf8');

test('the owner downloads page shows both actions and the explicit destructive warning', () => {
	assert.match(page, /Owner only/i);
	assert.match(page, /Remove torrent, keep files/);
	assert.match(page, /Delete torrent and downloaded files/);
	assert.match(script, /cannot be undone/i);
	assert.match(script, /shared or hardlinked/i);
	assert.match(page, /Needs attention/i);
	assert.match(page, /does not mean imported or playable/i);
	assert.match(page, /id="qbDeleteAck"/);
	assert.match(page, /I understand the downloaded files cannot be recovered/);
	assert.match(page, /id="qbReview"/);
	assert.match(page, /role="alert"/);
});

test('the client polls only while visible, keeps one request in flight, and never receives a raw hash', () => {
	assert.match(script, /visibilitychange/);
	assert.match(script, /document\.hidden/);
	assert.match(script, /if \(state\.stopped \|\| document\.hidden \|\| state\.inFlight\) return;/);
	assert.match(script, /AbortController/);
	assert.match(script, /pagehide/);
	assert.match(script, /unconfigured/);
	assert.match(script, /disabled/);
	assert.match(script, /stale/);
	assert.match(script, /unreachable/);
	assert.match(script, /timeout/);
	assert.match(script, /auth-failed/);
	assert.match(script, /will not repeat this request automatically/);
	assert.match(script, /Needs attention/);
	assert.equal(script.includes('innerHTML'), false, 'row data is rendered with text nodes only');
	assert.equal(script.includes('.hash'), false, 'the browser only sees the opaque id and short display hash');
	assert.match(script, /displayHash/);
	assert.match(script, /generation/);
});

test('settings show read-only statistics and send configuration to installation settings', () => {
	assert.doesNotMatch(settings, /data-panel="integrations"/, 'the empty Integrations tab is gone');
	assert.doesNotMatch(settings, /settingsPanelIntegrations/);
	assert.match(settings, /id="qbittorrentSettings"/);
	assert.match(settings, /qbittorrent-settings\.js/);
	assert.match(settingsScript, /const title = el\('h2', 'Downloads'\)/);
	assert.match(settingsScript, /\/api\/qbittorrent\/summary/);
	assert.doesNotMatch(settingsScript, /\/api\/qbittorrent\/(?:status|config|disconnect)/, 'the page never offers configuration');
	assert.doesNotMatch(settingsScript, /createElement\('form'\)|createElement\('input'\)/, 'the page renders no qBittorrent form');
	assert.match(settingsScript, /installation settings on port 8990/);
	assert.match(settingsScript, /completed downloads are not the same as imported or playable/i);
});

test('the confirmation dialog has desktop and mobile layouts for one selected torrent', () => {
	assert.match(css, /\.qb-dialog\s*\{/);
	assert.match(css, /\.qb-dialog-actions/);
	assert.match(css, /@media \(max-width: 620px\)/);
	assert.match(css, /grid-template-columns: 1fr/);
	assert.match(css, /min-height: 48px/);
	assert.match(css, /\.qb-warning-destructive/);
	assert.match(css, /\.qb-row\.qb-attention/);
});

test('the page provides filters, pagination and an explicit no-rows distinction', () => {
	assert.match(page, /id="qbFilter"/);
	assert.match(page, /id="qbCategory"/);
	assert.match(page, /id="qbPrevious"/);
	assert.match(page, /id="qbNext"/);
	assert.match(page, /id="qbEmpty"/);
	assert.match(script, /No torrents are in this qBittorrent queue/);
	assert.match(script, /No torrents match this filter/);
});
