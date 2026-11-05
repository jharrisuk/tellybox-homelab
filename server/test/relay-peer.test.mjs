import test from 'node:test';
import assert from 'node:assert/strict';
import { forwardedHeaders, normalizePeer, privateWorkerPeer, tailnetPeer } from '../relay-media/install.mjs';

test('worker control peers are pinned, mapped IPv4 is normalised and broad LAN is not trusted by default', () => {
	assert.equal(normalizePeer('::ffff:100.100.10.20'), '100.100.10.20');
	assert.equal(tailnetPeer('100.100.10.20'), true);
	assert.equal(tailnetPeer('::ffff:100.100.10.20'), true);
	assert.equal(tailnetPeer('127.0.0.1'), true);
	assert.equal(tailnetPeer('192.168.1.10'), false, 'a LAN peer is not implicitly a worker');
	assert.equal(tailnetPeer('::ffff:100.100.10.20', '100.100.10.20'), true);
	assert.equal(tailnetPeer('100.100.10.21', '100.100.10.20'), false);
	assert.equal(privateWorkerPeer('10.0.2.2'), true);
	assert.equal(privateWorkerPeer('172.16.1.2'), true);
	assert.equal(privateWorkerPeer('8.8.8.8'), false);
	assert.equal(forwardedHeaders({ 'x-forwarded-for': '1.2.3.4' }), true);
	assert.equal(forwardedHeaders({ 'x-real-ip': '1.2.3.4' }), true);
	assert.equal(forwardedHeaders({ 'true-client-ip': '1.2.3.4' }), true);
	assert.equal(forwardedHeaders({ 'x-custom': '1.2.3.4' }), false);
});
