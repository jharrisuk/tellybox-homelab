/* Release 132 supersedes the release-129 Settings status panel.
 *
 * The full upstream monitor lives in Activity -> Streams. Installation
 * settings keep only the Dispatcharr connection configuration; the old
 * pointer sentence was removed so the setup page does not describe a
 * duplicate monitoring location.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../homelab/public/index.html', import.meta.url), 'utf8');
const setup = readFileSync(new URL('../homelab/public/setup.js', import.meta.url), 'utf8');

test('installation settings keep the connection settings without the stale Activity Streams link', () => {
	assert.equal(html.includes('id="dispatcharrStatusPanel"'), false, 'the duplicate aggregate panel is removed');
	assert.equal(setup.includes('createDispatcharrStatusController'), false, 'the settings status controller is removed');
	assert.equal(setup.includes('dispatcharrStatus.start()'), false, 'settings no longer polls Dispatcharr status');
	assert.equal(html.includes('/activity#streams'), false, 'the old pointer sentence is gone');
	assert.equal(html.includes('dispatcharrStreamsLink'), false);
	assert.equal(setup.includes('streamsActivityLink'), false);
	assert.match(setup, /applyDispatcharrLocation|Test saved connection/i, 'Dispatcharr connection configuration remains');
	assert.match(setup, /Where Dispatcharr runs/i, 'the connection location selector remains');
});
