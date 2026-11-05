import test from 'node:test';
import assert from 'node:assert/strict';
import { relayMediaCaddyBlock, relayMediaCaddySite, scopedCaddyScript, workerDeployment } from '../homelab/relay-worker.mjs';

const relay = { hostname: 'watch.example.com', homeTailscaleIp: '100.100.10.20' };
test('media prefix is a scoped handle before the home proxy and strips viewer credentials', () => {
	const block = relayMediaCaddyBlock({ mediaPort: 18086 });
	assert.match(block, /handle \/relay-media\/\*/);
	assert.match(block, /handle \/internal\/\*/);
	assert.doesNotMatch(block, /handle \/homelab/);
	assert.match(block, /header_up -Cookie/);
	assert.match(block, /header_up -Authorization/);
	assert.match(block, /header_up -X-JServer-App/);
	assert.match(block, /reverse_proxy 127\.0\.0\.1:18086/);
	const site = relayMediaCaddySite(relay, { mediaPort: 18086 });
	assert.ok(site.indexOf('handle /relay-media/*') < site.indexOf('reverse_proxy 100.100.10.20:8083'));
	assert.match(site, /respond @private 404/);
	assert.match(site, /\/internal\/\*/);
});
test('local origin CORS is exact and never wildcard or credential-bearing', () => {
	const block = relayMediaCaddyBlock({ mediaPort: 18086, localOrigin: 'http://192.168.1.10:8082/' });
	assert.match(block, /Access-Control-Allow-Origin "http:\/\/192\.168\.1\.10:8082"/);
	assert.match(block, /Vary Origin/);
	assert.doesNotMatch(block, /Allow-Origin "\*"|Allow-Credentials/);
	assert.throws(() => relayMediaCaddyBlock({ localOrigin: 'http://user:secret@example.test' }));
});
test('scoped Caddy edit backs up, validates and restores on reload failure', () => {
	const script = scopedCaddyScript({ mediaPort: 18086, caddyFile: '/etc/caddy/home-relay.Caddyfile', site: 'watch.example.test' });
	assert.match(script, /Caddyfile\.\$\(date/);
	assert.ok(script.indexOf('caddy validate') < script.indexOf('install -m 644'));
	assert.match(script, /cp "\$backup" "\$target"/);
	assert.match(script, /handle\[\[:space:\]\]\*/);
	assert.match(script, /watch\.example\.test/);
	assert.doesNotMatch(script, /cat > \/etc\/caddy\/Caddyfile|rm -rf \/etc\/caddy|ufw/);
	assert.match(script, /already present\. Nothing changed/);
});
test('main private control mapping is idempotent and preserves existing serve entries', async () => {
	const { mainWorkerControlScript, workerActivationScript } = await import('../homelab/relay-worker.mjs');
	const main = mainWorkerControlScript({ mainPort: 8083 });
	assert.match(main, /tailscale serve --yes --bg --tcp 8083/);
	assert.match(main, /already exists\. Nothing changed/);
	const worker = workerActivationScript({ controlPort: 18087 });
	assert.match(worker, /tailscale serve --yes --bg --tcp 18087/);
	assert.match(worker, /preserved/);
});
test('preflight records private peer identity and rejects serve-port conflicts without changing anything', async () => {
	const { parseWorkerPreflight } = await import('../homelab/relay-worker.mjs');
	const ok = `TELLYBOX_OS=ubuntu 24.04\nTELLYBOX_IP=100.100.10.20\nTELLYBOX_TS_VERSION=1.104.2\nTELLYBOX_PODMAN=/usr/bin/podman\nTELLYBOX_PING_OK=1\nTELLYBOX_SERVE_BEGIN\n|-- tcp://relay.example.test:9191 (tailnet only)\n|--> tcp://127.0.0.1:9192\nTELLYBOX_SERVE_END\n`;
	const ready = parseWorkerPreflight(ok);
	assert.equal(ready.ready, true); assert.equal(ready.ip, '100.100.10.20'); assert.deepEqual(ready.conflicts, []);
	const conflict = parseWorkerPreflight(ok.replace('tcp://127.0.0.1:9192', 'tcp://127.0.0.1:9192\n|-- tcp://relay.example.test:18087'));
	assert.equal(conflict.ready, false); assert.match(conflict.conflicts.join(' '), /18087/);
	const noPing = parseWorkerPreflight(ok.replace('PING_OK=1', 'PING_OK=0'));
	assert.equal(noPing.checks.mainReachable, false);
});
test('Podman worker deployment is isolated and does not touch existing services or the owner API', () => {
	const { unit, serve, setup } = workerDeployment({ worker: { workerId: 'relay-worker', image: 'localhost/tellybox-relay-worker:test',
		tailscaleIp: '100.100.10.20', mediaPort: 18086, controlPort: 18087, mainControlKeyFile: '/root/main-control.pem',
		mainHeartbeatUrl: 'http://100.100.10.11:8083/internal/worker/heartbeat', upstreamUrl: 'http://host.containers.internal:9192' }, mainMediaPublicKeyFile: '/root/main-media.pem' });
	assert.match(unit, /podman run/);
	assert.match(unit, /--read-only/);
	assert.match(unit, /--cap-drop=ALL/);
	assert.match(unit, /--network=slirp4netns:allow_host_loopback=true/);
	assert.match(unit, /host\.containers\.internal:10\.0\.2\.2/);
	assert.match(unit, /127\.0\.0\.1:18086:18086/);
	assert.doesNotMatch(unit, /docker\.sock|--privileged|--network=host|existing-engine|existing-proxy|:owner/);
	assert.match(serve, /tailscale serve --yes --bg --tcp 18087/);
	assert.doesNotMatch(setup, /apt-get install docker|systemctl restart caddy|Caddyfile/);
});
