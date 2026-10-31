import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('../public/connection-status.js', import.meta.url), 'utf8');
async function page(access, fails = false) {
	const elements = [], listeners = {};
	const element = () => ({ dataset: {}, attrs: {}, children: [], setAttribute(k,v) { this.attrs[k] = v; }, append(...v) { this.children.push(...v); }, before() {}, addEventListener() {}, contains() { return false; } });
	const brand = element();
	const context = { navigator: { onLine: true }, AbortSignal, setInterval() {}, window: { addEventListener(k,v) { listeners[k] = v; } }, document: { hidden: false, querySelector() { return brand; }, createElement() { const e = element(); elements.push(e); return e; }, addEventListener() {} }, fetch: async () => ({ ok: !fails, json: async () => access }) };
	vm.runInNewContext(source, context);
	await new Promise(resolve => setImmediate(resolve));
	return { button: elements[1], note: elements[2], listeners, context };
}
test('home public IP is a relay connection until a verified media route is reported', async () => {
	const { button, note, listeners } = await page({ home: true, local: false });
	assert.equal(button.dataset.route, 'relay');
	listeners['tellybox-route']({ detail: { route: 'local', text: 'Streaming locally' } });
	assert.equal(button.dataset.route, 'local');
	button.onclick(); assert.equal(note.hidden, false); assert.equal(note.textContent, 'Streaming locally');
	listeners['tellybox-route']({ detail: { route: 'relay', text: 'Streaming through the relay' } });
	assert.equal(button.dataset.route, 'relay'); assert.equal(note.textContent, 'Streaming through the relay');
	assert.equal(button.attrs['aria-label'], note.textContent);
});
test('direct LAN, unavailable server and offline states are distinct', async () => {
	const local = await page({ local: true }); assert.equal(local.button.dataset.route, 'local');
	local.context.navigator.onLine = false; local.listeners.offline(); assert.equal(local.button.dataset.route, 'unknown');
	const failed = await page({}, true); assert.equal(failed.button.dataset.route, 'unknown');
});
